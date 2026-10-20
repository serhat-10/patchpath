import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Cache } from "../src/core/cache.js";
import { formatText } from "../src/core/format.js";
import { BREAKING_LINES, CANDIDATES_PER_LINE, MAX_PLAN_REQUESTS, candidatesFor } from "../src/core/plan.js";
import { scan } from "../src/core/scan.js";
import { compareVersions } from "../src/core/semver.js";
import { fetchPackageDeps, fetchPackageInfo } from "../src/core/sources/npm-registry.js";
import type { Dependency, PlanEntry } from "../src/core/types.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Advisory {
  id: string;
  name: string;
  /** Affected from `introduced` (default: all versions) up to, not including, `fixed`. */
  introduced?: string;
  fixed?: string;
  severity?: string;
}
type Versions = Record<string, { dependencies?: Record<string, string>; deprecated?: string }>;

let registry: Record<string, { latest?: string; versions: Versions }> = {};
let advisories: Advisory[] = [];
/** Registry names that answer HTTP 400 (not retried). */
let broken = new Set<string>();
let requests: string[] = [];

const affects = (a: Advisory, name: string, version: string) =>
  a.name === name &&
  (!a.introduced || compareVersions(version, a.introduced) >= 0) &&
  (!a.fixed || compareVersions(version, a.fixed) < 0);

function fakeNetwork(url: string, init?: RequestInit): Response {
  requests.push(`${url} ${init?.body ?? ""}`);
  if (url.endsWith("/v1/querybatch")) {
    const { queries } = JSON.parse(String(init?.body)) as { queries: { package: { name: string }; version: string }[] };
    return json({
      results: queries.map((q) => {
        const ids = advisories.filter((a) => affects(a, q.package.name, q.version)).map((a) => ({ id: a.id }));
        return ids.length ? { vulns: ids } : {};
      }),
    });
  }
  const detail = /\/v1\/vulns\/(.+)$/.exec(url);
  if (detail) {
    const a = advisories.find((x) => x.id === decodeURIComponent(detail[1] as string));
    if (!a) return json({}, 404);
    const events = [{ introduced: a.introduced ?? "0" }, ...(a.fixed ? [{ fixed: a.fixed }] : [])];
    return json({
      id: a.id,
      summary: `test advisory for ${a.name}`,
      database_specific: { severity: a.severity ?? "HIGH" },
      affected: [{ package: { ecosystem: "npm", name: a.name }, ranges: [{ type: "SEMVER", events }] }],
    });
  }
  const reg = /^https:\/\/registry\.npmjs\.org\/(.+)$/.exec(url);
  if (reg) {
    const name = decodeURIComponent(reg[1] as string);
    if (broken.has(name)) return json({ error: "bad request" }, 400);
    const doc = registry[name];
    if (!doc) return json({}, 404);
    return json({ "dist-tags": doc.latest ? { latest: doc.latest } : {}, versions: doc.versions });
  }
  return json({ error: `unexpected request ${url}` }, 500);
}

const pub = (name: string, version: string, extra: Record<string, unknown> = {}) => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`,
  ...extra,
});

/** app -> express@4.17.1 -> body-parser@1.19.0 -> qs@6.7.0, like the demo project. */
const expressLock = {
  "": { dependencies: { express: "^4.17.1" } },
  "node_modules/express": pub("express", "4.17.1", { dependencies: { "body-parser": "1.19.0" } }),
  "node_modules/body-parser": pub("body-parser", "1.19.0", { dependencies: { qs: "6.7.0" } }),
  "node_modules/qs": pub("qs", "6.7.0"),
};

const bodyParser = {
  versions: {
    "1.19.0": { dependencies: { qs: "6.7.0" } },
    "1.20.0": { dependencies: { qs: "6.9.0" } },
    "1.20.1": { dependencies: { qs: "~6.11.0" } },
    "2.0.0": { dependencies: { qs: "^6.12.0" } },
  },
};
const qs = {
  latest: "6.13.0",
  versions: { "6.7.0": {}, "6.9.0": {}, "6.11.0": {}, "6.11.2": {}, "6.12.0": {}, "6.13.0": {} },
};
const QS_ADVISORY: Advisory = { id: "GHSA-qs", name: "qs", fixed: "6.10.0" };

describe("upgrade plan", () => {
  let dir: string;
  const writeLock = (packages: Record<string, unknown>) =>
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages }));
  const planFor = (entries: PlanEntry[], name: string) => entries.find((e) => e.name === name);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "patchpath-plan-"));
    requests = [];
    broken = new Set();
    advisories = [QS_ADVISORY];
    registry = { "body-parser": bodyParser, qs };
    writeLock(expressLock);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => fakeNetwork(String(input), init)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it("recommends the smallest non-breaking version whose chain resolves outside the affected range", async () => {
    registry.express = {
      latest: "4.19.0",
      versions: {
        "4.17.1": { dependencies: { "body-parser": "1.19.0" } },
        "4.18.0": { dependencies: { "body-parser": "1.20.0" } }, // -> qs 6.9.0, still affected
        "4.19.0": { dependencies: { "body-parser": "1.20.1" } }, // -> qs ~6.11.0
        "4.19.1": { dependencies: { "body-parser": "1.20.1" } },
      },
    };
    // Brought in by qs 6.12+: had the planner ignored "~6.11.0" and taken the newest qs, OSV would
    // report this one and it would show up as remaining.
    advisories.push({ id: "GHSA-qs-new", name: "qs", introduced: "6.12.0" });

    const report = await scan(dir, { cache: false });
    const entry = planFor(report.plan, "express");
    expect(entry).toMatchObject({
      status: "upgrade",
      target: "4.19.0",
      breaking: false,
      total: 1,
      clears: { count: 1, packages: ["qs@6.7.0"], worst: "high" },
      remaining: [],
      estimated: true,
    });

    const text = formatText(report);
    expect(text).toContain("Upgrade plan");
    expect(text).toContain("express 4.17.1 -> 4.19.0: clears 1 advisory (worst high), non-breaking");
    expect(text).toContain("qs@6.7.0 (transitive) 1 advisory, worst high: covered by upgrading express");
    expect(text).toContain("npm install -- express@4.19.0");
    // The plan comes before the per-package list, and qs needs no override any more.
    expect(text.indexOf("Upgrade plan")).toBeLessThan(text.indexOf("Findings"));
    expect(report.suggestedOverrides).toEqual({ qs: "6.10.0" });
    expect(text).not.toContain('"overrides"');
  });

  it("recommends the best partial non-breaking upgrade and names a breaking one that clears everything", async () => {
    registry.express = {
      latest: "5.0.0",
      versions: {
        "4.17.1": { dependencies: { "body-parser": "1.19.0" } },
        "4.18.0": { dependencies: { "body-parser": "1.20.0" } }, // newest 4.x still pulls qs 6.9.0
        "5.0.0": { dependencies: { "body-parser": "^2.0.0" } },
      },
    };
    advisories.push({ id: "GHSA-express", name: "express", fixed: "4.18.0", severity: "MODERATE" });

    const report = await scan(dir, { cache: false });
    const entry = planFor(report.plan, "express");
    expect(entry).toMatchObject({
      status: "upgrade",
      target: "4.18.0",
      breaking: false,
      total: 2,
      clears: { count: 1, packages: ["express@4.17.1"], worst: "moderate" },
      remaining: [{ id: "GHSA-qs", package: "qs@6.7.0", after: "qs@6.9.0" }],
      breakingAlternative: "5.0.0",
    });
    const text = formatText(report);
    expect(text).toContain("express 4.17.1 -> 4.18.0: clears 1 of 2 advisories");
    expect(text).toContain("still open: qs@6.7.0 -> 6.9.0 (1 high)");
    expect(text).toContain("5.0.0 would clear all of them (may break");
    // qs is not covered, so its override is still offered.
    expect(text).toContain('"qs": "6.10.0"');
  });

  it("recommends a breaking upgrade when only a new major helps, the newest on that major", async () => {
    registry.express = {
      versions: {
        "4.17.1": { dependencies: { "body-parser": "1.19.0" } },
        "4.18.0": { dependencies: { "body-parser": "1.20.0" } },
        "5.0.0": { dependencies: { "body-parser": "^2.0.0" } },
        "5.1.0": { dependencies: { "body-parser": "^2.0.0" } },
      },
    };
    const report = await scan(dir, { cache: false });
    // 5.0.0 and 5.1.0 both clear it: not the first release of the new major, the newest one.
    expect(planFor(report.plan, "express")).toMatchObject({ status: "upgrade", target: "5.1.0", breaking: true, remaining: [] });
    expect(planFor(report.plan, "express")?.breakingAlternative).toBeUndefined();
    expect(formatText(report)).toContain("express 4.17.1 -> 5.1.0: clears 1 advisory (worst high), may break");
  });

  it("says when nothing helps and the dependency is deprecated", async () => {
    writeLock({
      "": { dependencies: { request: "^2.88.0" } },
      "node_modules/request": pub("request", "2.88.2", { dependencies: { qs: "~6.5.2" } }),
      "node_modules/qs": pub("qs", "6.7.0"),
    });
    registry.request = {
      latest: "2.88.2",
      versions: { "2.88.0": { dependencies: { qs: "~6.5.2" } }, "2.88.2": { dependencies: { qs: "~6.5.2" }, deprecated: "request has been deprecated" } },
    };
    const report = await scan(dir, { cache: false });
    const entry = planFor(report.plan, "request");
    expect(entry).toMatchObject({ status: "no-fix", total: 1, deprecated: "request has been deprecated", remaining: [{ id: "GHSA-qs" }] });
    expect(entry?.target).toBeUndefined();
    expect(formatText(report)).toMatch(/request 2\.88\.2: no upgrade clears its 1 advisory .*deprecated: replace it/);
  });

  it("marks the plan unavailable when registry metadata cannot be read, and the scan still succeeds", async () => {
    broken.add("express");
    const report = await scan(dir, { cache: false });
    expect(report.findings.map((f) => f.name)).toEqual(["qs"]);
    const entry = planFor(report.plan, "express");
    expect(entry).toMatchObject({ status: "unavailable", remaining: [{ id: "GHSA-qs" }] });
    expect(entry?.target).toBeUndefined();
    expect(report.warnings.some((w) => w.startsWith("Upgrade plan unavailable for express"))).toBe(true);
    expect(formatText(report)).toContain("express 4.17.1: no estimate");
  });

  it("counts an advisory that OSV reports for the estimated version as remaining", async () => {
    registry.express = {
      versions: {
        "4.17.1": { dependencies: { "body-parser": "1.19.0" } },
        "4.18.0": { dependencies: { "body-parser": "1.20.1" } }, // -> qs 6.11.2: clears GHSA-qs...
      },
    };
    // ...but OSV knows another advisory for that very version.
    advisories.push({ id: "GHSA-qs-6-11", name: "qs", introduced: "6.11.0", fixed: "6.12.0", severity: "LOW" });
    const report = await scan(dir, { cache: false });
    const entry = planFor(report.plan, "express");
    expect(entry).toMatchObject({ status: "upgrade", target: "4.18.0", clears: { count: 1 } });
    expect(entry?.remaining).toEqual([
      { id: "GHSA-qs-6-11", severity: "low", package: "qs@6.7.0", after: "qs@6.11.2", introduced: true },
    ]);
    expect(formatText(report)).toContain("still open: qs@6.7.0 -> 6.11.2 (1 low, new)");
    // The resolved version was sent to OSV.
    expect(requests.some((r) => r.includes("/querybatch") && r.includes('"version":"6.11.2"'))).toBe(true);
  });

  it("detects a locked version that the new range still allows, and says to run npm update", async () => {
    registry.express = {
      versions: {
        "4.17.1": { dependencies: { "body-parser": "1.19.0" } },
        "4.18.0": { dependencies: { "body-parser": "^1.19.0" } }, // the locked 1.19.0 still satisfies this
      },
    };
    const report = await scan(dir, { cache: false });
    expect(planFor(report.plan, "express")).toMatchObject({ target: "4.18.0", alsoUpdate: ["body-parser"], remaining: [] });
    // The Commands block runs it; the plan line does not repeat it (it stays in the JSON).
    const text = formatText(report);
    expect(text).toContain("  npm install -- express@4.18.0\n  npm update -- body-parser\n");
    expect(text).not.toContain("also run npm update body-parser");
    // Without a Commands block that has it, the plan line still says it.
    expect(formatText({ ...report, commands: undefined })).toContain("also run npm update body-parser");
  });

  it.each([
    ["nested", { express: { qs: "6.7.0" } }],
    ["nested deeper, with a range key", { express: { "body-parser@1": { "qs@^6.0.0": "6.7.0" } } }],
    ["top level with a range key", { "qs@6": "6.7.0" }],
  ])("does not claim to clear a package that an override holds (%s)", async (_label, overrides) => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { express: "^4.17.1" }, overrides }));
    registry.express = { versions: { "4.17.1": { dependencies: { "body-parser": "1.19.0" } }, "4.19.0": { dependencies: { "body-parser": "1.20.1" } } } };
    const report = await scan(dir, { cache: false });
    const entry = planFor(report.plan, "express");
    expect(entry?.clears.packages ?? []).not.toContain("qs@6.7.0");
    expect(entry?.heldByOverride).toEqual(["qs"]);
    expect(formatText(report)).toContain("held by an override in package.json: qs");
    expect(formatText(report)).not.toContain("covered by upgrading express");
  });

  it("does not treat a key with only nested overrides as overridden itself", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { express: "^4.17.1" }, overrides: { "body-parser": { other: "1.0.0" } } }));
    registry.express = { versions: { "4.17.1": { dependencies: { "body-parser": "1.19.0" } }, "4.19.0": { dependencies: { "body-parser": "1.20.1" } } } };
    const report = await scan(dir, { cache: false });
    expect(planFor(report.plan, "express")).toMatchObject({ target: "4.19.0", remaining: [] });
  });

  it("never requests a package on the chain that is not from the public registry", async () => {
    writeLock({
      "": { dependencies: { express: "^4.17.1" } },
      "node_modules/express": pub("express", "4.17.1", { dependencies: { "@corp/middle": "^1.0.0" } }),
      "node_modules/@corp/middle": { version: "1.0.0", resolved: "https://npm.corp.example/@corp/middle/-/middle-1.0.0.tgz", dependencies: { qs: "6.7.0" } },
      "node_modules/qs": pub("qs", "6.7.0"),
    });
    // 4.18.0 needs a @corp/middle that is not installed: what it would get cannot be known.
    registry.express = { versions: { "4.17.1": { dependencies: { "@corp/middle": "^1.0.0" } }, "4.18.0": { dependencies: { "@corp/middle": "^2.0.0" } } } };
    const report = await scan(dir, { cache: false });
    expect(requests.join("\n")).not.toContain("corp");
    expect(planFor(report.plan, "express")).toMatchObject({
      status: "unavailable",
      unresolved: ["qs@6.7.0"],
      remaining: [{ id: "GHSA-qs" }],
    });
  });

  it("never requests a private package on the chain when the new version keeps the same range", async () => {
    writeLock({
      "": { dependencies: { express: "^4.17.1" } },
      "node_modules/express": pub("express", "4.17.1", { dependencies: { "@corp/middle": "^1.0.0" } }),
      "node_modules/@corp/middle": { version: "1.0.0", resolved: "https://npm.corp.example/@corp/middle/-/middle-1.0.0.tgz", dependencies: { qs: "6.7.0" } },
      "node_modules/qs": pub("qs", "6.7.0"),
    });
    registry.express = { versions: { "4.17.1": { dependencies: { "@corp/middle": "^1.0.0" } }, "4.18.0": { dependencies: { "@corp/middle": "^1.0.0" } } } };
    const report = await scan(dir, { cache: false });
    expect(requests.join("\n")).not.toContain("corp");
    // The private package stays where it is (it is never looked up), so qs stays too: no claim.
    const entry = planFor(report.plan, "express");
    expect(entry?.status).not.toBe("upgrade");
    expect(entry?.remaining).toEqual([expect.objectContaining({ id: "GHSA-qs", package: "qs@6.7.0" })]);
    expect(formatText(report)).not.toContain("covered by upgrading express");
  });

  it("is skipped with plan: false, without extra requests", async () => {
    registry.express = { versions: { "4.17.1": {}, "4.18.0": { dependencies: { "body-parser": "1.20.1" } } } };
    const report = await scan(dir, { cache: false, plan: false });
    expect(report.plan).toEqual([]);
    expect(formatText(report)).not.toContain("Upgrade plan");
    expect(formatText(report)).toContain("Fix first");
    // One registry document per installed package, one OSV batch for the report and one that
    // checks the "fixed in" version (qs@6.10.0): nothing for the planner.
    expect(requests.filter((r) => r.includes("registry.npmjs.org"))).toHaveLength(3);
    const batches = requests.filter((r) => r.includes("/querybatch"));
    expect(batches).toHaveLength(2);
    expect(batches[1]).toContain('"version":"6.10.0"');
  });

  it("reuses the registry documents already downloaded for the report", async () => {
    registry.express = { versions: { "4.17.1": {}, "4.18.0": { dependencies: { "body-parser": "1.20.1" } } } };
    const report = await scan(dir, { cache: false });
    expect(planFor(report.plan, "express")?.target).toBe("4.18.0");
    expect(requests.filter((r) => r.includes("registry.npmjs.org"))).toHaveLength(3);
  });

  it(`stops after ${MAX_PLAN_REQUESTS} extra registry requests and says so`, async () => {
    const packages: Record<string, unknown> = { "": { dependencies: {} } };
    const deps: Record<string, string> = {};
    for (let i = 0; i < MAX_PLAN_REQUESTS + 5; i++) {
      deps[`p${i}`] = "^1.0.0";
      packages[`node_modules/p${i}`] = pub(`p${i}`, "1.0.0");
      advisories.push({ id: `GHSA-p${i}`, name: `p${i}`, fixed: "1.0.1" });
      // The report's own lookup fails (400), so the planner has to ask again.
      broken.add(`p${i}`);
    }
    (packages[""] as { dependencies: Record<string, string> }).dependencies = deps;
    writeLock(packages);
    const report = await scan(dir, { cache: false });
    const planRequests = requests.filter((r) => r.includes("registry.npmjs.org")).length - (MAX_PLAN_REQUESTS + 5);
    expect(planRequests).toBe(MAX_PLAN_REQUESTS);
    // Honest about why: the tool's own budget, not the registry; and how to continue.
    const warning = report.warnings.find((w) => w.includes(`request limit reached (${MAX_PLAN_REQUESTS} extra registry requests)`));
    expect(warning).toContain("Rerun without --no-cache to continue");
    expect(report.plan.filter((e) => e.reason?.includes("request limit reached: rerun patchpath to continue"))).toHaveLength(5);
    // The packages that were looked up got HTTP 400; only those say "registry data unavailable".
    expect(report.plan.filter((e) => e.reason?.includes("registry data unavailable"))).toHaveLength(MAX_PLAN_REQUESTS);
    expect(report.plan.every((e) => e.status === "unavailable")).toBe(true);
  });
});

describe("candidatesFor", () => {
  const dep: Dependency = { name: "p", version: "1.0.0", direct: true, dev: false, external: false };

  it(`tries at most ${CANDIDATES_PER_LINE} of the newest releases per line, on the ${BREAKING_LINES} newest breaking lines`, () => {
    const versions: Record<string, Record<string, string>> = { "0.9.0": {}, "1.0.0": {}, "2.0.0-beta.1": {} };
    for (let i = 1; i <= 30; i++) versions[`1.0.${i}`] = {};
    for (const major of [2, 3, 4, 5]) {
      versions[`${major}.0.0`] = {};
      versions[`${major}.1.0`] = {};
    }
    const deprecated = { "1.0.30": "bad release" };
    const result = candidatesFor(dep, { versions }, { deprecated });
    // 1.0.10 .. 1.0.29: the 20 newest on the current line (1.0.30 is deprecated, 2.0.0-beta.1 a prerelease).
    const current = Array.from({ length: 20 }, (_, i) => `1.0.${i + 10}`);
    expect(result).toEqual([...current, "3.0.0", "3.1.0", "4.0.0", "4.1.0", "5.0.0", "5.1.0"]);
  });
});

describe("fetchPackageDeps cache", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "patchpath-deps-"));
    requests = [];
    broken = new Set();
    registry = { qs };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => fakeNetwork(String(input), init)));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses a valid cached record, refetches a malformed one, and keeps it apart from the report's entries", async () => {
    const cache = new Cache(dir);
    await cache.set("v3:npm:deps:qs", { versions: { "6.7.0": { evil: 5 } } });
    const first = await fetchPackageDeps("qs", cache);
    expect(first.requested).toBe(true);
    expect(Object.keys(first.deps?.versions ?? {})).toContain("6.11.2");
    const second = await fetchPackageDeps("qs", cache);
    expect(second.requested).toBe(false);
    expect(second.deps).toEqual(first.deps);
    // The report's own entry is untouched: fetchPackageInfo still downloads its slim record.
    await fetchPackageInfo("qs", cache);
    expect(requests.filter((r) => r.includes("registry.npmjs.org"))).toHaveLength(2);
  });
});
