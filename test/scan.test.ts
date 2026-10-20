import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exceedsThreshold, formatText } from "../src/core/format.js";
import { scan } from "../src/core/scan.js";
import type { Report, Severity } from "../src/core/types.js";
import { UserError } from "../src/core/util.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const GHSA = {
  id: "GHSA-test-lodash",
  summary: "Prototype pollution in lodash",
  database_specific: { severity: "HIGH" },
  affected: [
    {
      package: { ecosystem: "npm", name: "lodash" },
      ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }],
    },
  ],
};

let requests: string[] = [];

/** Extra advisories for a test: `versions` are the affected versions, fixed in `fixed`. */
interface FakeAdvisory {
  id: string;
  name: string;
  versions: string[];
  fixed: string;
}
let advisories: FakeAdvisory[] = [];

const osvRecord = (a: FakeAdvisory) => ({
  id: a.id,
  summary: `test advisory for ${a.name}`,
  database_specific: { severity: "HIGH" },
  affected: [{ package: { ecosystem: "npm", name: a.name }, versions: a.versions, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: a.fixed }] }] }],
});

function fakeNetwork(url: string, init?: RequestInit): Response {
  requests.push(`${url} ${init?.body ?? ""}`);
  if (url.endsWith("/v1/querybatch")) {
    const { queries } = JSON.parse(String(init?.body)) as { queries: { package: { name: string }; version: string }[] };
    return json({
      results: queries.map((q) => {
        const ids = advisories.filter((a) => a.name === q.package.name && a.versions.includes(q.version)).map((a) => ({ id: a.id }));
        if (q.package.name === "lodash" && q.version === "4.17.15") ids.push({ id: GHSA.id });
        return ids.length ? { vulns: ids } : {};
      }),
    });
  }
  if (url.endsWith(`/v1/vulns/${GHSA.id}`)) return json(GHSA);
  const extra = advisories.find((a) => url.endsWith(`/v1/vulns/${a.id}`));
  if (extra) return json(osvRecord(extra));
  if (url.includes("registry.npmjs.org/")) {
    if (url.endsWith("/leftpad")) {
      return json({
        "dist-tags": { latest: "1.3.0" },
        versions: { "0.0.1": { deprecated: "use String.prototype.padStart \x1b]0;PWNED\x07" } },
      });
    }
    if (url.endsWith("/vitest")) return json({ "dist-tags": { latest: "3.0.0" }, versions: {} });
    if (url.endsWith("/lodash")) return json({ "dist-tags": { latest: "4.17.21" }, versions: {} });
    return json({ "dist-tags": { latest: "1.2.0" }, versions: {} });
  }
  return json({ error: `unexpected request ${url}` }, 500);
}

/** A lockfile entry resolved from the public registry. */
const pub = (name: string, version: string, extra: Record<string, unknown> = {}) => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`,
  ...extra,
});

describe("scan", () => {
  let dir: string;
  const writeLock = (packages: Record<string, unknown>) =>
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages }));

  beforeEach(() => {
    requests = [];
    advisories = [];
    dir = mkdtempSync(join(tmpdir(), "patchpath-"));
    copyFileSync(new URL("./fixtures/lock-v3.json", import.meta.url), join(dir, "package-lock.json"));
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => fakeNetwork(String(input), init)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it("combines vulnerabilities, deprecations and direct major lag, worst first", async () => {
    const report = await scan(dir, { cache: false });

    expect(report.summary.packages).toBe(5);
    expect(report.summary.vulnerabilities.high).toBe(1);
    expect(report.summary.deprecated).toBe(1);
    // Only direct dependencies count as lag: vitest 1.0.0 -> 3.0.0. Transitive leftpad does not.
    expect(report.summary.outdated.major).toBe(1);

    expect(report.findings.map((f) => f.name)).toEqual(["lodash", "leftpad", "vitest"]);
    const lodash = report.findings[0];
    expect(lodash).toMatchObject({ fixVersion: "4.17.21", fixIsBreaking: false });
    expect(lodash?.vulnerabilities[0]).toMatchObject({ id: GHSA.id, severity: "high", fixedIn: ["4.17.21"] });
  });

  it("lists the most severe advisory of a package first", async () => {
    const advisory = (id: string, severity: string) => ({
      id,
      database_specific: { severity },
      affected: [{ package: { ecosystem: "npm", name: "lodash" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }] }],
    });
    const base = (input: string | URL, init?: RequestInit) => fakeNetwork(String(input), init);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/v1/querybatch")) {
          const { queries } = JSON.parse(String(init?.body)) as { queries: { package: { name: string }; version: string }[] };
          return json({
            results: queries.map((q) =>
              q.package.name === "lodash" && q.version === "4.17.15"
                ? { vulns: [{ id: "A-LOW" }, { id: "B-CRIT" }, { id: "C-MOD" }] }
                : {},
            ),
          });
        }
        if (url.endsWith("/v1/vulns/A-LOW")) return json(advisory("A-LOW", "LOW"));
        if (url.endsWith("/v1/vulns/B-CRIT")) return json(advisory("B-CRIT", "CRITICAL"));
        if (url.endsWith("/v1/vulns/C-MOD")) return json(advisory("C-MOD", "MODERATE"));
        return base(input, init);
      }),
    );
    const report = await scan(dir, { cache: false });
    expect(report.findings[0]?.vulnerabilities.map((v) => v.id)).toEqual(["B-CRIT", "C-MOD", "A-LOW"]);
  });

  it("cleans maintainer-controlled text", async () => {
    const report = await scan(dir, { cache: false });
    const leftpad = report.findings.find((f) => f.name === "leftpad");
    expect(leftpad?.deprecated).toContain("padStart");
    expect(leftpad?.deprecated).not.toMatch(/[\x00-\x1f]/);
    expect(formatText(report, { color: false })).not.toContain("PWNED\x07");
  });

  it("can skip dev dependencies", async () => {
    const report = await scan(dir, { cache: false, includeDev: false });
    expect(report.summary.packages).toBe(3);
    expect(report.findings.map((f) => f.name)).not.toContain("vitest");
  });

  it("keeps going when a registry lookup fails and records a warning", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        return url.endsWith("/leftpad") ? json({}, 400) : fakeNetwork(url, init);
      }),
    );
    const report = await scan(dir, { cache: false });
    expect(report.warnings.some((w) => w.includes("leftpad"))).toBe(true);
    expect(report.findings.map((f) => f.name)).toContain("lodash");
  });

  describe("pinned dependencies", () => {
    const setupPinned = (spec: string) => {
      writeLock({
        "": { devDependencies: { vitest: spec } },
        "node_modules/vitest": pub("vitest", "1.0.0", { dev: true }),
      });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { vitest: spec } }));
    };

    it("hides major lag of an exact-pinned direct dependency by default", async () => {
      setupPinned("1.0.0");
      const report = await scan(dir, { cache: false, plan: false });
      expect(report.summary.outdated.major).toBe(0);
      expect(report.findings).toEqual([]);
      expect(formatText(report)).not.toContain("latest is 3.0.0");
    });

    it("shows it with includePinnedLag", async () => {
      setupPinned("1.0.0");
      const report = await scan(dir, { cache: false, plan: false, includePinnedLag: true });
      expect(report.summary.outdated.major).toBe(1);
      expect(formatText(report)).toContain("latest is 3.0.0");
    });

    it("still shows lag for a range, and always reports vulnerabilities of a pinned dependency", async () => {
      setupPinned("^1.0.0");
      expect((await scan(dir, { cache: false, plan: false })).summary.outdated.major).toBe(1);

      writeLock({
        "": { dependencies: { lodash: "4.17.15" } },
        "node_modules/lodash": pub("lodash", "4.17.15"),
      });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { lodash: "4.17.15" } }));
      const report = await scan(dir, { cache: false, plan: false });
      expect(report.findings.map((f) => f.name)).toEqual(["lodash"]);
      expect(report.summary.vulnerabilities.high).toBe(1);
    });
  });

  describe("privacy", () => {
    it("does not send packages from other registries anywhere", async () => {
      writeLock({
        "": { dependencies: { "@corp/secret": "^1.0.0", lodash: "^4.17.0" } },
        "node_modules/@corp/secret": { version: "1.0.0", resolved: "https://npm.corp.example/@corp/secret/-/secret-1.0.0.tgz" },
        "node_modules/lodash": pub("lodash", "4.17.15"),
      });
      const report = await scan(dir, { cache: false });
      expect(requests.join("\n")).not.toContain("secret");
      expect(report.summary.external).toBe(1);
      expect(report.warnings.join(" ")).toContain("not checked");
      expect(report.warnings.join(" ")).toContain("--registry");
    });

    it("never sends an entry without a resolved URL, but still checks bundled dependencies", async () => {
      writeLock({
        "": { dependencies: { "@corp/unresolved": "^1.0.0", bundler: "^1.0.0", "@corp/private-bundler": "^1.0.0" } },
        // npm leaves `resolved` out with omit-lockfile-registry-resolved, and for other cases too
        "node_modules/@corp/unresolved": { version: "1.0.0" },
        "node_modules/bundler": pub("bundler", "1.0.0"),
        "node_modules/bundler/node_modules/bundled-dep": { version: "2.0.0", inBundle: true },
        "node_modules/@corp/private-bundler": { version: "1.0.0", resolved: "https://npm.corp.example/x.tgz" },
        "node_modules/@corp/private-bundler/node_modules/private-bundled": { version: "1.0.0", inBundle: true },
      });
      const report = await scan(dir, { cache: false });
      const sent = requests.join("\n");
      expect(sent).not.toContain("unresolved");
      expect(sent).not.toContain("private-bundle");
      expect(sent).toContain("bundled-dep");
      expect(report.summary.external).toBe(3);
      expect(report.warnings.join(" ")).toContain("--assume-public");
    });

    it("checks entries without a resolved URL with assumePublic", async () => {
      writeLock({
        "": { dependencies: { lodash: "^4.17.0" } },
        "node_modules/lodash": { version: "4.17.15" },
      });
      const before = await scan(dir, { cache: false });
      expect(requests.join("\n")).not.toContain("lodash");
      expect(before.findings).toEqual([]);

      const report = await scan(dir, { cache: false, assumePublic: true });
      expect(report.summary.external).toBe(0);
      expect(report.findings.map((f) => f.name)).toEqual(["lodash"]);
    });

    it("checks packages resolved through a --registry mirror, matching on whole path segments", async () => {
      writeLock({
        "": { dependencies: { lodash: "^4.17.0", "@corp/secret": "^1.0.0" } },
        "node_modules/lodash": {
          version: "4.17.15",
          resolved: "https://artifactory.corp.example/api/npm/npm-remote/lodash/-/lodash-4.17.15.tgz",
        },
        "node_modules/@corp/secret": {
          version: "1.0.0",
          resolved: "https://artifactory.corp.example/api/npm/npm-remote-private/@corp/secret/-/secret-1.0.0.tgz",
        },
      });
      const without = await scan(dir, { cache: false });
      expect(without.summary.external).toBe(2);
      expect(requests).toEqual([]);

      const report = await scan(dir, { cache: false, registries: ["https://artifactory.corp.example/api/npm/npm-remote//"] });
      expect(report.summary.external).toBe(1);
      expect(report.findings.map((f) => f.name)).toEqual(["lodash"]);
      expect(requests.join("\n")).not.toContain("secret");
    });

    it("rejects a registry that is not an http(s) URL", async () => {
      await expect(scan(dir, { cache: false, registries: ["file:///etc"] })).rejects.toThrow(UserError);
    });
  });

  describe("suggested overrides", () => {
    it("pins a transitive package when every copy is on the fixed line", async () => {
      writeLock({
        "": { dependencies: { express: "^4.0.0", other: "^1.0.0" } },
        "node_modules/express": pub("express", "4.17.1", { dependencies: { lodash: "^4.17.0" } }),
        "node_modules/lodash": pub("lodash", "4.17.15"),
        "node_modules/other": pub("other", "1.0.0", { dependencies: { lodash: "4.17.10" } }),
        "node_modules/other/node_modules/lodash": pub("lodash", "4.17.10"),
      });
      const report = await scan(dir, { cache: false });
      expect(report.suggestedOverrides).toEqual({ lodash: "4.17.21" });
      const finding = report.findings.find((f) => f.name === "lodash");
      expect(finding?.via).toEqual(["express@4.17.1"]);
      const text = formatText(report);
      expect(text).toContain("via express@4.17.1");
      expect(text).toContain('"overrides"');
    });

    it("does not downgrade a copy that is already newer than the fix", async () => {
      advisories = [{ id: "GHSA-qs", name: "qs", versions: ["6.2.3"], fixed: "6.2.4" }];
      writeLock({
        "": { dependencies: { a: "^1.0.0", b: "^1.0.0" } },
        "node_modules/a": pub("a", "1.0.0", { dependencies: { qs: "6.2.3" } }),
        "node_modules/qs": pub("qs", "6.2.3"),
        "node_modules/b": pub("b", "1.0.0", { dependencies: { qs: "^6.9.0" } }),
        "node_modules/b/node_modules/qs": pub("qs", "6.9.7"),
      });
      const report = await scan(dir, { cache: false });
      expect(report.findings.find((f) => f.name === "qs")?.fixVersion).toBe("6.2.4");
      expect(report.suggestedOverrides).toEqual({});
    });

    it("does not force 0.x copies on different minor lines onto one version", async () => {
      advisories = [{ id: "GHSA-zero", name: "zero", versions: ["0.2.3"], fixed: "0.2.5" }];
      writeLock({
        "": { dependencies: { a: "^1.0.0", b: "^1.0.0" } },
        "node_modules/a": pub("a", "1.0.0", { dependencies: { zero: "^0.2.0" } }),
        "node_modules/zero": pub("zero", "0.2.3"),
        "node_modules/b": pub("b", "1.0.0", { dependencies: { zero: "^0.1.0" } }),
        "node_modules/b/node_modules/zero": pub("zero", "0.1.9"),
      });
      const report = await scan(dir, { cache: false });
      expect(report.findings.find((f) => f.name === "zero")?.fixVersion).toBe("0.2.5");
      expect(report.suggestedOverrides).toEqual({});
    });

    it("never overrides a name that is also a direct dependency (npm EOVERRIDE)", async () => {
      advisories = [{ id: "GHSA-dd", name: "dd", versions: ["1.1.4"], fixed: "1.1.5" }];
      writeLock({
        "": { dependencies: { dd: "1.0.0", a: "^1.0.0" } },
        "node_modules/dd": pub("dd", "1.0.0"),
        "node_modules/a": pub("a", "1.0.0", { dependencies: { dd: "1.1.4" } }),
        "node_modules/a/node_modules/dd": pub("dd", "1.1.4"),
      });
      const report = await scan(dir, { cache: false });
      expect(report.findings.find((f) => f.name === "dd")).toMatchObject({ direct: false, fixVersion: "1.1.5" });
      expect(report.suggestedOverrides).toEqual({});
    });

    it("does not let --no-dev hide a dev copy that the override would downgrade", async () => {
      advisories = [{ id: "GHSA-qs", name: "qs", versions: ["6.2.3"], fixed: "6.2.4" }];
      writeLock({
        "": { dependencies: { a: "^1.0.0" }, devDependencies: { tool: "^1.0.0" } },
        "node_modules/a": pub("a", "1.0.0", { dependencies: { qs: "6.2.3" } }),
        "node_modules/qs": pub("qs", "6.2.3"),
        "node_modules/tool": pub("tool", "1.0.0", { dev: true, dependencies: { qs: "^6.9.0" } }),
        "node_modules/tool/node_modules/qs": pub("qs", "6.9.7", { dev: true }),
      });
      const report = await scan(dir, { cache: false, includeDev: false });
      expect(report.findings.find((f) => f.name === "qs")?.fixVersion).toBe("6.2.4");
      expect(report.suggestedOverrides).toEqual({});
    });
  });

  it("formats a readable report and honours the fail-on threshold", async () => {
    const report = await scan(dir, { cache: false });
    const text = formatText(report);
    expect(text).toContain("lodash@4.17.15");
    // lodash is a direct dependency, so the advice is an upgrade (transitive ones say "fixed in")
    expect(text).toContain("upgrade to 4.17.21");
    expect(exceedsThreshold(report, "high")).toBe(true);
    expect(exceedsThreshold(report, "critical")).toBe(false);
  });

  it("reports a helpful error when there is no lockfile", async () => {
    const empty = mkdtempSync(join(tmpdir(), "patchpath-empty-"));
    try {
      await expect(scan(empty, { cache: false })).rejects.toThrow(UserError);
      writeFileSync(join(empty, "yarn.lock"), "");
      await expect(scan(empty, { cache: false })).rejects.toThrow(/yarn\.lock/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  describe("network failures", () => {
    /** Runs `fn` with faked retry back-off until it settles; real file I/O still happens in between. */
    async function withFakeBackoff<T>(fn: () => Promise<T>): Promise<T | unknown> {
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      try {
        let settled = false;
        const result = fn().catch((e: unknown) => e);
        void result.then(() => (settled = true));
        while (!settled) {
          await vi.advanceTimersByTimeAsync(1000);
          await new Promise((resolve) => setImmediate(resolve));
        }
        return await result;
      } finally {
        vi.useRealTimers();
      }
    }

    const offline = () => {
      const error = new TypeError("fetch failed");
      (error as { cause?: unknown }).cause = { code: "ENOTFOUND" };
      return error;
    };

    /** 60 public transitive packages, more than the 12 parallel registry lookups. */
    function writeManyPackages() {
      const packages: Record<string, unknown> = { "": { dependencies: { lodash: "^4.17.0" } } };
      packages["node_modules/lodash"] = pub("lodash", "4.17.15");
      for (let i = 0; i < 60; i++) packages[`node_modules/p${i}`] = pub(`p${i}`, "1.0.0");
      writeLock(packages);
    }

    it("turns a network outage into a clear error", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(offline())));
      const error = await withFakeBackoff(() => scan(dir, { cache: false }));
      expect(error).toBeInstanceOf(UserError);
      expect((error as Error).message).toMatch(/Could not reach/);
    });

    it("stops the registry lookups once the OSV query has failed", async () => {
      writeManyPackages();
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          calls++;
          throw offline();
        }),
      );
      let atFailure = -1;
      // One fake clock for the whole test, so retries pending after the failure would still fire.
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      try {
        const tick = async () => {
          await vi.advanceTimersByTimeAsync(1000);
          await new Promise((resolve) => setImmediate(resolve));
        };
        let settled = false;
        const result = scan(dir, { cache: false }).catch((e: unknown) => e);
        void result.then(() => (settled = true));
        while (!settled) await tick();
        expect(((await result) as Error).message).toMatch(/Could not reach api\.osv\.dev/);
        atFailure = calls;
        // Nothing keeps retrying in the background after scan() has rejected.
        for (let i = 0; i < 60; i++) await tick();
      } finally {
        vi.useRealTimers();
      }
      expect(calls).toBe(atFailure);
      // 4 OSV attempts + at most 12 parallel registry lookups x 4 attempts.
      expect(calls).toBeLessThanOrEqual(4 + 12 * 4);
    });

    it("collapses an unreachable registry into one warning and stops calling it", async () => {
      writeManyPackages();
      let registryCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.includes("registry.npmjs.org")) {
            registryCalls++;
            throw offline();
          }
          return fakeNetwork(url, init);
        }),
      );
      const report = (await withFakeBackoff(() => scan(dir, { cache: false }))) as Report;
      expect(report.findings.map((f) => f.name)).toEqual(["lodash"]);
      const registryWarnings = report.warnings.filter((w) => w.includes("registry.npmjs.org"));
      expect(registryWarnings).toHaveLength(1);
      expect(registryWarnings[0]).toMatch(/unreachable.*61 packages/);
      // The circuit opens after the first round of parallel lookups has exhausted its retries.
      expect(registryCalls).toBeLessThanOrEqual(12 * 4);
    });
  });
});

describe("exceedsThreshold", () => {
  const reportWith = (severity: Severity): Report => ({
    root: "",
    lockfile: "",
    scannedAt: "",
    warnings: [],
    suggestedOverrides: {},
    plan: [],
    summary: {} as Report["summary"],
    findings: [
      {
        name: "p",
        version: "1.0.0",
        direct: true,
        dev: false,
        priority: 1,
        vulnerabilities: [{ id: "X", aliases: [], summary: "", severity, fixedIn: [], url: "" }],
      },
    ],
  });

  it("counts an unknown severity as moderate so CI cannot pass silently", () => {
    expect(exceedsThreshold(reportWith("unknown"), "moderate")).toBe(true);
    expect(exceedsThreshold(reportWith("unknown"), "low")).toBe(true);
    expect(exceedsThreshold(reportWith("unknown"), "high")).toBe(false);
  });
});
