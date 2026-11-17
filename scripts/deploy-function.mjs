#!/usr/bin/env node
/**
 * Deploy edge funkce přes Management API.
 * _shared moduly se inlinují (mají bez importů), takže stačí jeden soubor.
 * Použití: node scripts/deploy-function.mjs <slug> [verify_jwt=true|false]
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const slug = process.argv[2];
if (!slug) { console.error("Chybí slug funkce."); process.exit(1); }
const verifyJwt = process.argv[3] !== "false";
const REF = process.env.SONGCRAFT_PROJECT_REF || "eqgoedaydvwsuqgakpos";
const tokenPath = process.env.SONGCRAFT_MANAGEMENT_TOKEN_FILE || join(homedir(), ".config", "songcraft", "clean-token");
const token = readFileSync(tokenPath, "utf8").trim();
const root = join(import.meta.dirname, "..", "supabase", "functions");

let body = readFileSync(join(root, slug, "index.ts"), "utf8");
const importRe = /import\s*\{([^}]+)\}\s*from\s*["']\.\.\/_shared\/([a-z0-9-]+)\.ts["'];?/g;
let match;
const inlined = new Set();
while ((match = importRe.exec(body)) !== null) {
  const name = match[2];
  if (inlined.has(name)) continue;
  inlined.add(name);
  const modPath = join(root, "_shared", name + ".ts");
  if (!existsSync(modPath)) { console.error("Chybí _shared/" + name + ".ts"); process.exit(1); }
  const mod = readFileSync(modPath, "utf8").replace(/^export /gm, "");
  body = body.replace(match[0], "// --- inlined _shared/" + name + ".ts ---\n" + mod + "\n// --- end " + name + " ---");
}

const listRes = await fetch(`https://api.supabase.com/v1/projects/${REF}/functions`, { headers: { Authorization: `Bearer ${token}` } });
const list = await listRes.json();
const existing = Array.isArray(list) ? list.find((f) => f.slug === slug) : null;

const url = existing
  ? `https://api.supabase.com/v1/projects/${REF}/functions/${slug}`
  : `https://api.supabase.com/v1/projects/${REF}/functions`;
const payload = existing
  ? { body, verify_jwt: verifyJwt }
  : { slug, name: slug, body, verify_jwt: verifyJwt };
const response = await fetch(url, {
  method: existing ? "PATCH" : "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
const text = await response.text();
console.log("HTTP", response.status);
console.log(text.slice(0, 500));
if (!response.ok) process.exit(1);
console.log(`deployed ${slug} (inlined: ${[...inlined].join(", ") || "nic"})`);
