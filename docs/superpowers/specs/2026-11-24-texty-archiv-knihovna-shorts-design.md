# Design: Archiv rozpracovaných textů + Shorts v knihovně

Datum: 2026-11-24

## Intent

Uživatel si v sekci Texty drží rozpracované texty, z nichž některé už jsou ve skutečnosti hotové písně nebo materiál pro rework. Mají přestat zalepovat seznam Textů, ale nesmí se ztratit. V Knihovně má být na první pohled vidět, zda ke skladbě existuje Shorts, a v detailu mají být dostupné všechny publikované odkazy (dlouhé video i Shorts). Názvy položek v seznamu Textů musí být čitelné celé.

## Goals

- Detail rozpracovaného textu má tlačítko `Archivovat`; po potvrzení položka zmizí ze seznamu rozpracovaných textů.
- Archivovaný text zůstává v `sc_lyrics`, lze ho v Texty najít pod filtrem `Archivováno`, otevřít a v detailu má `Obnovit do rozpracovaných`.
- Archivované texty se nepočítají ani neexportují jako rozpracované.
- Seznam Textů zobrazuje celé názvy funkcí bez `numberOfLines` ořezání.
- Knihovna zobrazuje stejný štítek `SHORTS`: modrý = hotové 9:16 video existuje, zelený = shorts publikován (zelený má přednost).
- Detail skladby zobrazí všechna publikovaná videa se samostatnými odkazy a rozlišením `Video` / `Shorts`.

## Non-goals / anti-goals

- Nemazat žádné texty, skladby ani publikace.
- Nepřidávat ruční zaškrtávací pole pro Shorts; stav se odvozuje z DB.
- Neměnit Google Docs import, publish pipeline ani VM.
- Nepřidávat nový samostatný „Archiv“ tab; archiv zůstává filtrem uvnitř Textů.
- Negenerovat nové YouTube video ani neměnit `is_published` hromadně.

## Constraints

- Aplikace użyva přímý Supabase klient (`lib/trpc.ts`), ne legacy Drizzle/TRPC.
- `sc_lyrics.status` má dnes CHECK jen `('draft','complete')`; archiv vyžaduje novou migraci, ne úpravu staré.
- `sc_studio_snapshot` dnes nevrací `agent_videos` ani `youtube_publications`; je třeba ho rozšířit v nové migraci přes `create or replace`.
- Shorts se v DB spolehlivě pozná podle `agent_videos.aspect = '9:16'`; staré záznamy mohou mít výchozí `16:9`, proto fallback podle `#shorts` v názvu/tazích publikace.
- Všechny mutace musí být omezeny na `user_id = auth.uid()` / přihlášený uživatel.
- Žádná operace na VM, žádné YouTube publish, žádné cizí Supabase projekty.

## Approaches

### Archiv rozpracovaných textů

- **A — vybráno:** nový status `archived` + filtr `Rozpracované / Archivováno` v Texty, tlačítko `Archivovat` a `Obnovit do rozpracovaných` v detailu. Data zůstávají v DB, rework je možný, seznam zůstává čistý.
- **B — odmítnuto:** archiv bez filtru. Schovalo by to položky, ale znemožnilo by rework z aplikace.
- **C — odmítnuto:** samostatný `archived_at` příznak při ponechaném `status='draft'`. Vyžadoval by zásah do snapshotu a mapování a pořád by rozmazával význam `draft`.

### Shorts v knihovně

- **A — vybráno:** odvozovat modrý/zelený stav a seznam odkazů z `agent_videos` + `youtube_publications` v rozšířeném snapshotu. Žádná ruční údržba, stav odpovídá DB a YouTube.
- **B — odmítnuto:** ruční příznaky na `sc_songs`. Další klikání a riziko, že se označení rozejde s reálným videem.
- **C — odmítnuto:** kombinace automatického a ručního stavu. Zbytečná složitost pro první verzi.

## Design

### 1. Archiv textů

1. Nová migrace `supabase/migrations/20261124000000_lyric_archived_status.sql`: rozšířit CHECK `sc_lyrics.status` na `('draft','complete','archived')`. Ponechat existující RLS update politiku.
2. `lib/external-studio.ts`: `StudioDocument.status` rozšířit o `"archived"`; `documentFromRow` už nebude cokoliv jiného než `complete` převádět na `draft`. Přidat `archiveDocument(id)` a `restoreDocument(id)` jako update `sc_lyrics.status` s `eq("user_id")`.
3. `lib/trpc.ts`: přidat `archiveDocument` / `restoreDocument` vedle `completeDocument` a invalidovat studio snapshot.
4. `app/text/[id].tsx`: pro `status === "draft"` zobrazit `Archivovat` s potvrzovacím `Alert`; pro `status === "archived"` zobrazit `Obnovit do rozpracovaných`. Po obou akcích `clearDraft` a `router.back()`/návrat na seznam. `Označit jako hotové` zůstává jen pro `draft`.
5. `app/(tabs)/texts.tsx`: přidat filtr `Rozpracované / Archivováno` (výchozí rozpracované); archivovaný řádek má jiný StatusChip a otevírá se stejně. U názvu odstranit `numberOfLines={2}`, nechat `flexShrink`/`minWidth: 0`, chip dát do vlastního řádku, aby se název netlačil mimo obrazovku.
6. `components/studio-ui.tsx`: `StatusChip` podporuje `archived` (např. šedá, label `ARCHIVOVÁNO`); `writing-workspace.tsx` pro archiv zobrazí `Archivovaný text`.
7. Počítadla v `app/(tabs)/index.tsx` a export v `songcraft-utilities` už filtrují `draft`, takže archivované texty po změně statusu přestanou být počítány.

### 2. Shorts a odkazy v Knihovně

1. Nová migrace `supabase/migrations/20261124010000_studio_snapshot_videos_publications.sql`: `create or replace function public.sc_studio_snapshot(p_user_id uuid)` přidá klíče `videos` a `publications`:
   - `videos`: `id, user_id, song_id, aspect, render_status, type, mode, created_at` z `agent_videos` pro daného uživatele.
   - `publications`: `id, user_id, song_id, video_id, youtube_video_id, status, title, tags, published_at, privacy_status` z `youtube_publications` pro daného uživatele.
2. `lib/external-studio.ts`: přidat typy `StudioVideo`, `StudioPublication`, rozšířit `StudioSnapshot` o `videos`/`publications` a mapovat je do payloadu. `StudioSong` ponechat beze změny; `publishedVideoId` zůstává pro kompatibilitu.
3. `lib/shorts.ts` (nebo malý helper v `external-studio.ts`): `isShortVideo(video, publication)` = `video.aspect === '9:16'` nebo fallback `#shorts` v `publication.title`/`tags`. `shortsState(songId, snapshot)` vrátí `none | created | published`; `published` > `created`.
4. `app/(tabs)/library.tsx`: v `renderItem` vedle badge `YouTube` přidat badge `SHORTS` s barvou `colors.primary` pro `created` a `colors.success` pro `published`. Žádný nový filtr v Knihovně.
5. `app/song/[id].tsx`: nahradit jediný `Kopírovat link` seznamem publikací této skladby ze snapshotu (`status='published'`, neprázdné `youtube_video_id`). Každý řádek: ikona, label `Video`/`Shorts`, název publikace, datum a odkaz otevíraný přes existující `components/external-link.tsx` (`https://youtu.be/<id>`). Zachovat i kopírování linku jako sekundární akci.
6. Badge barvy a odkazy nesmí měnit `sc_songs.is_published` ani spouštět publish.

### 3. Testy a ověření

- Nové/extending Vitest testy pro mapování snapshotu, `shortsState` (vč. fallback `#shorts`) a filtr archivu.
- Ověřit `npx tsc --noEmit` (v Termuxu přes `node node_modules/typescript/bin/tsc --noEmit`), Vitest, security-boundary-check a production-smoke-check.
- Ruční ověření v appce: archivace/obnovení textu, celé názvy v seznamu, modrý/zelený `SHORTS`, odkazy na více publikací.

## What is left to the builder

- Konkrétní texty tlačítek a přesné barvy z theme (modrá = `colors.primary`, zelená = `colors.success`).
- Aplikace migrací na čistý projekt `eqgoedaydvwsuqgakpos`.
- Nasazení edge funkcí není potřeba; mění se jen SQL funkce snapshotu a klientské UI.
