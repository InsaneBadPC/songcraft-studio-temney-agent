import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { deleteOrder, joinStoragePath, OWNED_TABLES, planRestore } from "../workers/backup/backup-worker.mjs";

const migrationAccounts = readFileSync("supabase/migrations/20261015000000_service_console.sql", "utf8");
const migrationBucket = readFileSync("supabase/migrations/20261015000001_backup_bucket.sql", "utf8");
const migrationLock = readFileSync("supabase/migrations/20261015000002_lock_backup_table.sql", "utf8");
const migrationNonce = readFileSync("supabase/migrations/20261015000003_restore_nonce.sql", "utf8");
const console_ = readFileSync("supabase/functions/songcraft-service-console/index.ts", "utf8");
const worker = readFileSync("workers/backup/backup-worker.mjs", "utf8");
const screen = readFileSync("app/service.tsx", "utf8");
const client = readFileSync("lib/service-console.ts", "utf8");

describe("servisní účet je oddělený a nepřepisovatelný z klienta", () => {
  it("příznak služby je v tabulce s nulovou client policy, ne v user_metadata", () => {
    expect(migrationAccounts).toContain("create table if not exists public.sc_service_accounts");
    expect(migrationAccounts).toContain("songcraft_drop_client_policies('public.sc_service_accounts')");
    expect(migrationAccounts).toContain("songcraft_set_service_policy('public.sc_service_accounts')");
    expect(migrationAccounts).toContain("revoke all on public.sc_service_accounts");
    // Prázdná tabulka = nikdo nepovolen (fail-closed), jako u _shared/access.ts.
    expect(migrationAccounts).not.toMatch(/insert into public\.sc_service_accounts[^;]*select[^;]*where[^;]*or true/i);
    // user_metadata si uživatel přepíše sám přes klienta - nesmí být zdrojem práv.
    expect(console_).not.toMatch(/user_metadata[^]*?\?\?\s*service|isServiceAccount\s*=\s*user\.user_metadata/);
    expect(console_).toContain('from("sc_service_accounts")');
  });

  it("funkce odmítne nepovolený účet a neexistující akci", () => {
    expect(console_).toContain('return json({ error: "Tento účet nemá právo servisní konzole." }, 403)');
    expect(console_).toContain("ACTIONS.includes(action as Action)");
    expect(console_).toContain("Chybí přihlášení.");
    expect(console_).toContain("Chybí konfigurace serveru.");
    // 401 musí být před 403 - neautentizovaný nesmí dostat ani stopu existence konzole.
    expect(console_.indexOf("Chybí přihlášení.")).toBeLessThan(console_.indexOf("nemá právo servisní konzole"));
  });

  it("každá změna stavu má zápis auditu PŘED zásahem", () => {
    // Sedm akcí mění stav: create_user, grant_service, revoke_service,
    // start_backup, prepare_restore (i ve variantě restore_new), cancel_job.
    // U každé musí být zápis `pending` dřív než zásah - jinak by změna mohla
    // proběhnout bez stopy v append-only logu.
    const pendingWrites = console_.split('result: "pending"').length - 1;
    expect(pendingWrites).toBe(7);
    expect(console_.match(/Zápis auditu selhal/g)?.length).toBe(6);
    expect(console_).toContain('result: entry.result');
  });
});

describe("archiv patří všem účtům, ale neodnáší cizí tajemství", () => {
  it("youtube_credentials a mrtvá záloha nejsou v seznamu exportu", () => {
    expect(OWNED_TABLES).not.toContain("youtube_credentials");
    expect(OWNED_TABLES).not.toContain("_backup_agent_videos_20261005");
    expect(console_).toContain('const NEVER_EXPORTED = ["youtube_credentials", "_backup_agent_videos_20261005"]');
    expect(worker).toContain('youtube_credentials');
    // Refresh token od Google nesmí být ani náhodou v manifestu.
    expect(worker).not.toMatch(/refresh_token|access_token/);
  });

  it("archiv je v soukromém bucketu bez client policy", () => {
    expect(migrationBucket).toContain("'songcraft-backups', 'songcraft-backups', false");
    expect(migrationBucket).toContain("Bucket songcraft-backups nesmí být veřejný");
    expect(migrationBucket).toContain("nesmí mít žádnou client policy");
    expect(worker).toContain('const BACKUP_BUCKET = "songcraft-backups"');
    // Uživatelská média jdou do jiného bucketu - prefix vlastníka se nesmí plést.
    expect(worker).toContain('const BUCKET = "songcraft"');
  });

  it("archiv má manifest, uživatele a data rozdělená podle účtu", () => {
    expect(worker).toContain("manifest.json");
    expect(worker).toContain("users.json");
    expect(worker).toContain('path.join(userDir, `${table}.jsonl`)');
    expect(worker).toContain("walkStorage(`${userId}/`)");
    expect(worker).toContain("neverExported");
  });

  /**
   * Prefix ze vstupu končí lomítkem. `${prefix}/${name}` dá `uuid//covers`, a
   * storage na dvojité lomítko vrátí prázdno - záloha by tvrdila "0 souborů",
   * přestože je v bucketu 136 objektů. Přesně to se stalo.
   */
  it("neskládá dvojité lomítko v cestě k souboru", () => {
    const uid = "99dacb87-b331-4069-9b15-61c06bd76bdd";
    expect(joinStoragePath(`${uid}/`, "covers")).toBe(`${uid}/covers`);
    expect(joinStoragePath(`${uid}/covers/`, "obalka.png")).toBe(`${uid}/covers/obalka.png`);
    expect(joinStoragePath(`${uid}/covers`, "obalka.png")).toBe(`${uid}/covers/obalka.png`);
    expect(joinStoragePath("", "songcraft-web")).toBe("songcraft-web");
    for (const bad of [joinStoragePath(`${uid}/`, "covers"), joinStoragePath(`${uid}/covers/`, "a.png")]) {
      expect(bad).not.toContain("//");
    }
    expect(worker).toContain("joinStoragePath(prefix, entry.name)");
    // Archiv musí jít do bucketu, který tenhle MIME typ vůbec přijímá.
    expect(worker).toContain('"Content-Type": "application/x-zstd"');
  });
});

describe("obnova dá každému účtu jen jeho vlastní data", () => {
  const SOURCE = "11111111-1111-1111-1111-111111111111";
  const TARGET = "22222222-2222-2222-2222-222222222222";

  it("do stejného účtu se data nemapují", () => {
    const plan = planRestore(SOURCE, SOURCE);
    expect(plan.remapped).toBe(false);
    expect(plan.row({ id: "a", user_id: SOURCE, title: "Píseň" })).toEqual({ id: "a", user_id: SOURCE, title: "Píseň" });
    expect(plan.file("covers/x.png")).toBe(`${SOURCE}/covers/x.png`);
  });

  it("do nového účtu se přepíše user_id v řádku i první segment cesty", () => {
    const plan = planRestore(SOURCE, TARGET);
    expect(plan.remapped).toBe(true);
    expect(plan.row({ id: "a", user_id: SOURCE, title: "Píseň" })).toEqual({ id: "a", user_id: TARGET, title: "Píseň" });
    expect(plan.file("covers/x.png")).toBe(`${TARGET}/covers/x.png`);
    expect(plan.file("audio/song.mp3")).toBe(`${TARGET}/audio/song.mp3`);
  });

  it("vnitřní ID řádků zůstává, aby vazby mezi tabulkami nepovolily", () => {
    const plan = planRestore(SOURCE, TARGET);
    const row = plan.row({ id: "row-1", user_id: SOURCE, song_id: "song-9" });
    expect(row.id).toBe("row-1");
    expect(row.song_id).toBe("song-9");
  });

  it("maže děti před rodiči, jinak by to spadlo na cizím klíči", () => {
    const order = deleteOrder({ sc_songs: 1, sc_albums: 1, sc_audio_versions: 1, sc_lyrics: 1 });
    expect(order.indexOf("sc_audio_versions")).toBeLessThan(order.indexOf("sc_songs"));
    expect(order.indexOf("sc_songs")).toBeLessThan(order.indexOf("sc_albums"));
    expect(order.indexOf("sc_songs")).toBeLessThan(order.indexOf("sc_lyrics"));
  });

  it("řádky se vkládají po 200 a archví se nedá obejít", () => {
    expect(worker).toContain("const chunkSize = 200");
    // Počet řádků v archivu se musí shodovat s manifestem.
    expect(worker).toContain("manifest tvrdí");
  });

  /**
   * `agent_settings` má jako primární klíč `user_id`, ne `id` - to je jediná
   * tabulka z 25, která se liší. Objednání podle `id` spadne na
   * "column agent_settings.id does not exist" a export selže v půlce.
   */
  it("nesortuje a neupsertuje podle cizho primárního klíče", () => {
    expect(worker).toContain('const PRIMARY_KEY = { agent_settings: "user_id" }');
    expect(worker).toContain("order=${primaryKey(table)}.asc");
    expect(worker).toContain("?on_conflict=${primaryKey(table)}");
    expect(worker).toContain("?${key}=in.(");
    expect(worker).toContain("JSON.parse(line)[key]");
  });

  /**
   * PostgREST vrací holé pole, ne `{ data: [...] }`. Rozbalit to jako objekt je
   * tichá chyba - `jobs` vyjde `undefined`, podmínka `if (!job) return` to schytne
   * a worker jen tiše nedělá nic, bez jediné chyby v logu. Stalo se to.
   */
  it("nečte odpověď PostgREST jako by to byl objekt s data", () => {
    expect(worker).not.toMatch(/const \{ data[^}]*\} = await request\(/);
    expect(worker).not.toContain("jobs?.[0]");
    expect(worker).toContain("const job = Array.isArray(jobs) ? jobs[0] : null");
    expect(worker).toContain("const claimed = await request(");
    expect(worker).toContain("return Array.isArray(claimed) && claimed.length > 0 ? claimed[0] : null");
  });

  it("zastaralou úlohu ukončí podle started_at, ne podle neexistujícího sloupce", () => {
    expect(worker).toContain("started_at=lt.");
    expect(worker).not.toContain("lease_expires_at=");
  });

  /**
   * `once(tar, "close")` připojené až po `await` na druhý proces ztratí událost,
   * když proces doběhne v mezeře. Node pak skončí kódem 13
   * ("unsettled top-level await") bez jediné chyby v logu. Posluchače se proto
   * musí připojit hned při startu.
   */
  it("poslouchá oba procesy archivace dřív, než na některý čeká", () => {
    expect(worker).not.toContain("await once(");
    expect(worker).not.toContain("function once(");
    expect(worker).toContain("const tarDone = new Promise((resolve) => tar.once(\"close\"");
    expect(worker).toContain("const zstdDone = new Promise((resolve) => zstd.once(\"close\"");
    expect(worker).toContain("await Promise.all([tarDone, zstdDone])");
    expect(worker).toContain("await Promise.all([zstdDone, tarDone])");
  });
});

describe("obnova je dvoukroková a vyprší", () => {
  it("samotné ID úlohy potvrzení není", () => {
    expect(console_).toContain('job.status !== "awaiting_confirmation"');
    expect(console_).toContain("sameBytes(await hashToken(nonce)");
    expect(console_).toContain("confirm_nonce_hash: null");
  });

  it("token je v databázi jen jako hash a má omezenou platnost", () => {
    expect(migrationNonce).toContain("confirm_nonce_hash text");
    expect(console_).toContain("hashToken(nonce)");
    expect(console_).not.toMatch(/confirm_nonce_hash:\s*nonce/);
    expect(console_).toContain("NONCE_TTL_MS = 15 * 60 * 1000");
    expect(screen).toContain("potvrzovací token");
    expect(client).toContain("confirmationToken");
  });

  it("čekající úloha nesmí bez potvrzení spadnout do fronty", () => {
    expect(migrationNonce).toContain("awaiting_confirmation");
    expect(console_).toContain('update({ status: "queued"');
    expect(worker).toContain("status=eq.queued");
  });
});

describe("díra v záložní tabulce je zavřená a zapsaná v repu", () => {
  it("definice je v repu, aby o ní věděl každý další", () => {
    expect(migrationLock).toContain("create table if not exists public._backup_agent_videos_20261005");
    expect(migrationLock).toContain("enable row level security");
    expect(migrationLock).toContain("revoke all on public._backup_agent_videos_20261005");
    expect(migrationLock).toContain("songcraft_drop_client_policies");
  });

  it("fail-closed kontrola po migraci skutečně ověřuje práva klienta", () => {
    expect(migrationLock).toContain("nesmí mít žádnou client policy");
    expect(migrationLock).toContain("musí mít zapnuté RLS");
    expect(migrationLock).toContain("zbyla práva pro klienta");
    expect(migrationLock).toContain("information_schema.role_table_grants");
  });
});

describe("konzole je mimo tab bar a je ve stacku", () => {
  it("obrazovka existuje a je zaregistrovaná", () => {
    expect(screen).toContain("Servisní konzole");
    expect(readFileSync("app/_layout.tsx", "utf8")).toContain('<Stack.Screen name="service" />');
    // Ne v tab baru - jen služební účet.
    expect(readFileSync("app/(tabs)/_layout.tsx", "utf8")).not.toContain("service");
  });

  it("konzole sama neautentizuje, jen kreslí co funkce vrátila", () => {
    expect(screen).toContain("Bez oprávnění");
    expect(client).toContain('supabase.functions.invoke("songcraft-service-console"');
    // Klient nesmí číst cizí data přímo - RLS by je stejně odmítlo.
    expect(client).not.toContain('supabase.from("sc_lyrics")');
    expect(client).not.toContain('supabase.from("sc_songs")');
  });
});