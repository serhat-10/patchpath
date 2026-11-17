import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatText } from "../src/core/format.js";
import { scan } from "../src/core/scan.js";
import { compareVersions } from "../src/core/semver.js";
import type { Report } from "../src/core/types.js";


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


// Round-two checks: ranking ties, breaking vs non-breaking, deep nesting, dev-only dependents, text wording.

function invariants(report: Report) {
  const s = report.planSummary;
  if (s) {
    expect(s.pathsFixed + s.pathsRemaining).toBe(s.pathsTotal);
    expect(s.advisoriesEliminated).toBeLessThanOrEqual(s.advisoriesTotal);
  }
  for (const e of report.plan) {
    if (!e.paths) continue;
    expect(e.paths.fixed + e.paths.remaining).toBe(e.paths.total);
    if (e.status === "no-fix") expect(e.paths.fixed).toBe(0);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "patchpath-r2-"));
  advisories = [SHARED, { id: "GHSA-own", name: "own", fixed: "1.2.0" }, { id: "GHSA-other", name: "other", fixed: "1.2.0" }];
  registry = { shared: sharedReg, own: sharedReg, other: sharedReg };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => fakeNetwork(String(input), init)));
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

const find = (r: Report, n: string) => r.plan.find((e) => e.name === n);

describe("round two: ranking", () => {
  it("among non-breaking candidates with equal clears, fewer remaining paths wins, deterministically", async () => {
    // alpha 1.1.0 clears own, shared stays ^1.0.0 (beta holds ~1.0.0). alpha 1.2.0 clears own and
    // drops one shared path. Expected: 1.2.0; paths total 3 (shared x2, own x1), fixed 2, remaining 1.
    lock({
      "": { dependencies: { alpha: "^1.0.0", beta: "^1.0.0" } },
      "node_modules/alpha": pub("alpha", "1.0.0", { dependencies: { shared: "^1.0.0", own: "1.0.0" } }),
      "node_modules/beta": pub("beta", "1.0.0", { dependencies: { shared: "~1.0.0" } }),
      "node_modules/shared": pub("shared", "1.0.0"),
      "node_modules/own": pub("own", "1.0.0"),
    });
    registry.alpha = {
      versions: {
        "1.0.0": { dependencies: { shared: "^1.0.0", own: "1.0.0" } },
        "1.1.0": { dependencies: { shared: "^1.0.0", own: "^1.2.0" } },
        "1.2.0": { dependencies: { shared: "^1.2.0", own: "^1.2.0" } },
      },
    };
    registry.beta = { versions: { "1.0.0": { dependencies: { shared: "~1.0.0" } } } };
    const first = await scan(dir, { cache: false });
    const second = await scan(dir, { cache: false });
    for (const r of [first, second]) {
      invariants(r);
      expect(find(r, "alpha")).toMatchObject({ target: "1.2.0", clears: { count: 1 }, paths: { total: 3, fixed: 2, remaining: 1 } });
    }
    expect(JSON.stringify(first.plan)).toBe(JSON.stringify(second.plan));
  });

  it("non-breaking that clears beats a breaking one that clears more; the breaking one is the alternative", async () => {
    // alpha 1.1.0 clears own only; 2.0.0 clears own and other. Expected target 1.1.0, alternative 2.0.0.
    lock({
      "": { dependencies: { alpha: "^1.0.0" } },
      "node_modules/alpha": pub("alpha", "1.0.0", { dependencies: { own: "1.0.0", other: "1.0.0" } }),
      "node_modules/own": pub("own", "1.0.0"),
      "node_modules/other": pub("other", "1.0.0"),
    });
    registry.alpha = {
      versions: {
        "1.0.0": { dependencies: { own: "1.0.0", other: "1.0.0" } },
        "1.1.0": { dependencies: { own: "^1.2.0", other: "1.0.0" } },
        "2.0.0": { dependencies: { own: "^1.2.0", other: "^1.2.0" } },
      },
    };
    const r = await scan(dir, { cache: false });
    invariants(r);
    expect(find(r, "alpha")).toMatchObject({ status: "upgrade", target: "1.1.0", breaking: false, breakingAlternative: "2.0.0" });
  });

  it("no entry is ever a breaking upgrade that clears nothing", async () => {
    lock({
      "": { dependencies: { alpha: "^1.0.0", beta: "^1.0.0" } },
      "node_modules/alpha": pub("alpha", "1.0.0", { dependencies: { shared: "^1.0.0" } }),
      "node_modules/beta": pub("beta", "1.0.0", { dependencies: { shared: "~1.0.0" } }),
      "node_modules/shared": pub("shared", "1.0.0"),
    });
    registry.beta = { versions: { "1.0.0": { dependencies: { shared: "~1.0.0" } }, "2.0.0": { dependencies: { shared: "^1.2.0" } } } };
    registry.alpha = {
      versions: { "1.0.0": { dependencies: { shared: "^1.0.0" } }, "1.1.0": { dependencies: { shared: "^1.2.0" } }, "2.0.0": { dependencies: { shared: "^1.2.0" } } },
    };
    const r = await scan(dir, { cache: false });
    invariants(r);
    for (const e of r.plan) if (e.status === "upgrade" && e.breaking) expect(e.clears.count).toBeGreaterThan(0);
  });

  it("only a breaking path-only candidate: no-fix, no command, sensible reason, summary absent or zero", async () => {
    lock({
      "": { dependencies: { alpha: "^1.0.0", beta: "^1.0.0" } },
      "node_modules/alpha": pub("alpha", "1.0.0", { dependencies: { shared: "~1.0.0" } }),
      "node_modules/beta": pub("beta", "1.0.0", { dependencies: { shared: "~1.0.0" } }),
      "node_modules/shared": pub("shared", "1.0.0"),
    });
    registry.alpha = { versions: { "1.0.0": { dependencies: { shared: "~1.0.0" } }, "2.0.0": { dependencies: { shared: "^1.2.0" } } } };
    registry.beta = { versions: { "1.0.0": { dependencies: { shared: "~1.0.0" } } } };
    const r = await scan(dir, { cache: false });
    invariants(r);
    const a = find(r, "alpha");
    expect(a).toMatchObject({ status: "no-fix", clears: { count: 0 }, paths: { total: 2, fixed: 0, remaining: 2 } });
    expect(a?.reason).toMatch(/2\.0\.0 \(may break\) only removes some paths/);
    expect(a?.target).toBeUndefined();
    expect(JSON.stringify(r.commands ?? [])).not.toContain("alpha");
    expect(r.planSummary?.pathsFixed ?? 0).toBe(0);
    expect(r.planSummary?.advisoriesEliminated ?? 0).toBe(0);
    expect(formatText(r)).not.toMatch(/alpha -> 2\.0\.0/);
  });

  it("breaking path-only candidate plus an in-range refresh that clears another package: counted once", async () => {
    // shared (alpha ^1.0.0 only) is cleared by the in-range refresh. own is pinned ~1.0.0 by beta, so
    // alpha 2.0.0 (own ^1.2.0) only drops one of two own paths. Expected: 3 paths, 1 fixed (the
    // refresh), 1 of 2 advisories eliminated; alpha is not recommended as a breaking upgrade.
    lock({
      "": { dependencies: { alpha: "^1.0.0", beta: "^1.0.0" } },
      "node_modules/alpha": pub("alpha", "1.0.0", { dependencies: { shared: "^1.0.0", own: "~1.0.0" } }),
      "node_modules/beta": pub("beta", "1.0.0", { dependencies: { own: "~1.0.0" } }),
      "node_modules/shared": pub("shared", "1.0.0"),
      "node_modules/own": pub("own", "1.0.0"),
    });
    registry.alpha = {
      versions: { "1.0.0": { dependencies: { shared: "^1.0.0", own: "~1.0.0" } }, "2.0.0": { dependencies: { shared: "^1.0.0", own: "^1.2.0" } } },
    };
    registry.beta = { versions: { "1.0.0": { dependencies: { own: "~1.0.0" } } } };
    const r = await scan(dir, { cache: false });
    invariants(r);
    // The plan is the refresh only: alpha 2.0.0 clears nothing the refresh does not, so it is not proposed.
    // Fixed: the shared path (1). Advisories: only shared is eliminated, once.
    expect(r.planSummary).toEqual({ pathsTotal: 3, pathsFixed: 1, pathsRemaining: 2, advisoriesTotal: 2, advisoriesEliminated: 1 });
  });

  it("a breaking upgrade must clear something the safe refresh does not already clear", async () => {
    // Same fixture as d. alpha 2.0.0 'clears' shared@1.0.0, which the in-range refresh clears by
    // itself (refreshClears 1); on top of that it only removes an own path. Net new advisories: 0.
    lock({
      "": { dependencies: { alpha: "^1.0.0", beta: "^1.0.0" } },
      "node_modules/alpha": pub("alpha", "1.0.0", { dependencies: { shared: "^1.0.0", own: "~1.0.0" } }),
      "node_modules/beta": pub("beta", "1.0.0", { dependencies: { own: "~1.0.0" } }),
      "node_modules/shared": pub("shared", "1.0.0"),
      "node_modules/own": pub("own", "1.0.0"),
    });
    registry.alpha = {
      versions: { "1.0.0": { dependencies: { shared: "^1.0.0", own: "~1.0.0" } }, "2.0.0": { dependencies: { shared: "^1.0.0", own: "^1.2.0" } } },
    };
    registry.beta = { versions: { "1.0.0": { dependencies: { own: "~1.0.0" } } } };
    const r = await scan(dir, { cache: false });
    const a = find(r, "alpha");
    if (a?.status === "upgrade" && a.breaking) expect(a.clears.count).toBeGreaterThan(a.refreshClears ?? 0);
    expect(r.commands?.some((c) => c.kind === "breaking") ?? false).toBe(false);
  });

  it("when a breaking upgrade clears only what a safe refresh clears anyway, the entry says so (refreshClears)", async () => {
    // Both alpha and beta allow shared ^1.0.0, so `npm update` alone clears it. A breaking alpha 2.0.0
    // recommendation would be redundant: expected not an upgrade, or flagged with refreshClears.
    lock({
      "": { dependencies: { alpha: "^1.0.0", beta: "^1.0.0" } },
      "node_modules/alpha": pub("alpha", "1.0.0", { dependencies: { shared: "^1.0.0" } }),
      "node_modules/beta": pub("beta", "1.0.0", { dependencies: { shared: "^1.0.0" } }),
      "node_modules/shared": pub("shared", "1.0.0"),
    });
    registry.alpha = { versions: { "1.0.0": { dependencies: { shared: "^1.0.0" } }, "2.0.0": { dependencies: { shared: "^1.2.0" } } } };
    registry.beta = { versions: { "1.0.0": { dependencies: { shared: "^1.0.0" } } } };
    const r = await scan(dir, { cache: false });
    expect(r.planSummary).toEqual({ pathsTotal: 2, pathsFixed: 2, pathsRemaining: 0, advisoriesTotal: 1, advisoriesEliminated: 1 });
    const a = find(r, "alpha");
    if (a?.status === "upgrade") expect(a.refreshClears).toBe(1);
  });
});

describe("round two: reach and nesting", () => {
  it("gamma > alpha > delta > shared and zed > shared: only zed is named", async () => {
    lock({
      "": { dependencies: { alpha: "^1.0.0", zed: "^1.0.0", gamma: "^1.0.0" } },
      "node_modules/alpha": pub("alpha", "1.0.0", { dependencies: { delta: "^1.0.0" } }),
      "node_modules/delta": pub("delta", "1.0.0", { dependencies: { shared: "^1.0.0" } }),
      "node_modules/zed": pub("zed", "1.0.0", { dependencies: { zz: "^1.0.0" } }),
      "node_modules/zz": pub("zz", "1.0.0", { dependencies: { shared: "~1.0.0" } }),
      "node_modules/gamma": pub("gamma", "1.0.0", { dependencies: { alpha: "^1.0.0" } }),
      "node_modules/shared": pub("shared", "1.0.0"),
    });
    registry.alpha = { versions: { "1.0.0": { dependencies: { delta: "^1.0.0" } }, "1.1.0": { dependencies: { delta: "^1.1.0" } } } };
    registry.delta = { versions: { "1.0.0": { dependencies: { shared: "^1.0.0" } }, "1.1.0": { dependencies: { shared: "^1.2.0" } } } };
    registry.zed = { versions: { "1.0.0": { dependencies: { zz: "^1.0.0" } } } };
    registry.zz = { versions: { "1.0.0": { dependencies: { shared: "~1.0.0" } } } };
    registry.gamma = { versions: { "1.0.0": { dependencies: { alpha: "^1.0.0" } } } };
    const r = await scan(dir, { cache: false });
    invariants(r);
    const a = find(r, "alpha");
    expect(a?.status).toBe("upgrade");
    expect(a?.stillReachedVia).toEqual(["zed"]);
  });

  it("entry names a dependency as a remaining route although the plan upgrades that dependency too", async () => {
    // With both upgrades applied nothing is open, so neither entry should name the other.
    lock({
      "": { dependencies: { alpha: "^1.0.0", beta: "^1.0.0" } },
      "node_modules/alpha": pub("alpha", "1.0.0", { dependencies: { shared: "~1.0.0", own: "1.0.0" } }),
      "node_modules/beta": pub("beta", "1.0.0", { dependencies: { shared: "~1.0.0", other: "1.0.0" } }),
      "node_modules/shared": pub("shared", "1.0.0"),
      "node_modules/own": pub("own", "1.0.0"),
      "node_modules/other": pub("other", "1.0.0"),
    });
    registry.alpha = {
      versions: { "1.0.0": { dependencies: { shared: "~1.0.0", own: "1.0.0" } }, "1.1.0": { dependencies: { shared: "^1.2.0", own: "^1.2.0" } } },
    };
    registry.beta = {
      versions: { "1.0.0": { dependencies: { shared: "~1.0.0", other: "1.0.0" } }, "1.1.0": { dependencies: { shared: "^1.2.0", other: "^1.2.0" } } },
    };
    const r = await scan(dir, { cache: false });
    invariants(r);
    expect(r.planSummary).toEqual({ pathsTotal: 4, pathsFixed: 4, pathsRemaining: 0, advisoriesTotal: 3, advisoriesEliminated: 3 });
    for (const n of ["alpha", "beta"]) {
      const e = find(r, n);
      expect(e?.status).toBe("upgrade");
      expect(e?.stillReachedVia ?? []).toEqual([]);
      expect(e?.remaining ?? []).toEqual([]);
    }
  });

  it("one name@version at two locations, several dependents each", async () => {
    // shared@1.0.0 at the top (beta, gamma) and under alpha (alpha, x): 4 paths.
    lock({
      "": { dependencies: { alpha: "^1.0.0", beta: "^1.0.0", gamma: "^1.0.0" } },
      "node_modules/alpha": pub("alpha", "1.0.0", { dependencies: { shared: "1.0.0", x: "^1.0.0" } }),
      "node_modules/alpha/node_modules/shared": pub("shared", "1.0.0"),
      "node_modules/x": pub("x", "1.0.0", { dependencies: { shared: "1.0.0" } }),
      "node_modules/beta": pub("beta", "1.0.0", { dependencies: { shared: "~1.0.0" } }),
      "node_modules/gamma": pub("gamma", "1.0.0", { dependencies: { shared: "~1.0.0" } }),
      "node_modules/shared": pub("shared", "1.0.0"),
    });
    registry.alpha = {
      versions: { "1.0.0": { dependencies: { shared: "1.0.0", x: "^1.0.0" } }, "1.1.0": { dependencies: { shared: "^1.2.0", x: "^1.0.0" } } },
    };
    registry.x = { versions: { "1.0.0": { dependencies: { shared: "1.0.0" } }, "1.1.0": { dependencies: { shared: "^1.0.0" } } } };
    registry.beta = { versions: { "1.0.0": { dependencies: { shared: "~1.0.0" } } } };
    registry.gamma = { versions: { "1.0.0": { dependencies: { shared: "~1.0.0" } } } };
    const r = await scan(dir, { cache: false });
    invariants(r);
    expect(r.planSummary?.pathsTotal).toBe(4);
    expect(find(r, "alpha")?.paths?.total).toBe(4);
    expect(r.planSummary?.pathsRemaining).toBeGreaterThanOrEqual(2);
  });

  it("dev-only dependent next to a prod dependent counts both paths", async () => {
    lock({
      "": { dependencies: { alpha: "^1.0.0" }, devDependencies: { devA: "^1.0.0" } },
      "node_modules/alpha": pub("alpha", "1.0.0", { dependencies: { shared: "^1.0.0" } }),
      "node_modules/devA": pub("devA", "1.0.0", { dev: true, dependencies: { shared: "~1.0.0" } }),
      "node_modules/shared": pub("shared", "1.0.0"),
    });
    registry.alpha = { versions: { "1.0.0": { dependencies: { shared: "^1.0.0" } }, "1.1.0": { dependencies: { shared: "^1.2.0" } } } };
    registry.devA = { versions: { "1.0.0": { dependencies: { shared: "~1.0.0" } } } };
    const r = await scan(dir, { cache: false });
    invariants(r);
    expect(r.planSummary?.pathsTotal).toBe(2);
    expect(find(r, "alpha")?.paths).toMatchObject({ total: 2, fixed: 1, remaining: 1 });
    expect(find(r, "alpha")?.stillReachedVia).toEqual(["devA"]);
  });

  it("includeDev false drops the dev dependent from totals and reach", async () => {
    lock({
      "": { dependencies: { alpha: "^1.0.0" }, devDependencies: { devA: "^1.0.0" } },
      "node_modules/alpha": pub("alpha", "1.0.0", { dependencies: { shared: "^1.0.0" } }),
      "node_modules/devA": pub("devA", "1.0.0", { dev: true, dependencies: { shared: "~1.0.0" } }),
      "node_modules/shared": pub("shared", "1.0.0"),
    });
    registry.alpha = { versions: { "1.0.0": { dependencies: { shared: "^1.0.0" } }, "1.1.0": { dependencies: { shared: "^1.2.0" } } } };
    registry.devA = { versions: { "1.0.0": { dependencies: { shared: "~1.0.0" } } } };
    const r = await scan(dir, { cache: false, includeDev: false });
    invariants(r);
    expect(find(r, "alpha")?.stillReachedVia).toBeUndefined();
    expect(r.planSummary).toMatchObject({ pathsTotal: 1, pathsFixed: 1, advisoriesEliminated: 1 });
  });

  it("a dev-only vulnerable chain with includeDev false has no plan", async () => {
    lock({
      "": { devDependencies: { devA: "^1.0.0" } },
      "node_modules/devA": pub("devA", "1.0.0", { dev: true, dependencies: { shared: "^1.0.0" } }),
      "node_modules/shared": pub("shared", "1.0.0", { dev: true }),
    });
    registry.devA = { versions: { "1.0.0": { dependencies: { shared: "^1.0.0" } } } };
    const r = await scan(dir, { cache: false, includeDev: false });
    expect(r.plan).toEqual([]);
    expect(r.planSummary).toBeUndefined();
  });
});

describe("round two: text wording", () => {
  it.each([[0], [1], [3]])("wording with %i other dependents of the shared package", async (n) => {
    const names = Array.from({ length: n }, (_, i) => `d${i}`);
    lock({
      "": { dependencies: Object.fromEntries(["alpha", ...names].map((x) => [x, "^1.0.0"])) },
      "node_modules/alpha": pub("alpha", "1.0.0", { dependencies: { shared: "^1.0.0" } }),
      ...Object.fromEntries(names.map((x) => [`node_modules/${x}`, pub(x, "1.0.0", { dependencies: { shared: "~1.0.0" } })])),
      "node_modules/shared": pub("shared", "1.0.0"),
    });
    registry.alpha = { versions: { "1.0.0": { dependencies: { shared: "^1.0.0" } }, "1.1.0": { dependencies: { shared: "^1.2.0" } } } };
    for (const x of names) registry[x] = { versions: { "1.0.0": { dependencies: { shared: "~1.0.0" } } } };
    const r = await scan(dir, { cache: false });
    const text = formatText(r);
    if (n === 0) {
      expect(text).toContain("clears 1 advisory");
      expect(text).not.toContain("removes");
    } else {
      expect(text).toContain(`removes 1 of ${n + 1} vulnerable paths, clears no advisory`);
      expect(text).toContain("stays open");
      expect(text).toContain("still reached through");
    }
    expect(text).toContain(`Paths fixed: 1 of ${n + 1}`);
  });
});
