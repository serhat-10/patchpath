import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cache } from "../src/core/cache.js";
import { formatText } from "../src/core/format.js";
import { parseNpmLockfile } from "../src/core/lockfile/npm.js";
import { scan } from "../src/core/scan.js";
import { fetchPackageDeps, fetchPackageInfo } from "../src/core/sources/npm-registry.js";
import type { Report } from "../src/core/types.js";
import { isValidNpmName } from "../src/core/util.js";
import { net, pub, useFakeNetwork, writeLock } from "./helpers/fake-registry.js";

/** Every argument a pasted command line would get, from the JSON report. */
const commandArgs = (report: Report) => (report.commands ?? []).flatMap((c) => [...c.install, ...c.update]);
/** The lines of the text report that are meant to be pasted into a shell. */
const pasted = (text: string) => text.split("\n").filter((l) => /^\s*npm /.test(l));

const SAFE_ARG = /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*(?:@npm:(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*)?(?:@[0-9A-Za-z.+-]+)?$/;

describe("isValidNpmName", () => {
  it.each(["express", "qs", "@types/node", "JSONStream", "lodash.merge", "socket.io-client", "a~b", "@scope/a_b"])("accepts %s", (name) => {
    expect(isValidNpmName(name)).toBe(true);
  });
  it.each([
    "",
    "express#$(touch PWNED)",
    "--registry=https://evil.example/x/../../../../express",
    "-x",
    ".hidden",
    "_private",
    "~home",
    "a b",
    "a;b",
    "a`b`",
    "a$b",
    "a'b",
    "a(b)",
    "a!b",
    "a*b",
    "@scope/",
    "@/x",
    "@scope/x/y",
    "x/y",
    "node_modules",
    "favicon.ico",
    "a".repeat(215),
  ])("rejects %j", (name) => {
    expect(isValidNpmName(name)).toBe(false);
  });
});

describe("package names npm would not accept", () => {
  useFakeNetwork();

  const hostileLock = (key: string) => {
    writeLock({
      "": { dependencies: { [key]: "^4.16.0" } },
      [`node_modules/${key}`]: pub("express", "4.16.0", { dependencies: { qs: "~6.5.1" } }),
      "node_modules/qs": pub("qs", "6.5.1"),
    });
    net.advisories = [{ id: "GHSA-qs", name: "qs", fixed: "6.5.3" }];
    net.registry = {
      express: { versions: { "4.16.0": { dependencies: { qs: "~6.5.1" } }, "4.17.0": { dependencies: { qs: "~6.5.3" } } } },
      qs: { versions: { "6.5.1": {}, "6.5.3": {} } },
    };
  };

  it.each(["express#$(touch PWNED)", "--registry=https://evil.example/x/../../../../express"])(
    "never puts %j into a command, a request or an override, and fails closed",
    async (key) => {
      hostileLock(key);
      const report = await scan(net.dir, { cache: false });
      for (const arg of commandArgs(report)) expect(arg).toMatch(SAFE_ARG);
      expect(JSON.stringify(report.commands ?? [])).not.toMatch(/PWNED|evil|registry=/);
      for (const name of Object.keys(report.suggestedOverrides)) expect(isValidNpmName(name)).toBe(true);
      for (const line of pasted(formatText(report))) expect(line).not.toMatch(/PWNED|evil|\$\(|--registry/);
      // Nothing about it was sent anywhere, and not to the real express document either.
      expect(net.requests.join("\n")).not.toMatch(/PWNED|evil|touch/);
      expect(net.registryPaths).not.toContain("/express");
      // Counted as unchecked (exit 3 with --fail-on) and explained.
      expect(report.summary.external).toBe(1);
      expect(report.warnings.some((w) => w.includes("name npm does not accept"))).toBe(true);
      // The real, valid child is still checked.
      expect(report.findings.map((f) => f.name)).toEqual(["qs"]);
    },
  );

  it("keeps an invalid name unchecked even with --assume-public and --registry", () => {
    const text = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { "a b": "1" } },
        "node_modules/a b": { version: "1.0.0" },
      },
    });
    const [dep] = parseNpmLockfile(text, undefined, { assumePublic: true });
    expect(dep).toMatchObject({ external: true });
  });

  it("checks the alias key as well as the real name", () => {
    const text = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { "x;rm": "npm:ms@2.1.3" } },
        "node_modules/x;rm": { name: "ms", version: "2.1.3", resolved: "https://registry.npmjs.org/ms/-/ms-2.1.3.tgz" },
      },
    });
    expect(parseNpmLockfile(text)[0]).toMatchObject({ name: "ms", external: true });
  });
});

describe("a private package the project bundles itself", () => {
  useFakeNetwork();

  it("is not checked, not sent anywhere and named in the warning", async () => {
    const secret = "zz-acme-secret-lib-xyz";
    writeLock({
      "": { dependencies: { [secret]: "^1.0.0" }, bundleDependencies: [secret] },
      [`node_modules/${secret}`]: { version: "1.0.0", resolved: `https://npm.acme.internal/${secret}/-/${secret}-1.0.0.tgz`, inBundle: true },
    });
    const report = await scan(net.dir, { cache: false });
    expect(net.requests.join("\n")).not.toContain("acme");
    expect(report.summary.external).toBe(1);
    expect(report.warnings.some((w) => w.includes(`${secret}@1.0.0`) && w.includes("not checked"))).toBe(true);
  });
});

describe("suggested overrides", () => {
  useFakeNetwork();

  it("never overrides a name the project declares itself, even when its spec is git (npm EOVERRIDE)", async () => {
    // mailspring: "debug": "github:emorikawa/debug#nylas", and slate pulls in debug 3.2.6 from the registry.
    writeFileSync(
      join(net.dir, "package.json"),
      JSON.stringify({ dependencies: { debug: "github:emorikawa/debug#nylas", slate: "^0.44.0" }, devDependencies: { tool: "file:../tool" } }),
    );
    const reg = (name: string, version: string, extra: Record<string, unknown> = {}) => ({
      version,
      resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
      ...extra,
    });
    writeFileSync(
      join(net.dir, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 1,
        dependencies: {
          debug: { version: "github:emorikawa/debug#29685485665b44c42d33ebd7ed62570b21c6e4bd", from: "github:emorikawa/debug#nylas" },
          tool: { version: "file:../tool", dev: true, requires: { ms: "^2.0.0" } },
          ms: reg("ms", "2.0.0"),
          slate: reg("slate", "0.44.0", { requires: { debug: "^3.1.0" }, dependencies: { debug: reg("debug", "3.2.6") } }),
        },
      }),
    );
    net.advisories = [
      { id: "GHSA-debug", name: "debug", fixed: "3.2.7", severity: "LOW" },
      { id: "GHSA-ms", name: "ms", fixed: "2.0.1", severity: "LOW" },
    ];
    const report = await scan(net.dir, { cache: false, plan: false });
    expect(report.findings.map((f) => f.name).sort()).toEqual(["debug", "ms"]);
    expect(report.suggestedOverrides).toEqual({ ms: "2.0.1" });
  });
});

describe("registry requests", () => {
  useFakeNetwork();

  it("percent-encodes the name in the URL", async () => {
    net.registry = { "@scope/pkg": { versions: { "1.0.0": {} } } };
    await fetchPackageInfo("@scope/pkg", new Cache(null));
    expect(net.registryPaths).toEqual(["/@scope%2fpkg"]);
  });

  it("rejects a document that names another package", async () => {
    net.registry = { victim: { name: "attacker", latest: "9.9.9", versions: { "9.9.9": {} } } };
    await expect(fetchPackageInfo("victim", new Cache(null))).rejects.toThrow(/different package/);
    await expect(fetchPackageDeps("victim", new Cache(null))).rejects.toThrow(/different package/);
  });
});
