import { describe, expect, it } from "vitest";
import { normalizeDocumentStatus } from "../lib/document-status";

describe("normalizace stavu textu", () => {
  it("zachová archived", () => expect(normalizeDocumentStatus("archived")).toBe("archived"));
  it("zachová complete a draft", () => {
    expect(normalizeDocumentStatus("complete")).toBe("complete");
    expect(normalizeDocumentStatus("draft")).toBe("draft");
  });
  it("neznámý stav považuje za draft", () => expect(normalizeDocumentStatus("something-else")).toBe("draft"));
});
