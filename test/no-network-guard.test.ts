import { afterEach, describe, expect, it, vi } from "vitest";

describe("no-network guard", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects an unstubbed fetch and names the URL", async () => {
    await expect(fetch("https://example.invalid/x")).rejects.toThrow(
      "test tried to reach the real network: https://example.invalid/x",
    );
    await expect(fetch(new URL("https://example.invalid/u"))).rejects.toThrow(/example\.invalid\/u/);
  });

  it("lets a test stub fetch, and brings the guard back after unstubAllGlobals", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    expect(await (await fetch("https://example.invalid/y")).text()).toBe("ok");
    vi.unstubAllGlobals();
    await expect(fetch("https://example.invalid/y")).rejects.toThrow(/real network/);
  });

  it("restores the guard after a spyOn is restored", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("spied"));
    expect(await (await fetch("https://example.invalid/z")).text()).toBe("spied");
    spy.mockRestore();
    await expect(fetch("https://example.invalid/z")).rejects.toThrow(/real network/);
  });
});
