import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { isAllowedPrivateUser, privateAccessMessage } from "../_shared/access.ts";
import {
  fallbackModels, fetchProviderModels, findProvider, keyHint, publicProviderList,
} from "../_shared/llm-providers.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });

/**
 * Vlastní AI poskytovatel a API klíč uživatele.
 *
 * Rozdíl proti `songcraft-service-console`: tady jde o data JEDNOHO uživatele a
 * klíč PATŘÍ TOMU UŽIVATELI. Služební účet tady nemá nic co dělat - Temney jede
 * na sdílených serverových klíčích a tato tabulka pro něj zůstává prázdná, takže
 * resolver v agent-orchestratoru spadne na `keyEnvs` a chová se stejně jako dnes.
 *
 * KLÍČ NIKDY NEOPUŠTÍ SERVER
 *
 * - uloží se do `sc_user_ai_settings` (RLS zapnutá, žádná client policy)
 * - klient dostane jen `hasKey` a `keyHint` (poslední čtyři znaky)
 * - klíč se nikdy neloguje ani nevrací v chybové zprávě
 * - `list_models` posílá klíč poskytovateli přímo odsud, ne přes klienta
 *
 * `save_key` klíč nejdřív ověří proti API poskytovatele. Uložit nedělaný klíč
 * znamená, že uživatel uvidí "hotovo" a AI mu pak v aplikaci selhává až při
 * psaní textu, což se hledá velmi špatně.
 */

const ACTIONS = ["get_settings", "save_key", "set_model", "list_models", "clear_key"] as const;
type Action = (typeof ACTIONS)[number];

function cleanKey(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/^["']|["']$/g, "");
}

/** Kontrola formátu podle poskytovatele - ať se chyba dozví dřív než u pokusu. */
function validateKeyShape(providerId: string, key: string): string | null {
  if (key.length < 8 || key.length > 400) return "Klíč má mít 8 až 400 znaků.";
  if (providerId === "gemini" && !key.startsWith("AIza")) return "Klíč z Google AI Studio začíná na AIza.";
  if (providerId === "openrouter" && !key.startsWith("sk-or-")) {
    return "Klíč z OpenRouter začíná na sk-or-.";
  }
  if (providerId === "groq" && !key.startsWith("gsk_")) return "Klíč z Groq začíná na gsk_.";
  if (providerId === "cerebras" && !key.startsWith("csk-")) return "Klíč z Cerebras začíná na csk-.";
  return null;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json({ error: `Nepovolená metoda ${request.method}, použij POST.` }, 405);

  const authorization = request.headers.get("Authorization");
  const url = Deno.env.get("SUPABASE_URL") || Deno.env.get("SONGCRAFT_SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SONGCRAFT_SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SONGCRAFT_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return json({ error: "Chybí konfigurace serveru." }, 503);
  if (!authorization) return json({ error: "Chybí přihlášení." }, 401);

  const auth = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: authError } = await auth.auth.getUser();
  if (authError || !user) return json({ error: "Neplatné přihlášení." }, 401);
  if (!isAllowedPrivateUser(user, { allowedUserIds: Deno.env.get("SONGCRAFT_ALLOWED_USER_IDS") ?? undefined, allowedEmails: Deno.env.get("SONGCRAFT_ALLOWED_EMAILS") ?? undefined })) {
    return json({ error: privateAccessMessage() }, 403);
  }

  const input = await request.json().catch(() => null) as Record<string, unknown> | null;
  const action = input?.action;
  if (typeof action !== "string" || !ACTIONS.includes(action as Action)) {
    return json({ error: `Neznámá akce. Povolené jsou: ${ACTIONS.join(", ")}.` }, 400);
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const audit = async (actionType: string, result: "pending" | "success" | "error", payload: Record<string, unknown>, errorMessage?: string) => {
    // Klíč se do auditu nikdy nepropírá - payload je volaný ručně a neobsahuje ho.
    await admin.from("agent_action_log").insert({
      user_id: user.id,
      action_type: actionType,
      payload,
      result,
      error_message: errorMessage ? errorMessage.slice(0, 500) : null,
    });
  };

  const readSettings = async () => {
    const { data, error } = await admin
      .from("sc_user_ai_settings")
      .select("provider,model,key_hint,key_verified_at,last_error,updated_at")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) throw new Error("Nastavení poskytovatele se nepodařilo načíst.");
    return data;
  };

  // Účet Temney jede na sdílených serverových klíčích a tato sekce v aplikaci
  // vůbec nepotřebuje. Server to ví ze stejné tabulky, kterou používá servisní
  // konzole - klient si to jen řekne, takže se nemusí ptát ještě na jinou.
  const isServiceAccount = async () => {
    const { data } = await admin.from("sc_service_accounts").select("user_id").eq("user_id", user.id).maybeSingle();
    return Boolean(data);
  };

  const clientSettings = (row: Record<string, unknown> | null, sharedOnly = false) => ({
    sharedOnly,
    provider: row?.provider ?? null,
    model: row?.model ?? null,
    hasKey: Boolean(row),
    keyHint: row?.key_hint ?? null,
    keyVerifiedAt: row?.key_verified_at ?? null,
    lastError: row?.last_error ?? null,
    updatedAt: row?.updated_at ?? null,
  });

  // ------------------------------------------------------------ get_settings
  if (action === "get_settings") {
    const row = await readSettings();
    return json({
      settings: clientSettings(row, !row && await isServiceAccount()),
      providers: publicProviderList(),
    });
  }

  // --------------------------------------------------------------- list_models
  if (action === "list_models") {
    const wanted = typeof input?.provider === "string" ? input.provider : "";
    const provider = findProvider(wanted);
    if (!provider) return json({ error: "Neznámý poskytovatel." }, 400);

    const row = await readSettings();
    const live = row?.provider === provider.id ? String((await admin
      .from("sc_user_ai_settings")
      .select("api_key")
      .eq("user_id", user.id)
      .maybeSingle()).data?.api_key ?? "") : "";

    // Klíč posíláme poskytovateli odsud, ne přes telefon.
    const live_result = live ? await fetchProviderModels(provider, live) : null;
    if (live_result) {
      return json({
        provider: provider.id,
        models: live_result.models,
        source: live_result.source,
        message: live_result.source === "live"
          ? `${live_result.models.length} free modelů načteno přímo od poskytovatele.`
          : "",
      });
    }
    return json({
      provider: provider.id,
      models: fallbackModels(provider),
      source: "fallback",
      message: live
        ? "Poskytovatel neodpověděl na seznam modelů. Zobrazuji záložní seznam."
        : "Zatím nemáš uložený klíč - zobrazuji záložní seznam. Po vložení klíče se načte skutečný.",
    });
  }

  // ----------------------------------------------------------------- save_key
  if (action === "save_key") {
    const providerId = typeof input?.provider === "string" ? input.provider.trim().toLowerCase() : "";
    const provider = findProvider(providerId);
    if (!provider) return json({ error: "Neznámý poskytovatel." }, 400);
    const apiKey = cleanKey(input?.apiKey);
    const shapeError = validateKeyShape(provider.id, apiKey);
    if (shapeError) {
      await audit("ai:save_key", "error", { provider: provider.id }, shapeError);
      return json({ error: shapeError }, 400);
    }

    if (!await (async () => {
      await admin.from("agent_action_log").insert({
        user_id: user.id,
        action_type: "ai:save_key",
        payload: { provider: provider.id },
        result: "pending",
      });
      return true;
    })()) return json({ error: "Zápis auditu selhal, klíč nebyl uložen." }, 500);

    // Ověření proti API poskytovatele PŘED uložením.
    const models = await fetchProviderModels(provider, apiKey);
    if (!models) {
      await audit("ai:save_key", "error", { provider: provider.id }, "poskytovatel nepřijal klíč");
      return json({
        error: `${provider.label} klíč nepřijal. Zkontroluj, že je správně zkopírovaný a že má přístup k API.`,
      }, 422);
    }

    const model = typeof input?.model === "string" && input.model.trim()
      ? input.model.trim().slice(0, 160)
      : models.models[0]?.id ?? null;

    const { error } = await admin.from("sc_user_ai_settings").upsert({
      user_id: user.id,
      provider: provider.id,
      model,
      api_key: apiKey,
      key_hint: keyHint(apiKey),
      key_verified_at: new Date().toISOString(),
      last_error: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    if (error) {
      await audit("ai:save_key", "error", { provider: provider.id }, error.message);
      return json({ error: "Klíč se nepodařilo uložit." }, 502);
    }

    await audit("ai:save_key", "success", { provider: provider.id, model, models: models.models.length });
    return json({
      settings: clientSettings(await readSettings()),
      models: models.models,
      message: `${provider.label}: uloženo, načteno ${models.models.length} free modelů.`,
    });
  }

  // ---------------------------------------------------------------- set_model
  // Změna modelu NESMÍ jít přes save_key: tam se klíč validuje podle délky a
  // prázdný by spadl. Klíč se při tom nemění, takže se ani nečte.
  if (action === "set_model") {
    const model = typeof input?.model === "string" ? input.model.trim().slice(0, 160) : "";
    if (!model) return json({ error: "Vyber model ze seznamu." }, 400);
    const { data: row, error: readError } = await admin
      .from("sc_user_ai_settings")
      .select("provider, user_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (readError || !row) return json({ error: "Nejdřív ulož klíč poskytovatele." }, 409);
    const provider = findProvider(row.provider);
    if (!provider) return json({ error: "Uložený poskytovatel neznáme." }, 409);
    const { error } = await admin.from("sc_user_ai_settings")
      .update({ model, updated_at: new Date().toISOString() })
      .eq("user_id", user.id);
    if (error) return json({ error: "Model se nepodařilo uložit." }, 502);
    await audit("ai:set_model", "success", { provider: provider.id, model });
    return json({ settings: clientSettings(await readSettings()), message: `Model nastaven: ${model}` });
  }

  // --------------------------------------------------------------- clear_key
  if (action === "clear_key") {
    if (!await (async () => {
      await admin.from("agent_action_log").insert({
        user_id: user.id,
        action_type: "ai:clear_key",
        payload: {},
        result: "pending",
      });
      return true;
    })()) return json({ error: "Zápis auditu selhal, klíč nebyl smazán." }, 500);

    const { error } = await admin.from("sc_user_ai_settings").delete().eq("user_id", user.id);
    if (error) {
      await audit("ai:clear_key", "error", {}, error.message);
      return json({ error: "Klíč se nepodařilo smazat." }, 502);
    }
    await audit("ai:clear_key", "success", {});
    return json({ settings: clientSettings(null), message: "Klíč je smazaný. Použije se sdílený klíč projektu." });
  }

  return json({ error: "Neznámá akce." }, 400);
});