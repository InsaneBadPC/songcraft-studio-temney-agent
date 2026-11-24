import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const external = readFileSync("lib/external-studio.ts", "utf8");
const trpc = readFileSync("lib/trpc.ts", "utf8");

const functionBlock = (name: string) => {
  const match = external.match(new RegExp(`export async function ${name}[\\s\\S]*?\\n}\\n`, "m"));
  expect(match, `missing function ${name}`).not.toBeNull();
  return match![0];
};

describe("archivace textu", () => {
  it("omezuje mutace na user_id a nastavuje archived/draft", () => {
    const archive = functionBlock("archiveExternalDocument");
    const restore = functionBlock("restoreExternalDocument");

    expect(archive).toContain('eq("user_id", user.id)');
    expect(archive).toContain('status: "archived"');
    expect(restore).toContain('eq("user_id", user.id)');
    expect(restore).toContain('status: "draft"');

    expect(external.toLowerCase()).not.toContain("delete from");
  });

  it("vystavuje mutace v trpc klientovi", () => {
    expect(trpc).toContain("archiveDocument: { useMutation");
    expect(trpc).toContain("restoreDocument: { useMutation");
  });
});
