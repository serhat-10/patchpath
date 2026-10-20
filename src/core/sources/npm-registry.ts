import type { Cache } from "../cache.js";
import { fetchJson, sanitize, type NetContext } from "../util.js";

const REGISTRY = "https://registry.npmjs.org";
const TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_PREFIX = "v1:npm:pkg:";
/** Separate, slim records for the upgrade planner, so the entries above stay small. */
const DEPS_CACHE_PREFIX = "v3:npm:deps:";

export interface PackageInfo {
  latest?: string;
  /** Deprecation messages keyed by version; only deprecated versions are present. */
  deprecated: Record<string, string>;
}

/**
 * What each published version declares: `dependencies`, `optionalDependencies` and
 * `peerDependencies` merged into one name -> range map (dependencies win on a clash).
 * Used only to estimate how an upgrade would resolve; never printed.
 */
export interface PackageDeps {
  latest?: string;
  versions: Record<string, Record<string, string>>;
  /**
   * `peerDependencies` per version (optional ones included: npm checks them when they are
   * installed), for versions that declare any. Used to warn that an upgrade will probably fail
   * with ERESOLVE.
   */
  peers?: Record<string, Record<string, string>>;
  /** Of `peers`, the names marked `optional` in `peerDependenciesMeta`, per version. */
  optionalPeers?: Record<string, string[]>;
}

type DepMap = Record<string, unknown>;

interface Packument {
  name?: unknown;
  "dist-tags"?: { latest?: string };
  versions?: Record<
    string,
    {
      deprecated?: string;
      dependencies?: DepMap;
      optionalDependencies?: DepMap;
      peerDependencies?: DepMap;
      peerDependenciesMeta?: Record<string, unknown>;
    }
  >;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPackageInfo = (value: unknown): value is PackageInfo =>
  typeof value === "object" && value !== null && typeof (value as PackageInfo).deprecated === "object";

const isPackageDeps = (value: unknown): value is PackageDeps =>
  isObject(value) &&
  (value.latest === undefined || typeof value.latest === "string") &&
  isObject(value.versions) &&
  Object.values(value.versions).every((deps) => isObject(deps) && Object.values(deps).every((r) => typeof r === "string")) &&
  (value.peers === undefined ||
    (isObject(value.peers) &&
      Object.values(value.peers).every((deps) => isObject(deps) && Object.values(deps).every((r) => typeof r === "string"))));

function extractDeps(doc: Packument): PackageDeps {
  const versions: Record<string, Record<string, string>> = {};
  const peers: Record<string, Record<string, string>> = {};
  const optionalPeers: Record<string, string[]> = {};
  for (const [version, meta] of Object.entries(doc.versions ?? {})) {
    if (!isObject(meta)) continue;
    const deps: Record<string, string> = {};
    for (const map of [meta.peerDependencies, meta.optionalDependencies, meta.dependencies]) {
      if (!isObject(map)) continue;
      for (const [name, range] of Object.entries(map)) if (typeof range === "string") deps[name] = range;
    }
    versions[version] = deps;
    if (isObject(meta.peerDependencies)) {
      // Optional peers are kept too: npm does not install them, but checks them when they are installed.
      const declared: Record<string, string> = {};
      for (const [name, range] of Object.entries(meta.peerDependencies)) if (typeof range === "string") declared[name] = range;
      if (Object.keys(declared).length) peers[version] = declared;
      const optional = Object.keys(declared).filter((n) => {
        const m = isObject(meta.peerDependenciesMeta) ? meta.peerDependenciesMeta[n] : undefined;
        return isObject(m) && m.optional === true;
      });
      if (optional.length) optionalPeers[version] = optional;
    }
  }
  const latest = doc["dist-tags"]?.latest;
  return { latest: typeof latest === "string" ? latest : undefined, versions, peers, optionalPeers };
}

/** Every part percent-encoded; a scoped name keeps its "@" and gets the slash encoded, like npm does. */
const urlOf = (name: string) => {
  const slash = name.startsWith("@") ? name.indexOf("/") : -1;
  return slash === -1
    ? `${REGISTRY}/${encodeURIComponent(name)}`
    : `${REGISTRY}/@${encodeURIComponent(name.slice(1, slash))}%2f${encodeURIComponent(name.slice(slash + 1))}`;
};
// The abbreviated document is far smaller than the full packument, and still lists per-version dependencies.
const ABBREVIATED = { accept: "application/vnd.npm.install-v1+json" };

/** Downloads a package document and refuses one that says it is about another package. */
async function fetchPackument(name: string, net: NetContext): Promise<Packument | null> {
  const doc = await fetchJson<Packument>(urlOf(name), { headers: ABBREVIATED }, net);
  if (isObject(doc) && doc.name !== undefined && doc.name !== name) {
    throw new Error(`the registry answered with a document for a different package (asked for ${sanitize(name, 214)})`);
  }
  return doc;
}

/**
 * `onDeps`, when given, receives the per-version dependency data of a freshly downloaded document,
 * so the upgrade planner does not have to download it a second time. It is cached as well.
 */
export async function fetchPackageInfo(
  name: string,
  cache: Cache,
  net: NetContext = {},
  onDeps?: (deps: PackageDeps) => void,
  /** Called right before a request is made; may throw to refuse it (request cap). */
  beforeRequest?: () => void,
): Promise<PackageInfo | null> {
  const key = `${CACHE_PREFIX}${name}`;
  const cached = await cache.get<unknown>(key, TTL_MS);
  if (isPackageInfo(cached)) return cached;

  beforeRequest?.();
  const doc = await fetchPackument(name, net);
  if (!doc) return null;

  const deprecated: Record<string, string> = {};
  for (const [version, meta] of Object.entries(doc.versions ?? {})) {
    // Maintainers control this text, so clean it before it can reach a terminal or an agent.
    if (meta?.deprecated) deprecated[version] = sanitize(meta.deprecated, 300);
  }
  const latest = doc["dist-tags"]?.latest;
  const info: PackageInfo = { latest: latest ? sanitize(latest, 100) : undefined, deprecated };
  await cache.set(key, info);
  if (onDeps) {
    const deps = extractDeps(doc);
    // Cached together with the entry above, so a later scan that finds this one cached does not
    // have to download the document again for the planner.
    await cache.set(`${DEPS_CACHE_PREFIX}${name}`, deps);
    onDeps(deps);
  }
  return info;
}

/**
 * Per-version dependency ranges of a package, from the cache (6 h, like fetchPackageInfo), from
 * `fresh` (a document already downloaded in this scan) or from the registry. `requested` says
 * whether a request was made. Returns null when the registry has no such package.
 */
export async function fetchPackageDeps(
  name: string,
  cache: Cache,
  net: NetContext = {},
  fresh?: PackageDeps,
  /** Called right before a request is made; may throw to refuse it (request cap). */
  beforeRequest?: () => void,
): Promise<{ deps: PackageDeps | null; requested: boolean }> {
  const key = `${DEPS_CACHE_PREFIX}${name}`;
  if (fresh) {
    await cache.set(key, fresh);
    return { deps: fresh, requested: false };
  }
  const cached = await cache.get<unknown>(key, TTL_MS);
  if (isPackageDeps(cached)) return { deps: cached, requested: false };

  beforeRequest?.();
  const doc = await fetchPackument(name, net);
  if (!doc) return { deps: null, requested: true };
  if (!isObject(doc) || (doc.versions !== undefined && !isObject(doc.versions))) {
    throw new Error(`unexpected registry response for ${sanitize(name, 214)}`);
  }
  const deps = extractDeps(doc);
  await cache.set(key, deps);
  return { deps, requested: true };
}
