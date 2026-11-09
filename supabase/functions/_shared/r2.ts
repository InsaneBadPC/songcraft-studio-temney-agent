/**
 * Minimální S3 klient pro Cloudflare R2 v edge funkcích.
 *
 * Drží se stejného schématu jako `workers/backup/r2.mjs`: SigV4, region
 * `auto`, služba `s3`, presigned URL. Edge funkce potřebuje hlavně podepsaný
 * GET pro stahování archivů; PUT/HEAD/DELETE jsou připravené pro další
 * stěhování médií.
 */

const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function hmac(key: Uint8Array | string, value: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? encoder.encode(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value)));
}

function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function amzDates(now = new Date()): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

/** `r2://bucket/key` → { bucket, key }; jinak null. */
export function parseR2Path(value: unknown): { bucket: string; key: string } | null {
  if (typeof value !== "string" || !value.startsWith("r2://")) return null;
  const rest = value.slice(5);
  const slash = rest.indexOf("/");
  if (slash < 1) return null;
  return { bucket: rest.slice(0, slash), key: rest.slice(slash + 1) };
}

export type R2Client = {
  endpoint: string;
  bucket: string;
  presign: (method: string, key: string, expires?: number) => Promise<string>;
  getObject: (key: string, expires?: number) => Promise<Response>;
  putObject: (key: string, body: BodyInit, contentType?: string, expires?: number) => Promise<Response>;
  headObject: (key: string, expires?: number) => Promise<{ size: number; etag: string } | null>;
  deleteObject: (key: string, expires?: number) => Promise<void>;
};

export function createR2Client(options: {
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  bucket?: string;
  region?: string;
} = {}): R2Client {
  const endpoint = String(options.endpoint ?? Deno.env.get("R2_ENDPOINT") ?? "").replace(/\/+$/, "");
  const accessKeyId = options.accessKeyId ?? Deno.env.get("R2_ACCESS_KEY_ID") ?? "";
  const secretAccessKey = options.secretAccessKey ?? Deno.env.get("R2_SECRET_ACCESS_KEY") ?? "";
  const bucket = options.bucket ?? Deno.env.get("R2_BUCKET") ?? "songcraft-studio";
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("R2_ENDPOINT, R2_ACCESS_KEY_ID a R2_SECRET_ACCESS_KEY musí být nastavené.");
  }
  const host = new URL(endpoint).host;
  const region = options.region ?? "auto";
  const service = "s3";

  async function presign(method: string, key: string, expires = 3600): Promise<string> {
    const { amzDate, dateStamp } = amzDates();
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const canonicalUri = `/${bucket}/${String(key).split("/").map(rfc3986).join("/")}`;
    const query: Record<string, string> = {
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

  async function getObject(key: string, expires = 3600): Promise<Response> {
    const response = await fetch(await presign("GET", key, expires));
    if (!response.ok) throw new Error(`R2 GET ${key}: HTTP ${response.status}`);
    return response;
  }

  async function putObject(key: string, body: BodyInit, contentType = "application/octet-stream", expires = 3600): Promise<Response> {
    const response = await fetch(await presign("PUT", key, expires), {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body,
    });
    if (!response.ok) throw new Error(`R2 PUT ${key}: HTTP ${response.status}`);
    return response;
  }

  async function headObject(key: string, expires = 3600): Promise<{ size: number; etag: string } | null> {
    const response = await fetch(await presign("HEAD", key, expires), { method: "HEAD" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`R2 HEAD ${key}: HTTP ${response.status}`);
    return {
      size: Number(response.headers.get("content-length") || 0),
      etag: (response.headers.get("etag") || "").replace(/"/g, ""),
    };
  }

  async function deleteObject(key: string, expires = 3600): Promise<void> {
    const response = await fetch(await presign("DELETE", key, expires), { method: "DELETE" });
    if (!response.ok && response.status !== 404) throw new Error(`R2 DELETE ${key}: HTTP ${response.status}`);
  }

  return { endpoint, bucket, presign, getObject, putObject, headObject, deleteObject };
}

export function r2FromEnv(options: Parameters<typeof createR2Client>[0] = {}): R2Client {
  return createR2Client(options);
}
