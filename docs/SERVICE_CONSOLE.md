# Servisní konzole Temney — návrh

Cíl: účet **Temney** je služební. V aplikaci má skrytou servisní konzoli, kde lze
přidat uživatele a spustit **zálohu všech dat všech uživatelů** i její **obnovu**
tak, aby po obnově měl každý uživatel výhradně svá data.

Reálná velikost dnešní databáze (změřeno 15. 10. 2026): bucket `songcraft`
**136 objektů / 1 336 MB**, největší 48 MB, 26 objektů nad 20 MB. 4 uživatelé,
27 tabulek, 166 řádků auditu.

---

## 1. Proč edge funkce nepostačí

1 336 MB se nevejde do Deno izolátu (paměťový strop, ~150 s). Záloha **i**
obnova se proto dělají na VM, přesně stejnou architekturou, jakou už funguje
render videí: řádek v databázi = úloha, worker ji vybere, průběh zapíše,
výsledek uloží do bucketu.

VM `138.2.190.31` má **36 GB volného disku** (potřeba ~3 GB: pracovní kopie +
archiv) a 954 MB RAM, z toho 223 MB volných — proto worker **nesmí nic držet
v paměti**. Vše streamuje. `zip` na VM není, ale `tar` a `zstd` ano → archiv
`.tar.zst`.

---

## 2. Tři kusy

### A. Edge funkce `songcraft-service-console`

Jen řídící vrstva. **Nikdy nesahá na soubory.**

Vzor: `supabase/functions/youtube-status/index.ts` (ověření) +
`supabase/functions/agent-confirm/index.ts` (potvrzování + audit).

| krok | chování |
|---|---|
| chybí `Authorization` | 401 |
| chybí konfigurace klíčů | 503 |
| `auth.getUser()` selže | 401 |
| uživatel není v `sc_service_accounts` | 403 |
| neznámá akce | 400 (allowlist, ne blacklist) |
| každá úspěšná i odmítnutá operace | zápis do `agent_action_log` |

Akce: `list_users`, `create_user`, `start_backup`, `start_restore`,
`job_status`, `cancel_job`.

`verify_jwt = true` v `supabase/config.toml`.

### B. Worker `songcraft-backup` na VM

Nová Node služba (`/opt/songcraft-studio/workers/backup/`, systemd
`songcraft-backup`), **neprivilegovaný** uživatel `songcraft-renderer`, čte
`sc_service_backups` / `sc_service_restores`, streamuje, průběh průběžně
zapisuje do DB. Režim `RUN_ONCE=1` pro ruční běh a testy.

### C. UI `app/service.tsx`

Mimo tab bar, jen pro služební účet (`isServiceAccount`). Obrazovky:
**Účty** (seznam, přidat) · **Zálohy** (spustit, průběh, stáhnout archiv) ·
**Obnovy** (výběr účtu a archivu, dvě varianty níže).

---

## 3. Služební účet

Nová tabulka **`sc_service_accounts`**:

```sql
user_id uuid primary key references auth.users(id) on delete cascade,
label    text not null,
created_at timestamptz not null default now()
```

- **Bez jediné client policy** — stejně jako `youtube_credentials`. Jen
  `service_role`.
- **Fail-closed**: prázdná tabulka = nikdo není služební.
- **Nepoužívám `user_metadata`** — to si uživatel přepíše sám přes klienta,
  takže z něj nejde udělat příznak oprávnění.

---

## 4. Formát archivu

`backups/<backup_id>.tar.zst`, uvnitř:

```
manifest.json        schema verze, čas, zdrojový projekt ref, počty, checksum
users.json           účty: staré UUID, e-mail, display_name (bez hesel, bez tokenů)
rows/<tabulka>.jsonl řádky tabulek 1:1, jak jsou v DB
files/<staré_uuid>/<cesta>  binární soubory v původní podobě
```

**`youtube_credentials` se neexportuje.** Je to refresh token od Google —
v archivu stažitelném na telefon by to znamenalo přístup na kanál. Při obnově
se nepřenáší a kanály se propojí novým OAuth flownem.

Zbytek 26 tabulek jde celý, včetně `agent_action_log` a `agent_videos`.

---

## 5. Obnova — dvě varianty

Interní ID řádků (PK) se **nemění**, takže vazby mezi tabulkami
(`sc_audio_versions.song_id`, `youtube_publications.agent_video_id`, …) zůstávají
v konzistenci. Přemapovává se jen `user_id` a cesty souborů.

### Varianta A — do existujícího účtu se stejným ID

„Obnova do původního stavu." Data účtu se smažou a naplní ze zálohy, ID i odkazy
se nemění. Použitelné po nešťastném smazání.

### Varianta B — do nového účtu (přenos)

„Převést databáze." Vznikne nový účet s **novým UUID**, všechna `user_id`
se přepíší na nové a soubory se zkopírují z `files/<staré_uuid>/…` na
`<nový_uuid>/…`. Funguje i v **jiném Supabase projektu** — export je
samostatný, restore nemá nic společného s původním projektem.

Obě varianty jsou potvrzené přes `agent_ops` (nonce, hash, `agent_confirm`)
jako ostatní destruktivní operace. U varianty A je to **smazání dat**, proto
potvrzení musí být povinné a jednoznačné.

---

## 6. Migrace

| soubor | co dělá |
|---|---|
| `20261015000000_service_accounts.sql` | `sc_service_accounts`, `sc_service_backups`, `sc_service_restores`, RLS, service policy, SQL asserty |
| `20261015000001_backup_bucket.sql` | bucket `songcraft-backups`, **private**, žádná client policy |
| `20261015000002_lock_backup_table.sql` | `_backup_agent_videos_20261005`: RLS zapnout, `anon` + `authenticated` odebrat vše, nechat `service_role` |

Třetí migrace zavírá živou díru — viz `SONGCRAFT-STAV-2026-10-15.md`.

---

## 7. Co musí platit po každé změně

```
pnpm security:check     žádný secret v kódu
pnpm smoke:structure    povinné soubory a migrace
tsc --noEmit            čistý
vitest run              všechny testy
eslint app components   0 chyb
expo export --platform web
deno check supabase/functions/songcraft-service-console/index.ts
```

Nové testy:

- služební účet: nepovolený účet dostane 403, povolený projde
- `sc_service_accounts` nemá žedinou client policy
- export **neobsahuje** `youtube_credentials`
- export **obsahuje všechny soubory** daného účtu
- round-trip: export → obnova do nového účtu → **každý řádek patří správnému
  `user_id`**, cesty souborů mají nový prefix
- round-trip izolace: po obnově účet A nevidí data účtu B přes běžného klienta

Ten poslední test je zásadní — je to přesně to, co požaduje zadání.

---

## 8. Nasazení

Novou funkci je nutné přidat do `.github/workflows/deploy-agent-orchestrator.yml`
(seznam je manuální, funkce mimo něj skončí 404), jinak
`songcraft-service-console` nenaběhne.

Worker na VM se nasazuje přes `scp` + `sudo install` stejně jako renderer, ale
jde o **novou službu** → potřeba samostatného schválení.

---

## 9. Fáze

| fáze | obsah |
|---|---|
| **1** | migrace (service accounts, bucket, uzavření díry) + `songcraft-service-console` s `list_users` a `create_user` + UI + testy |
| **2** | worker na VM + `start_backup` + archiv + stahování |
| **3** | `start_restore` varianty A i B + round-trip testy na živém projektu |

Fáze 2 a 3 se dají otestovat bezpečně: export → obnova do **nového
testovacího účtu** → kontrola izolace → účet smazat. Bez zásahu do reálných
dat.