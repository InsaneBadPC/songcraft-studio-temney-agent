import { resolveMediaUrl, signMediaPaths } from "@/lib/media-url";
import { supabase } from "@/lib/supabase";
import { assertOwnedStoragePath } from "@/lib/storage-paths";

export type StudioVideoJob = {
  id: string;
  songId: string | null;
  type: string;
  mode: string | null;
  backend: string | null;
  /** Efekt na obrázku skladby pro album_cover_intro. */
  centerEffect: string | null;
  renderStatus: "queued" | "rendering" | "ready" | "failed" | string;
  errorMessage: string | null;
  storagePath: string | null;
  createdAt: string;
};

/**
 * `userId` jde ze sdíleného stavu přihlášení (useAuth v kontextu).
 *
 * Dřív si funkce volala `supabase.auth.getUser()` sama - při pollingu
 * každých 15 s to znamenalo extra auth request navíc ke každému dotazu
 * na joby. Teď je identita zdarma, protože ji má provider v paměti.
 */
export async function listVideoJobs(userId: string | null | undefined, limit = 5): Promise<StudioVideoJob[]> {
  if (!userId) throw new Error("Pro seznam renderů se přihlas.");
  const { data, error } = await supabase.from("agent_videos").select("id,song_id,type,mode,backend,center_effect,render_status,error_message,storage_path,created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(Math.min(Math.max(limit, 1), 20));
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({ id: row.id, songId: row.song_id, type: row.type, mode: row.mode ?? null, backend: row.backend ?? null, centerEffect: row.center_effect ?? null, renderStatus: row.render_status, errorMessage: row.error_message ?? null, storagePath: row.storage_path ?? null, createdAt: row.created_at }));
}

/**
 * Podepsaná URL hotového videa. Cesta může být legacy Supabase Storage
 * i R2 (`r2://...`) - podepíše se stejným dávkovým mechanismem jako
 * ostatní média, ne vlastním requestem na každý soubor.
 */
export async function getVideoDownloadUrl(userId: string | null | undefined, job: StudioVideoJob) {
  if (!userId) throw new Error("Pro stažení videa se přihlas.");
  if (job.renderStatus !== "ready" || !job.storagePath) throw new Error("Video ještě není připravené.");
  const path = assertOwnedStoragePath(userId, job.storagePath);
  const url = await resolveMediaUrl(path);
  if (!url) throw new Error("Video se nepodařilo podepsat.");
  return url;
}

/** Podepíše cesty hotových jobů najednou (pro seznam, ne po jednom). */
export async function signVideoJobPaths(paths: (string | null | undefined)[]): Promise<Record<string, string>> {
  return signMediaPaths(paths);
}
