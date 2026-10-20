import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exceedsThreshold, formatText } from "../src/core/format.js";
import { parsePnpmLockfile } from "../src/core/lockfile/pnpm.js";
import { scan } from "../src/core/scan.js";
import type { Dependency } from "../src/core/types.js";
import { UserError } from "../src/core/util.js";
import { net, useFakeNetwork } from "./helpers/fake-registry.js";

const fixture = new URL("./fixtures/pnpm-9/pnpm-lock.yaml", import.meta.url);
const lockText = readFileSync(fixture, "utf8");
const byId = (deps: Dependency[]) => new Map(deps.map((d) => [`${d.name}@${d.version}`, d]));

const UNKNOWN = [
  "corp-secret-registry@1.0.0",
  "debug@2.6.9",
  "express-lite@1.2.0",
  "fsevents-lite@2.3.2",
  "js-tokens@4.0.0",
  "lodash@4.17.15",
  "loose-envify@1.4.0",
  "ms@2.0.0",
  "ms@2.1.2",
  "react-dom@18.2.0",
  "react@18.2.0",
  "react@18.3.1",
  "scheduler@0.23.0",
  "string-width@4.2.3",
  "test-runner@3.4.0",
];
const EXTERNAL = [
  "@corp-secret/private@2.1.0",
  "corp-secret-gh@3.0.0",
  "corp-secret-git@1.0.0",
  "corp-secret-local@0.1.0",
  "corp-secret-mismatch@4.17.21",
  "minimist@1.2.0",
];

describe("pnpm v9 lockfile reader", () => {
  const { dependencies, warnings } = parsePnpmLockfile(lockText);
  const deps = byId(dependencies);

  it("lists each name@version once: peer variants merge, aliases use the real name, workspace links are skipped", () => {
    expect([...deps.keys()].sort()).toEqual([...UNKNOWN, ...EXTERNAL, "qs@6.5.1"].sort());
    expect([...deps.keys()].some((id) => /corp-secret-(alias|ws)/.test(id))).toBe(false);
  });

  it("works out direct, dev and via from the importers, workspaces included", () => {
    const direct = dependencies.filter((d) => d.direct).map((d) => `${d.name}@${d.version}`).sort();
    expect(direct).toEqual(
      [
        "@corp-secret/private@2.1.0",
        "corp-secret-gh@3.0.0",
        "corp-secret-git@1.0.0",
        "corp-secret-local@0.1.0",
        "corp-secret-registry@1.0.0",
        "express-lite@1.2.0",
        "fsevents-lite@2.3.2",
        "lodash@4.17.15",
        "ms@2.1.2",
        "qs@6.5.1",
        "react-dom@18.2.0",
        "react@18.2.0",
        "test-runner@3.4.0",
      ].sort(),
    );
    const dev = dependencies.filter((d) => d.dev).map((d) => `${d.name}@${d.version}`).sort();
    expect(dev).toEqual(["minimist@1.2.0", "react@18.3.1", "string-width@4.2.3", "test-runner@3.4.0"]);
    expect(deps.get("ms@2.0.0")?.via).toEqual(["express-lite@1.2.0", "debug@2.6.9"]);
    expect(deps.get("react@18.3.1")?.via).toEqual(["test-runner@3.4.0", "react-dom@18.2.0"]);
    expect(deps.get("string-width@4.2.3")?.via).toEqual(["test-runner@3.4.0"]);
    expect(deps.get("scheduler@0.23.0")?.via).toEqual(["react-dom@18.2.0"]);
  });

  it("checks a public tarball URL, treats integrity-only entries as unknown, and never checks anything else", () => {
    expect(deps.get("qs@6.5.1")).toMatchObject({ external: false });
    for (const id of UNKNOWN) expect(deps.get(id), id).toMatchObject({ external: true, unresolved: true });
    for (const id of EXTERNAL) {
      expect(deps.get(id)?.external, id).toBe(true);
      expect(deps.get(id)?.unresolved, id).toBeUndefined();
    }
    expect(warnings.join("\n")).toMatch(/does not say which registry 15 packages came from .*--assume-public/);
  });

  it("--assume-public opens integrity-only entries only; --registry opens a mirror's tarballs", () => {
    const opened = byId(parsePnpmLockfile(lockText, { assumePublic: true }).dependencies);
    for (const id of UNKNOWN) expect(opened.get(id)?.external, id).toBe(false);
    for (const id of EXTERNAL) expect(opened.get(id)?.external, id).toBe(true);
    const mirrored = byId(parsePnpmLockfile(lockText, { registries: ["https://npm.corp.example/"] }).dependencies);
    expect(mirrored.get("@corp-secret/private@2.1.0")?.external).toBe(false);
    expect(mirrored.get("lodash@4.17.15")?.external).toBe(true);
  });

  it("flags names npm would not accept, through the package key or an alias", () => {
    const lock = [
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    dependencies:",
      "      '--registry=https://evil.example':",
      "        specifier: npm:a@^1",
      "        version: a@1.0.0",
      "      'b$(touch PWNED)':",
      "        specifier: ^1",
      "        version: 1.0.0",
      "packages:",
      "  a@1.0.0:",
      "    resolution: {integrity: sha512-x}",
      "  'b$(touch PWNED)@1.0.0':",
      "    resolution: {integrity: sha512-x}",
      "snapshots:",
      "  a@1.0.0: {}",
      "  'b$(touch PWNED)@1.0.0': {}",
      "",
    ].join("\n");
    const deps = parsePnpmLockfile(lock, { assumePublic: true }).dependencies;
    expect(deps).toHaveLength(2);
    for (const d of deps) expect(d).toMatchObject({ external: true, invalidName: true });
  });

  it("cleans terminal escapes out of names and versions", () => {
    const lock = [
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    dependencies:",
      "      a: {specifier: '1', version: \"1.0.0\\e[31m\\u202e\"}",
      "packages:",
      "  \"a@1.0.0\\e[31m\\u202e\":",
      "    resolution: {integrity: sha512-x}",
      "snapshots:",
      "  \"a@1.0.0\\e[31m\\u202e\": {}",
      "",
    ].join("\n");
    const [dep] = parsePnpmLockfile(lock, { assumePublic: true }).dependencies;
    expect(dep?.version).toBe("1.0.0 [31m");
    expect(dep?.external).toBe(true);
  });

  it("skips an unbalanced peer suffix instead of guessing", () => {
    const lock = [
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    dependencies:",
      "      a: {specifier: '1', version: 1.0.0(b@1.0.0}",
      "packages:",
      "  a@1.0.0:",
      "    resolution: {integrity: sha512-x}",
      "snapshots:",
      "  a@1.0.0(b@1.0.0: {}",
      "",
    ].join("\n");
    const deps = parsePnpmLockfile(lock, { assumePublic: true }).dependencies;
    // The snapshot key matches no package, so nothing about it is trusted.
    for (const d of deps) if (d.name === "a@1.0.0(b@1.0.0") expect(d.external).toBe(true);
    expect(deps.find((d) => d.name === "a" && d.version === "1.0.0")?.external).toBe(false);
  });

  it("follows each peer variant on its own: a resolved optional peer of a dev-only variant stays dev", () => {
    // The shape pnpm 9.15.9 writes (checked with `pnpm install --lockfile-only`) for one workspace
    // that depends on ajv-formats + ajv@8.13.0 and another that has ajv-formats + ajv@8.12.0 as
    // devDependencies: the resolved optional peer is listed under the variant's
    // optionalDependencies. `pnpm install --prod --frozen-lockfile` then installs
    // ajv-formats@2.1.1_ajv@8.13.0 and ajv@8.13.0 but not ajv@8.12.0 (pnpm follows depPaths with
    // their peer suffix), so ajv@8.12.0 is dev although "ajv-formats@2.1.1" as a whole is production.
    const lock = [
      "lockfileVersion: '9.0'",
      "importers:",
      "  .: {}",
      "  packages/a:",
      "    dependencies:",
      "      ajv: {specifier: 8.13.0, version: 8.13.0}",
      "      ajv-formats: {specifier: 2.1.1, version: 2.1.1(ajv@8.13.0)}",
      "  packages/b:",
      "    devDependencies:",
      "      ajv: {specifier: 8.12.0, version: 8.12.0}",
      "      ajv-formats: {specifier: 2.1.1, version: 2.1.1(ajv@8.12.0)}",
      "packages:",
      "  ajv-formats@2.1.1:",
      "    resolution: {integrity: sha512-x}",
      "    peerDependencies: {ajv: ^8.0.0}",
      "    peerDependenciesMeta: {ajv: {optional: true}}",
      "  ajv@8.12.0: {resolution: {integrity: sha512-x}}",
      "  ajv@8.13.0: {resolution: {integrity: sha512-x}}",
      "  fast-deep-equal@3.1.3: {resolution: {integrity: sha512-x}}",
      "snapshots:",
      "  ajv-formats@2.1.1(ajv@8.12.0):",
      "    optionalDependencies: {ajv: 8.12.0}",
      "  ajv-formats@2.1.1(ajv@8.13.0):",
      "    optionalDependencies: {ajv: 8.13.0}",
      "  ajv@8.12.0:",
      "    dependencies: {fast-deep-equal: 3.1.3}",
      "  ajv@8.13.0:",
      "    dependencies: {fast-deep-equal: 3.1.3}",
      "  fast-deep-equal@3.1.3: {}",
      "",
    ].join("\n");
    const result = parsePnpmLockfile(lock, { assumePublic: true });
    expect(result.warnings).toEqual([]);
    const deps = byId(result.dependencies);
    expect(deps.get("ajv-formats@2.1.1")?.dev).toBe(false);
    expect(deps.get("ajv@8.13.0")?.dev).toBe(false);
    expect(deps.get("fast-deep-equal@3.1.3")?.dev).toBe(false);
    expect(deps.get("ajv@8.12.0")?.dev).toBe(true);
  });

  it.each([
    ["an empty file", ""],
    ["only a comment", "# nothing\n"],
    ["pnpm 8 (lockfile 6.0)", "lockfileVersion: '6.0'\nimporters: {}\n"],
    ["pnpm 7 (lockfile 5.4)", "lockfileVersion: 5.4\n"],
    ["a missing version", "importers: {}\n"],
    ["no importers", "lockfileVersion: '9.0'\npackages: {}\n"],
    ["invalid YAML", "lockfileVersion: '9.0'\nimporters: [\n"],
    ["duplicate keys", "lockfileVersion: '9.0'\nlockfileVersion: '9.0'\nimporters: {}\n"],
    ["YAML aliases", "lockfileVersion: '9.0'\nimporters: &a {x: 1}\npackages: *a\n"],
    ["a billion-laughs document", `lockfileVersion: '9.0'\na: &a [x, x]\nb: &b [*a, *a, *a, *a]\nc: &c [*b, *b, *b, *b]\nimporters: [*c, *c, *c]\n`],
    ["a JSON array", "[1, 2, 3]"],
    ["deep nesting", `lockfileVersion: '9.0'\nimporters: ${"[".repeat(100_000)}${"]".repeat(100_000)}\n`],
  ])("rejects %s with a readable error", (_, text) => {
    expect(() => parsePnpmLockfile(text)).toThrow(UserError);
  });

  it("ignores unknown shapes inside a valid v9 lockfile without crashing", () => {
    const odd = [
      "lockfileVersion: '9.0'",
      "importers:",
      "  .: [not, a, map]",
      "  web:",
      "    dependencies: just-a-string",
      "    devDependencies:",
      "      x: [1, 2]",
      "      y: {version: [1]}",
      "packages: [a, b]",
      "snapshots:",
      "  a@1.0.0: plain",
      "  ? [complex, key]",
      "  : {}",
      "",
    ].join("\n");
    const deps = parsePnpmLockfile(odd).dependencies;
    expect(deps.every((d) => d.external)).toBe(true);
  });

  it("never throws anything but a UserError on mangled input", () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const lines = lockText.split("\n");
    const junk = ["'", '"', ":", "  ", "\t", "{", "}", "[", "]", "&a", "*a", "!!binary", "? ", "- ", "(", ")", "@", "\u0000", "---", "%YAML 1.1"];
    for (let round = 0; round < 300; round++) {
      const copy = [...lines];
      for (let k = 0; k < 4; k++) {
        const at = rand(copy.length);
        const line = copy[at] ?? "";
        const cut = rand(line.length + 1);
        const op = rand(4);
        if (op === 0) copy[at] = line.slice(0, cut) + (junk[rand(junk.length)] as string) + line.slice(cut);
        else if (op === 1) copy.splice(at, 1);
        else if (op === 2) copy.splice(at, 0, line);
        else copy[at] = line.slice(cut);
      }
      try {
        for (const d of parsePnpmLockfile(copy.join("\n")).dependencies) {
          expect(typeof d.name).toBe("string");
          // Mangling can only take checks away: nothing integrity-only becomes public by default.
          if (!d.external) expect(`${d.name}@${d.version}`).toBe("qs@6.5.1");
        }
      } catch (error) {
        expect(error).toBeInstanceOf(UserError);
      }
    }
  });

  it("reads a large lockfile in reasonable time", () => {
    const parts = ["lockfileVersion: '9.0'", "importers:", "  .:", "    dependencies:"];
    const n = 10_000;
    for (let i = 0; i < n; i += 50) parts.push(`      pkg-${i}: {specifier: ^1.0.0, version: 1.0.${i}(peer@1.0.0)}`);
    parts.push("packages:");
    for (let i = 0; i < n; i++) parts.push(`  pkg-${i}@1.0.${i}:`, `    resolution: {integrity: sha512-${"A".repeat(86)}==}`);
    parts.push("snapshots:");
    for (let i = 0; i < n; i++) {
      parts.push(`  pkg-${i}@1.0.${i}(peer@1.0.0):`);
      if ((i + 1) % 50 !== 0) parts.push("    dependencies:", `      pkg-${i + 1}: 1.0.${i + 1}(peer@1.0.0)`);
    }
    const started = Date.now();
    const deps = parsePnpmLockfile(`${parts.join("\n")}\n`, { assumePublic: true }).dependencies;
    expect(deps).toHaveLength(n);
    expect(deps.find((d) => d.name === "pkg-49")?.via).toHaveLength(49);
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});

describe("scan of a pnpm v9 project", () => {
  useFakeNetwork();

  const setUp = () => {
    copyFileSync(fixture, join(net.dir, "pnpm-lock.yaml"));
    net.advisories = [
      { id: "GHSA-qs", name: "qs", fixed: "6.5.3", severity: "HIGH" },
      { id: "GHSA-lodash", name: "lodash", fixed: "4.17.21", severity: "CRITICAL" },
      { id: "GHSA-minimist", name: "minimist", fixed: "1.2.6", severity: "CRITICAL" },
    ];
    net.registry = {
      "express-lite": { latest: "3.0.0", versions: { "1.2.0": {}, "3.0.0": {} } },
      qs: { latest: "6.5.3", versions: { "6.5.1": {}, "6.5.3": {} } },
    };
  };

  it("by default checks only what the lockfile proves public, and produces no plan, command or override", async () => {
    setUp();
    const report = await scan(net.dir, { cache: false });
    expect(report.lockfileType).toBe("pnpm-9");
    expect(report.planUnavailable).toBe("upgrade plan is not available for yarn/pnpm lockfiles yet");
    expect(report.plan).toEqual([]);
    expect(report.commands).toBeUndefined();
    expect(report.suggestedOverrides).toEqual({});
    expect(report.summary.external).toBe(21);
    expect(report.findings.map((f) => f.name)).toEqual(["qs"]);
    const sent = net.requests.join("\n");
    expect(sent).toMatch(/"qs"|\/qs/);
    expect(sent).not.toMatch(/lodash|express-lite|corp-secret|corp\.example|evil/);
  });

  it("with --assume-public reports findings, lag and via, and still never sends a private name", async () => {
    setUp();
    const report = await scan(net.dir, { cache: false, assumePublic: true });
    expect(report.summary.external).toBe(6);
    expect(report.findings.find((f) => f.name === "lodash")).toMatchObject({ direct: true, fixVersion: "4.17.21" });
    expect(report.findings.find((f) => f.name === "express-lite")).toMatchObject({ updateGap: "major" });
    expect(report.findings.find((f) => f.name === "qs")).toMatchObject({ direct: true, fixVersion: "6.5.3" });
    expect(exceedsThreshold(report, "critical")).toBe(true);
    const sent = net.requests.join("\n");
    // corp-secret-registry is integrity-only, so --assume-public sends it: that is what the flag means.
    expect(sent).toMatch(/corp-secret-registry/);
    expect(sent).not.toMatch(/corp-secret-(alias|gh|git|local|mismatch|ws)|@corp-secret|corp\.example|evil|minimist/);

    const text = formatText(report);
    expect(text).toContain("upgrade plan is not available for yarn/pnpm lockfiles yet");
    expect(text).not.toMatch(/^\s*(npm|yarn|pnpm) /m);
    expect(text).not.toMatch(/"overrides"|Transitive fixes/);
  });

  it("--no-dev drops what only dev dependencies reach", async () => {
    setUp();
    const all = await scan(net.dir, { cache: false, assumePublic: true });
    const prod = await scan(net.dir, { cache: false, assumePublic: true, includeDev: false });
    expect(all.summary.packages - prod.summary.packages).toBe(4);
  });

  it("is picked over yarn.lock by packageManager, and over it by the fixed order otherwise", async () => {
    setUp();
    writeFileSync(join(net.dir, "yarn.lock"), "# yarn lockfile v1\n\na@^1.0.0:\n  version \"1.0.0\"\n");
    const ordered = await scan(net.dir, { cache: false });
    expect(ordered.lockfileType).toBe("pnpm-9");
    expect(ordered.warnings.join("\n")).toMatch(/read pnpm-lock\.yaml \(first in the order.*\), not yarn\.lock/);
    writeFileSync(join(net.dir, "package.json"), JSON.stringify({ packageManager: "yarn@1.22.22" }));
    expect((await scan(net.dir, { cache: false })).lockfileType).toBe("yarn-v1");
    writeFileSync(join(net.dir, "package.json"), JSON.stringify({ packageManager: "pnpm@9.12.0" }));
    expect((await scan(net.dir, { cache: false })).lockfileType).toBe("pnpm-9");
  });
});
