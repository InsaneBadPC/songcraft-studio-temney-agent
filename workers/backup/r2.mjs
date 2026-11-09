/**
 * Minimální S3 klient pro Cloudflare R2.
 *
 * Proč bez AWS SDK: worker běží na 2jádrové VM s 954 MB RAM a jediné, co
 * potřebuje, je podepsaný GET/PUT/HEAD/DELETE. AWS SDK je na to zbytečně
 * velké a přidává další závislosti do služby, která se nasazuje ručně.
 *
 * Podepisuje se SigV4 s regionem `auto` a službou `s3`. Pro uploady se
 * používají presigned URL, takže se nikdy neposílá podepsané tělo a tělo
 * může téct proudem.
 */

import { webcrypto } from "node:crypto";

const subtle = globalThis.crypto?.subtle ?? webcrypto.subtle;
const encoder = new TextEncoder();

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value) {
  return hex(await subtle.digest("SHA-256", typeof value === "string" ? encoder.encode(value) : value));
}

async function hmac(key, value) {
  const cryptoKey = await subtle.importKey("raw", typeof key === "string" ? encoder.encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", cryptoKey, encoder.encode(value)));
}

function rfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function amzDates(now = new Date()) {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

export function createR2Client(options = {}) {
  const endpoint = String(options.endpoint ?? process.env.R2_ENDPOINT ?? "").replace(/\/+$/, "");
  const accessKeyId = options.accessKeyId ?? process.env.R2_ACCESS_KEY_ID ?? "";
  const secretAccessKey = options.secretAccessKey ?? process.env.R2_SECRET_ACCESS_KEY ?? "";
  const bucket = options.bucket ?? process.env.R2_BUCKET ?? "songcraft-studio";
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("R2_ENDPOINT, R2_ACCESS_KEY_ID a R2_SECRET_ACCESS_KEY musí být nastavené.");
  }
  const host = new URL(endpoint).host;
  const region = options.region ?? "auto";
  const service = "s3";

  async function presign(method, key, expires = 3600) {
    const { amzDate, dateStamp } = amzDates();
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const canonicalUri = `/${bucket}/${String(key).split("/").map(rfc3986).join("/")}`;
    const query = {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${accessKeyId}/${credentialScope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": String(Math.max(1, Math.min(Number(expires) || 3600, 604800))),
      "X-Amz-SignedHeaders": "host",
    };
    const canonicalQuery = Object.keys(query).sort().map((k) => `${rfc3986(k)}=${rfc3986(query[k])}`).join("&");
    const canonicalHeaders = `host:${host}\n`;
    const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQuery}\n${canonicalHeaders}\nhost\nUNSIGNED-PAYLOAD`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`;
    const dateKey = await hmac(`AWS4${secretAccessKey}`, dateStamp);
    const regionKey = await hmac(dateKey, region);
    const serviceKey = await hmac(regionKey, service);
    const signingKey = await hmac(serviceKey, "aws4_request");
    const signature = hex(await hmac(signingKey, stringToSign));
    return `${endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }

  async function getObject(key, expires = 3600) {
    const response = await fetch(await presign("GET", key, expires));
    if (!response.ok) throw new Error(`R2 GET ${key}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    return response;
  }

  async function putObject(key, body, contentType = "application/octet-stream", expires = 3600) {
    const response = await fetch(await presign("PUT", key, expires), {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body,
    });
    if (!response.ok) throw new Error(`R2 PUT ${key}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    return response;
  }

  async function headObject(key, expires = 3600) {
    const response = await fetch(await presign("HEAD", key, expires), { method: "HEAD" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`R2 HEAD ${key}: HTTP ${response.status}`);
    return { size: Number(response.headers.get("content-length") || 0), etag: (response.headers.get("etag") || "").replace(/"/g, "") };
  }

  async function deleteObject(key, expires = 3600) {
    const response = await fetch(await presign("DELETE", key, expires), { method: "DELETE" });
    if (!response.ok && response.status !== 404) throw new Error(`R2 DELETE ${key}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  }

  return { endpoint, bucket, presign, getObject, putObject, headObject, deleteObject };
}

export function r2FromEnv(options = {}) {
  return createR2Client(options);
}
