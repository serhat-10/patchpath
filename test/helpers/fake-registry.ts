import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { compareVersions } from "../../src/core/semver.js";

// Fake OSV and registry for scan() tests, as in plan.test.ts: advisories affect [introduced, fixed).
// Registry URLs are read the way a server sees them: the fragment is never sent.

export interface Advisory {
  id: string;
  name: string;
  introduced?: string;
  fixed?: string;
  severity?: string;
}
export interface Version {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  deprecated?: string;
}
export interface Doc {
  latest?: string;
  /** Sent as the packument's `name` when set. */
  name?: string;
  versions: Record<string, Version>;
}

export const net = {
  registry: {} as Record<string, Doc>,
  advisories: [] as Advisory[],
  requests: [] as string[],
  /** Registry paths exactly as requested (still percent-encoded). */
  registryPaths: [] as string[],
  dir: "",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const affects = (a: Advisory, name: string, version: string) =>
  a.name === name &&
  (!a.introduced || compareVersions(version, a.introduced) >= 0) &&
  (!a.fixed || compareVersions(version, a.fixed) < 0);

function fakeNetwork(url: string, init?: RequestInit): Response {
  net.requests.push(`${url} ${init?.body ?? ""}`);
  if (url.endsWith("/v1/querybatch")) {
    const { queries } = JSON.parse(String(init?.body)) as { queries: { package: { name: string }; version: string }[] };
    return json({
      results: queries.map((q) => {
        const ids = net.advisories.filter((a) => affects(a, q.package.name, q.version)).map((a) => ({ id: a.id }));
        return ids.length ? { vulns: ids } : {};
      }),
    });
  }
  const detail = /\/v1\/vulns\/(.+)$/.exec(url);
  if (detail) {
    const a = net.advisories.find((x) => x.id === decodeURIComponent(detail[1] as string));
    if (!a) return json({}, 404);
    const events = [{ introduced: a.introduced ?? "0" }, ...(a.fixed ? [{ fixed: a.fixed }] : [])];
    return json({
      id: a.id,
      summary: `test advisory for ${a.name}`,
      database_specific: { severity: a.severity ?? "HIGH" },
      affected: [{ package: { ecosystem: "npm", name: a.name }, ranges: [{ type: "SEMVER", events }] }],
    });
  }
  const parsed = new URL(url);
  if (parsed.host === "registry.npmjs.org") {
    net.registryPaths.push(parsed.pathname);
    const name = decodeURIComponent(parsed.pathname.slice(1));
    const doc = net.registry[name];
    if (!doc) return json({}, 404);
    return json({
      ...(doc.name ? { name: doc.name } : {}),
      "dist-tags": doc.latest ? { latest: doc.latest } : {},
      versions: doc.versions,
    });
  }
  return json({ error: `unexpected request ${url}` }, 500);
}

export const pub = (name: string, version: string, extra: Record<string, unknown> = {}) => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`,
  ...extra,
});

export const writeLock = (packages: Record<string, unknown>, lockfileVersion = 3) =>
  writeFileSync(join(net.dir, "package-lock.json"), JSON.stringify({ lockfileVersion, packages }));

export const writePackageJson = (pkg: Record<string, unknown>) => writeFileSync(join(net.dir, "package.json"), JSON.stringify(pkg));

/** Registers beforeEach/afterEach hooks that give each test a fresh project folder and fake network. */
export function useFakeNetwork(): void {
  beforeEach(() => {
    net.dir = mkdtempSync(join(tmpdir(), "patchpath-fake-"));
    net.registry = {};
    net.advisories = [];
    net.requests = [];
    net.registryPaths = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => fakeNetwork(String(input), init)));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(net.dir, { recursive: true, force: true });
  });
}
