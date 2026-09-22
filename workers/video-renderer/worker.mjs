#!/usr/bin/env node
/**
 * Temney Agent v3.0 ffmpeg worker.
 * Run on a persistent VM with ffmpeg installed.
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WORKER_INTERVAL_MS (optional).
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
const exec = promisify(execFile);
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const bucket = "songcraft";
const interval = Number(process.env.WORKER_INTERVAL_MS || 30000);
if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
const api = (table, query = "") => `${url}/rest/v1/${table}${query}`;
async function request(endpoint, options = {}) { const response = await fetch(endpoint, { ...options, headers: { ...headers, ...(options.headers || {}) } }); if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`); return response.status === 204 ? null : response.json(); }
async function signed(pathname) { const result = await request(`${url}/storage/v1/object/sign/${bucket}/${pathname.split("/").map(encodeURIComponent).join("/")}`, { method: "POST", body: JSON.stringify({ expiresIn: 900 }) }); return `${url}/storage/v1${result.signedURL}`; }
async function download(file, target) { const response = await fetch(file); if (!response.ok) throw new Error(`Download failed ${response.status}`); await writeFile(target, Buffer.from(await response.arrayBuffer())); }
async function processJob(job) {
  const work = path.join("/tmp", `temney-${job.id}`); await mkdir(work, { recursive: true });
  try {
    const songs = await request(api("sc_songs", `?select=id,title,cover_path&id=eq.${encodeURIComponent(job.song_id)}&user_id=eq.${encodeURIComponent(job.user_id)}`)); const song = songs?.[0]; if (!song) throw new Error("Song not found");
    const versions = await request(api("sc_audio_versions", `?select=storage_path,is_final,is_primary&song_id=eq.${encodeURIComponent(job.song_id)}&user_id=eq.${encodeURIComponent(job.user_id)}&order=is_final.desc,is_primary.desc&limit=1`)); const version = versions?.[0]; if (!version) throw new Error("No final audio version"); if (!song.cover_path) throw new Error("No artwork");
    const audio = path.join(work, "audio.mp3"); const artwork = path.join(work, "artwork.jpg"); const output = path.join(work, "render.mp4"); await download(await signed(version.storage_path), audio); await download(await signed(song.cover_path), artwork);
    await exec("ffmpeg", ["-y", "-loop", "1", "-i", artwork, "-i", audio, "-vf", "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,format=yuv420p", "-c:v", "libx264", "-tune", "stillimage", "-c:a", "aac", "-b:a", "192k", "-shortest", output]);
    const bytes = await import("node:fs/promises").then((fs) => fs.readFile(output)); const outputPath = `${job.user_id}/videos/${job.id}.mp4`; const upload = await fetch(`${url}/storage/v1/object/${bucket}/${outputPath}`, { method: "POST", headers: { ...headers, "Content-Type": "video/mp4", "x-upsert": "true" }, body: bytes }); if (!upload.ok) throw new Error(`Upload failed ${upload.status}: ${await upload.text()}`);
    await request(api("agent_videos", `?id=eq.${job.id}&user_id=eq.${job.user_id}`), { method: "PATCH", body: JSON.stringify({ render_status: "ready", storage_path: outputPath }) }); console.log(`[ready] ${job.id}`);
  } catch (error) { const message = error instanceof Error ? error.message : String(error); await request(api("agent_videos", `?id=eq.${job.id}&user_id=eq.${job.user_id}`), { method: "PATCH", body: JSON.stringify({ render_status: "failed", error_message: message.slice(0, 1000) }) }).catch(() => {}); console.error(`[failed] ${job.id}: ${message}`); }
  await rm(work, { recursive: true, force: true });
}
async function tick() { const jobs = await request(api("agent_videos", "?select=id,user_id,song_id,type&render_status=eq.queued&order=created_at.asc&limit=1")); const job = jobs?.[0]; if (!job) return; const claimed = await request(api("agent_videos", `?id=eq.${job.id}&render_status=eq.queued`), { method: "PATCH", body: JSON.stringify({ render_status: "rendering" }) }); if (claimed) await processJob({ ...job }); }
console.log(`Temney renderer ready; interval ${interval}ms`); while (true) { await tick().catch((error) => console.error(error)); await new Promise((resolve) => setTimeout(resolve, interval)); }
