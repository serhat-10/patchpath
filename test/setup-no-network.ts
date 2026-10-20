// Runs before every test file (vitest `setupFiles`). Replaces the global fetch with one that throws,
// so a test that forgot to fake the network fails loudly instead of reaching the real one.
// Tests keep using vi.stubGlobal("fetch", ...) / vi.spyOn(globalThis, "fetch"); vi.unstubAllGlobals()
// and mockRestore() put this guard back, because it is the "original" they restore.
// Child processes (test/cli.test.ts) are covered separately by `--import test/helpers/fake-fetch.mjs`.
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  throw new Error(`test tried to reach the real network: ${url}`);
}) as typeof fetch;
