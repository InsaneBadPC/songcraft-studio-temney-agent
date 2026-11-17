import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();

vi.mock("../lib/supabase", () => ({
  supabase: {
    functions: { invoke: (...args: unknown[]) => invoke(...args) },
  },
}));

import { clearMediaUrlCache, isAbsoluteUrl, isR2Path, mediaStorageKey, resolveMediaUrl, signMediaPaths } from "../lib/media-url";

describe("media-url", () => {
  afterEach(() => {
    clearMediaUrlCache();
    invoke.mockReset();
  });

  it("rozpozná R2 cesty a absolutní URL", () => {
    expect(isR2Path("r2://songcraft-studio/u/covers/a.jpg")).toBe(true);
    expect(isR2Path("u/covers/a.jpg")).toBe(false);
    expect(isAbsoluteUrl("https://cdn.example.test/a.jpg")).toBe(true);
    expect(isAbsoluteUrl("r2://songcraft-studio/u/a.jpg")).toBe(false);
    expect(isAbsoluteUrl(null)).toBe(false);
  });

  it("mediaStorageKey vrátí cestu, ne URL", () => {
    expect(mediaStorageKey("r2://songcraft-studio/u/a.jpg")).toBe("r2://songcraft-studio/u/a.jpg");
    expect(mediaStorageKey("https://cdn.example.test/a.jpg")).toBeNull();
    expect(mediaStorageKey(null)).toBeNull();
  });

  it("podepíše celý balík JEDNÍM requestem (sign_batch)", async () => {
    invoke.mockResolvedValueOnce({
      data: { urls: { "u/a.jpg": "https://r2.test/a", "u/b.jpg": "https://r2.test/b" } },
      error: null,
    });

    const urls = await signMediaPaths(["u/a.jpg", "u/b.jpg", "u/a.jpg", null, undefined, ""]);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][1].body.action).toBe("sign_batch");
    expect(invoke.mock.calls[0][1].body.paths).toEqual(["u/a.jpg", "u/b.jpg"]);
    expect(urls["u/a.jpg"]).toBe("https://r2.test/a");
    expect(urls["u/b.jpg"]).toBe("https://r2.test/b");
  });

  it("druhý dotaz na stejné cesty jde z cache (0 requestů)", async () => {
    invoke.mockResolvedValueOnce({ data: { urls: { "u/a.jpg": "https://r2.test/a" } }, error: null });

    await signMediaPaths(["u/a.jpg"]);
    const again = await signMediaPaths(["u/a.jpg"]);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(again["u/a.jpg"]).toBe("https://r2.test/a");
  });

  it("podepisuje jen cesty, které v cache nejsou", async () => {
    invoke.mockResolvedValueOnce({ data: { urls: { "u/a.jpg": "https://r2.test/a" } }, error: null });
    await signMediaPaths(["u/a.jpg"]);

    invoke.mockResolvedValueOnce({ data: { urls: { "u/b.jpg": "https://r2.test/b" } }, error: null });
    const urls = await signMediaPaths(["u/a.jpg", "u/b.jpg"]);

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][1].body.paths).toEqual(["u/b.jpg"]);
    expect(urls["u/a.jpg"]).toBe("https://r2.test/a");
    expect(urls["u/b.jpg"]).toBe("https://r2.test/b");
  });

  it("resolveMediaUrl propustí absolutní URL bez requestu", async () => {
    expect(await resolveMediaUrl("https://cdn.example.test/a.jpg")).toBe("https://cdn.example.test/a.jpg");
    expect(invoke).not.toHaveBeenCalled();
    expect(await resolveMediaUrl(null)).toBeNull();
  });

  it("při chybě edge funkce vrátí jen to, co má v cache (nespadne)", async () => {
    invoke.mockResolvedValueOnce({ data: null, error: { message: "nedostupné" } });
    const urls = await signMediaPaths(["u/a.jpg"]);
    expect(urls).toEqual({});
  });
});
