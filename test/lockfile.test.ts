import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseNpmLockfile } from "../src/core/lockfile/npm.js";
import { UserError } from "../src/core/util.js";

const v3 = readFileSync(new URL("./fixtures/lock-v3.json", import.meta.url), "utf8");

const lock = (packages: Record<string, unknown>) => JSON.stringify({ lockfileVersion: 3, packages });
const byId = (text: string) => new Map(parseNpmLockfile(text).map((d) => [`${d.name}@${d.version}`, d]));

describe("parseNpmLockfile", () => {
  it("parses v3 packages, including scoped and nested ones", () => {
    const ids = parseNpmLockfile(v3).map((d) => `${d.name}@${d.version}`);
    expect(ids).toEqual(["@scope/pkg@1.2.0", "leftpad@0.0.1", "lodash@4.17.15", "lodash@4.17.21", "vitest@1.0.0"]);
  });

  it("skips the root, workspace folders and links", () => {
    const names = parseNpmLockfile(v3).map((d) => d.name);
    expect(names).not.toContain("local");
    expect(names).not.toContain("demo");
  });

  it("separates direct from transitive and dev from prod", () => {
    const deps = byId(v3);
    expect(deps.get("lodash@4.17.15")).toMatchObject({ direct: true, dev: false });
    expect(deps.get("lodash@4.17.21")).toMatchObject({ direct: false, dev: true });
    expect(deps.get("leftpad@0.0.1")).toMatchObject({ direct: false, dev: false });
    expect(deps.get("vitest@1.0.0")).toMatchObject({ direct: true, dev: true });
  });

  it("uses the real package name for npm aliases (v3)", () => {
    const deps = byId(
      lock({
        "": { dependencies: { "my-alias": "npm:lodash@4.17.15" } },
        "node_modules/my-alias": { name: "lodash", version: "4.17.15" },
      }),
    );
    expect([...deps.keys()]).toEqual(["lodash@4.17.15"]);
    expect(deps.get("lodash@4.17.15")?.direct).toBe(true);
  });

  it("resolves npm aliases in v1 lockfiles", () => {
    const v1 = JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        "my-alias": { version: "npm:lodash@4.17.15" },
        "scoped-alias": { version: "npm:@scope/thing@2.0.0" },
      },
    });
    expect(parseNpmLockfile(v1).map((d) => `${d.name}@${d.version}`)).toEqual(["@scope/thing@2.0.0", "lodash@4.17.15"]);
  });

  it("parses v1 lockfiles using package.json for direct dependencies", () => {
    const v1 = JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        a: {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz",
          dependencies: { b: { version: "2.0.0", resolved: "https://registry.npmjs.org/b/-/b-2.0.0.tgz" } },
        },
      },
    });
    const deps = parseNpmLockfile(v1, JSON.stringify({ dependencies: { a: "^1.0.0" } }));
    expect(deps).toEqual([
      { name: "a", version: "1.0.0", direct: true, dev: false, external: false },
      { name: "b", version: "2.0.0", direct: false, dev: false, external: false },
    ]);
  });

  it("treats workspace dependencies as direct", () => {
    const deps = byId(
      lock({
        "": { workspaces: ["packages/*"] },
        "packages/a": { version: "1.0.0", dependencies: { wsdep: "^1.0.0" } },
        "node_modules/wsdep": { version: "1.4.0" },
        "node_modules/hoisted": { version: "2.0.0" },
      }),
    );
    expect(deps.get("wsdep@1.4.0")?.direct).toBe(true);
    expect(deps.get("hoisted@2.0.0")?.direct).toBe(false);
  });

  it("flags packages that do not come from the public registry", () => {
    const deps = byId(
      lock({
        "": { dependencies: { "@corp/secret": "^1.0.0", gitdep: "github:x/y", lodash: "^4.0.0" } },
        "node_modules/@corp/secret": { version: "1.0.0", resolved: "https://npm.corp.example/@corp/secret/-/secret-1.0.0.tgz" },
        "node_modules/gitdep": { version: "1.0.0", resolved: "git+ssh://git@github.com/x/y.git#abc" },
        "node_modules/lodash": { version: "4.17.21", resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz" },
      }),
    );
    expect(deps.get("@corp/secret@1.0.0")?.external).toBe(true);
    expect(deps.get("gitdep@1.0.0")?.external).toBe(true);
    expect(deps.get("lodash@4.17.21")?.external).toBe(false);
  });

  it("records the chain from the direct dependency", () => {
    const deps = byId(
      lock({
        "": { dependencies: { express: "^4.0.0" } },
        "node_modules/express": { version: "4.17.1", dependencies: { "body-parser": "1.19.0" } },
        "node_modules/body-parser": { version: "1.19.0", dependencies: { qs: "6.7.0" } },
        "node_modules/qs": { version: "6.7.0" },
      }),
    );
    expect(deps.get("qs@6.7.0")?.via).toEqual(["express@4.17.1", "body-parser@1.19.0"]);
    expect(deps.get("body-parser@1.19.0")?.via).toEqual(["express@4.17.1"]);
    expect(deps.get("express@4.17.1")?.via).toBeUndefined();
  });

  it("resolves nested copies the way node does", () => {
    const deps = byId(
      lock({
        "": { dependencies: { a: "^1.0.0" } },
        "node_modules/a": { version: "1.0.0", dependencies: { qs: "^6.5.0" } },
        "node_modules/a/node_modules/qs": { version: "6.5.5" },
        "node_modules/qs": { version: "6.7.0" },
      }),
    );
    expect(deps.get("qs@6.5.5")?.via).toEqual(["a@1.0.0"]);
    // the top-level qs is not reachable from anything declared, so it has no chain
    expect(deps.get("qs@6.7.0")?.via).toBeUndefined();
  });

  it("treats devOptional entries as production: npm install --omit=dev still installs them", () => {
    const deps = byId(
      lock({
        "": {},
        "node_modules/x": { version: "1.0.0", devOptional: true },
        "node_modules/y": { version: "1.0.0", dev: true, optional: true },
      }),
    );
    expect(deps.get("x@1.0.0")?.dev).toBe(false);
    // an optional dependency of a dev dependency is still dev
    expect(deps.get("y@1.0.0")?.dev).toBe(true);
  });

  it("cleans every lockfile string at ingestion, including the via chain", () => {
    const hostile = "evil\u001b]0;PWNED\u0007‮\u{E0041}";
    const deps = parseNpmLockfile(
      lock({
        "": { dependencies: { [hostile]: "^1.0.0" } },
        [`node_modules/${hostile}`]: { version: "1.0.0\u001b[31m", dependencies: { victim: "^1.0.0" } },
        "node_modules/victim": { version: "1.0.0" },
      }),
    );
    const victim = deps.find((d) => d.name === "victim");
    expect(victim?.via).toHaveLength(1);
    const unsafe = /[\u0000-\u001f\u007f-\u009f‮\u{E0000}-\u{E007F}]/u;
    for (const d of deps) {
      for (const text of [d.name, d.version, ...(d.via ?? [])]) expect(text).not.toMatch(unsafe);
    }
  });

  it("does not trust entries without a resolved URL unless asked to", () => {
    const text = lock({
      "": { dependencies: { a: "^1.0.0", b: "^1.0.0" } },
      "node_modules/a": { version: "1.0.0" },
      "node_modules/b": { version: "1.0.0", resolved: "https://mirror.example/npm/b/-/b-1.0.0.tgz" },
    });
    const plain = new Map(parseNpmLockfile(text).map((d) => [d.name, d]));
    expect(plain.get("a")).toMatchObject({ external: true, unresolved: true });
    expect(plain.get("b")).toMatchObject({ external: true });
    expect(plain.get("b")?.unresolved).toBeUndefined();

    const opted = new Map(
      parseNpmLockfile(text, undefined, { assumePublic: true, registries: ["https://mirror.example/npm"] }).map((d) => [d.name, d]),
    );
    expect(opted.get("a")?.external).toBe(false);
    expect(opted.get("b")?.external).toBe(false);
  });

  it("checks v1 bundled dependencies like their bundler", () => {
    const v1 = JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        pub: {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/pub/-/pub-1.0.0.tgz",
          dependencies: { inner: { version: "2.0.0", bundled: true } },
        },
        priv: {
          version: "1.0.0",
          resolved: "https://npm.corp.example/priv-1.0.0.tgz",
          dependencies: { secret: { version: "2.0.0", bundled: true } },
        },
        loose: { version: "1.0.0" },
      },
    });
    const deps = new Map(parseNpmLockfile(v1).map((d) => [d.name, d]));
    expect(deps.get("inner")?.external).toBe(false);
    expect(deps.get("secret")?.external).toBe(true);
    expect(deps.get("loose")?.external).toBe(true);
  });

  it("accepts a byte-order mark", () => {
    expect(parseNpmLockfile(`﻿${v3}`)).toHaveLength(5);
  });

  it("rejects invalid input with a UserError", () => {
    expect(() => parseNpmLockfile("not json")).toThrow(UserError);
    expect(() => parseNpmLockfile("{}")).toThrow(UserError);
  });
});
