import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const detail = readFileSync("app/song/[id].tsx", "utf8");

describe("odkazy v detailu skladby", () => {
  it("používá helper pro všechny publikace", () => {
    expect(detail).toContain("publishedVideosForSong(");
    expect(detail).toContain("ExternalLink");
    expect(detail).toContain("https://youtu.be/");
  });
  it("rozlišuje Video a Shorts a nejen publishedVideoId", () => {
    expect(detail).toContain("publishedVideo.kind");
    expect(detail).toContain("publishedVideo.youtubeVideoId");
    expect(detail).not.toMatch(/Kopírovat link[\s\S]{0,200}youtube\.com\/watch/);
  });
});
