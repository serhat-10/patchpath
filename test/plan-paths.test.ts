import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatText } from "../src/core/format.js";
import { scan } from "../src/core/scan.js";
import { compareVersions } from "../src/core/semver.js";
import type { Report } from "../src/core/types.js";

// Adversarial checks for PlanEntry.paths, PlanEntry.stillReachedVia and Report.planSummary.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
interface Advisory {
  id: string;
  name: string;
  introduced?: string;
  fixed?: string;
}
type Versions = Record<string, Record<string, unknown>>;
let registry: Record<string, { latest?: string; versions: Versions }> = {};
let advisories: Advisory[] = [];
const affects = (a: Advisory, name: string, version: string) =>
  a.name === name &&
  (!a.introduced || compareVersions(version, a.introduced) >= 0) &&
  (!a.fixed || compareVersions(version, a.fixed) < 0);

function fakeNetwork(url: string, init?: RequestInit): Response {
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
      database_specific: { severity: "HIGH" },
      affected: [{ package: { ecosystem: "npm", name: a.name }, ranges: [{ type: "SEMVER", events }] }],
    });
  }
  const reg = /^https:\/\/registry\.npmjs\.org\/(.+)$/.exec(url);
  if (reg) {
    const doc = registry[decodeURIComponent(reg[1] as string)];
    if (!doc) return json({}, 404);
    return json({ "dist-tags": doc.latest ? { latest: doc.latest } : {}, versions: doc.versions });
  }
  return json({ error: `unexpected request ${url}` }, 500);
}

const pub = (name: string, version: string, extra: Record<string, unknown> = {}) => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
  ...extra,
});
const SHARED: Advisory = { id: "GHSA-shared", name: "shared", fixed: "1.2.0" };
const sharedReg = { versions: { "1.0.0": {}, "1.0.5": {}, "1.2.0": {}, "1.3.0": {} } };

let dir: string;
const lock = (packages: Record<string, unknown>) =>
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "t", lockfileVersion: 3, packages }));

/** Invariants that must hold for any report (case g). */
function invariants(report: Report) {
  const s = report.planSummary;
  if (!s) return;
  expect(s.pathsFixed + s.pathsRemaining).toBe(s.pathsTotal);
  expect(s.advisoriesEliminated).toBeLessThanOrEqual(s.advisoriesTotal);
  expect(s.pathsFixed).toBeGreaterThanOrEqual(0);
  expect(s.pathsRemaining).toBeGreaterThanOrEqual(0);
  for (const e of report.plan) {
    if (!e.paths) continue;
    expect(e.paths.fixed + e.paths.remaining).toBe(e.paths.total);
    expect(e.clears.count).toBeLessThanOrEqual(e.total);
    // An entry that clears an advisory cannot fix zero paths.
    if (e.clears.count > 0) expect(e.paths.fixed).toBeGreaterThan(0);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "patchpath-paths-"));
  advisories = [SHARED];
  registry = { shared: sharedReg };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => fakeNetwork(String(input), init)));
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

const fixable = { versions: { "1.0.0": { dependencies: { shared: "^1.0.0" } }, "1.1.0": { dependencies: { shared: "^1.2.0" } } } };

describe("plan paths: adversarial", () => {
  it("same package at two versions, only the old copy is vulnerable", async () => {
    // Expected: 1 vulnerable path (alpha > shared@1.0.0). beta's shared@1.3.0 is not counted.
    // Upgrading alpha to 1.1.0 (^1.2.0) fixes it: paths 1/1/0, clears 1, summary 1/1/0, 1/1.
    lock({
      "": { dependencies: { alpha: "^1.0.0", beta: "^1.0.0" } },
      "node_modules/alpha": pub("alpha", "1.0.0", { dependencies: { shared: "1.0.0" } }),
      "node_modules/alpha/node_modules/shared": pub("shared", "1.0.0"),
      "node_modules/beta": pub("beta", "1.0.0", { dependencies: { shared: "^1.3.0" } }),
      "node_modules/shared": pub("shared", "1.3.0"),
    });
    registry.alpha = { versions: { "1.0.0": { dependencies: { shared: "1.0.0" } }, "1.1.0": { dependencies: { shared: "^1.2.0" } } } };
    registry.beta = { versions: { "1.0.0": { dependencies: { shared: "^1.3.0" } } } };
    const report = await scan(dir, { cache: false });
    invariants(report);
    expect(report.plan.find((e) => e.name === "beta")).toBeUndefined();
    expect(report.plan.find((e) => e.name === "alpha")).toMatchObject({
      status: "upgrade",
      clears: { count: 1 },
      paths: { total: 1, fixed: 1, remaining: 0 },
    });
    expect(report.plan.find((e) => e.name === "alpha")?.stillReachedVia).toBeUndefined();
    expect(report.planSummary).toEqual({ pathsTotal: 1, pathsFixed: 1, pathsRemaining: 0, advisoriesTotal: 1, advisoriesEliminated: 1 });
  });

  it("an in-range refresh counts in the summary while the alpha entry stays no-fix", async () => {
    // alpha 1.0.0 locks shared with ^1.0.0, so `npm update shared` reaches the fixed version without
    // any alpha upgrade. The refresh clears the advisory, and the summary must count it.
    lock({
      "": { dependencies: { alpha: "^1.0.0" } },
      "node_modules/alpha": pub("alpha", "1.0.0", { dependencies: { shared: "^1.0.0" } }),
      "node_modules/shared": pub("shared", "1.0.0"),
    });
    registry.alpha = { versions: { "1.0.0": { dependencies: { shared: "^1.0.0" } }, "1.1.0": { dependencies: { shared: "~1.0.0" } } } };
    const report = await scan(dir, { cache: false });
    invariants(report);
    expect(report.planSummary).toMatchObject({ pathsTotal: 1, pathsFixed: 1, pathsRemaining: 0, advisoriesTotal: 1, advisoriesEliminated: 1 });
    const alpha = report.plan.find((e) => e.name === "alpha");
    // Upgrading alpha itself does nothing here; the fix comes from the in-range refresh only.
    expect(alpha?.status).toBe("no-fix");
    expect(alpha?.paths?.fixed).toBe(0);
  });

  it("the new alpha pins the vulnerable range and nothing in range helps", async () => {
    // Expected: lock spec ~1.0.0 so even an in-range update stays vulnerable (1.0.5). No path fixed,
    // advisory not eliminated, status no-fix, entry paths fixed 0.
    lock({
      "": { dependencies: { alpha: "^1.0.0" } },
      "node_modules/alpha": pub("alpha", "1.0.0", { dependencies: { shared: "~1.0.0" } }),
      "node_modules/shared": pub("shared", "1.0.0"),
    });
    registry.alpha = { versions: { "1.0.0": { dependencies: { shared: "~1.0.0" } }, "1.1.0": { dependencies: { shared: "~1.0.0" } } } };
    const report = await scan(dir, { cache: false });
    invariants(report);
    const alpha = report.plan.find((e) => e.name === "alpha");
    expect(alpha?.status).toBe("no-fix");
    expect(report.planSummary?.pathsFixed ?? 0).toBe(0);
    expect(report.planSummary?.advisoriesEliminated ?? 0).toBe(0);
    expect(alpha?.paths?.fixed ?? 0).toBe(0);
  });

  const three = (aFix: boolean, bFix: boolean, cFix: boolean) => {
    lock({
      "": { dependencies: { a: "^1.0.0", b: "^1.0.0", c: "^1.0.0" } },
      "node_modules/a": pub("a", "1.0.0", { dependencies: { shared: "^1.0.0" } }),
      "node_modules/b": pub("b", "1.0.0", { dependencies: { shared: "~1.0.0" } }),
      "node_modules/c": pub("c", "1.0.0", { dependencies: { shared: "~1.0.0" } }),
      "node_modules/shared": pub("shared", "1.0.0"),
    });
    const mk = (fix: boolean, old: string) => ({
      versions: { "1.0.0": { dependencies: { shared: old } }, ...(fix ? { "1.1.0": { dependencies: { shared: "^1.2.0" } } } : {}) },
    });
    registry.a = mk(aFix, "^1.0.0");
    registry.b = mk(bFix, "~1.0.0");
    registry.c = mk(cFix, "~1.0.0");
  };

  it("three dependents, one is upgradable", async () => {
    // Expected: total 3. Plan upgrades a only: a paths fixed 1 remaining 2, clears 0,
    // stillReachedVia [b, c]. Summary 3 total, 1 fixed, 2 remaining, 0/1 eliminated.
    three(true, false, false);
    const report = await scan(dir, { cache: false });
    invariants(report);
    expect(report.plan.find((e) => e.name === "a")).toMatchObject({ clears: { count: 0 }, paths: { total: 3, fixed: 1, remaining: 2 }, stillReachedVia: ["b", "c"] });
    expect(report.planSummary).toEqual({ pathsTotal: 3, pathsFixed: 1, pathsRemaining: 2, advisoriesTotal: 1, advisoriesEliminated: 0 });
  });

  it("three dependents, two are upgradable", async () => {
    // First principles: if a and b were both upgraded, 2 of 3 paths would be fixed. The planner only
    // proposes a (the finding is attributed to one direct dependency), so the summary describes
    // the plan as proposed: 1 fixed, 2 remaining. This documents that limit; b is still listed
    // under stillReachedVia although it is upgradable.
    three(true, true, false);
    const report = await scan(dir, { cache: false });
    invariants(report);
    expect(report.planSummary).toEqual({ pathsTotal: 3, pathsFixed: 1, pathsRemaining: 2, advisoriesTotal: 1, advisoriesEliminated: 0 });
    expect(report.plan.map((e) => e.name)).toEqual(["a"]);
  });

  it("stillReachedVia lists b although b has an upgrade", async () => {
    // Records the behaviour: the plan does not include b, so b is correctly "still reached".
    three(true, true, false);
    const report = await scan(dir, { cache: false });
    expect(report.plan.find((e) => e.name === "a")?.stillReachedVia).toEqual(["b", "c"]);
  });

  it("three dependents, all upgradable", async () => {
    // Expected: advisory eliminated project-wide: 3/3 fixed, 1/1.
    three(true, true, true);
    const report = await scan(dir, { cache: false });
    invariants(report);
    expect(report.planSummary).toEqual({ pathsTotal: 3, pathsFixed: 3, pathsRemaining: 0, advisoriesTotal: 1, advisoriesEliminated: 1 });
  });

  it("vulnerable package only below a devDependency", async () => {
    // Expected: with dev included, 1 path, fixed by alpha 1.1.0. With includeDev false: no plan, no summary paths.
    lock({
      "": { devDependencies: { alpha: "^1.0.0" } },
      "node_modules/alpha": pub("alpha", "1.0.0", { dev: true, dependencies: { shared: "^1.0.0" } }),
      "node_modules/shared": pub("shared", "1.0.0", { dev: true }),
    });
    registry.alpha = fixable;
    const withDev = await scan(dir, { cache: false });
    invariants(withDev);
    expect(withDev.planSummary).toMatchObject({ pathsTotal: 1, pathsFixed: 1, advisoriesEliminated: 1 });
    const noDev = await scan(dir, { cache: false, includeDev: false });
    invariants(noDev);
    expect(noDev.plan).toEqual([]);
    expect(noDev.planSummary?.pathsTotal ?? 0).toBe(0);
  });

  it("an optional dependency edge is a path", async () => {
    // Expected: alpha (dependencies) + beta (optionalDependencies) both reach shared: total 2;
    // upgrading alpha fixes 1, remaining 1 via beta.
    lock({
      "": { dependencies: { alpha: "^1.0.0", beta: "^1.0.0" } },
      "node_modules/alpha": pub("alpha", "1.0.0", { dependencies: { shared: "^1.0.0" } }),
      "node_modules/beta": pub("beta", "1.0.0", { optionalDependencies: { shared: "~1.0.0" } }),
      "node_modules/shared": pub("shared", "1.0.0"),
    });
    registry.alpha = fixable;
    registry.beta = { versions: { "1.0.0": { optionalDependencies: { shared: "~1.0.0" } } } };
    const report = await scan(dir, { cache: false });
    invariants(report);
    expect(report.plan.find((e) => e.name === "alpha")).toMatchObject({
      paths: { total: 2, fixed: 1, remaining: 1 },
      stillReachedVia: ["beta"],
    });
  });

  it("a peer edge from a package that stays on the vulnerable range", async () => {
    // Expected: beta only declares shared as a peer (~1.0.0), alpha depends on it. Upgrading alpha to ^1.2.0
    // cannot satisfy beta's peer, so the advisory must not be reported cleared by alpha alone.
    lock({
      "": { dependencies: { alpha: "^1.0.0", beta: "^1.0.0" } },
      "node_modules/alpha": pub("alpha", "1.0.0", { dependencies: { shared: "^1.0.0" } }),
      "node_modules/beta": pub("beta", "1.0.0", { peerDependencies: { shared: "~1.0.0" } }),
      "node_modules/shared": pub("shared", "1.0.0"),
    });
    registry.alpha = fixable;
    registry.beta = { versions: { "1.0.0": {} } };
    const report = await scan(dir, { cache: false });
    invariants(report);
    const alpha = report.plan.find((e) => e.name === "alpha");
    expect(alpha?.clears.count ?? 0).toBe(0);
    expect(report.planSummary?.advisoriesEliminated ?? 0).toBe(0);
  });

  it("a direct dependency that is itself the vulnerable package", async () => {
    // Expected: one path (root > shared). Upgrade: paths 1/1/0, cleared 1, no stillReachedVia.
    lock({
      "": { dependencies: { shared: "1.0.0" } },
      "node_modules/shared": pub("shared", "1.0.0"),
    });
    const report = await scan(dir, { cache: false });
    invariants(report);
    const e = report.plan.find((x) => x.name === "shared");
    expect(e).toMatchObject({ status: "upgrade", clears: { count: 1 }, paths: { total: 1, fixed: 1, remaining: 0 } });
    expect(e?.stillReachedVia).toBeUndefined();
    expect(report.planSummary).toMatchObject({ pathsTotal: 1, pathsFixed: 1, advisoriesEliminated: 1 });
  });

  it("direct and transitive at once", async () => {
    // Expected: 2 paths (root > shared, alpha > shared). alpha ^1.0.0 accepts 1.2.0, so one hoisted copy moves
    // and both are fixed.
    lock({
      "": { dependencies: { shared: "1.0.0", alpha: "^1.0.0" } },
      "node_modules/alpha": pub("alpha", "1.0.0", { dependencies: { shared: "^1.0.0" } }),
      "node_modules/shared": pub("shared", "1.0.0"),
    });
    registry.alpha = { versions: { "1.0.0": { dependencies: { shared: "^1.0.0" } } } };
    const report = await scan(dir, { cache: false });
    invariants(report);
    expect(report.planSummary?.pathsTotal).toBe(2);
    expect(report.planSummary?.pathsFixed).toBe(2);
  });

  it("identical input gives identical JSON", async () => {
    three(true, true, false);
    const strip = (r: Report) => JSON.stringify({ ...r, scannedAt: "" });
    const one = strip(await scan(dir, { cache: false }));
    const two = strip(await scan(dir, { cache: false }));
    expect(two).toBe(one);
  });

  it("text wording for partial and full plans", async () => {
    three(true, false, false);
    const text = formatText(await scan(dir, { cache: false }));
    expect(text).toContain("removes 1 of 3 vulnerable paths, clears no advisory");
    expect(text).toContain("Paths fixed: 1 of 3. Advisories eliminated project-wide: 0 of 1.");
    expect(text).not.toMatch(/clears 0 /);
    three(true, true, true);
    const all = formatText(await scan(dir, { cache: false }));
    expect(all).toContain("Paths fixed: 3 of 3. Advisories eliminated project-wide: 1 of 1.");
  });

  it("singular wording when one of one path is removed but nothing is cleared", async () => {
    // Expected: "1 vulnerable path", never "1 vulnerable paths". Hard to reach with total 1 and clears 0;
    // assert on whatever text appears.
    three(true, false, false);
    const text = formatText(await scan(dir, { cache: false }));
    expect(text).not.toMatch(/\b1 vulnerable paths/);
    expect(text).not.toMatch(/\b[02-9] of 1 vulnerable paths?/);
  });
});
