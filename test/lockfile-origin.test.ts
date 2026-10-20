import { describe, expect, it } from "vitest";
import { exactPinnedDependencies, parseNpmLockfile } from "../src/core/lockfile/npm.js";

const v3 = (packages: Record<string, unknown>) => JSON.stringify({ lockfileVersion: 3, packages });
const v1 = (dependencies: Record<string, unknown>) => JSON.stringify({ lockfileVersion: 1, dependencies });
const byName = (text: string, pkgJson?: string) => new Map(parseNpmLockfile(text, pkgJson).map((d) => [d.name, d]));

const REG = "https://registry.npmjs.org/";

describe("public registry URLs", () => {
  it.each([
    "https://registry.npmjs.org/a/-/a-1.0.0.tgz",
    "http://registry.npmjs.org/a/-/a-1.0.0.tgz",
    "http://registry.yarnpkg.com/a/-/a-1.0.0.tgz",
  ])("recognises %s", (resolved) => {
    const deps = byName(v3({ "": { dependencies: { a: "1" } }, "node_modules/a": { version: "1.0.0", resolved } }));
    expect(deps.get("a")?.external).toBe(false);
  });

  it.each([
    "http://registry.npmjs.org.evil.com/a/-/a-1.0.0.tgz",
    "https://registry.npmjs.org.evil.com/a/-/a-1.0.0.tgz",
    "http://registry.npmjs.org@evil.com/a/-/a-1.0.0.tgz",
    "https://registry.npmjs.org:evil@evil.com/a/-/a-1.0.0.tgz",
    "http://registry.npmjs.orgx/a/-/a-1.0.0.tgz",
    "ftp://registry.npmjs.org/a/-/a-1.0.0.tgz",
    "git+http://registry.npmjs.org/a.git",
  ])("rejects look-alike %s", (resolved) => {
    const deps = byName(v3({ "": { dependencies: { a: "1" } }, "node_modules/a": { version: "1.0.0", resolved } }));
    expect(deps.get("a")?.external).toBe(true);
  });
});

describe('v1 "resolved": false children (npm 6 fsevents bundles)', () => {
  const fsevents = (children: Record<string, unknown>, resolved = `${REG}fsevents/-/fsevents-1.2.9.tgz`) => ({
    fsevents: { version: "1.2.9", resolved, optional: true, dependencies: children },
  });

  it("checks optional children of a registry-resolved parent", () => {
    const deps = byName(v1(fsevents({ abbrev: { version: "1.1.1", resolved: false, optional: true, dev: true } })));
    expect(deps.get("abbrev")).toMatchObject({ external: false });
    expect(deps.get("abbrev")?.unresolved).toBeUndefined();
  });

  it("follows nesting: grandchildren inherit through the chain", () => {
    const deps = byName(
      v1(
        fsevents({
          rc: {
            version: "1.2.8",
            resolved: false,
            optional: true,
            dependencies: { minimist: { version: "1.2.0", resolved: false, optional: true } },
          },
        }),
      ),
    );
    expect(deps.get("minimist")?.external).toBe(false);
  });

  it("checks bundled children as well", () => {
    const deps = byName(v1(fsevents({ tar: { version: "4.4.8", resolved: false, bundled: true } })));
    expect(deps.get("tar")?.external).toBe(false);
  });

  it("does not trust children of a private parent", () => {
    const deps = byName(
      v1(
        fsevents(
          { abbrev: { version: "1.1.1", resolved: false, optional: true } },
          "https://npm.corp.example/fsevents-1.2.9.tgz",
        ),
      ),
    );
    expect(deps.get("abbrev")).toMatchObject({ external: true, unresolved: true });
  });

  it("does not trust children of a parent without a resolved URL", () => {
    const deps = byName(v1(fsevents({ abbrev: { version: "1.1.1", resolved: false, optional: true } }, "")));
    expect(deps.get("abbrev")?.external).toBe(true);
  });

  it("does not trust top-level entries or entries that are neither optional nor bundled", () => {
    const deps = byName(
      v1({
        top: { version: "1.0.0", resolved: false, optional: true },
        ...fsevents({ plain: { version: "1.0.0", resolved: false }, missing: { version: "1.0.0", optional: true } }),
      }),
    );
    expect(deps.get("top")?.external).toBe(true);
    expect(deps.get("plain")?.external).toBe(true);
    expect(deps.get("missing")?.external).toBe(true);
  });

  it("still lets --assume-public decide for the rest", () => {
    const text = v1(fsevents({ plain: { version: "1.0.0", resolved: false } }));
    const deps = new Map(parseNpmLockfile(text, undefined, { assumePublic: true }).map((d) => [d.name, d]));
    expect(deps.get("plain")?.external).toBe(false);
  });
});

describe("packages bundled by the project itself", () => {
  const secret = "zz-acme-secret-lib-xyz";

  it("judges a root-bundled entry by its own resolved URL (v3)", () => {
    const deps = byName(
      v3({
        "": { dependencies: { [secret]: "^1.0.0", ms: "^2.0.0" }, bundleDependencies: [secret, "ms"] },
        [`node_modules/${secret}`]: { version: "1.0.0", resolved: `https://npm.acme.internal/${secret}/-/${secret}-1.0.0.tgz`, inBundle: true },
        "node_modules/ms": { version: "2.1.3", resolved: `${REG}ms/-/ms-2.1.3.tgz`, inBundle: true },
      }),
    );
    expect(deps.get(secret)).toMatchObject({ external: true });
    expect(deps.get("ms")).toMatchObject({ external: false });
  });

  it("does the same for a workspace that bundles, and for a root-bundled entry without a URL", () => {
    const deps = byName(
      v3({
        "": { workspaces: ["packages/a"], dependencies: { nourl: "^1.0.0" }, bundleDependencies: ["nourl"] },
        "packages/a": { dependencies: { [secret]: "^1.0.0" }, bundleDependencies: [secret] },
        [`packages/a/node_modules/${secret}`]: { version: "1.0.0", resolved: `https://npm.acme.internal/${secret}-1.0.0.tgz`, inBundle: true },
        "node_modules/nourl": { version: "1.0.0", inBundle: true },
      }),
    );
    expect(deps.get(secret)).toMatchObject({ external: true });
    expect(deps.get("nourl")).toMatchObject({ external: true, unresolved: true });
  });

  it("judges a top-level bundled v1 entry by its own resolved URL", () => {
    const deps = byName(
      v1({
        [secret]: { version: "1.0.0", resolved: `https://npm.acme.internal/${secret}-1.0.0.tgz`, bundled: true },
        nourl: { version: "1.0.0", bundled: true },
        ms: { version: "2.1.3", resolved: `${REG}ms/-/ms-2.1.3.tgz`, bundled: true },
      }),
    );
    expect(deps.get(secret)?.external).toBe(true);
    expect(deps.get("nourl")?.external).toBe(true);
    expect(deps.get("ms")?.external).toBe(false);
  });
});

describe("--no-dev on v1: extraneous entries", () => {
  const pkgJson = JSON.stringify({ dependencies: { app: "^1", opt: "^1" }, devDependencies: { tool: "^1" } });
  const node = (extra: Record<string, unknown> = {}) => ({ version: "1.0.0", resolved: `${REG}x/-/x-1.0.0.tgz`, ...extra });

  const lockfile = v1({
    app: node({
      requires: { shared: "^1", inner: "^1" },
      dependencies: {
        // nothing requires this: app dropped it, the lockfile kept the tree
        mocha: node({ requires: { "js-yaml": "^4" }, dependencies: { "js-yaml": node() } }),
        inner: node({ requires: { "deep-nested": "^1" } }),
      },
    }),
    "deep-nested": node(),
    shared: node(),
    opt: node({ optional: true }),
    tool: node({ dev: true, requires: { "tool-dep": "^1" } }),
    "tool-dep": node({ dev: true }),
    orphan: node(),
  });

  it("marks entries that nothing reachable from the production dependencies requires as dev", () => {
    const deps = byName(lockfile, pkgJson);
    expect(deps.get("mocha")?.dev).toBe(true);
    expect(deps.get("js-yaml")?.dev).toBe(true);
    expect(deps.get("orphan")?.dev).toBe(true);
  });

  it("keeps everything that production code reaches, with Node's lookup order", () => {
    const deps = byName(lockfile, pkgJson);
    for (const name of ["app", "inner", "deep-nested", "shared", "opt"]) expect(deps.get(name)?.dev).toBe(false);
    expect(deps.get("tool")?.dev).toBe(true);
    expect(deps.get("tool-dep")?.dev).toBe(true);
  });

  it("changes nothing without package.json or without requires data", () => {
    expect(byName(lockfile).get("mocha")?.dev).toBe(false);
    const noRequires = v1({ app: node(), other: node() });
    expect(byName(noRequires, pkgJson).get("other")?.dev).toBe(false);
  });

  it("lets production win when a package is required by both production and dev code", () => {
    const text = v1({
      app: node({ requires: { shared: "^1" } }),
      tool: node({ dev: true, requires: { shared: "^1" } }),
      shared: node(),
    });
    const json = JSON.stringify({ dependencies: { app: "1" }, devDependencies: { tool: "1" } });
    expect(byName(text, json).get("shared")?.dev).toBe(false);
  });
});

describe("exactPinnedDependencies", () => {
  const pins = (json: unknown) => [...exactPinnedDependencies(JSON.stringify(json))].sort();

  it("finds exact versions in every section and ignores ranges, tags, aliases and urls", () => {
    expect(
      pins({
        dependencies: { pyodide: "0.27.2", a: "^1.0.0", b: "~1.0.0", c: "latest", d: "1.x", e: ">=1.0.0", f: "npm:x@1.0.0", g: "github:u/r#1.0.0", h: "file:../h", i: "*" },
        devDependencies: { beta: "2.0.0-beta.1", eq: "=3.1.0", v: "v1.2.3" },
        optionalDependencies: { opt: "1.0.0" },
      }),
    ).toEqual(["beta", "eq", "opt", "pyodide", "v"]);
  });

  it("needs every spec of a name to be exact", () => {
    expect(pins({ dependencies: { a: "1.0.0" }, devDependencies: { a: "^1.0.0" } })).toEqual([]);
  });

  it("is empty without a usable package.json", () => {
    expect(exactPinnedDependencies(undefined).size).toBe(0);
    expect(exactPinnedDependencies("not json").size).toBe(0);
  });
});
