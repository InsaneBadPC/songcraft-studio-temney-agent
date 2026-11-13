import { describe, expect, it } from "vitest";

import {
  MAX_SPOKEN_CHARS,
  normalizeVoiceTranscript,
  speechTextFromAnswer,
  voiceErrorMessage,
} from "../lib/assistant-voice";

describe("hlasový asistent", () => {
  it("sjednotí přepis řeči do jednoho řádku", () => {
    expect(normalizeVoiceTranscript("  Navrhni\n mi   refrén  ")).toBe("Navrhni mi refrén");
  });

  it("odstraní z odpovědi markdown, kód a odkazy", () => {
    const answer = "## Návrh\n\n- **Refrén:** `lásko má`\n- Detail: [odkaz](https://example.com)\n\n```text\nignoruj mě\n```";
    expect(speechTextFromAnswer(answer)).toBe("Návrh Refrén: lásko má Detail: odkaz");
  });

  it("zkrátí příliš dlouhou odpověď na čitelnou délku", () => {
    const spoken = speechTextFromAnswer(`${"slovo ".repeat(600)}konec`);
    expect(spoken.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS + 1);
    expect(spoken.endsWith("…")).toBe(true);
  });

  it("přeloží chyby rozpoznávání do češtiny", () => {
    expect(voiceErrorMessage("no-speech")).toContain("Nic jsem neslyšel");
    expect(voiceErrorMessage("not-allowed")).toContain("Povol");
    expect(voiceErrorMessage("aborted")).toBeNull();
  });
});
