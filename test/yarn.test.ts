import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exceedsThreshold, formatText } from "../src/core/format.js";
import { parseYarnLockfile, type Manifest } from "../src/core/lockfile/yarn.js";
import { scan } from "../src/core/scan.js";
import type { Dependency, Report } from "../src/core/types.js";
import { UserError } from "../src/core/util.js";
import { net, useFakeNetwork } from "./helpers/fake-registry.js";

const fixture = (name: string) => new URL(`./fixtures/yarn-v1/${name}`, import.meta.url);
const lockText = readFileSync(fixture("yarn.lock"), "utf8");
const manifest = JSON.parse(readFileSync(fixture("package.json"), "utf8")) as Manifest;
const byId = (deps: Dependency[]) => new Map(deps.map((d) => [`${d.name}@${d.version}`, d]));

describe("yarn v1 lockfile reader", () => {
  const { dependencies, warnings } = parseYarnLockfile(lockText, [manifest]);
  const deps = byId(dependencies);

  it("reads every block once per name@version, aliases under their real name", () => {
    expect([...deps.keys()].sort()).toEqual(
      [
        "@babel/code-frame@7.12.13",
        "@babel/highlight@7.13.10",
        "@corp-secret/private@2.1.0",
        "chalk@2.4.2",
        "corp-secret-git@1.0.0",
        "corp-secret-local@0.1.0",
        "corp-secret-mismatch@4.17.21",
        "debug@2.6.9",
        "express-lite@1.2.0",
        "fsevents-lite@2.3.2",
        "js-tokens@4.0.0",
        "lodash@4.17.15",
        "minimist@1.2.0",
        "ms@2.0.0",
        "ms@2.1.2",
        "qs@6.5.1",
        "test-runner@3.4.0",
      ].sort(),
    );
    expect([...deps.keys()].some((id) => id.startsWith("corp-secret-alias"))).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("takes direct and dev from package.json and reachability", () => {
    expect(deps.get("express-lite@1.2.0")).toMatchObject({ direct: true, dev: false, external: false });
    expect(deps.get("fsevents-lite@2.3.2")).toMatchObject({ direct: true, dev: false });
    expect(deps.get("test-runner@3.4.0")).toMatchObject({ direct: true, dev: true });
    // Declared in devDependencies and, through the alias, in dependencies: production wins.
    expect(deps.get("lodash@4.17.15")).toMatchObject({ direct: true, dev: false, external: false });
    // Reached from dev (test-runner) and production (express-lite).
    expect(deps.get("debug@2.6.9")).toMatchObject({ direct: false, dev: false, via: ["express-lite@1.2.0"] });
    expect(deps.get("ms@2.0.0")?.via).toEqual(["express-lite@1.2.0", "debug@2.6.9"]);
    expect(deps.get("chalk@2.4.2")?.via).toEqual(["@babel/code-frame@7.12.13", "@babel/highlight@7.13.10"]);
    expect(deps.get("minimist@1.2.0")).toMatchObject({ dev: true, via: ["test-runner@3.4.0"] });
  });

  it("checks only packages whose resolved URL is the public registry tarball of that very package", () => {
    for (const id of ["@babel/code-frame@7.12.13", "chalk@2.4.2", "express-lite@1.2.0", "qs@6.5.1", "ms@2.1.2"]) {
      expect(deps.get(id)?.external, id).toBe(false);
    }
    // private registry, git, file, look-alike host, and a public tarball under someone else's name
    for (const id of ["@corp-secret/private@2.1.0", "corp-secret-git@1.0.0", "corp-secret-local@0.1.0", "minimist@1.2.0", "corp-secret-mismatch@4.17.21"]) {
      expect(deps.get(id)?.external, id).toBe(true);
      expect(deps.get(id)?.unresolved, id).toBeUndefined();
    }
  });

  it("honours --registry for a mirror and --assume-public only for a missing resolved URL", () => {
    const lock = [
      "# yarn lockfile v1",
      "",
      "a@^1.0.0:",
      '  version "1.0.0"',
      '  resolved "https://mirror.example/npm/a/-/a-1.0.0.tgz#abc"',
      "",
      "b@^1.0.0:",
      '  version "1.0.0"',
      "",
      '"c@file:../c":',
      '  version "1.0.0"',
      "",
    ].join("\n");
    const plain = byId(parseYarnLockfile(lock, [{ dependencies: { a: "^1.0.0", b: "^1.0.0", c: "file:../c" } }]).dependencies);
    expect(plain.get("a@1.0.0")?.external).toBe(true);
    expect(plain.get("b@1.0.0")).toMatchObject({ external: true, unresolved: true });
    expect(plain.get("c@1.0.0")).toMatchObject({ external: true });
    expect(plain.get("c@1.0.0")?.unresolved).toBeUndefined();

    const opened = byId(
      parseYarnLockfile(lock, undefined, { registries: ["https://mirror.example/npm"], assumePublic: true }).dependencies,
    );
    expect(opened.get("a@1.0.0")?.external).toBe(false);
    expect(opened.get("b@1.0.0")?.external).toBe(false);
    // A file: spec stays unchecked whatever the options say.
    expect(opened.get("c@1.0.0")?.external).toBe(true);
  });

  it("says so when package.json is missing, and reports everything as transitive production code", () => {
    const result = parseYarnLockfile(lockText, undefined);
    expect(result.dependencies.every((d) => !d.direct && !d.dev && !d.via)).toBe(true);
    expect(result.warnings.join("\n")).toMatch(/No package\.json next to yarn\.lock/);
  });

  it("flags names npm would not accept and never treats them as public", () => {
    const lock = [
      "# yarn lockfile v1",
      "",
      '"evil$(touch PWNED)@^1.0.0":',
      '  version "1.0.0"',
      '  resolved "https://registry.yarnpkg.com/evil$(touch PWNED)/-/x-1.0.0.tgz"',
      "",
      '"ok-alias@npm:-rf@^1.0.0":',
      '  version "1.0.0"',
      '  resolved "https://registry.yarnpkg.com/-rf/-/-rf-1.0.0.tgz"',
      "",
    ].join("\n");
    const deps = parseYarnLockfile(lock, []).dependencies;
    expect(deps).toHaveLength(2);
    for (const d of deps) expect(d).toMatchObject({ external: true, invalidName: true });
  });

  it("cleans terminal escapes and invisible characters out of names and versions", () => {
    const lock = ["# yarn lockfile v1", "", '"a@^1.0.0":', '  version "1.0.0\\u001b[31m\\u202e"', ""].join("\n");
    const [dep] = parseYarnLockfile(lock, []).dependencies;
    expect(dep?.version).toBe("1.0.0 [31m");
    expect(dep?.external).toBe(true);
  });

  it.each([
    ["an empty file", ""],
    ["only comments", "# yarn lockfile v1\n\n"],
    ["a yarn berry lockfile", '__metadata:\n  version: 6\n\n"a@npm:^1.0.0":\n  version: 1.0.0\n'],
    ["JSON", '{"lockfileVersion": 3}'],
    ["an unterminated string", '"a@^1:\n  version "1.0.0"\n'],
    ["a header without a colon", "a@^1.0.0\n  version 1.0.0\n"],
    ["odd indentation", "a@^1.0.0:\n   version 1.0.0\n"],
    ["tabs", "a@^1.0.0:\n\tversion 1.0.0\n"],
    ["an entry without a version", 'a@^1.0.0:\n  resolved "https://registry.yarnpkg.com/a/-/a-1.0.0.tgz"\n'],
    ["a nested entry outside a list", 'a@^1.0.0:\n  version "1.0.0"\n    b "^1"\n'],
    ["a spec without a range", 'a:\n  version "1.0.0"\n'],
  ])("rejects %s with a readable error", (_, text) => {
    expect(() => parseYarnLockfile(text, [])).toThrow(UserError);
  });

  it("never throws anything but a UserError on mangled input", () => {
    // Deterministic pseudo-random mutations of the fixture: cut, duplicate and garble lines.
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const lines = lockText.split("\n");
    const junk = ['"', ":", "  ", "\t", "@", ",", "\\", '"\\u00', "\u0000", "\u202e", "npm:", "a@b@c"];
    for (let round = 0; round < 400; round++) {
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
        const result = parseYarnLockfile(copy.join("\n"), [manifest]);
        for (const d of result.dependencies) expect(typeof d.name).toBe("string");
      } catch (error) {
        expect(error).toBeInstanceOf(UserError);
      }
    }
  });

  it("reads a large lockfile quickly, and pathological lines in linear time", () => {
    const blocks = ["# yarn lockfile v1", ""];
    for (let i = 0; i < 20_000; i++) {
      blocks.push(
        `pkg-${i}@^1.0.0, pkg-${i}@^1.0.1:`,
        `  version "1.0.${i}"`,
        `  resolved "https://registry.yarnpkg.com/pkg-${i}/-/pkg-${i}-1.0.${i}.tgz#${"a".repeat(40)}"`,
        `  integrity sha512-${"A".repeat(86)}==`,
        ...(i > 0 ? ["  dependencies:", `    pkg-${i - 1} "^1.0.0"`] : []),
        "",
      );
    }
    let started = Date.now();
    const deps = parseYarnLockfile(blocks.join("\n"), [{ dependencies: { "pkg-19999": "^1.0.0" } }]).dependencies;
    expect(deps).toHaveLength(20_000);
    // A 20 000-deep chain keeps its first 32 and last 31 hops.
    const via = deps.find((d) => d.name === "pkg-0")?.via ?? [];
    expect(via).toHaveLength(64);
    expect([via[0], via[31], via[32], via[33], via[63]]).toEqual([
      "pkg-19999@1.0.19999",
      "pkg-19968@1.0.19968",
      "...",
      "pkg-31@1.0.31",
      "pkg-1@1.0.1",
    ]);
    expect(deps.find((d) => d.name === "pkg-19935")?.via).toHaveLength(64);
    expect(deps.find((d) => d.name === "pkg-19935")?.via).not.toContain("...");
    expect(Date.now() - started).toBeLessThan(5_000);

    started = Date.now();
    const long = `${'"a'.repeat(200_000)}:\n`;
    expect(() => parseYarnLockfile(long, [])).toThrow(UserError);
    const commas = `a@^1${", ".repeat(200_000)}:\n`;
    expect(() => parseYarnLockfile(commas, [])).toThrow(UserError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("scan of a yarn v1 project", () => {
  useFakeNetwork();

  const setUp = () => {
    copyFileSync(fixture("yarn.lock"), join(net.dir, "yarn.lock"));
    copyFileSync(fixture("package.json"), join(net.dir, "package.json"));
    net.advisories = [
      { id: "GHSA-qs", name: "qs", fixed: "6.5.3", severity: "HIGH" },
      { id: "GHSA-lodash", name: "lodash", fixed: "4.17.21", severity: "CRITICAL" },
      { id: "GHSA-minimist", name: "minimist", fixed: "1.2.6", severity: "CRITICAL" },
    ];
    net.registry = {
      "express-lite": { latest: "3.0.0", versions: { "1.2.0": {}, "3.0.0": {} } },
      qs: { latest: "6.5.3", versions: { "6.5.1": {}, "6.5.3": {} } },
      lodash: { latest: "4.17.21", versions: { "4.17.15": {}, "4.17.21": {} } },
    };
  };

  it("reports findings, lag and via, and produces no upgrade plan, command or override", async () => {
    setUp();
    const report = await scan(net.dir, { cache: false });
    expect(report.lockfileType).toBe("yarn-v1");
    expect(report.planUnavailable).toBe("upgrade plan is not available for yarn/pnpm lockfiles yet");
    expect(report.plan).toEqual([]);
    expect(report.commands).toBeUndefined();
    expect(report.refresh).toBeUndefined();
    expect(report.suggestedOverrides).toEqual({});
    expect(report.overridesOmitted).toBeUndefined();

    const qs = report.findings.find((f) => f.name === "qs");
    expect(qs).toMatchObject({ version: "6.5.1", direct: false, fixVersion: "6.5.3", via: ["express-lite@1.2.0"] });
    expect(report.findings.find((f) => f.name === "lodash")).toMatchObject({ direct: true, fixVersion: "4.17.21" });
    expect(report.findings.find((f) => f.name === "express-lite")).toMatchObject({ updateGap: "major", latest: "3.0.0" });
    // minimist comes from a look-alike host: never checked, so no finding.
    expect(report.findings.some((f) => f.name === "minimist")).toBe(false);
    expect(report.summary.external).toBe(5);
    expect(exceedsThreshold(report, "critical")).toBe(true);

    const text = formatText(report);
    expect(text).toContain("upgrade plan is not available for yarn/pnpm lockfiles yet");
    expect(text).not.toMatch(/^\s*(npm|yarn|pnpm) /m);
    expect(text).not.toMatch(/"overrides"|Transitive fixes/);
    expect(text).not.toContain("Upgrade plan (");
    expect(text).toContain("via express-lite@1.2.0");
  });

  it("still prints no npm command or override when a caller passes plan data in by hand", () => {
    const report: Report = {
      root: "",
      lockfile: "yarn.lock",
      lockfileType: "yarn-v1",
      scannedAt: "",
      summary: {
        packages: 2,
        direct: 1,
        external: 0,
        vulnerablePackages: 1,
        vulnerabilities: { critical: 0, high: 1, moderate: 0, low: 0, unknown: 0 },
        deprecated: 0,
        outdated: { major: 0, minor: 0, patch: 0 },
      },
      findings: [
        {
          name: "qs",
          version: "6.5.1",
          direct: false,
          dev: false,
          vulnerabilities: [{ id: "GHSA-qs", aliases: [], summary: "x", severity: "high", fixedIn: ["6.5.3"], url: "" }],
          fixVersion: "6.5.3",
          via: ["express@4.16.0"],
          priority: 1,
        },
      ],
      suggestedOverrides: { qs: "6.5.3" },
      plan: [
        {
          name: "express",
          version: "4.16.0",
          dev: false,
          status: "upgrade",
          target: "4.22.3",
          total: 1,
          clears: { count: 1, packages: ["qs@6.5.1"], worst: "high" },
          remaining: [],
          estimated: true,
        },
      ],
      commands: [{ kind: "safe", install: ["express@4.22.3"], update: ["qs"], entries: ["express"] }],
      warnings: [],
    };
    const text = formatText(report);
    expect(text).not.toMatch(/npm (install|update)/);
    expect(text).not.toMatch(/"overrides"|Transitive fixes/);
    expect(text).toContain("fixed in 6.5.3");
    // Control: the same data in an npm report is printed, so the guard above is what hides it.
    expect(formatText({ ...report, lockfileType: "npm" })).toMatch(/npm install -- express@4\.22\.3/);
    expect(formatText({ ...report, lockfileType: "npm", plan: [], commands: undefined })).toMatch(/"overrides"/);
    expect(text).not.toContain("Upgrade plan (");
  });

  it("--no-dev drops packages only dev dependencies reach", async () => {
    setUp();
    const report = await scan(net.dir, { cache: false, includeDev: false });
    expect(report.summary.packages).toBe(15);
    const ids = report.findings.map((f) => `${f.name}@${f.version}`);
    expect(ids).not.toContain("test-runner@3.4.0");
  });

  it("never sends the name of a git, file, private-registry, aliased or mismatched package", async () => {
    setUp();
    const report = await scan(net.dir, { cache: false });
    const sent = net.requests.join("\n");
    expect(sent).not.toMatch(/corp-secret|corp\.example|evil/);
    // The alias is looked up under its real name only.
    expect(sent).toMatch(/lodash/);
    expect(report.warnings.join("\n")).toMatch(/5 packages were not checked/);
  });

  it("with --assume-public and a mirror, still never sends git, file or mismatched names", async () => {
    setUp();
    await scan(net.dir, { cache: false, assumePublic: true, registries: ["https://npm.corp.example/"] });
    const sent = net.requests.join("\n");
    // The private registry was declared a mirror, so its package is now checked by name...
    expect(sent).toMatch(/@corp-secret\/private/);
    // ...but nothing else private moves.
    expect(sent).not.toMatch(/corp-secret-(git|local|mismatch|alias)/);
  });

  it("picks the lockfile package.json packageManager names when a folder has several, and says so", async () => {
    setUp();
    writeFileSync(join(net.dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }));
    const pkg = JSON.parse(readFileSync(fixture("package.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(net.dir, "package.json"), JSON.stringify({ ...pkg, packageManager: "yarn@1.22.22" }));
    const report = await scan(net.dir, { cache: false });
    expect(report.lockfileType).toBe("yarn-v1");
    expect(report.warnings.join("\n")).toMatch(/read yarn\.lock \(package\.json "packageManager" names it\), not package-lock\.json/);

    // yarn 2+ in packageManager does not pick yarn.lock: the fixed order applies (npm first).
    writeFileSync(join(net.dir, "package.json"), JSON.stringify({ ...pkg, packageManager: "yarn@4.1.0" }));
    const ordered = await scan(net.dir, { cache: false });
    expect(ordered.lockfileType).toBe("npm");
    expect(ordered.warnings.join("\n")).toMatch(/read package-lock\.json \(first in the order .*\), not yarn\.lock/);

    // A lockfile path is read as given, with no warning about the others.
    const direct = await scan(join(net.dir, "yarn.lock"), { cache: false });
    expect(direct.lockfileType).toBe("yarn-v1");
    expect(direct.warnings.join("\n")).not.toMatch(/Several lockfiles/);
  });

  it("reads yarn workspaces declared as dir/* and literal folders", async () => {
    setUp();
    const pkg = JSON.parse(readFileSync(fixture("package.json"), "utf8")) as Record<string, unknown>;
    // The root no longer declares express-lite; a workspace does.
    pkg.dependencies = { "@babel/code-frame": "^7.12.13" };
    pkg.workspaces = ["packages/*", "tools/**"];
    writeFileSync(join(net.dir, "package.json"), JSON.stringify(pkg));
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(net.dir, "packages", "web"), { recursive: true });
    writeFileSync(join(net.dir, "packages", "web", "package.json"), JSON.stringify({ dependencies: { "express-lite": "^1.0.0" } }));
    const report = await scan(net.dir, { cache: false });
    expect(report.findings.find((f) => f.name === "express-lite")).toMatchObject({ direct: true });
    expect(report.warnings.join("\n")).toMatch(/Workspace pattern "tools\/\*\*" not expanded/);
  });
});

describe("yarn header mixing a range and an npm: alias", () => {
  useFakeNetwork();

  it("is left unchecked, and the warning names the mixed header, not another registry", async () => {
    const lock = [
      "# yarn lockfile v1",
      "",
      '"@babel/plugin-x@^7.10.4", "@babel/plugin-x@npm:@someone/plugin-x@^7.5.2":',
      '  version "7.5.2"',
      '  resolved "https://registry.yarnpkg.com/@someone/plugin-x/-/plugin-x-7.5.2.tgz#abc"',
      "",
    ].join("\n");
    writeFileSync(join(net.dir, "yarn.lock"), lock);
    writeFileSync(join(net.dir, "package.json"), JSON.stringify({ dependencies: { "@babel/plugin-x": "^7.10.4" } }));
    const report = await scan(net.dir, { cache: false });
    expect(report.summary.external).toBe(1);
    const text = report.warnings.join("\n");
    expect(text).toMatch(/1 with a header mixing a range and an npm: alias/);
    expect(text).toMatch(/0 from another registry, git or a file/);
    expect(net.requests.join("\n")).not.toMatch(/plugin-x/);
  });
});

describe("yarn workspaces missing from the folder", () => {
  useFakeNetwork();

  it("warns once, with a count and examples, for declared workspaces that have no package.json", async () => {
    copyFileSync(fixture("yarn.lock"), join(net.dir, "yarn.lock"));
    const pkg = JSON.parse(readFileSync(fixture("package.json"), "utf8")) as Record<string, unknown>;
    pkg.workspaces = ["packages/*", "docs", "tools/cli", "missing/*"];
    writeFileSync(join(net.dir, "package.json"), JSON.stringify(pkg));
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(net.dir, "packages", "web"), { recursive: true });
    writeFileSync(join(net.dir, "packages", "web", "package.json"), JSON.stringify({ dependencies: {} }));
    const report = await scan(net.dir, { cache: false });
    const lines = report.warnings.filter((w) => /workspace/i.test(w) && /no package\.json/.test(w));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^3 declared workspaces have no package\.json here/);
    expect(lines[0]).toContain('"docs"');
    expect(lines[0]).toContain('"missing/*"');
  });
});

describe("yarn deps declared but absent from yarn.lock", () => {
  const noEntry = (ws: Manifest[], deps: Record<string, string>) =>
    parseYarnLockfile(lockText, [{ ...manifest, dependencies: { ...manifest.dependencies, ...deps } }, ...ws]).warnings.filter((w) =>
      /no yarn\.lock entry/.test(w),
    );

  it("does not count dependencies between workspace packages", () => {
    const ws = [
      { name: "@ws/a", version: "1.4.0" },
      { name: "@ws/b", version: "2.0.0" },
      { name: "@ws/c", version: "0.0.1" },
      { name: "@ws/d", version: "1.0.0" },
    ] as Manifest[];
    expect(noEntry(ws, { "@ws/a": "^1.0.0", "@ws/b": "workspace:*", "@ws/c": "*", "@ws/d": "1.0.0" })).toEqual([]);
  });

  it("still counts a workspace-named dependency the workspace does not satisfy, and real misses", () => {
    const warnings = noEntry([{ name: "@ws/a", version: "1.4.0" } as Manifest], { "@ws/a": "^2.0.0", "not-in-lock": "^1.0.0" });
    expect(warnings.join("\n")).toMatch(/^2 dependencies declared in package\.json have no yarn\.lock entry/);
  });
});
