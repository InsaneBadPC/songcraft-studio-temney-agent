import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("supabase/migrations/20261015000005_user_ai_provider.sql", "utf8");
const catalog = readFileSync("supabase/functions/_shared/llm-providers.ts", "utf8");
const aiSettings = readFileSync("supabase/functions/songcraft-ai-settings/index.ts", "utf8");
const orchestrator = readFileSync("supabase/functions/agent-orchestrator/index.ts", "utf8");
const copywriter = readFileSync("supabase/functions/songcraft-copywriter/index.ts", "utf8");
const rhymes = readFileSync("supabase/functions/songcraft-rhymes/index.ts", "utf8");
const assistant = readFileSync("supabase/functions/songcraft-studio-assistant/index.ts", "utf8");
const client = readFileSync("lib/ai-provider.ts", "utf8");
const settings = readFileSync("app/(tabs)/settings.tsx", "utf8");

const AI_CALLERS = [orchestrator, copywriter, rhymes, assistant];

describe("vlastní API klíč uživatele nesmí nikam odejít", () => {
  it("tabulka je service-only: RLS, žádná client policy, žádná práva klienta", () => {
    expect(migration).toContain("enable row level security");
    expect(migration).toContain("songcraft_drop_client_policies('public.sc_user_ai_settings')");
    expect(migration).toContain("revoke all on public.sc_user_ai_settings");
    expect(migration).toContain("nesmí mít žádnou client policy");
    expect(migration).toContain("klíč by byl čitelný z telefonu");
  });

  it("funkce vrací jen příznak a poslední čtyři znaky", () => {
    expect(aiSettings).toContain("hasKey: Boolean(row)");
    expect(aiSettings).toContain("keyHint: row?.key_hint ?? null");
    // Tělo funkce, která tvoří odpověď pro klienta, nesmí obsahovat api_key.
    const start = aiSettings.indexOf("const clientSettings");
    const end = aiSettings.indexOf("  });", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(aiSettings.slice(start, end)).not.toContain("api_key");
    // A select, kterým se to čte, si klíč vůbec nežádá.
    expect(aiSettings).toContain('select("provider,model,key_hint,key_verified_at,last_error,updated_at")');
    // Klíč se čte jen ve dvou místech a ani jedno není odpověď pro klienta:
    // sdílený resolver (předat do volání modelu) a ověření v list_models.
    const reads = (aiSettings.match(/select\("[^"]*api_key[^"]*"\)/g) ?? [])
      .concat(catalog.match(/select\("[^"]*api_key[^"]*"\)/g) ?? []);
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read).not.toContain("key_hint");
      expect(aiSettings.slice(Math.max(0, aiSettings.indexOf(read)), aiSettings.indexOf(read) + 400)).toContain("fetchProviderModels");
    }
  });

  it("klíč se neloguje ani nepropírá do auditu", () => {
    expect(aiSettings).toContain("Klíč se do auditu nikdy nepropírá");
    // Audit volá payload ručně a vždy bez klíče.
    const auditCalls = aiSettings.match(/audit\([^)]*\{[^}]*\}/g) ?? [];
    for (const call of auditCalls) expect(call).not.toContain("apiKey");
  });

  it("klient posílá klíč jen při ukládání, ne při čtení", () => {
    expect(client).toContain('action: "save_key"');
    expect(client).toContain("apiKey,");
    // get_settings ani list_models klíč z klienta nesmějí.
    const read = client.slice(client.indexOf("getAiSettings"), client.indexOf("saveAiKey"));
    expect(read).not.toContain("apiKey");
  });
});

describe("účet Temney zůstává na sdílených klíčích", () => {
  it("rozliší ho stejná tabulka, kterou používá servisní konzole", () => {
    expect(aiSettings).toContain('from("sc_service_accounts")');
    expect(aiSettings).toContain("sharedOnly");
    expect(aiSettings).toContain("!row && await isServiceAccount()");
  });

  it("bez vlastního klíče se použije sdílený klíč projektu", () => {
    expect(catalog).toContain("export function resolveSharedProvider");
    expect(catalog).toContain('id: "gemini"');
    // První poskytovatel v katalogu je Gemini, takže sdílený klíč zůstává
    // přesně to, co ty funkce používaly předtím.
    const first = catalog.indexOf('id: "gemini"');
    const others = catalog.indexOf('id: "openrouter"');
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(others);
    for (const caller of [copywriter, rhymes, assistant]) {
      expect(caller).toContain("resolveSharedProvider");
    }
    // agent-orchestrator si drží vlastní fallback přes env klíče.
    expect(orchestrator).toContain("provider.keyEnvs.map((entry) => envKeys()[entry])");
  });

  it("každá funkce dá vlastnímu klíči přednost, jinak by se výběr nepoužil", () => {
    for (const caller of AI_CALLERS) {
      expect(caller).toContain("resolveUserProvider");
    }
    // Tři jednoduché funkce: vlastní klíč, jinak sdílený - v tomhle pořadí.
    // Porovnáváme MÍSTA VOLÁNÍ, ne importy - v importu jsou názvy abecedně.
    for (const caller of [copywriter, rhymes, assistant]) {
      const own = caller.indexOf("await resolveUserProvider(admin, user.id)");
      const shared = caller.indexOf("?? resolveSharedProvider(");
      expect(own).toBeGreaterThan(-1);
      expect(shared).toBeGreaterThan(own);
    }
    // agent-orchestrator má vlastní fallback přes env klíče: vloží poskytovatele
    // uživatele před seznamem sdílených, takže jeho cyklus musí obsahovat own.
    const start = orchestrator.indexOf("for (const provider of own ?");
    expect(start).toBeGreaterThan(-1);
    const loop = orchestrator.slice(start, start + 140);
    expect(loop).toContain("own.provider");
    expect(loop.indexOf("own.provider")).toBeLessThan(loop.indexOf("OWN_PROVIDERS"));
  });

  it("vision zůstává na Gemini, i když má uživatel jiného providera", () => {
    expect(orchestrator).toContain('ownVision?.provider.id === "gemini"');
    expect(orchestrator).toContain("visionProvider(OWN_PROVIDERS, visionEnv)");
    expect(orchestrator).toContain("motion-recipe.ts");
  });
});

describe("katalog providerů je jeden zdroj pravdy", () => {
  it("agent-orchestrator si katalog nevytváří vlastní", () => {
    expect(orchestrator).toContain('from "../_shared/llm-providers.ts"');
    // Dva `const PROVIDERS` v jednom souboru by znamenaly rozdvoj.
    expect((orchestrator.match(/^const PROVIDERS:/gm) ?? []).length).toBe(0);
    expect(orchestrator).toContain("const OWN_PROVIDERS: ProviderCfg[] = PROVIDERS.map");
  });

  it("provider v databázi musí sedět s katalogem", () => {
    expect(catalog).toContain("export function findProvider");
    expect(aiSettings).toContain('findProvider(wanted)');
    expect(aiSettings).toContain('findProvider(providerId)');
    expect(aiSettings).toContain("Neznámý poskytovatel");
  });

  it("seznam je záměrný a uvádí, kde klíč vzít", () => {
    for (const id of ["gemini", "openrouter", "groq", "cerebras", "sambanova", "deepseek"]) {
      expect(catalog).toContain(`id: "${id}"`);
    }
    expect(catalog).toContain("signupUrl");
    expect(catalog).toContain("freeNote");
  });

  it("každý provider umí říct, co je free", () => {
    // OpenRouter má přesnou cenu, Gemini rodinu flash, ostatní free plán celý.
    expect(catalog).toContain('id.endsWith(":free")');
    expect(catalog).toContain("/flash/i.test");
    // Bez toho by se zobrazilo všechno, co klíč vidí, včetně placených.
    expect(catalog).toContain("if (provider.isFree && !provider.isFree(entry)) continue;");
  });
});

describe("klíč se ověří dřív, než se uloží", () => {
  it("uložený klíč musí být schopen načíst modely", () => {
    expect(aiSettings).toContain("Ověření proti API poskytovatele PŘED uložením");
    expect(aiSettings).toContain("const models = await fetchProviderModels(provider, apiKey)");
    expect(aiSettings).toContain("klíč nepřijal");
  });

  it("tvar klíče se kontroluje podle providera", () => {
    expect(aiSettings).toContain('providerId === "gemini" && !key.startsWith("AIza")');
    expect(aiSettings).toContain('providerId === "openrouter" && !key.startsWith("sk-or-")');
    expect(aiSettings).toContain('providerId === "groq" && !key.startsWith("gsk_")');
    expect(aiSettings).toContain('providerId === "cerebras" && !key.startsWith("csk-")');
  });

  it("když API neodpoví, ukáže se záložní seznam, ne chyba klíče", () => {
    expect(aiSettings).toContain('source: "fallback"');
    expect(aiSettings).toContain('live_result.source === "live"');
    expect(catalog).toContain("export function fallbackModels");
    // fetchProviderModels vrací null, ne hází - jinak by se špatný klíč
    // a výpadek providera tvářily stejně.
    expect(catalog).toMatch(/catch \{\s*return null;/);
    expect(aiSettings).toContain("Zobrazuji záložní seznam");
  });

  it("výběr modelu nejde přes save_key s prázdným klíčem", () => {
    expect(aiSettings).toContain('"set_model"');
    expect(aiSettings).toContain("Změna modelu NESMÍ jít přes save_key");
    expect(client).toContain("saveAiModelChoice");
    expect(settings).toContain("saveAiModelChoice(entry.id)");
    // Starý bug: prázdný klíč ve save_key by spadl na validaci délky.
    expect(settings).not.toMatch(/saveAiKey\(aiProvider,\s*""/);
  });
});

describe("Nastavení v aplikaci", () => {
  it("sekce je jen pro účty, které si providera zadají", () => {
    expect(settings).toContain("aiSettings && !aiSettings.sharedOnly");
    expect(settings).toContain("Vlastní AI poskytovatel");
  });

  it("má výběr providera, pole na klíč a načtení modelů", () => {
    expect(settings).toContain("Uložit a načíst modely");
    expect(settings).toContain("Načíst modely");
    expect(settings).toContain("aiProviders.map");
    expect(settings).toContain("freeNote");
  });

  it("říká, že klíč do telefonu nevrátí", () => {
    expect(settings).toContain("Klíč se ukládá na serveru a nikdy se nevrátí do telefonu");
  });

  it("umožní klíč smazat a vrátit se ke sdílenému", () => {
    expect(settings).toContain("Smazat vlastní klíč");
    expect(settings).toContain("clearAiKey");
    expect(settings).toContain("Uložený klíč končí na …");
  });
});