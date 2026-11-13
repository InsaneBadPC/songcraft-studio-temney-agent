/**
 * Skládání názvu, popisu a tagů pro YouTube publikaci.
 *
 * Jeden zdroj pravdy pro obě cesty (agent i běžný uživatel), aby název,
 * popis i tagy vypadaly stejně. Pravidla vychází z docs/YOUTUBE_RUST.md:
 *
 *  - Název: [Interpret] - [Název] ([Žánr / Nálada] | Official ... Video)
 *    Žánrový deskriptor v závorce řekne divákovi i algoritmu, o co jde,
 *    a tím zvyšuje CTR u skladby, kterou zatím nikdo nevyhledává.
 *  - Popis: krátký lidský souhrn (2–3 věty) + album + CTA + hashtagy.
 *    Plný text patří do titulků, ne do popisu — dump textu s poznámkami
 *    o produkci vypadal na YouTube jako surový prompt, ne jako popis písně.
 *  - Tagy: normalizované, max 15, každý max 30 znaků.
 *
 * Vše se čistí: název max 100 znaků, popis max 5000 znaků (limit YouTube).
 */

export type YoutubeMetadataInput = {
  artist?: string;
  title: string;
  album?: string | null;
  genre?: string | null;
  lyrics?: string | null;
  summary?: string | null;
  stylePrompts?: string[] | null;
  videoKind?: "video" | "shorts";
  language?: string | null;
};

const DEFAULT_ARTIST = "TEMNEY";
const VIDEO_LABEL: Record<"video" | "shorts", string> = {
  video: "Official Lyric Video",
  shorts: "Official Short",
};

// Tohle je jádro čitelnosti názvu. Bere se první, co sedí, jinak "Hip Hop".
const GENRE_RULES: [RegExp, string][] = [
  [/viking|nordic|seversk|valhal/i, "Viking Hip Hop"],
  [/temn|dark|noir|temno/i, "Temný Český Rap"],
  [/psychedel|surreal|šílen|labyrint/i, "Psychedelický Rap"],
  [/melanchol|smutn/i, "Melancholický Rap"],
  [/street|ulic|sídl|sidl/i, "Street Rap"],
  [/boom ?bap|old ?school/i, "Boom Bap"],
  [/trap/i, "Trap"],
  [/lo.?fi/i, "Lo-Fi Hip Hop"],
];

const JUNK_STYLE = /^(hip ?hop|rap|pop|rock|music|hudba|cz|cs|česky)$/i;

function firstLine(value: string) {
  return value.split(/\r?\n/, 1)[0].trim();
}

function stripDiacritics(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function slugHashtag(value: string) {
  return stripDiacritics(value).replace(/[^A-Za-z0-9]+/g, "").slice(0, 40);
}

function clip(value: string, max: number) {
  return value.length <= max ? value : value.slice(0, max - 1).trimEnd() + "…";
}

/** Žánrový deskriptor z textu stylu/žánru. */
export function genreDescriptor(input: YoutubeMetadataInput): string {
  const haystack = [input.genre ?? "", ...(input.stylePrompts ?? [])].join(" ");
  for (const [pattern, label] of GENRE_RULES) {
    if (pattern.test(haystack)) return label;
  }
  const cleaned = (input.stylePrompts ?? [])
    .map((part) => part.trim())
    .find((part) => part.length > 0 && !JUNK_STYLE.test(part));
  return cleaned ? cleaned.slice(0, 40) : "Hip Hop";
}

/** [Interpret] - [Název] ([Žánr] | Official ... Video). */
export function buildYoutubeTitle(input: YoutubeMetadataInput): string {
  const artist = (input.artist?.trim() || DEFAULT_ARTIST).slice(0, 60);
  const title = firstLine(input.title).slice(0, 90);
  const genre = genreDescriptor(input);
  const kind = input.videoKind === "shorts" ? "shorts" : "video";
  return clip(`${artist} - ${title} (${genre} | ${VIDEO_LABEL[kind]})`, 100);
}

/** Krátký souhrn: co v písni divák uslyší. Nikdy nedumpuje celý text. */
export function buildYoutubeSummary(input: YoutubeMetadataInput): string {
  const provided = (input.summary ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[„“"«»]+|[„“"«»]+$/g, "")
    .trim();
  if (provided) return clip(provided, 600);

  const title = firstLine(input.title);
  const artist = input.artist?.trim() || DEFAULT_ARTIST;
  const genre = genreDescriptor(input).toLowerCase();
  return clip(`„${title}“ je ${genre} od ${artist}.`, 600);
}

/** Popis: krátký souhrn + album + CTA + hashtagy. Text písně záměrně vynechává. */
export function buildYoutubeDescription(input: YoutubeMetadataInput): string {
  const title = firstLine(input.title);
  const summary = buildYoutubeSummary(input);
  const album = input.album?.trim();
  const lines: string[] = [summary];

  if (album) lines.push("", `Album: ${album}`);
  lines.push(
    "",
    `▸ Odběr na YouTube: https://www.youtube.com/@Temney?sub_confirmation=1`,
    "",
    [
      "#Temney",
      `#${slugHashtag(title) || "Song"}`,
      album ? `#${slugHashtag(album)}` : "",
      "#ceskahudba",
    ].filter(Boolean).join(" "),
  );
  return clip(lines.join("\n"), 5000);
}

/** Tagy: název, interpret, žánr, album - normalizované a bez duplicit. */
export function buildYoutubeTags(input: YoutubeMetadataInput): string[] {
  const artist = input.artist?.trim() || DEFAULT_ARTIST;
  const title = firstLine(input.title);
  const genre = genreDescriptor(input);
  const raw = [
    title,
    artist,
    `${
      artist
    } ${
      title
    }`,
    input.album ?? "",
    genre,
    "český hip hop",
    "český rap",
    "viking hip hop",
    "hip hop 2026",
    "nový český rap",
  ];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const value of raw) {
    const tag = value.trim().slice(0, 30);
    const key = tag.toLowerCase();
    if (tag && !seen.has(key)) {
      seen.add(key);
      tags.push(tag);
    }
    if (tags.length >= 15) break;
  }
  return tags;
}

/** Jednoduchý .srt z holého textu: každý neprázdný řádek jako jeden blok. */
export function buildSimpleSrt(lyrics: string, totalSeconds: number): string {
  const verses = lyrics
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (verses.length === 0 || totalSeconds <= 0) return "";

  // Delší verše dostanou úměrně víc času, ať titulek "nezmizí" uprostřed.
  const weights = verses.map((v) => Math.max(1, v.length));
  const weightSum = weights.reduce((a, b) => a + b, 0);
  let cursor = 0;
  const stamp = (seconds: number) => {
    const ms = Math.max(0, Math.round(seconds * 1000));
    const h = String(Math.floor(ms / 3_600_000)).padStart(2, "0");
    const m = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, "0");
    const s = String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0");
    const milli = String(ms % 1000).padStart(3, "0");
    return `${h}:${m}:${s},${milli}`;
  };
  const blocks: string[] = [];
  verses.forEach((verse, index) => {
    const start = cursor;
    const span = (weights[index] / weightSum) * totalSeconds;
    cursor += span;
    const end = index === verses.length - 1 ? totalSeconds : cursor;
    blocks.push(
      `${index + 1}\n${stamp(start)} --> ${stamp(end)}\n${verse}\n`,
    );
  });
  return blocks.join("\n");
}
