import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// End to end through the built CLI with the fake fetch: plan summary, text wording, exit codes.
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const FAKE_FETCH = pathToFileURL(fileURLToPath(new URL("./helpers/fake-fetch.mjs", import.meta.url))).href;

const pub = (name: string, version: string, extra: Record<string, unknown> = {}) => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
  ...extra,
});
const packument = (versions: Record<string, Record<string, unknown>>) => ({ "dist-tags": { latest: Object.keys(versions).at(-1) }, versions });
const vulns = { "shared@1.0.0": { id: "GHSA-shared", severity: "high", fixed: "1.2.0" } };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "patchpath-cli2-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[], registry: Record<string, unknown>) {
  const r = spawnSync(process.execPath, ["--import", FAKE_FETCH, CLI, dir, "--no-cache", ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, NO_COLOR: "1", PATCHPATH_FAKE_FETCH: JSON.stringify({ vulns, registry }) },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const lock = (packages: Record<string, unknown>) =>
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "t", lockfileVersion: 3, packages }));

const registry = {
  shared: packument({ "1.0.0": {}, "1.2.0": {} }),
  alpha: packument({ "1.0.0": { dependencies: { shared: "^1.0.0" } }, "1.1.0": { dependencies: { shared: "^1.2.0" } } }),
  beta: packument({ "1.0.0": { dependencies: { shared: "~1.0.0" } } }),
};

describe("cli: plan summary and exit codes", () => {
  it("shared package kept open by beta: 1 of 2 paths, 0 of 1 advisories", () => {
    lock({
      "": { dependencies: { alpha: "^1.0.0", beta: "^1.0.0" } },
      "node_modules/alpha": pub("alpha", "1.0.0", { dependencies: { shared: "^1.0.0" } }),
      "node_modules/beta": pub("beta", "1.0.0", { dependencies: { shared: "~1.0.0" } }),
      "node_modules/shared": pub("shared", "1.0.0"),
    });
    const j = run(["--json"], registry);
    const report = JSON.parse(j.out);
    expect(report.planSummary).toEqual({ pathsTotal: 2, pathsFixed: 1, pathsRemaining: 1, advisoriesTotal: 1, advisoriesEliminated: 0 });
    const alpha = report.plan.find((e: { name: string }) => e.name === "alpha");
    expect(alpha).toMatchObject({ status: "upgrade", clears: { count: 0 }, paths: { total: 2, fixed: 1, remaining: 1 }, stillReachedVia: ["beta"] });
    const text = run([], registry).out;
    expect(text).toContain("removes 1 of 2 vulnerable paths, clears no advisory");
    expect(text).toContain("still reached through: beta");
    expect(text).toContain("Paths fixed: 1 of 2. Advisories eliminated project-wide: 0 of 1.");
    expect(text).toContain("estimated to remove 1 vulnerable path in this step; 1 advisory stays open");
  });

  it("sole dependent: 1 of 1 path, 1 of 1 advisory, no path-only wording", () => {
    lock({
      "": { dependencies: { alpha: "^1.0.0" } },
      "node_modules/alpha": pub("alpha", "1.0.0", { dependencies: { shared: "^1.0.0" } }),
      "node_modules/shared": pub("shared", "1.0.0"),
    });
    const report = JSON.parse(run(["--json"], registry).out);
    expect(report.planSummary).toEqual({ pathsTotal: 1, pathsFixed: 1, pathsRemaining: 0, advisoriesTotal: 1, advisoriesEliminated: 1 });
    const text = run([], registry).out;
    expect(text).toContain("Paths fixed: 1 of 1.");
    expect(text).not.toContain("removes 1 of");
    expect(text).not.toMatch(/1 vulnerable paths/);
  });

  it("--fail-on exit codes do not depend on plan status or --no-plan", () => {
    lock({
      "": { dependencies: { alpha: "^1.0.0", beta: "^1.0.0" } },
      "node_modules/alpha": pub("alpha", "1.0.0", { dependencies: { shared: "^1.0.0" } }),
      "node_modules/beta": pub("beta", "1.0.0", { dependencies: { shared: "~1.0.0" } }),
      "node_modules/shared": pub("shared", "1.0.0"),
    });
    for (const level of ["low", "high", "critical"]) {
      const withPlan = run(["--fail-on", level, "--json"], registry);
      const without = run(["--fail-on", level, "--json", "--no-plan"], registry);
      expect(withPlan.code).toBe(without.code);
      expect(withPlan.code).toBe(level === "critical" ? 0 : 1);
    }
  });
});
