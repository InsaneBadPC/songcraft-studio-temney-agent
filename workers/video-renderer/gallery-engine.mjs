// Složení videa z více obrázků nebo videí jedné písně.
//
// Na rozdíl od loop-engine nemá jeden zdroj a náhodný plán průchodů - tady je
// přesně to, co uživatel vidí v panelu:
//
//   [obál písně 5 s] -> [scéna 8 s] -> [scéna 8 s] ... -> [obál písně 5 s]
//
// Scény se střídají v ručně nastaveném pořadí a opakují se, dokud hraje hudba.
// Obál je začátek a konec, ne položka smyčky.
//
// Každá scéna se znormalizuje na 1280x720 /24 fps, takže se pak dají spojit
// demuxerem bez překódování - na VM s 954 MB RAM je to jediná varianta, která
// nepotřebuje držet celé video v paměti.

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const FPS = 24;
const W = 1280;
const H = 720;
const THREADS = "2";

/** Přesné časy zadáním uživatele - když je chceš změnit, jde se sem. */
export const COVER_LEAD_SECONDS = 5;
export const COVER_TAIL_SECONDS = 5;
export const SCENE_SECONDS = 8;

const ENCODE = [
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
  "-r", String(FPS), "-profile:v", "high", "-level", "4.1",
  "-g", String(FPS * 2), "-keyint_min", String(FPS), "-sc_threshold", "0", "-an",
];

const FLAT = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,format=yuv420p`;

async function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-nostdin", "-loglevel", "error", "-y", ...args]);
    let err = "";
    proc.stderr.on("data", (chunk) => {
      err += chunk.toString();
      if (err.length > 8000) err = err.slice(-8000);
    });
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err.trim()}`))));
  });
}

export async function probeDuration(file) {
  const out = await new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1", file,
    ]);
    let text = "";
    proc.stdout.on("data", (c) => (text += c.toString()));
    proc.on("error", reject);
    proc.on("close", () => resolve(text.trim()));
  });
  const value = Number(out);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`ffprobe neprečetl délku ${file}`);
  return value;
}

/** Obál (nebo obrázek) jako 5s klip s velmi pomalým nájezdem - nesmí to být čitelný text. */
async function coverClip(source, seconds, out, label) {
  const frames = Math.max(1, Math.round(seconds * FPS));
  // Nájezd je malý a symetrický (tam a zpět), aby nepřebíhal vlastní text.
  const graph = `[0:v]${FLAT},zoompan=z='1.0+0.012*sin(2*PI*on/${frames})'`
    + `:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${FPS},setsar=1[v]`;
  await ffmpeg([
    "-threads", THREADS, "-loop", "1", "-framerate", String(FPS), "-i", source,
    "-filter_complex", graph, "-map", "[v]",
    "-frames:v", String(frames), ...ENCODE, "-y", out,
  ]);
  void label;
  return frames;
}

/**
 * Scéna z obrázku - jemný Ken Burns. Směr a velikost se střídají, aby dvě
 * sousední scény nevypadaly stejně. Rychlost je záměrně malá.
 */
async function imageScene(source, seconds, out, index) {
  const frames = Math.max(1, Math.round(seconds * FPS));
  const variant = index % 4;
  const zoom = ["1.0+0.035*on/" + frames, "1.035-0.035*on/" + frames,
    "1.0+0.028*on/" + frames, "1.028-0.028*on/" + frames][variant];
  const driftX = variant % 2 === 0 ? `+14*sin(2*PI*on/${frames})` : `-14*sin(2*PI*on/${frames})`;
  const driftY = variant < 2 ? `+10*sin(2*PI*on/${frames * 0.6})` : `-10*sin(2*PI*on/${frames * 0.6})`;
  const graph = `[0:v]${FLAT},zoompan=z='${zoom}'`
    + `:x='iw/2-(iw/zoom/2)+${driftX}':y='ih/2-(ih/zoom/2)+${driftY}'`
    + `:s=${W}x${H}:fps=${FPS},setsar=1[v]`;
  await ffmpeg([
    "-threads", THREADS, "-loop", "1", "-framerate", String(FPS), "-i", source,
    "-filter_complex", graph, "-map", "[v]",
    "-frames:v", String(frames), ...ENCODE, "-y", out,
  ]);
  return frames;
}

/** Scéna z videa - krátký úsek, případně zopakovaný, když je klip kratší. */
async function videoScene(source, seconds, out, index) {
  const frames = Math.max(1, Math.round(seconds * FPS));
  const srcLen = await probeDuration(source).catch(() => 0);
  // Vezmeme prostředek klipu, ne začátek - tam bývá rozjezd a rozjezd je
  // nejhorší možný start scény.
  const start = Math.max(0, Math.floor((srcLen - seconds) / 2));
  const graph = `[0:v]${FLAT},setsar=1[v]`;
  const input = srcLen > 0 && srcLen < seconds
    ? ["-stream_loop", String(Math.ceil(seconds / Math.max(0.5, srcLen))), "-ss", "0", "-i", source]
    : ["-ss", String(start), "-i", source];
  await ffmpeg([
    "-threads", THREADS, ...input,
    "-filter_complex", graph, "-map", "[v]",
    "-frames:v", String(frames), ...ENCODE, "-y", out,
  ]);
  void index;
  return frames;
}

/**
 * @param {{audio: string, cover: string, scenes: {kind: "image"|"video", path: string, sceneMs?: number}[],
 *          out: string, workDir: string, onProgress?: (l: string) => void,
 *          coverLeadSeconds?: number, coverTailSeconds?: number, sceneSeconds?: number}} options
 */
export async function buildGalleryVideo(options) {
  const {
    audio, cover, scenes, out, workDir, onProgress = () => {},
    coverLeadSeconds = COVER_LEAD_SECONDS,
    coverTailSeconds = COVER_TAIL_SECONDS,
    sceneSeconds = SCENE_SECONDS,
  } = options;

  if (!audio) throw new Error("gallery engine potřebuje audio pro určení délky videa");
  if (!cover) throw new Error("gallery engine potřebuje obál písně");
  if (!scenes || !scenes.length) throw new Error("gallery engine potřebuje alespoň jednu scénu");

  await mkdir(workDir, { recursive: true });
  const duration = await probeDuration(audio);
  const lead = Math.min(coverLeadSeconds, duration / 3);
  const tail = Math.min(coverTailSeconds, Math.max(0, duration - lead));
  const body = Math.max(0, duration - lead - tail);
  onProgress(`skladba ${duration.toFixed(2)} s · obál ${lead}s + scény ${body.toFixed(2)}s + obál ${tail}s`);

  const clips = [];
  const totalFrames = Math.max(1, Math.round(duration * FPS));
  let madeFrames = 0;
  const index = { i: 0 };

  const addCover = async (seconds, tag) => {
    const remaining = totalFrames - madeFrames;
    if (remaining <= 0) return;
    const want = Math.min(Math.round(seconds * FPS), remaining);
    const file = path.join(workDir, `${tag}.mp4`);
    await coverClip(cover, want / FPS, file, tag);
    madeFrames += want;
    clips.push(file);
    onProgress(`  obál ${tag}: ${(want / FPS).toFixed(2)} s`);
  };

  const addScene = async (scene) => {
    const remaining = totalFrames - madeFrames;
    if (remaining <= 0) return;
    const seconds = scene.sceneMs && scene.sceneMs > 0 ? scene.sceneMs / 1000 : sceneSeconds;
    const want = Math.min(Math.round(seconds * FPS), remaining);
    const file = path.join(workDir, `scene${String(index.i).padStart(4, "0")}.mp4`);
    if (scene.kind === "video") await videoScene(scene.path, want / FPS, file, index.i);
    else await imageScene(scene.path, want / FPS, file, index.i);
    madeFrames += want;
    clips.push(file);
    index.i += 1;
  };

  await addCover(lead, "cover-lead");

  const sceneSecondsTotal = body > 0 ? sceneSeconds : 0;
  let cursor = 0;
  const images = scenes.filter((s) => s.kind === "image");
  const videos = scenes.filter((s) => s.kind === "video");
  // Preferujeme to, co uživatel v panelu vidí a nařadil. Když zvolí režim
  // "z obrázků" a nahrá i videa, pustíme se obou - smysl smyčky tím nepřestane.
  const ordered = images.length + videos.length > 1 ? [...images, ...videos] : scenes;
  const pool = ordered.length ? ordered : scenes;

  while (cursor < body - 0.05 && pool.length) {
    for (const scene of pool) {
      if (cursor >= body - 0.05) break;
      const want = Math.min(sceneSecondsTotal, body - cursor);
      if (want <= 0.05) break;
      await addScene({ ...scene, sceneMs: Math.round(want * 1000) });
      cursor += want;
      onProgress(`  scéna ${index.i}: ${(want).toFixed(2)} s (${scene.kind}) · ${(cursor).toFixed(2)}/${body.toFixed(2)}`);
    }
  }

  await addCover(tail, "cover-tail");

  // Poslední scéna musí přesně vyplnit rámce, jinak by smyčka skočila.
  const manifest = path.join(workDir, "concat.txt");
  await writeFile(manifest, `${clips.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join("\n")}\n`, "utf8");

  const staged = path.join(workDir, "silent.mp4");
  await ffmpeg([
    "-threads", THREADS, "-f", "concat", "-safe", "0", "-i", manifest,
    "-c:v", "copy", "-an", "-y", staged,
  ]);

  await ffmpeg([
    "-threads", THREADS, "-i", staged, "-i", audio,
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-shortest", "-movflags", "+faststart", "-y", out,
  ]);

  const finalDuration = await probeDuration(out);
  onProgress(`hotovo: ${finalDuration.toFixed(2)} s z ${(madeFrames / FPS).toFixed(2)} s obrazu, ${clips.length} klipů`);
  if (Math.abs(finalDuration - duration) > 1.0) {
    onProgress(`POZOR: výstup ${finalDuration.toFixed(2)} s, očekáváno ${duration.toFixed(2)} s`);
  }

  // Úklid: na VM je málo místa a pracovní adresář může být na disku runneru.
  for (const file of clips) await rm(file, { force: true });
  await rm(staged, { force: true });
  return { duration: finalDuration, clips: clips.length, frames: madeFrames };
}

export async function readIfExists(file) {
  return readFile(file, "utf8").catch(() => "");
}