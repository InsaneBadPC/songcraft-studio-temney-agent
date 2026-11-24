import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("supabase/migrations/20261124000000_lyric_archived_status.sql", "utf8");

describe("migrace archivu textů", () => {
  it("rozšiřuje CHECK constraint na archived", () => {
    expect(migration).toContain("sc_lyrics_status_check");
    expect(migration).toContain("'archived'");
    expect(migration).toContain("'draft'");
    expect(migration).toContain("'complete'");
  });

  it("nic nemaže", () => {
    expect(migration.toLowerCase()).not.toContain("delete from");
    expect(migration.toLowerCase()).not.toContain("truncate");
    expect(migration.toLowerCase()).not.toContain("drop table");
  });
});
