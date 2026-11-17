import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { isAllowedPrivateUser, privateAccessMessage } from "../_shared/access.ts";
import { createR2Client, mediaKey, parseR2Path } from "../_shared/r2.ts";
import { resolveCallerScope } from "../_shared/scheduler-auth.ts";

/**
 * Media store: jediné místo, kde se binárky stahují a ukládají.
 *
 * Proč to existuje:
 * - Supabase Storage na free planu má 1 GB a projekt byl tvrdě omezený
 *   (402). Binárky (MP3, obaly, video) proto žijí v Cloudflare R2.
 * - Klient dřív podepisoval URL na každý řádek snapshotu = ~160 API
 *   requestů na jedno načtení obrazovky. Tady se podepíše DAVKOVĚ:
 *   1 request na libovolný počet cest.
 * - Před každým uploadem se kontroluje rozpočet uživatele, aby se kvóty
 *   nepřekročily tiše až do restrikce projektu.
 */

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });

const MAX_COVER_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const SIGN_BATCH_LIMIT = 400;
const SIGN_TTL_SECONDS = 60 * 60;

const safeFileName = (name: string) => name.normalize("NFKC").replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^[_.-]+/, "").replace(/_+/g, "_").slice(-180) || "songcraft-file";

type Folder = "covers" | "audio" | "videos" | "media";

const folderLimit = (folder: Folder) => folder === "covers" ? MAX_COVER_BYTES : folder === "audio" ? MAX_AUDIO_BYTES : MAX_VIDEO_BYTES;

const isR2Path = (value: string) => value.startsWith("r2://");

/** Cesta musí patřit vlastníkovi - stejné pravidlo jako v DB guardu. */
function ownedPath(userId: string, value: unknown): string | null {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("..") || value.startsWith("/")) return null;
  if (isR2Path(value)) {
    const parsed = parseR2Path(value);
    if (!parsed || parsed.bucket !== "songcraft-studio") return null;
    return parsed.key === userId || parsed.key.startsWith(`${userId}/`) ? value : null;
  }
  if (value.includes("//")) return null;
  return value === userId || value.startsWith(`${userId}/`) ? value : null;
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function kindForFolder(folder: Folder): "cover" | "audio" | "video" | "media" {
  if (folder === "covers") return "cover";
  if (folder === "audio") return "audio";
  if (folder === "media") return "media";
  return "video";
}

function contentTypeFor(path: string, fallback: string | null): string {
  if (fallback) return fallback;
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".mp4") || lower.endsWith(".m4a")) return "video/mp4";
  return "application/octet-stream";
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json({ error: "Použij POST požadavek." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || Deno.env.get("SONGCRAFT_SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SONGCRAFT_SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SONGCRAFT_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) return json({ error: "Externí cloud není správně nakonfigurován." }, 503);

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const input = await request.json().catch(() => null) as Record<string, unknown> | null;
  const action = typeof input?.action === "string" ? input.action : "";

  // -------------------------------------------------------------------------
  // purge_expired: plánované mazání DERIVÁTŮ (MP4 renderů) po purge_after.
  // Zdroje (obaly, MP3) se nemažou nikdy. Volá scheduler (cron).
  // -------------------------------------------------------------------------
  if (action === "purge_expired") {
    const env = {
      url: supabaseUrl,
      anonKey,
      serviceRoleKey: serviceKey,
      cronSecret: Deno.env.get("MEDIA_PURGE_CRON_SECRET") || Deno.env.get("SONGCRAFT_MEDIA_PURGE_CRON_SECRET"),
    };
    const verifyUser = async (bearer: string): Promise<string | null> => {
      const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: `Bearer ${bearer}` } } });
      const { data, error } = await auth.auth.getUser();
      return error || !data?.user ? null : data.user.id;
    };
    const verifyServiceRoleClaim = async (bearer: string): Promise<boolean> => {
      const auth = createClient(supabaseUrl, anonKey);
      const { data, error } = await auth.auth.getClaims(bearer);
      return !error && data?.claims?.role === "service_role";
    };
    const caller = await resolveCallerScope(request, env, { user: verifyUser, serviceRoleClaim: verifyServiceRoleClaim });
    if (!caller.ok) return json({ error: caller.error }, caller.status);
    if (caller.scope.role !== "scheduler") return json({ error: "Mazání smí spustit jen plánovač." }, 403);

    const { data: expired, error } = await admin
      .from("sc_media_objects")
      .select("id,user_id,storage_path,kind")
      .eq("state", "active")
      .eq("kind", "video")
      .not("purge_after", "is", null)
      .lt("purge_after", new Date().toISOString())
      .limit(200);
    if (error) return json({ error: error.message }, 400);

    let purged = 0;
    const failures: string[] = [];
    for (const row of expired ?? []) {
      try {
        const key = mediaKey(row.storage_path);
        if (!key) throw new Error("Cesta média je rozbitá.");
        const r2 = createR2Client();
        await r2.deleteObject(key);
        await admin.from("sc_media_objects").update({ state: "purged" }).eq("id", row.id);
        await admin.from("sc_metering_events").insert({ user_id: row.user_id, kind: "purge", byte_size: 0, storage_path: row.storage_path });
        purged += 1;
      } catch (caught) {
        failures.push(`${row.storage_path}: ${caught instanceof Error ? caught.message : "chyba"}`);
      }
    }
    return json({ ok: true, purged, failed: failures.length, failures });
  }

  const authorization = request.headers.get("Authorization");
  if (!authorization) return json({ error: "Chybí přihlášení." }, 401);

  const authClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: authError } = await authClient.auth.getUser();
  if (authError || !user) return json({ error: "Neplatné přihlášení." }, 401);
  if (!isAllowedPrivateUser(user, { allowedUserIds: Deno.env.get("SONGCRAFT_ALLOWED_USER_IDS") ?? undefined, allowedEmails: Deno.env.get("SONGCRAFT_ALLOWED_EMAILS") ?? undefined })) {
    return json({ error: privateAccessMessage() }, 403);
  }

  if (action === "health") {
    return json({ ok: true, service: "songcraft-media-store", r2Configured: Boolean(Deno.env.get("R2_ACCESS_KEY_ID")) });
  }

  // -------------------------------------------------------------------------
  // sign_batch: podepíše libovolný počet cest v JEDNOM requestu.
  // -------------------------------------------------------------------------
  if (action === "sign_batch") {
    const rawPaths = Array.isArray(input?.paths) ? input.paths : [];
    const paths = rawPaths
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .map((value) => ownedPath(user.id, value))
      .filter((value): value is string => Boolean(value))
      .slice(0, SIGN_BATCH_LIMIT);

    const unique = [...new Set(paths)];
    const urls: Record<string, string> = {};

    try {
      const r2 = createR2Client();
      for (const path of unique) {
        const key = mediaKey(path);
        if (!key) continue;
        urls[path] = await r2.presign("GET", key, SIGN_TTL_SECONDS);
      }
    } catch {
      return json({ error: "R2 není nakonfigurované." }, 503);
    }

    return json({ urls });
  }

  // -------------------------------------------------------------------------
  // usage: kolik uživatel snědl (storage + egress) a zda je blokovaný.
  // -------------------------------------------------------------------------
  if (action === "usage") {
    const { data, error } = await admin.rpc("sc_media_usage", { p_user_id: user.id });
    if (error) return json({ error: error.message }, 400);
    return json({ usage: data ?? null });
  }

  // -------------------------------------------------------------------------
  // upload_intent: vrátí podepsanou PUT URL, aby klient poslal soubor
  // PŘÍMO do R2. Data nejdou přes edge funkci (50 MB MP3 by se tam nevešly
  // a Supabase by to zbytečně počítal jako egress).
  // -------------------------------------------------------------------------
  if (action === "upload_intent") {
    const folder = typeof input?.folder === "string" ? input.folder as Folder : null;
    const fileName = typeof input?.fileName === "string" ? input.fileName : "";
    const contentType = typeof input?.contentType === "string" ? input.contentType : null;
    const byteSize = Number(input?.byteSize ?? 0);
    if (!folder || !["covers", "audio", "videos", "media"].includes(folder)) return json({ error: "Neplatná složka." }, 400);
    if (!fileName) return json({ error: "Chybí název souboru." }, 400);
    if (!Number.isFinite(byteSize) || byteSize <= 0) return json({ error: "Soubor je prázdný." }, 400);
    if (byteSize > folderLimit(folder)) return json({ error: `Soubor je větší než limit pro ${folder}.` }, 413);

    const { data: usage } = await admin.rpc("sc_media_usage", { p_user_id: user.id });
    const maxStorage = Number(usage?.maxStorageBytes ?? 2147483648);
    const storageBytes = Number(usage?.storageBytes ?? 0);
    if (storageBytes + byteSize > maxStorage) {
      return json({
        error: "Došlo k tvému limitu pro média. Uvolni prostor (např. smaž staré video) a zkus to znovu.",
        code: "budget_exceeded",
        usage: usage ?? null,
      }, 413);
    }

    const key = `${user.id}/${folder}/${Date.now()}-${safeFileName(fileName)}`;
    const type = contentTypeFor(key, contentType);
    const bucket = "songcraft-studio";

    try {
      const r2 = createR2Client();
      const uploadUrl = await r2.presign("PUT", key, 15 * 60);
      return json({ key: `r2://${bucket}/${key}`, uploadUrl, contentType: type, byteSize });
    } catch (error) {
      return json({ error: `Media store není dostupný: ${error instanceof Error ? error.message : "neznámá chyba"}` }, 503);
    }
  }

  // -------------------------------------------------------------------------
  // upload: uloží binárku do R2 a zaregistruje ji (fallback pro web).
  // -------------------------------------------------------------------------
  if (action === "upload") {
    const folder = typeof input?.folder === "string" ? input.folder as Folder : null;
    const fileName = typeof input?.fileName === "string" ? input.fileName : "";
    const base64 = typeof input?.base64 === "string" ? input.base64 : "";
    const contentType = typeof input?.contentType === "string" ? input.contentType : null;
    if (!folder || !["covers", "audio", "videos", "media"].includes(folder)) return json({ error: "Neplatná složka." }, 400);
    if (!fileName || !base64) return json({ error: "Chybí soubor." }, 400);

    const bytes = decodeBase64(base64);
    if (!bytes || bytes.byteLength === 0) return json({ error: "Soubor se nepodařilo přečíst." }, 400);
    if (bytes.byteLength > folderLimit(folder)) {
      return json({ error: `Soubor je větší než limit pro ${folder}.` }, 413);
    }

    const { data: usage } = await admin.rpc("sc_media_usage", { p_user_id: user.id });
    const maxStorage = Number(usage?.maxStorageBytes ?? 2147483648);
    const storageBytes = Number(usage?.storageBytes ?? 0);
    if (storageBytes + bytes.byteLength > maxStorage) {
      return json({
        error: "Došlo k tvému limitu pro média. Uvolni prostor (např. smaž staré video) a zkus to znovu.",
        code: "budget_exceeded",
        usage: usage ?? null,
      }, 413);
    }

    const key = `${user.id}/${folder}/${Date.now()}-${safeFileName(fileName)}`;
    const type = contentTypeFor(key, contentType);

    try {
      const r2 = createR2Client();
      await r2.putObject(key, bytes, type, SIGN_TTL_SECONDS);
    } catch (error) {
      return json({ error: `Media store není dostupný: ${error instanceof Error ? error.message : "neznámá chyba"}` }, 503);
    }

    const storagePath = `r2://songcraft-studio/${key}`;
    const sha256 = await sha256Hex(bytes);

    const { error: registerError } = await admin.from("sc_media_objects").upsert({
      user_id: user.id,
      storage_path: storagePath,
      kind: kindForFolder(folder),
      byte_size: bytes.byteLength,
      content_type: type,
      original_file_name: fileName.slice(0, 180),
      sha256,
      state: "active",
    }, { onConflict: "user_id,storage_path" });

    await admin.from("sc_metering_events").insert({ user_id: user.id, kind: "upload", byte_size: bytes.byteLength, storage_path: storagePath });

    if (registerError) {
      return json({ error: `Soubor se uložil, ale nezapsal do katalogu: ${registerError.message}` }, 500);
    }

    let url: string | null = null;
    try {
      const r2 = createR2Client();
      url = await r2.presign("GET", key, SIGN_TTL_SECONDS);
    } catch {
      url = null;
    }

    return json({ key: storagePath, url, byteSize: bytes.byteLength, contentType: type, sha256 });
  }

  // -------------------------------------------------------------------------
  // register: worker/renderer zaregistruje hotový render a nastaví
  // purge_after = published_at + 7 dní (derivát se ukládá, zdroje ne).
  // -------------------------------------------------------------------------
  if (action === "register") {
    const storagePath = typeof input?.storagePath === "string" ? input.storagePath : "";
    const byteSize = Number(input?.byteSize ?? 0);
    const kind = typeof input?.kind === "string" ? input.kind : "video";
    const sha256 = typeof input?.sha256 === "string" ? input.sha256 : null;
    const publishedAt = typeof input?.publishedAt === "string" ? input.publishedAt : null;
    const path = ownedPath(user.id, storagePath);
    if (!path) return json({ error: "Cesta nepatří uživateli." }, 403);

    const purgeAfter = publishedAt ? new Date(new Date(publishedAt).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString() : null;
    const { error } = await admin.from("sc_media_objects").upsert({
      user_id: user.id,
      storage_path: path,
      kind: kind === "video" ? "video" : kind === "audio" ? "audio" : kind === "cover" ? "cover" : "media",
      byte_size: Number.isFinite(byteSize) && byteSize >= 0 ? byteSize : 0,
      sha256,
      state: "active",
      published_at: publishedAt,
      purge_after: purgeAfter,
    }, { onConflict: "user_id,storage_path" });
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true, path, purgeAfter });
  }

  // -------------------------------------------------------------------------
  // delete: smaže objekt (jen vlastní, jen derivát po purge_after).
  // -------------------------------------------------------------------------
  if (action === "delete") {
    const storagePath = typeof input?.storagePath === "string" ? input.storagePath : "";
    const path = ownedPath(user.id, storagePath);
    if (!path) return json({ error: "Cesta nepatří uživateli." }, 403);

    const { data: row } = await admin.from("sc_media_objects").select("id,kind,state,purge_after").eq("user_id", user.id).eq("storage_path", path).maybeSingle();
    if (!row) return json({ error: "Soubor není v katalogu." }, 404);
    if (row.kind === "cover" || row.kind === "audio" || row.kind === "media") {
      return json({ error: "Zdrojová média (obaly, MP3, nahrané soubory) se mazat nesmějí." }, 409);
    }
    if (row.purge_after && new Date(row.purge_after).getTime() > Date.now()) {
      return json({ error: "Video se maže až 7 dní po zveřejnění.", purgeAfter: row.purge_after }, 409);
    }

    const key = mediaKey(path);
    if (!key) return json({ error: "Cesta média je rozbitá." }, 400);
    try {
      const r2 = createR2Client();
      await r2.deleteObject(key);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Mazání selhalo." }, 503);
    }

    await admin.from("sc_media_objects").update({ state: "purged" }).eq("user_id", user.id).eq("storage_path", path);
    await admin.from("sc_metering_events").insert({ user_id: user.id, kind: "purge", byte_size: 0, storage_path: path });
    return json({ ok: true, path });
  }

  return json({ error: "Neznámá akce." }, 400);
});
