/**
 * Typy doprovodných médií písně a pevné časy skládání videa.
 *
 * Časy jsou záměrně tady, ne rozptýlené v rendereru: uživatel si nastaví
 * smyčku jen jednou a změna se promítne všude.
 */

/** Obrázek nebo krátké video. */
export type SongMediaKind = "image" | "video";

export interface SongMediaItem {
  id: string;
  songId: string;
  kind: SongMediaKind;
  storageKey: string;
  url: string | null;
  originalFileName: string | null;
  mimeType: string | null;
  byteSize: number;
  sortOrder: number;
  /** Vlastní délka scény v ms; 0 = použít SCENE_SECONDS. */
  sceneMs: number;
}

/**
 * Složení videa, které uživatel vidí v panelu:
 *   [cover 5 s] -> [scéna 8 s] -> [scéna 8 s] ... -> [cover 5 s]
 */
export const COVER_LEAD_SECONDS = 5;
export const COVER_TAIL_SECONDS = 5;
export const SCENE_SECONDS = 8;

/** Rychlý převod na ffmpeg argumenty. */
export const COVER_LEAD = COVER_LEAD_SECONDS;
export const COVER_TAIL = COVER_TAIL_SECONDS;
export const SCENE = SCENE_SECONDS;

export function formatBytes(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}