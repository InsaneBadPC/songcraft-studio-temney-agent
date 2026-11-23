import { supabase } from "@/lib/supabase";

export const YOUTUBE_OAUTH_REDIRECT_URL = process.env.EXPO_PUBLIC_YOUTUBE_OAUTH_REDIRECT_URL || "http://localhost";

export async function createYouTubeAuthorizationUrl() {
  const { data, error } = await supabase.functions.invoke("youtube-oauth-start", { body: { redirectUri: YOUTUBE_OAUTH_REDIRECT_URL } });
  if (error) throw new Error(error.message || "YouTube připojení se nepodařilo zahájit.");
  const url = (data as { authorizationUrl?: unknown } | null)?.authorizationUrl;
  if (typeof url !== "string" || !/^https:\/\/accounts\.google\.com\//i.test(url)) throw new Error("YouTube vrátil neplatnou autorizační adresu.");
  return url as string;
}

export async function exchangeYouTubeCode(code: string, state: string) {
  const { data, error } = await supabase.functions.invoke("youtube-oauth-exchange", { body: { code, state } });
  if (error) throw new Error(error.message || "YouTube token se nepodařilo uložit.");
  const result = data as { connected?: unknown; channelId?: unknown; channelTitle?: unknown; reason?: unknown; error?: unknown } | null;
  if (result?.connected !== true) {
    const reason = typeof result?.reason === "string" ? result.reason : typeof result?.error === "string" ? result.error : null;
    throw new Error(reason ?? "YouTube token se nepodařilo uložit.");
  }
  return {
    connected: true as const,
    channelId: typeof result.channelId === "string" ? result.channelId : null,
    channelTitle: typeof result.channelTitle === "string" ? result.channelTitle : null,
  };
}
