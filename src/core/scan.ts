import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Cache, defaultCacheDir } from "./cache.js";
import { buildLockGraph, type LockGraph } from "./graph.js";
import { MAX_LOCKFILE_BYTES, PLAN_UNAVAILABLE, type LockfileType } from "./lockfile/common.js";
import { exactPinnedDependencies, parseNpmLockfile } from "./lockfile/npm.js";
import { parsePnpmLockfile } from "./lockfile/pnpm.js";
import { parseYarnLockfile, type Manifest } from "./lockfile/yarn.js";
import { buildPlan, type OverrideRule, type PlanResult } from "./plan.js";
import { compareVersions, crossesBreaking, isPrerelease, isValidVersion, updateGap } from "./semver.js";
import { fetchPackageInfo, type PackageDeps, type PackageInfo } from "./sources/npm-registry.js";
import { isAffected, queryVulnerabilities, type OsvVuln } from "./sources/osv.js";
import {
  SEVERITY_ORDER,
  type BundledCopy,
  type Dependency,
  type Finding,
  type PlanEntry,
  type Report,
  type Severity,
  type UpdateGap,
} from "./types.js";
import { CircuitBreaker, NetworkError, UserError, displayPath, isMalicious, isValidNpmName, mapLimit, sanitize, type NetContext } from "./util.js";

export interface ScanOptions {
  /** Include devDependencies. Defaults to true. */
  includeDev?: boolean;
  /** Use the on-disk cache. Defaults to true. */
  cache?: boolean;
  /** Override the cache directory (mainly for tests). */
  cacheDir?: string;
  /**
   * URL prefixes of mirrors or proxies of the public npm registry (Artifactory, Nexus, Verdaccio
   * uplinks, ...). Packages resolved from them are checked; registry.npmjs.org and
   * registry.yarnpkg.com are always included.
   */
  registries?: string[];
  /**
   * Treat lockfile entries without a `resolved` URL as public registry packages
   * (for lockfiles written with npm's `omit-lockfile-registry-resolved`).
   */
  assumePublic?: boolean;
  /**
   * Work out the upgrade plan (`Report.plan`): which version of each direct dependency clears the
   * vulnerabilities below it. Makes a few extra registry and OSV requests. Defaults to true.
   */
  plan?: boolean;
  /**
   * Also report direct dependencies pinned to an exact version in package.json as a major version
   * behind. Hidden by default (pins are usually deliberate); vulnerabilities are always reported.
   */
  includePinnedLag?: boolean;
}

/** Supported lockfiles by file name, in the order used when a folder has several and nothing else decides. */
const LOCKFILES: [string, LockfileType][] = [
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
  ["pnpm-lock.yaml", "pnpm-9"],
  ["yarn.lock", "yarn-v1"],
];
const OTHER_LOCKFILES = ["bun.lockb", "bun.lock"];

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

interface Located {
  path: string;
  type: LockfileType;
  /** Set when the folder had several lockfiles: which one was read and why. */
  warning?: string;
}

/** The package manager named by package.json `packageManager` ("pnpm@9.1.0", "yarn@1.22.19"), if any. */
function packageManagerOf(packageJson: string | undefined): LockfileType | undefined {
  try {
    const field = (JSON.parse(packageJson ?? "") as { packageManager?: unknown }).packageManager;
    if (typeof field !== "string") return undefined;
    if (field.startsWith("npm@")) return "npm";
    if (field.startsWith("pnpm@")) return "pnpm-9";
    // yarn 2+ writes a different lockfile format (rejected when read), so only 1.x picks yarn.lock.
    if (field.startsWith("yarn@1.")) return "yarn-v1";
  } catch {
    // no usable package.json
  }
  return undefined;
}

/**
 * Finds the lockfile to read. A file is read by its name. In a folder with several lockfiles the
 * rule is: the one matching package.json `packageManager` (npm, pnpm, or yarn 1.x) when that file
 * exists; otherwise package-lock.json, npm-shrinkwrap.json, pnpm-lock.yaml, yarn.lock, in that
 * order. Either way a warning names the lockfiles that were not read.
 */
async function locateLockfile(target: string): Promise<Located> {
  const path = resolve(target);
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new UserError(`Path not found: ${path}`);
  }
  if (info.isFile()) {
    const known = LOCKFILES.find(([name]) => name === basename(path));
    if (!known) {
      throw new UserError(
        `Unsupported file "${sanitize(basename(path), 200)}". patchpath reads package-lock.json, npm-shrinkwrap.json, ` +
          `yarn.lock (yarn v1) and pnpm-lock.yaml (lockfile v9).`,
      );
    }
    return { path, type: known[1] };
  }
  const present: [string, LockfileType][] = [];
  for (const entry of LOCKFILES) if (await exists(join(path, entry[0]))) present.push(entry);
  if (!present.length) {
    for (const name of OTHER_LOCKFILES) {
      if (await exists(join(path, name))) {
        throw new UserError(
          `Found ${name}, which is not supported yet. patchpath reads package-lock.json, npm-shrinkwrap.json, ` +
            `yarn.lock (yarn v1) and pnpm-lock.yaml (lockfile v9).`,
        );
      }
    }
    throw new UserError(`No lockfile found in ${path} (package-lock.json, npm-shrinkwrap.json, pnpm-lock.yaml or yarn.lock).`);
  }
  let packageJson: string | undefined;
  try {
    packageJson = await readFile(join(path, "package.json"), "utf8");
  } catch {
    // optional
  }
  const manager = packageManagerOf(packageJson);
  const byManager = present.find(([, type]) => type === manager);
  const [name, type] = byManager ?? (present[0] as [string, LockfileType]);
  // npm reads npm-shrinkwrap.json and package-lock.json alike; only a different manager's file is a real conflict.
  const others = present.filter(([other, otherType]) => other !== name && otherType !== type).map(([other]) => other);
  const warning = others.length
    ? `Several lockfiles in this folder: read ${name}` +
      (byManager ? ` (package.json "packageManager" names it)` : ` (first in the order package-lock.json, npm-shrinkwrap.json, pnpm-lock.yaml, yarn.lock)`) +
      `, not ${others.join(", ")}. Pass the path of a lockfile to scan another one.`
    : undefined;
  return { path: join(path, name), type, warning };
}

/**
 * The project's package.json files for a yarn v1 lockfile: the root's, then each workspace's.
 * Workspace patterns are expanded only in the simple forms `dir` and `dir/*` inside the project;
 * others are skipped with a warning (what they declare is then not marked direct).
 */
async function yarnManifests(root: string, packageJson: string | undefined, warnings: string[]): Promise<Manifest[] | undefined> {
  if (packageJson === undefined) return undefined;
  let json: Manifest & { workspaces?: unknown };
  try {
    json = JSON.parse(packageJson) as typeof json;
    if (!json || typeof json !== "object") throw new Error("not an object");
  } catch {
    warnings.push("package.json is not valid JSON, so it was not used to tell direct and dev-only packages apart.");
    return undefined;
  }
  const manifests: Manifest[] = [json];
  const field = json.workspaces;
  const patterns: unknown[] = Array.isArray(field)
    ? field
    : field && typeof field === "object" && Array.isArray((field as { packages?: unknown }).packages)
      ? (field as { packages: unknown[] }).packages
      : [];
  const skipped: string[] = [];
  const folders = new Set<string>();
  const literal = new Set<string>();
  const absent: string[] = [];
  const plain = (part: string) => part !== "" && part !== "." && part !== ".." && !/[*?[\]{}!]/.test(part);
  for (const pattern of patterns.slice(0, 200)) {
    if (typeof pattern !== "string") continue;
    // A negation only removes folders; ignoring it can only add roots (more "direct", less "dev").
    if (pattern.startsWith("!")) continue;
    const clean = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
    const parts = clean.split("/");
    if (parts.every(plain)) {
      folders.add(clean);
      literal.add(clean);
    } else if (parts.length > 1 && parts.at(-1) === "*" && parts.slice(0, -1).every(plain)) {
      const base = parts.slice(0, -1).join("/");
      let matched = 0;
      try {
        for (const entry of await readdir(join(root, base), { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name !== "node_modules" && !entry.name.startsWith(".")) {
            folders.add(`${base}/${entry.name}`);
            matched++;
          }
        }
      } catch {
        // a pattern that matches nothing
      }
      if (!matched) absent.push(pattern);
    } else skipped.push(pattern);
  }
  for (const folder of [...folders].slice(0, 1000)) {
    try {
      const ws = JSON.parse(await readFile(join(root, folder, "package.json"), "utf8")) as Manifest;
      if (ws && typeof ws === "object") manifests.push(ws);
    } catch {
      // A folder named outright is a workspace the project declares; one found through dir/* is just a folder.
      if (literal.has(folder)) absent.push(folder);
    }
  }
  if (absent.length) {
    warnings.push(
      `${absent.length} declared workspace${absent.length === 1 ? " has" : "s have"} no package.json here ` +
        `(${absent.slice(0, 3).map((p) => JSON.stringify(sanitize(p, 80))).join(", ")}${absent.length > 3 ? ", ..." : ""}): ` +
        `what they declare is not marked direct or dev, so those packages may be reported as transitive.`,
    );
  }
  if (skipped.length) {
    warnings.push(
      `Workspace pattern${skipped.length === 1 ? "" : "s"} ${skipped.slice(0, 3).map((p) => JSON.stringify(sanitize(p, 80))).join(", ")} ` +
        `not expanded (only "dir" and "dir/*" are): dependencies declared there are reported as transitive production packages.`,
    );
  }
  return manifests;
}

/**
 * Orders findings: malicious packages, then the worst vulnerability, then deprecations,
 * then everything else. Within a tier, direct beats transitive, production beats dev,
 * and more vulnerabilities beat fewer.
 */
function priorityOf(f: Omit<Finding, "priority">): number {
  const rank: Record<Severity, number> = { critical: 6, high: 5, moderate: 4, unknown: 3, low: 2 };
  let tier = 0;
  if (f.deprecated) tier = 1;
  for (const v of f.vulnerabilities) {
    tier = Math.max(tier, isMalicious(v) ? 7 : rank[v.severity]);
  }
  return (
    tier * 100_000 +
    (f.direct ? 10_000 : 0) +
    (f.dev ? 0 : 1_000) +
    Math.min(f.vulnerabilities.length, 99) * 10 +
    (f.deprecated ? 5 : 0)
  );
}

export async function scan(target: string, options: ScanOptions = {}): Promise<Report> {
  const located = await locateLockfile(target);
  const { path: lockfile, type } = located;
  const root = dirname(lockfile);
  const cache = new Cache(options.cache === false ? null : (options.cacheDir ?? defaultCacheDir()));
  const warnings: string[] = located.warning ? [located.warning] : [];

  let packageJson: string | undefined;
  try {
    packageJson = await readFile(join(root, "package.json"), "utf8");
  } catch {
    // package.json is optional: only v1 lockfiles need it for the direct/transitive split
  }

  if (type !== "npm" && (await stat(lockfile)).size > MAX_LOCKFILE_BYTES) {
    throw new UserError(`${basename(lockfile)} is too large to read (over 64 MB).`);
  }
  // Every installed copy, production and dev: overrides apply to all of them, whatever --no-dev says.
  const lockText = await readFile(lockfile, "utf8");
  const parseOptions = { registries: options.registries, assumePublic: options.assumePublic };
  let allDependencies: Dependency[];
  if (type === "yarn-v1") {
    const parsed = parseYarnLockfile(lockText, await yarnManifests(root, packageJson, warnings), parseOptions);
    allDependencies = parsed.dependencies;
    warnings.push(...parsed.warnings);
  } else if (type === "pnpm-9") {
    const parsed = parsePnpmLockfile(lockText, parseOptions);
    allDependencies = parsed.dependencies;
    warnings.push(...parsed.warnings);
  } else {
    allDependencies = parseNpmLockfile(lockText, packageJson, parseOptions);
  }
  const dependencies =
    options.includeDev === false ? allDependencies.filter((d) => !d.dev) : allDependencies;

  // Private, git and tarball packages are not on the public registry. Looking them up would
  // leak internal names and could return data for an unrelated public package of the same name.
  // Packages without a `resolved` URL are not sent either: nothing says they are public.
  const external = dependencies.filter((d) => d.external && !d.invalidName);
  const checkable = dependencies.filter((d) => !d.external);
  const invalid = dependencies.filter((d) => d.invalidName);
  if (invalid.length) {
    const sample = invalid.slice(0, 3).map((d) => JSON.stringify(sanitize(`${d.name}@${d.version}`, 120))).join(", ");
    warnings.push(
      `${invalid.length} lockfile ${invalid.length === 1 ? "entry has" : "entries have"} a package name npm does not accept ` +
        `(${sample}${invalid.length > 3 ? ", ..." : ""}): not checked, not sent anywhere and left out of every command. ` +
        `Check how the lockfile was produced; it may have been edited by hand or tampered with.`,
    );
  }
  if (external.length) {
    const sample = external.slice(0, 3).map((d) => `${d.name}@${d.version}`).join(", ");
    const unresolved = external.filter((d) => d.unresolved).length;
    const mixed = external.filter((d) => d.mixedHeader && !d.unresolved).length;
    const fixes = [
      unresolved < external.length ? "pass --registry <url> for a mirror of the public npm registry" : "",
      unresolved ? "pass --assume-public if your lockfile omits `resolved` for registry packages" : "",
    ].filter(Boolean);
    warnings.push(
      `${external.length} package${external.length === 1 ? " was" : "s were"} not checked and not sent anywhere ` +
        `(${sample}${external.length > 3 ? ", ..." : ""}): ` +
        `${external.length - unresolved - mixed} from another registry, git or a file, ${unresolved} without a resolved URL` +
        `${mixed ? `, ${mixed} with a header mixing a range and an npm: alias (not known which package was installed)` : ""}. ` +
        `To check them, ${fixes.join(", or ")}.`,
    );
  }

  // One breaker and one cancel signal for the whole scan: when OSV fails the scan is over,
  // so the registry lookups stop instead of retrying in the background.
  const controller = new AbortController();
  const net: NetContext = { signal: controller.signal, breaker: new CircuitBreaker() };

  const infos = new Map<string, PackageInfo>();
  // Per-version dependency data of the documents downloaded below, kept for the upgrade planner.
  // Only npm lockfiles get a plan: its commands are npm commands and its overrides npm overrides.
  const npmLockfile = type === "npm";
  const planning = options.plan !== false && npmLockfile;
  const fresh = new Map<string, PackageDeps>();
  // Passing a callback also caches the planner's data with the report's, even with --no-plan, so
  // that a later run with the plan does not have to download the same documents again.
  const keepDeps = (name: string) => (deps: PackageDeps) => {
    if (planning) fresh.set(name, deps);
  };
  const unreachable = new Map<string, { message: string; skipped: number }>();
  const loadRegistry = () =>
    mapLimit([...new Set(checkable.map((d) => d.name))], 12, async (name) => {
      if (controller.signal.aborted) return;
      try {
        const info = await fetchPackageInfo(name, cache, net, keepDeps(name));
        if (info) infos.set(name, info);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof NetworkError) {
          // A host that is down would otherwise produce one identical warning per package.
          const entry = unreachable.get(error.host) ?? { message: error.message, skipped: 0 };
          entry.skipped++;
          unreachable.set(error.host, entry);
          return;
        }
        warnings.push(`Could not read registry data for ${name}: ${sanitize((error as Error).message, 160)}`);
      }
    });

  const registryDone = loadRegistry();
  let lookup: Awaited<ReturnType<typeof queryVulnerabilities>>;
  try {
    lookup = await queryVulnerabilities(checkable, cache, net);
  } catch (error) {
    controller.abort(error);
    // Wait for the (now cancelled) registry lookups so nothing keeps running after the scan fails.
    await registryDone;
    throw error;
  }
  await registryDone;
  warnings.push(...lookup.warnings);
  for (const [host, { message, skipped }] of unreachable) {
    warnings.push(
      `${host} unreachable (${sanitize(message, 160)}); registry data skipped for ${skipped} ` +
        `package${skipped === 1 ? "" : "s"} (deprecations and latest versions may be missing).`,
    );
  }

  const summary: Report["summary"] = {
    packages: dependencies.length,
    direct: dependencies.filter((d) => d.direct).length,
    external: external.length + invalid.length,
    vulnerablePackages: 0,
    vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0, unknown: 0 },
    deprecated: 0,
    malicious: 0,
    outdated: { major: 0, minor: 0, patch: 0 },
  };

  const pinned = options.includePinnedLag ? new Set<string>() : exactPinnedDependencies(packageJson);
  const findings: Finding[] = [];
  for (const dep of checkable) {
    const result = lookup.results.get(`${dep.name}@${dep.version}`);
    // Worst first, so a truncated listing never hides the most serious advisory.
    const vulns = [...(result?.vulnerabilities ?? [])].sort(
      (a, b) => SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity) || (a.id < b.id ? -1 : 1),
    );
    const info = infos.get(dep.name);
    const deprecated = info?.deprecated[dep.version];
    // Lag only matters for what the project chose to depend on, not for what those pull in.
    const gap: UpdateGap | null = dep.direct && info?.latest && !pinned.has(dep.name) ? updateGap(dep.version, info.latest) : null;

    if (vulns.length) summary.vulnerablePackages++;
    for (const v of vulns) summary.vulnerabilities[v.severity]++;
    if (deprecated) summary.deprecated++;
    if (vulns.some(isMalicious) && summary.malicious !== undefined) summary.malicious++;
    if (gap) summary.outdated[gap]++;

    if (!vulns.length && !deprecated && gap !== "major") continue;
    const fixVersion = result?.fixVersion;
    const partial = {
      name: dep.name,
      version: dep.version,
      direct: dep.direct,
      dev: dep.dev,
      vulnerabilities: vulns,
      deprecated,
      latest: dep.direct ? info?.latest : undefined,
      updateGap: gap ?? undefined,
      fixVersion,
      fixIsBreaking: fixVersion ? crossesBreaking(dep.version, fixVersion) : undefined,
      via: dep.via,
    };
    findings.push({ ...partial, priority: priorityOf(partial) });
  }
  findings.sort((a, b) => b.priority - a.priority || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // A "fixed in" version can carry an advisory of its own (moment 2.29.4 fixes the 2.24.0 ones but
  // has GHSA-4p3w-j4w9-5jqw): check each against OSV and move on to the next fixed version.
  const records = new Map(lookup.records);
  const unverified = await verifyFixVersions(findings, records, cache, net, warnings);

  if (!npmLockfile) {
    // yarn and pnpm: the findings (with their fixed versions) are complete, but nothing here may
    // turn into an npm command or an npm `overrides` block, which would be wrong for these projects.
    return {
      root: displayPath(root),
      lockfile: displayPath(lockfile),
      lockfileType: type,
      scannedAt: new Date().toISOString(),
      summary,
      findings,
      suggestedOverrides: {},
      plan: [],
      planUnavailable: PLAN_UNAVAILABLE,
      warnings: warnings.sort(),
    };
  }

  const graph = buildLockGraph(lockText, packageJson);
  let planResult: PlanResult | undefined;
  if (planning && graph) {
    try {
      planResult = await buildPlan({
        dependencies,
        allDependencies,
        findings,
        records,
        infos,
        fresh,
        overrides: overrideRules(packageJson),
        graph,
        cache,
        net,
      });
      warnings.push(...planResult.warnings);
    } catch (error) {
      // The plan is a bonus: whatever goes wrong, the report itself still stands.
      warnings.push(`Upgrade plan skipped: ${sanitize((error as Error)?.message ?? error, 200)}`);
    }
  }

  const overrides = suggestOverrides(findings, allDependencies, graph, projectDeclared(packageJson, lockText));
  const overridesOmitted = [...unverified]
    .filter(([name]) => !overrides.suggested[name] && findings.some((f) => f.name === name && !f.direct))
    .map(([name, reason]) => ({ name, reason }));
  const plan: PlanEntry[] = planResult?.plan ?? [];
  return {
    root: displayPath(root),
    lockfile: displayPath(lockfile),
    lockfileType: type,
    scannedAt: new Date().toISOString(),
    summary,
    findings,
    suggestedOverrides: overrides.suggested,
    plan,
    commands: planResult?.commands.length ? planResult.commands : undefined,
    refresh: planResult?.refresh,
    bundled: overrides.bundled.length ? overrides.bundled : undefined,
    overridesOmitted: overridesOmitted.length ? overridesOmitted : undefined,
    warnings: warnings.sort(),
  };
}

/** Fixed versions found in the advisories' ranges for `name`, newer than `version`. */
function fixedVersions(records: OsvVuln[], name: string, version: string): string[] {
  const out = new Set<string>();
  for (const record of records) {
    for (const entry of record.affected ?? []) {
      if (entry.package?.ecosystem !== "npm" || entry.package.name !== name) continue;
      for (const range of entry.ranges ?? []) {
        for (const event of range.events ?? []) {
          if (event.fixed && isValidVersion(event.fixed) && compareVersions(event.fixed, version) > 0) out.add(event.fixed);
        }
      }
    }
  }
  return [...out].filter((v) => !isPrerelease(v) || isPrerelease(version));
}

/** Rounds of OSV checks for "fixed in" versions; each round moves a fix past the advisories it carries. */
const FIX_CHECK_ROUNDS = 4;

/**
 * Checks every `fixVersion` against OSV. A fix that carries an advisory itself is replaced by the
 * smallest fixed version (non-breaking first) that is outside every advisory seen so far, and that
 * one is checked again. When none is left, or the check cannot be finished, the fix is removed.
 * Returns the reason per package name for fixes that were removed. Adds new records to `records`.
 */
async function verifyFixVersions(
  findings: Finding[],
  records: Map<string, OsvVuln>,
  cache: Cache,
  net: NetContext,
  warnings: string[],
): Promise<Map<string, string>> {
  const removed = new Map<string, string>();
  const carriedBy = new Map<Finding, Set<string>>();
  let pending = findings.filter((f) => f.fixVersion && f.vulnerabilities.length);
  const drop = (f: Finding, reason: string) => {
    removed.set(f.name, reason);
    f.fixVersion = undefined;
    f.fixIsBreaking = undefined;
  };
  for (let round = 0; round < FIX_CHECK_ROUNDS && pending.length; round++) {
    const refs = new Map(pending.map((f) => [`${f.name}@${f.fixVersion}`, { name: f.name, version: f.fixVersion as string }]));
    let lookup: Awaited<ReturnType<typeof queryVulnerabilities>>;
    try {
      lookup = await queryVulnerabilities([...refs.values()], cache, net, records);
    } catch (error) {
      warnings.push(
        `Could not check the suggested fixed versions against OSV (${sanitize((error as Error)?.message ?? error, 160)}); ` +
          `a "fixed in" version may carry an advisory of its own.`,
      );
      return removed;
    }
    for (const [id, record] of lookup.records) records.set(id, record);
    const next: Finding[] = [];
    for (const f of pending) {
      const fix = f.fixVersion as string;
      const carried = lookup.results.get(`${f.name}@${fix}`)?.vulnerabilities ?? [];
      if (!carried.length) continue;
      const ids = carriedBy.get(f) ?? new Set<string>();
      for (const v of carried) ids.add(v.id);
      carriedBy.set(f, ids);
      const known = [...new Set([...f.vulnerabilities.map((v) => v.id), ...ids])].map((id) => records.get(id));
      const example = `${sanitize(carried[0]?.id, 100)} in ${f.name}@${fix}`;
      if (known.some((r) => !r)) {
        drop(f, `the fixed version carries an advisory whose details could not be read (${example})`);
        continue;
      }
      const candidate = fixedVersions(known as OsvVuln[], f.name, f.version)
        .sort((a, b) => Number(crossesBreaking(f.version, a)) - Number(crossesBreaking(f.version, b)) || compareVersions(a, b))
        .find((v) => (known as OsvVuln[]).every((r) => !isAffected(r, f.name, v)));
      if (!candidate) {
        drop(f, `every fixed version found carries a known advisory (${example})`);
        continue;
      }
      f.fixVersion = candidate;
      f.fixIsBreaking = crossesBreaking(f.version, candidate);
      next.push(f);
    }
    pending = next;
  }
  for (const f of pending) drop(f, `could not confirm a fixed version without advisories of its own`);
  return removed;
}

/**
 * What the root package.json `overrides` (npm) pins, at any depth, with the parents it is nested
 * under: `{"qs": "6.5.1"}` and `{"qs@6": ...}` pin every qs, `{"express": {"qs": "6.5.1"}}` only the
 * qs below express. A key whose value is an object only pins itself through its `"."` entry:
 * `{"express": {"qs": ...}}` leaves express alone.
 */
function overrideRules(packageJson: string | undefined): OverrideRule[] {
  const rules: OverrideRule[] = [];
  // "name" or "name@range"; scoped names start with "@".
  const nameOf = (key: string) => {
    const at = key.indexOf("@", 1);
    return at === -1 ? key : key.slice(0, at);
  };
  type Fields = Record<"dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies", unknown>;
  let pkg: Partial<Fields> & { overrides?: unknown } = {};
  // What the root declares for a name; npm resolves `$name` in this order (Edge#spec).
  const declared = (name: string): string[] =>
    (["devDependencies", "optionalDependencies", "dependencies", "peerDependencies"] as const)
      .map((f) => pkg[f])
      .filter((deps): deps is Record<string, unknown> => Boolean(deps) && typeof deps === "object" && !Array.isArray(deps))
      .map((deps) => (Object.hasOwn(deps, name) ? deps[name] : undefined))
      .filter((v): v is string => typeof v === "string");
  // The range npm checks edges to a top-level, unkeyed rule's name against (see OverrideRule.spec).
  const effective = (key: string, value: unknown): string | undefined => {
    if (key !== nameOf(key) || typeof value !== "string") return undefined;
    const own = declared(key);
    const spec = value.startsWith("$") ? declared(value.slice(1))[0] : value;
    if (!spec || spec.trim() === "" || spec.trim() === "*") return undefined;
    // npm refuses an override of a direct dependency that changes its range (EOVERRIDE).
    if (own.some((s) => s !== spec)) return undefined;
    return spec;
  };
  const walk = (level: unknown, under: string[]) => {
    if (!level || typeof level !== "object" || Array.isArray(level) || under.length > 32) return;
    for (const [key, value] of Object.entries(level)) {
      if (key === ".") continue;
      if (value && typeof value === "object") {
        const dot = (value as Record<string, unknown>)["."];
        if ("." in value) rules.push({ name: nameOf(key), under, ...spec(key, dot, under) });
        walk(value, [...under, nameOf(key)]);
      } else rules.push({ name: nameOf(key), under, ...spec(key, value, under) });
    }
  };
  const spec = (key: string, value: unknown, under: string[]) => {
    const s = under.length ? undefined : effective(key, value);
    return s === undefined ? {} : { spec: s };
  };
  try {
    pkg = JSON.parse(packageJson ?? "{}") ?? {};
    walk(pkg.overrides, []);
  } catch {
    // no package.json or not JSON: nothing is overridden as far as we know
  }
  return rules;
}

/**
 * For transitive packages, pin the fixed version with an npm override. An override replaces
 * EVERY installed copy of a name (production and dev, whatever --no-dev says), so a name is only
 * suggested when that is safe for all copies:
 * - it is not also a direct dependency (npm rejects such overrides with EOVERRIDE unless the spec
 *   matches or uses `$name`, and the right fix there is to bump the dependency itself);
 * - every copy comes from the public registry, has a valid version, is not newer than the fix
 *   (no downgrades) and is on the same breaking line as the fix (same major, same 0.x minor,
 *   same 0.0.x patch).
 * Breaking fixes are left out: they need the parent package to be updated instead.
 *
 * Bundled copies (shipped inside another package's tarball) are not touched by an override, so
 * they are left out of the checks and listed separately: the package that bundles them must be
 * upgraded instead.
 */
/**
 * Every name the project declares itself (root package.json, and the root and workspace entries of
 * a v2/v3 lockfile), whatever the spec: a git, file or URL dependency has no registry copy in the
 * lockfile's flat list, but npm still rejects an override for it (EOVERRIDE).
 */
function projectDeclared(packageJson: string | undefined, lockText: string): Set<string> {
  const names = new Set<string>();
  const add = (pkg: unknown) => {
    if (!pkg || typeof pkg !== "object") return;
    for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      const deps = (pkg as Record<string, unknown>)[section];
      if (deps && typeof deps === "object") for (const name of Object.keys(deps)) names.add(name);
    }
  };
  try {
    add(JSON.parse(packageJson ?? "{}"));
  } catch {
    // no usable package.json
  }
  try {
    const packages = (JSON.parse(lockText.replace(/^﻿/, "")) as { packages?: Record<string, unknown> }).packages ?? {};
    for (const [path, pkg] of Object.entries(packages)) if (!path.includes("node_modules/")) add(pkg);
  } catch {
    // parsed (and reported) elsewhere
  }
  return names;
}

function suggestOverrides(
  findings: Finding[],
  allDependencies: Dependency[],
  graph: LockGraph | null,
  declared: Set<string>,
): { suggested: Record<string, string>; bundled: BundledCopy[] } {
  // name@version -> bundler ids, and the ids of which every copy is bundled.
  const bundlers = new Map<string, Set<string>>();
  const unbundled = new Set<string>();
  for (const node of graph?.nodes.values() ?? []) {
    if (node.root) continue;
    const id = `${node.name}@${node.version}`;
    const bundler = node.bundled && node.bundler ? graph?.nodes.get(node.bundler) : undefined;
    if (bundler) bundlers.set(id, (bundlers.get(id) ?? new Set()).add(`${bundler.name}@${bundler.version}`));
    else unbundled.add(id);
  }
  const bundledOnly = (id: string) => bundlers.has(id) && !unbundled.has(id);

  const bundled: BundledCopy[] = [];
  const wanted = new Map<string, string>();
  for (const f of findings) {
    if (!f.vulnerabilities.length) continue;
    const id = `${f.name}@${f.version}`;
    const by = bundlers.get(id);
    if (by) bundled.push({ package: id, bundledIn: [...by].sort(), advisories: f.vulnerabilities.length });
    if (f.direct || !f.fixVersion || f.fixIsBreaking || bundledOnly(id)) continue;
    if (!isValidNpmName(f.name) || !isValidVersion(f.fixVersion) || declared.has(f.name)) continue;
    const current = wanted.get(f.name);
    if (!current || compareVersions(f.fixVersion, current) > 0) wanted.set(f.name, f.fixVersion);
  }
  const copies = new Map<string, Dependency[]>();
  for (const d of allDependencies) {
    if (bundledOnly(`${d.name}@${d.version}`)) continue;
    copies.set(d.name, [...(copies.get(d.name) ?? []), d]);
  }

  const suggested: Record<string, string> = {};
  for (const [name, fix] of [...wanted].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const safe = (copies.get(name) ?? []).every(
      (d) =>
        !d.direct &&
        !d.external &&
        isValidVersion(d.version) &&
        compareVersions(d.version, fix) <= 0 &&
        !crossesBreaking(d.version, fix),
    );
    if (safe) suggested[name] = fix;
  }
  return { suggested, bundled };
}

