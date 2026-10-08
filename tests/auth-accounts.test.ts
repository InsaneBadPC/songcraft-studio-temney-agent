import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Seznam prihlasovacich obrazovky je napsany natvrdo v app/auth.tsx - tak to
// nebylo nikdy generovane z databaze. Kdyz se prida ucet do Supabase, ale zapomene
// se na tenhle soubor, uzivatel se v aplikaci neprihlasi a chyba se tvari jako
// spatne heslo. Proto se tu hlida, ze kazde jmeno v obrazovce ma unikatni id a
// e-mail na @songcraft.test, a ze spodni poznamka zmiňuje všechny.

const auth = readFileSync("app/auth.tsx", "utf8");

const listed = [...auth.matchAll(
  /\{\s*id:\s*"([^"]+)",\s*name:\s*"([^"]+)",\s*email:\s*"([^"]+)",\s*description:\s*"([^"]+)"/g,
)].map((m) => ({ id: m[1], name: m[2], email: m[3], description: m[4] }));

describe("prihlasovaci obrazovka", () => {
  it("ma vsechny zname po sobe", () => {
    expect(listed.length, "v app/auth.tsx neni zadny ucet").toBeGreaterThan(0);
    expect(listed.map((a) => a.name)).toContain("Temney");
    expect(listed.map((a) => a.name)).toContain("DJ Palačinka");
    expect(listed.map((a) => a.name)).toContain("Verča");
    expect(listed.map((a) => a.name)).toContain("Wednesday");
  });

  it("id je unikatni a e-mail konci na songcraft.test", () => {
    const ids = listed.map((a) => a.id);
    expect(new Set(ids).size, `duplicitni id: ${ids.join(", ")}`).toBe(ids.length);
    for (const a of listed) {
      expect(a.email, `${a.name} ma email mimo songcraft.test`).toMatch(/@songcraft\.test$/);
    }
  });

  it("heslo v obrazovce nikdy nefiguruje", () => {
    // heslo se zadava do pole rucne, v kodu být nesmi
    expect(auth).not.toMatch(/password:\s*"[^"]+"/);
    expect(auth).not.toMatch(/Heslo\d/);
  });

  it("spodni poznamka zminuje kazde jmeno - jinak lide nevi, ze ucet existuje", () => {
    // Poznamka mluvi cesky, takze jmenem prochazi pad a koncovka se meni:
    // "Verca" -> "Vercu", "DJ Palacinka" -> "DJ Palacinku". Proto se porovnava
    // na klic bez diakritiky z prvnich CTECH znaku - to jeste staci na rozliseni
    // techhle jmen a koncovku prezije.
    const key = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().slice(0, 4);
    const note = /Přístup je omezený na ([^.]+)\./.exec(auth)?.[1] ?? "";
    expect(note, "poznamka pod prihlasovacim formularem chybi").not.toBe("");
    const noteKey = note.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    for (const a of listed) {
      expect(noteKey, `${a.name} chybi v poznamce pod prihlasovacim formularem`).toContain(key(a.name));
    }
  });
});