import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const client = readFileSync("lib/youtube-oauth.ts", "utf8");
const settings = readFileSync("app/(tabs)/settings.tsx", "utf8");
const start = readFileSync("supabase/functions/youtube-oauth-start/index.ts", "utf8");

describe("YouTube OAuth loopback login", () => {
  it("uses registered loopback redirect and requests it from the start function", () => {
    expect(client).toContain('process.env.EXPO_PUBLIC_YOUTUBE_OAUTH_REDIRECT_URL || "http://localhost"');
    expect(client).toContain("body: { redirectUri: YOUTUBE_OAUTH_REDIRECT_URL }");
    expect(client).toContain("export async function exchangeYouTubeCode");
  });

  it("exchanges the browser callback before reporting success", () => {
    expect(settings).toContain('result.type === "success" && result.url');
    expect(settings).toContain('searchParams.get("code")');
    expect(settings).toContain('searchParams.get("state")');
    expect(settings).toContain("exchangeYouTubeCode(code, state)");
    expect(settings).toContain("granted.connected");
    expect(settings).not.toContain('const YOUTUBE_REDIRECT = "https://eqgoedaydvwsuqgakpos.supabase.co/functions/v1/youtube-oauth-callback";');
  });

  it("accepts only allowlisted loopback redirect in the start function", () => {
    expect(start).toContain("requestedRedirectUri");
    expect(start).toContain("allowedRedirects");
    expect(start).toContain("redirect_uri: redirectUri");
  });

  it("has a token exchange function bound to the signed-in user", () => {
    const path = "supabase/functions/youtube-oauth-exchange/index.ts";
    expect(existsSync(path)).toBe(true);
    const exchange = readFileSync(path, "utf8");
    expect(exchange).toContain('eq("user_id", user.id)');
    expect(exchange).toContain("code_verifier");
    expect(exchange).toContain("redirect_uri: stateRow.redirect_uri");
    expect(exchange).toContain("youtube_credentials");
    expect(exchange).toContain("connected: true");
  });
});
