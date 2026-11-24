import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("supabase/migrations/20261124010000_studio_snapshot_videos_publications.sql", "utf8");
const client = readFileSync("lib/external-studio.ts", "utf8");

describe("snapshot videí a publikací", () => {
  it("vrací data jen přihlášenému uživateli", () => {
    expect(migration).toContain("create or replace function public.sc_studio_snapshot");
    const videosBlock = migration.match(/'videos',[\s\S]*?'publications'/)?.[0] ?? "";
    const publicationsBlock = migration.match(/'publications',[\s\S]*?end;\s*\$\$/)?.[0] ?? "";
    expect(videosBlock).toContain("from public.agent_videos");
    expect(videosBlock).toContain("where user_id = v_user");
    expect(publicationsBlock).toContain("from public.youtube_publications");
    expect(publicationsBlock).toContain("where user_id = v_user");
  });
  it("obsahuje videos a publications", () => {
    expect(migration).toContain("'videos'");
    expect(migration).toContain("'publications'");
    expect(client).toContain("export type StudioVideo");
    expect(client).toContain("export type StudioPublication");
    expect(client).toContain("videos: (payload.videos ?? []).map(videoFromRow)");
    expect(client).toContain("publications: (payload.publications ?? []).map(publicationFromRow)");
  });
});
