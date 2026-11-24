import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const texts = readFileSync("app/(tabs)/texts.tsx", "utf8");
const ui = readFileSync("components/studio-ui.tsx", "utf8");

describe("seznam Textů", () => {
  it("má filtr Rozpracované / Archivováno", () => {
    expect(texts).toContain("Rozpracované");
    expect(texts).toContain("Archivováno");
    expect(texts).toContain('d.status === "archived"');
  });

  it("neořezává název položky", () => {
    expect(texts).not.toMatch(/<Text[^>]*numberOfLines=\{2\}[^>]*style=\{[^}]*styles\.name/);
    expect(texts).toContain("styles.name");
  });

  it("zná archivovaný stav v StatusChip", () => {
    expect(ui).toContain('state: "draft" | "complete" | "cloud" | "archived"');
    expect(ui).toContain("ARCHIVOVÁNO");
  });
});
