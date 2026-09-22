import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = Deno.env.get("SUPABASE_URL"); const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"); if (!url || !service) return json({ error: "Chybí konfigurace." }, 503);
  const admin = createClient(url, service); const input = await request.json().catch(() => ({})) as { userId?: string };
  let query = admin.from("youtube_credentials").select("user_id,access_token,channel_id").limit(100); if (input.userId) query = query.eq("user_id", input.userId); const { data: credentials, error } = await query; if (error) return json({ error: error.message }, 502);
  let synced = 0;
  for (const credential of credentials ?? []) {
    if (!credential.access_token || !credential.channel_id) continue;
    const response = await fetch(`https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==${encodeURIComponent(credential.channel_id)}&startDate=2000-01-01&endDate=${new Date().toISOString().slice(0, 10)}&metrics=views,estimatedMinutesWatched,averageViewDuration,likes,comments,subscribersGained&dimensions=day&sort=-day&maxResults=30`, { headers: { Authorization: `Bearer ${credential.access_token}` } });
    if (!response.ok) continue; const report = await response.json().catch(() => null) as { rows?: Array<Array<string | number>> } | null;
    for (const values of report?.rows ?? []) { const date = String(values[0]); const { data: publications } = await admin.from("youtube_publications").select("id").eq("user_id", credential.user_id).eq("status", "published").limit(100); for (const publication of publications ?? []) { await admin.from("youtube_stats").upsert({ user_id: credential.user_id, youtube_publication_id: publication.id, date, views: Number(values[1]) || 0, watch_time_minutes: Number(values[2]) || 0, avg_view_duration_seconds: Number(values[3]) || 0, likes: Number(values[4]) || 0, comments: Number(values[5]) || 0, subscribers_gained: Number(values[6]) || 0 }, { onConflict: "youtube_publication_id,date" }); } synced += 1; }
  }
  return json({ synced });
});
