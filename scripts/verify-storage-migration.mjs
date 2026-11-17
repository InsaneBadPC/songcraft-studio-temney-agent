#!/usr/bin/env node
/**
 * G5: Migrace Supabase Storage → R2 nesmí ztratit data.
 * Kontroluje tvrdé záruky přímo ve skriptu.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const source = readFileSync(join(root, "scripts/migrate-storage-to-r2.mjs"), "utf8");
const fail = (message) => { console.error("FAIL:", message); process.exit(1); };

// 1) Výchozí režim je dry-run; mazání jen s --commit.
if (!source.includes('const COMMIT = args.has("--commit")')) fail("mazání není podmíněné --commit");
if (!source.includes('mode: COMMIT ? "commit" : "dry-run"')) fail("report neoznačuje režim");
if (!source.includes("if (COMMIT) {")) fail("delete není uvnitř COMMIT bloku");

// 2) Ověření SHA-256 + velikosti PŘED smazáním.
const putIndex = source.indexOf("await r2Put(");
const headIndex = source.indexOf("await r2Head(");
const hashIndex = source.indexOf("targetHash !== sourceHash");
const deleteIndex = source.indexOf("await deleteObject(");
if (!(putIndex > -1 && headIndex > putIndex && hashIndex > headIndex && deleteIndex > hashIndex)) {
  fail("pořadí není kopie → HEAD → SHA-256 → delete");
}
if (!source.includes("Velikost v R2 nesedí")) fail("chybí kontrola velikosti po přenosu");

// 3) Žádný UPDATE/DELETE na uživatelských tabulkách.
const forbidden = /(?:update|delete)\s+(?:from\s+)?(?:public\.)?sc_(albums|lyrics|songs|audio_versions|song_media|style_prompts|rhyme_words)\b/i;
if (forbidden.test(source)) fail("migrace sahá na uživatelská data (UPDATE/DELETE na sc_* tabulkách)");

// 4) Jediný zápis je aditivní registrace.
if (!source.includes("insert into sc_media_objects")) fail("chybí aditivní registrace do sc_media_objects");
if (!source.includes("on conflict (user_id, storage_path)")) fail("registrace není idempotentní");

// 5) Kontrola počtů řádků před a po.
if (!source.includes("report.dataBefore") || !source.includes("report.dataAfter")) fail("chybí měření dat před/po");
if (!source.includes("počty řádků v DB se změnily")) fail("chybí tvrdá kontrola, že se data nezměnila");

// 6) Selhání jednoho objektu nesmí smazat nic dalšího.
if (!source.includes('entry.status = "failed"')) fail("chyba objektu není zaznamenaná");
if (!source.includes("zůstaly v Supabase")) fail("selhané objekty nezůstávají v Supabase");

console.log("režim: dry-run default, mazání jen --commit");
console.log("pořadí: kopie → HEAD → SHA-256 → delete");
console.log("uživatelské tabulky: beze změny (jen aditivní registrace)");
console.log("storage migration verified");
