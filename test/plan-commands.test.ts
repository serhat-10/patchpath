import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatText } from "../src/core/format.js";
import { MAX_PLAN_REQUESTS } from "../src/core/plan.js";
import { scan } from "../src/core/scan.js";
import { compareVersions } from "../src/core/semver.js";
import type { PlanEntry, Report } from "../src/core/types.js";

// Fake OSV and registry, as in plan.test.ts: advisories affect [introduced, fixed).
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Advisory {
  id: string;
  name: string;
  introduced?: string;
  fixed?: string;
  severity?: string;
}
interface Version {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  deprecated?: string;
}

let registry: Record<string, { latest?: string; versions: Record<string, Version> }> = {};
let advisories: Advisory[] = [];
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

let dir: string;
const writeLock = (packages: Record<string, unknown>, lockfileVersion = 3) =>
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion, packages }));
const entry = (report: Report, name: string) => report.plan.find((e) => e.name === name) as PlanEntry;
const safeStep = (report: Report) => report.commands?.find((c) => c.kind === "safe");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "patchpath-cmd-"));
  requests = [];
  broken = new Set();
  advisories = [];
  registry = {};
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => fakeNetwork(String(input), init)));
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe("plan commands", () => {
  it("keeps breaking upgrades out of the non-breaking command, one command each", async () => {
    writeLock({
      "": { dependencies: { lib: "^1.0.0" }, devDependencies: { tool: "^1.0.0" } },
      "node_modules/lib": pub("lib", "1.0.0"),
      "node_modules/tool": pub("tool", "1.0.0", { dev: true }),
    });
    advisories = [
      { id: "GHSA-lib", name: "lib", fixed: "1.0.1" },
      { id: "GHSA-tool", name: "tool", fixed: "2.0.0", severity: "CRITICAL" },
    ];
    registry = {
      lib: { versions: { "1.0.0": {}, "1.0.1": {} } },
      tool: { versions: { "1.0.0": {}, "1.1.0": {}, "2.0.0": {} } },
    };
    const report = await scan(dir, { cache: false });
    expect(report.commands).toEqual([
      expect.objectContaining({ kind: "safe", install: ["lib@1.0.1"], update: [], entries: ["lib"] }),
      expect.objectContaining({ kind: "breaking", install: ["tool@2.0.0"], entries: ["tool"] }),
    ]);
    expect(safeStep(report)?.clears).toMatchObject({ count: 1, total: 2 });
    const text = formatText(report);
    expect(text).toContain("# 1. non-breaking, estimated to clear 1 of 2 advisories\n  npm install -- lib@1.0.1\n");
    expect(text).toContain("# tool: may break (new major or 0.x minor)\n  npm install -- tool@2.0.0");
    // No line mixes the two.
    expect(text).not.toMatch(/npm install .*lib@1\.0\.1.*tool@|npm install .*tool@2\.0\.0.*lib@/);
  });

  it("flags a target whose peer dependency the installed tree does not satisfy, and keeps it out of the safe step", async () => {
    writeLock({
      "": { dependencies: { "dev-server": "^3.0.0", bundler: "^4.0.0", lib: "^1.0.0" } },
      "node_modules/dev-server": pub("dev-server", "3.0.0", { peerDependencies: { bundler: "^4.0.0" } }),
      "node_modules/bundler": pub("bundler", "4.41.2"),
      "node_modules/lib": pub("lib", "1.0.0"),
    });
    advisories = [
      { id: "GHSA-ds", name: "dev-server", fixed: "5.0.0" },
      { id: "GHSA-lib", name: "lib", fixed: "1.0.1" },
    ];
    registry = {
      "dev-server": {
        versions: {
          "3.0.0": { peerDependencies: { bundler: "^4.0.0" } },
          "5.2.6": { peerDependencies: { bundler: "^5.0.0" } },
        },
      },
      bundler: { versions: { "4.41.2": {}, "5.0.0": {} } },
      lib: { versions: { "1.0.0": {}, "1.0.1": {} } },
    };
    const report = await scan(dir, { cache: false });
    const conflict = "dev-server@5.2.6 needs bundler@^5.0.0 (installed 4.41.2)";
    expect(entry(report, "dev-server")).toMatchObject({ target: "5.2.6", breaking: true, peerConflicts: [conflict] });
    expect(safeStep(report)?.install).toEqual(["lib@1.0.1"]);
    expect(report.commands?.find((c) => c.entries.includes("dev-server"))).toMatchObject({
      kind: "breaking",
      install: ["dev-server@5.2.6"],
      conflicts: [conflict],
    });
    expect(formatText(report)).toContain(`likely peer conflict, npm may refuse with ERESOLVE: ${conflict}`);
  });

  it("prints commands with a likely peer conflict last, and says to scan again between steps", async () => {
    writeLock({
      "": { dependencies: { "dev-server": "^3.0.0", bundler: "^4.0.0", tool: "^1.0.0" } },
      "node_modules/dev-server": pub("dev-server", "3.0.0", { peerDependencies: { bundler: "^4.0.0" } }),
      "node_modules/bundler": pub("bundler", "4.41.2"),
      "node_modules/tool": pub("tool", "1.0.0"),
    });
    advisories = [
      // The conflicting upgrade fixes the worse advisory, so the plan lists it first.
      { id: "GHSA-ds", name: "dev-server", fixed: "5.0.0", severity: "CRITICAL" },
      { id: "GHSA-tool", name: "tool", fixed: "2.0.0", severity: "LOW" },
    ];
    registry = {
      "dev-server": { versions: { "3.0.0": { peerDependencies: { bundler: "^4.0.0" } }, "5.2.6": { peerDependencies: { bundler: "^5.0.0" } } } },
      bundler: { versions: { "4.41.2": {}, "5.0.0": {} } },
      tool: { versions: { "1.0.0": {}, "2.0.0": {} } },
    };
    const report = await scan(dir, { cache: false });
    expect(report.plan.map((e) => e.name).slice(0, 2)).toEqual(["dev-server", "tool"]);
    expect(report.commands?.map((c) => c.entries[0])).toEqual(["tool", "dev-server"]);
    const text = formatText(report);
    expect(text).toContain("scan again before the next");
    expect(text.indexOf("npm install -- tool@2.0.0")).toBeLessThan(text.indexOf("npm install -- dev-server@5.2.6"));
    expect(text).toMatch(/# dev-server: .*run it last, on its own/);
  });

  it("treats an installed prerelease as outside a peer range, like npm", async () => {
    // npm (arborist dep-valid) checks with semver.satisfies(version, range, loose): no prereleases.
    writeLock({
      "": { dependencies: { app: "^1.0.0", graphql: "15.1.0-rc.1", tools: "^4.0.0" } },
      "node_modules/app": pub("app", "1.0.0", { dependencies: { leaf: "^1.0.0" } }),
      "node_modules/leaf": pub("leaf", "1.0.0"),
      "node_modules/graphql": pub("graphql", "15.1.0-rc.1"),
      "node_modules/tools": pub("tools", "4.0.7", { peerDependencies: { graphql: "^15.0.0" } }),
    });
    advisories = [{ id: "GHSA-leaf", name: "leaf", fixed: "1.0.1" }];
    registry = { app: { versions: { "1.0.0": { dependencies: { leaf: "^1.0.0" } } } }, leaf: { versions: { "1.0.0": {}, "1.0.1": {} } } };
    const report = await scan(dir, { cache: false });
    expect(safeStep(report)).toMatchObject({
      legacyPeerDeps: true,
      existingConflicts: ["tools@4.0.7 wants graphql@^15.0.0, installed 15.1.0-rc.1"],
    });
  });

  it.each([
    ["*", "0.61.5-jitsi.2"],
    ["", "1.4.5-lts.1"],
    [" * ", "2.0.0-beta.3"],
  ])("treats any installed version, a prerelease too, as inside the peer range %j, like npm", async (spec, installed) => {
    // arborist dep-valid: a fetchSpec of "*" is valid for any version, and "" is read as "*".
    writeLock({
      "": { dependencies: { app: "^1.0.0", rn: installed, tools: "^4.0.0" } },
      "node_modules/app": pub("app", "1.0.0", { dependencies: { leaf: "^1.0.0" } }),
      "node_modules/leaf": pub("leaf", "1.0.0"),
      "node_modules/rn": pub("rn", installed),
      "node_modules/tools": pub("tools", "4.0.7", { peerDependencies: { rn: spec } }),
    });
    advisories = [{ id: "GHSA-leaf", name: "leaf", fixed: "1.0.1" }];
    registry = { app: { versions: { "1.0.0": { dependencies: { leaf: "^1.0.0" } } } }, leaf: { versions: { "1.0.0": {}, "1.0.1": {} } } };
    const report = await scan(dir, { cache: false });
    expect(safeStep(report)).toMatchObject({ update: ["leaf"] });
    expect(safeStep(report)?.existingConflicts).toBeUndefined();
    expect(safeStep(report)?.legacyPeerDeps).toBeUndefined();
  });

  describe("optional peer dependencies", () => {
    // tool 1 pulls in sub, which needs notifier 1 (jest-cli 24 -> @jest/reporters -> node-notifier).
    // tool 2 lists notifier ^2 as an optional peer instead.
    const setup = (extraRootDeps: Record<string, string>, optional: boolean) => {
      writeLock({
        "": { dependencies: { tool: "^1.0.0", ...extraRootDeps } },
        "node_modules/tool": pub("tool", "1.0.0", { dependencies: { sub: "^1.0.0" } }),
        "node_modules/sub": pub("sub", "1.0.0", { dependencies: { notifier: "^1.0.0" } }),
        "node_modules/notifier": pub("notifier", "1.0.0"),
      });
      advisories = [{ id: "GHSA-tool", name: "tool", fixed: "2.0.0" }];
      registry = {
        tool: {
          versions: {
            "1.0.0": { dependencies: { sub: "^1.0.0" } },
            "2.0.0": {
              peerDependencies: { notifier: "^2.0.0" },
              ...(optional ? { peerDependenciesMeta: { notifier: { optional: true } } } : {}),
            },
          },
        },
        sub: { versions: { "1.0.0": { dependencies: { notifier: "^1.0.0" } } } },
        notifier: { versions: { "1.0.0": {}, "2.0.0": {} } },
      };
    };

    it("does not warn about an optional peer that is only installed because the upgraded package pulled it in", async () => {
      setup({}, true);
      const report = await scan(dir, { cache: false });
      expect(entry(report, "tool")).toMatchObject({ target: "2.0.0" });
      expect(entry(report, "tool").peerConflicts).toBeUndefined();
      expect(formatText(report)).not.toContain("needs notifier");
    });

    it("still warns when the optional peer is installed for someone else", async () => {
      setup({ notifier: "^1.0.0" }, true);
      const report = await scan(dir, { cache: false });
      expect(entry(report, "tool").peerConflicts).toEqual(["tool@2.0.0 needs notifier@^2.0.0 (installed 1.0.0)"]);
    });

    it("still warns when the peer is not marked optional", async () => {
      setup({}, false);
      const report = await scan(dir, { cache: false });
      expect(entry(report, "tool").peerConflicts).toEqual(["tool@2.0.0 needs notifier@^2.0.0 (installed 1.0.0)"]);
    });
  });

  it("says the installed version is deprecated and names the upgrade target, not 'replace it'", async () => {
    writeLock({
      "": { dependencies: { lib: "^1.0.0" } },
      "node_modules/lib": pub("lib", "1.0.0"),
    });
    advisories = [{ id: "GHSA-lib", name: "lib", fixed: "1.0.1" }];
    registry = { lib: { versions: { "1.0.0": { deprecated: "old release" }, "1.0.1": {} } } };
    const report = await scan(dir, { cache: false });
    const text = formatText(report);
    expect(text).toMatch(/lib 1\.0\.0 -> 1\.0\.1: clears 1 advisory .*installed version deprecated, upgrade to 1\.0\.1/);
    expect(text).not.toContain("replace it");
  });

  it("moves a non-breaking upgrade with a peer conflict (declared by another direct dependency) out of the safe step", async () => {
    writeLock({
      "": { dependencies: { core: "^1.0.0", forms: "^1.0.0", lib: "^1.0.0" } },
      "node_modules/core": pub("core", "1.0.0"),
      "node_modules/forms": pub("forms", "1.0.0", { peerDependencies: { core: "1.0.0" } }),
      "node_modules/lib": pub("lib", "1.0.0"),
    });
    advisories = [
      { id: "GHSA-core", name: "core", fixed: "1.1.0" },
      { id: "GHSA-lib", name: "lib", fixed: "1.0.1" },
    ];
    registry = {
      core: { versions: { "1.0.0": {}, "1.1.0": {} } },
      forms: { versions: { "1.0.0": { peerDependencies: { core: "1.0.0" } } } },
      lib: { versions: { "1.0.0": {}, "1.0.1": {} } },
    };
    const report = await scan(dir, { cache: false });
    expect(entry(report, "core")).toMatchObject({ target: "1.1.0", breaking: false, peerConflicts: ["forms@1.0.0 wants core@1.0.0"] });
    expect(safeStep(report)?.install).toEqual(["lib@1.0.1"]);
    expect(report.commands?.find((c) => c.entries.includes("core"))).toMatchObject({ kind: "conflict", install: ["core@1.1.0"] });
    expect(formatText(report)).toContain("# core: non-breaking; likely peer conflict");
  });

  it("moves a lockstep family (same scope, same version) in one command", async () => {
    writeLock({
      "": { dependencies: { "@ng/core": "^14.0.0", "@ng/router": "^14.0.0", "@other/x": "^14.0.0" } },
      "node_modules/@ng/core": pub("@ng/core", "14.0.0"),
      "node_modules/@ng/router": pub("@ng/router", "14.0.0", { peerDependencies: { "@ng/core": "14.0.0" } }),
      "node_modules/@other/x": pub("@other/x", "14.0.0"),
    });
    advisories = [{ id: "GHSA-ng", name: "@ng/core", fixed: "20.0.0" }];
    registry = {
      "@ng/core": { versions: { "14.0.0": {}, "20.0.0": {}, "20.3.28": {} } },
      "@ng/router": {
        versions: {
          "14.0.0": { peerDependencies: { "@ng/core": "14.0.0" } },
          "20.3.28": { peerDependencies: { "@ng/core": "20.3.28" } },
        },
      },
      "@other/x": { versions: { "14.0.0": {}, "20.3.28": {} } },
    };
    const report = await scan(dir, { cache: false });
    // The newest release of the new major, and the router moves with it, so no peer conflict.
    expect(report.commands).toEqual([
      expect.objectContaining({ kind: "breaking", install: ["@ng/core@20.3.28", "@ng/router@20.3.28"], conflicts: undefined }),
    ]);
  });
});

// bitwarden (npm 11.16, checked on that lockfile and on a minimal Angular project): `npm install
// @angular-devkit/build-angular@14.2.11` stops with ERESOLVE. Its optional peer @angular/localize is
// not installed, yet npm loads it into the peer set at the newest release in range (14.3.0) and
// checks its peers: @angular/compiler@14.3.0, where 14.1.0 is installed and
// @angular/platform-browser-dynamic@14.1.0 (not in that peer set) holds it at exactly 14.1.0.
// Here: builder = build-angular, localize = @angular/localize, cli = compiler-cli,
// compiler = @angular/compiler, dynamic = platform-browser-dynamic.
describe("peers npm checks for a new version although they are not installed", () => {
  const setup = (opts: { rootCompiler?: string; withDynamic?: boolean; localizeInstalled?: boolean; overrides?: Record<string, string> } = {}) => {
    const { rootCompiler = "^1.0.0", withDynamic = true, localizeInstalled = false, overrides } = opts;
    const dependencies: Record<string, string> = { compiler: rootCompiler, lib: "^1.0.0", ...(withDynamic ? { dynamic: "^1.0.0" } : {}) };
    const devDependencies: Record<string, string> = { builder: "^1.0.0", cli: "^1.0.0", ...(localizeInstalled ? { localize: "1.0.0" } : {}) };
    if (overrides) writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", dependencies, devDependencies, overrides }));
    const builderPeers = { peerDependencies: { cli: "^1.0.0", localize: "^1.0.0" }, peerDependenciesMeta: { localize: { optional: true } } };
    writeLock({
      "": { name: "x", dependencies, devDependencies },
      "node_modules/compiler": pub("compiler", "1.0.0"),
      "node_modules/lib": pub("lib", "1.0.0"),
      ...(withDynamic ? { "node_modules/dynamic": pub("dynamic", "1.0.0", { peerDependencies: { compiler: "1.0.0" } }) } : {}),
      "node_modules/cli": pub("cli", "1.0.0", { dev: true, peerDependencies: { compiler: "1.0.0" } }),
      "node_modules/builder": pub("builder", "1.0.0", { dev: true, peerDependencies: builderPeers.peerDependencies }),
      ...(localizeInstalled ? { "node_modules/localize": pub("localize", "1.0.0", { dev: true, peerDependencies: { compiler: "1.0.0", cli: "1.0.0" } }) } : {}),
    });
    advisories = [
      { id: "GHSA-builder", name: "builder", fixed: "1.1.0" },
      { id: "GHSA-lib", name: "lib", fixed: "1.0.1" },
    ];
    registry = {
      builder: { versions: { "1.0.0": builderPeers, "1.1.0": builderPeers } },
      // `latest` is outside ^1.0.0, as for @angular/localize (22.x): npm takes the newest 1.x.
      localize: {
        latest: "2.0.0",
        versions: {
          "1.0.0": { peerDependencies: { compiler: "1.0.0", cli: "1.0.0" } },
          "1.1.0": { peerDependencies: { compiler: "1.1.0", cli: "1.1.0" } },
          "2.0.0": { peerDependencies: { compiler: "2.0.0", cli: "2.0.0" } },
        },
      },
      compiler: { versions: { "1.0.0": {}, "1.1.0": {}, "2.0.0": {} } },
      cli: { versions: { "1.0.0": { peerDependencies: { compiler: "1.0.0" } }, "1.1.0": { peerDependencies: { compiler: "1.1.0" } } } },
      dynamic: { versions: { "1.0.0": { peerDependencies: { compiler: "1.0.0" } } } },
      lib: { versions: { "1.0.0": {}, "1.0.1": {} } },
    };
  };
  const conflict =
    "builder@1.1.0 has peer localize, which is not installed: npm still checks localize@1.1.0, which needs compiler@1.1.0 (installed 1.0.0, held at 1.0.0 by dynamic@1.0.0)";

  it("keeps the upgrade out of the safe step when such a peer needs a version the tree holds back", async () => {
    setup();
    const report = await scan(dir, { cache: false });
    expect(entry(report, "builder")).toMatchObject({ target: "1.1.0", breaking: false, peerConflicts: [conflict] });
    expect(safeStep(report)?.install).toEqual(["lib@1.0.1"]);
    expect(report.commands?.find((c) => c.entries.includes("builder"))).toMatchObject({
      kind: "conflict",
      install: ["builder@1.1.0"],
      conflicts: [conflict],
    });
    expect(formatText(report)).toContain(`# builder: non-breaking; likely peer conflict, npm may refuse with ERESOLVE: ${conflict}`);
  });

  it("asks the registry only for that peer's document, once, and says the same with a warm cache", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "patchpath-cache-"));
    try {
      setup();
      const first = await scan(dir, { cacheDir });
      expect(requests.filter((r) => r.startsWith("https://registry.npmjs.org/localize"))).toHaveLength(1);
      requests = [];
      const second = await scan(dir, { cacheDir });
      expect(requests.filter((r) => r.includes("registry.npmjs.org"))).toEqual([]);
      expect(second.commands).toEqual(first.commands);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("does not flag it when the root pins the peer's peer at the installed version (npm keeps that one)", async () => {
    setup({ rootCompiler: "1.0.0" });
    const report = await scan(dir, { cache: false });
    expect(entry(report, "builder").peerConflicts).toBeUndefined();
    expect(safeStep(report)?.install).toEqual(["builder@1.1.0", "lib@1.0.1"]);
  });

  it("does not flag it when the peer is installed and its peers are met", async () => {
    setup({ localizeInstalled: true });
    const report = await scan(dir, { cache: false });
    expect(entry(report, "builder").peerConflicts).toBeUndefined();
    expect(safeStep(report)?.install).toEqual(["builder@1.1.0", "lib@1.0.1"]);
  });

  it("does not flag it when only packages of the same peer set hold the version back (npm replaces them together)", async () => {
    // cli also pins compiler at 1.0.0, but cli is a peer of builder: npm moves it along.
    setup({ withDynamic: false });
    const report = await scan(dir, { cache: false });
    expect(entry(report, "builder").peerConflicts).toBeUndefined();
    expect(safeStep(report)?.install).toEqual(["builder@1.1.0", "lib@1.0.1"]);
  });

  it("does not flag it when a root override names the package that is held back (not modelled)", async () => {
    setup({ overrides: { compiler: "$compiler" } });
    const report = await scan(dir, { cache: false });
    expect(entry(report, "builder").peerConflicts).toBeUndefined();
  });

  it("does not flag it when the package holding the version back moves in the same step", async () => {
    setup();
    advisories.push({ id: "GHSA-dynamic", name: "dynamic", fixed: "1.1.0" });
    registry.dynamic = { versions: { "1.0.0": { peerDependencies: { compiler: "1.0.0" } }, "1.1.0": { peerDependencies: { compiler: "^1.0.0" } } } };
    const report = await scan(dir, { cache: false });
    expect(entry(report, "builder").peerConflicts).toBeUndefined();
    expect(safeStep(report)?.install).toEqual(["builder@1.1.0", "dynamic@1.1.0", "lib@1.0.1"]);
  });

  it("does not flag it when the version is held back by a plain dependency, not a peer (not checked against npm)", async () => {
    setup({ withDynamic: false });
    const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")) as { packages: Record<string, Record<string, unknown>> };
    (lock.packages[""]?.dependencies as Record<string, string>).app = "^1.0.0";
    lock.packages["node_modules/app"] = pub("app", "1.0.0", { dependencies: { compiler: "1.0.0" } });
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify(lock));
    registry.app = { versions: { "1.0.0": { dependencies: { compiler: "1.0.0" } } } };
    const report = await scan(dir, { cache: false });
    expect(entry(report, "builder").peerConflicts).toBeUndefined();
  });

  it("does not flag it when the peer's document cannot be read", async () => {
    setup();
    broken.add("localize");
    const report = await scan(dir, { cache: false });
    expect(entry(report, "builder").peerConflicts).toBeUndefined();
    expect(safeStep(report)?.install).toEqual(["builder@1.1.0", "lib@1.0.1"]);
  });
});

describe("aliases, workspaces and peer dependencies of the project", () => {
  it("keeps an alias and the real name apart, and installs the alias as alias@npm:name@version", async () => {
    writeLock({
      "": { dependencies: { "socket.io-client": "2.4.0", sio4: "npm:socket.io-client@4.0.0" } },
      "node_modules/socket.io-client": pub("socket.io-client", "2.4.0"),
      "node_modules/sio4": pub("socket.io-client", "4.0.0", { name: "socket.io-client" }),
    });
    advisories = [
      { id: "GHSA-v2", name: "socket.io-client", fixed: "2.5.0" },
      { id: "GHSA-v4", name: "socket.io-client", introduced: "4.0.0", fixed: "4.1.0" },
    ];
    registry = { "socket.io-client": { versions: { "2.4.0": {}, "2.5.0": {}, "4.0.0": {}, "4.1.0": {} } } };
    const report = await scan(dir, { cache: false });
    expect(report.plan.map((e) => [e.name, e.alias, e.version, e.target])).toEqual(
      expect.arrayContaining([
        ["socket.io-client", undefined, "2.4.0", "2.5.0"],
        ["socket.io-client", "sio4", "4.0.0", "4.1.0"],
      ]),
    );
    expect(safeStep(report)?.install.sort()).toEqual(["sio4@npm:socket.io-client@4.1.0", "socket.io-client@2.5.0"]);
    expect(safeStep(report)?.clears).toMatchObject({ count: 2, total: 2 });
    expect(formatText(report)).toMatch(/npm install -- (socket\.io-client@2\.5\.0 sio4@npm:socket\.io-client@4\.1\.0|sio4@npm:socket\.io-client@4\.1\.0 socket\.io-client@2\.5\.0)\n/);
  });

  const workspaceLock = (rootDeps: Record<string, string> = {}) =>
    writeLock({
      "": { workspaces: ["packages/a"], dependencies: rootDeps },
      "packages/a": { name: "a", version: "1.0.0", dependencies: { mocha: "^3.5.3" } },
      "node_modules/a": { resolved: "packages/a", link: true },
      "node_modules/mocha": pub("mocha", "3.5.3"),
    });

  it("installs a workspace's dependency in that workspace (-w), not in the root", async () => {
    workspaceLock();
    advisories = [{ id: "GHSA-mocha", name: "mocha", fixed: "3.5.4" }];
    registry = { mocha: { versions: { "3.5.3": {}, "3.5.4": {} } } };
    const report = await scan(dir, { cache: false });
    expect(entry(report, "mocha")).toMatchObject({ target: "3.5.4", workspaces: ["packages/a"] });
    expect(safeStep(report)).toMatchObject({ install: [], workspaceInstall: { "packages/a": ["mocha@3.5.4"] } });
    const text = formatText(report);
    expect(text).toContain("  npm install -w packages/a -- mocha@3.5.4\n");
    expect(text).not.toMatch(/npm install -- mocha/);
  });

  it("installs in the root and in the workspace when both declare the package", async () => {
    workspaceLock({ mocha: "^3.5.0" });
    advisories = [{ id: "GHSA-mocha", name: "mocha", fixed: "3.5.4" }];
    registry = { mocha: { versions: { "3.5.3": {}, "3.5.4": {} } } };
    const report = await scan(dir, { cache: false });
    expect(safeStep(report)).toMatchObject({ install: ["mocha@3.5.4"], workspaceInstall: { "packages/a": ["mocha@3.5.4"] } });
  });

  it("keeps two versions of one name in two workspaces apart", async () => {
    writeLock({
      "": { workspaces: ["packages/a", "packages/b"] },
      "packages/a": { name: "a", version: "1.0.0", dependencies: { lib: "^1.0.0" } },
      "packages/b": { name: "b", version: "1.0.0", dependencies: { lib: "^2.0.0" } },
      "node_modules/a": { resolved: "packages/a", link: true },
      "node_modules/b": { resolved: "packages/b", link: true },
      "node_modules/lib": pub("lib", "1.0.0"),
      "packages/b/node_modules/lib": pub("lib", "2.0.0"),
    });
    advisories = [
      { id: "GHSA-1", name: "lib", fixed: "1.0.1" },
      { id: "GHSA-2", name: "lib", introduced: "2.0.0", fixed: "2.0.1" },
    ];
    registry = { lib: { versions: { "1.0.0": {}, "1.0.1": {}, "2.0.0": {}, "2.0.1": {} } } };
    const report = await scan(dir, { cache: false });
    expect(safeStep(report)?.workspaceInstall).toEqual({ "packages/a": ["lib@1.0.1"], "packages/b": ["lib@2.0.1"] });
    expect(safeStep(report)?.clears).toMatchObject({ count: 2, total: 2 });
  });

  it("leaves an install refused for its workspace folder out of the estimate, not only out of the command", async () => {
    writeLock({
      "": { workspaces: ["packages/$(calc)"], dependencies: { other: "^1.0.0" } },
      // Pinned exactly: only the (refused) install could move it, not an in-range npm update.
      "packages/$(calc)": { name: "w", version: "1.0.0", dependencies: { lib: "1.0.0" } },
      "node_modules/w": { resolved: "packages/$(calc)", link: true },
      "node_modules/lib": pub("lib", "1.0.0"),
      "node_modules/other": pub("other", "1.0.0"),
    });
    advisories = [
      { id: "GHSA-lib", name: "lib", fixed: "1.0.1" },
      { id: "GHSA-other", name: "other", fixed: "1.0.1" },
    ];
    registry = { lib: { versions: { "1.0.0": {}, "1.0.1": {} } }, other: { versions: { "1.0.0": {}, "1.0.1": {} } } };
    const report = await scan(dir, { cache: false });
    expect(safeStep(report)).toMatchObject({ install: ["other@1.0.1"], clears: { count: 1, total: 2, packages: ["other@1.0.0"] } });
    expect(safeStep(report)?.workspaceInstall).toBeUndefined();
    expect(report.warnings.some((w) => w.includes("not one npm accepts as it is") && w.includes("$(calc)"))).toBe(true);
    expect(entry(report, "lib")).toMatchObject({ status: "unavailable", clears: { count: 0 } });
    const text = formatText(report);
    expect(text).toContain("estimated to clear 1 of 2 advisories");
    expect(text).not.toMatch(/lib@1\.0\.0 .*covered by/);
    for (const line of text.split("\n").filter((l) => /^\s*npm /.test(l))) expect(line).not.toContain("$(");
  });

  it("does not put a package that is only a peer dependency of the project into the safe step", async () => {
    writeLock({
      "": { peerDependencies: { ms: "^2.0.0" }, dependencies: { lib: "^1.0.0" } },
      "node_modules/ms": pub("ms", "2.0.0", { peer: true }),
      "node_modules/lib": pub("lib", "1.0.0"),
    });
    advisories = [
      { id: "GHSA-ms", name: "ms", fixed: "2.1.0" },
      { id: "GHSA-lib", name: "lib", fixed: "1.0.1" },
    ];
    registry = { ms: { versions: { "2.0.0": {}, "2.1.0": {} } }, lib: { versions: { "1.0.0": {}, "1.0.1": {} } } };
    const report = await scan(dir, { cache: false });
    expect(safeStep(report)?.install).toEqual(["lib@1.0.1"]);
    expect(report.commands?.find((c) => c.entries.includes("ms"))).toMatchObject({ kind: "peer", install: ["ms@2.1.0"], peerRange: ["ms"] });
    expect(formatText(report)).toContain("# ms: non-breaking; a peerDependency of this project: npm install raises its range in package.json");
  });
});

describe("in-range refresh", () => {
  it("says npm update when the fix is inside the range the parent declares", async () => {
    writeLock({
      "": { dependencies: { framework: "^5.0.0" } },
      "node_modules/framework": pub("framework", "5.16.1", { dependencies: { axios: "^1.6.0" } }),
      "node_modules/axios": pub("axios", "1.13.5"),
    });
    advisories = [{ id: "GHSA-axios", name: "axios", fixed: "1.20.0" }];
    registry = {
      framework: { latest: "5.16.1", versions: { "5.16.1": { dependencies: { axios: "^1.6.0" } } } },
      axios: { latest: "1.21.0", versions: { "1.13.5": {}, "1.20.0": {}, "1.21.0": {} } },
    };
    const report = await scan(dir, { cache: false });
    expect(entry(report, "framework")).toMatchObject({ status: "no-fix", refreshClears: 1 });
    expect(report.refresh).toMatchObject({ update: ["axios"], clears: { count: 1, packages: ["axios@1.13.5"] }, covered: ["axios@1.13.5"] });
    expect(report.commands).toEqual([expect.objectContaining({ kind: "safe", install: [], update: ["axios"] })]);
    const text = formatText(report);
    expect(text).toContain("  npm update -- axios\n");
    expect(text).toContain("the in-range npm update below clears 1 of them without changing framework");
    expect(text).toContain("axios@1.13.5 (transitive) 1 advisory, worst high: covered by the in-range npm update");
    // npm picks the newest in range, and that version was checked against OSV too.
    expect(requests.some((r) => r.includes("/querybatch") && r.includes('"version":"1.21.0"'))).toBe(true);
  });

  it("updates the parent too when the parent pins the vulnerable version", async () => {
    writeLock({
      "": { dependencies: { app: "^1.0.0" } },
      "node_modules/app": pub("app", "1.0.0", { dependencies: { mid: "^2.0.0" } }),
      "node_modules/mid": pub("mid", "2.0.0", { dependencies: { leaf: "1.0.0" } }),
      "node_modules/leaf": pub("leaf", "1.0.0"),
    });
    advisories = [{ id: "GHSA-leaf", name: "leaf", fixed: "1.0.1" }];
    registry = {
      app: { versions: { "1.0.0": { dependencies: { mid: "^2.0.0" } } } },
      mid: { versions: { "2.0.0": { dependencies: { leaf: "1.0.0" } }, "2.1.0": { dependencies: { leaf: "^1.0.1" } } } },
      leaf: { versions: { "1.0.0": {}, "1.0.1": {} } },
    };
    const report = await scan(dir, { cache: false });
    // `npm update leaf` alone cannot move it (mid pins 1.0.0); `npm update mid` brings ^1.0.1.
    expect(report.refresh?.update).toEqual(["mid"]);
    expect(safeStep(report)).toMatchObject({ update: ["mid"], clears: { count: 1, total: 1 } });
  });

  it("leaves out of npm update a package whose peer is already in conflict, and says so", async () => {
    writeLock({
      "": { dependencies: { app: "^1.0.0", graphql: "15.0.0", tools: "^4.0.0" } },
      "node_modules/app": pub("app", "1.0.0", { dependencies: { server: "^2.0.0" } }),
      "node_modules/server": pub("server", "2.11.0", { dependencies: { leaf: "1.0.0" }, peerDependencies: { graphql: "^14.0.0 || ^15.0.0" } }),
      "node_modules/leaf": pub("leaf", "1.0.0"),
      "node_modules/graphql": pub("graphql", "15.0.0"),
      // Already broken today: tools wants graphql 14, the root has 15.
      "node_modules/tools": pub("tools", "4.0.7", { peerDependencies: { graphql: "^14.0.0" } }),
    });
    advisories = [{ id: "GHSA-leaf", name: "leaf", fixed: "1.0.1" }];
    registry = {
      app: { versions: { "1.0.0": { dependencies: { server: "^2.0.0" } } } },
      server: {
        versions: {
          "2.11.0": { dependencies: { leaf: "1.0.0" }, peerDependencies: { graphql: "^14.0.0 || ^15.0.0" } },
          "2.26.2": { dependencies: { leaf: "^1.0.1" }, peerDependencies: { graphql: "^14.0.0 || ^15.0.0" } },
        },
      },
      leaf: { versions: { "1.0.0": {}, "1.0.1": {} } },
    };
    const report = await scan(dir, { cache: false });
    expect(report.refresh).toBeUndefined();
    const step = safeStep(report);
    expect(step?.update ?? []).not.toContain("server");
    expect(step?.held).toEqual([
      "server: server@2.26.2 has peer graphql, which is already in conflict (tools@4.0.7 wants graphql@^14.0.0, installed 15.0.0)",
    ]);
    expect(formatText(report)).toContain("# not in npm update (likely peer conflict): server:");
  });

  // inmemory wants graphql 14, the root has 15: npm install and npm update both stop with ERESOLVE.
  const brokenPeerLock = (extra: Record<string, unknown> = {}, rootDeps: Record<string, string> = {}) => {
    writeLock({
      "": { dependencies: { app: "^1.0.0", graphql: "15.0.0", lib: "^1.0.0", ...rootDeps }, devDependencies: { inmemory: "1.6.5" } },
      "node_modules/app": pub("app", "1.0.0", { dependencies: { leaf: "^1.0.0" } }),
      "node_modules/leaf": pub("leaf", "1.0.0"),
      "node_modules/lib": pub("lib", "1.0.0"),
      "node_modules/graphql": pub("graphql", "15.0.0"),
      "node_modules/inmemory": pub("inmemory", "1.6.5", { dev: true, peerDependencies: { graphql: "^14.0.0" } }),
      ...extra,
    });
    advisories = [
      { id: "GHSA-leaf", name: "leaf", fixed: "1.0.1" },
      { id: "GHSA-lib", name: "lib", fixed: "1.0.1" },
    ];
    registry = {
      app: { versions: { "1.0.0": { dependencies: { leaf: "^1.0.0" } } } },
      leaf: { versions: { "1.0.0": {}, "1.0.1": {} } },
      lib: { versions: { "1.0.0": {}, "1.0.1": {} } },
    };
  };

  it("adds --legacy-peer-deps to npm install and npm update when a direct dependency's peer is already broken", async () => {
    brokenPeerLock();
    const report = await scan(dir, { cache: false });
    expect(safeStep(report)).toMatchObject({
      install: ["lib@1.0.1"],
      update: ["leaf"],
      legacyPeerDeps: true,
      existingConflicts: ["inmemory@1.6.5 wants graphql@^14.0.0, installed 15.0.0"],
    });
    const text = formatText(report);
    expect(text).toContain("npm install and npm update stop with ERESOLVE without --legacy-peer-deps");
    expect(text).toContain("  npm install --legacy-peer-deps -- lib@1.0.1\n  npm update --legacy-peer-deps -- leaf\n");
  });

  it("does not use --legacy-peer-deps when packages are installed only as peers: it would remove them", async () => {
    brokenPeerLock(
      {
        "node_modules/react-dom": pub("react-dom", "18.2.0", { peerDependencies: { react: "^18.2.0" } }),
        "node_modules/react": pub("react", "18.3.1", { peer: true }),
      },
      { "react-dom": "18.2.0" },
    );
    const report = await scan(dir, { cache: false });
    expect(safeStep(report)).toMatchObject({
      install: [],
      update: [],
      blocked: { install: ["lib@1.0.1"], update: ["leaf"] },
      peerOnly: ["react"],
    });
    expect(safeStep(report)?.legacyPeerDeps).toBeUndefined();
    const text = formatText(report);
    expect(text).not.toContain("--legacy-peer-deps --");
    expect(text).not.toMatch(/^\s*npm (install|update)/m);
    expect(text).toContain("--legacy-peer-deps would remove packages installed only as peers (react)");
    expect(text).toContain("# resolve the conflict by hand, then run: npm install -- lib@1.0.1");
    expect(text).toContain("#   npm update -- leaf");
  });

  it("adds --legacy-peer-deps to a separate (breaking) command as well, when the conflict is still there", async () => {
    brokenPeerLock({ "node_modules/tool": pub("tool", "1.0.0") }, { tool: "^1.0.0" });
    advisories.push({ id: "GHSA-tool", name: "tool", fixed: "2.0.0" });
    registry.tool = { versions: { "1.0.0": {}, "2.0.0": {} } };
    const report = await scan(dir, { cache: false });
    expect(report.commands?.find((c) => c.kind === "breaking")).toMatchObject({
      install: ["tool@2.0.0"],
      legacyPeerDeps: true,
      existingConflicts: ["inmemory@1.6.5 wants graphql@^14.0.0, installed 15.0.0"],
    });
    const text = formatText(report);
    expect(text).toContain("  npm install --legacy-peer-deps -- tool@2.0.0\n");
    expect(text).not.toMatch(/^\s*npm install -- tool@/m);
  });

  it("blocks a separate command too when --legacy-peer-deps would remove packages installed only as peers", async () => {
    brokenPeerLock(
      {
        "node_modules/react-dom": pub("react-dom", "18.2.0", { peerDependencies: { react: "^18.2.0" } }),
        "node_modules/react": pub("react", "18.3.1", { peer: true }),
        "node_modules/tool": pub("tool", "1.0.0"),
      },
      { "react-dom": "18.2.0", tool: "^1.0.0" },
    );
    advisories.push({ id: "GHSA-tool", name: "tool", fixed: "2.0.0" });
    registry.tool = { versions: { "1.0.0": {}, "2.0.0": {} } };
    const report = await scan(dir, { cache: false });
    expect(report.commands?.find((c) => c.kind === "breaking")).toMatchObject({
      install: [],
      update: [],
      blocked: { install: ["tool@2.0.0"], update: [] },
      peerOnly: ["react"],
    });
    const text = formatText(report);
    expect(text).not.toMatch(/^\s*npm (install|update)/m);
    expect(text).toContain("# resolve the conflict by hand, then run: npm install -- tool@2.0.0");
  });

  it("does not add --legacy-peer-deps to a separate command that resolves the conflict itself", async () => {
    brokenPeerLock();
    advisories.push({ id: "GHSA-inmemory", name: "inmemory", fixed: "2.0.0" });
    registry.inmemory = {
      versions: { "1.6.5": { peerDependencies: { graphql: "^14.0.0" } }, "2.0.0": { peerDependencies: { graphql: "^15.0.0" } } },
    };
    const report = await scan(dir, { cache: false });
    const step = report.commands?.find((c) => c.kind === "breaking");
    expect(step).toMatchObject({ install: ["inmemory@2.0.0"] });
    expect(step?.legacyPeerDeps).toBeUndefined();
    expect(step?.existingConflicts).toBeUndefined();
    expect(formatText(report)).toContain("  npm install -- inmemory@2.0.0\n");
  });

  // bitwarden: eslint-plugin-tailwindcss wants tailwindcss ^3.2.2, 3.1.6 is installed, but the root
  // package.json has `"overrides": {"tailwindcss": "$tailwindcss"}`. npm then checks every edge to
  // tailwindcss, the peer edge included, against the root's own range (^3.0.24), which 3.1.6
  // satisfies: npm install and npm update run without ERESOLVE (npm 11.16, checked on that lockfile).
  // direct=false: the root does not declare tailwindcss, app pulls it in.
  const overriddenPeerLock = (overrides: Record<string, unknown>, direct = true) => {
    const devDependencies = { "eslint-plugin-tailwindcss": "^3.8.3", ...(direct ? { tailwindcss: "^3.0.24" } : {}) };
    const dependencies = { app: "^1.0.0", lib: "^1.0.0", "react-dom": "18.2.0" };
    const appDeps = { leaf: "^1.0.0", ...(direct ? {} : { tailwindcss: "^3.0.0" }) };
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", dependencies, devDependencies, overrides }));
    writeLock({
      "": { name: "x", dependencies, devDependencies },
      "node_modules/app": pub("app", "1.0.0", { dependencies: appDeps }),
      "node_modules/leaf": pub("leaf", "1.0.0"),
      "node_modules/lib": pub("lib", "1.0.0"),
      "node_modules/eslint-plugin-tailwindcss": pub("eslint-plugin-tailwindcss", "3.8.3", { dev: true, peerDependencies: { tailwindcss: "^3.2.2" } }),
      "node_modules/tailwindcss": pub("tailwindcss", "3.1.6", direct ? { dev: true } : {}),
      // Installed only as a peer: --legacy-peer-deps would drop it, so a conflict blocks the step.
      "node_modules/react-dom": pub("react-dom", "18.2.0", { peerDependencies: { react: "^18.2.0" } }),
      "node_modules/react": pub("react", "18.3.1", { peer: true }),
    });
    advisories = [
      { id: "GHSA-leaf", name: "leaf", fixed: "1.0.1" },
      { id: "GHSA-lib", name: "lib", fixed: "1.0.1" },
    ];
    registry = {
      app: { versions: { "1.0.0": { dependencies: appDeps } } },
      leaf: { versions: { "1.0.0": {}, "1.0.1": {} } },
      lib: { versions: { "1.0.0": {}, "1.0.1": {} } },
    };
  };

  it("does not call a peer conflict existing when a root override ($ref) makes npm accept the installed version", async () => {
    overriddenPeerLock({ tailwindcss: "$tailwindcss" });
    const report = await scan(dir, { cache: false });
    const step = safeStep(report);
    expect(step).toMatchObject({ install: ["lib@1.0.1"], update: ["leaf"] });
    expect(step?.existingConflicts).toBeUndefined();
    expect(step?.blocked).toBeUndefined();
    expect(step?.legacyPeerDeps).toBeUndefined();
    const text = formatText(report);
    expect(text).toContain("  npm install -- lib@1.0.1\n  npm update -- leaf\n");
    expect(text).not.toContain("existing peer conflict");
  });

  it("does the same for a literal override the installed version satisfies, when the root does not declare the package", async () => {
    overriddenPeerLock({ tailwindcss: "~3.1.0" }, false);
    const report = await scan(dir, { cache: false });
    expect(safeStep(report)?.existingConflicts).toBeUndefined();
    expect(safeStep(report)?.blocked).toBeUndefined();
  });

  it("still reports the conflict when the override does not accept the installed version, or may not apply to the peer edge", async () => {
    for (const overrides of [
      { tailwindcss: "^3.2.2 <3.2.3" }, // the installed 3.1.6 is outside the override too
      { tailwindcss: "~3.1.0" }, // differs from the root's own ^3.0.24: npm stops with EOVERRIDE
      { "tailwindcss@^3": "$tailwindcss" }, // keyed: not modelled, so not trusted
      { "eslint-plugin-tailwindcss": { tailwindcss: "$tailwindcss" } }, // nested: not modelled
      { tailwindcss: "$nothing" }, // a reference npm cannot resolve
      { tailwindcss: "github:tailwindlabs/tailwindcss" }, // not a range
    ]) {
      overriddenPeerLock(overrides);
      const report = await scan(dir, { cache: false });
      expect(safeStep(report), JSON.stringify(overrides)).toMatchObject({
        existingConflicts: ["eslint-plugin-tailwindcss@3.8.3 wants tailwindcss@^3.2.2, installed 3.1.6"],
        blocked: { install: ["lib@1.0.1"], update: ["leaf"] },
      });
    }
  });

  // app 1.1.0 keeps mid's range, so the estimate assumes `npm update mid`; mid 1.1.0 needs graphql 14.
  // tool (when given) is a breaking upgrade that keeps mid's range as well; listed first, it is the
  // direct dependency leaf is counted under, and the in-range search is what holds mid back.
  const heldMidLock = (withTool = false) => {
    writeLock({
      "": { dependencies: { ...(withTool ? { tool: "^1.0.0" } : {}), app: "^1.0.0", graphql: "15.0.0" } },
      "node_modules/app": pub("app", "1.0.0", { dependencies: { mid: "^1.0.0" } }),
      "node_modules/mid": pub("mid", "1.0.0", { dependencies: { leaf: "1.0.0" } }),
      "node_modules/leaf": pub("leaf", "1.0.0"),
      "node_modules/graphql": pub("graphql", "15.0.0"),
      ...(withTool ? { "node_modules/tool": pub("tool", "1.0.0", { dependencies: { mid: "^1.0.0" } }) } : {}),
    });
    advisories = [
      { id: "GHSA-app", name: "app", fixed: "1.1.0" },
      { id: "GHSA-leaf", name: "leaf", fixed: "1.0.1" },
      ...(withTool ? [{ id: "GHSA-tool", name: "tool", fixed: "2.0.0" }] : []),
    ];
    registry = {
      app: { versions: { "1.0.0": { dependencies: { mid: "^1.0.0" } }, "1.1.0": { dependencies: { mid: "^1.0.0" } } } },
      mid: {
        versions: {
          "1.0.0": { dependencies: { leaf: "1.0.0" } },
          "1.1.0": { dependencies: { leaf: "1.0.1" }, peerDependencies: { graphql: "^14.0.0" } },
        },
      },
      leaf: { versions: { "1.0.0": {}, "1.0.1": {} } },
      ...(withTool ? { tool: { versions: { "1.0.0": { dependencies: { mid: "^1.0.0" } }, "2.0.0": { dependencies: { mid: "^1.0.0" } } } } } : {}),
    };
  };
  const midHeld = "mid: mid@1.1.0 needs graphql@^14.0.0 (installed 15.0.0)";

  it("does not tell to run npm update for a name it held back for a peer conflict", async () => {
    heldMidLock();
    const report = await scan(dir, { cache: false });
    expect(entry(report, "app")).toMatchObject({ target: "1.1.0", alsoUpdate: ["mid"] });
    expect(safeStep(report)).toMatchObject({ install: ["app@1.1.0"], update: [] });
    expect(safeStep(report)?.held).toEqual([midHeld]);
    const text = formatText(report);
    expect(text).not.toContain("also run npm update mid");
    expect(text).toContain("    not in npm update (likely peer conflict, see the commands below): mid\n");
    expect(text).toContain("# not in npm update (likely peer conflict): mid:");
  });

  it("does not count, or call covered, what only the held-back npm update would clear", async () => {
    heldMidLock();
    const report = await scan(dir, { cache: false });
    // Without `npm update mid`, leaf stays on 1.0.0: app 1.1.0 clears its own advisory only.
    expect(entry(report, "app")).toMatchObject({
      target: "1.1.0",
      clears: { count: 1, packages: ["app@1.0.0"] },
      remaining: [{ id: "GHSA-leaf", package: "leaf@1.0.0" }],
    });
    expect(safeStep(report)?.clears).toMatchObject({ count: 1, total: 2 });
    const text = formatText(report);
    expect(text).toMatch(/app 1\.0\.0 -> 1\.1\.0: clears 1 of 2 advisories/);
    expect(text).not.toMatch(/leaf@1\.0\.0 .*covered by/);
  });

  it("keeps a held-back name out of a separate command's npm update too, and says why there", async () => {
    heldMidLock(true);
    const report = await scan(dir, { cache: false });
    expect(entry(report, "tool")).toMatchObject({ target: "2.0.0", breaking: true, alsoUpdate: ["mid"] });
    const step = report.commands?.find((c) => c.kind === "breaking");
    expect(step).toMatchObject({ install: ["tool@2.0.0"], update: [], held: [midHeld] });
    const text = formatText(report);
    expect(text).not.toMatch(/^\s*npm update .*mid/m);
    const toolBlock = text.slice(text.indexOf("# tool:"));
    expect(toolBlock).toContain("# not in npm update (likely peer conflict): mid:");
  });

  it("does not offer a refresh that cannot clear anything", async () => {
    writeLock({
      "": { dependencies: { app: "^1.0.0" } },
      "node_modules/app": pub("app", "1.0.0", { dependencies: { leaf: "~1.0.0" } }),
      "node_modules/leaf": pub("leaf", "1.0.0"),
    });
    advisories = [{ id: "GHSA-leaf", name: "leaf", fixed: "1.1.0" }];
    registry = {
      app: { versions: { "1.0.0": { dependencies: { leaf: "~1.0.0" } } } },
      leaf: { versions: { "1.0.0": {}, "1.0.5": {}, "1.1.0": {} } },
    };
    const report = await scan(dir, { cache: false });
    expect(report.refresh).toBeUndefined();
    expect(report.commands).toBeUndefined();
  });
});

describe("every chain to a vulnerable copy", () => {
  // d -> engine (declares ws) -> ws, and d -> adapter (locked, still in range) -> the same ws.
  const lock = () =>
    writeLock({
      "": { dependencies: { d: "^4.7.0" } },
      "node_modules/d": pub("d", "4.7.2", { dependencies: { engine: "~6.5.0", adapter: "~2.5.2" } }),
      "node_modules/engine": pub("engine", "6.5.2", { dependencies: { ws: "~8.11.0" } }),
      "node_modules/adapter": pub("adapter", "2.5.2", { dependencies: { ws: "~8.11.0" } }),
      "node_modules/ws": pub("ws", "8.11.0"),
    });
  beforeEach(() => {
    lock();
    advisories = [{ id: "GHSA-ws", name: "ws", fixed: "8.17.1" }];
    registry = {
      d: {
        versions: {
          "4.7.2": { dependencies: { engine: "~6.5.0", adapter: "~2.5.2" } },
          "4.8.0": { dependencies: { engine: "~6.6.0", adapter: "~2.5.2" } },
        },
      },
      engine: { versions: { "6.5.2": { dependencies: { ws: "~8.11.0" } }, "6.6.0": { dependencies: { ws: "~8.17.1" } } } },
      ws: { versions: { "8.11.0": {}, "8.11.2": {}, "8.17.1": {} } },
    };
  });

  it("does not claim a copy that another locked parent still pins", async () => {
    registry.adapter = { versions: { "2.5.2": { dependencies: { ws: "~8.11.0" } }, "2.5.5": { dependencies: { ws: "~8.11.0" } } } };
    const report = await scan(dir, { cache: false });
    // The shortest chain (d > engine > ws) is fixed, but adapter keeps ws on ~8.11.0.
    expect(entry(report, "d")).toMatchObject({ status: "no-fix", total: 1 });
    expect(report.findings.find((f) => f.name === "ws")).toBeDefined();
    expect(formatText(report)).not.toContain("covered by upgrading d");
  });

  it("adds the other locked parent to npm update when its newer in-range release lets go", async () => {
    registry.adapter = { versions: { "2.5.2": { dependencies: { ws: "~8.11.0" } }, "2.5.5": { dependencies: { ws: "~8.17.1" } } } };
    const report = await scan(dir, { cache: false });
    expect(entry(report, "d")).toMatchObject({
      status: "upgrade",
      target: "4.8.0",
      clears: { count: 1, packages: ["ws@8.11.0"] },
      alsoUpdate: ["adapter"],
    });
    expect(safeStep(report)).toMatchObject({ install: ["d@4.8.0"], update: ["adapter"] });
    expect(formatText(report)).toContain("  npm install -- d@4.8.0\n  npm update -- adapter\n");
  });
});

describe("fixed-in versions and overrides", () => {
  it("never suggests a fix or override that carries an advisory of its own", async () => {
    writeLock({
      "": { dependencies: { app: "^1.0.0" } },
      "node_modules/app": pub("app", "1.0.0", { dependencies: { moment: "2.24.0" } }),
      "node_modules/moment": pub("moment", "2.24.0"),
    });
    advisories = [
      { id: "GHSA-old", name: "moment", fixed: "2.29.4" },
      // 2.29.4 fixes the one above but is itself affected by this one.
      { id: "GHSA-4p3w", name: "moment", introduced: "2.29.2", fixed: "2.31.0" },
    ];
    registry = { app: { versions: { "1.0.0": { dependencies: { moment: "2.24.0" } } } }, moment: { versions: {} } };
    const report = await scan(dir, { cache: false });
    expect(report.findings.find((f) => f.name === "moment")).toMatchObject({ fixVersion: "2.31.0", fixIsBreaking: false });
    expect(report.suggestedOverrides).toEqual({ moment: "2.31.0" });
    const text = formatText(report);
    expect(text).toContain("-> fixed in 2.31.0");
    expect(text).not.toContain("2.29.4");
  });

  it("omits the override and says why when every fixed version carries an advisory", async () => {
    writeLock({
      "": { dependencies: { app: "^1.0.0" } },
      "node_modules/app": pub("app", "1.0.0", { dependencies: { lib: "1.0.0" } }),
      "node_modules/lib": pub("lib", "1.0.0"),
    });
    advisories = [
      { id: "GHSA-a", name: "lib", fixed: "1.1.0" },
      { id: "GHSA-b", name: "lib", introduced: "1.1.0" }, // never fixed
    ];
    registry = { app: { versions: { "1.0.0": { dependencies: { lib: "1.0.0" } } } }, lib: { versions: {} } };
    const report = await scan(dir, { cache: false });
    expect(report.findings.find((f) => f.name === "lib")?.fixVersion).toBeUndefined();
    expect(report.suggestedOverrides).toEqual({});
    expect(report.overridesOmitted).toEqual([
      { name: "lib", reason: "every fixed version found carries a known advisory (GHSA-b in lib@1.1.0)" },
    ]);
    expect(formatText(report)).toContain("No override for lib: every fixed version found carries a known advisory");
  });

  it("holds only the copies below the parent a nested override names", async () => {
    // {"express": {"qs": ...}} pins the qs under express; the copy that `other` uses stays free.
    const deps = { express: "^4.0.0", other: "^1.0.0" };
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: deps, overrides: { express: { qs: "6.5.1" } } }));
    writeLock({
      "": { dependencies: deps },
      "node_modules/express": pub("express", "4.0.0", { dependencies: { qs: "~6.5.0" } }),
      "node_modules/express/node_modules/qs": pub("qs", "6.5.1"),
      "node_modules/other": pub("other", "1.0.0", { dependencies: { qs: "~6.5.1" } }),
      "node_modules/qs": pub("qs", "6.5.2"),
    });
    advisories = [{ id: "GHSA-qs", name: "qs", fixed: "6.5.3" }];
    registry = {
      express: { versions: { "4.0.0": { dependencies: { qs: "~6.5.0" } } } },
      other: { versions: { "1.0.0": { dependencies: { qs: "~6.5.1" } } } },
      qs: { versions: { "6.5.1": {}, "6.5.2": {}, "6.5.3": {} } },
    };
    const report = await scan(dir, { cache: false });
    expect(entry(report, "express").heldByOverride).toEqual(["qs"]);
    expect(entry(report, "other").heldByOverride).toBeUndefined();
    expect(report.refresh).toMatchObject({ update: ["qs"], covered: ["qs@6.5.2"] });
    expect(safeStep(report)?.update).toEqual(["qs"]);
    const text = formatText(report);
    expect(text).toContain("qs@6.5.2 (transitive) 1 advisory, worst high: covered by the in-range npm update");
    expect(text).not.toMatch(/qs@6\.5\.1 .*covered by/);
  });

  it("does not override bundled copies, and names the package that bundles them", async () => {
    writeLock({
      "": { dependencies: { nyc: "^7.0.0", other: "^1.0.0" } },
      "node_modules/nyc": pub("nyc", "7.1.0", { dependencies: { handlebars: "^4.0.0" }, bundleDependencies: ["handlebars"] }),
      "node_modules/nyc/node_modules/handlebars": { version: "4.0.5", inBundle: true },
      "node_modules/other": pub("other", "1.0.0", { dependencies: { lodash: "^4.0.0" } }),
      "node_modules/lodash": pub("lodash", "4.17.10"),
    });
    advisories = [
      { id: "GHSA-hb", name: "handlebars", fixed: "4.7.10", severity: "CRITICAL" },
      { id: "GHSA-lodash", name: "lodash", fixed: "4.17.21" },
    ];
    registry = {
      nyc: { versions: { "7.1.0": { dependencies: { handlebars: "^4.0.0" } } } },
      other: { versions: { "1.0.0": { dependencies: { lodash: "^4.0.0" } } } },
      lodash: { versions: { "4.17.10": {} } },
    };
    const report = await scan(dir, { cache: false, plan: false });
    expect(report.suggestedOverrides).toEqual({ lodash: "4.17.21" });
    expect(report.bundled).toEqual([{ package: "handlebars@4.0.5", bundledIn: ["nyc@7.1.0"], advisories: 1 }]);
    const text = formatText(report);
    expect(text).toContain("handlebars@4.0.5 (1 advisory): bundled in nyc@7.1.0: upgrade nyc");
    expect(text).not.toContain('"handlebars"');
  });

  it("shows one target per package: a direct dependency's line in Findings uses the plan's target", async () => {
    writeLock({ "": { dependencies: { purify: "^2.0.0" } }, "node_modules/purify": pub("purify", "2.0.0") });
    advisories = [
      { id: "GHSA-1", name: "purify", fixed: "2.5.9", severity: "HIGH" },
      { id: "GHSA-2", name: "purify", fixed: "3.4.16", severity: "LOW" },
    ];
    // Nothing on 2.x clears GHSA-2; 2.5.9 is the best non-breaking target.
    registry = { purify: { versions: { "2.0.0": {}, "2.5.9": {}, "3.4.16": {} } } };
    const report = await scan(dir, { cache: false });
    expect(entry(report, "purify")).toMatchObject({ target: "2.5.9", breakingAlternative: "3.4.16" });
    expect(report.findings[0]?.fixVersion).toBe("3.4.16");
    const text = formatText(report);
    const line = text.split("\n").find((l) => l.startsWith("purify@2.0.0"));
    expect(line).toContain("-> upgrade to 2.5.9 (see the plan)");
    expect(line).not.toContain("3.4.16");
  });
});

describe("plan targets and the request budget", () => {
  it("takes the newest clean, non-deprecated release on the new major, not its first", async () => {
    writeLock({ "": { devDependencies: { jest: "^27.0.0" } }, "node_modules/jest": pub("jest", "27.0.0", { dev: true }) });
    advisories = [
      { id: "GHSA-jest", name: "jest", fixed: "28.0.0" },
      { id: "GHSA-jest-28-1", name: "jest", introduced: "28.1.0", fixed: "28.1.1" },
    ];
    registry = {
      jest: {
        versions: {
          "27.0.0": {},
          "28.0.0": {},
          "28.0.3": {},
          "28.1.0": {}, // carries an advisory
          "28.2.0": { deprecated: "broken release" },
        },
      },
    };
    const report = await scan(dir, { cache: false });
    expect(entry(report, "jest")).toMatchObject({ target: "28.0.3", breaking: true, remaining: [] });
  });

  it("caches the planner's registry data together with the report's, so a second run makes no plan requests", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "patchpath-cache-"));
    try {
      writeLock({
        "": { dependencies: { app: "^1.0.0" } },
        "node_modules/app": pub("app", "1.0.0", { dependencies: { leaf: "^1.0.0" } }),
        "node_modules/leaf": pub("leaf", "1.0.0"),
      });
      advisories = [{ id: "GHSA-leaf", name: "leaf", fixed: "1.0.1" }];
      registry = {
        app: { versions: { "1.0.0": { dependencies: { leaf: "^1.0.0" } } } },
        leaf: { versions: { "1.0.0": {}, "1.0.1": {} } },
      };
      const first = await scan(dir, { cacheDir, plan: false });
      expect(first.plan).toEqual([]);
      requests = [];
      const second = await scan(dir, { cacheDir });
      expect(second.refresh?.update).toEqual(["leaf"]);
      expect(requests.filter((r) => r.includes("registry.npmjs.org"))).toEqual([]);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("spends the request budget on production dependencies first", async () => {
    const packages: Record<string, unknown> = { "": { dependencies: {}, devDependencies: {} } };
    const root = packages[""] as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    // Dev packages sort first by name, production ones last: the budget must not follow the name.
    for (let i = 0; i < MAX_PLAN_REQUESTS; i++) {
      const name = `a-dev${i}`;
      root.devDependencies[name] = "^1.0.0";
      packages[`node_modules/${name}`] = pub(name, "1.0.0", { dev: true });
      advisories.push({ id: `GHSA-${name}`, name, fixed: "1.0.1", severity: "CRITICAL" });
      broken.add(name);
    }
    for (let i = 0; i < 5; i++) {
      const name = `z-prod${i}`;
      root.dependencies[name] = "^1.0.0";
      packages[`node_modules/${name}`] = pub(name, "1.0.0");
      advisories.push({ id: `GHSA-${name}`, name, fixed: "1.0.1", severity: "LOW" });
      broken.add(name);
    }
    writeLock(packages);
    const report = await scan(dir, { cache: false });
    const capped = report.plan.filter((e) => e.reason?.includes("request limit reached"));
    expect(capped).toHaveLength(5);
    expect(capped.every((e) => e.dev)).toBe(true);
    expect(report.plan.filter((e) => e.name.startsWith("z-prod")).every((e) => !e.reason?.includes("request limit"))).toBe(true);
  });
});
