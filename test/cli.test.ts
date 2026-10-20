import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// End-to-end: the built CLI (test/global-setup.ts builds it) in a real child process, with
// fetch replaced by test/helpers/fake-fetch.mjs. Nothing here touches the network.
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const FAKE_FETCH = pathToFileURL(fileURLToPath(new URL("./helpers/fake-fetch.mjs", import.meta.url))).href;

interface Vuln {
  id: string;
  severity: string;
  fixed: string;
}

let dir: string;
let log: string;

function run(args: string[], vulns: Record<string, Vuln> | "offline" = {}, registry?: Record<string, unknown>) {
  rmSync(log, { force: true });
  const started = Date.now();
  const result = spawnSync(process.execPath, ["--import", FAKE_FETCH, CLI, dir, "--no-cache", ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      NO_COLOR: "1",
      PATCHPATH_DEBUG: "",
      PATCHPATH_FAKE_FETCH: vulns === "offline" ? "offline" : JSON.stringify({ vulns, registry }),
      PATCHPATH_FAKE_LOG: log,
    },
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  } catch {
    // no call was made
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, ms: Date.now() - started, calls };
}

const pub = (name: string, version: string, extra: Record<string, unknown> = {}) => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`,
  ...extra,
});
const mirror = (name: string, version: string) => ({
  version,
  resolved: `https://artifactory.corp.example/api/npm/npm-remote/${name}/-/${name}-${version}.tgz`,
});
const writeLock = (packages: Record<string, unknown>) =>
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages }));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "patchpath-cli-"));
  log = join(dir, "fetch.log");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("cli", () => {
  it("fails fast and cleanly when offline", () => {
    // Like the 95-package demo project: far more packages than parallel registry lookups.
    const packages: Record<string, unknown> = { "": { dependencies: { p0: "^1.0.0" } } };
    for (let i = 0; i < 95; i++) packages[`node_modules/p${i}`] = pub(`p${i}`, "1.0.0");
    writeLock(packages);

    const r = run([], "offline");
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("patchpath: Could not reach api.osv.dev (ENOTFOUND). Are you offline?\n");
    expect(r.stderr).not.toMatch(/\n\s+at /);
    // ~3.5 s of retry back-off for the OSV query, then the process must end. Before the fix it
    // kept retrying registry lookups for ~28 s.
    expect(r.ms).toBeLessThan(12_000);
    // 4 OSV attempts + at most 12 parallel registry lookups x 4 attempts; the rest are cancelled.
    // Before the fix: 376 calls.
    expect(r.calls.length).toBeLessThanOrEqual(4 + 12 * 4);
  });

  it("rejects an unknown option with exit code 2 and no stack trace", () => {
    writeLock({ "": {} });
    const r = run(["--bogus"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^patchpath: .*--bogus.*\n$/);
    expect(r.stderr).not.toMatch(/\n\s+at /);
    expect(r.calls).toEqual([]);
  });

  it("accepts --include-pinned-lag and documents it in --help", () => {
    writeLock({ "": { dependencies: { a: "1.0.0" } }, "node_modules/a": pub("a", "1.0.0") });
    const r = run(["--include-pinned-lag", "--no-plan"]);
    expect(r.code).toBe(0);
    const help = run(["--help"]);
    expect(help.stdout).toContain("--include-pinned-lag");
  });

  it("keeps devOptional packages under --no-dev: they are installed in production", () => {
    writeLock({
      "": { dependencies: { app: "^1.0.0" }, devDependencies: { opt: "^1.0.0", tool: "^1.0.0" } },
      "node_modules/app": pub("app", "1.0.0", { optionalDependencies: { opt: "^1.0.0" } }),
      "node_modules/opt": pub("opt", "1.0.0", { devOptional: true, optional: true }),
      "node_modules/tool": pub("tool", "1.0.0", { dev: true }),
    });
    const r = run(["--no-dev", "--json"], { "opt@1.0.0": { id: "GHSA-opt", severity: "HIGH", fixed: "1.0.1" } });
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.summary.packages).toBe(2);
    expect(report.findings.map((f: { name: string }) => f.name)).toEqual(["opt"]);
    expect(report.findings[0].dev).toBe(false);
  });

  it("prints valid JSON with no control characters from hostile lockfile names or via chains", () => {
    const hostile = "evil\u001b]0;PWNED\u0007‮\u{E0041}x";
    writeLock({
      "": { dependencies: { [hostile]: "^1.0.0" } },
      [`node_modules/${hostile}`]: pub("evil", "1.0.0", { dependencies: { victim: "^1.0.0" } }),
      "node_modules/victim": pub("victim", "1.0.0"),
    });
    const r = run(["--json"], { "victim@1.0.0": { id: "GHSA-victim", severity: "LOW", fixed: "1.0.1" } });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/[\u0000-\u0009\u000b-\u001f]/);
    const report = JSON.parse(r.stdout);
    const victim = report.findings.find((f: { name: string }) => f.name === "victim");
    expect(victim.via).toHaveLength(1);
    // JSON.stringify escapes control characters, so check the parsed strings themselves.
    const strings: string[] = [];
    JSON.parse(r.stdout, (_key, value) => {
      if (typeof value === "string") strings.push(value);
      return value;
    });
    for (const s of strings) expect(s).not.toMatch(/[\u0000-\u001f\u007f-\u009f‮\u{E0000}-\u{E007F}]/u);
    expect(victim.via[0]).toContain("PWNED");
    // the text report is clean too
    const text = run([], { "victim@1.0.0": { id: "GHSA-victim", severity: "LOW", fixed: "1.0.1" } });
    expect(text.stdout).not.toMatch(/[\u001b\u0007‮]/);
  });

  it("prints the upgrade plan first, and skips it with --no-plan", () => {
    writeLock({
      "": { dependencies: { express: "^4.17.1" } },
      "node_modules/express": pub("express", "4.17.1", { dependencies: { qs: "6.7.0" } }),
      "node_modules/qs": pub("qs", "6.7.0"),
    });
    const vulns = { "qs@6.7.0": { id: "GHSA-qs", severity: "HIGH", fixed: "6.10.0" } };
    const registry = {
      express: { versions: { "4.17.1": { dependencies: { qs: "6.7.0" } }, "4.18.0": { dependencies: { qs: "~6.11.0" } } } },
      qs: { versions: { "6.7.0": {}, "6.11.0": {}, "6.11.1": {} } },
    };
    const r = run([], vulns, registry);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Upgrade plan.*\n  express 4\.17\.1 -> 4\.18\.0: clears 1 advisory \(worst high\), non-breaking\n/);
    expect(r.stdout).toContain("covered by upgrading express");
    const plain = run(["--no-plan", "--json"], vulns, registry);
    expect(plain.code).toBe(0);
    expect(JSON.parse(plain.stdout).plan).toEqual([]);
    // The report's batch and the check of the "fixed in" version; none for the planner.
    expect(plain.calls.filter((c) => c.includes("/querybatch"))).toHaveLength(2);
  });

  describe("fail-closed --fail-on", () => {
    const vulns = { "lodash@4.17.15": { id: "GHSA-lodash", severity: "HIGH", fixed: "4.17.21" } };
    const mirrored = () =>
      writeLock({
        "": { dependencies: { lodash: "^4.17.0", minimist: "^1.0.0" } },
        "node_modules/lodash": mirror("lodash", "4.17.15"),
        "node_modules/minimist": mirror("minimist", "1.2.0"),
      });

    it("exits 3 when nothing could be checked, and says how to fix it", () => {
      mirrored();
      const r = run(["--fail-on", "low"], vulns);
      expect(r.code).toBe(3);
      expect(r.calls).toEqual([]);
      expect(r.stdout).not.toContain("No known vulnerabilities.");
      expect(r.stdout).toContain("Nothing was checked: 2 packages were not checked");
      expect(r.stderr).toMatch(/2 packages were not checked \(exit code 3\)/);
      expect(r.stderr).toContain("--registry");
      expect(r.stderr).toContain("--assume-public");
      expect(r.stderr.trim().split("\n")).toHaveLength(1);
    });

    it("exits 0 with --allow-unchecked, and without --fail-on", () => {
      mirrored();
      expect(run(["--fail-on", "low", "--allow-unchecked"], vulns).code).toBe(0);
      expect(run([], vulns).code).toBe(0);
    });

    it("checks mirror packages with --registry and exits 1 above the threshold", () => {
      mirrored();
      const r = run(["--fail-on", "high", "--registry", "https://artifactory.corp.example/api/npm/npm-remote/"], vulns);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain("GHSA-lodash");
      expect(r.calls.some((c) => c.includes("lodash"))).toBe(true);
    });

    it("still exits 1 when the threshold is exceeded and some packages were unchecked", () => {
      writeLock({
        "": { dependencies: { lodash: "^4.17.0", "@corp/secret": "^1.0.0" } },
        "node_modules/lodash": pub("lodash", "4.17.15"),
        "node_modules/@corp/secret": { version: "1.0.0" },
      });
      const r = run(["--fail-on", "moderate"], vulns);
      expect(r.code).toBe(1);
      expect(r.calls.join("\n")).not.toContain("secret");
    });

    it("checks entries without a resolved URL with --assume-public", () => {
      writeLock({
        "": { dependencies: { lodash: "^4.17.0" } },
        "node_modules/lodash": { version: "4.17.15" },
      });
      expect(run(["--fail-on", "critical"], vulns).code).toBe(3);
      expect(run(["--fail-on", "critical", "--assume-public"], vulns).code).toBe(0);
      expect(run(["--fail-on", "high", "--assume-public"], vulns).code).toBe(1);
    });
  });
});

describe("cli on yarn v1 and pnpm lockfiles", () => {
  const copyFixture = (folder: string, files: string[]) => {
    for (const file of files) copyFileSync(new URL(`./fixtures/${folder}/${file}`, import.meta.url), join(dir, file));
  };
  const lookedUp = (calls: string[]) => calls.join("\n");

  it("yarn v1: findings, exit codes, JSON field, and never an npm command or a private name", () => {
    copyFixture("yarn-v1", ["yarn.lock", "package.json"]);
    const vulns = { "qs@6.5.1": { id: "GHSA-qs", severity: "HIGH", fixed: "6.5.3" } };

    const text = run(["--fail-on", "critical"], vulns);
    // Nothing critical, but 5 packages could not be checked: exit 3.
    expect(text.code).toBe(3);
    expect(text.stdout).toContain("upgrade plan is not available for yarn/pnpm lockfiles yet");
    expect(text.stdout).toContain("qs@6.5.1 (transitive) -> fixed in 6.5.3");
    expect(text.stdout).not.toMatch(/^\s*(npm|yarn|pnpm) /m);
    expect(lookedUp(text.calls)).not.toMatch(/corp-secret|corp\.example|evil/);

    expect(run(["--fail-on", "high"], vulns).code).toBe(1);
    expect(run(["--fail-on", "critical", "--allow-unchecked"], vulns).code).toBe(0);

    const json = run(["--json"], vulns);
    const report = JSON.parse(json.stdout) as Record<string, unknown>;
    expect(report.lockfileType).toBe("yarn-v1");
    expect(report.planUnavailable).toBe("upgrade plan is not available for yarn/pnpm lockfiles yet");
    expect(report.plan).toEqual([]);
    expect(report.commands).toBeUndefined();
    expect(report.suggestedOverrides).toEqual({});
  });

  it("pnpm 9: integrity-only entries need --assume-public; private names never leave; no npm command", () => {
    copyFixture("pnpm-9", ["pnpm-lock.yaml"]);
    const vulns = {
      "qs@6.5.1": { id: "GHSA-qs", severity: "MODERATE", fixed: "6.5.3" },
      "lodash@4.17.15": { id: "GHSA-lodash", severity: "CRITICAL", fixed: "4.17.21" },
    };
    const closed = run(["--fail-on", "high"], vulns);
    expect(closed.code).toBe(3);
    expect(closed.stderr).toMatch(/21 packages were not checked/);
    expect(lookedUp(closed.calls)).not.toMatch(/lodash|corp-secret|corp\.example|evil/);

    const open = run(["--fail-on", "high", "--assume-public"], vulns);
    expect(open.code).toBe(1);
    expect(open.stdout).toContain("upgrade plan is not available for yarn/pnpm lockfiles yet");
    expect(open.stdout).not.toMatch(/^\s*(npm|yarn|pnpm) /m);
    expect(lookedUp(open.calls)).not.toMatch(/corp-secret-(alias|gh|git|local|mismatch|ws)|@corp-secret|corp\.example|evil/);

    const json = JSON.parse(run(["--json", "--assume-public"], vulns).stdout) as Record<string, unknown>;
    expect(json.lockfileType).toBe("pnpm-9");
    expect(json.planUnavailable).toBe("upgrade plan is not available for yarn/pnpm lockfiles yet");
    expect(json.commands).toBeUndefined();
    expect(json.suggestedOverrides).toEqual({});
  });

  it("rejects a pnpm 8 lockfile with exit code 2", () => {
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '6.0'\n\ndependencies: {}\n");
    const r = run([], {});
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/only lockfile version 9\.0/);
    expect(r.calls).toEqual([]);
  });

  it("names the other lockfiles when a folder has several", () => {
    copyFixture("yarn-v1", ["yarn.lock", "package.json"]);
    writeLock({ "": { dependencies: { lodash: "^4.17.0" } }, "node_modules/lodash": pub("lodash", "4.17.21") });
    const r = run(["--json"], {});
    const report = JSON.parse(r.stdout) as { lockfileType: string; warnings: string[] };
    expect(report.lockfileType).toBe("npm");
    expect(report.warnings.join("\n")).toMatch(/Several lockfiles in this folder: read package-lock\.json .*not yarn\.lock/);
  });

  it("rejects a yarn berry lockfile with exit code 2", () => {
    writeFileSync(join(dir, "yarn.lock"), '__metadata:\n  version: 6\n\n"a@npm:^1.0.0":\n  version: 1.0.0\n');
    const r = run([], {});
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/yarn v2\+ \(berry\)/);
    expect(r.calls).toEqual([]);
  });
});

describe("cli report paths do not leak the local user name", () => {
  const fixture = () => {
    const base = mkdtempSync(join(tmpdir(), "patchpath-user-"));
    const proj = join(base, "myproj");
    mkdirSync(proj);
    writeFileSync(
      join(proj, "package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/a": pub("a", "1.0.0") } }),
    );
    return { base, proj };
  };
  const exec = (cwd: string, target: string, flag: string, home?: string) =>
    spawnSync(process.execPath, ["--import", FAKE_FETCH, CLI, target, "--no-cache", flag], {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        ...(home ? { HOME: home, USERPROFILE: home } : {}),
        NO_COLOR: "1",
        PATCHPATH_FAKE_FETCH: JSON.stringify({ vulns: {} }),
        PATCHPATH_FAKE_LOG: join(cwd, "fetch.log"),
      },
    });

  it("shows paths relative to the cwd (root is .)", () => {
    const { base, proj } = fixture();
    try {
      const report = JSON.parse(exec(proj, ".", "--json").stdout);
      expect(report.root).toBe(".");
      expect(report.lockfile).toBe("package-lock.json");
      const text = exec(proj, ".", "--no-plan").stdout;
      expect(text.split("\n")[0]).toContain("package-lock.json");
      expect(text).not.toContain("patchpath-user-");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("shows ~ for a project outside the cwd but under the home directory", () => {
    const { base, proj } = fixture();
    const elsewhere = mkdtempSync(join(tmpdir(), "patchpath-else-"));
    try {
      const r = exec(elsewhere, proj, "--json", base);
      const report = JSON.parse(r.stdout);
      expect(report.root).toBe(["~", "myproj"].join(sep));
      expect(report.lockfile).toBe(["~", "myproj", "package-lock.json"].join(sep));
      expect(r.stdout).not.toContain(base);
      const text = exec(elsewhere, proj, "--no-plan", base).stdout;
      expect(text).not.toContain(base);
    } finally {
      rmSync(base, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
