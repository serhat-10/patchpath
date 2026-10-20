import { sanitize } from "./util.js";

/**
 * The installed tree of an npm lockfile as a graph of install locations, with every dependency
 * edge (not only the shortest chain). The upgrade planner uses it to work out what npm keeps,
 * moves or drops after an upgrade. Built separately from the flat list in lockfile/npm.ts, which
 * stays the source of truth for what the report checks.
 */

export interface GraphEdge {
  /** Install path of the dependent ("" is the project root). */
  from: string;
  /** Install path the dependency resolves to. */
  to: string;
  /** The key the dependent declares (the folder name; differs from the package name for npm aliases). */
  key: string;
  /** Declared range, with an `npm:<name>@` alias prefix removed. */
  spec: string;
  peer: boolean;
}

export interface GraphNode {
  path: string;
  name: string;
  version: string;
  /** The project root or a workspace folder: never changes. */
  root: boolean;
  /** Shipped inside another package's tarball (`inBundle` / v1 `bundled`): npm cannot update or override it. */
  bundled: boolean;
  /** For bundled nodes: the install path of the package that bundles it. */
  bundler?: string;
  /** Installed only because something declares it as a peer (v3 `peer: true`). */
  peer?: boolean;
  in: GraphEdge[];
  out: GraphEdge[];
}

export interface LockGraph {
  nodes: Map<string, GraphNode>;
  /** Finds the install path `name` resolves to from `from`, like Node's module resolution. */
  locate(from: string, name: string): string | undefined;
}

const MARKER = "node_modules/";

interface LockPackage {
  name?: string;
  version?: string;
  resolved?: string;
  link?: boolean;
  inBundle?: boolean;
  peer?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface LegacyNode {
  version?: string;
  bundled?: boolean;
  requires?: Record<string, unknown>;
  dependencies?: Record<string, LegacyNode>;
}

/** `npm:name@range` -> `range`; anything else unchanged. */
export function stripAlias(spec: string): string {
  const m = /^npm:(?:@[^/]+\/)?[^@]+@(.*)$/.exec(spec);
  return m ? (m[1] as string) || "*" : spec;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringMap = (value: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (isObject(value)) for (const [k, v] of Object.entries(value)) if (typeof v === "string") out[k] = v;
  return out;
};

function makeLocate(installed: (path: string) => string | undefined) {
  return (from: string, name: string): string | undefined => {
    let base = from;
    for (;;) {
      const found = installed(base ? `${base}/${MARKER}${name}` : `${MARKER}${name}`);
      if (found) return found;
      if (!base) return undefined;
      const cut = base.lastIndexOf(`/${MARKER}`);
      base = cut === -1 ? "" : base.slice(0, cut);
    }
  };
}

/**
 * Builds the graph from lockfile text (v1, v2 or v3). `packageJson` gives the root's declared
 * dependencies for v1 lockfiles. Returns null when the lockfile cannot be read; never throws.
 */
export function buildLockGraph(text: string, packageJson?: string): LockGraph | null {
  let lock: { packages?: Record<string, LockPackage>; dependencies?: Record<string, LegacyNode> };
  try {
    lock = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return null;
  }
  if (!isObject(lock)) return null;
  const nodes = new Map<string, GraphNode>();
  const addNode = (path: string, name: string, version: string, root: boolean, bundled: boolean) => {
    const node: GraphNode = {
      path,
      name: sanitize(name, 214),
      version: sanitize(version, 100),
      root,
      bundled,
      in: [],
      out: [],
    };
    nodes.set(path, node);
    return node;
  };
  const addEdge = (from: string, key: string, spec: string, peer: boolean, to: string | undefined) => {
    if (to === undefined || to === from) return;
    const source = nodes.get(from);
    const target = nodes.get(to);
    if (!source || !target) return;
    // dependencies win over peer entries for the same key, like npm
    if (source.out.some((e) => e.key === key)) return;
    const edge: GraphEdge = { from, to, key, spec: stripAlias(spec), peer };
    source.out.push(edge);
    target.in.push(edge);
  };

  if (isObject(lock.packages)) {
    const packages = lock.packages;
    const target = (path: string): string | undefined => {
      const pkg = packages[path];
      if (!isObject(pkg)) return undefined;
      if (pkg.link) return typeof pkg.resolved === "string" && nodes.has(pkg.resolved) ? pkg.resolved : undefined;
      return nodes.has(path) ? path : undefined;
    };
    const locate = makeLocate(target);
    for (const [path, pkg] of Object.entries(packages)) {
      if (!isObject(pkg) || pkg.link) continue;
      const root = !path.includes(MARKER);
      if (!root && typeof pkg.version !== "string") continue;
      const name = pkg.name ?? (root ? path : path.slice(path.lastIndexOf(MARKER) + MARKER.length));
      const node = addNode(path, String(name), root ? "" : (pkg.version as string), root, Boolean(pkg.inBundle));
      if (pkg.peer === true) node.peer = true;
    }
    for (const node of nodes.values()) {
      if (!node.bundled) continue;
      // The bundler is the closest ancestor folder that is not itself bundled.
      let cur = node.path;
      for (;;) {
        const cut = cur.lastIndexOf(`/${MARKER}`);
        if (cut === -1) break;
        cur = cur.slice(0, cut);
        const parent = nodes.get(cur);
        if (parent && !parent.bundled) {
          // Bundled by the project (root or workspace): installed and updated like any dependency.
          if (!parent.root) node.bundler = cur;
          break;
        }
      }
      if (!node.bundler) node.bundled = false;
    }
    for (const node of [...nodes.values()]) {
      const pkg = packages[node.path] as LockPackage;
      const groups: [Record<string, string>, boolean][] = [
        [stringMap(pkg.dependencies), false],
        [stringMap(pkg.optionalDependencies), false],
        ...(node.root ? ([[stringMap(pkg.devDependencies), false]] as [Record<string, string>, boolean][]) : []),
        [stringMap(pkg.peerDependencies), true],
      ];
      for (const [deps, peer] of groups) {
        for (const [key, spec] of Object.entries(deps)) addEdge(node.path, key, spec, peer, locate(node.path, key));
      }
    }
    return { nodes, locate };
  }

  if (isObject(lock.dependencies)) {
    addNode("", "", "", true, false);
    const requires = new Map<string, Record<string, string>>();
    const walk = (deps: Record<string, LegacyNode>, base: string) => {
      for (const [folder, entry] of Object.entries(deps)) {
        if (!isObject(entry) || typeof entry.version !== "string") continue;
        const path = base ? `${base}/${MARKER}${folder}` : `${MARKER}${folder}`;
        const alias = /^npm:((?:@[^/]+\/)?[^@]+)@(.+)$/.exec(entry.version);
        const node = addNode(path, alias ? (alias[1] as string) : folder, alias ? (alias[2] as string) : entry.version, false, Boolean(entry.bundled));
        if (node.bundled && base) node.bundler = base;
        else node.bundled = false;
        const req: Record<string, string> = {};
        for (const [k, v] of Object.entries(isObject(entry.requires) ? entry.requires : {})) {
          // Old npm 5 lockfiles write `true`; the locked version is the best range we have then.
          req[k] = typeof v === "string" ? v : "";
        }
        requires.set(path, req);
        if (isObject(entry.dependencies)) walk(entry.dependencies as Record<string, LegacyNode>, path);
      }
    };
    walk(lock.dependencies, "");
    // A bundled package nested in another bundled one is bundled by the outermost non-bundled one.
    for (const node of nodes.values()) {
      while (node.bundler && nodes.get(node.bundler)?.bundled) node.bundler = nodes.get(node.bundler)?.bundler;
      if (node.bundled && !node.bundler) node.bundled = false;
    }
    const locate = makeLocate((path) => (nodes.has(path) && path !== "" ? path : undefined));
    let rootDeps: [Record<string, string>, boolean][] = [];
    try {
      const pj = JSON.parse(packageJson ?? "{}") as Record<string, unknown>;
      rootDeps = [
        [stringMap(pj.dependencies), false],
        [stringMap(pj.optionalDependencies), false],
        [stringMap(pj.devDependencies), false],
        [stringMap(pj.peerDependencies), true],
      ];
    } catch {
      // without package.json the root has no edges: nothing is direct
    }
    for (const [deps, peer] of rootDeps) {
      for (const [key, spec] of Object.entries(deps)) addEdge("", key, spec, peer, locate("", key));
    }
    for (const [path, req] of requires) {
      for (const [key, spec] of Object.entries(req)) {
        const to = locate(path, key);
        addEdge(path, key, spec || (to ? (nodes.get(to)?.version ?? "") : ""), false, to);
      }
    }
    return { nodes, locate };
  }
  return null;
}
