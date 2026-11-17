#!/usr/bin/env node
/**
 * G2 + G3: Snapshot stojí 1 RPC + 1 dávkový podpis (ne ~160 requestů).
 * Měří se ze zdrojáků, ne z odhadu.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const studio = readFileSync(join(root, "lib/external-studio.ts"), "utf8");
const mediaUrl = readFileSync(join(root, "lib/media-url.ts"), "utf8");
const trpc = readFileSync(join(root, "lib/trpc.ts"), "utf8");
const auth = readFileSync(join(root, "hooks/use-auth.ts"), "utf8");
const layout = readFileSync(join(root, "app/_layout.tsx"), "utf8");

const fail = (message) => { console.error("FAIL:", message); process.exit(1); };

// 1) Snapshot jde přes RPC, ne přes 7 PostgREST dotazů.
const snapshotStart = studio.indexOf("export async function getExternalStudioSnapshot");
const snapshotEnd = studio.indexOf("export async function uploadToExternalStorage");
const snapshotBody = studio.slice(snapshotStart, snapshotEnd);
if (!snapshotBody.includes('supabase.rpc("sc_studio_snapshot"')) fail("snapshot nevolá sc_studio_snapshot RPC");
if (snapshotBody.includes("supabase.from(")) fail("snapshot stále dělá PostgREST dotazy na tabulky");

// 2) Podepisování je dávkové: signMediaPaths, ne createSignedUrl na řádek.
if (!snapshotBody.includes("signMediaPaths(")) fail("snapshot nepoužívá dávkové podepsání");
const perRowSign = (studio.match(/createSignedUrl\(/g) ?? []).length;
if (perRowSign !== 0) fail(`v external-studio.ts zůstalo ${perRowSign} createSignedUrl volání (musí být 0)`);

// 3) Dávkový podpis = jeden invoke, ne smyčka.
const signBody = mediaUrl.slice(mediaUrl.indexOf("export async function signMediaPaths"));
if (!signBody.includes("sign_batch")) fail("signMediaPaths nepoužívá action sign_batch");
if ((signBody.match(/functions\.invoke/g) ?? []).length !== 1) fail("signMediaPaths dělá víc než jeden invoke");
if (!mediaUrl.includes("new Map")) fail("chybí cache podepsaných URL");

// 4) Auth je jeden sdílený provider (ne 16 nezávislých getUser).
if (!auth.includes("createContext")) fail("useAuth není kontextový provider");
if (!layout.includes("AuthProviderRoot")) fail("root layout neobaluje AuthProviderRoot");
const getUserInAuth = (auth.split("\n").filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//")).join("\n").match(/supabase\.auth\.getUser\(\)/g) ?? []).length;
if (getUserInAuth !== 1) fail(`useAuth volá getUser ${getUserInAuth}× (musí být 1)`);

// 5) Snapshot má staleTime a throttlovanou invalidaci při návratu do appky.
if (!trpc.includes("staleTime:")) fail("snapshot nemá staleTime");
if (!trpc.includes("fetchedAt")) fail("invalidace při návratu do appky není throttlovaná podle stáří dat");

// 6) Galerie i video URL jdou přes dávkový podpis.
const galleryStart = studio.indexOf("export async function listExternalSongMedia");
const galleryBody = studio.slice(galleryStart, galleryStart + 1600);
if (!galleryBody.includes("signMediaPaths(")) fail("galerie nepodepisuje dávkově");
const videoJobs = readFileSync(join(root, "lib/video-jobs.ts"), "utf8");
const videoJobsCode = videoJobs.split("\n").filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//")).join("\n");
if (videoJobsCode.includes("createSignedUrl")) fail("video-jobs stále podepisuje vlastní createSignedUrl");
if (videoJobsCode.includes("supabase.auth.getUser()")) fail("video-jobs si volá getUser při každém dotazu");

console.log("snapshot: 1 RPC + 1 dávkový podpis");
console.log("createSignedUrl v external-studio.ts:", perRowSign);
console.log("getUser v useAuth:", getUserInAuth);
console.log("client request budget verified");
