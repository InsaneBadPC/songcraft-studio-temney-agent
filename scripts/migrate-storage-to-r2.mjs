#!/usr/bin/env node
/**
 * Migrace binárek ze Supabase Storage do Cloudflare R2.
 *
 * TVRDÉ ZÁRUKY (nesmí se porušit):
 * 1) ŽÁDNÝ řádek v sc_albums / sc_lyrics / sc_songs / sc_audio_versions /
 *    sc_song_media se NEPŘEPISUJE ani NEMAZE. Jediný zápis je ADITIVNÍ
 *    registrace v sc_media_objects (nová tabulka).
 * 2) Soubor se ze Supabase smaže AŽ PO tom, co:
 *    - byl nahrán do R2,
 *    - HEAD v R2 vrátí stejnou velikost,
 *    - SHA-256 stažených dat z R2 sedí s SHA-256 originálu.
 *    Když cokoli nesedí, soubor v Supabase ZŮSTANE a migrace skončí chybou.
 * 3) Výchozí režim je DRY RUN. Bez `--commit` se nic nemaže.
 * 4) Každý krok se zapisuje do reportu (JSON), takže je vidět, co se stalo.
 *
 * Použití:
 *   node scripts/migrate-storage-to-r2.mjs --dry-run
 *   node scripts/migrate-storage-to-r2.mjs --commit
 */

import { createHash, createHmac } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROJECT_REF = "hfykngbhcxmnpxvjagoj";
const API = "https://api.supabase.com/v1";
const STORAGE_API = "https://hfykngbhcxmnpxvjagoj.supabase.co";
const BUCKET = "songcraft";
const REPORT_DIR = join(homedir(), "temney-agent", "ui_audit", "migration-reports");

const args = new Set(process.argv.slice(2));
const COMMIT = args.has("--commit");
const ONLY_USER = (() => { const i = process.argv.indexOf("--user"); return i > -1 ? process.argv[i + 1] : null; })();

function accessToken() {
  const path = join(homedir(), ".supabase", "access-token");
  const token = readFileSync(path, "utf8").trim();
  if (!token) throw new Error(`Chybí token v ${path}`);
  return token;
}

const token = accessToken();

async function query(sql) {
  const response = await fetch(`${API}/projects/${PROJECT_REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`DB query selhala (${response.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : [];
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function r2Config() {
  const env = readFileSync(join(homedir(), "InsaneCode", "secrets", "edge-functions.env"), "utf8");
  const pick = (key) => {
    const line = env.split("\n").find((entry) => entry.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim().replace(/^["']|["']$/g, "") : "";
  };
  const endpoint = pick("R2_ENDPOINT");
  const accessKeyId = pick("R2_ACCESS_KEY_ID");
  const secretAccessKey = pick("R2_SECRET_ACCESS_KEY");
  const bucket = pick("R2_BUCKET") || "songcraft-studio";
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("V edge-functions.env chybí R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY.");
  }
  return { endpoint, accessKeyId, secretAccessKey, bucket };
}

// --- SigV4 (stejné schéma jako supabase/functions/_shared/r2.ts) -----------
const enc = new TextEncoder();
const hex = (buffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const sha256 = (value) => hex(createHash("sha256").update(value).digest());

function createHmacSha256(key, value) {
  return createHmac("sha256", key).update(value).digest();
}

function rfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function presign(config, method, key, expires = 3600) {
  const host = new URL(config.endpoint).host;
  const region = "auto";
  const service = "s3";
  const now = new Date();
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const amzDate = iso;
  const dateStamp = iso.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const canonicalUri = `/${config.bucket}/${key.split("/").map(rfc3986).join("/")}`;
  const query = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${config.accessKeyId}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = Object.keys(query).sort().map((name) => `${rfc3986(name)}=${rfc3986(query[name])}`).join("&");
  const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQuery}\nhost:${host}\n\nhost\nUNSIGNED-PAYLOAD`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${sha256(enc.encode(canonicalRequest))}`;
  const dateKey = createHmacSha256(`AWS4${config.secretAccessKey}`, dateStamp);
  const regionKey = createHmacSha256(dateKey, region);
  const serviceKey = createHmacSha256(regionKey, service);
  const signingKey = createHmacSha256(serviceKey, "aws4_request");
  const signature = hex(createHmacSha256(signingKey, stringToSign));
  return `${config.endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

async function r2Put(config, key, bytes, contentType) {
  const url = await presign(config, "PUT", key, 3600);
  const response = await fetch(url, { method: "PUT", headers: { "Content-Type": contentType }, body: bytes });
  if (!response.ok) throw new Error(`R2 PUT ${key}: HTTP ${response.status}`);
}

async function r2Head(config, key) {
  const url = await presign(config, "HEAD", key, 3600);
  const response = await fetch(url, { method: "HEAD" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`R2 HEAD ${key}: HTTP ${response.status}`);
  return { size: Number(response.headers.get("content-length") || 0), etag: (response.headers.get("etag") || "").replace(/"/g, "") };
}

async function r2Get(config, key) {
  const url = await presign(config, "GET", key, 3600);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`R2 GET ${key}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

// --- Supabase Storage ----------------------------------------------------
async function listObjects(prefix = "", limit = 1000) {
  const response = await fetch(`${STORAGE_API}/storage/v1/object/list/${BUCKET}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", apikey: token },
    body: JSON.stringify({ prefix, limit, sortBy: { column: "name", order: "asc" } }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Storage list selhal (${response.status}): ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function downloadObject(path) {
  const response = await fetch(`${STORAGE_API}/storage/v1/object/${BUCKET}/${encodeURIComponent(path).replace(/%2F/g, "/")}`, {
    headers: { Authorization: `Bearer ${token}`, apikey: token },
  });
  if (!response.ok) throw new Error(`Storage download ${path}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function deleteObject(path) {
  const response = await fetch(`${STORAGE_API}/storage/v1/object/${BUCKET}/${encodeURIComponent(path).replace(/%2F/g, "/")}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}`, apikey: token },
  });
  if (!response.ok && response.status !== 404) throw new Error(`Storage delete ${path}: HTTP ${response.status}`);
}

const sha256Bytes = (bytes) => hex(createHash("sha256").update(bytes).digest());

async function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = join(REPORT_DIR, `migration-${stamp}.json`);
  const report = { mode: COMMIT ? "commit" : "dry-run", startedAt: new Date().toISOString(), objects: [], errors: [], dataBefore: null, dataAfter: null };

  const countQuery = "select (select count(*) from sc_albums) albums, (select count(*) from sc_lyrics) lyrics, (select count(*) from sc_songs) songs, (select count(*) from sc_audio_versions) versions, (select count(*) from sc_song_media) media, (select count(*) from sc_style_prompts) prompts, (select count(*) from sc_rhyme_words) rhymes";
  report.dataBefore = (await query(countQuery))[0] ?? null;
  console.log("Data před migrací:", JSON.stringify(report.dataBefore));

  const config = await r2Config();
  console.log(`R2: ${config.endpoint} / bucket ${config.bucket}`);

  // Seznam všech objektů (rekurzivně přes prefixy).
  const objects = [];
  async function walk(prefix) {
    const entries = await listObjects(prefix);
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null || entry.metadata === null) {
        await walk(path);
      } else {
        objects.push({ path, size: Number(entry.metadata?.size ?? 0) });
      }
    }
  }
  await walk("");
  console.log(`Nalezeno ${objects.length} objektů v bucketu ${BUCKET}.`);

  const filtered = ONLY_USER ? objects.filter((entry) => entry.path.startsWith(`${ONLY_USER}/`)) : objects;
  let copied = 0;
  let verified = 0;
  let deleted = 0;

  for (const object of filtered) {
    const entry = { path: object.path, size: object.size, status: "pending" };
    report.objects.push(entry);
    try {
      const bytes = await downloadObject(object.path);
      const sourceHash = sha256Bytes(bytes);
      const key = object.path; // zachováme stejnou strukturu cest
      const contentType = object.path.endsWith(".mp4") ? "video/mp4" : object.path.endsWith(".mp3") ? "audio/mpeg" : object.path.match(/\.(jpe?g|png|webp)$/i) ? "image/jpeg" : "application/octet-stream";

      await r2Put(config, key, bytes, contentType);
      copied += 1;

      const head = await r2Head(config, key);
      if (!head || head.size !== bytes.byteLength) throw new Error(`Velikost v R2 nesedí (${head?.size} != ${bytes.byteLength})`);
      const roundTrip = await r2Get(config, key);
      const targetHash = sha256Bytes(roundTrip);
      if (targetHash !== sourceHash) throw new Error("SHA-256 se neshoduje po přenosu");
      verified += 1;
      entry.sha256 = sourceHash;
      entry.status = "verified";

      if (COMMIT) {
        const userId = object.path.split("/")[0];
        const kind = object.path.includes("/videos/") ? "video" : object.path.includes("/audio/") ? "audio" : object.path.includes("/covers/") ? "cover" : "media";
        await query(`insert into sc_media_objects (user_id, storage_path, kind, byte_size, sha256, state)
          values (${sqlLiteral(userId)}, ${sqlLiteral(`r2://${config.bucket}/${key}`)}, ${sqlLiteral(kind)}, ${bytes.byteLength}, ${sqlLiteral(sourceHash)}, 'active')
          on conflict (user_id, storage_path) do update set byte_size = excluded.byte_size, sha256 = excluded.sha256, state = 'active'`);
        await deleteObject(object.path);
        deleted += 1;
        entry.status = "migrated";
      }
      console.log(`OK ${object.path} (${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB) ${entry.status}`);
    } catch (error) {
      entry.status = "failed";
      entry.error = error.message;
      report.errors.push({ path: object.path, error: error.message });
      console.error(`CHYBA ${object.path}: ${error.message}`);
    }
  }

  report.dataAfter = (await query(countQuery))[0] ?? null;
  report.summary = { objects: filtered.length, copied, verified, deleted };
  report.finishedAt = new Date().toISOString();
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  const before = report.dataBefore ?? {};
  const after = report.dataAfter ?? {};
  const unchanged = Object.keys(before).every((key) => before[key] === after[key]);
  console.log("Data po migraci:", JSON.stringify(after));
  console.log(`Shrnutí: ${copied} zkopírováno, ${verified} ověřeno, ${deleted} smazáno ze Supabase. Report: ${reportPath}`);
  if (!unchanged) {
    console.error("KRITICKÉ: počty řádků v DB se změnily! Migrace je zastavená, nic dalšího se nemaže.");
    process.exit(1);
  }
  if (report.errors.length > 0) {
    console.error(`${report.errors.length} objektů selhalo - zůstaly v Supabase, nic se neztratilo.`);
    process.exit(1);
  }
  console.log("migration verified");
}

main().catch((error) => {
  console.error("Migrace selhala:", error.message);
  process.exit(1);
});
