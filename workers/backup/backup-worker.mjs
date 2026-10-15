/**
 * SongCraft Studio — worker záloh a obnov.
 *
 * Proč existuje vedle edge funkce songcraft-service-console:
 *
 * Záloha všech uživatelů má reálně přes gigabajt (15. 10. 2026: 136 objektů,
 * 1 336 MB). Edge funkce to nesplave — Deno izolát má paměťový strop a krátký
 * životní cyklus requestu. Tady je běžná Node služba na VM, která soubory
 * streamuje přes disk a nedrží je v paměti (VM má 954 MB RAM, z toho ~220 MB
 * volných).
 *
 * Stejná architektura jako u renderu videí: `sc_service_backups` je fronta,
 * tahle služba ji vybere, průběh zapíše do progress a výsledek nahraje do
 * bucketu `songcraft-backups`. Edge funkce je řídící vrstva - účty, potvrzení
 * a podepsaná adresa ke stažení - a soubory vůbec neotevírá.
 *
 * Proměnné prostředí (Systemd EnvironmentFile):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   WORK_DIR           výchozí /var/lib/songcraft-studio/work
 *   WORKER_INTERVAL_MS výchozí 30000
 *   RUN_ONCE=1         vyřídit frontu a skončit (testy a ruční běh)
 */

import { createWriteStream, createReadStream, existsSync } from "node:fs";
import { mkdir, rm, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const workRoot = process.env.WORK_DIR || "/var/lib/songcraft-studio/work";
const interval = Number(process.env.WORKER_INTERVAL_MS || 30000);
const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES || 2 * 1024 * 1024 * 1024);

const headers = {
  apikey: key,
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
};
const api = (table, query = "") => `${url}/rest/v1/${table}${query}`;

/**
 * Tabulky, které patří uživateli. Záměrný seznam, ne výběr z katalogu - kdyby
 * se v repo objevila tabulka, která tu chybí, raději aby se do zálohy nedostala
 * než aby se tam dostala s cizím user_id sloupcem.
 *
 * Vyloženo záměrně:
 *   youtube_credentials            refresh token od Google - v archivu stažitelném
 *                                 na telefon by to znamenalo přístup na kanál
 *   _backup_agent_videos_20261005  mrtvá ruční záloha, viz migrace 20261015000002
 */
const OWNED_TABLES = [
  "sc_albums", "sc_lyrics", "sc_songs", "sc_audio_versions", "sc_rhyme_words",
  "sc_style_prompts", "sc_cover_jobs", "sc_video_jobs", "sc_song_media",
  "agent_settings", "agent_conversations", "agent_messages", "agent_recommendations",
  "agent_action_log", "agent_image_assets", "agent_videos", "agent_media_uploads",
  "agent_channel_stats", "agent_content_calendar", "agent_confirmations", "agent_ops",
  "youtube_publications", "youtube_stats", "youtube_oauth_states", "motion_recipes",
];

/**
 * Primární klíč tabulky. Výjimka z `id` je `agent_settings`, kde je PK přímo
 * `user_id` (20260922000000_temney_agent_v3.sql). Zjisteno z živé DB
 * (pg_index), ne odhadem - objednání podle `id` tam spadne na
 * "column agent_settings.id does not exist" a export selže v půlce.
 */
const PRIMARY_KEY = { agent_settings: "user_id" };
const primaryKey = (table) => PRIMARY_KEY[table] ?? "id";

/**
 * Pořadí mazání: děti před rodiči. Vyplývá z cizích klíčů v živé DB
 *   sc_albums -> sc_lyrics -> sc_songs -> {sc_audio_versions, sc_song_media, motion_recipes}
 *   agent_conversations -> {agent_messages, agent_media_uploads}
 *   agent_videos -> youtube_publications -> youtube_stats
 * Obrácené pořadí by skončilo na porušení cizího klíče, a to je přesně druh
 * chyby, který by operátor neměl řešit ručně.
 */
const DELETE_ORDER = [
  "youtube_stats", "youtube_publications", "motion_recipes", "sc_song_media",
  "sc_audio_versions", "agent_messages", "agent_media_uploads", "sc_songs",
  "sc_lyrics", "sc_albums", "agent_videos", "agent_conversations",
  "agent_action_log", "agent_channel_stats", "agent_confirmations",
  "agent_content_calendar", "agent_image_assets", "agent_ops",
  "agent_recommendations", "agent_settings", "sc_cover_jobs", "sc_rhyme_words",
  "sc_style_prompts", "sc_video_jobs", "youtube_oauth_states",
];

const BUCKET = "songcraft";
const BACKUP_BUCKET = "songcraft-backups";
const ARCHIVE_FORMAT = "tar.zst";

async function request(endpoint, options = {}) {
  const response = await fetch(endpoint, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  if (!response.ok) throw new Error(`${response.status}: ${(await response.text()).slice(0, 400)}`);
  return response.status === 204 ? null : response.json();
}

/** Storage API vyžaduje lomítka v cestě DOSLOVA; encodeURIComponent by je změnilo na %2F → 400. */
function encodePath(pathname) {
  return pathname.split("/").map(encodeURIComponent).join("/");
}

function step(stage, extra = {}) {
  return { stage, at: new Date().toISOString(), ...extra };
}

async function setProgress(jobId, progress) {
  await request(api("sc_service_backups", `?id=eq.${encodeURIComponent(jobId)}`), {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ progress }),
  });
}

async function fail(jobId, message) {
  const text = String(message ?? "").slice(0, 900);
  console.error(`[${jobId}] selhalo: ${text}`);
  await request(api("sc_service_backups", `?id=eq.${encodeURIComponent(jobId)}`), {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status: "failed", error_message: text, finished_at: new Date().toISOString() }),
  });
}

/** Atomické převzetí úlohy - dva workery by si ji jinak vzaly oba. */
async function claim(jobId) {
  const claimed = await request(api("sc_service_backups", `?id=eq.${encodeURIComponent(jobId)}&status=eq.queued`), {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ status: "running", started_at: new Date().toISOString(), error_message: null }),
  });
  return Array.isArray(claimed) && claimed.length > 0 ? claimed[0] : null;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

async function listBucket(prefix, limit = 1000) {
  const results = [];
  for (let offset = 0; ; offset += limit) {
    const page = await request(`${url}/storage/v1/object/list/${BUCKET}`, {
      method: "POST",
      body: JSON.stringify({ prefix, limit, offset, sortOrder: { key: "name", ascending: true } }),
    });
    const entries = Array.isArray(page) ? page : [];
    results.push(...entries);
    if (entries.length < limit) break;
  }
  return results;
}

/**
 * Složení cesty v bucketu bez dvojitého lomítka.
 *
 * Prefix ze vstupu končí lomítkem (`uuid/`), takže prosté `${prefix}/${name}`
 * dává `uuid//covers`. Storage na to vrací prázdný seznam - záloha pak tvrdí
 * "0 souborů", přestože bucket 136 objektů má. Otestované v
 * tests/service-console.test.ts.
 */
export function joinStoragePath(prefix, name) {
  const base = prefix.replace(/\/+$/, "");
  return base ? `${base}/${name}` : name;
}

/**
 * Rekurzivně všechny soubory pod prefixem, s velikostí z odpovědi.
 *
 * Prefix se před skládáním cesty normalizuje bez koncového lomítka. Bez toho
 * vznikne `uuid//covers` (vstup má `uuid/` + skládané `/`), storage na dvojité
 * lomítko vrátí prázdný seznam a záloha skončí s nulou souborů, přestože
 * soubory v bucketu jsou.
 */
async function walkStorage(prefix, out = [], depth = 0) {
  if (depth > 8) throw new Error(`Storage je příliš hluboko vnořený: ${prefix}`);
  for (const entry of await listBucket(prefix)) {
    const full = joinStoragePath(prefix, entry.name);
    if (entry.id) out.push({ path: full, bytes: Number(entry.metadata?.size ?? 0) });
    else await walkStorage(`${full}/`, out, depth + 1);
  }
  return out;
}

async function downloadTo(urlPath, target) {
  const response = await fetch(`${url}/storage/v1/object/${BUCKET}/${encodePath(urlPath)}`, { headers });
  if (!response.ok) throw new Error(`Stažení ${urlPath} selhalo: HTTP ${response.status}`);
  await mkdir(path.dirname(target), { recursive: true });
  await pipeline(response.body, createWriteStream(target));
}

async function uploadFrom(urlPath, file, contentType, bytes) {
  if (bytes > maxUploadBytes) throw new Error(`Soubor ${urlPath} je větší než povolených ${maxUploadBytes} B`);
  const response = await fetch(`${url}/storage/v1/object/${BUCKET}/${encodePath(urlPath)}`, {
    method: "POST",
    // Node 22 umí stream jako tělo fetche; 48 MB videa se do paměti nevejde.
    headers: { ...headers, "Content-Type": contentType || "application/octet-stream", "x-upsert": "true" },
    body: Readable.toWeb(createReadStream(file)),
    duplex: "half",
  });
  if (!response.ok) throw new Error(`Nahrání ${urlPath} selhalo: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// Archiv
// ---------------------------------------------------------------------------

/**
 * `tar -c` ve streamu do `zstd`. Nepoužíváme `tar --zstd`, protože to není
 * na starších Ubuntu standardně; pipe funguje vždy a data nikdy nesídí na disku
 * dvakrát.
 *
 * Posluchače na `close` se musí připojit HNED při startu, ne až po `await`.
 * Kdyby se `close` z taru přihodilo během čekání na zstd, nikdo by ho neslyšel,
 * `await` by zůstal viset navěcky a Node by skončil kódem 13
 * ("unsettled top-level await"). Bez jediné chyby v logu.
 */
async function writeArchive(sourceDir, archivePath) {
  const tar = spawn("tar", ["-cf", "-", "-C", sourceDir, "."], { stdio: ["ignore", "pipe", "pipe"] });
  const zstd = spawn("zstd", ["-3", "-T1", "-q", "-o", archivePath], { stdio: ["pipe", "ignore", "pipe"] });
  const errors = [];
  tar.stderr.on("data", (chunk) => errors.push(`tar: ${String(chunk)}`));
  zstd.stderr.on("data", (chunk) => errors.push(`zstd: ${String(chunk)}`));
  tar.once("error", (error) => errors.push(`tar: ${error.message}`));
  zstd.once("error", (error) => errors.push(`zstd: ${error.message}`));
  const tarDone = new Promise((resolve) => tar.once("close", (code) => resolve(code ?? 1)));
  const zstdDone = new Promise((resolve) => zstd.once("close", (code) => resolve(code ?? 1)));
  tar.stdout.pipe(zstd.stdin);
  const [tarCode, zstdCode] = await Promise.all([tarDone, zstdDone]);
  if (tarCode !== 0 || zstdCode !== 0) {
    throw new Error(`archiv selhal (tar=${tarCode}, zstd=${zstdCode}): ${errors.join("").slice(0, 300)}`);
  }
}

async function extractArchive(archivePath, targetDir) {
  const zstd = spawn("zstd", ["-d", "-q", "-c", archivePath], { stdio: ["ignore", "pipe", "pipe"] });
  const tar = spawn("tar", ["-xf", "-", "-C", targetDir], { stdio: ["pipe", "ignore", "pipe"] });
  const errors = [];
  zstd.stderr.on("data", (chunk) => errors.push(`zstd: ${String(chunk)}`));
  tar.stderr.on("data", (chunk) => errors.push(`tar: ${String(chunk)}`));
  zstd.once("error", (error) => errors.push(`zstd: ${error.message}`));
  tar.once("error", (error) => errors.push(`tar: ${error.message}`));
  const zstdDone = new Promise((resolve) => zstd.once("close", (code) => resolve(code ?? 1)));
  const tarDone = new Promise((resolve) => tar.once("close", (code) => resolve(code ?? 1)));
  zstd.stdout.pipe(tar.stdin);
  const [zstdCode, tarCode] = await Promise.all([zstdDone, tarDone]);
  if (zstdCode !== 0 || tarCode !== 0) {
    throw new Error(`rozbalení selhalo (zstd=${zstdCode}, tar=${tarCode}): ${errors.join("").slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------------------
// Záloha
// ---------------------------------------------------------------------------

async function listAuthUsers() {
  const users = [];
  for (let page = 1; page <= 20; page += 1) {
    const response = await fetch(`${url}/auth/v1/admin/users?page=${page}&per_page=200`, { headers });
    if (!response.ok) throw new Error(`auth.users selhalo: HTTP ${response.status}`);
    const payload = await response.json();
    users.push(...(payload?.users ?? []));
    if (users.length >= (payload?.total ?? 0)) break;
  }
  return users;
}

async function runBackup(job) {
  const jobId = job.id;
  const dir = path.join(workRoot, `backup-${jobId}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(path.join(dir, "rows"), { recursive: true });

  const users = await listAuthUsers();
  const service = new Set((await request(api("sc_service_accounts", "?select=user_id"))).map((row) => row.user_id));
  await setProgress(jobId, step("listing", { users: users.length }));

  const manifestUsers = [];
  for (const [index, user] of users.entries()) {
    const userId = user.id;
    const userDir = path.join(dir, "rows", userId);
    await mkdir(userDir, { recursive: true });

    const tables = {};
    for (const table of OWNED_TABLES) {
      let from = 0;
      const page = 1000;
      const lines = [];
      for (;;) {
        const batch = await request(
          api(table, `?user_id=eq.${encodeURIComponent(userId)}&select=*&order=${primaryKey(table)}.asc&limit=${page}&offset=${from}`),
        );
        for (const row of batch) lines.push(JSON.stringify(row));
        if (batch.length < page) break;
        from += page;
      }
      if (lines.length > 0) {
        await writeFile(path.join(userDir, `${table}.jsonl`), `${lines.join("\n")}\n`, "utf8");
        tables[table] = lines.length;
      }
      await setProgress(jobId, step("rows", { user: index + 1, users: users.length, table, rows: lines.length }));
    }

    const files = await walkStorage(`${userId}/`);
    let bytes = 0;
    for (const [fileIndex, file] of files.entries()) {
      await downloadTo(file.path, path.join(dir, "files", file.path));
      bytes += file.bytes;
      if (fileIndex % 5 === 0 || fileIndex === files.length - 1) {
        await setProgress(jobId, step("files", { user: index + 1, users: users.length, file: fileIndex + 1, files: files.length, bytes }));
      }
    }

    manifestUsers.push({
      userId,
      email: user.email ?? null,
      displayName: user.user_metadata?.display_name ?? null,
      isService: service.has(userId),
      tables,
      files: files.length,
      bytes,
    });
  }

  const manifest = {
    format: ARCHIVE_FORMAT,
    schema: 1,
    projectRef: url,
    createdAt: new Date().toISOString(),
    tables: OWNED_TABLES,
    neverExported: ["youtube_credentials", "_backup_agent_videos_20261005"],
    users: manifestUsers,
    totals: {
      users: manifestUsers.length,
      rows: manifestUsers.reduce((sum, entry) => sum + Object.values(entry.tables).reduce((a, b) => a + b, 0), 0),
      files: manifestUsers.reduce((sum, entry) => sum + entry.files, 0),
      bytes: manifestUsers.reduce((sum, entry) => sum + entry.bytes, 0),
    },
  };
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  await writeFile(path.join(dir, "users.json"), JSON.stringify(manifestUsers, null, 2), "utf8");

  await setProgress(jobId, step("archiving", { bytes: manifest.totals.bytes }));
  const archivePath = path.join(workRoot, `${jobId}.${ARCHIVE_FORMAT}`);
  await rm(archivePath, { force: true });
  await writeArchive(dir, archivePath);
  const archiveStat = await stat(archivePath);
  if (archiveStat.size > maxUploadBytes) {
    throw new Error(`Archiv má ${archiveStat.size} B, limit je ${maxUploadBytes} B.`);
  }

  await setProgress(jobId, step("uploading", { archiveBytes: archiveStat.size }));
  const parts = await uploadArchiveParts(jobId, archivePath, archiveStat.size, async (done, total, bytes) => {
    await setProgress(jobId, step("uploading", { part: done, parts: total, archiveBytes: archiveStat.size, sentBytes: bytes }));
  });

  await request(api("sc_service_backups", `?id=eq.${encodeURIComponent(jobId)}`), {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      status: "done",
      archive_path: jobId,
      archive_bytes: archiveStat.size,
      archive_parts: parts,
      manifest: { ...manifest.totals, parts },
      progress: step("done", { archiveBytes: archiveStat.size, parts }),
      finished_at: new Date().toISOString(),
    }),
  });

  await rm(dir, { recursive: true, force: true });
  await rm(archivePath, { force: true });
  console.log(`[${jobId}] záloha hotová: ${manifest.totals.users} účtů, ${manifest.totals.files} souborů, ${archiveStat.size} B`);
}

/**
 * Archiv se NEposílá v jednom requestu. Bucket songcraft-backups jde přes
 * Cloudflare, který má tvrdý limit na velikost těla jednoho requestu (100 MB);
 * 1,28 GB v jednom POST nikdy nedojde a request zůstane viset, než ho
 * gateway odpojí - což na 2jádrové VM s 954 MB RAM zablokuje i renderer.
 *
 * Proto se archiv posílá po částech. Části se čtou ze souboru po offsetu, takže
 * se na disku nezdvojuje. `PART_SIZE` je pod limit s rezervou.
 */
const PART_SIZE = 48 * 1024 * 1024;

export function partCount(totalBytes, partSize = PART_SIZE) {
  return Math.max(1, Math.ceil(totalBytes / partSize));
}

export function partName(base, index) {
  return `${base}.part-${String(index + 1).padStart(4, "0")}`;
}

/** Archiv jde do jiného bucketu než uživatelská média, takže má vlastní cestu. */
async function uploadArchiveParts(base, file, bytes, onProgress) {
  const parts = partCount(bytes);
  for (let index = 0; index < parts; index += 1) {
    const start = index * PART_SIZE;
    const end = Math.min(start + PART_SIZE, bytes) - 1;
    const size = end - start + 1;
    const response = await fetch(`${url}/storage/v1/object/${BACKUP_BUCKET}/${encodePath(partName(base, index))}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/octet-stream", "x-upsert": "true" },
      body: Readable.toWeb(createReadStream(file, { start, end })),
      duplex: "half",
    });
    if (!response.ok) throw new Error(`Nahrání části ${index + 1}/${parts} selhalo: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    onProgress?.(index + 1, parts, end + 1);
  }
  return parts;
}

/** Při obnově se části spojí v pořadí do jednoho souboru a ten se rozbalí. */
async function downloadArchiveParts(base, parts, target) {
  const stream = createWriteStream(target);
  for (let index = 0; index < parts; index += 1) {
    const response = await fetch(`${url}/storage/v1/object/${BACKUP_BUCKET}/${encodePath(partName(base, index))}`, { headers });
    if (!response.ok) throw new Error(`Stažení části ${index + 1}/${parts} selhalo: HTTP ${response.status}`);
    await pipeline(response.body, stream, { end: false });
  }
  await new Promise((resolve, reject) => { stream.end(resolve); stream.on("error", reject); });
}

// ---------------------------------------------------------------------------
// Obnova
// ---------------------------------------------------------------------------

async function runRestore(job) {
  const jobId = job.id;
  const sourceUserId = typeof job.progress?.sourceUserId === "string" ? job.progress.sourceUserId : job.target_user_id;
  const targetUserId = job.target_user_id;
  if (!targetUserId) throw new Error("Obnova nemá cílový účet.");
  if (!job.source_backup_id) throw new Error("Obnova nemá zdrojovou zálohu.");

  const sourceList = await request(
    api("sc_service_backups", `?id=eq.${encodeURIComponent(job.source_backup_id)}&select=id,archive_path,archive_parts,archive_bytes,status,kind`),
  );
  const backup = Array.isArray(sourceList) ? sourceList[0] : null;
  if (!backup || backup.kind !== "backup" || backup.status !== "done" || !backup.archive_path) {
    throw new Error("Zdrojová záloha není hotová nebo nemá archiv.");
  }

  const dir = path.join(workRoot, `restore-${jobId}`);
  const archivePath = path.join(workRoot, `${jobId}.${ARCHIVE_FORMAT}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const parts = Number(backup.archive_parts || 1);
  await setProgress(jobId, step("downloading", { source: backup.archive_path, parts }));
  await downloadArchiveParts(backup.archive_path, parts, archivePath);
  await extractArchive(archivePath, dir);

  const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  const archivedUser = manifest.users?.find((entry) => entry.userId === sourceUserId);
  if (!archivedUser) {
    throw new Error(`V archivu není uživatel ${sourceUserId}. V archivu jsou: ${(manifest.users ?? []).map((entry) => entry.email ?? entry.userId).join(", ")}`);
  }

  const remap = sourceUserId === targetUserId ? null : { from: sourceUserId, to: targetUserId };
  const plan = planRestore(sourceUserId, targetUserId);
  const rowsDir = path.join(dir, "rows", sourceUserId);
  const filesDir = path.join(dir, "files", sourceUserId);

  let inserted = 0;
  for (const [table, expected] of Object.entries(archivedUser.tables ?? {})) {
    if (!OWNED_TABLES.includes(table)) continue;
    const file = path.join(rowsDir, `${table}.jsonl`);
    if (!existsSync(file)) throw new Error(`V archivu chybí ${table} pro daného uživatele.`);

    const rows = (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    if (rows.length !== expected) throw new Error(`${table}: v archivu ${rows.length} řádků, manifest tvrdí ${expected}. Archiv je poškozený.`);

    const payload = rows.map(plan.row);
    const chunkSize = 200;
    for (let start = 0; start < payload.length; start += chunkSize) {
      const chunk = payload.slice(start, start + chunkSize);
      await request(api(table, `?on_conflict=${primaryKey(table)}`), { method: "POST", body: JSON.stringify(chunk) });
    }
    inserted += payload.length;
    await setProgress(jobId, step("rows", { table, inserted }));
  }

  // Staré řádky, které v archivu nejsou, obnova znamená smazat. Děti před
  // rodiči, jinak to skončí na cizím klíči.
  let removed = 0;
  for (const table of deleteOrder(archivedUser.tables ?? {})) {
    const key = primaryKey(table);
    const keep = new Set(
      (await readFile(path.join(rowsDir, `${table}.jsonl`), "utf8"))
        .split("\n").filter(Boolean).map((line) => JSON.parse(line)[key]),
    );
    const existing = await request(api(table, `?user_id=eq.${encodeURIComponent(targetUserId)}&select=${key}`));
    const stale = existing.map((row) => row[key]).filter((value) => !keep.has(value));
    if (stale.length === 0) continue;
    await request(api(table, `?${key}=in.(${stale.join(",")})&user_id=eq.${encodeURIComponent(targetUserId)}`), {
      method: "DELETE",
      headers: { Prefer: "return=minimal" },
    });
    removed += stale.length;
    await setProgress(jobId, step("pruning", { table, removed }));
  }

  let files = 0;
  let bytes = 0;
  for (const entry of await walkAllFiles(filesDir)) {
    const relative = path.relative(filesDir, entry.absolute).split(path.sep).join("/");
    await uploadFrom(plan.file(relative), entry.absolute, null, entry.size);
    files += 1;
    bytes += entry.size;
    if (files % 5 === 0) await setProgress(jobId, step("files", { files, bytes }));
  }

  await request(api("sc_service_backups", `?id=eq.${encodeURIComponent(jobId)}`), {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      status: "done",
      manifest: { sourceUserId, targetUserId, remapped: Boolean(remap), rows: inserted, removed, files, bytes },
      progress: step("done", { rows: inserted, removed, files, bytes }),
      finished_at: new Date().toISOString(),
    }),
  });

  await rm(dir, { recursive: true, force: true });
  await rm(archivePath, { force: true });
  console.log(`[${jobId}] obnova hotová: ${inserted} řádků, ${files} souborů${remap ? ", user_id přemapován" : ""}`);
}

async function walkAllFiles(root, out = []) {
  if (!existsSync(root)) return out;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) await walkAllFiles(absolute, out);
    else out.push({ absolute, size: (await stat(absolute)).size });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Smyčka
// ---------------------------------------------------------------------------

async function tick() {
  // Úloha, která zůstala ve stavu running, je buď visící worker, nebo spadla.
  // Bez toho by fronta zůstala zablokovaná navždy. Stojí na `started_at`,
  // ne na `lease_expires_at` jako u renderu - tady žádný lease není, protože
  // záloha je jediný krok a nemá se o ni kdo převzít.
  const staleBefore = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  await request(
    api("sc_service_backups", `?status=eq.running&started_at=lt.${encodeURIComponent(staleBefore)}`),
    { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "failed", error_message: "Worker se ztratil, úloha byla označena za selhanou.", finished_at: new Date().toISOString() }) },
  ).catch((error) => console.error("zastaralé úlohy:", error instanceof Error ? error.message : error));

  const jobs = await request(
    api("sc_service_backups", "?select=id,kind,status,source_backup_id,target_user_id,progress&status=eq.queued&order=created_at.asc&limit=1"),
  );
  const job = Array.isArray(jobs) ? jobs[0] : null;
  if (!job) return;
  const claimed = await claim(job.id);
  if (!claimed) return;
  console.log(`[${claimed.id}] beru úlohu ${claimed.kind}`);
  try {
    if (claimed.kind === "backup") await runBackup(claimed);
    else await runRestore({ ...claimed, progress: job.progress });
  } catch (error) {
    await fail(claimed.id, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Obnova jednoho uživatele do cílového účtu.
 *
 * Klíčová vlastnost: při `restore_new` má zdrojový účet v archivu jiné UUID než
 * cílový, takže se přepisuje `user_id` v každém řádku a první segment cesty
 * každého souboru. Bez toho by cizí data skončila pod účtem, který je nevlastnil,
 * a přesně to je ta chyba, kterou celá ta izolace řeší.
 *
 * Vnitřní ID řádků se NEMĚNÍ, aby vazby mezi tabulkami (sc_audio_versions.song_id,
 * youtube_publications.agent_video_id) zůstaly konzistentní.
 */
export function planRestore(sourceUserId, targetUserId, rows, relativeFile) {
  const remapped = sourceUserId !== targetUserId;
  return {
    remapped,
    row: (row) => (remapped ? { ...row, user_id: targetUserId } : row),
    file: (relativePath) => (remapped ? `${targetUserId}/${relativePath}` : `${sourceUserId}/${relativePath}`),
    // Cesta v archivu, kde leží soubor daného uživatele.
    archivedFile: (relativePath) => `${sourceUserId}/${relativePath}`,
  };
}

/** Pořadí mazání musí mít děti před rodiči, jinak to spadne na cizím klíči. */
export function deleteOrder(archivedTables) {
  return DELETE_ORDER.filter((table) => Object.prototype.hasOwnProperty.call(archivedTables, table));
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

export { OWNED_TABLES, DELETE_ORDER, BUCKET, BACKUP_BUCKET, ARCHIVE_FORMAT, PART_SIZE, encodePath };

if (isMain) {
  if (!url || !key) throw new Error("SUPABASE_URL a SUPABASE_SERVICE_ROLE_KEY jsou povinné");
  console.log(`SongCraft backup worker ready; interval ${interval}ms; work ${workRoot}`);
  do {
    await tick().catch((error) => console.error(error));
    if (process.env.RUN_ONCE === "1") break;
    await new Promise((resolve) => setTimeout(resolve, interval));
  } while (true);
}