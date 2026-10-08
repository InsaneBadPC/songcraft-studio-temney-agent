import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const worker = readFileSync("workers/video-renderer/worker.mjs", "utf8");
const engine = readFileSync("workers/video-renderer/loop-engine.mjs", "utf8");
const gallery = readFileSync("workers/video-renderer/gallery-engine.mjs", "utf8");


describe("Oracle video worker contract", () => {
  it("reads the persisted prompt_used column and all three modes", () => {
    expect(worker).toContain("prompt_used");
    expect(worker).not.toContain("select=id,user_id,song_id,type,mode,backend,prompt,");
    expect(worker).toContain("static_cover");
    expect(worker).toContain("image_animation");
    expect(worker).toContain("full_scenes");
  });

  it("uses final/tagged audio and private owner paths", () => {
    expect(worker).toContain("is_final=eq.true");
    expect(worker).toContain("tagged_storage_path || version.original_storage_path || version.storage_path");
    expect(worker).toContain("ownedPath(job.user_id");
  });

  it("renders the uploaded-video loop locally and never trusts a foreign path", () => {
    expect(worker).toContain("video_loop");
    expect(worker).toContain("renderSeamlessVideoLoop");
    // vlastnictví cesty se musí ověřit přes ownedPath, ne ručně
    expect(worker).toContain('ownedPath(job.user_id, job.source_video_path)');
    // plynulost: crossfade jednotka + opakování na délku audia
    expect(worker).toContain("xfade=transition=fade");
    expect(worker).toContain("-stream_loop");
    // 9:16 pro short, 16:9 jinak
    expect(worker).toContain('aspect === "9:16" ? { w: 1080, h: 1920 }');
  });

  it("has a fail-closed duration probe instead of guessing", () => {
    expect(worker).toContain("ffprobe");
    expect(worker).toContain("ffprobe returned no usable duration");
  });

  it("makes the stored aspect match the real output", () => {
    // dashboard vrací 16:9; pro 9:16 se musí výstup převést, jinak short v DB
    // tvrdí svislé a soubor je vodorovný
    expect(worker).toContain("fitToAspect");
    expect(worker).toContain("pad=1080:1920");
  });

  it("renders both video kinds with the loop engine", () => {
    expect(worker).toContain('from "./loop-engine.mjs"');
    expect(worker).toContain("buildLoopVideo");
    // 16:9 i 9:16 z jednoho průchodu
    expect(worker).toContain('aspect: job.aspect === "9:16" ? "9:16" : "16:9"');
    // video skladby, jinak obal
    expect(worker).toContain("job.source_video_path");
    expect(worker).toContain("sourceImage");
    // engine nesmí potřebovat dashboard
    expect(worker.slice(worker.indexOf('type === "source_loop"'), worker.indexOf('type === "static_cover"')))
      .not.toContain("dashGenerate");
  });

  it("probes the output with field names so the check can actually match", () => {
    // nk=1 vyhazuje názvy polí a validace hledající width= padla vždy
    expect(worker).toContain('"default=nw=1"');
    // konkrétní argument ffprobe, ne zmínka v komentáři
    expect(worker).not.toContain('"default=nw=1:nk=1"');
    expect(worker).not.toMatch(/"-of",\s*"default=[^"]*nk=1/);
    expect(worker).toContain("/width=\\d+/i");
  });

  it("keeps finished passes on retry so the engine can resume", () => {
    // smazání pracovního adresáře při retry znamenalo restart od prvního průchodu
    expect(worker).toContain("se ponechává, engine naváže");
    expect(worker).toContain("pruneOldWork");
    expect(worker).toContain("LEASE_MS = 6 * 60 * 60 * 1000");
  });

  it("only reuses passes when the plan is unchanged", () => {
    const engine = readFileSync("workers/video-renderer/loop-engine.mjs", "utf8");
    expect(engine).toContain("plan.sha");
    expect(engine).toContain("createHash");
    expect(engine).toContain("pokračuji, plán beze změny");
    // čištění smí být jen uvnitř větve "plán se změnil"
    const cleanup = engine.slice(engine.indexOf("if (previous === fingerprint)"));
    expect(cleanup).toContain("plán se změnil");
    expect(cleanup).toContain("rm(path.join(workDir, file)");
  });

  it("nezavádí funkci, která by vracela tokeny", () => {
    const fn = readFileSync("supabase/functions/youtube-status/index.ts", "utf8");
    const api = readFileSync("lib/external-studio.ts", "utf8");
    // youtube_credentials má záměrně žádnou policy pro klienta; funkce smí
    // číst jen se service role a vrátit smí příznak a titul
    expect(fn).toContain("SUPABASE_SERVICE_ROLE_KEY");
    // refresh token se smí použít na serveru, nesmí se nikdy vrátit v odpovědi
    const bodies = [...fn.matchAll(/json\(\s*\{([\s\S]*?)\}/g)].map((m) => m[1]);
    expect(bodies.length, "funkce nic nevrací").toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body, `odpověď vrací refresh_token: ${body.slice(0, 80)}`).not.toContain("refresh_token");
      expect(body, `odpověď vrací access_token: ${body.slice(0, 80)}`).not.toContain("access_token");
    }
    expect(fn).toContain("channel_id,updated_at");
    expect(api).toContain("getYoutubeChannelStatus");
    const client = api.slice(api.indexOf("export async function getYoutubeChannelStatus"));
    expect(client.slice(0, client.indexOf("export"))).not.toContain("refresh_token");
  });

  it("bere GET i POST, protoze klient posila POST", () => {
    const fn = readFileSync("supabase/functions/youtube-status/index.ts", "utf8");
    expect(fn).toContain('request.method !== "GET" && request.method !== "POST"');
    expect(fn).not.toContain('if (request.method !== "GET") return json({ error: "Použij GET." }');
    expect(readFileSync("lib/external-studio.ts", "utf8")).toContain('invoke("youtube-status", { method: "GET" })');
  });

  // Regrese 8. 10. 2026: youtube-status vracelo connected: true, jakmile v
  // tabulce byl ANY row. Kdyz Google odmítl obnovit prava (invalid_grant),
  // appka ukazala "Nahravani i publikace funguji" a tlacitko "Pripojit YouTube
  // OAuth" vubec nevykreslila - nebylo se kam kliknout a kanal se nedal
  // pripojit znovu. Ted je to fail-closed: "pripojene" znamena, ze tokenem
  // opravdu dostala odpoved od YouTube.
  it("youtube-status je fail-closed, ne pinda jen na existenci radku", () => {
    const raw = readFileSync("supabase/functions/youtube-status/index.ts", "utf8");
    // komentáře nepočítáme - popisují to samé (jen celořádkové, aby se nesahalo na // uvnitr URL)
    const fn = raw.split("\n").map((l) => (l.trimStart().startsWith("//") ? "" : l)).join("\n");
    // jediny connected: true je az za overenim odpovedi od YouTube
    const trues = [...fn.matchAll(/connected:\s*true/g)];
    expect(trues, "connected: true smi byt jen jednou").toHaveLength(1);
    const trueAt = fn.indexOf("connected: true");
    const proofAt = Math.max(
      fn.indexOf("oauth2.googleapis.com/token"),
      fn.indexOf("youtube/v3/channels"),
    );
    expect(proofAt, "chybi overeni tokenu").toBeGreaterThan(-1);
    expect(trueAt, "connected: true pred overenim tokenu").toBeGreaterThan(proofAt);
    // odmítnutý token musí skončit connected: false, ne tichým connected: true
    expect(fn).toContain("invalid_grant");
    expect(fn).toContain("token_revoked");
    expect(fn).toContain('reason === "invalid_grant"');
    // a nesmí se tím vrátit žádný citlivý údaj
    for (const m of fn.matchAll(/json\(\s*\{([\s\S]*?)\}/g)) {
      expect(m[1]).not.toContain("refresh_token");
      expect(m[1]).not.toContain("access_token");
    }
  });

  it("youtube-status neni kosmetika: pripojeni se da znovu", () => {
    const fn = readFileSync("supabase/functions/youtube-status/index.ts", "utf8");
    const falses = [...fn.matchAll(/connected:\s*false/g)];
    // radku v tabulce, chybi verifier, neplatny nebo odmity token, chybi kanal,
    // YouTube neodpovida -> kazda z tech cest musi vratit connected: false
    expect(falses.length, "malo cest, kde se hlasi nepripojeno").toBeGreaterThanOrEqual(4);
    expect(fn).toContain("Kanál připoj znovu");
    expect(fn).toContain("AbortSignal.timeout(15_000)");
  });

  it("only knows render types the DB constraint allows", () => {
    const known = ['"static_cover"', '"image_animation"', '"full_scenes"', '"video_loop"'];
    for (const type of known) expect(worker).toContain(`type === ${type}`);
    expect(worker).toContain("Unknown video type");
  });

  it("runs every pass over a seamless source", () => {
    // Regrese: zdrojové video neni smycka, takze linearni pruchod delsii nez
    // zbytek zdroje se zasekl o tvrdy skok (po 121 snimcich).
    expect(engine).toContain("buildSeamlessBase");
    expect(engine).toContain("smooth.mp4");
    expect(engine).toContain("xfade=transition=fade");
    // prichody nesmi kreslit primo ze zdroje
    expect(engine).toContain("source = smooth;");
  });

  it("supports both aspect ratios from the same pass render", () => {
    expect(engine).toContain('aspect !== "16:9" && aspect !== "9:16"');
    expect(engine).toContain("{ w: 1080, h: 1920 }");
    expect(engine).toContain("pad=");
    // 16:9 nesmí jít přes filtr, jinak by se zbytečně překódoval
    expect(engine).toContain("null[v]");
  });

  it("declares a plan the join logic can satisfy", () => {
    // kazdy prechod spotrebuje T snimku, takze plan musi mit rezervu
    expect(engine).toContain("deficit");
    expect(engine).toContain("joinFrames");
    // 'cut' musi pokracovat presne od konce predchoziho pruchodu
    expect(engine).toContain("endFrame");
  });

  it("does not re-decode a still image for every frame of a short", () => {
    // Regrese: `-loop 1` na vstupu rozbalil PNG znovu pro kazdy snimek a
    // 24 s verticalniho klipu trvalo na 2jádrové VM 7 minut. `loop` filtr
    // (size=1) si snimek v pameti podrzi - 3x rychleji, vysledek bitove stejny.
    const shortClip = gallery.slice(
      gallery.indexOf("async function shortContentClip"),
      gallery.indexOf("export async function buildShortVideo"),
    );
    expect(shortClip).toContain("loop=loop=-1:size=1:start=0");
    expect(shortClip).not.toContain('"-loop", "1"');
  });

  // Regrese 8. 10. 2026: request() vraci SUROVE JSON z odpovedi, ne obalku
  // { data, error } - tak to chodi v celem tomhle workeru. Galerie ale psala
  // `const { data: rows, error: mediaError } = await request(...)`, takze rows
  // bylo vzdy undefined a mediaError vzdy undefined. Chyba se nevyvolala, radky
  // se nevykreslily a engine dostal prazdne scény.
  it("nerozbiji si data z PostgREST, request() vraci surove json", () => {
    expect(worker).toContain("return response.status === 204 ? null : response.json()");
    // nesmi se to nikde rozbalovat jako { data, error }
    const bad = [...worker.matchAll(/const\s*\{\s*data\s*:\s*(\w+)\s*,\s*error\s*:\s*(\w+)\s*\}\s*=\s*await request\(/g)];
    expect(bad.map((m) => `${m[1]}/${m[2]}`), "zbytek obalky { data, error } z request()").toEqual([]);
    // galerie si tohle musi vyridit sama a rucit si tvar
    expect(worker).toContain("Array.isArray(rowsResult)");
    expect(worker).toContain("neočekávaný tvar odpovědi");
  });

  it("drzi vystup pod limitkem bucketu - CRF nesmi bezel vyborne kvality", () => {
    // Regrese: gallery_videos padaly na "Upload failed 400 Payload too large".
    // Bucket ma limit 50 MB, proto je CRF u vystupu zvednute - 20 delalo prilis
    // velke soubory.
    //
    // Pozor: CRF 18 v workeru je MEZIKROK (krátky usek, ze kterého se pak skládá
    // celé video), ten se nikdy neodesílá a kvalita v nem ma byt maximalni.
    // Kontrolujeme proto jen místa, ze kterych opravdu vzniká soubor do bucketu.
    const upload = worker.slice(worker.indexOf("async function prepareUpload"), worker.indexOf("async function processJob"));
    const uploadCrf = Number(/"-crf",\s*"(\d+)"/.exec(upload)?.[1]);
    expect(uploadCrf, "prepareUpload nema CRF").toBeGreaterThanOrEqual(28);

    const galleryEncode = [...gallery.matchAll(/"-crf",\s*"(\d+)"/g)].map((m) => Number(m[1]));
    expect(galleryEncode, "gallery ma mit dva kodovace (16:9 a 9:16)").toHaveLength(2);
    for (const c of galleryEncode) {
      expect(c, `CRF ${c} je moc nizke, soubory pretecou limit 50 MB`).toBeGreaterThanOrEqual(25);
      expect(c, `CRF ${c} je moc vysoke, kvalita spadne`).toBeLessThanOrEqual(33);
    }

    // a pred uploadem se nesmi rezolut preskočit pres limit
    expect(worker).toContain("Compressed video is still too large");
    expect(worker).toContain("const target = `${file}.upload.mp4`");
  });
});
