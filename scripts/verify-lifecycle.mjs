#!/usr/bin/env node
/**
 * G6: Lifecycle - deriváty (MP4) se mažou 7 dní po zveřejnění, zdroje nikdy.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const fn = readFileSync(join(root, "supabase/functions/songcraft-media-store/index.ts"), "utf8");
const migration = readFileSync(join(root, "supabase/migrations/20261117000000_media_registry_snapshot_rpc.sql"), "utf8");
const fail = (message) => { console.error("FAIL:", message); process.exit(1); };

// 1) purge_after = published_at + 7 dní.
if (!fn.includes("7 * 24 * 60 * 60 * 1000")) fail("registrace nenastavuje 7denní lhůtu");
if (!fn.includes("purge_after: purgeAfter")) fail("registrace neukládá purge_after");

// 2) Plánované mazání cílí jen na kind=video s prošlým purge_after.
const purgeStart = fn.indexOf('if (action === "purge_expired")');
const purgeBody = fn.slice(purgeStart, fn.indexOf("const authorization = request.headers.get"));
if (!purgeBody.includes('.eq("kind", "video")')) fail("purge_expired nemaže jen videa");
if (!purgeBody.includes('.lt("purge_after", new Date().toISOString())')) fail("purge_expired nemaže jen prošlé deriváty");
if (!purgeBody.includes('.eq("state", "active")')) fail("purge_expired nemaže jen aktivní objekty");
if (!purgeBody.includes('caller.scope.role !== "scheduler"')) fail("purge_expired může spustit kdokoli");

// 3) Ruční delete odmítá obaly a MP3.
const deleteStart = fn.indexOf('if (action === "delete")');
const deleteBody = fn.slice(deleteStart, fn.indexOf('return json({ error: "Neznámá akce." }'));
if (!deleteBody.includes("Zdrojová média (obaly, MP3, nahrané soubory) se mazat nesmějí.")) fail("delete nemá ochranu zdrojových médií");
if (!deleteBody.includes("Video se maže až 7 dní po zveřejnění.")) fail("delete nerespektuje 7denní lhůtu");

// 4) DB má index pro mazání a stav 'purged'.
if (!migration.includes("purge_after")) fail("migrace nemá sloupec purge_after");
if (!migration.includes("sc_media_objects_purge_idx")) fail("chybí index pro plánované mazání");
if (!migration.includes("'purged'")) fail("chybí stav purged");

console.log("derivát: purge_after = published_at + 7 dní");
console.log("plánovač: jen kind=video, state=active, purge_after < now");
console.log("zdroje (cover, audio, media): mazání odmítnuto");
console.log("lifecycle verified");
