# Texty archiv + Shorts v knihovně Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Umožnit archivaci rozpracovaných textů bez ztráty dat, zobrazit celé názvy v seznamu Textů a v Knihovně odvozovat modrý/zelený stav Shorts se všemi publikovanými odkazy.

**Architecture:** Archiv je nový stav `sc_lyrics.status='archived'`; `Texty` mají filtr `Rozpracované / Archivováno` a detail má `Archivovat` / `Obnovit`. Shorts se neoznačuje ručně — rozšířený `sc_studio_snapshot` vrací `agent_videos` a `youtube_publications`, z kterých čistý helper odvozuje stav a seznam odkazů. Aplikace používá přímý Supabase klient v `lib/external-studio.ts`, ne legacy Drizzle/TRPC.

**Tech Stack:** Expo/React Native + TypeScript, TanStack Query, Supabase RPC, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-24-texty-archiv-knihovna-shorts-design.md`

## Global Constraints

- Pracovat pouze v `~/temney-agent` a pouze s projektem `eqgoedaydvwsuqgakpos`.
- Žádné cizí Supabase projekty, žádný SCS2, žádné Kilo konverzace jako zdroj.
- Nikdy nedělat `delete`, `truncate`, `drop`; archivace znamená změnu stavu, ne mazání.
- Každá DB mutace musí být vázaná na přihlášeného uživatele (`auth.uid()` / `user.id`).
- Neměnit Google Docs import, publish pipeline, VM ani YouTube publikace.
- Necommitovat bez výslovného požadavku uživatele.
- V Termuxu použít `node node_modules/typescript/bin/tsc --noEmit`; Vitest s `ESBUILD_BINARY_PATH=...` a `--pool=threads --maxWorkers=1 --minWorkers=1`.
- Web export v Termuxu: `CI=true EXPO_NO_TELEMETRY=1 bun node_modules/expo/bin/cli export --platform web --max-workers 1`.

## Review Focus

- **Cizí uživatel:** archivace/obnovení ani snapshot nesmí číst ani měnit cizí řádky — test v Task 2 kontroluje `eq("user_id", user.id)` a test v Task 5 kontroluje `where user_id = v_user` v RPC.
- **Archiv spadne zpět na draft:** `documentFromRow` musí zachovat `archived` — test v Task 2 volá `normalizeDocumentStatus("archived")`.
- **Legacy Shorts bez `aspect`:** musí se poznat podle `#shorts` nebo `Official Short` v názvu/tazích — test v Task 6.
- **Více publikací:** detail musí zobrazit všechna videa, ne jen `publishedVideoId` — test v Task 6 a Task 8.
- **Dlouhý název v Textech:** název nesmí mít `numberOfLines={2}` — test v Task 3.
- **Žádné mazání:** migrace ani UI nesmí obsahovat `delete from public.sc_lyrics` — test v Task 1.

---

### Task 1: Databázový stav `archived`

**Files:**
- Create: `supabase/migrations/20261124000000_lyric_archived_status.sql`
- Test: `tests/lyric-archive-migration.test.ts`

**Interfaces:**
- Produces: `sc_lyrics.status` přijímá `draft | complete | archived`; constraint `sc_lyrics_status_check` existuje.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `ESBUILD_BINARY_PATH=/data/data/com.termux/files/usr/tmp/opencode/esbuild-0.21.5/package/bin/esbuild node node_modules/vitest/vitest.mjs run tests/lyric-archive-migration.test.ts --pool=threads --maxWorkers=1 --minWorkers=1`
Expected: FAIL — migration file does not exist.

- [ ] **Step 3: Implement the migration**

Create the file with two statements: `alter table public.sc_lyrics drop constraint if exists sc_lyrics_status_check;` then `alter table public.sc_lyrics add constraint sc_lyrics_status_check check (status in ('draft','complete','archived'));`. Do not touch any other table or data.

- [ ] **Step 4: Run test to verify it passes**

Run the same Vitest command.
Expected: PASS.

- [ ] **Step 5: Apply and verify the migration on `eqgoedaydvwsuqgakpos`**

Use the existing Management API helper in `/data/data/com.termux/files/usr/tmp/opencode/temney-audit/db.mjs` with `database/query`, then query `pg_constraint` for `sc_lyrics_status_check`.
Expected: definition contains `draft`, `complete`, `archived`; no rows changed.

---

### Task 2: Archive mutations and status mapping

**Files:**
- Create: `lib/document-status.ts`
- Modify: `lib/external-studio.ts:21-35` (type), `:123` (`documentFromRow`), near `:510-513` (mutations)
- Modify: `lib/trpc.ts:10` (imports), `:99` (studio mutations)
- Test: `tests/document-status.test.ts`
- Test: `tests/archive-mutations.test.ts`

**Interfaces:**
- Consumes: `sc_lyrics.status` includes `archived` from Task 1.
- Produces: `normalizeDocumentStatus(value): "draft" | "complete" | "archived"`; `archiveExternalDocument(id: string): Promise<void>`; `restoreExternalDocument(id: string): Promise<void>`; `trpc.studio.archiveDocument` and `trpc.studio.restoreDocument` mutations taking `{ id: string | number }`.

- [ ] **Step 1: Write failing pure test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run the Vitest command for `tests/document-status.test.ts`.
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `normalizeDocumentStatus` and wire it into `documentFromRow`**

Create `lib/document-status.ts` with the exact signature and a three-value whitelist. Replace the inline ternary in `lib/external-studio.ts:123` with `normalizeDocumentStatus(row.status)`. Add `"archived"` to `StudioDocument.status`.

- [ ] **Step 4: Run pure test**

Run the same command.
Expected: PASS.

- [ ] **Step 5: Write failing mutation wiring test**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const external = readFileSync("lib/external-studio.ts", "utf8");
const trpc = readFileSync("lib/trpc.ts", "utf8");

describe("archivace textu", () => {
  it("omezuje mutace na user_id a nastavuje archived/draft", () => {
    for (const name of ["archiveExternalDocument", "restoreExternalDocument"]) {
      expect(external).toContain(`export async function ${name}`);
      expect(external).toContain('eq("user_id", user.id)');
    }
    expect(external).toContain("status: \"archived\"");
    expect(external).toContain("status: \"draft\"");
    expect(external.toLowerCase()).not.toContain("delete from");
  });

  it("vystavuje mutace v trpc klientovi", () => {
    expect(trpc).toContain("archiveDocument: { useMutation");
    expect(trpc).toContain("restoreDocument: { useMutation");
  });
});
```

- [ ] **Step 6: Run mutation test to verify it fails**

Run the Vitest command for `tests/archive-mutations.test.ts`.
Expected: FAIL — functions missing.

- [ ] **Step 7: Implement archive/restore mutations**

In `lib/external-studio.ts`, add both functions using `owner()`, `supabase.from("sc_lyrics").update({ status: ... }).eq("id", id).eq("user_id", user.id).select("id").single()`, and reuse `assert`. In `lib/trpc.ts`, import both and add the two mutations beside `completeDocument`, both accepting `{ id }: { id: string | number }`.

- [ ] **Step 8: Run mutation test**

Run the same command.
Expected: PASS.

---

### Task 3: Texty list filter and full titles

**Files:**
- Modify: `app/(tabs)/texts.tsx:34-38`, `:60-70`, `:82`, `:94`, `:126-127`
- Modify: `components/studio-ui.tsx:356-368`
- Test: `tests/texts-list.test.ts`

**Interfaces:**
- Consumes: `StudioDocument.status` includes `archived` from Task 2.
- Produces: default list shows only `draft`; `Archivováno` filter shows only `archived`.

- [ ] **Step 1: Write failing source test**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const texts = readFileSync("app/(tabs)/texts.tsx", "utf8");
const ui = readFileSync("components/studio-ui.tsx", "utf8");

describe("seznam Textů", () => {
  it("má filtr Rozpracované / Archivováno", () => {
    expect(texts).toContain("Rozpracované");
    expect(texts).toContain("Archivováno");
    expect(texts).toContain('d.status === "archived"');
  });

  it("neořezává název položky", () => {
    expect(texts).not.toMatch(/<Text[^>]*numberOfLines=\{2\}[^>]*style=\{[^}]*styles\.name/);
    expect(texts).toContain("styles.name");
  });

  it("zná archivovaný stav v StatusChip", () => {
    expect(ui).toContain('state: "draft" | "complete" | "cloud" | "archived"');
    expect(ui).toContain("ARCHIVOVÁNO");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run the Vitest command for `tests/texts-list.test.ts`.
Expected: FAIL.

- [ ] **Step 3: Implement the list changes**

Add `const [statusFilter, setStatusFilter] = useState<"draft" | "archived">("draft")`. Derive `documents` filtered by `statusFilter`, then apply album/search filters. Add a `View` with two `FilterChip`s above the count row. Remove `numberOfLines={2}` from the name `Text`, keep `StatusChip` in its own element, and set `name` style to include `minWidth: 0`. Change the empty state text depending on `statusFilter`. Add `archived` to `StatusChip` with `colors.muted` and label `ARCHIVOVÁNO`.

- [ ] **Step 4: Run test**

Run the same command.
Expected: PASS.

---

### Task 4: Text detail archive / restore actions

**Files:**
- Modify: `app/text/[id].tsx:33-38`, `:140-148`, `:189-201`
- Modify: `components/writing-workspace.tsx:184`
- Test: `tests/text-detail-archive.test.ts`

**Interfaces:**
- Consumes: `trpc.studio.archiveDocument` / `restoreDocument` from Task 2.
- Produces: archive and restore actions available from the text detail.

- [ ] **Step 1: Write failing source test**

```ts
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run the Vitest command for `tests/text-detail-archive.test.ts`.
Expected: FAIL.

- [ ] **Step 3: Implement the detail actions**

Add `archive` and `restore` mutations from `trpc.studio`. Implement `changeStatus(next: "archived" | "draft")` that saves via `save()` when needed, calls the matching mutation, clears the local draft, invalidates the snapshot, and navigates to `/(tabs)/texts`. Add the two buttons with `Alert.alert` confirmation. Keep `Označit jako hotové` only for `status !== "archived"`. In `writing-workspace.tsx`, add the archived status label.

- [ ] **Step 4: Run test**

Run the same command.
Expected: PASS.

---

### Task 5: Snapshot rozšíření o videa a publikace

**Files:**
- Create: `supabase/migrations/20261124010000_studio_snapshot_videos_publications.sql`
- Modify: `lib/external-studio.ts:37-58` (types), `:89` (`StudioSnapshot`), `:149-157` (payload), `:184-192` (return)
- Test: `tests/studio-snapshot-videos.test.ts`

**Interfaces:**
- Consumes: existing `sc_studio_snapshot(p_user_id uuid)` from `20261117000000_media_registry_snapshot_rpc.sql:196-262`.
- Produces: `StudioVideo = { id, userId, songId, aspect, renderStatus, type, mode, createdAt }`; `StudioPublication = { id, userId, songId, videoId, youtubeVideoId, status, title, tags: string[], publishedAt, privacyStatus }`; snapshot exposes `videos` and `publications`.

- [ ] **Step 1: Write failing test**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("supabase/migrations/20261124010000_studio_snapshot_videos_publications.sql", "utf8");
const client = readFileSync("lib/external-studio.ts", "utf8");

describe("snapshot videí a publikací", () => {
  it("vrací data jen přihlášenému uživateli", () => {
    expect(migration).toContain("create or replace function public.sc_studio_snapshot");
    expect(migration.match(/where user_id = v_user/g)?.length).toBeGreaterThanOrEqual(2);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run the Vitest command for `tests/studio-snapshot-videos.test.ts`.
Expected: FAIL.

- [ ] **Step 3: Implement the migration**

Use `create or replace function public.sc_studio_snapshot(p_user_id uuid default auth.uid())` with the same `returns jsonb`, `stable`, `security definer`, `set search_path = public` and existing keys. Add two `jsonb_build_object` keys:
- `'videos'`: `select id, user_id, song_id, aspect, render_status, type, mode, created_at from public.agent_videos where user_id = v_user order by created_at desc`
- `'publications'`: `select id, user_id, video_id, song_id, youtube_video_id, status, title, tags, published_at, privacy_status from public.youtube_publications where user_id = v_user order by published_at desc nulls last`
Never edit the old migration file.

- [ ] **Step 4: Apply and inspect the RPC**

Apply via Management API `database/query`, then call the RPC for Temney via PostgREST with the Management API auth token only in the shell environment (never print it).
Expected: response contains `videos` and `publications` arrays; no other user IDs appear.

- [ ] **Step 5: Implement client mapping**

Add `videoFromRow` and `publicationFromRow` in `lib/external-studio.ts`, add both types to `StudioSnapshot`, add both to the payload cast and return object. `publicationFromRow` must normalize `tags` to `string[]` (fallback `[]`).

- [ ] **Step 6: Run test**

Run the same command.
Expected: PASS.

---

### Task 6: Shorts helper

**Files:**
- Create: `lib/shorts.ts`
- Test: `tests/shorts.test.ts`

**Interfaces:**
- Consumes: `StudioVideo` / `StudioPublication` / `StudioSnapshot` from Task 5.
- Produces: `shortsState(snapshot, songId): "none" | "created" | "published"`; `publishedVideosForSong(snapshot, songId): PublishedVideoLink[]`, where `PublishedVideoLink = { id: string; youtubeVideoId: string; title: string; publishedAt: Date | null; kind: "Video" | "Shorts" }`.

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it } from "vitest";
import { publishedVideosForSong, shortsState } from "../lib/shorts";

const video = (id: string, songId: string, aspect: string) => ({ id, userId: "u", songId, aspect, renderStatus: "ready", type: "image_animation", mode: null, createdAt: new Date() });
const publication = (id: string, songId: string, videoId: string | null, youtubeVideoId: string, title: string, tags: string[] = []) => ({ id, userId: "u", songId, videoId, youtubeVideoId, status: "published", title, tags, publishedAt: new Date(), privacyStatus: "public" });

describe("shorts state", () => {
  it("published má přednost před created", () => {
    const snapshot = { videos: [video("v1", "s1", "9:16")], publications: [publication("p1", "s1", "v1", "abc", "TEMNEY – A #shorts")] };
    expect(shortsState(snapshot as any, "s1")).toBe("published");
  });
  it("pozná created podle 9:16 video", () => {
    const snapshot = { videos: [video("v1", "s1", "9:16")], publications: [] };
    expect(shortsState(snapshot as any, "s1")).toBe("created");
  });
  it("legacy shorts pozná podle #shorts v názvu", () => {
    const hashtag = { videos: [video("v1", "s1", "16:9")], publications: [publication("p1", "s1", "v1", "abc", "TEMNEY – A #shorts")] };
    const descriptor = { videos: [video("v1", "s1", "16:9")], publications: [publication("p1", "s1", "v1", "abc", "TEMNEY – A Official Short")] };
    expect(shortsState(hashtag as any, "s1")).toBe("published");
    expect(shortsState(descriptor as any, "s1")).toBe("published");
  });
  it("nepletl cizí skladbu", () => {
    const snapshot = { videos: [video("v1", "other", "9:16")], publications: [] };
    expect(shortsState(snapshot as any, "s1")).toBe("none");
  });
  it("vrátí všechna publikovaná videa", () => {
    const snapshot = { videos: [video("v1", "s1", "9:16")], publications: [publication("p1", "s1", null, "long1", "TEMNEY – A"), publication("p2", "s1", "v1", "short1", "TEMNEY – A #shorts")] };
    const links = publishedVideosForSong(snapshot as any, "s1");
    expect(links.map((l) => l.kind)).toEqual(["Video", "Shorts"]);
    expect(links.map((l) => l.youtubeVideoId)).toEqual(["long1", "short1"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run the Vitest command for `tests/shorts.test.ts`.
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/shorts.ts`**

`isShortPublication` returns true when the linked `StudioVideo.aspect === "9:16"` or lowercased `title`/`tags` contains `#shorts` or `official short`. `shortsState` returns `published` when any published publication for the song is short, otherwise `created` when any ready 9:16 video exists for the song, otherwise `none`. `publishedVideosForSong` filters `status === "published"` and non-empty `youtubeVideoId`, maps every row, and labels it `Shorts` via `isShortPublication` else `Video`; sort by `publishedAt` descending with nulls last.

- [ ] **Step 4: Run test**

Run the same command.
Expected: PASS.

---

### Task 7: Shorts badge v Knihovně

**Files:**
- Modify: `app/(tabs)/library.tsx:10-17`, `:132-169`, `:208-215`
- Test: `tests/library-shorts-badge.test.ts`

**Interfaces:**
- Consumes: `shortsState(snapshot, song.id)` from Task 6.
- Produces: `SHORTS` badge in the library row.

- [ ] **Step 1: Write failing source test**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const library = readFileSync("app/(tabs)/library.tsx", "utf8");

describe("Shorts badge v knihovně", () => {
  it("používá helper a zobrazuje SHORTS", () => {
    expect(library).toContain("shortsState(");
    expect(library).toContain(">SHORTS<");
  });
  it("rozlišuje modrou a zelenou", () => {
    expect(library).toContain("colors.primary");
    expect(library).toContain("colors.success");
    expect(library).toContain("shortsTone");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run the Vitest command for `tests/library-shorts-badge.test.ts`.
Expected: FAIL.

- [ ] **Step 3: Implement the badge**

Import `shortsState`. In `renderItem`, compute `const shorts = shortsState(snapshot.data, item.id)`. Add a badge after the YouTube badge when `shorts !== "none"`, with `const shortsTone = shorts === "published" ? colors.success : colors.primary`, background `${shortsTone}1F`, border `${shortsTone}38`, icon `smart_display`, text `SHORTS`.

- [ ] **Step 4: Run test**

Run the same command.
Expected: PASS.

---

### Task 8: Všechny publikované odkazy v detailu skladby

**Files:**
- Modify: `app/song/[id].tsx:8-17`, `:117-132`, `:224-226`
- Test: `tests/song-public-links.test.ts`

**Interfaces:**
- Consumes: `publishedVideosForSong(snapshot, songId)` from Task 6 and `ExternalLink` from `components/external-link.tsx`.
- Produces: all published videos listed in the publication card.

- [ ] **Step 1: Write failing source test**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const detail = readFileSync("app/song/[id].tsx", "utf8");

describe("odkazy v detailu skladby", () => {
  it("používá helper pro všechny publikace", () => {
    expect(detail).toContain("publishedVideosForSong(");
    expect(detail).toContain("ExternalLink");
    expect(detail).toContain("https://youtu.be/");
  });
  it("rozlišuje Video a Shorts a nejen publishedVideoId", () => {
    expect(detail).toContain("publishedVideo.kind");
    expect(detail).toContain("publishedVideo.youtubeVideoId");
    expect(detail).not.toMatch(/Kopírovat link[\s\S]{0,200}youtube\.com\/watch/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run the Vitest command for `tests/song-public-links.test.ts`.
Expected: FAIL.

- [ ] **Step 3: Implement the link list**

Import `publishedVideosForSong` and `ExternalLink`. Compute `const publishedVideos = publishedVideosForSong(snapshot.data, songId)`. Keep the publication card header; replace the single `Kopírovat link` action with a `View` mapping every `publishedVideos` row to a row containing `MaterialIcons name={kind === "Shorts" ? "smart_display" : "smart_tv"}`, label `Video`/`Shorts`, title, date and an `ExternalLink href={`https://youtu.be/${youtubeVideoId}`}`. Keep the copy action as a secondary `Pressable` using `copyText`.

- [ ] **Step 4: Run test**

Run the same command.
Expected: PASS.

---

### Task 9: Finální ověření

**Files:** none — verification only.

- [ ] **Step 1: Spustit全体 testy**

Run: `ESBUILD_BINARY_PATH=/data/data/com.termux/files/usr/tmp/opencode/esbuild-0.21.5/package/bin/esbuild node node_modules/vitest/vitest.mjs run --pool=threads --maxWorkers=1 --minWorkers=1`
Expected: all tests pass.

- [ ] **Step 2: Typecheck a lint**

Run: `node node_modules/typescript/bin/tsc --noEmit`
Run: `npx expo lint`
Expected: no errors.

- [ ] **Step 3: Security a structure gates**

Run: `node scripts/security-boundary-check.mjs`
Run: `node scripts/production-smoke-check.mjs`
Expected: both OK.

- [ ] **Step 4: Web export**

Run: `CI=true EXPO_NO_TELEMETRY=1 bun node_modules/expo/bin/cli export --platform web --max-workers 1`
Expected: `Exported: dist`.

- [ ] **Step 5: Ruční ověření v aplikaci**

Otevřít Texty → rozpracovaný text → `Archivovat` → položka zmizí; přepnout `Archivováno` → otevřít → `Obnovit do rozpracovaných`; zkontrolovat dlouhý název. Otevřít Knihovnu → skladba s hotovým 9:16 videem → modrý `SHORTS`; skladba s publikovaným shorts → zelený `SHORTS`; detail → odkazy na všechna videa.
