import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { isAllowedPrivateUser, privateAccessMessage } from "../_shared/access.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });

/**
 * Zda je kanál připojený. Záměrně NEVRACÍ tokeny.
 *
 * Tabulka youtube_credentials má záměrně žádnou policy pro client role, aby
 * aplikace nikdy nemohla přečíst refresh token. Tato funkce běží se service
 * role a vrací jen příznak, titul kanálu a datum připojení — nic citlivého.
 *
 * Proč to potřebujeme: tlačítko „Připojit YouTube OAuth“ v Nastavení hází
 * redirect_uri_mismatch, pokud u Google klíče chybí adresa funkce. Aplikace
 * tak musí umět říct „je to připojené“ i bez stisknutí tlačítka.
 */
Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  // supabase.functions.invoke() posílá POST, i když funkce nic nepřijímá.
  // Když se povolí jen GET, klient dostane 405 „Použijte GET“ a appka to
  // vyloží jako „nepodařilo se ověřit“. Proto bereme obojí.
  if (request.method !== "GET" && request.method !== "POST") {
    return json({ error: `Nepovolená metoda ${request.method}, použij GET.` }, 405);
  }
  const authorization = request.headers.get("Authorization");
  const url = Deno.env.get("SUPABASE_URL") || Deno.env.get("SONGCRAFT_SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SONGCRAFT_SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SONGCRAFT_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) return json({ error: "Chybí konfigurace serveru." }, 503);
  if (!authorization) return json({ error: "Chybí přihlášení." }, 401);

  const auth = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: authError } = await auth.auth.getUser();
  if (authError || !user) return json({ error: "Neplatné přihlášení." }, 401);
  if (!isAllowedPrivateUser(user, { allowedUserIds: Deno.env.get("SONGCRAFT_ALLOWED_USER_IDS") ?? undefined, allowedEmails: Deno.env.get("SONGCRAFT_ALLOWED_EMAILS") ?? undefined })) return json({ error: privateAccessMessage() }, 403);

  const admin = createClient(url, serviceKey);
  const { data, error } = await admin
    .from("youtube_credentials")
    .select("channel_id,updated_at")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) return json({ error: "Stav kanálu se nepodařilo načíst." }, 502);

  if (!data?.channel_id) {
    return json({
      connected: false,
      message: "Kanál není připojený.",
    });
  }

  // Tady to bylo fail-open a to byl důvod, proč se kanál nedal připojit znovu:
  // jakmile v tabulce existoval jakýkoliv řádek, funkce vrátila connected: true,
  // i kdyby Google token dávno odmítl. Aplikace pak ukázala zelenou kartu
  // „Připojeno. Nahrávání i publikace fungují" a tlačítko „Připojit YouTube
  // OAuth" vůbec nevykreslila - nebylo se kam kliknout.
  //
  // Fail-closed: „připojené" znamená, že jsem tokenem opravdu dostal odpověď
  // od YouTube. Když to nedokážu, řeknu to a vrátím důvod.
  //
  // Důvody, které Google vrací:
  //   invalid_grant - token byl odmítnut nebo odvolán (nejčastěji consent
  //                  screen v režimu Testing, který Google zruší po 7 dnech)
  //   401/403 na channels API - token prošel, ale nesmí tenhle kanál
  const { data: credential } = await admin
    .from("youtube_credentials")
    .select("access_token,refresh_token,expires_at")
    .eq("user_id", user.id)
    .maybeSingle();

  let bearer = credential?.access_token ?? null;
  const expired = !credential?.expires_at ||
    new Date(credential.expires_at).getTime() < Date.now() + 60_000;

  if (expired) {
    const clientId = Deno.env.get("YOUTUBE_CLIENT_ID");
    const clientSecret = Deno.env.get("YOUTUBE_CLIENT_SECRET");
    if (!credential?.refresh_token) {
      return json({
        connected: false,
        message: "Uložený přihlašovací údaj nemá čím obnovit práva. Kanál připoj znovu.",
      });
    }
    if (!clientId || !clientSecret) {
      return json({ connected: false, message: "Chybí konfigurace Google klíče. Kanál připoj znovu." });
    }
    const refreshed = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: credential.refresh_token,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!refreshed.ok) {
      const reason = (await refreshed.json().catch(() => null))?.error ?? `HTTP ${refreshed.status}`;
      if (reason === "invalid_grant") {
        return json({
          connected: false,
          code: "token_revoked",
          message:
            "Google odmítl obnovit oprávnění, souhlas byl odvolán nebo vypršel. V Google Cloud přepni OAuth consent screen z režimu Testing na Production a pak kanál připoj znovu - jinak token umře zase po sedmi dnech.",
        });
      }
      return json({ connected: false, message: `Google oprávnění neobnovil (${reason}). Zkus to prosím znovu.` });
    }
    const payload = await refreshed.json();
    bearer = payload.access_token ?? null;
    await admin
      .from("youtube_credentials")
      .update({
        access_token: payload.access_token,
        expires_at: new Date(Date.now() + Number(payload.expires_in ?? 3600) * 1000).toISOString(),
      })
      .eq("user_id", user.id);
  }

  if (!bearer) {
    return json({ connected: false, message: "Oprávnění k kanálu nejsou k dispozici. Připoj kanál znovu." });
  }

  // Důkaz, že token fakt funguje. Titul kanálu vezmeme ze stejné odpovědi.
  let channelTitle = "YouTube kanál";
  let channelResponse: Response;
  try {
    channelResponse = await fetch(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      { headers: { Authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(15_000) },
    );
  } catch {
    return json({ connected: false, message: "YouTube neodpověděl. Zkus to prosím znovu." });
  }
  if (!channelResponse.ok) {
    return json({
      connected: false,
      message: channelResponse.status === 401 || channelResponse.status === 403
        ? "Oprávnění k kanálu už neplatí. Připoj kanál znovu."
        : `YouTube vrátil ${channelResponse.status}. Zkus to prosím znovu.`,
    });
  }
  const payload = await channelResponse.json().catch(() => null);
  const resolved = payload?.items?.[0];
  if (!resolved?.id) {
    return json({ connected: false, message: "YouTube nevrátil žádný kanál. Připoj kanál znovu." });
  }

  return json({
    connected: true,
    channelId: resolved.id,
    channelTitle: resolved.snippet?.title ?? channelTitle,
    connectedAt: data.updated_at,
  });
});
