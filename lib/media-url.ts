import { supabase } from "@/lib/supabase";

/**
 * Podepisování URL na media - dávkově a s cache.
 *
 * Proč to není "signed URL na každý řádek":
 * Snapshot studia má ~150 řádků s obalem/MP3. Kdyby se každý podepsal
 * zvlášť, jeden načtení obrazovky = ~160 API requestů (tak to fungovalo
 * a právě to přetáhlo kvótu). Tady se podepíše celý balík v JEDNOM
 * requestu (`sign_batch`) a výsledek se drží v paměti.
 */

const SIGN_TTL_MS = 45 * 60 * 1000;
const SIGN_FUNCTION = "songcraft-media-store";

const cache = new Map<string, { url: string; expiresAt: number }>();

export const isR2Path = (value: string | null | undefined): boolean => Boolean(value?.startsWith("r2://"));

export const isAbsoluteUrl = (value: string | null | undefined): boolean =>
  Boolean(value && /^(?:https?:|data:|file:|content:|blob:)/i.test(value));

const cacheKey = (path: string) => path;

export function clearMediaUrlCache(): void {
  cache.clear();
}

function cachedUrls(paths: string[]): Record<string, string> {
  const urls: Record<string, string> = {};
  const now = Date.now();
  for (const path of paths) {
    const entry = cache.get(cacheKey(path));
    if (entry && entry.expiresAt > now) urls[path] = entry.url;
  }
  return urls;
}

function rememberUrls(urls: Record<string, string>): void {
  const expiresAt = Date.now() + SIGN_TTL_MS;
  for (const [path, url] of Object.entries(urls)) {
    if (!url) continue;
    cache.set(cacheKey(path), { url, expiresAt });
  }
}

/**
 * Podepíše všechny cesty, které ještě nemá v cache, JEDNÍM requestem.
 * Vrací mapu `cesta -> URL`.
 */
export async function signMediaPaths(paths: (string | null | undefined)[]): Promise<Record<string, string>> {
  const wanted = [...new Set(paths.filter((path): path is string => Boolean(path && path.length > 0)))];
  if (wanted.length === 0) return {};

  const known = cachedUrls(wanted);
  const missing = wanted.filter((path) => !known[path]);
  if (missing.length === 0) return known;

  const { data, error } = await supabase.functions.invoke(SIGN_FUNCTION, { body: { action: "sign_batch", paths: missing } });
  if (error || !data) return known;

  const urls = (data as { urls?: Record<string, string> }).urls ?? {};
  rememberUrls(urls);
  return { ...known, ...urls };
}

/**
 * Jedna cesta -> hotová URL (přes cache, jinak přes sign_batch).
 * Používá se v okamžiku, kdy uživatel fakt soubor otevírá/přehrává.
 */
export async function resolveMediaUrl(path: string | null | undefined): Promise<string | null> {
  if (!path) return null;
  if (isAbsoluteUrl(path)) return path;
  const urls = await signMediaPaths([path]);
  return urls[path] ?? null;
}

/** Verze path, kterou smí poslat dál do DB (r2://... nebo legacy cesta). */
export function mediaStorageKey(path: string | null | undefined): string | null {
  if (!path) return null;
  return isAbsoluteUrl(path) ? null : path;
}
