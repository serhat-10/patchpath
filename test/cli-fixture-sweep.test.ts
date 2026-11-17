import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// Runs the built CLI on every package-lock fixture with a fake fetch; nothing touches the network.
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const FAKE_FETCH = pathToFileURL(fileURLToPath(new URL("./helpers/fake-fetch.mjs", import.meta.url))).href;
const LOCKS = ["lock-v3.json", "shared-transitive/package-lock.json"];

function scanJson(lock: string) {
  const dir = mkdtempSync(join(tmpdir(), "patchpath-sweep-"));
  try {
    copyFileSync(fileURLToPath(new URL(`./fixtures/${lock}`, import.meta.url)), join(dir, "package-lock.json"));
    const lockText = readFileSync(join(dir, "package-lock.json"), "utf8");
    const names = Object.keys((JSON.parse(lockText) as { packages: Record<string, { version?: string }> }).packages)
      .filter((k) => k.includes("node_modules/"));
    const vulns: Record<string, unknown> = {};
    names.forEach((k, i) => {
      const name = k.slice(k.lastIndexOf("node_modules/") + 13);
      const version = (JSON.parse(lockText) as { packages: Record<string, { version?: string }> }).packages[k]?.version;
      if (version && i % 2 === 0) vulns[`${name}@${version}`] = { id: `GHSA-${i}`, severity: "HIGH", fixed: "99.0.0" };
    });
    const result = spawnSync(process.execPath, ["--import", FAKE_FETCH, CLI, dir, "--no-cache", "--json"], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, NO_COLOR: "1", PATCHPATH_FAKE_FETCH: JSON.stringify({ vulns }) },
    });
    return { status: result.status, out: result.stdout, err: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const strip = (text: string) => JSON.stringify({ ...JSON.parse(text), scannedAt: undefined, requests: undefined, root: undefined, lockfile: undefined });

describe.each(LOCKS)("json output for fixture %s", (lock) => {
  it("is valid JSON with integer counts, no NaN, and no zero advisoriesIntroduced", () => {
    const { out, err } = scanJson(lock);
    expect(err).not.toMatch(/TypeError|at .*\.js:\d+/);
    const report = JSON.parse(out) as { planSummary?: Record<string, number> };
    expect(out).not.toMatch(/NaN|Infinity|undefined/);
    for (const [key, value] of Object.entries(report.planSummary ?? {})) {
      expect(Number.isInteger(value), key).toBe(true);
    }
    if (report.planSummary) expect(report.planSummary.advisoriesIntroduced).not.toBe(0);
  });
  it("gives identical output on a second run apart from the timestamp", () => {
    expect(strip(scanJson(lock).out)).toBe(strip(scanJson(lock).out));
  });
});
