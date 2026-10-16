import { supabase } from "@/lib/supabase";

/**
 * Klient vlastního AI poskytovatele.
 *
 * Klíč se posílá jen jednou - při uložení. Odtud se už nikdy nevrací: funkce
 * odpovídá jen `hasKey` a `keyHint` (poslední čtyři znaky). Bez toho by klíč
 * putoval do telefonu, do záloh zařízení a při jakémkoliv logování i do souborů.
 */

export type AiProvider = {
  id: string;
  label: string;
  signupUrl: string;
  freeNote: string;
  phoneRequired: boolean;
  fallbackModels: string[];
};

export type AiSettings = {
  /** true = účet jede na sdíleném klíči projektu, sekce se v UI skryje. */
  sharedOnly: boolean;
  provider: string | null;
  model: string | null;
  hasKey: boolean;
  keyHint: string | null;
  keyVerifiedAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
};

export type AiModel = { id: string; label: string };

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("songcraft-ai-settings", { body });
  if (error) throw new Error(error.message ?? "Nastavení AI neodpovědělo.");
  const payload = data as { error?: string } & T;
  if (payload?.error) throw new Error(payload.error);
  return payload;
}

export function getAiSettings() {
  return call<{ settings: AiSettings; providers: AiProvider[] }>({ action: "get_settings" });
}

export function saveAiKey(provider: string, apiKey: string, model?: string) {
  return call<{ settings: AiSettings; models: AiModel[]; message: string }>({
    action: "save_key",
    provider,
    apiKey,
    ...(model ? { model } : {}),
  });
}

export function saveAiModelChoice(model: string) {
  return call<{ settings: AiSettings; message: string }>({ action: "set_model", model });
}

export function listAiModels(provider: string) {
  return call<{ provider: string; models: AiModel[]; source: "live" | "fallback"; message: string }>({
    action: "list_models",
    provider,
  });
}

export function clearAiKey() {
  return call<{ settings: AiSettings; message: string }>({ action: "clear_key" });
}