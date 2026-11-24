import type { StudioPublication, StudioSnapshot, StudioVideo } from "@/lib/external-studio";

export type PublishedVideoLink = {
  id: string;
  youtubeVideoId: string;
  title: string;
  publishedAt: Date | null;
  kind: "Video" | "Shorts";
};

const SHORT_MARKERS = ["#shorts", "official short"];

export function isShortPublication(publication: StudioPublication, videos: StudioVideo[]): boolean {
  const linkedVideo = publication.videoId
    ? videos.find((video) => video.id === publication.videoId && video.songId === publication.songId)
    : undefined;
  if (linkedVideo?.aspect === "9:16") return true;
  const title = (publication.title ?? "").toLowerCase();
  if (SHORT_MARKERS.some((marker) => title.includes(marker))) return true;
  return publication.tags.some((tag) => SHORT_MARKERS.some((marker) => tag.toLowerCase().includes(marker)));
}

export function shortsState(snapshot: StudioSnapshot, songId: string): "none" | "created" | "published" {
  const publishedShort = snapshot.publications.some(
    (publication) =>
      publication.songId === songId &&
      publication.status === "published" &&
      isShortPublication(publication, snapshot.videos),
  );
  if (publishedShort) return "published";
  const readyVerticalVideo = snapshot.videos.some(
    (video) => video.songId === songId && video.aspect === "9:16" && video.renderStatus === "ready",
  );
  return readyVerticalVideo ? "created" : "none";
}

export function publishedVideosForSong(snapshot: StudioSnapshot, songId: string): PublishedVideoLink[] {
  return snapshot.publications
    .filter(
      (publication): publication is StudioPublication & { youtubeVideoId: string } =>
        publication.songId === songId &&
        publication.status === "published" &&
        typeof publication.youtubeVideoId === "string" &&
        publication.youtubeVideoId.trim().length > 0,
    )
    .map((publication): PublishedVideoLink => ({
      id: publication.id,
      youtubeVideoId: publication.youtubeVideoId,
      title: publication.title ?? "",
      publishedAt: publication.publishedAt,
      kind: isShortPublication(publication, snapshot.videos) ? "Shorts" : "Video",
    }))
    .sort((a, b) => {
      if (a.publishedAt === null) return b.publishedAt === null ? 0 : 1;
      if (b.publishedAt === null) return -1;
      return b.publishedAt.getTime() - a.publishedAt.getTime();
    });
}
