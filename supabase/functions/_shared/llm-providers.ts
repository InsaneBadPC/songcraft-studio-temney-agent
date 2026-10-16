/**
 * Katalog AI poskytovatelů a načítání jejich modelů.
 *
 * Jeden zdroj pravdy: tento soubor přebírá `PROVIDERS` z `agent-orchestrator`,
 * aby se katalog nevyskytoval na dvou místech. Adaptery na volání (`geminiChat`
 * a `openaiCompatibleChat`) zůstávají v `agent-orchestrator` - tam jsou
 * napojené na nástroje pro agenta.
 *
 * Účet Temney jede na sdílených serverových klíčích (`keyEnvs`) a jeho
 * chování se tímto souborem vůbec nemění. Ostatní účty si zadají vlastní
 * providera a vlastní klíč; ten má v `sc_user_ai_settings` prioritu.
 *
 * Seznam je záměrný, ne výběr z katalogu: `provider` v databázi musí sedět
 * s `id` odtud, jinak by šlo uložit nesmysl a funkce by nevěděla, kam volat.
 *
 * `kind` určuje tvar volání:
 *   gemini - rodné API, `x-goog-api-key`, `/models/{model}:generateContent`
 *   openai - OpenAI-compatible, `Authorization: Bearer`, `/chat/completions`
 *
 * `models` je pouze záložní seznam pro případ, že poskytovatel neodpoví nebo
 * klíč nemá přístup k žádnému modelu - aplikace pak neskočí rovnou na chybu,
 * ale zkusí něco použitelného.
 */

export type ProviderKind = "gemini" | "openai";

export type ProviderCfg = {
  id: string;
  label: string;
  kind: ProviderKind;
  base: string;
  /** Záložní modely, použité když se nepovede načíst seznam z API. */
  models: string[];
  /** Serverové proměnné s klíčem projektu - cesta účtu Temney. */
  keyEnvs: string[];
  /** Kde uživatel klíč získá. */
  signupUrl: string;
  /** Co je na free plánu - zobrazí se v aplikaci. */
  freeNote: string;
  /** Vyžaduje ověření telefonem. Zobrazí se v aplikaci. */
  phoneRequired?: boolean;
  /**
   * Jak poznat free model v odpovědi `/models`. Bez toho se vrátí všechno,
   * co klíč vidí - u většiny providerů je totiž free celý plán.
   */
  isFree?: (model: Record<string, unknown>) => boolean;
};

const isZeroPrice = (value: unknown) => value === "0" || value === 0 || value === "0.0";

export const PROVIDERS: ProviderCfg[] = [
  {
    id: "gemini",
    label: "Google AI Studio (Gemini)",
    kind: "gemini",
    base: "https://generativelanguage.googleapis.com/v1beta",
    models: ["gemini-3.6-flash", "gemini-3.1-flash-lite", "gemini-2.5-flash-lite"],
    keyEnvs: ["GOOGLE_AI_STUDIO_KEY", "GEMINI_API_KEY"],
    signupUrl: "https://aistudio.google.com/apikey",
    freeNote: "Nejštědřejší free tier. Karta není potřeba. Flash modely jsou zdarma, Pro ne.",
    // Na free plánu jsou rodiny *flash*; Pro a image modely jsou placené.
    isFree: (model) => typeof model.name === "string" && /flash/i.test(String(model.name)),
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai",
    base: "https://openrouter.ai/api/v1",
    models: ["google/gemini-3.5-flash-lite", "deepseek/deepseek-v4.1-flash"],
    keyEnvs: ["OPENROUTER_API_KEY"],
    signupUrl: "https://openrouter.ai/keys",
    freeNote: "Jedna adresa, stovky modelů. Free modely končí příponou :free (20 RPM, 50 RPD na účet).",
    // OpenRouter vrací ceníhle a dá se podle ní poznat free model přesně.
    isFree: (model) => {
      const id = String(model.id ?? "");
      if (id.endsWith(":free")) return true;
      const pricing = model.pricing as { prompt?: unknown; completion?: unknown } | undefined;
      if (!pricing) return false;
      return isZeroPrice(pricing.prompt) && isZeroPrice(pricing.completion);
    },
  },
  {
    id: "groq",
    label: "Groq",
    kind: "openai",
    base: "https://api.groq.com/openai/v1",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
    keyEnvs: [],
    signupUrl: "https://console.groq.com/keys",
    freeNote: "Velmi rychlé. Free plán bez karty, ale vyžaduje ověření telefonem. Limity jsou na model.",
    phoneRequired: true,
  },
  {
    id: "cerebras",
    label: "Cerebras",
    kind: "openai",
    base: "https://api.cerebras.ai/v1",
    models: ["llama-3.3-70b", "qwen-3-32b"],
    keyEnvs: [],
    signupUrl: "https://cloud.cerebras.ai",
    freeNote: "Free tier bez karty i telefonu. Limity na model.",
  },
  {
    id: "sambanova",
    label: "SambaNova Cloud",
    kind: "openai",
    base: "https://api.sambanova.ai/v1",
    models: ["Meta-Llama-3.3-70B-Instruct", "DeepSeek-V3.1"],
    keyEnvs: [],
    signupUrl: "https://cloud.sambanova.ai/apis",
    freeNote: "200 tisíc tokenů denně, 20 requestů za minutu. Bez karty i telefonu.",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai",
    base: "https://api.deepseek.com",
    models: ["deepseek-chat", "deepseek-flash"],
    keyEnvs: ["DEEPSEEK_API_KEY"],
    signupUrl: "https://platform.deepseek.com/api_keys",
    freeNote: "Nejlevnější placený tier - pár korun na vstupu. Bez trvalého bezplatného plánu.",
  },
];

export function findProvider(id: string | null | undefined): ProviderCfg | null {
  if (typeof id !== "string") return null;
  const wanted = id.trim().toLowerCase();
  return PROVIDERS.find((provider) => provider.id === wanted) ?? null;
}

/** Katalog pro klienta - bez adres a bez čehokoli, co by bylo tajemství. */
export function publicProviderList() {
  return PROVIDERS.map((provider) => ({
    id: provider.id,
    label: provider.label,
    signupUrl: provider.signupUrl,
    freeNote: provider.freeNote,
    phoneRequired: Boolean(provider.phoneRequired),
    fallbackModels: provider.models,
  }));
}

export type ProviderModel = { id: string; label: string };

/**
 * Načte modely poskytovatele přes jeho API. Klíč jde po jeho vlastní hlavičce
 * - Gemini do `x-goog-api-key`, ostatní do `Authorization: Bearer`.
 *
 * Když API neodpoví nebo je klíč špatný, vrací `null` místo vyhození: volající
 * pak ukáže záložní seznam a upozorní, že se seznam nepovedlo načíst. Je lepší
 * ukázat starý seznam modelů, než uživateli říkat, že klíč neplatí, když
 * provider jen vrací 500.
 */
export async function fetchProviderModels(
  provider: ProviderCfg,
  apiKey: string,
): Promise<{ models: ProviderModel[]; source: "live" | "fallback" } | null> {
  try {
    const url = provider.kind === "gemini"
      ? `${provider.base}/models?pageSize=200`
      : `${provider.base}/models`;
    const response = await fetch(url, {
      headers: provider.kind === "gemini"
        ? { "x-goog-api-key": apiKey }
        : { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    const raw: unknown[] = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
    const models: ProviderModel[] = [];
    for (const entry of raw as Array<Record<string, unknown>>) {
      if (provider.isFree && !provider.isFree(entry)) continue;
      const id = String(entry.id ?? entry.name ?? "").trim();
      if (!id) continue;
      // Gemini vrací "models/gemini-3.6-flash", volání chce "gemini-3.6-flash".
      const clean = id.startsWith("models/") ? id.slice("models/".length) : id;
      if (provider.kind === "gemini" && !clean.includes("generateContent") && !clean.includes("embed")) {
        models.push({ id: clean, label: clean });
      } else if (provider.kind !== "gemini") {
        models.push({ id: clean, label: clean });
      }
    }
    const unique = [...new Map(models.map((model) => [model.id, model])).values()].sort((a, b) =>
      a.id.localeCompare(b.id));
    if (unique.length === 0) return null;
    return { models: unique.slice(0, 200), source: "live" };
  } catch {
    return null;
  }
}

/** Bez API klíče vracíme záložní seznam, aby šlo vybrat providera před klíčem. */
export function fallbackModels(provider: ProviderCfg): ProviderModel[] {
  return provider.models.map((id) => ({ id, label: id }));
}

/** Poslední čtyři znaky - jediné, co se o klíči dozví klient. */
export function keyHint(apiKey: string): string {
  return apiKey.slice(-4);
}

export type ResolvedProvider = {
  provider: ProviderCfg;
  key: string;
  model: string;
  /** true = klíč si zadal uživatel, false = sdílený klíč projektu (účet Temney). */
  own: boolean;
};

/**
 * Poskytovatel pro daného uživatele.
 *
 * Účet Temney nemá v `sc_user_ai_settings` žádný řádek - jede na sdílených
 * serverových klíčích a tato funkce pro něj vrátí `null`. Ostatní si v
 * Nastavení providera a klíč vyberou a tady dostanou to, co si zadali.
 *
 * Klíč se čte service klientem z tabulky bez jediné client policy a nikdy se
 * neloguje ani nevrací do klienta.
 */
export async function resolveUserProvider(admin: any, userId: string): Promise<ResolvedProvider | null> {
  const { data, error } = await admin
    .from("sc_user_ai_settings")
    .select("provider, model, api_key")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  const provider = findProvider(data.provider);
  const key = typeof data.api_key === "string" ? data.api_key : "";
  if (!provider || !key) return null;
  const model = typeof data.model === "string" && data.model.trim()
    ? data.model.trim()
    : provider.models[0];
  return { provider, key, model, own: true };
}

/**
 * Poskytovatel pro uživatele, který si žádný vlastní klíč nezadal.
 * Vrátí prvního poskytovatele, jehož klíč je v prostředí - tedy sdílený klíč
 * projektu. Chování účtu Temney je přesně tohle a nesmí se měnit.
 */
export function resolveSharedProvider(keyEnvs: () => Record<string, string | undefined>): ResolvedProvider | null {
  for (const provider of PROVIDERS) {
    const key = provider.keyEnvs.map((entry) => keyEnvs()[entry]).find(Boolean);
    if (key) return { provider, key, model: provider.models[0], own: false };
  }
  return null;
}

/**
 * Jedno volání modelu v obou tvarech API.
 *
 * `gemini` bere systémovou instrukci zvlášť a vrací text z `candidates`,
 * `openai` ji posílá jako zprávu s rolí `system` a vrací
 * `choices[0].message.content`. Volající dostane v obou případech jen text, takže
 * je na něm nezáleží, který provider má uživatel.
 *
 * Vrací `null`, ne hází - volající chybu zformuluje sám, protože jednotlivé
 * funkce píšou uživateli různá slova.
 */
export async function completeText(
  resolved: ResolvedProvider,
  system: string,
  userText: string,
  generationConfig: Record<string, unknown> = {},
): Promise<string | null> {
  const { provider, key, model } = resolved;
  const response = provider.kind === "gemini"
    ? await fetch(`${provider.base}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: userText }] }],
        generationConfig,
      }),
      signal: AbortSignal.timeout(60_000),
    })
    : await fetch(`${provider.base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: system }, { role: "user", content: userText }],
        ...generationConfig,
      }),
      signal: AbortSignal.timeout(60_000),
    });

  if (!response.ok) return null;
  const payload = await response.json().catch(() => null);
  if (provider.kind === "gemini") {
    const parts = payload?.candidates?.[0]?.content?.parts;
    return Array.isArray(parts) ? parts.map((part: { text?: unknown }) => typeof part.text === "string" ? part.text : "").join("\n").trim() : null;
  }
  const content = payload?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content.trim() : null;
}