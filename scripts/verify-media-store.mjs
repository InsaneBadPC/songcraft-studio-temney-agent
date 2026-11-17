#!/usr/bin/env node
/**
 * G4: Edge funkce songcraft-media-store umí dávkové podepsání, upload do R2
 * s kontrolou rozpočtu, registraci a mazání derivátů.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..");
const functionsRoot = join(root, "supabase/functions");
const source = readFileSync(join(functionsRoot, "songcraft-media-store/index.ts"), "utf8");
const shared = readFileSync(join(functionsRoot, "_shared/r2.ts"), "utf8");
const fail = (message) => { console.error("FAIL:", message); process.exit(1); };

for (const action of ["sign_batch", "upload_intent", "upload", "register", "delete", "usage", "purge_expired", "health"]) {
  if (!source.includes(`action === "${action}"`)) fail(`chybí akce ${action}`);
}

if (!source.includes("createR2Client")) fail("media store nepoužívá R2 klienta");
if (!source.includes("mediaKey(path)")) fail("sign_batch nepoužívá sdílený převod cest");
if (!source.includes('r2.presign("GET", key')) fail("sign_batch nepodepisuje R2 přímo");
if (source.includes("createSignedUrls(") || source.includes("createSignedUrl(")) fail("zbyla Supabase Storage podepisovací cesta");
if (!shared.includes('export function mediaKey')) fail("chybí sdílený mediaKey");
if (!source.includes("sc_media_usage")) fail("upload nekontroluje rozpočet uživatele");
if (!source.includes("budget_exceeded")) fail("překročení rozpočtu nevrací srozumitelnou chybu");
if (!source.includes("sc_media_objects")) fail("upload nezapisuje do katalogu médií");
if (!source.includes("sc_metering_events")) fail("upload nemeteruje bajty");
if (!source.includes("resolveCallerScope")) fail("purge_expired nemá autorizaci plánovače");

const deleteStart = source.indexOf('if (action === "delete")');
const deleteBody = source.slice(deleteStart, source.indexOf('return json({ error: "Neznámá akce." }'));
if (!deleteBody.includes('row.kind === "cover" || row.kind === "audio" || row.kind === "media"')) fail("delete nemaže jen deriváty - chybí ochrana zdrojů");
if (deleteBody.includes("input?.force === true") || deleteBody.includes("input.force === true")) fail("force obchází 7denní lhůtu");

const storageCall = /(?:\.storage\s*\.\s*from\s*\(|\bstorage\.from\s*\(|createSignedUrls?\s*\()/;
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) return walk(path);
  return entry.isFile() && entry.name === "index.ts" ? [path] : [];
});
for (const file of walk(functionsRoot)) {
  const text = readFileSync(file, "utf8");
  if (storageCall.test(text)) fail(`Supabase Storage volání v ${relative(root, file)}`);
}

console.log("akce: sign_batch, upload_intent, upload, register, delete, usage, purge_expired, health");
console.log("cesty: legacy + r2:// přes mediaKey, přímé R2 podpisy");
console.log("edge funkce: bez Supabase Storage volání");
console.log("media store verified");
