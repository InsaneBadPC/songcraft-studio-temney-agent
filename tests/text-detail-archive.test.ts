import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const editor = readFileSync("app/text/[id].tsx", "utf8");
const workspace = readFileSync("components/writing-workspace.tsx", "utf8");

describe("detail rozpracovaného textu", () => {
  it("má Archivovat jen pro draft a Obnovit pro archived", () => {
    expect(editor).toContain("archiveDocument.useMutation()");
    expect(editor).toContain("restoreDocument.useMutation()");
    expect(editor).toContain('document?.status === "draft"');
    expect(editor).toContain('document?.status === "archived"');
    expect(editor).toContain("Archivovat");
    expect(editor).toContain("Obnovit do rozpracovaných");
  });

  it("po archivaci/obnovení maže lokální draft a invaliduje snapshot", () => {
    expect(editor).toContain("clearDraft(id ?? null, userId, \"text\")");
    expect(editor).toContain("utils.studio.snapshot.invalidate()");
  });

  it("workspace správně popisuje archiv", () => {
    expect(workspace).toContain("Archivovaný text");
  });

  it("oba přepínače stavu mají potvrzení a archiv nejde dokončit", () => {
    expect(editor).toContain('Alert.alert("Archivovat text?"');
    expect(editor).toContain('Alert.alert("Obnovit text?"');
    expect(workspace).toContain('status !== "archived"');
  });
});
