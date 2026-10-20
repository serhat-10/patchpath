import { UserError, isValidNpmName, sanitize } from "../util.js";
import type { Dependency } from "../types.js";
import { DependencyCollector } from "./common.js";

interface LockPackage {
  /** Present when the install folder differs from the real name (npm aliases). */
  name?: string;
  version?: string;
  resolved?: string;
  dev?: boolean;
  devOptional?: boolean;
  inBundle?: boolean;
  link?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface LegacyNode {
  version?: string;
  dev?: boolean;
  /** npm 6 writes `false` for bundled children of a package (for example fsevents' node-pre-gyp tree). */
  resolved?: string | false;
  bundled?: boolean;
  optional?: boolean;
  requires?: Record<string, string>;
  dependencies?: Record<string, LegacyNode>;
}

interface Lockfile {
  lockfileVersion?: number;
  packages?: Record<string, LockPackage>;
  dependencies?: Record<string, LegacyNode>;
}

const MARKER = "node_modules/";
// Old npm versions wrote plain-http URLs for the same hosts. The prefixes end with "/", so look-alikes
// (registry.npmjs.org.evil.com, registry.npmjs.org@evil.com) never match.
export const PUBLIC_REGISTRIES = [
  "https://registry.npmjs.org/",
  "https://registry.yarnpkg.com/",
  "http://registry.npmjs.org/",
  "http://registry.yarnpkg.com/",
];

export interface ParseOptions {
  /**
   * Extra URL prefixes that serve the public npm registry (a mirror or proxy). Packages resolved
   * from them are treated like registry.npmjs.org packages, i.e. looked up.
   */
  registries?: string[];
  /** Treat entries without a `resolved` URL as public registry packages. */
  assumePublic?: boolean;
}

/** Validates a registry URL and gives it exactly one trailing slash, so prefixes match on path boundaries. */
export function normalizeRegistry(url: string): string {
  let parsed: URL | undefined;
  try {
    parsed = new URL(url.trim());
  } catch {
    // reported below
  }
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    throw new UserError(`--registry must be an http(s) URL (got "${sanitize(url, 200)}").`);
  }
  parsed.search = "";
  parsed.hash = "";
  return `${parsed.href.replace(/\/+$/, "")}/`;
}

type Origin = "public" | "external" | "unknown";

/**
 * Where a package came from. A missing `resolved` is "unknown": npm omits it for registry packages
 * with `omit-lockfile-registry-resolved`, but it can be missing for anything else too, so the name
 * may be private and must not be sent anywhere. Bundled packages have no `resolved` of their own;
 * they inherit the origin of the package that bundles them.
 */
function originOf(
  resolved: string | false | undefined,
  bundledIn: Origin | undefined,
  registries: string[],
  assumePublic: boolean,
): Origin {
  if (bundledIn) return bundledIn;
  if (!resolved) return assumePublic ? "public" : "unknown";
  return registries.some((prefix) => resolved.startsWith(prefix)) ? "public" : "external";
}

function declaredNames(pkg: Partial<LockPackage> | undefined, includeDev = true): string[] {
  return [
    ...Object.keys(pkg?.dependencies ?? {}),
    ...(includeDev ? Object.keys(pkg?.devDependencies ?? {}) : []),
    ...Object.keys(pkg?.optionalDependencies ?? {}),
    ...Object.keys(pkg?.peerDependencies ?? {}),
  ];
}

/** An exact version with no range operator: `1.2.3`, `=1.2.3`, `v1.2.3`, `1.2.3-beta.1`. */
const EXACT_VERSION = /^[=v]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Names the root package.json pins to one exact version (`"pyodide": "0.27.2"`, no `^`/`~`).
 * That is usually deliberate, so callers can skip the "major version behind" warning for them
 * (their vulnerabilities must still be reported). A name listed in several sections counts only
 * when every spec is exact; ranges, tags, aliases, git and file specs never count.
 */
export function exactPinnedDependencies(packageJson: string | undefined): Set<string> {
  const pinned = new Set<string>();
  if (!packageJson) return pinned;
  let json: LockPackage;
  try {
    json = JSON.parse(packageJson) as LockPackage;
  } catch {
    return pinned;
  }
  const specs = new Map<string, string[]>();
  for (const section of [json.dependencies, json.devDependencies, json.optionalDependencies]) {
    for (const [name, spec] of Object.entries(section ?? {})) specs.set(name, [...(specs.get(name) ?? []), String(spec)]);
  }
  for (const [name, list] of specs) {
    if (list.every((spec) => EXACT_VERSION.test(spec.trim()))) pinned.add(name);
  }
  return pinned;
}

/** `npm:name@1.2.3` (v1 aliases) -> the real name and version. */
function unalias(name: string, version: string): { name: string; version: string } {
  const m = /^npm:((?:@[^/]+\/)?[^@]+)@(.+)$/.exec(version);
  return m ? { name: m[1] as string, version: m[2] as string } : { name, version };
}

/**
 * npm 6 writes `"resolved": false` (not a missing key) for the children of a bundled package, e.g.
 * the node-pre-gyp tree under fsevents 1.x. They travel inside the parent's tarball, so the parent's
 * origin is theirs. That is only safe when the parent itself came from the public registry (a private
 * parent could bundle anything), the entry is explicitly `false` (a missing key stays "unknown"),
 * and npm marked it bundled or optional. Optional alone is the shape npm 6 really writes: in the
 * mattermost lockfile every one of the 66 `"resolved": false` entries (fsevents 1.2.9's tree) has
 * `optional: true` and no `bundled`. Anything else stays unknown.
 */
function legacyResolved(node: LegacyNode, parentOrigin: Origin | undefined): string | undefined {
  if (node.resolved === false) {
    return parentOrigin === "public" && (node.bundled || node.optional) ? PUBLIC_REGISTRIES[0] : undefined;
  }
  return node.resolved;
}

const SEP = "\u0000";

/**
 * Paths (folder names joined by SEP) of v1 entries that something reachable from the root's
 * production dependencies requires, following `requires` with Node's lookup order. The lockfile
 * keeps entries that nothing requires any more (extraneous trees under a package that dropped the
 * dependency); `npm install --omit=dev` and `npm audit --omit=dev` leave them out, but they carry no
 * `dev` flag. Returns undefined, so nothing is reclassified, when the lockfile cannot support the
 * computation: no package.json production dependencies, or no `requires` data at all.
 */
function legacyProductionReach(top: Record<string, LegacyNode>, roots: Set<string>): Set<string> | undefined {
  const nodes = new Map<string, LegacyNode>();
  let hasRequires = false;
  const index = (level: Record<string, LegacyNode>, trail: string[]) => {
    for (const [folder, node] of Object.entries(level)) {
      const path = [...trail, folder];
      nodes.set(path.join(SEP), node);
      if (node.requires) hasRequires = true;
      if (node.dependencies) index(node.dependencies, path);
    }
  };
  index(top, []);
  if (!hasRequires || !roots.size) return undefined;

  const seen = new Set<string>();
  const queue: string[][] = [];
  const visit = (from: string[], name: string) => {
    for (let depth = from.length; depth >= 0; depth--) {
      const path = [...from.slice(0, depth), name];
      const key = path.join(SEP);
      if (!nodes.has(key)) continue;
      if (!seen.has(key)) {
        seen.add(key);
        queue.push(path);
      }
      return;
    }
  };
  for (const name of roots) visit([], name);
  for (let head = 0; head < queue.length; head++) {
    const path = queue[head] as string[];
    for (const name of Object.keys(nodes.get(path.join(SEP))?.requires ?? {})) visit(path, name);
  }
  return seen;
}

/** Node's module resolution: look in the package's own node_modules, then each ancestor's. */
function resolvePath(from: string, name: string, installed: (path: string) => boolean): string | undefined {
  let base = from;
  for (;;) {
    const candidate = base ? `${base}/${MARKER}${name}` : `${MARKER}${name}`;
    if (installed(candidate)) return candidate;
    if (!base) return undefined;
    const cut = base.lastIndexOf(`/${MARKER}`);
    base = cut === -1 ? "" : base.slice(0, cut);
  }
}

/**
 * Parses an npm lockfile (v1, v2 or v3) into a flat, de-duplicated dependency list.
 * `packageJson` is only needed to tell direct dependencies apart in v1 lockfiles.
 */
export function parseNpmLockfile(text: string, packageJson?: string, options: ParseOptions = {}): Dependency[] {
  const registries = [...PUBLIC_REGISTRIES, ...(options.registries ?? []).map(normalizeRegistry)];
  const assumePublic = options.assumePublic ?? false;
  let lock: Lockfile;
  try {
    // PowerShell and some editors write a byte-order mark that JSON.parse rejects.
    lock = JSON.parse(text.replace(/^﻿/, "")) as Lockfile;
  } catch {
    throw new UserError("package-lock.json is not valid JSON.");
  }

  const found = new DependencyCollector();
  const add = (dep: Dependency) => found.add(dep);

  if (lock.packages) {
    const packages = lock.packages;
    const installed = (path: string) => Boolean(packages[path]?.version && !packages[path]?.link);
    const nameOf = (path: string) => packages[path]?.name ?? path.slice(path.lastIndexOf(MARKER) + MARKER.length);
    const idOf = (path: string) => `${nameOf(path)}@${packages[path]?.version}`;

    // The root ("") and workspace folders are the project itself. What they declare is "direct".
    const directPaths = new Set<string>();
    for (const [path, pkg] of Object.entries(packages)) {
      if (path.includes(MARKER)) continue;
      for (const name of declaredNames(pkg)) {
        const child = resolvePath(path, name, installed);
        if (child) directPaths.add(child);
      }
    }

    // Breadth-first from the direct dependencies gives each package its shortest chain.
    const parent = new Map<string, string | undefined>();
    const queue = [...directPaths];
    for (const path of queue) parent.set(path, undefined);
    for (let head = 0; head < queue.length; head++) {
      const path = queue[head] as string;
      for (const name of declaredNames(packages[path], false)) {
        const child = resolvePath(path, name, installed);
        if (child && !parent.has(child)) {
          parent.set(child, path);
          queue.push(child);
        }
      }
    }
    const chainTo = (path: string): string[] => {
      const chain: string[] = [];
      for (let cur = parent.get(path); cur !== undefined; cur = parent.get(cur)) chain.unshift(idOf(cur));
      return chain;
    };

    const origins = new Map<string, Origin>();
    const originAt = (path: string): Origin => {
      const known = origins.get(path);
      if (known) return known;
      const pkg = packages[path] ?? {};
      let bundledIn: Origin | undefined;
      // The bundler is the closest ancestor folder that is not itself bundled. When that is the
      // project (the root or a workspace), the package is a dependency like any other and its own
      // `resolved` says where it came from: the project's tarball is not a public one.
      const cut = path.lastIndexOf(`/${MARKER}`);
      if (pkg.inBundle && cut !== -1 && path.slice(0, cut).includes(MARKER)) bundledIn = originAt(path.slice(0, cut));
      const origin = originOf(pkg.resolved, bundledIn, registries, assumePublic);
      origins.set(path, origin);
      return origin;
    };

    for (const [path, pkg] of Object.entries(packages)) {
      if (!path.includes(MARKER) || !installed(path)) continue;
      const direct = directPaths.has(path);
      const via = direct || !parent.has(path) ? undefined : chainTo(path);
      const origin = originAt(path);
      const invalidName = !isValidNpmName(nameOf(path)) || !isValidNpmName(path.slice(path.lastIndexOf(MARKER) + MARKER.length));
      add({
        name: String(nameOf(path)),
        version: pkg.version as string,
        direct,
        // `devOptional` means "dev dependency AND optional dependency of a production package".
        // `npm install --omit=dev` still installs it (only --omit=dev --omit=optional drops it),
        // so it is production code and must not disappear under --no-dev.
        dev: Boolean(pkg.dev),
        external: invalidName || origin !== "public",
        unresolved: !invalidName && origin === "unknown",
        invalidName,
        via,
      });
    }
  } else if (lock.dependencies) {
    let direct = new Set<string>();
    let production = new Set<string>();
    if (packageJson) {
      try {
        const json = JSON.parse(packageJson) as LockPackage;
        direct = new Set(declaredNames(json));
        production = new Set(declaredNames({ ...json, devDependencies: undefined, peerDependencies: undefined }));
      } catch {
        // fall through: every package is then reported as transitive
      }
    }
    const reachable = legacyProductionReach(lock.dependencies, production);
    // `parentOrigin` is the origin of the package whose `dependencies` we are in (undefined at the top).
    const walk = (nodes: Record<string, LegacyNode>, parentOrigin: Origin | undefined, trail: string[]) => {
      for (const [folder, node] of Object.entries(nodes)) {
        const path = [...trail, folder];
        // Bundled by the project itself (top level): its own `resolved` decides, as for any other entry.
        const bundledIn = node.bundled ? parentOrigin : undefined;
        const origin = originOf(legacyResolved(node, parentOrigin), bundledIn, registries, assumePublic);
        if (node.version && !/^(file:|link:|git|https?:)/.test(node.version)) {
          const { name, version } = unalias(folder, node.version);
          const invalidName = !isValidNpmName(name) || !isValidNpmName(folder);
          add({
            name,
            version,
            direct: parentOrigin === undefined && direct.has(folder),
            // Not required by anything reachable from the root's production dependencies: extraneous.
            dev: Boolean(node.dev) || (reachable !== undefined && !reachable.has(path.join(SEP))),
            external: invalidName || origin !== "public",
            unresolved: !invalidName && origin === "unknown",
            invalidName,
          });
        }
        if (node.dependencies) walk(node.dependencies, origin, path);
      }
    };
    walk(lock.dependencies, undefined, []);
  } else {
    throw new UserError("package-lock.json has no packages. Run `npm install` first.");
  }

  return found.finish();
}
