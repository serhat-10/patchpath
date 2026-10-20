import satisfies from "semver/functions/satisfies.js";
import validRange from "semver/ranges/valid.js";
import type { Dependency } from "../types.js";
import { UserError, isValidNpmName } from "../util.js";
import { MAX_LOCKFILE_BYTES, flattenGraph, tarballOrigin, type GraphPackage, type Origin } from "./common.js";
import { PUBLIC_REGISTRIES, normalizeRegistry, type ParseOptions } from "./npm.js";

/**
 * Reader for yarn v1 ("classic") lockfiles. The format is not YAML: blocks of
 *
 *   "@babel/code-frame@^7.0.0", "@babel/code-frame@^7.10.4":
 *     version "7.12.13"
 *     resolved "https://registry.yarnpkg.com/@babel/code-frame/-/code-frame-7.12.13.tgz#dcfc8..."
 *     integrity sha512-...
 *     dependencies:
 *       "@babel/highlight" "^7.12.13"
 *
 * Each block is one installed package; its header lists every `name@range` that resolved to it.
 * There is no tree and no dev flag: what the project declares comes from package.json (the root's
 * and its workspaces'), and dev-only packages are worked out by reachability from those.
 * The reader is a single pass over the lines with no regular expression that can backtrack, and
 * it rejects anything it does not understand instead of guessing.
 */

/** A package.json (root or workspace), as far as the reader needs it. */
export interface Manifest {
  name?: unknown;
  version?: unknown;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
}

interface Block {
  line: number;
  specs: string[];
  fields: Map<string, string>;
  maps: Map<string, Map<string, string>>;
}

export interface YarnParseResult {
  dependencies: Dependency[];
  warnings: string[];
}

const fail = (line: number, why: string): never => {
  throw new UserError(`yarn.lock is not a yarn v1 lockfile patchpath can read (line ${line}: ${why}).`);
};

/** Reads a double-quoted string starting at `start` (a `"`); returns the value and the index after it. */
function quoted(text: string, start: number, line: number): [string, number] {
  let i = start + 1;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") i++;
    else if (ch === '"') break;
  }
  if (i >= text.length) fail(line, "unterminated string");
  try {
    return [JSON.parse(text.slice(start, i + 1)) as string, i + 1];
  } catch {
    return fail(line, "bad string escape");
  }
}

/** A key or value token: quoted, or bare up to the next space (or the end for a value). */
function token(text: string, start: number, line: number, toEnd: boolean): [string, number] {
  if (text[start] === '"') return quoted(text, start, line);
  let end = start;
  if (toEnd) end = text.length;
  else while (end < text.length && text[end] !== " " && text[end] !== ":") end++;
  return [text.slice(start, end).trim(), end];
}

/** `"a@^1", b@^2:` -> ["a@^1", "b@^2"]. */
function headerSpecs(text: string, line: number): string[] {
  if (!text.endsWith(":")) fail(line, "expected a `name@range:` header");
  const body = text.slice(0, -1);
  const specs: string[] = [];
  let i = 0;
  while (i < body.length) {
    while (body[i] === " ") i++;
    let spec: string;
    if (body[i] === '"') [spec, i] = quoted(body, i, line);
    else {
      const end = body.indexOf(",", i);
      spec = body.slice(i, end === -1 ? body.length : end).trim();
      i = end === -1 ? body.length : end;
    }
    if (!spec) fail(line, "empty package spec");
    specs.push(spec);
    while (body[i] === " ") i++;
    if (i < body.length) {
      if (body[i] !== ",") fail(line, "expected `,` between package specs");
      i++;
    }
  }
  if (!specs.length) fail(line, "empty header");
  return specs;
}

function readBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let block: Block | undefined;
  let map: Map<string, string> | undefined;
  const lines = text.split("\n");
  for (let n = 0; n < lines.length; n++) {
    const line = n + 1;
    const raw = (lines[n] as string).replace(/\r$/, "");
    if (!raw.trim() || raw.startsWith("#")) continue;
    let indent = 0;
    while (raw[indent] === " ") indent++;
    if (raw[indent] === "\t") fail(line, "tab indentation");
    const body = raw.slice(indent).trimEnd();
    if (indent === 0) {
      block = { line, specs: headerSpecs(body, line), fields: new Map(), maps: new Map() };
      blocks.push(block);
      map = undefined;
      continue;
    }
    if (!block) return fail(line, "indented line before the first package");
    if (indent === 2) {
      let [key, i] = token(body, 0, line, false);
      if (!key) fail(line, "missing key");
      if (body[i] === ":") i++;
      const rest = body.slice(i).trim();
      if (!rest) {
        // `dependencies:` and friends open a nested map.
        map = new Map();
        block.maps.set(key, map);
        continue;
      }
      map = undefined;
      const [value] = token(rest, 0, line, true);
      block.fields.set(key, value);
      continue;
    }
    if (indent === 4) {
      if (!map) return fail(line, "nested entry outside a dependency list");
      let [key, i] = token(body, 0, line, false);
      if (!key) fail(line, "missing dependency name");
      if (body[i] === ":") i++;
      const [value] = token(body.slice(i).trim(), 0, line, true);
      map.set(key, value);
      continue;
    }
    fail(line, `unexpected indentation (${indent} spaces)`);
  }
  return blocks;
}

/** `name@range` -> name and range; a scoped name keeps its leading `@`. */
function splitSpec(spec: string): { name: string; range: string } | undefined {
  const at = spec.indexOf("@", 1);
  if (at <= 0) return undefined;
  return { name: spec.slice(0, at), range: spec.slice(at + 1) };
}

/** A dist-tag such as `latest` or `next`: letters, digits, `.`, `_`, `-`, no `:` or `/`. */
const DIST_TAG = /^[A-Za-z][A-Za-z0-9._-]*$/;

/**
 * True when `range` can only mean "a version from the registry": a semver range or a dist-tag.
 * git, GitHub shorthands (`user/repo`), URLs, `file:`, `link:` and the like never count, whatever
 * `resolved` says.
 */
function registryRange(range: string): boolean {
  if (range.length > 200) return false;
  return validRange(range) !== null || DIST_TAG.test(range);
}

/** The installed package a block describes: real name (aliases unwrapped) and whether every spec is a registry one. */
function identify(specs: string[]): { name: string; registry: boolean; invalidName: boolean; mixed: boolean } | undefined {
  let name: string | undefined;
  let registry = true;
  let invalidName = false;
  let mixed = false;
  for (const spec of specs) {
    const split = splitSpec(spec);
    if (!split) return undefined;
    let { range } = split;
    let real = split.name;
    if (!isValidNpmName(split.name)) invalidName = true;
    // `alias@npm:real@range`
    if (range.startsWith("npm:")) {
      const inner = splitSpec(range.slice(4));
      if (!inner) {
        registry = false;
        continue;
      }
      real = inner.name;
      range = inner.range;
      if (!isValidNpmName(real)) invalidName = true;
    }
    if (!registryRange(range)) registry = false;
    if (name === undefined) name = real;
    // One block, several real names: not something yarn writes. Check nothing in it.
    else if (name !== real) {
      registry = false;
      mixed = true;
    }
  }
  return name === undefined ? undefined : { name, registry, invalidName, mixed };
}

/**
 * Parses a yarn v1 lockfile into the flat dependency list. `manifests` are the project's
 * package.json files (root first, then workspaces); without them (undefined) the reader cannot
 * tell direct and dev packages apart and reports every package as transitive production code.
 */
export function parseYarnLockfile(
  text: string,
  manifests: Manifest[] | undefined,
  options: ParseOptions = {},
): YarnParseResult {
  if (text.length > MAX_LOCKFILE_BYTES) throw new UserError("yarn.lock is too large to read (over 64 MB).");
  const clean = text.replace(/^﻿/, "");
  if (/^__metadata:/m.test(clean)) {
    throw new UserError("yarn.lock is a yarn v2+ (berry) lockfile, which is not supported yet. Only yarn v1 lockfiles are read.");
  }
  const registries = [...PUBLIC_REGISTRIES, ...(options.registries ?? []).map(normalizeRegistry)];
  const assumePublic = options.assumePublic ?? false;
  const warnings: string[] = [];
  if (!/^# yarn lockfile v1\s*$/m.test(clean)) {
    warnings.push("yarn.lock has no `# yarn lockfile v1` header; it was read as a yarn v1 lockfile.");
  }

  const blocks = readBlocks(clean);
  if (!blocks.length) throw new UserError("yarn.lock has no packages. Run `yarn install` first.");

  const nodes = new Map<string, GraphPackage>();
  const bySpec = new Map<string, string>();
  const depMaps = new Map<string, Map<string, string>[]>();
  blocks.forEach((block, index) => {
    const id = String(index);
    const who = identify(block.specs);
    if (!who) fail(block.line, "a package spec without `@range`");
    const { name, registry, invalidName, mixed } = who as NonNullable<typeof who>;
    const version = block.fields.get("version");
    if (!version) return fail(block.line, "package without a version");
    const resolved = block.fields.get("resolved");
    const origin: Origin = registry ? tarballOrigin(resolved, name, version, registries, assumePublic) : "external";
    nodes.set(id, { name, version, origin, invalidName, ...(mixed ? { mixedHeader: true } : {}), deps: [] });
    for (const spec of block.specs) bySpec.set(spec, id);
    depMaps.set(
      id,
      ["dependencies", "optionalDependencies"].flatMap((key) => (block.maps.has(key) ? [block.maps.get(key) as Map<string, string>] : [])),
    );
  });

  let missing = 0;
  for (const [id, maps] of depMaps) {
    const node = nodes.get(id) as GraphPackage;
    for (const map of maps) {
      for (const [dep, range] of map) {
        const target = bySpec.get(`${dep}@${range}`);
        if (target === undefined) missing++;
        else node.deps.push(target);
      }
    }
  }
  if (missing) {
    warnings.push(
      `${missing} dependency reference${missing === 1 ? "" : "s"} in yarn.lock ${missing === 1 ? "has" : "have"} no matching entry ` +
        `(the lockfile may be out of date): chains and the dev/production split may be incomplete.`,
    );
  }

  const prodRoots: string[] = [];
  const devRoots: string[] = [];
  let undeclared = 0;
  // Workspace packages by name: yarn links them and never writes a lockfile entry for them.
  const workspaceVersions = new Map<string, string>();
  for (const manifest of manifests ?? []) {
    if (typeof manifest.name === "string" && typeof manifest.version === "string") workspaceVersions.set(manifest.name, manifest.version);
  }
  const isWorkspaceLink = (dep: string, range: string): boolean => {
    const version = workspaceVersions.get(dep);
    if (version === undefined) return false;
    if (range.startsWith("workspace:") || range === "*" || range === "" || range === "latest") return true;
    try {
      return satisfies(version, range);
    } catch {
      return false;
    }
  };
  for (const manifest of manifests ?? []) {
    const sections: [Record<string, unknown> | undefined, string[]][] = [
      [manifest.dependencies, prodRoots],
      [manifest.optionalDependencies, prodRoots],
      [manifest.devDependencies, devRoots],
    ];
    for (const [section, roots] of sections) {
      if (!section || typeof section !== "object") continue;
      for (const [dep, range] of Object.entries(section)) {
        if (typeof range !== "string") continue;
        const target = bySpec.get(`${dep}@${range}`);
        if (target !== undefined) roots.push(target);
        else if (isWorkspaceLink(dep, range)) continue;
        else if (registryRange(range) || range.startsWith("npm:")) undeclared++;
      }
    }
  }
  if (undeclared) {
    warnings.push(
      `${undeclared} dependenc${undeclared === 1 ? "y" : "ies"} declared in package.json ${undeclared === 1 ? "has" : "have"} no yarn.lock entry ` +
        `(run yarn install): ${undeclared === 1 ? "it is" : "they are"} not in the report.`,
    );
  }
  if (!manifests) {
    warnings.push(
      "No package.json next to yarn.lock: direct and dev-only packages cannot be told apart, so every package is " +
        "reported as a transitive production dependency (no lag check, --no-dev hides nothing).",
    );
  }

  return { dependencies: flattenGraph({ nodes, prodRoots, devRoots, rootsKnown: manifests !== undefined }), warnings };
}
