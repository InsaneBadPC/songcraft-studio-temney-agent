export const ASSISTANT_VOICE_LANG = "cs-CZ";
export const ASSISTANT_VOICE_AUTOPLAY_KEY = "assistant_voice_autoplay";
export const MAX_SPOKEN_CHARS = 2000;

/** Sjednotí přepis z rozpoznávání řeči do jednoho čistého řádku. */
export function normalizeVoiceTranscript(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Připraví text odpovědi pro TTS: pryč s markdownem, kódem a odkazy,
 * které by se četly nesmyslně. Dlouhé odpovědi zkrátí na čitelnou délku.
 */
export function speechTextFromAnswer(value: string): string {
  const withoutCodeBlocks = value.replace(/```[\s\S]*?```/g, " ");
  const withoutInlineCode = withoutCodeBlocks.replace(/`([^`]*)`/g, "$1");
  const withoutLinks = withoutInlineCode.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  const withoutUrls = withoutLinks.replace(/https?:\/\/\S+/g, " ");
  const withoutMarkup = withoutUrls
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/[*_~>#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (withoutMarkup.length <= MAX_SPOKEN_CHARS) return withoutMarkup;
  const clipped = withoutMarkup.slice(0, MAX_SPOKEN_CHARS);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > MAX_SPOKEN_CHARS * 0.6 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}

/** Česká hláška pro chybu rozpoznávání. `null` znamená, že se nemá nic hlásit. */
export function voiceErrorMessage(code: string): string | null {
  switch (code) {
    case "aborted":
      return null;
    case "no-speech":
      return "Nic jsem neslyšel. Zkus to znovu.";
    case "speech-timeout":
      return "Mikrofon nezachytil řeč. Zkus to znovu.";
    case "not-allowed":
      return "Povol prosím mikrofon a rozpoznávání řeči v nastavení.";
    case "service-not-allowed":
      return "Rozpoznávání řeči není na tomto zařízení dostupné.";
    case "language-not-supported":
      return "Čeština není pro rozpoznávání řeči nainstalovaná.";
    case "network":
      return "Rozpoznávání řeči potřebuje připojení k internetu.";
    case "audio-capture":
      return "Mikrofon se nepodařilo otevřít.";
    case "busy":
      return "Rozpoznávání je zaneprázdněné. Zkus to za chvíli.";
    default:
      return "Hlasový vstup se nepodařil. Zkus to znovu.";
  }
}
