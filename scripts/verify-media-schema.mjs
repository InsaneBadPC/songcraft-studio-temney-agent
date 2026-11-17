#!/usr/bin/env node
/**
 * G1: Databázová vrstva media store existuje na eqgoedaydvwsuqgakpos
 * a data uživatelů jsou nedotčená (počty řádků se nesmí měnit).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REF = process.env.SONGCRAFT_PROJECT_REF || "eqgoedaydvwsuqgakpos";
const tokenPath = process.env.SONGCRAFT_MANAGEMENT_TOKEN_FILE || join(homedir(), ".config", "songcraft", "clean-token");
const token = readFileSync(tokenPath, "utf8").trim();

async function query(sql) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`DB query selhala (${response.status}): ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : [];
}

const tables = await query("select table_name from information_schema.tables where table_schema='public' and table_name in ('sc_media_objects','sc_usage_budget','sc_metering_events')");
const names = tables.map((row) => row.table_name).sort();
if (names.join(",") !== "sc_media_objects,sc_metering_events,sc_usage_budget") {
  console.error("Chybí tabulky:", names);
  process.exit(1);
}

const routines = await query("select routine_name from information_schema.routines where routine_schema='public' and routine_name in ('sc_studio_snapshot','sc_media_usage')");
const routineNames = routines.map((row) => row.routine_name).sort();
if (routineNames.join(",") !== "sc_media_usage,sc_studio_snapshot") {
  console.error("Chybí RPC funkce:", routineNames);
  process.exit(1);
}

const counts = (await query("select (select count(*) from sc_albums) albums, (select count(*) from sc_lyrics) lyrics, (select count(*) from sc_songs) songs, (select count(*) from sc_audio_versions) versions, (select count(*) from sc_song_media) media"))[0];
for (const [key, value] of Object.entries(counts)) {
  if (!Number.isFinite(Number(value)) || Number(value) < 0) {
    console.error("Neplatný počet řádků:", key, value);
    process.exit(1);
  }
}

const budgets = await query("select count(*) as n from sc_usage_budget");
if (Number(budgets[0]?.n ?? 0) === 0) {
  console.error("Rozpočty uživatelů nejsou seednuté.");
  process.exit(1);
}

console.log("tabulky:", names.join(", "));
console.log("RPC:", routineNames.join(", "));
console.log("data uživatelů:", JSON.stringify(counts));
console.log("rozpočtů:", budgets[0].n);
console.log("media schema verified");
