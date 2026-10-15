import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { isAllowedPrivateUser, privateAccessMessage } from "../_shared/access.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });

/**
 * Servisní konzole: účty, zálohy a obnovy.
 *
 * Tato funkce NESAHÁ na soubory a nezná 1,3 GB archivu. Zálohu staví worker
 * na Oracle VM, tady je jen evidence úlohy, stav a podepsaná adresa ke stažení.
 * Stejné rozdělení jako u renderu videí: řádek v tabulce = úloha, worker vybere.
 *
 * Kdo sem smí:
 *   1. přihlášený uživatel (JWT ověřený tady, ne jen gateway)
 *   2. v produkčním allowlistu SONGCRAFT_ALLOWED_USER_IDS / _EMAILS
 *   3. vypsaný v tabulce sc_service_accounts
 *
 * Příznak služby je záměrně v tabulce a NE v auth.users.user_metadata -
 * metadata si uživatel přepíše sám přes klienta.
 */

/** Tabulky, které patří uživateli. Záměrný seznam, ne výběr z katalogu. */
const OWNED_TABLES = [
  "sc_albums", "sc_lyrics", "sc_songs", "sc_audio_versions", "sc_rhyme_words",
  "sc_style_prompts", "sc_cover_jobs", "sc_video_jobs", "sc_song_media",
  "agent_settings", "agent_conversations", "agent_messages", "agent_recommendations",
  "agent_action_log", "agent_image_assets", "agent_videos", "agent_media_uploads",
  "agent_channel_stats", "agent_content_calendar", "agent_confirmations", "agent_ops",
  "youtube_publications", "youtube_stats", "youtube_oauth_states", "motion_recipes",
] as const;

/**
 * Vyloženo záměrně:
 *   youtube_credentials               refresh token od Google. Kdyby byl v
 *                                    archivu stažitelném na telefon, znamenalo
 *                                    by to přístup na kanál. Při obnově se
 *                                    nepřenáší, kanál se propojí novým OAuth.
 *   _backup_agent_videos_20261005     mrtvá ruční záloha z 5. 10. 2026, mimo
 *                                    RLS již opravená v 20261015000002.
 */
const NEVER_EXPORTED = ["youtube_credentials", "_backup_agent_videos_20261005"] as const;

const ACTIONS = [
  "list_users", "create_user", "start_backup", "prepare_restore", "confirm_restore",
  "job_status", "cancel_job", "list_service_accounts", "grant_service", "revoke_service",
] as const;
type Action = (typeof ACTIONS)[number];

const BACKUP_BUCKET = "songcraft-backups";
const NONCE_TTL_MS = 15 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function hashToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Porovnání v konstantním čase, stejně jako agent-confirm a youtube-publish. */
function sameBytes(left: string, right: string) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}

function newNonce() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json({ error: `Nepovolená metoda ${request.method}, použij POST.` }, 405);

  const authorization = request.headers.get("Authorization");
  const url = Deno.env.get("SUPABASE_URL") || Deno.env.get("SONGCRAFT_SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SONGCRAFT_SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SONGCRAFT_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return json({ error: "Chybí konfigurace serveru." }, 503);
  if (!authorization) return json({ error: "Chybí přihlášení." }, 401);

  const auth = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: authError } = await auth.auth.getUser();
  if (authError || !user) return json({ error: "Neplatné přihlášení." }, 401);
  if (!isAllowedPrivateUser(user, { allowedUserIds: Deno.env.get("SONGCRAFT_ALLOWED_USER_IDS") ?? undefined, allowedEmails: Deno.env.get("SONGCRAFT_ALLOWED_EMAILS") ?? undefined })) {
    return json({ error: privateAccessMessage() }, 403);
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { data: serviceAccount, error: serviceError } = await admin
    .from("sc_service_accounts")
    .select("label")
    .eq("user_id", user.id)
    .maybeSingle();
  if (serviceError) return json({ error: "Služební účty se nepodařilo načíst." }, 502);
  if (!serviceAccount) return json({ error: "Tento účet nemá právo servisní konzole." }, 403);

  const input = await request.json().catch(() => null) as Record<string, unknown> | null;
  const action = input?.action;
  if (typeof action !== "string" || !ACTIONS.includes(action as Action)) {
    return json({ error: `Neznámá akce. Povolené jsou: ${ACTIONS.join(", ")}.` }, 400);
  }

  /**
   * agent_action_log je append-only (trigger v 20260925010000 zablokuje UPDATE
   * i DELETE), takže průběh nejde přepsat. Proto každá operace, která něco mění,
   * zapíše řádek `pending` PŘED zásahem a druhý až s výsledkem. Když selže
   * zápis `pending`, operace se vůbec nekoná - raději stop, než změna bez stopy.
   */
  const audit = async (entry: { actionType: string; result: "pending" | "success" | "error"; payload?: Record<string, unknown>; error?: string }) => {
    const { error } = await admin.from("agent_action_log").insert({
      user_id: user.id,
      action_type: entry.actionType,
      payload: entry.payload ?? {},
      result: entry.result,
      error_message: entry.error ? entry.error.slice(0, 500) : null,
    });
    return !error;
  };

  const deny = async (actionName: string, status: number, message: string) => {
    await audit({ actionType: `service:${actionName}`, result: "error", error: message });
    return json({ error: message }, status);
  };

  const adminHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
  const adminUsers = `${url}/auth/v1/admin/users`;

  // ---------------------------------------------------------------- list_users
  if (action === "list_users") {
    const usersResponse = await fetch(`${adminUsers}?per_page=200`, { headers: adminHeaders, signal: AbortSignal.timeout(15_000) });
    if (!usersResponse.ok) return await deny(action, 502, "Seznam účtů se nepodařilo načíst.");
    const payload = await usersResponse.json();
    const users: { id: string; email?: string; user_metadata?: Record<string, unknown> }[] = payload?.users ?? [];

    const { data: services } = await admin.from("sc_service_accounts").select("user_id,label");
    const serviceIds = new Map((services ?? []).map((row) => [row.user_id, row.label]));

    // Počty řádků na uživatele. Jeden průchod na tabulku místo dotazu per
    // uživatel per tabulka - jinak by to bylo 26 × N HTTP volání.
    // Stránkování ručně, protože PostgREST defaultně vrátí jen 1 000 řádků
    // a tichý úbytek by se v konzoli projevil jen jako chybný počet.
    const counts = new Map<string, Record<string, number>>();
    for (const table of OWNED_TABLES) {
      let from = 0;
      const page = 1000;
      for (;;) {
        const { data, error: pageError } = await admin
          .from(table)
          .select("user_id")
          .order("user_id", { ascending: true })
          .range(from, from + page - 1);
        if (pageError) return await deny(action, 502, `Počty v tabulce ${table} se nepodařilo načíst.`);
        const rows = (data ?? []) as { user_id: string }[];
        for (const row of rows) {
          const entry = counts.get(row.user_id) ?? {};
          entry[table] = (entry[table] ?? 0) + 1;
          counts.set(row.user_id, entry);
        }
        if (rows.length < page) break;
        from += page;
      }
    }

    const { data: objects } = await admin.storage.from("songcraft").list("", { limit: 1000 });
    const filesByUser = new Map<string, number>();
    for (const entry of objects ?? []) {
      const owner = entry.name.split("/")[0];
      filesByUser.set(owner, (filesByUser.get(owner) ?? 0) + 1);
    }

    return json({
      users: users.map((row) => ({
        id: row.id,
        email: row.email ?? null,
        displayName: (row.user_metadata?.display_name as string) ?? null,
        isService: serviceIds.has(row.id),
        serviceLabel: serviceIds.get(row.id) ?? null,
        rows: counts.get(row.id) ?? {},
        totalRows: Object.values(counts.get(row.id) ?? {}).reduce((sum, value) => sum + value, 0),
        files: filesByUser.get(row.id) ?? 0,
      })),
      tables: OWNED_TABLES,
      neverExported: NEVER_EXPORTED,
    });
  }

  // ---------------------------------------------------------- list_service_*
  if (action === "list_service_accounts") {
    const { data } = await admin
      .from("sc_service_accounts")
      .select("user_id,label,created_at")
      .order("created_at", { ascending: true });
    return json({ serviceAccounts: data ?? [] });
  }

  // -------------------------------------------------------------- create_user
  if (action === "create_user") {
    const email = typeof input?.email === "string" ? input.email.trim().toLowerCase() : "";
    const password = typeof input?.password === "string" ? input.password : "";
    const displayName = typeof input?.displayName === "string" ? input.displayName.trim() : "";
    if (!EMAIL.test(email)) return await deny(action, 400, "E-mail nemá platný tvar.");
    if (password.length < 8) return await deny(action, 400, "Heslo musí mít alespoň 8 znaků.");
    if (displayName.length < 1 || displayName.length > 80) return await deny(action, 400, "Jméno musí mít 1 až 80 znaků.");

    if (!await audit({ actionType: "service:create_user", result: "pending", payload: { email, displayName } })) {
      return json({ error: "Zápis auditu selhal, účet nebyl založen." }, 500);
    }

    const created = await fetch(adminUsers, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { display_name: displayName } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!created.ok) {
      const reason = (await created.json().catch(() => null))?.msg ?? (await created.text().catch(() => `HTTP ${created.status}`));
      await audit({ actionType: "service:create_user", result: "error", payload: { email, displayName }, error: String(reason) });
      return json({ error: `Účet se nepodařilo založit: ${String(reason).slice(0, 200)}` }, created.status === 422 ? 409 : 502);
    }
    const user = await created.json();

    await audit({ actionType: "service:create_user", result: "success", payload: { userId: user?.id, email, displayName } });
    return json({
      userId: user?.id ?? null,
      email,
      message: "Účet založený. Aby mohl volat AI funkce, přidej ho do SONGCRAFT_ALLOWED_EMAILS a funkce znovu nasaď - přihlášení do aplikace tím pádem nepotřebuje nic.",
      warnings: [
        "Edge funkce (AI, obálky, texty, nahrávání) povolují uživatele přes SONGCRAFT_ALLOWED_EMAILS / SONGCRAFT_ALLOWED_USER_IDS. Nový účet tam zatím není, takže se v aplikaci přihlásí, ale AI funkce mu neodpovědí.",
        "Účet se navíc musí objevit na přihlašovací obrazovce aplikace (app/auth.tsx), jinak se v něm nelze vybrat.",
      ],
    });
  }

  // ------------------------------------------------------- grant/revoke service
  if (action === "grant_service" || action === "revoke_service") {
    const target = typeof input?.userId === "string" ? input.userId.trim() : "";
    const label = typeof input?.label === "string" ? input.label.trim() : "";
    if (!UUID.test(target)) return await deny(action, 400, "userId musí být UUID.");
    if (action === "grant_service" && (label.length < 1 || label.length > 80)) return await deny(action, 400, "Jméno musí mít 1 až 80 znaků.");

    const { data: exists } = await admin.auth.admin.getUserById(target);
    if (!exists?.user) return await deny(action, 404, "Takový účet neexistuje.");

    if (!await audit({ actionType: `service:${action}`, result: "pending", payload: { userId: target, label } })) {
      return json({ error: "Zápis auditu selhal, změna nebyla provedena." }, 500);
    }

    const result = action === "grant_service"
      ? await admin.from("sc_service_accounts").upsert({ user_id: target, label, granted_by: user.id }, { onConflict: "user_id" })
      : await admin.from("sc_service_accounts").delete().eq("user_id", target);
    if (result.error) {
      await audit({ actionType: `service:${action}`, result: "error", payload: { userId: target }, error: result.error.message });
      return json({ error: "Změna se nepodařilo uložit." }, 502);
    }
    await audit({ actionType: `service:${action}`, result: "success", payload: { userId: target, label } });
    return json({ ok: true });
  }

  // -------------------------------------------------------------- start_backup
  if (action === "start_backup") {
    const open = await admin.from("sc_service_backups").select("id").in("status", ["queued", "running"]).limit(1);
    if (open.data && open.data.length > 0) return await deny(action, 409, "Běží už jiná záloha nebo obnova. Počkej, ať doběhne.");

    if (!await audit({ actionType: "service:start_backup", result: "pending" })) {
      return json({ error: "Zápis auditu selhal, záloha nebyla spuštěna." }, 500);
    }
    const { data, error } = await admin
      .from("sc_service_backups")
      .insert({ kind: "backup", mode: "full", requested_by: user.id })
      .select("id,kind,mode,status,created_at")
      .single();
    if (error) {
      await audit({ actionType: "service:start_backup", result: "error", error: error.message });
      return json({ error: "Zálohu se nepodařilo založit." }, 502);
    }
    await audit({ actionType: "service:start_backup", result: "success", payload: { jobId: data.id } });
    return json({ job: data, message: "Záloha je ve frontě. Renderer ji vybere do 30 sekund." });
  }

  // ----------------------------------------------------------- prepare_restore
  if (action === "prepare_restore") {
    const mode = input?.mode;
    if (mode !== "restore_existing" && mode !== "restore_new") {
      return await deny(action, 400, "Režim obnovy musí být restore_existing nebo restore_new.");
    }
    const sourceBackupId = typeof input?.sourceBackupId === "string" ? input.sourceBackupId.trim() : "";
    const targetUserId = typeof input?.targetUserId === "string" ? input.targetUserId.trim() : "";
    if (!UUID.test(sourceBackupId)) return await deny(action, 400, "sourceBackupId musí být UUID hotové zálohy.");
    if (mode === "restore_existing" && !UUID.test(targetUserId)) return await deny(action, 400, "restore_existing potřebuje UUID účtu, jehož data se nahradí.");

    const { data: source } = await admin
      .from("sc_service_backups")
      .select("id,kind,status,archive_path")
      .eq("id", sourceBackupId)
      .maybeSingle();
    if (!source) return await deny(action, 404, "Zdrojová záloha nenalezena.");
    if (source.kind !== "backup" || source.status !== "done" || !source.archive_path) {
      return await deny(action, 409, "Zdrojová záloha ještě není hotová.");
    }

    let destinationUserId = targetUserId;
    let idMap: Record<string, string> = {};
    if (mode === "restore_new") {
      const email = typeof input?.email === "string" ? input.email.trim().toLowerCase() : "";
      const password = typeof input?.password === "string" ? input.password : "";
      const displayName = typeof input?.displayName === "string" ? input.displayName.trim() : "";
      if (!EMAIL.test(email)) return await deny(action, 400, "restore_new potřebuje platný e-mail.");
      if (password.length < 8) return await deny(action, 400, "Heslo musí mít alespoň 8 znaků.");
      if (displayName.length < 1 || displayName.length > 80) return await deny(action, 400, "Jméno musí mít 1 až 80 znaků.");

      if (!await audit({ actionType: "service:prepare_restore", result: "pending", payload: { mode, sourceBackupId, email } })) {
        return json({ error: "Zápis auditu selhal, obnova nebyla připravena." }, 500);
      }
      const created = await fetch(adminUsers, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { display_name: displayName } }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!created.ok) {
        const reason = String((await created.json().catch(() => null))?.msg ?? created.status);
        await audit({ actionType: "service:prepare_restore", result: "error", payload: { mode, email }, error: reason });
        return json({ error: `Nový účet se nepodařilo založit: ${reason.slice(0, 200)}` }, created.status === 422 ? 409 : 502);
      }
      const fresh = await created.json();
      destinationUserId = fresh.id;
      // Přesná podoba id_mapu naplní worker, až bude číst manifest. Tady
      // zaznamenáváme jen to, že cílový účet vznikl, aby se to dalo do auditu.
      idMap = { created: fresh.id };
    }

    const nonce = newNonce();
    const { data, error } = await admin
      .from("sc_service_backups")
      .insert({
        kind: "restore",
        mode,
        status: "awaiting_confirmation",
        source_backup_id: sourceBackupId,
        target_user_id: destinationUserId || null,
        id_map: idMap,
        requested_by: user.id,
        confirm_nonce_hash: await hashToken(nonce),
        confirm_expires_at: new Date(Date.now() + NONCE_TTL_MS).toISOString(),
      })
      .select("id,kind,mode,status,target_user_id,confirm_expires_at")
      .single();
    if (error) {
      await audit({ actionType: "service:prepare_restore", result: "error", payload: { mode, sourceBackupId }, error: error.message });
      return json({ error: "Obnovu se nepodařilo připravit." }, 502);
    }
    await audit({ actionType: "service:prepare_restore", result: "success", payload: { jobId: data.id, mode, targetUserId: destinationUserId } });

    return json({
      job: data,
      confirmationToken: nonce,
      message: mode === "restore_existing"
        ? "Tato obnova MAŽE data cílového účtu a pak je naplní ze zálohy. Vlož token potvrzení."
        : "Účet byl založen. Vlož token potvrzení a obnova se spustí.",
      warnings: [
        "youtube_credentials se nepřenáší - kanál bude potřeba připojit znovu přes OAuth.",
        "Nový účet bude potřeba přidat do SONGCRAFT_ALLOWED_EMAILS, jinak mu AI funkce neodpovědí.",
      ],
    });
  }

  // ----------------------------------------------------------- confirm_restore
  if (action === "confirm_restore") {
    const jobId = typeof input?.jobId === "string" ? input.jobId.trim() : "";
    const nonce = typeof input?.confirmationToken === "string" ? input.confirmationToken : "";
    if (!UUID.test(jobId) || !nonce) return await deny(action, 400, "Chybí jobId nebo confirmationToken.");

    const { data: job } = await admin
      .from("sc_service_backups")
      .select("id,status,mode,confirm_nonce_hash,confirm_expires_at,requested_by")
      .eq("id", jobId)
      .maybeSingle();
    if (!job) return await deny(action, 404, "Obnova nenalezena.");
    if (job.status !== "awaiting_confirmation") return await deny(action, 409, `Obnova už je ve stavu ${job.status}.`);
    if (!job.confirm_expires_at || new Date(job.confirm_expires_at).getTime() < Date.now()) {
      return await deny(action, 409, "Potvrzovací token vypršel. Připrav obnovu znovu.");
    }
    // Samotné ID úlohy není potvrzení - bez shody hashe se nespustí.
    if (!sameBytes(await hashToken(nonce), String(job.confirm_nonce_hash ?? ""))) {
      await audit({ actionType: "service:confirm_restore", result: "error", payload: { jobId }, error: "neplatný potvrzovací token" });
      return json({ error: "Potvrzovací token není platný." }, 403);
    }

    if (!await audit({ actionType: "service:confirm_restore", result: "pending", payload: { jobId, mode: job.mode } })) {
      return json({ error: "Zápis auditu selhal, obnova se nespustila." }, 500);
    }

    const { data: claimed, error: claimError } = await admin
      .from("sc_service_backups")
      .update({ status: "queued", confirm_nonce_hash: null, confirm_expires_at: null, started_at: null })
      .eq("id", jobId)
      .eq("status", "awaiting_confirmation")
      .select("id,kind,mode,status,target_user_id,source_backup_id")
      .single();
    if (claimError || !claimed) return await deny(action, 409, "Obrovu už někdo potvrdil.");

    await audit({ actionType: "service:confirm_restore", result: "success", payload: { jobId, mode: claimed.mode } });
    return json({ job: claimed, message: "Potvrzeno. Obnova běží na rendereru." });
  }

  // ---------------------------------------------------------------- job_status
  if (action === "job_status") {
    const jobId = typeof input?.jobId === "string" ? input.jobId.trim() : "";
    let query = admin.from("sc_service_backups")
      .select("id,kind,mode,status,target_user_id,source_backup_id,archive_path,archive_bytes,manifest,progress,error_message,created_at,started_at,finished_at")
      .order("created_at", { ascending: false })
      .limit(20);
    if (jobId) {
      if (!UUID.test(jobId)) return await deny(action, 400, "jobId musí být UUID.");
      query = query.eq("id", jobId);
    }
    const { data: jobs, error } = await query;
    if (error) return json({ error: "Úlohy se nepodařilo načíst." }, 502);

    const withUrls = [] as Record<string, unknown>[];
    for (const job of (jobs ?? []) as Record<string, unknown>[]) {
      const entry = { ...job };
      if (job.status === "done" && typeof job.archive_path === "string" && job.archive_path) {
        const signed = await admin.storage.from(BACKUP_BUCKET).createSignedUrl(job.archive_path, 3600, { download: true });
        entry.downloadUrl = signed.data?.signedUrl ?? null;
      }
      withUrls.push(entry);
    }
    return json({ jobs: withUrls });
  }

  // ---------------------------------------------------------------- cancel_job
  if (action === "cancel_job") {
    const jobId = typeof input?.jobId === "string" ? input.jobId.trim() : "";
    if (!UUID.test(jobId)) return await deny(action, 400, "jobId musí být UUID.");
    const { data: job } = await admin.from("sc_service_backups").select("id,status,kind").eq("id", jobId).maybeSingle();
    if (!job) return await deny(action, 404, "Úloha nenalezena.");
    if (!["queued", "running", "awaiting_confirmation"].includes(String(job.status))) {
      return await deny(action, 409, `Úloha už je ve stavu ${job.status} a nedá se zrušit.`);
    }
    if (!await audit({ actionType: "service:cancel_job", result: "pending", payload: { jobId } })) {
      return json({ error: "Zápis auditu selhal, úloha nebyla zrušena." }, 500);
    }
    const { error } = await admin.from("sc_service_backups")
      .update({ status: "canceled", finished_at: new Date().toISOString() })
      .eq("id", jobId)
      .in("status", ["queued", "running", "awaiting_confirmation"]);
    if (error) {
      await audit({ actionType: "service:cancel_job", result: "error", payload: { jobId }, error: error.message });
      return json({ error: "Zrušení se nepodařilo uložit." }, 502);
    }
    await audit({ actionType: "service:cancel_job", result: "success", payload: { jobId } });
    return json({ ok: true, message: "Úloha je zrušená. Pokud už běží, renderer ji přestane zpracovávat při dalším kroku." });
  }

  return json({ error: "Neznámá akce." }, 400);
});