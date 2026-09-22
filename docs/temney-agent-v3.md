# SongCraft Studio 3.0 — Temney Agent

## Stav implementace

Verze 3.0 přidává serverový orchestrátor s function callingem, bezpečnou databázovou migraci, privátní artwork pipeline, renderovací frontu, publikační drafty a synchronizaci statistik. Chat v aplikaci volá `agent-orchestrator` a při jeho nedostupnosti zachovává fallback na původního asistenta.

### Dostupné nástroje

| Nástroj | Chování |
|---|---|
| `list_songs` | Vrátí pouze skladby ověřeného uživatele. |
| `extract_lyric_themes` | Gemini extrahuje 3–6 vizuálních motivů. |
| `generate_song_artwork` | Pollinations vygeneruje artwork s Temney character bible a uloží jej do privátního Storage. |
| `generate_metadata` | Připraví návrh názvu, popisu a tagů. |
| `render_video` | Vytvoří položku ve frontě `agent_videos`. |
| `create_recommendation` | Uloží strategické doporučení se stavem `pending`. |
| `schedule_publication` | Vytvoří soukromý YouTube draft. |
| `publish_to_youtube` | Nikdy nepublikuje bez potvrzení; endpoint připraví payload a ověří OAuth. |

## Nasazení Supabase

1. Spusť `supabase db push` nebo aplikuj soubor `supabase/migrations/20260922000000_temney_agent_v3.sql`.
2. Nastav secrets:

```bash
supabase secrets set GEMINI_API_KEY=<gemini-api-key>
supabase secrets set SUPABASE_URL=<supabase-url>
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
```

3. Deploy funkcí:

```bash
supabase functions deploy agent-orchestrator
supabase functions deploy youtube-publish
supabase functions deploy youtube-sync-stats
supabase functions deploy video-renderer-dispatch
```

Pro skutečný resumable upload na YouTube nastav také OAuth secrets:

```bash
supabase secrets set YOUTUBE_CLIENT_ID=<oauth-client-id>
supabase secrets set YOUTUBE_CLIENT_SECRET=<oauth-client-secret>
```

Uživatel musí mít předem uložený refresh token v `youtube_credentials`. Bez něj endpoint pouze vytvoří nebo vrátí soukromý draft a nic veřejně nezmění.

## Render worker

Worker na VM má bezpečně načítat řádky `agent_videos` se stavem `queued`, atomicky je přepnout na `rendering`, stáhnout audio a artwork přes podepsané Storage URL, spustit ffmpeg, nahrát MP4 do bucketu `songcraft` a aktualizovat řádek na `ready` nebo `failed`. Service-role klíč patří pouze do environmentu workeru a nikdy do repozitáře.

## YouTube OAuth

OAuth access/refresh tokeny patří do `youtube_credentials` a nesmí být vráceny klientovi. Před produkčním uploadem je třeba dokončit resumable upload přes YouTube Data API v3. Endpoint je záměrně konzervativní: bez validního OAuth draft pouze odmítne a nic veřejného nezmění.

## Plánovač

Denní synchronizaci lze spustit přes Supabase pg_cron voláním `youtube-sync-stats`. Týdenní report může volat `agent-orchestrator` s interní úlohou nebo samostatná Edge Function. Pro častější kontrolu fronty použij worker, nikoli opakované AI session polling.

## Bezpečnostní pravidla

Každý serverový dotaz ověřuje JWT a filtruje `user_id`. Citlivé akce se zapisují do `agent_action_log`. Veřejné změny zůstávají v `draft` nebo `pending_confirmation`. Artwork používá character bible, ale text se do obrázku negeneruje AI; overlay se má doplnit deterministicky rendererem.

## Stav dokončení (2026-09-22)

- ✅ Migrace `20260922000000_temney_agent_v3.sql` aplikovaná; secrets nastavené (`GEMINI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`).
- ✅ Deployed (v3.0): `agent-orchestrator`, `youtube-publish`, `youtube-sync-stats` (verify_jwt off), `video-renderer-dispatch`. E2E prošlo (list_songs, extract_lyric_themes, generate_metadata, generate_song_artwork, render_video, schedule_publication, publish_to_youtube -> pending_confirmation).
- ✅ Render worker ověřen (RUN_ONCE + WORK_DIR), MP4 v bucketu `songcraft`, řádky `agent_videos` → `ready`.
- ✅ Plánovač: `.github/workflows/sync-youtube-stats.yml` (GitHub Actions cron 06:00 UTC + manual) volá `youtube-sync-stats`.
- ⏳ **DOKONČENO 2026-09-22**: `youtube_credentials` naplněno pro Temney (`99dacb87-…`, channel `UCVBrh8BozfEz5SDltgsvGWw`, scopes `youtube`+`youtube.upload`). OAuth souhlas prošel přes test usera `insanebad2@gmail.com` (Testing mód: owner = kandidát, ale Google ho pustí až jako Test user). Refesh token ověřen, `youtube-publish` má funkční resumable upload.
