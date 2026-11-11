import { describe, expect, it } from "vitest";

import { countText, formatTextStats } from "../lib/text-stats";

describe("statistiky textu", () => {
  it("spočítá řádky, slova a znaky", () => {
    expect(countText("První řádek\nDruhý řádek")).toEqual({ lines: 2, words: 4, chars: 23 });
  });

  it("vrátí nuly pro prázdný text", () => {
    expect(countText("")).toEqual({ lines: 0, words: 0, chars: 0 });
  });

  it("skloňuje podle českých pravidel", () => {
    expect(formatTextStats("jeden")).toBe("1 řádek · 1 slovo · 5 znaků");
    expect(formatTextStats("dva slova")).toBe("1 řádek · 2 slova · 9 znaků");
    expect(formatTextStats("pět slov zde")).toBe("1 řádek · 3 slova · 12 znaků");
  });
});
