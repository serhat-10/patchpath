import type { UpdateGap } from "./types.js";

interface Parsed {
  core: [number, number, number];
  pre: string[];
}

/** Parsed versions, kept because the planner compares the same few thousand versions over and over. */
const parsed = new Map<string, Parsed | null>();

function parse(version: string): Parsed | null {
  let result = parsed.get(version);
  if (result === undefined) {
    result = parseUncached(version);
    if (parsed.size > 100_000) parsed.clear();
    parsed.set(version, result);
  }
  return result;
}

function parseUncached(version: string): Parsed | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split(".") : [],
  };
}

export const isValidVersion = (version: string): boolean => parse(version) !== null;

export const isPrerelease = (version: string): boolean => (parse(version)?.pre.length ?? 0) > 0;

const isNumeric = (s: string) => /^\d+$/.test(s);

function comparePre(a: string[], b: string[]): number {
  // A version without a prerelease tag is higher than the same version with one.
  if (!a.length || !b.length) return b.length - a.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (isNumeric(x) && isNumeric(y)) return Number(x) - Number(y);
    if (isNumeric(x)) return -1;
    if (isNumeric(y)) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Semver precedence. Unparseable versions compare equal to everything. */
export function compareVersions(a: string, b: string): number {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) {
    const diff = (x.core[i] as number) - (y.core[i] as number);
    if (diff !== 0) return diff;
  }
  return comparePre(x.pre, y.pre);
}

/**
 * True when moving from `from` to `to` can break callers under semver: a new major,
 * a new minor while still on 0.x, or a new patch while on 0.0.x (the same lines npm's
 * caret ranges use: ^1.2.3, ^0.2.3 and ^0.0.3).
 */
export function crossesBreaking(from: string, to: string): boolean {
  const a = parse(from);
  const b = parse(to);
  if (!a || !b) return false;
  if (a.core[0] !== b.core[0]) return true;
  if (a.core[0] !== 0) return false;
  if (a.core[1] !== b.core[1]) return true;
  return a.core[1] === 0 && a.core[2] !== b.core[2];
}

/**
 * How far `installed` is behind `latest`, or null when it is current, newer, or unparseable.
 * This names the semver position that differs, so 0.1.0 -> 0.2.0 is a "minor" gap even though
 * `crossesBreaking` treats it as breaking; the two answer different questions.
 */
export function updateGap(installed: string, latest: string): UpdateGap | null {
  const a = parse(installed);
  const b = parse(latest);
  if (!a || !b || compareVersions(installed, latest) >= 0) return null;
  const names: UpdateGap[] = ["major", "minor", "patch"];
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return names[i] as UpdateGap;
  }
  return "patch";
}
