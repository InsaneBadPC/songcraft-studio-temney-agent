import { describe, expect, it } from "vitest";
import { publishedVideosForSong, shortsState } from "../lib/shorts";

const video = (id: string, songId: string, aspect: string) => ({ id, userId: "u", songId, aspect, renderStatus: "ready", type: "image_animation", mode: null, createdAt: new Date("2026-01-01T00:00:00.000Z") });
const publication = (id: string, songId: string, videoId: string | null, youtubeVideoId: string, title: string, tags: string[] = []) => ({ id, userId: "u", songId, videoId, youtubeVideoId, status: "published", title, tags, publishedAt: new Date("2026-01-02T00:00:00.000Z"), privacyStatus: "public" });

describe("shorts state", () => {
  it("published má přednost před created", () => {
    const snapshot = { videos: [video("v1", "s1", "9:16")], publications: [publication("p1", "s1", "v1", "abc", "TEMNEY – A #shorts")] };
    expect(shortsState(snapshot as any, "s1")).toBe("published");
  });
  it("pozná created podle 9:16 video", () => {
    const snapshot = { videos: [video("v1", "s1", "9:16")], publications: [] };
    expect(shortsState(snapshot as any, "s1")).toBe("created");
  });
  it("legacy shorts pozná podle #shorts v názvu", () => {
    const hashtag = { videos: [video("v1", "s1", "16:9")], publications: [publication("p1", "s1", "v1", "abc", "TEMNEY – A #shorts")] };
    const descriptor = { videos: [video("v1", "s1", "16:9")], publications: [publication("p1", "s1", "v1", "abc", "TEMNEY – A Official Short")] };
    expect(shortsState(hashtag as any, "s1")).toBe("published");
    expect(shortsState(descriptor as any, "s1")).toBe("published");
  });
  it("nepletl cizí skladbu", () => {
    const snapshot = { videos: [video("v1", "other", "9:16")], publications: [] };
    expect(shortsState(snapshot as any, "s1")).toBe("none");
  });
  it("vrátí všechna publikovaná videa", () => {
    const snapshot = { videos: [video("v1", "s1", "9:16")], publications: [publication("p1", "s1", null, "long1", "TEMNEY – A"), publication("p2", "s1", "v1", "short1", "TEMNEY – A #shorts")] };
    const links = publishedVideosForSong(snapshot as any, "s1");
    expect(links.map((l) => l.kind)).toEqual(["Video", "Shorts"]);
    expect(links.map((l) => l.youtubeVideoId)).toEqual(["long1", "short1"]);
  });
});
