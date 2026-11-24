import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const library = readFileSync("app/(tabs)/library.tsx", "utf8");

describe("Shorts badge v knihovně", () => {
  it("používá helper a zobrazuje SHORTS", () => {
    expect(library).toContain("shortsState(");
    expect(library).toContain(">SHORTS<");
  });
  it("rozlišuje modrou a zelenou", () => {
    expect(library).toContain("colors.primary");
    expect(library).toContain("colors.success");
    expect(library).toContain("shortsTone");
  });
});
