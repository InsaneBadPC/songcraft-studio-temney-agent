import { describe, expect, it } from "vitest";

import {
  buildSimpleSrt,
  buildYoutubeDescription,
  buildYoutubeSummary,
  buildYoutubeTags,
  buildYoutubeTitle,
  genreDescriptor,
} from "../supabase/functions/_shared/youtube-metadata";

const base = {
  title: "Falešná naděje",
  album: "Myšlenkovej Boom",
  lyrics: "Tma padá na blok.\nZ mých plic hustý dým.",
  stylePrompts: ["viking hip hop", "dark nordic"],
};

describe("YouTube metadata", () => {
  it("staví název se žánrovým deskriptorem a označením typu videa", () => {
    expect(buildYoutubeTitle(base)).toBe("TEMNEY - Falešná naděje (Viking Hip Hop | Official Lyric Video)");
    expect(buildYoutubeTitle({ ...base, videoKind: "shorts" })).toContain("Official Short");
  });

  it("drží limit názvu 100 znaků", () => {
    const title = buildYoutubeTitle({ ...base, title: "A".repeat(300) });
    expect(title.length).toBeLessThanOrEqual(100);
  });

  it("vybere žánr podle stylu, ne podle názvu", () => {
    expect(genreDescriptor({ title: "X", stylePrompts: ["psychedelic šílenství"] })).toBe("Psychedelický Rap");
    expect(genreDescriptor({ title: "X", stylePrompts: [] })).toBe("Hip Hop");
  });

  it("popis je krátký souhrn, ne dump textu s produkčními poznámkami", () => {
    const description = buildYoutubeDescription({
      ...base,
      summary: "Skladba sleduje člověka, který se v noci vyrovnává s vlastními démony.",
    });
    expect(description).toContain("Skladba sleduje člověka");
    expect(description).toContain("Myšlenkovej Boom");
    expect(description).toContain("#Temney");
    expect(description).toContain("#MyslenkovejBoom");
    expect(description).not.toContain("Tma padá na blok.");
    expect(description).not.toContain("TEXT:");
  });

  it("bez souhrnu složí krátký popis z názvu, žánru a alba", () => {
    const description = buildYoutubeDescription(base);
    expect(description).toContain("Falešná naděje");
    expect(description).toContain("je viking hip hop od TEMNEY");
    expect(description).not.toContain("Tma padá na blok.");
  });

  it("odstraní hashtagy ze souhrnu, aby je popis nepřidával dvakrát", () => {
    expect(buildYoutubeSummary({ ...base, summary: "Text písně. #Temney #FalesnaNadeje" })).toBe("Text písně.");
  });

  it("očistí a zkrátí příliš dlouhý souhrn", () => {
    const summary = buildYoutubeSummary({ ...base, summary: ` „${"velmi ".repeat(300)}“ ` });
    expect(summary.length).toBeLessThanOrEqual(600);
    expect(summary.startsWith("velmi")).toBe(true);
    expect(summary.endsWith(" „")).toBe(false);
  });

  it("drží limit popisu 5000 znaků", () => {
    const description = buildYoutubeDescription({
      ...base,
      summary: "řádek\n".repeat(2000),
      lyrics: "text\n".repeat(2000),
    });
    expect(description.length).toBeLessThanOrEqual(5000);
  });

  it("tagy jsou bez duplicit, max 15, každý max 30 znaků", () => {
    const tags = buildYoutubeTags(base);
    expect(tags.length).toBeLessThanOrEqual(15);
    expect(tags.every((tag) => tag.length <= 30)).toBe(true);
    expect(new Set(tags.map((t) => t.toLowerCase())).size).toBe(tags.length);
    expect(tags[0]).toBe("Falešná naděje");
  });

  it("vytvoří načasované titulky z holého textu", () => {
    const srt = buildSimpleSrt("první řádek\ndruhý řádek", 30);
    expect(srt).toContain("1\n00:00:00,000 -->");
    expect(srt).toContain("první řádek");
    expect(srt).toContain("druhý řádek");
    expect(srt.trim().split("\n\n").length).toBe(2);
  });

  it("bez textu nebo délky titulky nevrací", () => {
    expect(buildSimpleSrt("", 30)).toBe("");
    expect(buildSimpleSrt("text", 0)).toBe("");
  });
});
