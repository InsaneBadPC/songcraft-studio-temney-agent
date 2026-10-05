/**
 * Katalog režimů videa pro tab Videa.
 *
 * JEDNO MÍSTO, KDE ŽIJÍ REŽIMY. Dříve byl seznam režimů rozkopán na čtyřech
 * místech (export/youtube.tsx, songcraft-youtube/index.ts, agent-orchestrator,
 * worker.mjs) a to je přesně jak se stalo, že UI nabídlo `source_gallery`,
 * který databáze zakázala a renderer neuměl. Tady je definice jednou, a UI
 * i server si ji jen čtou.
 *
 * Každý režim má:
 *   - `type` a `mode`  = stejná hodnota, protože to jsou synonyma v agent_videos
 *   - `backend`        = kdo to vyrábí
 *   - `media`          = odkud renderer vezme scény (null = jen obal)
 *
 * Změna režimu znamená: nový řádek tady + nová migrace, která hodnotu povolí.
 * Test `tests/video-tab.test.ts` hlídá, aby se nikdy nerozutekly.
 */

/** Kde renderer vezme scény pro video. */
export type VideoMediaSource =
  /** Jen obrázek skladby: `sc_songs.cover_path`. Nic dalšího. */
  | "song_cover"
  /** Doprovodné obrázky: `sc_song_media` kde `kind = 'image'`. */
  | "song_media_images"
  /** Doprovodná videa: `sc_song_media` kde `kind = 'video'`. */
  | "song_media_videos"
  /** Obojí dohromady, POOŘADÍ JAKO V DATABÁZI. */
  | "song_media_mixed";

export interface VideoModeDefinition {
  /** Jedinečný klíč pro UI. */
  readonly id: string;
  /** Hodnota do agent_videos.type i .mode. */
  readonly type: string;
  /** Hodnota do agent_videos.backend. */
  readonly backend: string;
  /** Odkud renderer vezme scény. */
  readonly media: VideoMediaSource;
  /** Název na kartě v tabu Videa. */
  readonly label: string;
  /** Krátký popis na kartě. */
  readonly detail: string;
  /** Ikona MaterialIcons. */
  readonly icon: string;
  /**
   * Efekt v prostředku videa. `null` znamená, že uživatel vybírá sám.
   */
  readonly centerEffect: VideoCenterEffect | null;
  /** Zda režim vůbec potřebuje doprovodná média (jinak stačí obal). */
  readonly needsMedia: boolean;
}

/**
 * Efekt, který běží na obrázku skladby uprostřed videa.
 *
 * Uživatel si zvolil, že obrázek skladby nemá být statický. Každý efekt je
 * jen jiný ffmpeg filtr, žádný dashboard, žádná GPU. Renderer si vybere podle
 * `seed` a písni se to nebude opakovat.
 */
export type VideoCenterEffect =
  /** Dýchání: pomalý zoom tam a zpět + mírný sinusový drift. */
  | "breathe"
  /** Parallax: rozdílná rychlost pro přední a zadní vrstvu + posuv. */
  | "parallax"
  /** Kroky: obraz se posouvá v řadě kroků, jako přehrávač. */
  | "steps";

/** Efekty v pořadí, v jakém je UI nabízí. */
export const CENTER_EFFECTS: readonly { id: VideoCenterEffect; label: string; detail: string }[] = [
  {
    id: "breathe",
    label: "Dýchání",
    detail: "Pomalý zoom tam a zpět s mírným posuvem do stran",
  },
  {
    id: "parallax",
    label: "Parallax",
    detail: "Přední vrstva letí rychleji než zadní, vzniká hloubka",
  },
  {
    id: "steps",
    label: "Kroky",
    detail: "Obraz se posouvá po skocích, jako přehrávač písni",
  },
] as const;

/**
 * Režim, kdy je uprostřed obrázek skladby a kolem obál alba.
 *
 * `centerEffect` je tu schválně `null`: uživatel vybírá efekt sám. U ostatních
 * režimů je efekt vždy `breathe`, protože tam je obrázek jen jedna scéna mezi
 * desítkami dalších a volba by nebyla smysluplná.
 */
export type VideoModeId =
  | "album_cover_intro"
  | "gallery_images"
  | "gallery_videos"
  | "gallery_mixed";

/**
 * Efekt pro režimy, kde uživatel nevolí. Gallery scény dýchají, protože je
 * obrazků víc a jednotlivý efekt by nebyl čitelný.
 */
const GALLERY_EFFECT: VideoCenterEffect = "breathe";

/**
 * Všechny režimy tabu Videa. Pořadí je pořadí na kartách.
 *
 * `album_cover_intro`  obál alba 3 s -> obrázek skladby -> obál alba 3 s
 * `gallery_images`     obál alba 3 s -> doprovodné obrázky po 8 s -> obál alba 3 s
 * `gallery_videos`     obál alba 3 s -> krátké scény 5-10 s -> obál alba 3 s
 * `gallery_mixed`      obál alba 3 s -> obrázky i scény v tvém pořadí -> obál alba 3 s
 */
export const VIDEO_MODES: readonly VideoModeDefinition[] = [
  {
    id: "album_cover_intro",
    type: "album_cover_intro",
    backend: "ffmpeg",
    media: "song_cover",
    label: "Video z obrázku skladby",
    detail: "Obál alba 3 s, obrázek skladby, obál alba 3 s",
    icon: "music-note",
    centerEffect: null,
    needsMedia: false,
  },
  {
    id: "gallery_images",
    type: "gallery_images",
    backend: "vm_gallery",
    media: "song_media_images",
    label: "Z více obrázků",
    detail: "Obál alba 3 s, obrázky po 8 s, obál alba 3 s",
    icon: "photo-library",
    centerEffect: GALLERY_EFFECT,
    needsMedia: true,
  },
  {
    id: "gallery_videos",
    type: "gallery_videos",
    backend: "vm_gallery",
    media: "song_media_videos",
    label: "Smyčka z videí",
    detail: "Obál alba 3 s, krátké scény 5–10 s, obál alba 3 s",
    icon: "videocam",
    centerEffect: GALLERY_EFFECT,
    needsMedia: true,
  },
  {
    id: "gallery_mixed",
    type: "gallery_mixed",
    backend: "vm_gallery",
    media: "song_media_mixed",
    label: "Kombinované",
    detail: "Obál alba 3 s, obrázky i scény v tvém pořadí",
    icon: "dynamic-feed",
    centerEffect: GALLERY_EFFECT,
    needsMedia: true,
  },
] as const;

/** Všechny hodnoty `type`, které tab Videa smí poslat do databáze. */
export const VIDEO_MODE_TYPES = VIDEO_MODES.map((mode) => mode.type);

/** Všechny hodnoty `backend`, které tab Videa smí poslat do databáze. */
export const VIDEO_MODE_BACKENDS = [...new Set(VIDEO_MODES.map((mode) => mode.backend))];

/** Režimy, které renderer skládá z doprovodných médií. */
export const GALLERY_MODE_TYPES = VIDEO_MODES.filter((mode) => mode.backend === "vm_gallery").map(
  (mode) => mode.type,
);

export function findVideoMode(type: unknown): VideoModeDefinition | null {
  if (typeof type !== "string") return null;
  return VIDEO_MODES.find((mode) => mode.type === type) ?? null;
}

/** Je tohle hodnota, kterou smí poslat tab Videa? */
export function isVideoModeType(type: unknown): type is string {
  return typeof type === "string" && VIDEO_MODE_TYPES.includes(type);
}

/** Důvod, proč režim na píseň nejde použít - s českou hláškou pro UI. */
export type VideoModeBlocker = "no-final-audio" | "no-song-cover" | "no-media";

/**
 * Je píseň použitelná pro tenhle režim?
 *
 * Čistá funkce, žádný dotaz - volá se při kreslení každého řádku seznamu.
 * Důvod vracíme, ne boolean, aby UI nemuselo slovník překládat: uživatel vidí
 * "0 doprovodných videí", ne "no_media".
 */
export function checkVideoModeReadiness(input: {
  mode: string;
  hasFinalAudio: boolean;
  hasSongCover: boolean;
  imageCount: number;
  videoCount: number;
}): { ready: true } | { ready: false; blocker: VideoModeBlocker; label: string } {
  if (!input.hasFinalAudio) {
    return { ready: false, blocker: "no-final-audio", label: "chybí finální MP3" };
  }
  if (!input.hasSongCover) {
    return { ready: false, blocker: "no-song-cover", label: "chybí obrázek skladby" };
  }

  if (input.mode === "album_cover_intro") {
    // Obál albumu není překážka: renderer sklouzne na obál skladby.
    return { ready: true };
  }

  if (input.mode === "gallery_images" && input.imageCount === 0) {
    return { ready: false, blocker: "no-media", label: "0 doprovodných obrázků" };
  }
  if (input.mode === "gallery_videos" && input.videoCount === 0) {
    return { ready: false, blocker: "no-media", label: "0 doprovodných videí" };
  }
  if (input.mode === "gallery_mixed" && input.imageCount + input.videoCount === 0) {
    return { ready: false, blocker: "no-media", label: "0 doprovodných médií" };
  }

  return { ready: true };
}
