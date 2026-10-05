import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  CENTER_EFFECTS,
  findVideoMode,
  GALLERY_MODE_TYPES,
  isVideoModeType,
  VIDEO_MODE_BACKENDS,
  VIDEO_MODE_TYPES,
  VIDEO_MODES,
checkVideoModeReadiness,
} from "../lib/video-modes";

const migration = readFileSync(
  "supabase/migrations/20261005000000_video_tab_modes.sql",
  "utf8",
);
const worker = readFileSync("workers/video-renderer/worker.mjs", "utf8");
const gallery = readFileSync("workers/video-renderer/gallery-engine.mjs", "utf8");
const edge = readFileSync("supabase/functions/songcraft-youtube/index.ts", "utf8");
const layout = readFileSync("app/(tabs)/_layout.tsx", "utf8");

/**
 * Komentáře v kódu popisují, co bylo rozbité a proč - a obsahují tedy i
 * zakázané řetězce (`if (!artwork)`, `[...images, ...videos]`,
 * `vm_source_loop`). Testy níže kontrolují KÓD, ne komentáře, takže je
 * nejdřív odstraníme. Bez toho by každý test selhal kvůli vysvětlení, které
 * je přesně to, co chceme v repu mít.
 */
function withoutComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

const workerCode = withoutComments(worker);
const galleryCode = withoutComments(gallery);
const edgeCode = withoutComments(edge);
const layoutCode = withoutComments(layout);
const migrationCode = withoutComments(migration);

/**
 * Testy tabu Videa.
 *
 * Důvod, proč čteme zdrojáky jako text místo runtime assertions: chyby, které
 * tato appka opravovala, byly většinou v synkronicity mezi soubory - tab nabídl
 * režim, který migrace zakázala, worker neuměl větev, kterou UI posílalo.
 * Tento styl to hlídá levněji než spouštění renderu na Oracle VM.
 */
describe("tab Videa: katalog režimů", () => {
  it("nabízí přesně čtyři režimy ve dvou úrovních", () => {
    expect(VIDEO_MODES).toHaveLength(4);
    expect(VIDEO_MODE_TYPES).toEqual([
      "album_cover_intro",
      "gallery_images",
      "gallery_videos",
      "gallery_mixed",
    ]);
    // Jediný režim, kde uživatel vybírá efekt, je ten s obrázkem skladby.
    const withUserEffect = VIDEO_MODES.filter((mode) => mode.centerEffect === null);
    expect(withUserEffect.map((mode) => mode.id)).toEqual(["album_cover_intro"]);
  });

  it("všechny tři galerie jdou přes jeden backend vm_gallery", () => {
    expect(VIDEO_MODE_BACKENDS).toEqual(["ffmpeg", "vm_gallery"]);
    expect(GALLERY_MODE_TYPES).toEqual(["gallery_images", "gallery_videos", "gallery_mixed"]);
    // gallery_mixed MUSÍ jít přes vm_gallery. Kdyby spadl na vm_full_scenes,
    // renderer by se pokusil volat dashboard, který na VM není.
    expect(findVideoMode("gallery_mixed")?.backend).toBe("vm_gallery");
  });

  it("findVideoMode a isVideoModeType neseznávají neznámé hodnoty", () => {
    expect(findVideoMode("album_cover_intro")?.label).toBeTruthy();
    // source_gallery nesmí projít: v DB není povolený a každý pokus skončil 502.
    expect(findVideoMode("source_gallery")).toBeNull();
    expect(isVideoModeType("source_gallery")).toBe(false);
    expect(isVideoModeType("gallery_images")).toBe(true);
    expect(isVideoModeType(undefined)).toBe(false);
  });

  it("efekty na obrázek skladby jsou tři a odpovídají DB CHECKu", () => {
    expect(CENTER_EFFECTS.map((effect) => effect.id)).toEqual(["breathe", "parallax", "steps"]);
    for (const effect of CENTER_EFFECTS) {
      expect(migrationCode).toContain(`'${effect.id}'`);
      expect(worker).toContain(`"${effect.id}"`);
    }
  });
});

describe("tab Videa: migrace", () => {
  it("povoluje všechny čtyři režimy v type i mode", () => {
    for (const type of VIDEO_MODE_TYPES) {
      expect(migrationCode).toContain(`'${type}'`);
    }
    // type i mode musí mít STEJNÝ seznam, jinak se job vloží s mode, který
    // CHECK v .type nepovolí.
    const typeBlock = migrationCode.slice(
      migrationCode.indexOf("add constraint agent_videos_type_check"),
      migrationCode.indexOf("add constraint agent_videos_mode_check"),
    );
    const modeBlock = migrationCode.slice(
      migrationCode.indexOf("add constraint agent_videos_mode_check"),
      migrationCode.indexOf("add constraint agent_videos_backend_check"),
    );
    for (const type of VIDEO_MODE_TYPES) {
      expect(typeBlock).toContain(`'${type}'`);
      expect(modeBlock).toContain(`'${type}'`);
    }
  });

  it("povoluje backend vm_gallery a NESMÍ vracet vm_source_loop", () => {
    expect(migrationCode).toContain("'vm_gallery'");
    // vm_source_loop nikdy nebyl v žádném CHECKu - proto každá galerie skončila 502.
    expect(migrationCode).not.toMatch(/check\s*\([^)]*vm_source_loop/);
    expect(migrationCode).toContain("set backend = 'vm_gallery'");
    expect(migrationCode).toContain("where backend = 'vm_source_loop'");
  });

  it("přemapuje source_gallery na gallery_mixed a končí fail-closed", () => {
    expect(migrationCode).toContain("'source_gallery'");
    expect(migrationCode).toContain("set mode = 'gallery_mixed', type = 'gallery_mixed'");
    expect(migrationCode).toContain("raise exception");
    // Fail-closed musí být POSLEDNÍ krok, jinak se kontrola spustí dřív než
    // se přemapuje.
    expect(migrationCode.lastIndexOf("raise exception")).toBeGreaterThan(
      migrationCode.lastIndexOf("set backend = 'vm_gallery'"),
    );
  });

  it("nese nové sloupce cover_lead_path a center_effect s vlastnickou kontrolou", () => {
    expect(migrationCode).toContain("add column if not exists cover_lead_path text");
    expect(migrationCode).toContain("add column if not exists center_effect text");
    // Cesta musí jít stejným helperem jako ostatní cesty, jinak by šlo
    // uložit cestu cizího uživatele.
    expect(migrationCode).toContain("songcraft_add_path_constraint");
    expect(migrationCode).toContain("agent_videos_cover_lead_path_user_prefix");
  });
});

describe("tab Videa: worker", () => {
  it("načítá všechny sloupce, které režimy potřebují", () => {
    // Dřív tu chyběly gallery_kind i source_video_path, takže job.galleryKind
    // bylo undefined a renderer si vždy bral všechno.
    for (const column of ["gallery_kind", "cover_lead_path", "center_effect", "source_video_path"]) {
      expect(workerCode).toContain(column);
    }
  });

  it("má větev pro každý režim tabu Videa", () => {
    expect(workerCode).toContain('SONG_COVER_MODE = "album_cover_intro"');
    for (const type of GALLERY_MODE_TYPES) {
      expect(workerCode).toContain(`${type}:`);
    }
    expect(workerCode).toContain("buildSongCoverVideo");
    expect(workerCode).toContain("buildGalleryVideo");
  });

  it("u obrazku skladby nahradí mrtvý `if (!artwork)`", () => {
    // Původní větev byla `if (!artwork) { ...buildGalleryVideo... }`, ale
    // artwork se stahuje pro každý typ kromě source_loop, takže `if` nikdy
    // nenastal a buildGalleryVideo se nikdy nezavolal.
    const galleryBranch = workerCode.slice(
      workerCode.indexOf("GALLERY_MODES[type]"),
      workerCode.indexOf('type === "source_loop"'),
    );
    expect(galleryBranch).toContain("buildGalleryVideo");
    expect(withoutComments(galleryBranch)).not.toContain("if (!artwork)");
  });

  it("nesmí házet pořadí doprovodných médií", () => {
    // Dřív engine dělal [...images, ...videos], čímž zahodil pořadí, které
    // uživatel nastavil tážením v panelu.
    expect(galleryCode).not.toContain("[...images, ...videos]");
    expect(galleryCode).toContain('wanted === "image"');
    expect(galleryCode).toContain('wanted === "video"');
    expect(galleryCode).toContain("mixed");
  });

  it("zná všechny tři efekty a neuhne neznámý", () => {
    expect(workerCode).toContain('const CENTER_EFFECTS = ["breathe", "parallax", "steps"]');
    expect(galleryCode).toContain("normalizeCenterEffect");
    // Renderer musí neznámý efekt převést na breathe, ne shodit render.
    expect(galleryCode).toContain('return CENTER_EFFECTS.includes(value) ? value : "breathe"');
  });

  it("bere obál alba z cover_lead_path a obrázek skladby zvlášť", () => {
    expect(workerCode).toContain("job.cover_lead_path");
    expect(workerCode).toContain("songCoverStoragePath");
    // albumCoverLead nesmí být pad na prázdnou hodnotu a spadnout zpět na null.
    expect(workerCode).toContain("jobCoverLead || songCoverStoragePath || albumCoverStoragePath");
  });
});

describe("tab Videa: gallery engine", () => {
  it("má obál 3 s a scénu 8 s", () => {
    expect(galleryCode).toContain("export const COVER_LEAD_SECONDS = 3");
    expect(galleryCode).toContain("export const COVER_TAIL_SECONDS = 3");
    expect(galleryCode).toContain("export const SCENE_SECONDS = 8");
  });

  it("krátké video scény jsou 5-10 s", () => {
    expect(galleryCode).toContain("export const VIDEO_SCENE_MIN_SECONDS = 5");
    expect(galleryCode).toContain("export const VIDEO_SCENE_MAX_SECONDS = 10");
  });

  it("efekt a délka scény jsou deterministické ze seedu", () => {
    // Opakovaný render stejné písně musí dát stejný výsledek, jinak si
    // uživatel stáhne něco jiného, než minule.
    expect(galleryCode).toContain("export function randomFor");
    expect(galleryCode).toContain("const variant = Math.floor(random() * 4)");
    expect(workerCode).toContain("seed: String(job.id)");
  });

  it("graf každého efektu existuje a je použitelný ve filter_complex", () => {
    expect(galleryCode).toContain("function centerEffectGraph");
    expect(galleryCode).toContain("zoompan");
    // parallax je jediný, který skládá dvě vrstvy.
    expect(galleryCode).toContain("blend=all_mode=screen");
    // steps musí skákat po skocích, ne plavat plynule.
    expect(galleryCode).toContain("floor(on/");
  });

  it("manifest pro concat demuxer používá absolutní cesty", () => {
    // Concat demuxer řeší relativní cesty vzhledem k adresáři concat.txt,
    // ne ke cwd. Relativní cesta tak hledá workDir/workDir/scena0000.mp4 a
    // render spadne. Chybu nebylo vidět dřív, protože engine nikdy nebyl
    // zavolán - viz test mrtvého `if (!artwork)`.
    expect(galleryCode).not.toMatch(/`file '\$\{file\.replace/);
    expect(galleryCode).toMatch(/path\.resolve\(file\)/);
    // Oba buildy to musí dělat - jinak by album_cover_intro spadl.
    expect(galleryCode.match(/path\.resolve\(file\)/g)).toHaveLength(2);
  });
});

describe("tab Videa: edge funkce", () => {
  it("mapuje režimy na backendy z katalogu, ne ternárním řetězcem", () => {
    expect(edgeCode).toContain("vm_gallery");
    // Starý řetězec mapoval source_gallery na vm_source_loop, což DB
    // nepovolovalo, takže každý pokus skončil 502.
    expect(edgeCode).not.toContain("vm_source_loop");
  });

  it("říká uživateli hned, když píseň nemá doprovodná média", () => {
    expect(edgeCode).toContain("sc_song_media");
    expect(edgeCode).toContain("409");
    // Bez téhle kontroly by job čekal ve frontě a pak selhal.
    expect(edgeCode).toContain("nejsou nahrány žádné doprovodné obrázky");
    expect(edgeCode).toContain("nejsou nahrána žádná doprovodná videa");
  });

  it("posílá obál alba zvlášť a nepadá na prázdnou hodnotu", () => {
    expect(edgeCode).toContain("cover_lead_path: coverLeadPath");
    expect(edgeCode).toContain("albumCoverLead ?? coverPath");
  });

  it("propustí jen efekt z povolené trojice", () => {
    expect(edgeCode).toContain("EFFECT_CHOICES");
    for (const effect of CENTER_EFFECTS) {
      expect(edgeCode).toContain(`"${effect.id}"`);
    }
  });
});

describe("tab Videa: připravenost písně", () => {
  const base = {
    imageCount: 2,
    videoCount: 1,
    hasFinalAudio: true,
    hasSongCover: true,
  };

  /**
   * Vrátí hlášku, jen když je píseň opravdu nepřipravená. Bez toho by test
   * musel psát `if (!result.ready)` a přehlédl by případ, kdy připravená je.
   */
  function blockerLabel(result: ReturnType<typeof checkVideoModeReadiness>) {
    expect(result.ready).toBe(false);
    return result.ready ? "" : result.label;
  }

  it("bez finálního MP3 není připravená vůbec", () => {
    for (const mode of VIDEO_MODE_TYPES) {
      const result = checkVideoModeReadiness({ ...base, mode, hasFinalAudio: false });
      expect(result.ready).toBe(false);
    }
  });

  it("bez obrázku skladby nejde ani album_cover_intro", () => {
    const result = checkVideoModeReadiness({
      ...base,
      mode: "album_cover_intro",
      hasSongCover: false,
    });
    expect(blockerLabel(result)).toBe("chybí obrázek skladby");
  });

  it("album_cover_intro nepotřebuje doprovodná média", () => {
    const result = checkVideoModeReadiness({
      ...base,
      mode: "album_cover_intro",
      imageCount: 0,
      videoCount: 0,
    });
    expect(result.ready).toBe(true);
  });

  it("režim videa vyžaduje aspoň jedno video", () => {
    const result = checkVideoModeReadiness({
      ...base,
      mode: "gallery_videos",
      videoCount: 0,
      imageCount: 3,
    });
    expect(blockerLabel(result)).toBe("0 doprovodných videí");
  });

  it("kombinované video stačí jedna jakákoliv média", () => {
    expect(checkVideoModeReadiness({ ...base, mode: "gallery_mixed", imageCount: 1, videoCount: 0 }).ready).toBe(true);
    expect(checkVideoModeReadiness({ ...base, mode: "gallery_mixed", imageCount: 0, videoCount: 1 }).ready).toBe(true);
    expect(checkVideoModeReadiness({ ...base, mode: "gallery_mixed", imageCount: 0, videoCount: 0 }).ready).toBe(false);
  });
});

describe("tab Videa: registrace v aplikaci", () => {
  it("je sedmý tab a nezakryje žádný existující", () => {
    const tabs = [...layoutCode.matchAll(/Tabs\.Screen name="([a-z]+)"/g)].map((match) => match[1]);
    expect(tabs).toEqual(["index", "texts", "albums", "library", "videos", "assistant", "settings"]);
  });

  it("nepřidává href: null, který by skryl tab", () => {
    // Tohle přesně zabilo tab Alba: při přenosu mezi repy přišlo `href: null`
    // a uživatel ztratil celou sekci, aniž by se v repu cokoli smazalo.
    expect(layoutCode).not.toContain("href: null");
  });
});
