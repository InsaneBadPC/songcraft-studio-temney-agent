// Složení videa z více obrázků nebo videí jedné písně, a ze samotného obrázku
// skladby mezi dvěma obály alba.
//
// Na rozdíl od loop-engine nemá jeden zdroj a náhodný plán průchodů - tady je
// přesně to, co uživatel vidí v panelu:
//
//   [obál alba 3 s] -> [scéna 8 s] -> [scéna 8 s] ... -> [obál alba 3 s]
//
// Scény se střídají V RUČNÍM POŘADÍ a opakují se, dokud hraje hudba. Obál alba
// je začátek a konec, ne položka smyčky.
//
// Druhý režim, album_cover_intro, nemá vůbec scény:
//
//   [obál alba 3 s] -> [obrázek skladby, efekt dýchání/parallax/kroky] -> [obál alba 3 s]
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

/**
 * Přesné časy zadáním uživatele - když je chceš změnit, jde se sem.
 *
 * 5. 10. 2026: obál alba 5 s -> 3 s. Kratší úvod nepřebíjí text na obalu,
 * ale video je pořád čitelné jako hudební videoklip.
 */
export const COVER_LEAD_SECONDS = 3;
export const COVER_TAIL_SECONDS = 3;
export const SCENE_SECONDS = 8;

/** Krátké video scény trvají 5-10 s; když uživatel neurčí, losuje se mezi nimi. */
export const VIDEO_SCENE_MIN_SECONDS = 5;
export const VIDEO_SCENE_MAX_SECONDS = 10;

const ENCODE = [
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p",
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

/**
 * Deterministický zdroj náhodnosti ze seeda.
 *
 * Stejný vzor jako v loop-engine: xorshift, seed složený z charCode. Proč ne
 * Math.random: opakovaný render stejné písně musí dát stejné délky scén a
 * stejný efekt, jinak si uživatel stáhne něco jiného, než minule.
 */
export function randomFor(seed, state0 = 0x9e3779b9) {
  let state = state0 >>> 0;
  for (const char of String(seed)) {
    state = (Math.imul(state, 31) + char.charCodeAt(0)) >>> 0;
  }
  return function next() {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x100000000;
  };
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
 * Efekty, které běží na obrázku skladby uprostřed videa.
 *
 * Uživatel si vybral, že obrázek nemá být statický - chtěl nějaký pohyb.
 * Každý efekt je jen jiný ffmpeg filtr, žádný dashboard a žádná GPU, takže
 * se dá vyrenderovat i na VM s 954 MB RAM.
 *
 *   breathe   pomalý zoom tam a zpět + sinusový drift. Nejklidnější varianta.
 *   parallax  přední vrstva letí rychleji než zadní. Vzniká hloubka.
 *   steps     obraz se posouvá po skocích, jako přehrávač.
 *
 * `variant` zajišťuje, že dvě sousední scény nevypadají stejně, a zároveň
 * že píseň s jedním obrázkem není nudná.
 */
export const CENTER_EFFECTS = ["breathe", "parallax", "steps"];

/**
 * Graf pro efekt na obrázku. Vrací filtrační řetězec pro `-filter_complex`.
 *
 * @param {"breathe"|"parallax"|"steps"} effect
 * @param {number} frames počet snímků
 * @param {number} variant 0-3, střídá směr a velikost
 */
function centerEffectGraph(effect, frames, variant) {
  // Velikost a směr se střídají podle varianty, jinak by všechny písně vypadaly
  // stejně a renderer by neměl proč jinak rozhodovat.
  const zoomIn = variant % 2 === 0;
  const magnitude = [1.022, 1.014, 1.030, 1.018][variant % 4];
  const zoom = zoomIn
    ? `1.0+${magnitude - 1}*on/${frames}`
    : `${1 + magnitude - 1}-${magnitude - 1}*on/${frames}`;

  if (effect === "parallax") {
    // Zadní vrstva: FLAT + slabý zoom. Přední vrstva: výraznější pohyb.
    // Dvě kopie téhož obrázku se složí přes sebe a jedna se pohybuje rychleji.
    const depth = [14, 9, 18, 11][variant % 4];
    const back = `[0:v]${FLAT},scale=${W * 2}:${H * 2},zoompan=z='1.0+0.010*on/${frames}'`
      + `:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${FPS}[back]`;
    const front = `[0:v]${FLAT},scale=${W * 2}:${H * 2},zoompan=z='1.0+0.026*on/${frames}'`
      + `:x='iw/2-(iw/zoom/2)+${depth}*sin(2*PI*on/${frames})'`
      + `:y='ih/2-(ih/zoom/2)+${depth * 0.6}*sin(2*PI*on/${frames * 0.7})'`
      + `:s=${W}x${H}:fps=${FPS}[front]`;
    // Přední vrstva lehce zesvětlená, aby se od zadní odlišila i bez pohybu.
    return `${back};${front};[back][front]blend=all_mode=screen:all_opacity=0.88,setsar=1[v]`;
  }

  if (effect === "steps") {
    // Posun po skocích: 8 kroků, každý drží 1/8 doby. offset=out před každým
    // krokem znamená skok místo plynulého pohybu.
    const steps = 8;
    const drift = [46, 34, 58, 40][variant % 4];
    const dirX = zoomIn ? "1" : "-1";
    const dirY = variant < 2 ? "1" : "-1";
    return `[0:v]${FLAT},scale=${W * 2}:${H * 2},zoompan=z='${zoom}'`
      + `:x='iw/2-(iw/zoom/2)+${dirX}*${drift}*floor(on/${frames}/${steps})'`
      + `:y='ih/2-(ih/zoom/2)+${dirY}*${drift}*0.6*floor(on/${frames}/${steps})'`
      + `:s=${W}x${H}:fps=${FPS},setsar=1[v]`;
  }

  // breathe - výchozí varianta.
  const driftX = zoomIn ? `+16*sin(2*PI*on/${frames})` : `-16*sin(2*PI*on/${frames})`;
  const driftY = variant < 2 ? `+11*sin(2*PI*on/${frames * 0.6})` : `-11*sin(2*PI*on/${frames * 0.6})`;
  return `[0:v]${FLAT},zoompan=z='${zoom}'`
    + `:x='iw/2-(iw/zoom/2)+${driftX}':y='ih/2-(ih/zoom/2)+${driftY}'`
    + `:s=${W}x${H}:fps=${FPS},setsar=1[v]`;
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

/**
 * Obrázek skladby jako celý prostředek videa s vybraným efektem.
 *
 * Toto je `album_cover_intro`: [obál alba 3 s] -> [obrázek skladby s efektem]
 * -> [obál alba 3 s]. Obál je kratší než obrázek, proto se do něj vejde celý.
 */
async function songCoverCenter(source, seconds, out, effect, variant) {
  const frames = Math.max(1, Math.round(seconds * FPS));
  const graph = centerEffectGraph(effect, frames, variant);
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
 * Složení videa z doprovodných médií.
 *
 * @param {{audio: string, cover: string, scenes: {kind: "image"|"video", path: string, sceneMs?: number}[],
 *          out: string, workDir: string, onProgress?: (l: string) => void,
 *          coverLeadSeconds?: number, coverTailSeconds?: number, sceneSeconds?: number,
 *          seed?: string}} options
 *   `cover` je OBAŁ ALBA (začátek a konec). `scenes` jsou doprovodná média
 *   V POŘADÍ, JAKÉ JE UŽIVATEL NAŘADIL V PANELU.
 */
export async function buildGalleryVideo(options) {
  const {
    audio, cover, scenes, out, workDir, onProgress = () => {},
    coverLeadSeconds = COVER_LEAD_SECONDS,
    coverTailSeconds = COVER_TAIL_SECONDS,
    sceneSeconds = SCENE_SECONDS,
    seed = "songcraft",
  } = options;

  if (!audio) throw new Error("gallery engine potřebuje audio pro určení délky videa");
  if (!cover) throw new Error("gallery engine potřebuje obál alba");
  if (!scenes || !scenes.length) throw new Error("gallery engine potřebuje alespoň jednu scénu");

  await mkdir(workDir, { recursive: true });
  const duration = await probeDuration(audio);
  const lead = Math.min(coverLeadSeconds, duration / 3);
  const tail = Math.min(coverTailSeconds, Math.max(0, duration - lead));
  const body = Math.max(0, duration - lead - tail);
  onProgress(`skladba ${duration.toFixed(2)} s · obál alba ${lead}s + scény ${body.toFixed(2)}s + obál alba ${tail}s`);

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
    onProgress(`  obál alba ${tag}: ${(want / FPS).toFixed(2)} s`);
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

  // KRÁTKÉ VIDEOSCÉNY 5-10 s. Když uživatel neurčí own délku (scene_ms = 0),
  // losujeme mezi 5 a 10 podle seedu písně - různé písně mají jiné délky
  // scén, ale stejná píseň se vyrenderuje stejně.
  const random = randomFor(seed);
  const videoSceneSeconds = () =>
    VIDEO_SCENE_MIN_SECONDS
    + Math.round(random() * (VIDEO_SCENE_MAX_SECONDS - VIDEO_SCENE_MIN_SECONDS));

  // Řád podle výběru režimu:
  //   gallery_images  jen obrázky
  //   gallery_videos  jen videa
  //   gallery_mixed   VŠE V POŘADÍ Z DATABÁZE
  //
  // Dřívější kód tu byl `[...images, ...videos]`, což házelo uživatelovo
  // pořadí pryč - obrázky se vždy posunuly před videa. U kombinovaného videa
  // je pořadí, které uživatel nastavil prstem, jediné správné pořadí.
  const wanted = (options.mediaFilter || "mixed").toString();
  let pool = scenes;
  if (wanted === "image") pool = scenes.filter((s) => s.kind === "image");
  else if (wanted === "video") pool = scenes.filter((s) => s.kind === "video");
  // "mixed" nechává scenes tak, jak přišly z databáze.

  if (!pool.length) {
    throw new Error(
      wanted === "image"
        ? "K této skladbě nejsou nahrány žádné doprovodné obrázky."
        : wanted === "video"
          ? "K této skladbě nejsou nahrána žádná doprovodná videa."
          : "K této skladbě nejsou nahrána žádná doprovodná média.",
    );
  }

  while (cursor < body - 0.05 && pool.length) {
    for (const scene of pool) {
      if (cursor >= body - 0.05) break;
      const planned = scene.kind === "video"
        ? (scene.sceneMs && scene.sceneMs > 0 ? scene.sceneMs / 1000 : videoSceneSeconds())
        : sceneSecondsTotal;
      const want = Math.min(planned, body - cursor);
      if (want <= 0.05) break;
      await addScene({ ...scene, sceneMs: Math.round(want * 1000) });
      cursor += want;
      onProgress(`  scéna ${index.i}: ${(want).toFixed(2)} s (${scene.kind}) · ${(cursor).toFixed(2)}/${body.toFixed(2)}`);
    }
  }

  await addCover(tail, "cover-tail");

  // Poslední scéna musí přesně vyplnit rámce, jinak by smyčka skočila.
  //
  // Cesty v manifestu MUSÍ být absolutní. Concat demuxer řeší relativní cesty
  // vzhledem k adresáři, kde je concat.txt, ne ke cwd - a ten je workDir. U
  // relativní cesty tak hledá `workDir/workDir/scena0000.mp4`. Tuhle chybu
  // nebylo vidět dřív, protože větev source_gallery nikdy nesplnila svůj
  // `if (!artwork)` a engine se nezavolal.
  const manifest = path.join(workDir, "concat.txt");
  await writeFile(manifest, `${clips.map((file) => `file '${path.resolve(file).replace(/'/g, "'\\''")}'`).join("\n")}\n`, "utf8");

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

/**
 * Efekt na obrázku skladby, když ho uživatel nevybral.
 *
 * Volba musí být z `CENTER_EFFECTS`. Renderer neháde - kdyby poslal něco
 * jiného, raději použije breathe a pokračuje, než aby skončil chybou.
 */
export function normalizeCenterEffect(value) {
  return CENTER_EFFECTS.includes(value) ? value : "breathe";
}

/**
 * Složení videa, kde je uprostřed obrázek skladby s efektem.
 *
 *   [obál alba 3 s] -> [obrázek skladby, dýchání/parallax/kroky] -> [obál alba 3 s]
 *
 * `cover` je obál ALBA. `songCover` je obrázek SKLADBY - to jsou dvě různé
 * věci, proto dvě cesty. Pokud album obal nemá, caller pošle do `cover`
 * obál skladby, aby to nikdy neselhalo.
 *
 * @param {{audio: string, cover: string, songCover: string, out: string, workDir: string,
 *          effect?: "breathe"|"parallax"|"steps", seed?: string,
 *          coverLeadSeconds?: number, coverTailSeconds?: number, onProgress?: (l: string) => void}} options
 */
export async function buildSongCoverVideo(options) {
  const {
    audio, cover, songCover, out, workDir, onProgress = () => {},
    effect = "breathe", seed = "songcraft",
    coverLeadSeconds = COVER_LEAD_SECONDS,
    coverTailSeconds = COVER_TAIL_SECONDS,
  } = options;

  if (!audio) throw new Error("song cover engine potřebuje audio pro určení délky videa");
  if (!cover) throw new Error("song cover engine potřebuje obál alba");
  if (!songCover) throw new Error("song cover engine potřebuje obrázek skladby");
  // Neznámý efekt není důvod shodit celý render - běžeme na breathe.
  const chosen = normalizeCenterEffect(effect);

  await mkdir(workDir, { recursive: true });
  const duration = await probeDuration(audio);
  const lead = Math.min(coverLeadSeconds, duration / 3);
  const tail = Math.min(coverTailSeconds, Math.max(0, duration - lead));
  const body = Math.max(0, duration - lead - tail);
  const label = CENTER_EFFECTS.join(" / ");
  onProgress(`skladba ${duration.toFixed(2)} s · obál alba ${lead}s + obrázek skladby (${chosen}) ${body.toFixed(2)}s + obál alba ${tail}s`);

  const clips = [];
  const totalFrames = Math.max(1, Math.round(duration * FPS));
  let madeFrames = 0;

  const addCover = async (seconds, tag) => {
    const remaining = totalFrames - madeFrames;
    if (remaining <= 0) return;
    const want = Math.min(Math.round(seconds * FPS), remaining);
    const file = path.join(workDir, `${tag}.mp4`);
    await coverClip(cover, want / FPS, file, tag);
    madeFrames += want;
    clips.push(file);
    onProgress(`  obál alba ${tag}: ${(want / FPS).toFixed(2)} s`);
  };

  // Efekt se volí ze seedu písně, aby dvě písně nevypadaly stejně, ale stejná
  // píseň se vyrenderovala pokaždé stejně.
  const random = randomFor(`${seed}:effect`);
  const variant = Math.floor(random() * 4);

  await addCover(lead, "cover-lead");

  if (body > 0.05) {
    const want = Math.min(Math.round(body * FPS), totalFrames - madeFrames);
    const file = path.join(workDir, "song-cover-center.mp4");
    await songCoverCenter(songCover, want / FPS, file, chosen, variant);
    madeFrames += want;
    clips.push(file);
    onProgress(`  obrázek skladby: ${(want / FPS).toFixed(2)} s (${chosen}, varianta ${variant} z [${label}])`);
  }

  await addCover(tail, "cover-tail");

  // Absolutní cesty - viz poznámka u buildGalleryVideo.
  const manifest = path.join(workDir, "concat.txt");
  await writeFile(manifest, `${clips.map((file) => `file '${path.resolve(file).replace(/'/g, "'\\''")}'`).join("\n")}\n`, "utf8");

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

  for (const file of clips) await rm(file, { force: true });
  await rm(staged, { force: true });
  return { duration: finalDuration, clips: clips.length, frames: madeFrames, effect: chosen, variant };
}

// ---------------------------------------------------------------------------
// YouTube Shorts (9:16)
//
// Krátké vejší video: obál alba 3 s -> <celý obrázek skladby> -> obál alba 3 s.
// Obrázek skladby i obál alba se do rámu vejdou celé - necropam je, jen je
// zmenšíme a vystředíme, a volné místo zaplníme pozadím, které uživatel dodal.

const S_W = 1080;
const S_H = 1920;

const S_ENCODE = [
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "29", "-pix_fmt", "yuv420p",
  "-r", String(FPS), "-g", String(FPS * 2), "-keyint_min", String(FPS),
  "-sc_threshold", "0", "-an",
];

/** Obrázek zaplní 1080x1920 pozadí (crop, bez černých pruhů). */
/**
 * Obrázek (album nebo skladba) se celý vejde do 1080x1920: zmenšíme ho,
 * vystředíme a po stranách (nahoře/dole) ho obložíme zvětšeným pozadím.
 * Tím je obál vždy celý viditelný a okolí není černé.
 *
 * Důležité: `-loop 1` u vstupu znamená, že se PNG rozloží a rozbalí ZNOVU
 * pro každý snímek. Na 1080x1920 a 24 fps to na dvoujádrové VM trvalo
 * 0,72 s na snímek, tedy 7 minut na 24 s videa. `loop` filtr (size=1) si
 * snímek v paměti podrží a opakuje ho, takže se obrázek rozbalí jen jednou:
 * 0,24 s na snímek, 3x rychleji. Výstup je bitově stejný (PSNR inf).
 */
async function shortContentClip(src, bg, seconds, out) {
  const frames = Math.max(1, Math.round(seconds * FPS));
  // Pozadí zabere celý 1080x1920, hlavní obsah (obál alba nebo obrázek skladby)
  // se celý vejde do středu a vystředí se.
  const still = `loop=loop=-1:size=1:start=0,setpts=N/(${FPS}*TB)`;
  const graph =
    `[0:v]scale=${S_W}:${S_H}:force_original_aspect_ratio=increase,`
    + `crop=${S_W}:${S_H},setsar=1,format=yuv420p,${still}[bg];`
    + `[1:v]scale=${S_W}:${S_H}:force_original_aspect_ratio=decrease,`
    + `format=yuv420p,${still}[f];`
    + `[bg][f]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]`;
  await ffmpeg([
    "-threads", THREADS, "-i", bg, "-i", src,
    "-filter_complex", graph, "-map", "[v]",
    "-frames:v", String(frames), ...S_ENCODE, "-y", out,
  ]);
  return frames;
}

/**
 * Vyrobí vertikální Shorts z obrázku skladby a obalu alba.
 *
 *   [obál alba 3 s] -> [obrázek skladby, bez efektu] -> [obál alba 3 s]
 *
 * V pozadí za obrázky je vyplněný obrázek, který dodejme sami (nebo rozmazaný
 * obál, když vydaný obrázek chybí). аудио se přikládá až v závěru.
 */
export async function buildShortVideo(options) {
  const {
    audio, cover, songCover, out, workDir, onProgress = () => {},
    background = null, // obrázek, který zaplní volná místa
    coverLeadSeconds = COVER_LEAD_SECONDS,
    coverTailSeconds = COVER_TAIL_SECONDS,
  } = options;

  if (!audio) throw new Error("Shorts vyžadují audio");
  if (!cover) throw new Error("Shorts vyžadují obál alba");
  if (!songCover) throw new Error("Shorts vyžadují obrázek skladby");

  await mkdir(workDir, { recursive: true });
  const duration = await probeDuration(audio);
  const lead = Math.min(coverLeadSeconds, duration / 3);
  const tail = Math.min(coverTailSeconds, Math.max(0, duration - lead));
  const body = Math.max(0, duration - lead - tail);
  onProgress(`shorts ${duration.toFixed(2)} s · obál ${lead}s + obrázek skladby ${body.toFixed(2)}s + obál ${tail}s`);

  const clips = [];
  const totalFrames = Math.max(1, Math.round(duration * FPS));
  let madeFrames = 0;

  const bgSource = background || cover;
  const addCover = async (seconds, tag) => {
    const remaining = totalFrames - madeFrames;
    if (remaining <= 0) return;
    const want = Math.min(Math.round(seconds * FPS), remaining);
    const file = path.join(workDir, `${tag}.mp4`);
    await shortContentClip(cover, bgSource, want / FPS, file);
    madeFrames += want;
    clips.push(file);
    onProgress(`  obál alba ${tag}: ${(want / FPS).toFixed(2)} s`);
  };

  await addCover(lead, "cover-lead");

  if (body > 0.05) {
    const want = Math.min(Math.round(body * FPS), totalFrames - madeFrames);
    const file = path.join(workDir, "song-center.mp4");
    await shortContentClip(songCover, bgSource, want / FPS, file);
    madeFrames += want;
    clips.push(file);
    onProgress(`  obrázek skladby: ${(want / FPS).toFixed(2)} s`);
  }

  await addCover(tail, "cover-tail");

  const manifest = path.join(workDir, "concat.txt");
  await writeFile(manifest, `${clips.map((f) => `file '${path.resolve(f).replace(/'/g, "'\\''")}'`).join("\n")}\n`, "utf8");

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
  onProgress(`hotovo: ${finalDuration.toFixed(2)} s · ${clips.length} klipů`);
  if (Math.abs(finalDuration - duration) > 1.0) {
    onProgress(`POZOR: výstup ${finalDuration.toFixed(2)} s, očekáváno ${duration.toFixed(2)} s`);
  }
  for (const f of clips) await rm(f, { force: true });
  await rm(staged, { force: true });
  return { duration: finalDuration, clips: clips.length };
}

/**
 * Najde start sekund, od kterého je nejenergičtější 30sekundové okno.
 * Vrátí start v sekundách z začátku audio. Jednoduché, bez ML: okno s
 * nejvyšším průměrem energie.
 */
export async function pickBest30s(audioFile) {
  // temp jde vedle vstupu - na Androidu/VM je to jediná psací cesta.
  const dir = path.dirname(audioFile);
  const tmp = path.join(dir, `sas_${Date.now()}.wav`);
  try {
    await ffmpeg(["-i", audioFile, "-ac", "1", "-ar", "8000", tmp]);
    const { readFile: rf, rm: rmf } = await import("node:fs/promises");
    const data = await rf(tmp);
    await rmf(tmp, { force: true });
    const samples = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.byteLength / 2));
    const sr = 8000;
    const win = 30 * sr;
    if (samples.length < win) return 0;
    let best = 0, bestEnergy = -1;
    for (let start = 0; start + win <= samples.length; start += sr) {
      let e = 0;
      for (let i = 0; i < win; i += 8) {
        const v = samples[start + i];
        e += v * v;
      }
      if (e > bestEnergy) { bestEnergy = e; best = start; }
    }
    return best / sr;
  } catch {
    return 0;
  }
}