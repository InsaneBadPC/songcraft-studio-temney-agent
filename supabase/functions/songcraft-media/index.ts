import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import NodeID3 from "npm:node-id3";
import { Buffer } from "node:buffer";
import { isAllowedPrivateUser, privateAccessMessage } from "../_shared/access.ts";
import { createR2Client, mediaKey } from "../_shared/r2.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const safeFileName = (name: string) => name.normalize("NFKC").replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^[_.-]+/, "").replace(/_+/g, "_").slice(-180) || "songcraft-file";

function ownedPath(userId: string, value: unknown): string | null {
  const key = mediaKey(value);
  if (!key) return null;
  return key === userId || key.startsWith(`${userId}/`) ? key : null;
}

function validAudio(bytes: Uint8Array, mime: string | null) {
  if (bytes.byteLength > MAX_AUDIO_BYTES || bytes.byteLength === 0) return false;
  if (mime === "audio/mp4" || mime === "audio/x-m4a") return bytes.byteLength >= 12 && new TextDecoder().decode(bytes.slice(4, 8)) === "ftyp";
  if (mime === "audio/aac") return bytes.byteLength >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf0) === 0xf0;
  return mime === "audio/mpeg" || mime === "audio/mp3" || mime === "application/octet-stream"
    ? bytes.byteLength >= 3 && (new TextDecoder().decode(bytes.slice(0, 3)) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))
    : false;
}

function validImage(bytes: Uint8Array, mime: string | null) {
  if (bytes.byteLength > MAX_IMAGE_BYTES || bytes.byteLength === 0) return false;
  if (mime === "image/png") return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value);
  if (mime === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/webp") return new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
  return false;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json({ error: "Použij POST požadavek." }, 405);

  const authorization = request.headers.get("Authorization");
  if (!authorization) return json({ error: "Chybí přihlášení." }, 401);
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || Deno.env.get("SONGCRAFT_SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SONGCRAFT_SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SONGCRAFT_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) return json({ error: "Externí cloud není správně nakonfigurován." }, 503);

  const authClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: authError } = await authClient.auth.getUser();
  if (authError || !user) return json({ error: "Neplatné přihlášení." }, 401);
  if (!isAllowedPrivateUser(user, { allowedUserIds: Deno.env.get("SONGCRAFT_ALLOWED_USER_IDS") ?? undefined, allowedEmails: Deno.env.get("SONGCRAFT_ALLOWED_EMAILS") ?? undefined })) return json({ error: privateAccessMessage() }, 403);

  const input = await request.json().catch(() => null) as { action?: unknown; versionId?: unknown; label?: unknown; note?: unknown } | null;
  if (input?.action === "health") return json({ ok: true, service: "songcraft-media" });
  if (input?.action !== "prepare_tagged_copy" || typeof input.versionId !== "string" || typeof input.label !== "string" || !input.label.trim()) {
    return json({ error: "Neplatný požadavek na přípravu MP3 kopie." }, 400);
  }
  const versionId = input.versionId.trim();
  const label = input.label.trim().slice(0, 120);
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 500) : null;
  if (!/^[0-9a-f-]{36}$/i.test(versionId)) return json({ error: "Neplatné ID zvukové verze." }, 400);

  const admin = createClient(supabaseUrl, serviceKey);
  const { data: version, error: versionError } = await admin
    .from("sc_audio_versions")
    .select("id,user_id,song_id,original_file_name,original_storage_path,storage_path,tagged_storage_path,mime_type,byte_size,id3_album,id3_track_number,id3_year,id3_genre,id3_comment")
    .eq("id", versionId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (versionError || !version) return json({ error: "Zvuková verze nebyla nalezena." }, 404);

  const { data: song, error: songError } = await admin.from("sc_songs").select("id,user_id,title,album_id,cover_path").eq("id", version.song_id).eq("user_id", user.id).maybeSingle();
  if (songError || !song) return json({ error: "Skladba pro zvukovou verzi nebyla nalezena." }, 404);
  const { data: album } = song.album_id
    ? await admin.from("sc_albums").select("name,cover_path,user_id").eq("id", song.album_id).eq("user_id", user.id).maybeSingle()
    : { data: null };

  // original_storage_path is immutable after the core-schema migration. The
  // fallback is only for legacy rows and is still constrained to this tenant.
  const sourcePath = ownedPath(user.id, version.original_storage_path ?? version.storage_path);
  if (!sourcePath) return json({ error: "Původní MP3 nemá platnou cestu vlastníka." }, 409);
  let r2: ReturnType<typeof createR2Client>;
  try {
    r2 = createR2Client();
  } catch (error) {
    return json({ error: `Media store není dostupný: ${error instanceof Error ? error.message : "neznámá chyba"}` }, 503);
  }

  let sourceResponse: Response;
  try {
    sourceResponse = await r2.getObject(sourcePath, 15 * 60);
  } catch {
    return json({ error: "Původní MP3 se nepodařilo načíst." }, 502);
  }
  const source = new Uint8Array(await sourceResponse.arrayBuffer());
  if (!validAudio(source, sourceResponse.headers.get("content-type") || version.mime_type)) return json({ error: "Soubor není platný podporovaný MP3/audio soubor." }, 415);

  let image: { mime: string; type: { id: number }; description: string; imageBuffer: Buffer } | undefined;
  const coverPath = ownedPath(user.id, song.cover_path ?? album?.cover_path);
  if (coverPath) {
    try {
      const coverResponse = await r2.getObject(coverPath, 15 * 60);
      const coverBytes = new Uint8Array(await coverResponse.arrayBuffer());
      const mime = coverResponse.headers.get("content-type") || (coverBytes[0] === 0x89 ? "image/png" : coverBytes[0] === 0xff ? "image/jpeg" : "image/webp");
      if (validImage(coverBytes, mime)) image = { mime, type: { id: mime === "image/png" ? 3 : mime === "image/jpeg" ? 3 : 6 }, description: "SongCraft cover", imageBuffer: Buffer.from(coverBytes) };
    } catch {
      image = undefined;
    }
  }

  const tagged = NodeID3.update({
    title: song.title,
    artist: "Temney",
    performerInfo: "Temney",
    album: album?.name || version.id3_album || "",
    trackNumber: version.id3_track_number || undefined,
    year: version.id3_year || undefined,
    genre: version.id3_genre || undefined,
    comment: note ? { language: "eng", text: note } : version.id3_comment ? { language: "eng", text: version.id3_comment } : undefined,
    image,
  }, Buffer.from(source));
  if (!Buffer.isBuffer(tagged)) return json({ error: "ID3 tagy se nepodařilo vložit do MP3." }, 500);

  const baseName = safeFileName(`Temney - ${song.title}${album?.name ? ` - ${album.name}` : ""} - ${label}`).replace(/\.mp3$/i, "");
  const targetKey = `${user.id}/audio/tagged/${crypto.randomUUID()}-${baseName}.mp3`;
  try {
    await r2.putObject(targetKey, tagged, "audio/mpeg", 15 * 60);
  } catch {
    return json({ error: "Hotovou MP3 kopii se nepodařilo uložit." }, 502);
  }
  const targetPath = `r2://${Deno.env.get("R2_BUCKET") || "songcraft-studio"}/${targetKey}`;
  await admin.from("sc_media_objects").upsert({
    user_id: user.id,
    storage_path: targetPath,
    kind: "audio",
    byte_size: tagged.byteLength,
    content_type: "audio/mpeg",
    original_file_name: `${baseName}.mp3`,
    state: "active",
  }, { onConflict: "user_id,storage_path" });
  await admin.from("sc_metering_events").insert({ user_id: user.id, kind: "upload", byte_size: tagged.byteLength, storage_path: targetPath });

  const { error: updateError } = await admin
    .from("sc_audio_versions")
    .update({ tagged_storage_path: targetPath, label, id3_title: song.title, id3_artist: "Temney", id3_album: album?.name || null, id3_comment: note ?? version.id3_comment ?? null, updated_at: new Date().toISOString() })
    .eq("id", version.id)
    .eq("user_id", user.id);
  if (updateError) {
    // The object is private and unreferenced; a later cleanup job can remove it.
    return json({ error: "Hotovou MP3 se sice podařilo uložit, ale nepodařilo se aktualizovat metadata." }, 502);
  }

  return json({ path: targetPath, fileName: `${baseName}.mp3` });
});
