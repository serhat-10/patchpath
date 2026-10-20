import { isScalar, parseAllDocuments, visit } from "yaml";
import type { Dependency } from "../types.js";
import { UserError, isValidNpmName } from "../util.js";
import { MAX_LOCKFILE_BYTES, flattenGraph, tarballOrigin, type GraphPackage, type Origin } from "./common.js";
import { PUBLIC_REGISTRIES, normalizeRegistry, type ParseOptions } from "./npm.js";

/**
 * Reader for pnpm lockfiles with `lockfileVersion: '9.0'` (written by pnpm 9 and 10):
 *
 *   importers:            what the project (".") and each workspace folder declares
 *     .:
 *       dependencies:
 *         react-dom: {specifier: ^18.2.0, version: 18.2.0(react@18.2.0)}
 *         sio4:      {specifier: npm:socket.io-client@4, version: socket.io-client@4.7.2}
 *         ws-b:      {specifier: workspace:*, version: link:packages/b}
 *   packages:             one entry per name@version: where it came from
 *     react-dom@18.2.0: {resolution: {integrity: sha512-...}}
 *   snapshots:            one entry per name@version(peers): what it depends on
 *     react-dom@18.2.0(react@18.2.0): {dependencies: {react: 18.2.0, scheduler: 0.23.0}}
 *
 * The YAML is parsed by the `yaml` package (a devDependency bundled into dist, like semver) with
 * the failsafe schema (every scalar stays a string), duplicate keys rejected, YAML aliases refused
 * and mappings read as Maps, so nothing in the file can touch an object prototype.
 *
 * Where a package came from (what decides whether its name may be sent anywhere):
 * - `resolution: {integrity}` alone: pnpm leaves the tarball URL out when it is the standard one of
 *   the registry configured at install time, for the package's scope. The lockfile does not say
 *   which registry that was (it may be a private one), so these are "unknown", exactly like npm
 *   entries without `resolved`: checked only with `--assume-public`.
 * - `resolution: {tarball}`: checked when the URL is the public registry's (or a `--registry`
 *   prefix's) tarball path for that very package.
 * - directories, git repositories, `file:` and `link:` references, versions that are not plain
 *   semver, and anything the reader does not recognise: never checked.
 */

export interface PnpmParseResult {
  dependencies: Dependency[];
  warnings: string[];
}

type YamlMap = Map<unknown, unknown>;

const isMap = (value: unknown): value is YamlMap => value instanceof Map;
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const mapAt = (map: YamlMap | undefined, key: string): YamlMap | undefined => {
  const value = map?.get(key);
  return isMap(value) ? value : undefined;
};
/** String-keyed entries of a mapping; anything else is skipped. */
const entries = (map: YamlMap | undefined): [string, unknown][] =>
  map ? [...map].filter((pair): pair is [string, unknown] => typeof pair[0] === "string") : [];

/** `name@version` -> name and version; a scoped name keeps its leading `@`. */
function splitKey(key: string): { name: string; version: string } | undefined {
  const at = key.indexOf("@", 1);
  if (at <= 0) return undefined;
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

/**
 * Start of the peer suffix of a snapshot key (`react-dom@18.2.0(react@18.2.0)(x@1.0.0)` -> the
 * first `(`), or the key's length when there is none. Undefined when the parentheses at the end do
 * not balance: such a key matches no package and stays unchecked.
 */
function peerSuffixStart(key: string): number | undefined {
  if (!key.endsWith(")")) return key.length;
  let depth = 0;
  for (let i = key.length - 1; i >= 0; i--) {
    const ch = key[i];
    if (ch === ")") depth++;
    else if (ch === "(") {
      depth--;
      if (depth < 0) return undefined;
      if (depth === 0 && key[i - 1] !== ")") return i;
    } else if (depth === 0) return undefined;
  }
  return undefined;
}

/**
 * The snapshot key a dependency reference points to, as pnpm resolves it (`refToRelative`):
 * `18.2.0(react@18.2.0)` under `react-dom` is `react-dom@18.2.0(react@18.2.0)`, an alias's
 * `socket.io-client@4.7.2` is itself, and `link:` (a workspace folder or local link) is nothing.
 */
function refToKey(ref: string, alias: string): string | undefined {
  if (ref.startsWith("link:")) return undefined;
  if (ref.startsWith("@")) return ref;
  const at = ref.indexOf("@");
  if (at === -1) return `${alias}@${ref}`;
  const colon = ref.indexOf(":");
  const bracket = ref.indexOf("(");
  if ((colon === -1 || at < colon) && (bracket === -1 || at < bracket)) return ref;
  return `${alias}@${ref}`;
}

function originOf(key: string, info: YamlMap | undefined, registries: string[], assumePublic: boolean): Origin {
  const split = splitKey(key);
  if (!split || !info) return "external";
  const { name, version } = split;
  // pnpm writes `name` / `version` fields only for packages that do not come from a registry.
  const ownName = str(info.get("name"));
  const ownVersion = str(info.get("version"));
  if ((ownName !== undefined && ownName !== name) || (ownVersion !== undefined && ownVersion !== version)) return "external";
  const resolution = mapAt(info, "resolution");
  if (!resolution) return "external";
  const keys = entries(resolution).map(([k]) => k);
  // Only `integrity` and `tarball` belong to a registry resolution; `directory`, `type: git`,
  // `repo`, `commit`, `path` and anything unknown mean it is not one.
  if (keys.some((k) => k !== "integrity" && k !== "tarball")) return "external";
  const tarball = resolution.get("tarball");
  if (tarball !== undefined) {
    const url = str(tarball);
    return url ? tarballOrigin(url, name, version, registries, false) : "external";
  }
  if (!str(resolution.get("integrity"))) return "external";
  return tarballOrigin(undefined, name, version, registries, assumePublic);
}

function readDocument(text: string): YamlMap {
  let docs;
  try {
    // `uniqueKeys` is checked below in linear time: the library's own check is quadratic per
    // mapping (6 s for a 10 000-package lockfile).
    docs = parseAllDocuments(text, { schema: "failsafe", uniqueKeys: false, prettyErrors: false, strict: true });
  } catch {
    throw new UserError("pnpm-lock.yaml is not valid YAML.");
  }
  if (!Array.isArray(docs) || !docs.length) throw new UserError("pnpm-lock.yaml is empty. Run `pnpm install` first.");
  // pnpm 10 can put a small document for config dependencies before the lockfile itself: the
  // lockfile is the last document with a lockfileVersion.
  let chosen: YamlMap | undefined;
  for (const doc of docs) {
    if (doc.errors.length) throw new UserError(`pnpm-lock.yaml is not valid YAML (${doc.errors[0]?.code ?? "parse error"}).`);
    let duplicate: string | undefined;
    visit(doc, {
      Map(_, map) {
        const seen = new Set<string>();
        for (const pair of map.items) {
          if (!isScalar(pair.key)) continue;
          const key = String(pair.key.value);
          if (seen.has(key)) {
            duplicate = key;
            return visit.BREAK;
          }
          seen.add(key);
        }
        return undefined;
      },
    });
    if (duplicate !== undefined) throw new UserError(`pnpm-lock.yaml has a duplicate key (${JSON.stringify(duplicate.slice(0, 80))}).`);
    let value: unknown;
    try {
      value = doc.toJS({ mapAsMap: true, maxAliasCount: 0 });
    } catch {
      throw new UserError("pnpm-lock.yaml uses YAML features a pnpm lockfile never has (aliases or tags).");
    }
    if (isMap(value) && value.has("lockfileVersion")) chosen = value;
  }
  if (!chosen) throw new UserError("pnpm-lock.yaml has no lockfileVersion.");
  return chosen;
}

/** Parses a pnpm v9 lockfile into the flat dependency list. */
export function parsePnpmLockfile(text: string, options: ParseOptions = {}): PnpmParseResult {
  if (text.length > MAX_LOCKFILE_BYTES) throw new UserError("pnpm-lock.yaml is too large to read (over 64 MB).");
  const registries = [...PUBLIC_REGISTRIES, ...(options.registries ?? []).map(normalizeRegistry)];
  const assumePublic = options.assumePublic ?? false;
  const warnings: string[] = [];

  let lock: YamlMap;
  try {
    lock = readDocument(text.replace(/^﻿/, ""));
  } catch (error) {
    // A stack overflow on absurdly nested input, or anything else the YAML parser throws.
    if (error instanceof UserError) throw error;
    throw new UserError("pnpm-lock.yaml is not valid YAML.");
  }
  const version = str(lock.get("lockfileVersion"));
  if (version === undefined || !/^9(\.\d+)?$/.test(version)) {
    throw new UserError(
      `pnpm-lock.yaml has lockfileVersion ${JSON.stringify(String(version ?? "?").slice(0, 20))}; only lockfile version 9.0 ` +
        `(pnpm 9 and 10) is supported. Run \`pnpm install\` with pnpm 9 or newer to update it.`,
    );
  }

  const packages = mapAt(lock, "packages");
  const snapshots = mapAt(lock, "snapshots");
  const importers = mapAt(lock, "importers");
  if (!importers) throw new UserError("pnpm-lock.yaml has no importers. Run `pnpm install` first.");

  const nodes = new Map<string, GraphPackage>();
  /** Snapshot key -> package key, for keys whose peer suffix parses. */
  const packageKey = (key: string) => {
    const end = peerSuffixStart(key);
    return end === undefined ? undefined : key.slice(0, end);
  };
  const addNode = (key: string) => {
    if (nodes.has(key)) return;
    const pkgKey = packageKey(key);
    const split = pkgKey === undefined ? undefined : splitKey(pkgKey);
    const name = split?.name ?? key;
    const info = pkgKey === undefined ? undefined : mapAt(packages, pkgKey);
    const origin = pkgKey === undefined ? "external" : originOf(pkgKey, info, registries, assumePublic);
    // A git or tarball package's key holds its URL; its `version` field (if any) reads better in the report.
    const version = (origin === "public" ? undefined : str(info?.get("version"))) ?? split?.version ?? "";
    nodes.set(key, { name, version, origin, invalidName: !split || !isValidNpmName(name), deps: [] });
  };
  for (const [key] of entries(snapshots)) addNode(key);
  // A package without a snapshot (not in pnpm 9 output, but cheap to cover) is still listed.
  const snapshotted = new Set([...nodes.keys()].map(packageKey));
  for (const [key] of entries(packages)) if (!snapshotted.has(key)) addNode(key);

  /** Node a reference points to, if the lockfile has it. Marks the target when the alias is a name npm would not accept. */
  const target = (alias: string, ref: unknown): string | undefined => {
    const value = str(ref);
    if (value === undefined) return undefined;
    const key = refToKey(value, alias);
    if (key === undefined || !nodes.has(key)) return undefined;
    if (!isValidNpmName(alias)) (nodes.get(key) as GraphPackage).invalidName = true;
    return key;
  };

  let dangling = 0;
  for (const [key, snapshot] of entries(snapshots)) {
    const node = nodes.get(key) as GraphPackage;
    const info = isMap(snapshot) ? snapshot : undefined;
    for (const section of ["dependencies", "optionalDependencies"]) {
      for (const [alias, ref] of entries(mapAt(info, section))) {
        const child = target(alias, ref);
        if (child !== undefined) node.deps.push(child);
        else if (!str(ref)?.startsWith("link:")) dangling++;
      }
    }
  }

  const prodRoots: string[] = [];
  const devRoots: string[] = [];
  for (const [, importer] of entries(importers)) {
    const project = isMap(importer) ? importer : undefined;
    const sections: [string, string[]][] = [
      ["dependencies", prodRoots],
      ["optionalDependencies", prodRoots],
      ["devDependencies", devRoots],
    ];
    for (const [section, roots] of sections) {
      for (const [alias, spec] of entries(mapAt(project, section))) {
        const ref = isMap(spec) ? spec.get("version") : spec;
        const child = target(alias, ref);
        if (child !== undefined) roots.push(child);
        else if (!str(ref)?.startsWith("link:")) dangling++;
      }
    }
  }
  if (dangling) {
    warnings.push(
      `${dangling} dependency reference${dangling === 1 ? "" : "s"} in pnpm-lock.yaml ${dangling === 1 ? "has" : "have"} no matching entry ` +
        `(the lockfile may be out of date): chains and the dev/production split may be incomplete.`,
    );
  }

  const dependencies = flattenGraph({ nodes, prodRoots, devRoots, rootsKnown: true });
  const unknown = dependencies.filter((d) => d.unresolved).length;
  if (unknown) {
    warnings.push(
      `pnpm-lock.yaml does not say which registry ${unknown} package${unknown === 1 ? "" : "s"} came from ` +
        `(integrity only: the registry configured when they were installed, which may be private), so ` +
        `${unknown === 1 ? "it was" : "they were"} not checked. Pass --assume-public if this project installs from registry.npmjs.org.`,
    );
  }
  return { dependencies, warnings };
}
