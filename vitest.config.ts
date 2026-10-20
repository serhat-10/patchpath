import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The CLI tests spawn the real dist/cli.js, so build it once before any test runs.
    globalSetup: ["./test/global-setup.ts"],
    // Blocks the real network in every test file; tests fake fetch themselves.
    setupFiles: ["./test/setup-no-network.ts"],
  },
});
