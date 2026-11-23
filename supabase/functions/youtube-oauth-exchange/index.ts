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

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method !== "POST") return json({ connected: false, reason: "method_not_allowed" }, 405);

  const authorization = request.headers.get("Authorization");
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || Deno.env.get("SONGCRAFT_SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SONGCRAFT_SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SONGCRAFT_SERVICE_ROLE_KEY");
  const clientId = Deno.env.get("YOUTUBE_CLIENT_ID");
  const clientSecret = Deno.env.get("YOUTUBE_CLIENT_SECRET");
  if (!supabaseUrl || !anonKey || !serviceKey || !clientId || !clientSecret) return json({ connected: false, reason: "not_configured" }, 503);
  if (!authorization) return json({ connected: false, reason: "missing_login" }, 401);

  const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: authError } = await auth.auth.getUser();
  if (authError || !user) return json({ connected: false, reason: "invalid_login" }, 401);
  if (!isAllowedPrivateUser(user, { allowedUserIds: Deno.env.get("SONGCRAFT_ALLOWED_USER_IDS") ?? undefined, allowedEmails: Deno.env.get("SONGCRAFT_ALLOWED_EMAILS") ?? undefined })) return json({ connected: false, reason: privateAccessMessage() }, 403);

  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const state = typeof body.state === "string" ? body.state.trim() : "";
  if (!code || !state || state.length > 256 || code.length > 2048) return json({ connected: false, reason: "invalid_request" }, 400);

  const admin = createClient(supabaseUrl, serviceKey);
  const { data: stateRow, error: stateError } = await admin
    .from("youtube_oauth_states")
    .select("id,user_id,code_verifier,redirect_uri,expires_at,consumed_at")
    .eq("state_hash", await sha256(state))
    .eq("user_id", user.id)
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (stateError || !stateRow) return json({ connected: false, reason: "invalid_state" }, 400);

  const { data: claimed, error: claimError } = await admin
    .from("youtube_oauth_states")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", stateRow.id)
    .eq("user_id", user.id)
    .is("consumed_at", null)
    .select("id,user_id,code_verifier")
    .maybeSingle();
  if (claimError || !claimed) return json({ connected: false, reason: "state_already_used" }, 400);

  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, code_verifier: stateRow.code_verifier, grant_type: "authorization_code", redirect_uri: stateRow.redirect_uri }),
      signal: AbortSignal.timeout(20_000),
    });
    const token = await tokenResponse.json().catch(() => null) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error_description?: string } | null;
    if (!tokenResponse.ok || !token?.access_token) return json({ connected: false, reason: token?.error_description ?? "token_exchange_failed" }, 400);

    const channelResponse = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&mine=true", { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(20_000) });
    const channelBody = await channelResponse.json().catch(() => null) as { items?: Array<{ id?: string; snippet?: { title?: string } }> } | null;
    const channelId = channelBody?.items?.[0]?.id;
    if (!channelResponse.ok || !channelId) return json({ connected: false, reason: "channel_lookup_failed" }, 502);

    const existing = await admin.from("youtube_credentials").select("refresh_token").eq("user_id", claimed.user_id).maybeSingle();
    const refreshToken = token.refresh_token || existing.data?.refresh_token || null;
    const { error: saveError } = await admin.from("youtube_credentials").upsert({
      user_id: claimed.user_id,
      access_token: token.access_token,
      refresh_token: refreshToken,
      expires_at: new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString(),
      channel_id: channelId,
      scopes: token.scope?.split(" ").filter(Boolean) ?? [],
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    if (saveError) return json({ connected: false, reason: "credential_save_failed" }, 502);
    return json({ connected: true, channelId, channelTitle: channelBody.items?.[0]?.snippet?.title ?? null });
  } catch {
    return json({ connected: false, reason: "oauth_failed" }, 502);
  }
});
