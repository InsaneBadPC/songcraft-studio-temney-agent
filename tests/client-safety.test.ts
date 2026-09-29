import { describe, expect, it } from "vitest";

import { assistantConversationTitle, upsertAssistantConversation, type AssistantConversation, type AssistantHistoryMessage } from "../lib/assistant-history";
import { normalizeOptionalId } from "../lib/client-input";
import { shouldRestoreDraft } from "../lib/draft-policy";
import { draftKey, isLegacyDraftKey, isUserDraftKey } from "../lib/draft-storage-key";
import { studioSnapshotQueryKey } from "../lib/query-keys";
import { firstQueryParam } from "../lib/query-params";

const message = (id: string, role: "user" | "assistant", content: string): AssistantHistoryMessage => ({ id, role, content });

describe("klientská bezpečnost a deterministicita", () => {
  it("oddělí snapshot cache jednotlivých uživatelů", () => {
    expect(studioSnapshotQueryKey("user-a")).toEqual(["songcraft", "supabase", "snapshot", "user-a"]);
    expect(studioSnapshotQueryKey("user-a")).not.toEqual(studioSnapshotQueryKey("user-b"));
  });

  it("použije uživatelský namespace pro nový i existující draft", () => {
    const key = draftKey("user/a", "document-1");
    expect(key).toBe("songcraft-draft-user%2Fa:text:document-1");
    expect(isUserDraftKey(key, "user/a")).toBe(true);
    expect(isUserDraftKey(key, "user-b")).toBe(false);
    expect(isLegacyDraftKey(key)).toBe(false);
    expect(draftKey("user/a", null, "song")).not.toBe(draftKey("user/a", null, "text"));
    expect(isLegacyDraftKey("songcraft-draft-document-1")).toBe(true);
  });

  it("obnoví jen draft, který je novější než server", () => {
    expect(shouldRestoreDraft(null, 100)).toBe(true);
    expect(shouldRestoreDraft(99, 100)).toBe(true);
    expect(shouldRestoreDraft(100, 100)).toBe(false);
    expect(shouldRestoreDraft(101, 100)).toBe(false);
  });

  it("načte album parametr i při opakované hodnotě", () => {
    expect(firstQueryParam("album-1")).toBe("album-1");
    expect(firstQueryParam(["album-2", "album-3"])).toBe("album-2");
    expect(firstQueryParam("  ")).toBeNull();
  });

  it("zachová null albumId jako explicitní odebrání z alba", () => {
    expect(normalizeOptionalId(null)).toBeNull();
    expect(normalizeOptionalId(undefined)).toBeUndefined();
    expect(normalizeOptionalId(42)).toBe("42");
  });

  it("neopakuje persistence, když se konverzace nezměnila", () => {
    const messages = [message("u-1", "user", "Nápad")];
    const first = upsertAssistantConversation([], null, messages, 100);
    expect(first.changed).toBe(true);
    expect(assistantConversationTitle(messages)).toBe("Nápad");

    const second = upsertAssistantConversation(first.conversations, first.id, messages, 200);
    expect(second.changed).toBe(false);
    expect(second.conversations).toBe(first.conversations);

    const empty = upsertAssistantConversation(first.conversations, null, [], 300);
    expect(empty.changed).toBe(false);
    expect(empty.conversations).toBe(first.conversations);
  });

  it("nevytváří prázdnou konverzaci při novém startu", () => {
    const existing: AssistantConversation = { id: "conv-1", title: "Stará", messages: [message("u-1", "user", "A")], createdAt: 1, updatedAt: 1 };
    const result = upsertAssistantConversation([existing], null, [], 2);
    expect(result.id).toBeNull();
    expect(result.conversations).toEqual([existing]);
  });
});
