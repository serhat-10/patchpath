import { isValidVersion } from "../semver.js";
import type { Dependency } from "../types.js";
import { isValidNpmName, sanitize } from "../util.js";

/**
 * The parts every lockfile reader shares: one flat, de-duplicated dependency list (the model the
 * report is built from, whatever the package manager), the origin rule that decides what may be
 * sent anywhere, and the reachability walk that turns a package graph into direct/dev/via.
 */

/** Lockfile formats patchpath reads. Only `npm` gets an upgrade plan, commands and overrides. */
export type LockfileType = "npm" | "yarn-v1" | "pnpm-9";

export const LOCKFILE_LABEL: Record<LockfileType, string> = {
  npm: "package-lock.json",
  "yarn-v1": "yarn.lock (yarn v1)",
  "pnpm-9": "pnpm-lock.yaml (lockfile v9)",
};

/** Said in the report (text and JSON `planUnavailable`) for every lockfile type without a plan. */
export const PLAN_UNAVAILABLE = "upgrade plan is not available for yarn/pnpm lockfiles yet";

/**
 * Collects packages by `name@version`. The same name and version can be installed several times
 * (nested copies, peer variants, several lockfile entries); they are one package in the report:
 * direct if any copy is, dev only if every copy is, and unchecked (external) if any copy is.
 */
export class DependencyCollector {
  private readonly found = new Map<string, Dependency>();

  add(dep: Dependency): void {
    const key = `${dep.name}@${dep.version}`;
    const existing = this.found.get(key);
    if (!existing) {
      this.found.set(key, dep);
      return;
    }
    existing.direct ||= dep.direct;
    existing.dev &&= dep.dev;
    existing.external ||= dep.external;
    if (dep.unresolved) existing.unresolved = true;
    if (dep.invalidName) existing.invalidName = true;
    if (dep.mixedHeader) existing.mixedHeader = true;
    if (existing.direct) existing.via = undefined;
    else if (dep.via && (!existing.via || dep.via.length < existing.via.length)) existing.via = dep.via;
  }

  /**
   * Lockfiles can come from anywhere (a cloned repo, a pull request), so every string taken from
   * them is cleaned here, before it reaches a request, the report or a terminal.
   */
  finish(): Dependency[] {
    for (const dep of this.found.values()) {
      dep.name = sanitize(dep.name, 214);
      dep.version = sanitize(dep.version, 100);
      if (dep.via) dep.via = dep.via.map((id) => sanitize(id, 320));
      if (!dep.unresolved) delete dep.unresolved;
      if (!dep.invalidName) delete dep.invalidName;
      if (!dep.mixedHeader) delete dep.mixedHeader;
    }
    return [...this.found.values()].sort((a, b) =>
      a.name === b.name ? (a.version < b.version ? -1 : 1) : a.name < b.name ? -1 : 1,
    );
  }
}

export type Origin = "public" | "external" | "unknown";

/**
 * Origin of a package from its tarball URL, for the yarn and pnpm readers. "public" needs all of:
 * - the URL starts with one of `registries` (prefixes that end with "/", so look-alike hosts such
 *   as registry.npmjs.org.evil.com never match);
 * - the rest of the URL is that registry's tarball path for this very package
 *   (`<name>/-/<file>.tgz`, scoped names also as `@scope%2fname/-/`), so a lockfile entry cannot
 *   borrow a public tarball URL for a name that is not that package's;
 * - the version is a plain semver version.
 * No URL is "unknown" (public only with `assumePublic`); anything else is "external".
 */
export function tarballOrigin(
  url: string | undefined,
  name: string,
  version: string,
  registries: string[],
  assumePublic: boolean,
): Origin {
  if (!isValidVersion(version)) return "external";
  if (!url) return assumePublic ? "public" : "unknown";
  const prefix = registries.find((p) => url.startsWith(p));
  if (!prefix) return "external";
  const rest = url.slice(prefix.length);
  const paths = [`${name}/-/`];
  if (name.startsWith("@")) paths.push(`${name.replace("/", "%2f")}/-/`, `${name.replace("/", "%2F")}/-/`);
  return paths.some((p) => rest.startsWith(p)) ? "public" : "external";
}

/** One installed package of a yarn or pnpm lockfile, as a node of the dependency graph. */
export interface GraphPackage {
  name: string;
  version: string;
  origin: Origin;
  /** The name, or a key it is installed under (an alias), is one npm would not accept. */
  invalidName: boolean;
  /** yarn v1: the header lists specs that disagree on the real package name (a mix of ranges and aliases). */
  mixedHeader?: boolean;
  /** Node ids of what it depends on (production and optional; dev dependencies of packages are not installed). */
  deps: string[];
}

export interface PackageGraph {
  nodes: Map<string, GraphPackage>;
  /** Node ids the project (root or a workspace) declares in `dependencies` / `optionalDependencies`. */
  prodRoots: string[];
  /** Node ids the project declares in `devDependencies`. */
  devRoots: string[];
  /**
   * False when the lockfile alone does not say what the project declares (yarn v1 without a
   * package.json): every package is then reported as transitive production code.
   */
  rootsKnown: boolean;
}

/**
 * Turns a package graph into the flat list. Direct means "declared by the project". A package is
 * dev only when the project's dev dependencies reach it and its production ones do not. A package
 * that no root reaches (a lockfile leftover, or a root the reader could not see) counts as
 * production: `--no-dev` never hides something because the reader missed a root.
 * `via` is the shortest chain from a direct dependency, found breadth-first.
 */
export function flattenGraph(graph: PackageGraph): Dependency[] {
  const { nodes } = graph;
  const reach = (starts: string[]) => {
    const parent = new Map<string, string | undefined>();
    const queue: string[] = [];
    for (const id of starts) {
      if (nodes.has(id) && !parent.has(id)) {
        parent.set(id, undefined);
        queue.push(id);
      }
    }
    for (let head = 0; head < queue.length; head++) {
      const id = queue[head] as string;
      for (const child of nodes.get(id)?.deps ?? []) {
        if (nodes.has(child) && !parent.has(child)) {
          parent.set(child, id);
          queue.push(child);
        }
      }
    }
    return parent;
  };
  const direct = new Set([...graph.prodRoots, ...graph.devRoots].filter((id) => nodes.has(id)));
  const parent = reach([...graph.prodRoots, ...graph.devRoots]);
  const production = reach(graph.prodRoots);
  const label = (id: string) => {
    const node = nodes.get(id) as GraphPackage;
    return `${node.name}@${node.version}`;
  };

  // A hostile lockfile can chain thousands of packages; listing every hop for every package would
  // take quadratic time and memory. Chains longer than VIA_MAX keep their first VIA_HEAD and last
  // VIA_TAIL hops with "..." between.
  const depth = new Map<string, number>();
  const head = new Map<string, string>();
  for (const [id, up] of parent) {
    // Map order is insertion order, i.e. breadth-first: a parent always comes before its children.
    const d = up === undefined ? 0 : (depth.get(up) as number) + 1;
    depth.set(id, d);
    // `head` is the ancestor at depth VIA_HEAD - 1: walking up VIA_HEAD hops from it gives the start.
    if (up !== undefined && d >= VIA_HEAD) head.set(id, d === VIA_HEAD ? up : (head.get(up) as string));
  }
  const chainOf = (id: string): string[] => {
    const hops = depth.get(id) as number;
    const walk = (from: string | undefined, steps: number) => {
      const out: string[] = [];
      for (let cur = from; cur !== undefined && out.length < steps; cur = parent.get(cur)) out.unshift(label(cur));
      return out;
    };
    if (hops <= VIA_MAX) return walk(parent.get(id), hops);
    return [...walk(head.get(id), VIA_HEAD), "...", ...walk(parent.get(id), VIA_TAIL)];
  };

  const out = new DependencyCollector();
  for (const [id, node] of nodes) {
    const via = !direct.has(id) && parent.has(id) ? chainOf(id) : undefined;
    const invalidName = node.invalidName || !isValidNpmName(node.name);
    out.add({
      name: node.name,
      version: node.version,
      direct: direct.has(id),
      dev: graph.rootsKnown && parent.has(id) && !production.has(id),
      external: invalidName || node.origin !== "public",
      unresolved: !invalidName && node.origin === "unknown",
      mixedHeader: node.mixedHeader,
      invalidName,
      via,
    });
  }
  return out.finish();
}

const VIA_MAX = 64;
const VIA_HEAD = 32;
const VIA_TAIL = 31;

/** Largest yarn.lock / pnpm-lock.yaml read (real ones are a few MB; this keeps memory bounded). */
export const MAX_LOCKFILE_BYTES = 64 * 1024 * 1024;
