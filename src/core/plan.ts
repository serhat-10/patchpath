import Range from "semver/classes/range.js";
import type { Cache } from "./cache.js";
import type { GraphNode, LockGraph } from "./graph.js";
import { stripAlias } from "./graph.js";
import { compareVersions, crossesBreaking, isPrerelease, isValidVersion } from "./semver.js";
import { fetchPackageDeps, fetchPackageInfo, type PackageDeps, type PackageInfo } from "./sources/npm-registry.js";
import { isAffected, queryVulnerabilities, type OsvVuln, type PackageRef } from "./sources/osv.js";
import {
  SEVERITY_ORDER,
  type Dependency,
  type Finding,
  type PlanAdvisory,
  type PlanCommand,
  type PlanEntry,
  type PlanRefresh,
  type Severity,
  type Vulnerability,
} from "./types.js";
import { NetworkError, isValidNpmName, mapLimit, sanitize, type NetContext } from "./util.js";

/** Newest releases tried per breaking line (the current line and each newer one). */
export const CANDIDATES_PER_LINE = 20;
/** Newer breaking lines tried, newest first (e.g. the 3 newest majors above the installed one). */
export const BREAKING_LINES = 3;
/**
 * Registry requests the planner may make per scan, on top of those made for the report itself.
 * Usually none are needed (the report's documents are reused or cached); the cap bounds the
 * worst case (a warm report cache with a cold planner cache). Requests run 8 at a time.
 */
export const MAX_PLAN_REQUESTS = 150;
/** How many levels of parents the in-range refresh search adds to `npm update` for one package. */
export const MAX_REFRESH_LEVELS = 3;
/**
 * How many install locations the planner may work out per scan, over all simulated scenarios.
 * Ordinary lockfiles stay far below it; a very large, densely connected tree would otherwise keep
 * the planner busy for minutes. Candidate upgrades may use the first 60%, the in-range update
 * search the rest. What is cut off is reported, never guessed.
 */
export const MAX_PLAN_WORK = 1_200_000;
/**
 * Of MAX_PLAN_REQUESTS, how many may go to peers a new version declares that are not installed
 * (npm still checks them), and how many names one such peer set may have before it is not checked.
 */
const MAX_HIDDEN_PEER_REQUESTS = 30;
const MAX_PEER_SET = 80;
const CANDIDATE_WORK_SHARE = 0.6;
const HELD_WORK_SHARE = 1.1;
const WORK_LIMIT_REASON = "not estimated: the dependency tree is too large to simulate every upgrade within the plan's work limit";
const REFUSED_REASON = "left out: its name, alias or workspace folder is not one npm accepts as it is (see the warnings)";

export interface PlanInput {
  /** The scanned dependencies (after --no-dev). */
  dependencies: Dependency[];
  /** Every installed package, dev ones included (for the public/private check). Defaults to `dependencies`. */
  allDependencies?: Dependency[];
  findings: Finding[];
  /** Advisory records (with affected ranges) from the main OSV lookup. */
  records: Map<string, OsvVuln>;
  /** Registry data from the main lookup: deprecations and `latest`. */
  infos: Map<string, PackageInfo>;
  /** Per-version dependency data of documents already downloaded in this scan. */
  fresh: Map<string, PackageDeps>;
  /** What the root package.json `overrides` pins. */
  overrides: OverrideRule[];
  /** Every install location and dependency edge of the lockfile. */
  graph: LockGraph;
  cache: Cache;
  net: NetContext;
}

/**
 * One package an npm override pins: `name`, below the chain of parent names it is nested under
 * (`{"express": {"body-parser": {"qs": ...}}}`: qs under ["express", "body-parser"]; [] for top level).
 */
export interface OverrideRule {
  name: string;
  under: string[];
  /**
   * Only for a top-level rule without a version in its key: the range npm checks every edge to
   * `name` against instead of the edge's own (peer edges included), with a `$name` reference
   * resolved from the root package.json. Unset when npm would not take it as it is (`*`, a
   * reference it cannot resolve, a value that differs from the root's own declaration: EOVERRIDE).
   */
  spec?: string;
}

export interface PlanResult {
  plan: PlanEntry[];
  /** The commands that apply the plan, safe step first. */
  commands: PlanCommand[];
  refresh?: PlanRefresh;
  warnings: string[];
  /** Registry requests made by the planner (cache hits and reused documents do not count). */
  requests: number;
}

/** A vulnerable installed package (`name@version`) and every location it is installed at. */
interface Target {
  id: string;
  name: string;
  version: string;
  finding: Finding;
  paths: string[];
  /** Every copy is bundled: only the bundling package can change it. */
  bundled: boolean;
}

/** A root or workspace (`root`, "" for the project root) declaring `key`, which resolves to `path`. */
interface Declaration {
  root: string;
  key: string;
  path: string;
  /** Declared only in `peerDependencies`. */
  peer: boolean;
}

/** One `npm install` argument: `key` (alias or name) at `version`, in the root or a workspace. */
interface Install {
  root: string;
  key: string;
  name: string;
  version: string;
  /** Install locations it moves. */
  paths: string[];
  peer: boolean;
}

const MARKER = "node_modules/";
/** The folder name a location is installed under: the alias for npm aliases, else the package name. */
const keyOf = (path: string) => path.slice(path.lastIndexOf(MARKER) + MARKER.length);
/** A workspace folder that can be passed to `-w` as it is (no shell metacharacters, no `..`, no leading `-`). */
const isPlainFolder = (path: string) => /^[A-Za-z0-9._@][A-Za-z0-9._@/-]*$/.test(path) && !path.split("/").includes("..");
const argOf = (i: Install) => (i.key === i.name ? `${i.name}@${i.version}` : `${i.key}@npm:${i.name}@${i.version}`);

interface Group {
  direct: Dependency;
  /** Install locations of the direct dependency (one per root or workspace that declares it). */
  paths: string[];
  targets: Target[];
}

/** What npm is estimated to end up with at one location: a set of versions (empty: gone). */
interface Resolution {
  versions: Set<string>;
  unknown: boolean;
}

interface Scenario {
  /** Direct dependency locations moved by `npm install name@version`. */
  changes: Map<string, string>;
  /** Names `npm update` is run for. */
  update: Set<string>;
  /**
   * Assume `npm update` for any package whose parent changed and whose locked version still
   * satisfies the new range; the names this matters for are collected in `assumed`.
   */
  refreshChanged: boolean;
  /** Names `refreshChanged` leaves where they are: the commands leave them out of `npm update`. */
  keep?: Set<string>;
}

/** Where a target ends up: the union over all its locations. */
interface Outcome {
  versions: string[];
  unknown: boolean;
}

interface Evaluation {
  version: string;
  breaking: boolean;
  remaining: PlanAdvisory[];
  cleared: { target: Target; vuln: Vulnerability }[];
  alsoUpdate: string[];
  unresolved: string[];
  score: number;
}

const WEIGHT: Record<Severity, number> = { critical: 10_000, high: 1_000, moderate: 100, unknown: 100, low: 1 };
const rank = (s: Severity) => SEVERITY_ORDER.indexOf(s);
const worstOf = (list: Severity[]): Severity | undefined =>
  list.reduce<Severity | undefined>((w, s) => (w === undefined || rank(s) > rank(w) ? s : w), undefined);
const scopeOf = (name: string) => (name.startsWith("@") && name.includes("/") ? name.slice(0, name.indexOf("/")) : undefined);

class CapReached extends Error {}

/**
 * Builds the upgrade plan. Never throws for network or data problems: they become warnings and
 * `unavailable` entries.
 */
export async function buildPlan(input: PlanInput): Promise<PlanResult> {
  const { dependencies, findings, infos, fresh, overrides, graph, cache, net } = input;
  const warnings: string[] = [];
  const records = new Map(input.records);
  const byId = new Map(dependencies.map((d) => [`${d.name}@${d.version}`, d]));
  const allById = new Map((input.allDependencies ?? dependencies).map((d) => [`${d.name}@${d.version}`, d]));
  const idOfNode = (n: GraphNode) => `${n.name}@${n.version}`;
  const publicPaths = new Set(
    [...graph.nodes.values()].filter((n) => !n.root && allById.get(idOfNode(n))?.external === false).map((n) => n.path),
  );
  const isPublic = (n: GraphNode) => publicPaths.has(n.path);
  const overBudget: string[] = [];
  let refreshCut = false;
  const uncheckedUpdates: string[] = [];
  const nodeAt = (path: string) => graph.nodes.get(path) as GraphNode;
  // Install locations an override pins: every copy for a top-level override, only the copies
  // below the named parents for a nested one (`{"express": {"qs": ...}}` leaves other's qs free).
  const pinned = new Set<string>();
  {
    const below = (from: string[]): string[] => {
      const seen = new Set<string>();
      const stack = from.flatMap((p) => nodeAt(p).out.map((e) => e.to));
      while (stack.length) {
        const path = stack.pop() as string;
        if (seen.has(path) || nodeAt(path).root) continue;
        seen.add(path);
        for (const e of nodeAt(path).out) stack.push(e.to);
      }
      return [...seen];
    };
    const all = [...graph.nodes.values()].filter((n) => !n.root).map((n) => n.path);
    for (const rule of overrides) {
      let scope = all;
      for (const parent of rule.under) scope = below(scope.filter((p) => nodeAt(p).name === parent));
      for (const p of scope) if (nodeAt(p).name === rule.name) pinned.add(p);
    }
  }

  // 1. Vulnerable targets, with every location they are installed at.
  const pathsById = new Map<string, string[]>();
  for (const node of graph.nodes.values()) {
    if (node.root) continue;
    const id = idOfNode(node);
    pathsById.set(id, [...(pathsById.get(id) ?? []), node.path]);
  }
  const targets: Target[] = [];
  for (const f of findings) {
    if (!f.vulnerabilities.length) continue;
    const id = `${f.name}@${f.version}`;
    const paths = pathsById.get(id);
    if (!paths?.length) continue;
    targets.push({ id, name: f.name, version: f.version, finding: f, paths, bundled: paths.every((p) => nodeAt(p).bundled) });
  }
  if (!targets.length) return { plan: [], commands: [], warnings, requests: 0 };

  // Direct locations: what a root or workspace declares. Only scanned ones (--no-dev) start a group.
  const directPaths = new Map<string, string[]>();
  const declarations = new Map<string, Declaration[]>();
  for (const node of graph.nodes.values()) {
    if (!node.root) continue;
    for (const e of node.out) {
      const child = nodeAt(e.to);
      if (child.root) continue;
      const id = idOfNode(child);
      const list = directPaths.get(id) ?? [];
      if (!list.includes(child.path)) directPaths.set(id, [...list, child.path]);
      declarations.set(id, [...(declarations.get(id) ?? []), { root: node.path, key: e.key, path: child.path, peer: e.peer }]);
    }
  }
  const directSet = new Set([...directPaths.values()].flat());
  // Breadth-first from the direct dependencies: each location's nearest direct dependency.
  const nearest = new Map<string, string>();
  const queue: string[] = [];
  for (const [id, paths] of directPaths) {
    if (!byId.get(id)?.direct) continue;
    for (const p of paths) {
      if (!nearest.has(p)) {
        nearest.set(p, id);
        queue.push(p);
      }
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const path = queue[head] as string;
    for (const e of nodeAt(path).out) {
      if (nearest.has(e.to) || nodeAt(e.to).root) continue;
      nearest.set(e.to, nearest.get(path) as string);
      queue.push(e.to);
    }
  }
  const depth = new Map(queue.map((p, i) => [p, i]));
  const groups = new Map<string, Group>();
  for (const t of targets) {
    const first = [...t.paths].filter((p) => nearest.has(p)).sort((a, b) => (depth.get(a) as number) - (depth.get(b) as number))[0];
    const directId = first === undefined ? undefined : nearest.get(first);
    const direct = directId === undefined ? undefined : byId.get(directId);
    if (!direct || directId === undefined) continue;
    let group = groups.get(directId);
    if (!group) groups.set(directId, (group = { direct, paths: directPaths.get(directId) ?? [], targets: [] }));
    group.targets.push(t);
  }

  const worstOfTargets = (list: Target[]) =>
    worstOf(list.flatMap((t) => t.finding.vulnerabilities.map((v) => v.severity))) ?? "unknown";
  const ordered = [...groups.values()].sort(
    (a, b) => rank(worstOfTargets(b.targets)) - rank(worstOfTargets(a.targets)) || (a.direct.name < b.direct.name ? -1 : 1),
  );
  // Production first, then the worst advisory: this is the order the request budget is spent in.
  const byPriority = [...targets].sort(
    (a, b) =>
      Number(a.finding.dev) - Number(b.finding.dev) ||
      rank(worstOfTargets([b])) - rank(worstOfTargets([a])) ||
      (a.id < b.id ? -1 : 1),
  );

  // 2. Registry metadata for the direct dependencies and every package above a vulnerable copy.
  //    Packages that are not from the public registry are never requested. Most documents were
  //    already downloaded for the report (`fresh`) or are cached; the rest count against
  //    MAX_PLAN_REQUESTS, spent in priority order.
  const wanted = new Set<string>();
  const want = (name: string) => wanted.add(name);
  const groupOf = new Map<Target, Group>();
  for (const g of ordered) for (const t of g.targets) groupOf.set(t, g);
  // One walk for all targets: what an earlier (more urgent) target reached is wanted already.
  const seen = new Set<string>();
  for (const t of byPriority) {
    const g = groupOf.get(t);
    if (g && !g.direct.external) want(g.direct.name);
    let frontier = t.paths;
    while (frontier.length) {
      const next: string[] = [];
      for (const p of frontier) {
        if (seen.has(p)) continue;
        seen.add(p);
        const node = nodeAt(p);
        if (!isPublic(node)) continue;
        want(node.name);
        for (const e of node.in) if (!seen.has(e.from)) next.push(e.from);
        if (node.bundler && !seen.has(node.bundler)) next.push(node.bundler);
      }
      frontier = next;
    }
  }
  // Direct dependencies that move in lockstep with a planned one (same scope, same version).
  for (const g of ordered) {
    const scope = scopeOf(g.direct.name);
    if (!scope) continue;
    for (const [id, paths] of directPaths) {
      const node = nodeAt(paths[0] as string);
      if (scopeOf(node.name) === scope && node.version === g.direct.version && isPublic(node) && id !== `${g.direct.name}@${g.direct.version}`) {
        want(node.name);
      }
    }
  }

  const metas = new Map<string, PackageDeps>();
  const failures = new Map<string, string>();
  const capped = new Set<string>();
  let requests = 0;
  await mapLimit([...wanted], 8, async (name) => {
    if (net.signal?.aborted) return;
    try {
      const { deps } = await fetchPackageDeps(name, cache, net, fresh.get(name), () => {
        if (requests >= MAX_PLAN_REQUESTS) throw new CapReached();
        requests++;
      });
      if (deps) metas.set(name, deps);
      else failures.set(name, "not found on the registry");
    } catch (error) {
      if (error instanceof CapReached) {
        capped.add(name);
        failures.set(
          name,
          `request limit reached: rerun patchpath to continue${cache.enabled ? ", the registry data read so far is cached" : ""}`,
        );
      } else if (error instanceof NetworkError) {
        // The report already warns about an unreachable host; the entries say why they are missing.
        failures.set(name, `${error.host} unreachable`);
      } else {
        failures.set(name, sanitize((error as Error)?.message ?? error, 120));
      }
    }
  });
  // v1 lockfiles do not record peerDependencies. Take them from registry data that is already at
  // hand (this scan's downloads or the cache; no requests), so peer conflicts can be seen there too.
  const hasPeerEdges = [...graph.nodes.values()].some((n) => !n.root && n.out.some((e) => e.peer));
  if (!hasPeerEdges) {
    const others = [...new Set([...graph.nodes.values()].filter((n) => isPublic(n) && !metas.has(n.name)).map((n) => n.name))];
    const local = new Map<string, PackageDeps>();
    await mapLimit(others, 16, async (name) => {
      try {
        const { deps } = await fetchPackageDeps(name, cache, net, fresh.get(name), () => {
          throw new CapReached();
        });
        if (deps) local.set(name, deps);
      } catch {
        // not cached: no peer data for it
      }
    });
    for (const node of graph.nodes.values()) {
      if (node.root || node.bundled) continue;
      const peers = (metas.get(node.name) ?? local.get(node.name))?.peers?.[node.version];
      for (const [key, spec] of Object.entries(peers ?? {})) {
        if (node.out.some((e) => e.key === key)) continue;
        const to = graph.locate(node.path, key);
        const target = to === undefined ? undefined : graph.nodes.get(to);
        if (!target || to === node.path) continue;
        const edge = { from: node.path, to: to as string, key, spec: stripAlias(spec), peer: true };
        node.out.push(edge);
        target.in.push(edge);
      }
    }
  }

  if (capped.size) {
    warnings.push(
      `Upgrade plan: request limit reached (${MAX_PLAN_REQUESTS} extra registry requests); ` +
        `${capped.size} package${capped.size === 1 ? " was" : "s were"} not looked up yet, so some estimates are incomplete. ` +
        (cache.enabled ? "Rerun to continue: what was read so far is cached." : "Rerun without --no-cache to continue."),
    );
  }

  // 3. The resolver: what npm is estimated to keep, move or drop at each location.
  const rangeCache = new Map<string, Range | null>();
  const rangeOf = (spec: string): Range | null => {
    let r = rangeCache.get(spec);
    if (r === undefined) {
      try {
        r = new Range(spec);
      } catch {
        r = null; // git URLs, tags, file: specs and other non-semver specs
      }
      rangeCache.set(spec, r);
    }
    return r;
  };
  /**
   * Peer ranges, checked like npm does (arborist dep-valid: `semver.satisfies(version, range, true)`,
   * loose and without prereleases): an installed 15.1.0-rc.1 does not satisfy ^15.0.0. A spec of
   * "*" (or "", which npm reads as "*") is valid for any version, prereleases included.
   */
  const peerRange = (spec: string): Range | null => {
    let r = peerRangeCache.get(spec);
    if (r === undefined) {
      const any = spec.trim() === "" || spec.trim() === "*";
      try {
        r = any ? new Range("*", { includePrerelease: true }) : new Range(spec, { loose: true });
      } catch {
        r = null;
      }
      peerRangeCache.set(spec, r);
    }
    return r;
  };
  const peerRangeCache = new Map<string, Range | null>();
  const satisfiesCache = new Map<string, boolean>();
  const satisfies = (version: string, spec: string) => {
    const key = `${version}\u0000${spec}`;
    let ok = satisfiesCache.get(key);
    if (ok === undefined) {
      const range = rangeOf(spec);
      ok = Boolean(range && isValidVersion(version) && range.test(version));
      satisfiesCache.set(key, ok);
    }
    return ok;
  };
  const isOptionalPeer = (name: string, version: string, peer: string) =>
    Boolean(metas.get(name)?.optionalPeers?.[version]?.includes(peer));
  /**
   * Whether something outside the subtrees of `moved` still needs the package at `at`. An optional
   * peer that is only installed because the moving package itself pulls it in (jest-cli 24 ->
   * node-notifier) goes away with the move, so it cannot conflict afterwards.
   */
  const heldOutside = (at: string, moved: string[]): boolean => {
    const below = new Set<string>();
    const stack = [...moved];
    while (stack.length) {
      const path = stack.pop() as string;
      if (below.has(path)) continue;
      below.add(path);
      for (const e of nodeAt(path).out) if (!e.peer) stack.push(e.to);
    }
    return nodeAt(at).in.some((e) => !e.peer && !below.has(e.from));
  };
  /** Deprecations of packages that are not installed (the report only reads installed ones). */
  const extraInfos = new Map<string, PackageInfo>();
  const isDeprecated = (name: string, version: string) =>
    Boolean((infos.get(name) ?? extraInfos.get(name))?.deprecated[version]);
  /** Like npm: the `latest` tag if it satisfies, else the newest non-deprecated match, else the newest match. */
  const pickIn = (meta: PackageDeps | undefined, name: string, spec: string): string | null => {
    const range = rangeOf(spec);
    if (!meta || !range) return null;
    const matches = Object.keys(meta.versions).filter((v) => isValidVersion(v) && range.test(v));
    if (meta.latest && matches.includes(meta.latest) && !isDeprecated(name, meta.latest)) return meta.latest;
    matches.sort((a, b) => Number(isDeprecated(name, a)) - Number(isDeprecated(name, b)) || compareVersions(b, a));
    return matches[0] ?? null;
  };
  const pickCache = new Map<string, string | null>();
  const pick = (name: string, spec: string): string | null => {
    const key = `${name}\u0000${spec}`;
    const known = pickCache.get(key);
    if (known !== undefined) return known;
    const result = pickIn(metas.get(name), name, spec);
    pickCache.set(key, result);
    return result;
  };
  /** Like `pick`, for a version that satisfies every one of `specs`. */
  const pickAll = (name: string, specs: string[]): string | null => {
    const unique = [...new Set(specs)];
    if (unique.length === 1) return pick(name, unique[0] as string);
    const key = `${name}\u0000${unique.sort().join("\u0001")}`;
    const known = pickCache.get(key);
    if (known !== undefined) return known;
    const meta = metas.get(name);
    const ranges = unique.map(rangeOf);
    let result: string | null = null;
    if (meta && ranges.every((r) => r)) {
      const matches = Object.keys(meta.versions).filter((v) => isValidVersion(v) && ranges.every((r) => (r as Range).test(v)));
      if (meta.latest && matches.includes(meta.latest) && !isDeprecated(name, meta.latest)) result = meta.latest;
      else {
        matches.sort((a, b) => Number(isDeprecated(name, a)) - Number(isDeprecated(name, b)) || compareVersions(b, a));
        result = matches[0] ?? null;
      }
    }
    pickCache.set(key, result);
    return result;
  };
  /** The range `deps` declares under `key`, following npm aliases ("x": "npm:name@^1"). */
  const declared = (deps: Record<string, string>, key: string): string | undefined =>
    deps[key] === undefined ? undefined : stripAlias(deps[key] as string);

  /** Locations worked out so far, over every resolver: the measure of the plan's work budget. */
  let work = 0;
  const bundledBy = new Map<string, string[]>();
  const pathsNamed = new Map<string, string[]>();
  for (const node of graph.nodes.values()) {
    if (node.bundler) bundledBy.set(node.bundler, [...(bundledBy.get(node.bundler) ?? []), node.path]);
    if (!node.root) pathsNamed.set(node.name, [...(pathsNamed.get(node.name) ?? []), node.path]);
  }
  /** The lockfile as it is, worked out once; and the locations where that is not simply "as installed". */
  let baseline: Map<string, Resolution> | undefined;
  let unstable: string[] = [];
  /** Everything a scenario can move: forward from what it changes, updates, or what is unstable anyway. */
  const closureOf = (scenario: Scenario): Set<string> => {
    const seen = new Set<string>();
    const queue = [...scenario.changes.keys(), ...unstable, ...[...scenario.update].flatMap((n) => pathsNamed.get(n) ?? [])];
    for (const p of queue) seen.add(p);
    for (let head = 0; head < queue.length; head++) {
      const path = queue[head] as string;
      for (const next of [...nodeAt(path).out.map((e) => e.to), ...(bundledBy.get(path) ?? [])]) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    return seen;
  };

  const makeResolver = (scenario: Scenario) => {
    const memo = new Map<string, Resolution>();
    const visiting = new Set<string>();
    const assumed = new Set<string>();
    const locked = (node: GraphNode): Resolution => ({ versions: new Set([node.version]), unknown: false });
    /**
     * Where a location ends up can only differ from the lockfile when something above it moves:
     * locations outside the forward closure of what the scenario touches keep their baseline.
     */
    const affected = baseline ? closureOf(scenario) : undefined;
    const shortcut = (path: string): Resolution | undefined => {
      const node = nodeAt(path);
      if (node.root) return locked(node);
      const change = scenario.changes.get(path);
      if (change !== undefined) return { versions: new Set([change]), unknown: false };
      const known = memo.get(path);
      if (known) return known;
      if (affected && baseline && !affected.has(path)) return baseline.get(path) ?? locked(node);
      return undefined;
    };
    /** What `path` waits for: the locations whose result its own depends on. */
    const inputsOf = (node: GraphNode): string[] =>
      pinned.has(node.path) ? [] : node.bundled && node.bundler ? [node.bundler] : node.in.map((e) => e.from);
    // A dependency cycle: a location still being worked out is assumed to stay where it is.
    const get = (path: string): Resolution => shortcut(path) ?? locked(nodeAt(path));
    const compute = (path: string): Resolution => {
      const node = nodeAt(path);
      work++;
      // Nothing above it moved and nothing asks for it: it stays as the lockfile has it.
      const before = baseline?.get(path);
      if (before && !scenario.update.has(node.name) && inputsOf(node).every((p) => nodeAt(p).root || get(p) === baseline?.get(p))) return before;
      if (pinned.has(node.path)) {
        // An override pins the package whatever its parents declare: assume it stays as installed.
        return locked(node);
      }
      if (node.bundled && node.bundler) {
        // Ships inside its bundler's tarball: it only changes when the bundler does.
        const bundler = nodeAt(node.bundler);
        const b = get(node.bundler);
        if (b.unknown) return { versions: new Set(), unknown: true };
        if ([...b.versions].every((v) => v === bundler.version)) return locked(node);
        if ([...b.versions].every((v) => v !== bundler.version && metas.get(bundler.name)?.versions[v] && !declared(metas.get(bundler.name)?.versions[v] ?? {}, node.name))) {
          return { versions: new Set(), unknown: false };
        }
        return { versions: new Set(), unknown: true };
      }
      if (!node.in.length) return locked(node);
      const result: Resolution = { versions: new Set(), unknown: false };
      // npm update matches the folder name: an aliased copy is never updated by name.
      const updatable = keyOf(path) === node.name;
      const wantsUpdate = updatable && scenario.update.has(node.name);
      // The ranges every remaining dependent declares after the change.
      const specs: { spec: string; parentChanged: boolean }[] = [];
      for (const edge of node.in) {
        const parent = nodeAt(edge.from);
        const pr = get(edge.from);
        if (pr.unknown) result.unknown = true;
        for (const pv of pr.versions) {
          const parentChanged = pv !== parent.version;
          let spec: string | undefined = edge.spec;
          if (parentChanged) {
            const deps = metas.get(parent.name)?.versions[pv];
            if (!deps) {
              result.unknown = true;
              continue;
            }
            spec = declared(deps, edge.key);
            if (spec === undefined) continue; // the new parent no longer depends on it
          }
          if (!rangeOf(spec)) {
            // not a semver range (git, tag, file): only an unchanged parent says what it gets
            if (parentChanged) result.unknown = true;
            else specs.push({ spec: node.version, parentChanged });
            continue;
          }
          specs.push({ spec, parentChanged });
        }
      }
      const okAll = specs.every((s) => satisfies(node.version, s.spec));
      const update =
        wantsUpdate || (updatable && scenario.refreshChanged && !scenario.keep?.has(node.name) && specs.some((s) => s.parentChanged));
      if (!specs.length) {
        // gone (or unknown, set above)
      } else if (okAll && !update) {
        result.versions.add(node.version);
      } else {
        // npm looks for one version that satisfies every dependent; failing that, it nests copies.
        const together = isPublic(node) ? pickAll(node.name, specs.map((s) => s.spec)) : null;
        if (together) {
          result.versions.add(together);
          if (okAll && together !== node.version && !wantsUpdate) assumed.add(node.name);
        } else {
          for (const { spec } of specs) {
            const ok = satisfies(node.version, spec);
            const picked = ok && !update ? node.version : isPublic(node) ? pick(node.name, spec) : null;
            if (picked) result.versions.add(picked);
            else if (ok) result.versions.add(node.version);
            else result.unknown = true;
          }
        }
      }
      return result;
    };
    // Depth-first over the dependents, with an explicit stack: chains in a large lockfile are
    // deeper than the call stack allows.
    const resolve = (start: string): Resolution => {
      const quick = shortcut(start);
      if (quick) return quick;
      const stack: { path: string; inputs: string[]; next: number }[] = [];
      const enter = (path: string) => {
        visiting.add(path);
        stack.push({ path, inputs: inputsOf(nodeAt(path)), next: 0 });
      };
      enter(start);
      while (stack.length) {
        const frame = stack[stack.length - 1] as (typeof stack)[number];
        if (frame.next < frame.inputs.length) {
          const input = frame.inputs[frame.next++] as string;
          if (!shortcut(input) && !visiting.has(input)) enter(input);
          continue;
        }
        memo.set(frame.path, compute(frame.path));
        visiting.delete(frame.path);
        stack.pop();
      }
      return memo.get(start) as Resolution;
    };
    const outcome = (t: Target): Outcome => {
      const versions = new Set<string>();
      let unknown = false;
      for (const p of t.paths) {
        const r = resolve(p);
        unknown ||= r.unknown;
        for (const v of r.versions) versions.add(v);
      }
      return { versions: [...versions], unknown };
    };
    /**
     * Peer-dependency problems among the packages this scenario moves: a new version whose peer
     * the tree does not satisfy, or a peer that another package declares on it that the new
     * version does not satisfy. npm re-checks these edges for every package it moves.
     */
    const peerIssues = (): string[] => {
      const out: string[] = [];
      const versionsAt = (path: string) => {
        const change = scenario.changes.get(path);
        if (change !== undefined) return [change];
        return [...(memo.get(path)?.versions ?? [nodeAt(path).version])];
      };
      /** A peer edge into `path` that the tree (after this scenario) already fails, as text. */
      const contested = (path: string): string | undefined => {
        const node = nodeAt(path);
        const mine = versionsAt(path);
        for (const e of node.in) {
          if (!e.peer || nodeAt(e.from).root) continue;
          const q = nodeAt(e.from);
          for (const qv of versionsAt(e.from)) {
            const spec = qv === q.version ? e.spec : metas.get(q.name)?.peers?.[qv]?.[e.key];
            const range = spec === undefined ? null : peerRange(spec);
            if (range && mine.some((v) => isValidVersion(v) && !range.test(v))) {
              return `${q.name}@${qv} wants ${node.name}@${spec}, installed ${mine[0]}`;
            }
          }
        }
        return undefined;
      };
      for (const [path, res] of memo) {
        const node = nodeAt(path);
        for (const v of res.versions) {
          if (v === node.version) continue;
          for (const [peer, spec] of Object.entries(metas.get(node.name)?.peers?.[v] ?? {})) {
            const range = peerRange(spec);
            const at = range ? graph.locate(path, peer) : undefined;
            if (!range || at === undefined) continue;
            if (isOptionalPeer(node.name, v, peer) && !heldOutside(at, [path])) continue;
            const have = versionsAt(at).filter(isValidVersion);
            if (have.length && have.every((h) => !range.test(h))) out.push(`${node.name}@${v} needs ${peer}@${spec} (installed ${have[0]})`);
            // A peer that the tree already fails to satisfy for someone else: npm re-checks it
            // when a package that declares it moves, and often gives up (ERESOLVE).
            const broken = contested(at);
            if (broken) out.push(`${node.name}@${v} has peer ${peer}, which is already in conflict (${broken})`);
          }
          for (const e of node.in) {
            if (!e.peer) continue;
            const q = nodeAt(e.from);
            if (versionsAt(e.from).some((x) => x !== q.version)) continue;
            const range = peerRange(e.spec);
            if (range && isValidVersion(v) && !range.test(v)) out.push(`${q.name}@${q.version} wants ${node.name}@${e.spec}`);
          }
        }
      }
      return [...new Set(out)];
    };
    return { outcome, assumed, peerIssues, resolve };
  };
  {
    const lockfileAsIs = makeResolver({ changes: new Map(), update: new Set(), refreshChanged: false });
    const result = new Map<string, Resolution>();
    for (const node of graph.nodes.values()) if (!node.root) result.set(node.path, lockfileAsIs.resolve(node.path));
    unstable = [...result].filter(([path, r]) => r.unknown || r.versions.size !== 1 || !r.versions.has(nodeAt(path).version)).map(([path]) => path);
    baseline = result;
  }

  // OSV results for estimated versions, filled in rounds.
  const osvChecked = new Set<string>();
  const osvResults = new Map<string, Vulnerability[]>();
  let osvFailed = false;
  const checkOsv = async (refs: PackageRef[]) => {
    const todo = new Map<string, PackageRef>();
    for (const r of refs) {
      const key = `${r.name}@${r.version}`;
      if (!osvChecked.has(key)) todo.set(key, r);
    }
    if (!todo.size || osvFailed) return;
    try {
      const lookup = await queryVulnerabilities([...todo.values()], cache, net, records);
      for (const key of todo.keys()) osvChecked.add(key);
      for (const [key, result] of lookup.results) osvResults.set(key, result.vulnerabilities);
      for (const [id, record] of lookup.records) records.set(id, record);
    } catch (error) {
      osvFailed = true;
      warnings.push(
        `Upgrade plan: could not check the estimated versions against OSV (${sanitize((error as Error)?.message ?? error, 160)}); ` +
          `advisories that an upgrade would introduce may be missing.`,
      );
    }
  };
  const refsOf = (t: Target, o: Outcome): PackageRef[] =>
    o.versions.filter((v) => v !== t.version).map((version) => ({ name: t.name, version }));

  /** Splits a target's advisories into cleared and remaining for one outcome. */
  const judge = (t: Target, o: Outcome, useOsv: boolean) => {
    const current = t.id;
    const cleared: Vulnerability[] = [];
    const remaining: PlanAdvisory[] = [];
    if (o.unknown) {
      for (const v of t.finding.vulnerabilities) remaining.push({ id: v.id, severity: v.severity, package: current });
      return { cleared, remaining, unresolved: true };
    }
    if (!o.versions.length) return { cleared: [...t.finding.vulnerabilities], remaining, unresolved: false };
    const osvIds = (v: string) => new Set((osvResults.get(`${t.name}@${v}`) ?? []).map((x) => x.id));
    for (const vuln of t.finding.vulnerabilities) {
      const record = records.get(vuln.id);
      const hit = o.versions.find(
        (v) => v === t.version || !record || (useOsv && osvIds(v).has(vuln.id)) || isAffected(record, t.name, v),
      );
      if (hit === undefined) cleared.push(vuln);
      else remaining.push({ id: vuln.id, severity: vuln.severity, package: current, after: `${t.name}@${hit}` });
    }
    if (useOsv) {
      const known = new Set(t.finding.vulnerabilities.map((v) => v.id));
      for (const v of o.versions) {
        if (v === t.version) continue;
        for (const x of osvResults.get(`${t.name}@${v}`) ?? []) {
          if (known.has(x.id)) continue;
          known.add(x.id);
          remaining.push({ id: x.id, severity: x.severity, package: current, after: `${t.name}@${v}`, introduced: true });
        }
      }
    }
    return { cleared, remaining, unresolved: false };
  };

  // 4. Simulate each candidate version of each direct dependency.
  interface Candidate {
    version: string;
    breaking: boolean;
    outcomes: Outcome[];
    assumed: string[];
  }
  interface Planned {
    group: Group;
    candidates: Candidate[];
    reason?: string;
    capped?: boolean;
    /** The locations of the direct dependency an accepted install moves. */
    paths?: string[];
  }
  // Names, aliases and workspace folders are checked before anything is estimated: what npm would
  // not accept as it is never gets a command, so what it would move is not counted either.
  const refused = new Set<string>();
  const accepted = (x: Declaration) => {
    const ok = isValidNpmName(x.key) && isValidNpmName(nodeAt(x.path).name) && (!x.root || isPlainFolder(x.root));
    if (!ok) refused.add(sanitize(`${x.root ? `${x.root}: ` : ""}${x.key}`, 240));
    return ok;
  };
  const planned: Planned[] = [];
  for (const group of ordered) {
    const d = group.direct;
    if (d.external) {
      planned.push({ group, candidates: [], reason: "not from the public registry, so it was not looked up" });
      continue;
    }
    const movable = new Set((declarations.get(`${d.name}@${d.version}`) ?? []).filter(accepted).map((x) => x.path));
    if (!movable.size) {
      planned.push({ group, candidates: [], reason: REFUSED_REASON });
      continue;
    }
    const meta = metas.get(d.name);
    if (!meta) {
      const why = failures.get(d.name);
      planned.push({
        group,
        candidates: [],
        reason: capped.has(d.name) ? (why as string) : `registry data unavailable (${why ?? "not requested"})`,
        capped: capped.has(d.name),
      });
      continue;
    }
    if (!meta.versions[d.version]) {
      planned.push({ group, candidates: [], reason: `the registry does not list the installed version ${d.version}` });
      continue;
    }
    if (work > MAX_PLAN_WORK * CANDIDATE_WORK_SHARE) {
      overBudget.push(d.name);
      planned.push({ group, candidates: [], reason: WORK_LIMIT_REASON });
      continue;
    }
    const paths = group.paths.filter((p) => movable.has(p));
    planned.push({
      group,
      paths,
      candidates: candidatesFor(d, meta, infos.get(d.name)).map((version) => {
        const resolver = makeResolver({
          changes: new Map(paths.map((p) => [p, version])),
          update: new Set(),
          refreshChanged: true,
        });
        const outcomes = group.targets.map((t) => resolver.outcome(t));
        resolver.assumed.delete(d.name);
        return { version, breaking: crossesBreaking(d.version, version), outcomes, assumed: [...resolver.assumed].sort() };
      }),
    });
  }

  // 5. Ask OSV about every estimated version that differs from what is installed, so advisories
  //    that a new version brings in are counted, not missed.
  const round1: PackageRef[] = [];
  for (const p of planned) {
    for (const c of p.candidates) {
      p.group.targets.forEach((t, i) => round1.push(...refsOf(t, c.outcomes[i] as Outcome)));
      // The direct dependency itself, even when it is clean today.
      round1.push({ name: p.group.direct.name, version: c.version });
    }
  }
  await checkOsv(round1);

  // 6. Score the candidates and pick one per direct dependency.
  const evaluate = (group: Group, c: Candidate): Evaluation => {
    const remaining: PlanAdvisory[] = [];
    const cleared: Evaluation["cleared"] = [];
    const unresolved: string[] = [];
    group.targets.forEach((t, i) => {
      const verdict = judge(t, c.outcomes[i] as Outcome, true);
      if (verdict.unresolved) unresolved.push(t.id);
      for (const vuln of verdict.cleared) cleared.push({ target: t, vuln });
      remaining.push(...verdict.remaining);
    });
    // The direct dependency's own new version may carry advisories it does not have today.
    const directId = `${group.direct.name}@${group.direct.version}`;
    if (!group.targets.some((t) => t.id === directId)) {
      const after = `${group.direct.name}@${c.version}`;
      for (const v of osvResults.get(after) ?? []) {
        remaining.push({ id: v.id, severity: v.severity, package: directId, after, introduced: true });
      }
    }
    const score = remaining.reduce((sum, a) => sum + WEIGHT[a.severity], 0);
    return { version: c.version, breaking: c.breaking, remaining, cleared, alsoUpdate: c.assumed, unresolved, score };
  };
  const better = (a: Evaluation, b: Evaluation) =>
    a.score - b.score || b.cleared.length - a.cleared.length || compareVersions(a.version, b.version);
  /**
   * On a new breaking line, the newest release that does at least as well: the first release of
   * a new major is rarely the one to move to.
   */
  const newestOnLine = (e: Evaluation | undefined, list: Evaluation[]): Evaluation | undefined =>
    e &&
    (list
      .filter(
        (x) =>
          !crossesBreaking(e.version, x.version) &&
          x.score <= e.score &&
          x.cleared.length >= e.cleared.length &&
          x.unresolved.length <= e.unresolved.length,
      )
      .sort((a, b) => compareVersions(b.version, a.version))[0] ??
      e);

  const plan: PlanEntry[] = [];
  const chosenByEntry = new Map<PlanEntry, { group: Group; paths: string[]; evaluation: Evaluation }>();
  const unavailable: string[] = [];
  const cappedEntries: string[] = [];
  for (const p of planned) {
    const d = p.group.direct;
    const total = p.group.targets.reduce((n, t) => n + t.finding.vulnerabilities.length, 0);
    const decls = declarations.get(`${d.name}@${d.version}`) ?? [];
    const alias = decls.every((x) => sanitize(x.key, 214) !== d.name) && decls[0] ? sanitize(decls[0].key, 214) : undefined;
    const workspaces = [...new Set(decls.map((x) => sanitize(x.root, 200)).filter(Boolean))].sort();
    const base = {
      name: d.name,
      ...(alias ? { alias } : {}),
      ...(workspaces.length ? { workspaces } : {}),
      version: d.version,
      dev: d.dev,
      total,
      deprecated: infos.get(d.name)?.deprecated[d.version],
      estimated: true as const,
    };
    /** Packages still open because an override in package.json holds them where they are. */
    const heldByOverride = (remaining: PlanAdvisory[]) => {
      const names = [...new Set(p.group.targets.filter((t) => t.paths.some((x) => pinned.has(x)) && remaining.some((r) => r.package === t.id)).map((t) => t.name))];
      return names.length ? names.sort() : undefined;
    };
    const openToday = (): PlanAdvisory[] =>
      p.group.targets.flatMap((t) => t.finding.vulnerabilities.map((v) => ({ id: v.id, severity: v.severity, package: t.id })));
    if (p.reason) {
      if (p.reason !== WORK_LIMIT_REASON && p.reason !== REFUSED_REASON) (p.capped ? cappedEntries : unavailable).push(d.name);
      plan.push({ ...base, status: "unavailable", reason: p.reason, clears: { count: 0, packages: [] }, remaining: openToday() });
      continue;
    }
    const evaluations = p.candidates.map((c) => evaluate(p.group, c));
    const helpful = evaluations.filter((e) => e.cleared.length > 0);
    const full = (list: Evaluation[]) =>
      list.filter((e) => e.remaining.length === 0).sort((a, b) => compareVersions(a.version, b.version))[0];
    const best = (list: Evaluation[]) => [...list].sort(better)[0];
    const nonBreaking = helpful.filter((e) => !e.breaking);
    const breaking = helpful.filter((e) => e.breaking);
    const chosen =
      full(nonBreaking) ?? best(nonBreaking) ?? newestOnLine(full(breaking), breaking) ?? newestOnLine(best(breaking), breaking);
    if (!chosen) {
      // Targets whose new version could not be worked out for any candidate.
      const unresolved = p.group.targets.filter(
        (t, i) => p.candidates.length > 0 && p.candidates.every((c) => c.outcomes[i]?.unknown),
      );
      if (unresolved.length && unresolved.length === p.group.targets.length) {
        unavailable.push(d.name);
        plan.push({
          ...base,
          status: "unavailable",
          reason:
            "could not follow the chain to the vulnerable packages (a package on it is not from the public registry, " +
            "or its registry data is missing)",
          clears: { count: 0, packages: [] },
          remaining: openToday(),
          unresolved: unresolved.map((t) => t.id),
        });
        continue;
      }
      const reason = p.candidates.length
        ? `none of the ${p.candidates.length} newer releases tried clears any`
        : "no newer non-deprecated release";
      plan.push({
        ...base,
        status: "no-fix",
        reason,
        clears: { count: 0, packages: [] },
        remaining: openToday(),
        unresolved: unresolved.length ? unresolved.map((t) => t.id) : undefined,
        heldByOverride: heldByOverride(openToday()),
      });
      continue;
    }
    const alternative = chosen.remaining.length && !chosen.breaking ? newestOnLine(full(breaking), breaking) : undefined;
    const clearedPackages = p.group.targets.filter((t) => chosen.cleared.some((c) => c.target === t)).map((t) => t.id);
    const entry: PlanEntry = {
      ...base,
      status: "upgrade",
      target: sanitize(chosen.version, 100),
      breaking: chosen.breaking,
      clears: {
        count: chosen.cleared.length,
        packages: clearedPackages,
        worst: worstOf(chosen.cleared.map((c) => c.vuln.severity)),
      },
      remaining: chosen.remaining.map((a) => ({ ...a, after: a.after && sanitize(a.after, 320) })),
      breakingAlternative: alternative ? sanitize(alternative.version, 100) : undefined,
      alsoUpdate: chosen.alsoUpdate.length ? chosen.alsoUpdate : undefined,
      unresolved: chosen.unresolved.length ? chosen.unresolved : undefined,
      heldByOverride: heldByOverride(chosen.remaining),
    };
    plan.push(entry);
    chosenByEntry.set(entry, { group: p.group, paths: p.paths ?? [], evaluation: chosen });
  }
  if (unavailable.length) {
    warnings.push(
      `Upgrade plan unavailable for ${unavailable.slice(0, 3).join(", ")}${unavailable.length > 3 ? ", ..." : ""}: ` +
        `the data needed for an estimate could not be read, so no upgrade is suggested (the reason is in the plan).`,
    );
  }

  // 7. Commands. Upgrades of one scope at one version move together (lockstep families such as
  //    @angular/*); peer dependencies of each step are checked against the installed tree. Every
  //    install is per declaration (root or workspace, and the key it is declared under), never per
  //    package name: an alias and the real name, or two workspaces, are different installs.
  const upgrades = plan.filter((e) => e.status === "upgrade" && e.target);
  const installsOf = (id: string, version: string): Install[] => {
    const byDecl = new Map<string, Install>();
    for (const d of (declarations.get(id) ?? []).filter(accepted)) {
      const key = `${d.root}\u0000${d.key}`;
      const known = byDecl.get(key);
      if (known) known.paths.push(d.path);
      else byDecl.set(key, { root: d.root, key: d.key, name: nodeAt(d.path).name, version, paths: [d.path], peer: d.peer });
    }
    return [...byDecl.values()];
  };
  interface Unit {
    entries: PlanEntry[];
    installs: Install[];
    breaking: boolean;
  }
  const units: Unit[] = [];
  for (const e of upgrades) {
    const scope = scopeOf(e.name);
    const unit = scope
      ? units.find((u) => {
          const first = u.entries[0] as PlanEntry;
          return scopeOf(first.name) === scope && first.version === e.version && first.target === e.target;
        })
      : undefined;
    const installs = installsOf(`${e.name}@${e.version}`, e.target as string);
    if (unit) {
      unit.entries.push(e);
      unit.installs.push(...installs);
      unit.breaking ||= Boolean(e.breaking);
    } else units.push({ entries: [e], installs, breaking: Boolean(e.breaking) });
  }
  const plannedIds = new Set(upgrades.map((e) => `${e.name}@${e.version}`));
  for (const u of units) {
    const first = u.entries[0] as PlanEntry;
    const scope = scopeOf(first.name);
    if (!scope) continue;
    for (const [id, paths] of directPaths) {
      const node = nodeAt(paths[0] as string);
      if (scopeOf(node.name) !== scope || node.version !== first.version || plannedIds.has(id) || !isPublic(node)) continue;
      if (u.installs.some((i) => i.name === node.name)) continue;
      // Only when that version exists for it, read without extra requests.
      if (metas.get(node.name)?.versions[first.target as string]) u.installs.push(...installsOf(id, first.target as string));
    }
  }

  // 7b. Peers npm checks for a new version although they are not installed (optional ones too).
  //     For `npm install x@v` npm loads the whole peer set of x@v into a copy of the root (arborist
  //     #loadPeerSet): each peer at the newest release the root's range allows, or, when the root
  //     does not declare it, the peer range. A peer that is not installed has no copy to keep, so
  //     its own peers are placed against the tree. When one of them needs another version than the
  //     installed copy, and a direct dependency outside that peer set holds the copy at a range no
  //     new version meets, npm stops with ERESOLVE (bitwarden: build-angular 14.2.11 -> optional
  //     @angular/localize 14.3.0 -> @angular/compiler 14.3.0, held at 14.1.0 by
  //     platform-browser-dynamic 14.1.0). Only that case is claimed; whatever is not known (a
  //     document not read, an override, a workspace, an alias) leaves the plan as it was.
  const rootNode = graph.nodes.get("");
  const rootSpec = new Map<string, string>();
  const rootDirect = new Set<string>();
  if (rootNode?.root) {
    for (const e of rootNode.out) {
      if (nodeAt(e.to).name !== e.key) continue;
      rootSpec.set(e.key, e.spec);
      rootDirect.add(e.to);
    }
  }
  const overridden = new Set(overrides.map((r) => r.name));
  const peerDocs = new Map<string, PackageDeps>();
  const docOf = (name: string) => metas.get(name) ?? peerDocs.get(name);
  /** Per `name@version`: the names that may be in its peer set, and the releases npm may load each at; null when not known. */
  const peerSets = new Map<string, { names: Set<string>; versions: Map<string, Set<string>> } | null>();
  let hiddenRequests = 0;
  let hiddenCut = false;
  {
    const loads = new Map<string, Promise<PackageDeps | undefined>>();
    const refuse = () => {
      if (requests >= MAX_PLAN_REQUESTS || hiddenRequests >= MAX_HIDDEN_PEER_REQUESTS) throw new CapReached();
      requests++;
      hiddenRequests++;
    };
    const load = async (name: string): Promise<PackageDeps | undefined> => {
      const known = docOf(name);
      if (known) return known;
      if (!isValidNpmName(name)) return undefined;
      // A name the lockfile has from elsewhere than the public registry is never asked for.
      const installed = pathsNamed.get(name) ?? [];
      if (installed.some((p) => !isPublic(nodeAt(p)))) return undefined;
      try {
        let deps: PackageDeps | undefined;
        if (installed.length) {
          deps = (await fetchPackageDeps(name, cache, net, fresh.get(name), refuse)).deps ?? undefined;
        } else {
          // Not installed: the registry's data of a public package names it. Deprecations decide
          // which release npm takes, so they are read from the same document.
          const info = await fetchPackageInfo(name, cache, net, (d) => (deps = d), refuse);
          if (info) extraInfos.set(name, info);
          deps ??= (await fetchPackageDeps(name, cache, net, undefined, refuse)).deps ?? undefined;
        }
        if (deps) peerDocs.set(name, deps);
        return deps;
      } catch (error) {
        if (error instanceof CapReached) hiddenCut = true;
        return undefined;
      }
    };
    const docFor = (name: string) => {
      let p = loads.get(name);
      if (!p) loads.set(name, (p = load(name)));
      return p;
    };
    // npm loads one release per peer edge: the newest the edge allows, kept only when the root's
    // range (if the root declares the name) allows it too, else the newest the root's range allows.
    // Every release some edge of the set can lead to is collected, so a version is "possible" here
    // whenever npm may take it. The names also take in the peers of every release in those ranges:
    // a name that may be in the set is never counted as holding a copy back.
    const loadPeerSet = async (name: string, version: string) => {
      const versions = new Map<string, Set<string>>([[name, new Set([version])]]);
      const names = new Set<string>([name]);
      const work: [string, string][] = [[name, version]];
      while (work.length) {
        const [n, v] = work.pop() as [string, string];
        const doc = await docFor(n);
        if (!doc?.versions[v]) return null;
        for (const [peer, spec] of Object.entries(doc.peers?.[v] ?? {})) {
          names.add(peer);
          const peerDoc = await docFor(peer);
          if (!peerDoc) return null;
          const rs = rootSpec.get(peer);
          const rootRange = rs === undefined ? undefined : rangeOf(rs);
          const picked = pickIn(peerDoc, peer, spec);
          const options: (string | null)[] = [];
          if (rs === undefined) options.push(picked);
          else {
            if (!rootRange) return null;
            options.push(pickIn(peerDoc, peer, rs));
            if (picked && rootRange.test(picked)) options.push(picked);
          }
          for (const option of options) {
            if (!option) return null;
            const known = versions.get(peer) ?? new Set<string>();
            versions.set(peer, known);
            if (known.has(option)) continue;
            known.add(option);
            work.push([peer, option]);
          }
          const range = peerRange(spec);
          for (const [w, peers] of Object.entries(peerDoc.peers ?? {})) {
            if (isValidVersion(w) && range?.test(w)) for (const other of Object.keys(peers)) names.add(other);
          }
          if (names.size > MAX_PEER_SET) return null;
        }
      }
      return { names, versions };
    };
    // Only what can go into the safe step: the other commands are separate already.
    const checked = new Map<string, { install: Install; hidden: [string, string][] }>();
    for (const u of units) {
      if (u.breaking || u.installs.some((i) => i.peer)) continue;
      for (const i of u.installs) {
        const id = `${i.name}@${i.version}`;
        const at = `${MARKER}${i.name}`;
        if (checked.has(id) || i.root !== "" || i.key !== i.name || !i.paths.includes(at)) continue;
        const hidden = Object.entries(metas.get(i.name)?.peers?.[i.version] ?? {}).filter(
          ([p]) => graph.locate(at, p) === undefined && !rootSpec.has(p) && !overridden.has(p),
        );
        if (hidden.length) checked.set(id, { install: i, hidden });
      }
    }
    // Their documents first, in parallel; then a quick test that needs no more than those (a
    // necessary condition of the full one below), and the whole peer set only where it passes.
    await mapLimit([...new Set([...checked.values()].flatMap((c) => c.hidden.map(([p]) => p)))], 8, docFor);
    const mayConflict = async (peer: string, spec: string): Promise<boolean> => {
      const doc = docOf(peer);
      const version = doc ? pickIn(doc, peer, spec) : null;
      if (!doc || !version) return false;
      for (const [q, s] of Object.entries(doc.peers?.[version] ?? {})) {
        if (doc.optionalPeers?.[version]?.includes(q)) continue;
        const at = `${MARKER}${q}`;
        const node = graph.nodes.get(at);
        const rs = rootSpec.get(q);
        const range = peerRange(s);
        if (!node || !range || rs === undefined || !rootDirect.has(at) || !isValidVersion(node.version) || range.test(node.version)) continue;
        const qDoc = await docFor(q);
        const picked = qDoc ? pickIn(qDoc, q, s) : null;
        const versions = [qDoc ? pickIn(qDoc, q, rs) : null, picked && rangeOf(rs)?.test(picked) ? picked : null].filter((v): v is string => v !== null);
        if (!versions.length || versions.includes(node.version)) continue;
        const holds = node.in.some((e) => {
          const held = e.peer && rootDirect.has(e.from) ? peerRange(e.spec) : null;
          return held && versions.every((v) => !held.test(v));
        });
        if (holds) return true;
      }
      return false;
    };
    for (const [id, { install, hidden }] of checked) {
      let worth = false;
      for (const [p, spec] of hidden) if ((worth = await mayConflict(p, spec))) break;
      if (worth) peerSets.set(id, await loadPeerSet(install.name, install.version));
    }
  }
  if (hiddenCut) {
    warnings.push(
      `Upgrade plan: request limit reached while reading peers that are not installed; some likely peer conflicts may not be shown. ` +
        (cache.enabled ? "Rerun to continue: what was read so far is cached." : "Rerun without --no-cache to continue."),
    );
  }
  const below = (path: string): Set<string> => {
    const seen = new Set<string>();
    const stack = nodeAt(path).out.map((e) => e.to);
    while (stack.length) {
      const p = stack.pop() as string;
      if (seen.has(p) || nodeAt(p).root) continue;
      seen.add(p);
      for (const e of nodeAt(p).out) stack.push(e.to);
    }
    return seen;
  };
  const hiddenPeerConflicts = (install: Install, moved: Map<string, string>): string[] => {
    const set = peerSets.get(`${install.name}@${install.version}`);
    if (!set) return [];
    const self = `${MARKER}${install.name}`;
    /** Why `peer@version` cannot be placed: a peer of it that the tree holds back, as text. */
    const heldBack = (peer: string, version: string): string | undefined => {
      const doc = docOf(peer);
      for (const [q, spec] of Object.entries(doc?.peers?.[version] ?? {})) {
        if (doc?.optionalPeers?.[version]?.includes(q)) continue;
        const range = peerRange(spec);
        const at = `${MARKER}${q}`;
        const node = graph.nodes.get(at);
        if (!range || !node || node.root || node.bundled || node.name !== q || !isPublic(node)) continue;
        if (moved.has(at) || overridden.has(q) || !isValidVersion(node.version) || range.test(node.version)) continue;
        // The root's own copy (npm keeps it when its range takes the installed version only).
        const rs = rootSpec.get(q);
        if (rs === undefined || !rootDirect.has(at) || !peerRange(rs)?.test(node.version)) continue;
        const versions = [...(set.versions.get(q) ?? [])];
        if (!versions.length || versions.includes(node.version)) continue;
        const inside = below(at);
        for (const e of node.in) {
          const f = nodeAt(e.from);
          // A peer edge of a direct dependency at the top that this step does not move, outside
          // the peer set (npm replaces peers of one set together), not below the held copy itself.
          // (A plain dependency edge holds the copy too, by arborist's code, but that is not
          // checked against npm yet, so it is not claimed.)
          if (!e.peer || f.root || f.path === self || !rootDirect.has(f.path) || moved.has(f.path) || inside.has(f.path)) continue;
          if (set.names.has(f.name)) continue;
          const held = peerRange(e.spec);
          if (held && versions.every((v) => !held.test(v))) {
            return `${peer}@${version}, which needs ${q}@${spec} (installed ${node.version}, held at ${e.spec} by ${f.name}@${f.version})`;
          }
        }
      }
      return undefined;
    };
    const out: string[] = [];
    for (const peer of Object.keys(docOf(install.name)?.peers?.[install.version] ?? {})) {
      if (graph.locate(self, peer) !== undefined || rootSpec.has(peer) || overridden.has(peer)) continue;
      const versions = [...(set.versions.get(peer) ?? [])];
      if (!versions.length) continue;
      // Every release npm may take for it has to fail, or nothing is claimed.
      const reasons = versions.map((v) => heldBack(peer, v));
      if (reasons.every((r) => r !== undefined)) {
        out.push(`${install.name}@${install.version} has peer ${peer}, which is not installed: npm still checks ${reasons[0]}`);
      }
    }
    return out;
  };

  const movedBy = (installs: Install[]) => {
    const moved = new Map<string, string>();
    for (const i of installs) for (const p of i.paths) moved.set(p, i.version);
    return moved;
  };
  const conflictsOf = (installs: Install[], context: Install[]): string[] => {
    const out: string[] = [];
    const moved = movedBy([...context, ...installs]);
    for (const install of installs) {
      const { name, version, paths } = install;
      // Peers the new version asks for, against what is installed (or moves in the same step).
      for (const [peer, spec] of Object.entries(metas.get(name)?.peers?.[version] ?? {})) {
        const range = peerRange(spec);
        if (!range) continue;
        const at = graph.locate(paths[0] ?? "", peer);
        if (at === undefined) continue; // not installed: npm adds it (its own peers: below)
        if (isOptionalPeer(name, version, peer) && !heldOutside(at, paths)) continue;
        const have = moved.get(at) ?? nodeAt(at).version;
        if (isValidVersion(have) && !range.test(have)) out.push(`${name}@${version} needs ${peer}@${spec} (installed ${have})`);
      }
      // Direct dependencies that declare this package as a peer.
      for (const p of paths) {
        for (const e of nodeAt(p).in) {
          if (!e.peer) continue;
          const q = nodeAt(e.from);
          if (q.root || q.name === name || !directSet.has(q.path)) continue;
          const qVersion = moved.get(q.path) ?? q.version;
          const spec = qVersion === q.version ? e.spec : metas.get(q.name)?.peers?.[qVersion]?.[e.key];
          const range = spec === undefined ? null : peerRange(spec);
          if (!range || range.test(version)) continue;
          out.push(`${q.name}@${qVersion} wants ${name}@${spec}`);
        }
      }
      out.push(...hiddenPeerConflicts(install, moved));
    }
    return [...new Set(out)].sort();
  };
  // Every non-breaking unit, checked together (one may fix another's peer); drop what conflicts.
  // A package that is only a peerDependency of the project gets its own command: npm install
  // rewrites its range in package.json, which the project's users then have to meet.
  let safe = units.filter((u) => !u.breaking && !u.installs.some((i) => i.peer));
  const dropped = new Map<Unit, string[]>();
  for (let round = 0; round < 5; round++) {
    const context = safe.flatMap((u) => u.installs);
    const next = safe.filter((u) => {
      const conflicts = conflictsOf(u.installs, context);
      if (conflicts.length) dropped.set(u, conflicts);
      return !conflicts.length;
    });
    if (next.length === safe.length) break;
    safe = next;
  }
  const safeInstalls = safe.flatMap((u) => u.installs);
  for (const u of units) {
    if (safe.includes(u)) continue;
    const found = conflictsOf(u.installs, safeInstalls);
    const conflicts = found.length ? found : (dropped.get(u) ?? []);
    if (conflicts.length) for (const e of u.entries) e.peerConflicts = conflicts;
  }

  // 8. The safe step as a whole, then in-range refreshes for what it leaves open.
  const safeChanges = movedBy(safeInstalls);
  const installedNames = new Set(safeInstalls.flatMap((i) => [i.name, i.key]));
  const safeUpdate = new Set(safe.flatMap((u) => u.entries.flatMap((e) => e.alsoUpdate ?? [])));
  const refreshNames = new Set<string>();
  // npm update matches the folder name, so an aliased copy cannot be named in it.
  const canUpdate = (n: GraphNode) => isPublic(n) && !n.bundled && !pinned.has(n.path) && keyOf(n.path) === n.name;
  const scenarioWith = (update: Set<string>): Scenario => ({ changes: safeChanges, update, refreshChanged: false });
  const allUpdate = () => new Set([...safeUpdate, ...refreshNames]);
  {
    for (const t of byPriority) {
      if (t.bundled) continue;
      if (work > MAX_PLAN_WORK) {
        refreshCut = true;
        break;
      }
      const start = judge(t, makeResolver(scenarioWith(allUpdate())).outcome(t), false);
      if (!start.remaining.length || start.unresolved) continue;
      let bestNames: Set<string> | undefined;
      let bestCleared = 0;
      const names = new Set<string>();
      let frontier = t.paths.map(nodeAt).filter(canUpdate);
      const seen = new Set(frontier.map((n) => n.path));
      for (let level = 0; level <= MAX_REFRESH_LEVELS && frontier.length; level++) {
        for (const n of frontier) names.add(n.name);
        const trial = makeResolver(scenarioWith(new Set([...allUpdate(), ...names])));
        const verdict = judge(t, trial.outcome(t), false);
        if (!verdict.unresolved && verdict.cleared.length > bestCleared) {
          bestCleared = verdict.cleared.length;
          bestNames = new Set(names);
          if (!verdict.remaining.length) break;
        }
        const next: GraphNode[] = [];
        for (const n of frontier) {
          for (const e of n.in) {
            const parent = nodeAt(e.from);
            if (seen.has(parent.path) || !canUpdate(parent)) continue;
            seen.add(parent.path);
            next.push(parent);
          }
        }
        frontier = next;
      }
      if (!bestNames) continue;
      // Keep only the names that matter: a parent added at one level may not be the one in the way.
      const already = allUpdate();
      const extra = [...bestNames].filter((n) => !already.has(n));
      if (extra.length <= 25) {
        for (const name of extra) {
          const without = new Set([...already, ...bestNames].filter((n) => n !== name));
          const verdict = judge(t, makeResolver(scenarioWith(without)).outcome(t), false);
          if (!verdict.unresolved && verdict.cleared.length >= bestCleared) bestNames.delete(name);
        }
      }
      for (const name of bestNames) if (!installedNames.has(name)) refreshNames.add(name);
    }
  }
  for (const name of safeUpdate) refreshNames.delete(name);

  // Leave out of `npm update` what would move a package onto a peer dependency the tree does not
  // satisfy: npm re-checks those edges and refuses (ERESOLVE), and the whole update fails.
  const held: string[] = [];
  const heldNames = new Set<string>();
  {
    const resolveAll = (update: Set<string>) => {
      const r = makeResolver(scenarioWith(update));
      for (const t of targets) r.outcome(t);
      return r.peerIssues();
    };
    const baseline = new Set(resolveAll(new Set()));
    for (const name of [...allUpdate()].sort()) {
      // Past the limit a name cannot be checked any more, so it is not suggested at all.
      if (work > MAX_PLAN_WORK * HELD_WORK_SHARE) {
        refreshCut = true;
        uncheckedUpdates.push(name);
        safeUpdate.delete(name);
        refreshNames.delete(name);
        continue;
      }
      const issues = resolveAll(new Set([name])).filter((x) => !baseline.has(x));
      if (!issues.length) continue;
      safeUpdate.delete(name);
      refreshNames.delete(name);
      held.push(`${name}: ${issues[0]}`);
      heldNames.add(name);
    }
  }

  // What the commands leave out of `npm update` (held back, unchecked, not a name npm accepts) is
  // not assumed for the entries that wanted it either: they are estimated again with those names
  // kept where they are, so "clears N" and "covered by" only count what the commands run. The
  // target stays the one chosen; the names stay in `alsoUpdate`, and the command says why.
  {
    const redo: { entry: PlanEntry; keep: string[]; candidate: Candidate }[] = [];
    for (const [entry, chosen] of chosenByEntry) {
      const inSafe = safe.some((u) => u.entries.includes(entry));
      const keep = (entry.alsoUpdate ?? []).filter(
        (n) => heldNames.has(n) || (inSafe && uncheckedUpdates.includes(n)) || !isValidNpmName(n),
      );
      if (!keep.length) continue;
      const { group, evaluation } = chosen;
      const resolver = makeResolver({
        changes: new Map(chosen.paths.map((p) => [p, evaluation.version])),
        update: new Set(),
        refreshChanged: true,
        keep: new Set(keep),
      });
      const outcomes = group.targets.map((t) => resolver.outcome(t));
      resolver.assumed.delete(group.direct.name);
      redo.push({ entry, keep, candidate: { version: evaluation.version, breaking: evaluation.breaking, outcomes, assumed: [...resolver.assumed] } });
    }
    await checkOsv(
      redo.flatMap(({ entry, candidate }) => {
        const { group } = chosenByEntry.get(entry) as { group: Group };
        return group.targets.flatMap((t, i) => refsOf(t, candidate.outcomes[i] as Outcome));
      }),
    );
    for (const { entry, keep, candidate } of redo) {
      const chosen = chosenByEntry.get(entry) as { group: Group; paths: string[]; evaluation: Evaluation };
      const evaluation = evaluate(chosen.group, candidate);
      const held = chosen.group.targets.filter((t) => t.paths.some((x) => pinned.has(x)) && evaluation.remaining.some((r) => r.package === t.id));
      entry.clears = {
        count: evaluation.cleared.length,
        packages: chosen.group.targets.filter((t) => evaluation.cleared.some((c) => c.target === t)).map((t) => t.id),
        worst: worstOf(evaluation.cleared.map((c) => c.vuln.severity)),
      };
      entry.remaining = evaluation.remaining.map((a) => ({ ...a, after: a.after && sanitize(a.after, 320) }));
      entry.unresolved = evaluation.unresolved.length ? evaluation.unresolved : undefined;
      entry.heldByOverride = held.length ? [...new Set(held.map((t) => t.name))].sort() : undefined;
      entry.alsoUpdate = [...new Set([...evaluation.alsoUpdate, ...keep])].sort();
      chosenByEntry.set(entry, { ...chosen, evaluation });
    }
  }

  // A direct dependency whose peer the tree already fails makes every `npm update` stop with
  // ERESOLVE (npm re-checks the root's edges), even for unrelated names, and so does `npm install`.
  // Keyed by the peer edge, so that a later step can tell a conflict it inherits from one it starts.
  // A root override of the peer's name replaces the peer range for npm (bitwarden:
  // `"tailwindcss": "$tailwindcss"`): that range is checked instead, but only for a name with one
  // plain top-level rule; anything else is checked against the peer range, as before.
  const overrideSpec = new Map<string, string>();
  {
    const ruleCount = new Map<string, number>();
    for (const rule of overrides) ruleCount.set(rule.name, (ruleCount.get(rule.name) ?? 0) + 1);
    for (const rule of overrides) {
      if (rule.spec !== undefined && !rule.under.length && ruleCount.get(rule.name) === 1 && peerRange(rule.spec)) {
        overrideSpec.set(rule.name, rule.spec);
      }
    }
  }
  const brokenPeers = (changes: Map<string, string>): Map<string, string> => {
    const out = new Map<string, string>();
    for (const node of graph.nodes.values()) {
      if (!node.root) continue;
      for (const e of node.out) {
        const d = nodeAt(e.to);
        if (d.root) continue;
        for (const p of d.out) {
          if (!p.peer) continue;
          const target = nodeAt(p.to);
          // The step itself may move either side.
          const dVersion = changes.get(d.path) ?? d.version;
          const spec = dVersion === d.version ? p.spec : metas.get(d.name)?.peers?.[dVersion]?.[p.key];
          const have = changes.get(target.path) ?? target.version;
          const r = spec === undefined ? null : peerRange(spec);
          // npm ignores overrides for bundled copies (Edge#satisfiedBy).
          const forced = target.bundled ? undefined : overrideSpec.get(target.name);
          if (forced !== undefined && isValidVersion(have) && peerRange(forced)?.test(have)) continue;
          if (r && isValidVersion(have) && !r.test(have)) {
            out.set(`${d.path}\u0000${p.key}`, `${d.name}@${dVersion} wants ${target.name}@${spec}, installed ${have}`);
          }
        }
      }
    }
    return out;
  };
  const existingConflicts = [...brokenPeers(safeChanges).values()];
  // --legacy-peer-deps gets past that, but it also drops every package installed only as a peer
  // (npm 11: `npm update ms --legacy-peer-deps` removes react next to react-dom). Then the step is
  // left to the user, after resolving the conflict by hand.
  const peerOnly = [...new Set([...graph.nodes.values()].filter((n) => n.peer && !n.root).map((n) => n.name))].sort();

  const combined = makeResolver(scenarioWith(allUpdate()));
  const combinedOutcomes = new Map(targets.map((t) => [t, combined.outcome(t)]));
  await checkOsv(targets.flatMap((t) => refsOf(t, combinedOutcomes.get(t) as Outcome)));
  const total = targets.reduce((n, t) => n + t.finding.vulnerabilities.length, 0);
  const verdicts = new Map(targets.map((t) => [t, judge(t, combinedOutcomes.get(t) as Outcome, true)]));
  const clearedBy = (list: Target[]) => list.flatMap((t) => (verdicts.get(t)?.cleared ?? []).map((v) => ({ t, v })));
  const safeCleared = clearedBy(targets);
  // What the upgrades in the safe step clear on their own; the rest is the refresh's doing.
  const byUpgrade = new Set<string>();
  for (const [entry, { evaluation }] of chosenByEntry) {
    if (!safe.some((u) => u.entries.includes(entry))) continue;
    for (const c of evaluation.cleared) byUpgrade.add(`${c.target.id}\u0000${c.vuln.id}`);
  }
  const refreshCleared = safeCleared.filter(({ t, v }) => !byUpgrade.has(`${t.id}\u0000${v.id}`));
  let refresh: PlanRefresh | undefined;
  if (refreshNames.size && refreshCleared.length) {
    refresh = {
      update: [...refreshNames].sort(),
      clears: {
        count: refreshCleared.length,
        packages: [...new Set(refreshCleared.map(({ t }) => t.id))],
        worst: worstOf(refreshCleared.map(({ v }) => v.severity)),
      },
      covered: [...new Set(refreshCleared.map(({ t }) => t))]
        .filter((t) => !verdicts.get(t)?.remaining.some((a) => !a.introduced))
        .map((t) => t.id),
    };
    for (const entry of plan) {
      const g = ordered.find((x) => x.direct.name === entry.name && x.direct.version === entry.version);
      if (!g) continue;
      const n = refreshCleared.filter(({ t }) => g.targets.includes(t)).length;
      if (n) entry.refreshClears = n;
    }
  } else refreshNames.clear();

  if (overBudget.length || refreshCut) {
    warnings.push(
      `Upgrade plan: work limit reached on this large dependency tree (${MAX_PLAN_WORK} install locations simulated)` +
        (overBudget.length ? `; ${overBudget.length} direct ${overBudget.length === 1 ? "dependency was" : "dependencies were"} not estimated (${overBudget.slice(0, 3).join(", ")}${overBudget.length > 3 ? ", ..." : ""})` : "") +
        (refreshCut ? `; the in-range npm update search stopped early${uncheckedUpdates.length ? ` and left out ${uncheckedUpdates.length} unchecked name${uncheckedUpdates.length === 1 ? "" : "s"}` : ""}` : "") +
        ". The rest of the plan stands; update what it lists, then scan again.",
    );
  }
  // Last line of defence for what gets pasted into a shell: names, aliases, versions and workspace
  // folders are checked once more, and anything odd is left out (and said so).
  const argsOf = (installs: Install[]): Pick<PlanCommand, "install" | "workspaceInstall"> => {
    const install: string[] = [];
    const workspaceInstall: Record<string, string[]> = {};
    for (const i of installs) {
      if (!isValidNpmName(i.key) || !isValidNpmName(i.name) || !isValidVersion(i.version) || (i.root && !isPlainFolder(i.root))) {
        refused.add(sanitize(`${i.root ? `${i.root}: ` : ""}${i.key}`, 240));
        continue;
      }
      const list = i.root ? (workspaceInstall[i.root] ??= []) : install;
      if (!list.includes(argOf(i))) list.push(argOf(i));
    }
    const folders = Object.keys(workspaceInstall).sort();
    return { install, workspaceInstall: folders.length ? Object.fromEntries(folders.map((f) => [f, workspaceInstall[f] as string[]])) : undefined };
  };
  const label = (e: PlanEntry) => e.alias ?? e.name;
  const peerRangeOf = (u: Unit) => {
    const names = [...new Set(u.installs.filter((i) => i.peer).map((i) => i.key))].sort();
    return names.length ? names : undefined;
  };

  const commands: PlanCommand[] = [];
  const acceptedName = (name: string) => {
    if (!isValidNpmName(name)) refused.add(sanitize(name, 240));
    return isValidNpmName(name);
  };
  const updateList = [...allUpdate()].filter((n) => !installedNames.has(n) && acceptedName(n)).sort();
  if (safeInstalls.length || updateList.length || held.length) {
    const args = argsOf(safeInstalls);
    const runs = args.install.length > 0 || Boolean(args.workspaceInstall) || updateList.length > 0;
    const conflicts = runs && existingConflicts.length ? [...new Set(existingConflicts)].sort() : undefined;
    const blocked = conflicts && peerOnly.length > 0;
    commands.push({
      kind: "safe",
      ...(blocked ? { install: [] } : args),
      update: blocked ? [] : updateList,
      entries: safe.flatMap((u) => u.entries.map(label)),
      held: held.length ? held : undefined,
      existingConflicts: conflicts,
      legacyPeerDeps: conflicts && !blocked ? true : undefined,
      blocked: blocked ? { ...args, update: updateList } : undefined,
      peerOnly: blocked ? peerOnly : undefined,
      clears: {
        count: safeCleared.length,
        total,
        packages: [...new Set(safeCleared.map(({ t }) => t.id))],
        worst: worstOf(safeCleared.map(({ v }) => v.severity)),
      },
    });
  }
  // A name held back from the safe step's `npm update` would stop a later command's update the
  // same way (the peer it needs is still not there): it is left out there too, and said so.
  const alsoUpdateOf = (u: Unit) => [...new Set(u.entries.flatMap((e) => e.alsoUpdate ?? []))].sort();
  const heldOf = (u: Unit) => {
    const names = new Set(alsoUpdateOf(u));
    const list = held.filter((h) => names.has(h.slice(0, h.indexOf(": "))));
    return list.length ? list : undefined;
  };
  const separate: { command: PlanCommand; unit: Unit }[] = [];
  for (const u of units) {
    if (safe.includes(u)) continue;
    const conflicts = u.entries[0]?.peerConflicts;
    const peerRange = peerRangeOf(u);
    separate.push({
      unit: u,
      command: {
        kind: u.breaking ? "breaking" : conflicts?.length ? "conflict" : peerRange ? "peer" : "conflict",
        ...argsOf(u.installs),
        update: alsoUpdateOf(u).filter((n) => !heldNames.has(n) && acceptedName(n)),
        entries: u.entries.map(label),
        held: heldOf(u),
        conflicts: conflicts?.length ? conflicts : undefined,
        peerRange,
      },
    });
  }
  if (refused.size) {
    warnings.push(
      `Upgrade plan: left out of the commands because a name, alias or workspace folder is not one npm accepts as it is: ` +
        `${[...refused].slice(0, 3).join(", ")}${refused.size > 3 ? ", ..." : ""}.`,
    );
  }

  const statusRank = { upgrade: 0, "no-fix": 1, unavailable: 2 };
  const worstRemaining = (e: PlanEntry) => worstOf(e.remaining.map((a) => a.severity)) ?? "unknown";
  plan.sort(
    (a, b) =>
      statusRank[a.status] - statusRank[b.status] ||
      (a.status === "upgrade"
        ? rank(b.clears.worst ?? "unknown") - rank(a.clears.worst ?? "unknown") || b.clears.count - a.clears.count
        : rank(worstRemaining(b)) - rank(worstRemaining(a)) || b.total - a.total) ||
      (a.name < b.name ? -1 : 1),
  );
  // Commands follow the plan's order (safe first).
  const position = (u: Unit) => Math.min(...u.entries.map((e) => plan.indexOf(e)));
  // A command with a likely peer conflict goes last: npm can accept it and still leave a tree on
  // which every later install stops with ERESOLVE.
  const risky = (s: (typeof separate)[number]) => Number(Boolean(s.command.conflicts?.length));
  separate.sort((a, b) => risky(a) - risky(b) || position(a.unit) - position(b.unit));
  // Each separate command runs after the safe step and the commands before it. A peer conflict that
  // is there before it and still there after it stops it with ERESOLVE too: the same rule as for the
  // safe step. One it would start itself is in `conflicts`, never hidden behind --legacy-peer-deps.
  let before = safeChanges;
  for (const { command: cmd, unit } of separate) {
    const after = new Map([...before, ...movedBy(unit.installs)]);
    const inherited = brokenPeers(before);
    const still = [...brokenPeers(after)].filter(([key]) => inherited.has(key)).map(([, text]) => text);
    before = after;
    const runs = cmd.install.length > 0 || Boolean(cmd.workspaceInstall) || cmd.update.length > 0;
    if (!runs || !still.length) continue;
    cmd.existingConflicts = [...new Set(still)].sort();
    if (peerOnly.length) {
      cmd.blocked = { install: cmd.install, workspaceInstall: cmd.workspaceInstall, update: cmd.update };
      cmd.peerOnly = peerOnly;
      cmd.install = [];
      cmd.workspaceInstall = undefined;
      cmd.update = [];
    } else cmd.legacyPeerDeps = true;
  }
  commands.push(...separate.map((s) => s.command));
  return { plan, commands, refresh, warnings, requests };
}

/**
 * Versions of `d` worth trying, oldest first: newer than the installed one, not deprecated, not a
 * prerelease (unless one is installed), at most CANDIDATES_PER_LINE of the newest per breaking
 * line, on the current line and the BREAKING_LINES newest lines above it.
 */
export function candidatesFor(d: Dependency, meta: PackageDeps, info?: PackageInfo): string[] {
  const newer = Object.keys(meta.versions)
    .filter(
      (v) =>
        isValidVersion(v) &&
        compareVersions(v, d.version) > 0 &&
        (!isPrerelease(v) || isPrerelease(d.version)) &&
        !info?.deprecated[v],
    )
    .sort(compareVersions);
  const lines: string[][] = [];
  for (const v of newer) {
    const line = lines.at(-1);
    if (line && !crossesBreaking(line[0] as string, v)) line.push(v);
    else lines.push([v]);
  }
  const current = lines[0] && !crossesBreaking(d.version, lines[0][0] as string) ? (lines.shift() as string[]) : [];
  return [current, ...lines.slice(-BREAKING_LINES)].flatMap((line) => line.slice(-CANDIDATES_PER_LINE));
}
