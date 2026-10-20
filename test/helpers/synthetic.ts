import type { Advisory, Doc } from "./fake-registry.js";

export interface SyntheticOptions {
  packages: number;
  /** Dependencies per package (to packages further down the list, so the tree has no cycles). */
  edges: number;
  direct: number;
  vulnerable: number;
  seed?: number;
}

/**
 * A large flat v3 lockfile with random dependency edges, registry documents for every package
 * (1.0.0, 1.0.1, 1.1.0 and 2.0.0) and advisories fixed in 1.1.0 for `vulnerable` of them.
 */
export function syntheticProject({ packages, edges, direct, vulnerable, seed = 42 }: SyntheticOptions) {
  let state = seed;
  const random = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  const name = (i: number) => `pkg-${i}`;
  const lock: Record<string, unknown> = { "": { dependencies: {} } };
  const registry: Record<string, Doc> = {};
  for (let i = 0; i < packages; i++) {
    const deps: Record<string, string> = {};
    for (let k = 0; k < edges; k++) {
      const j = Math.floor(random() * packages);
      if (j === i) continue;
      deps[name(j)] = "^1.0.0";
    }
    lock[`node_modules/${name(i)}`] = {
      version: "1.0.0",
      resolved: `https://registry.npmjs.org/${name(i)}/-/${name(i)}-1.0.0.tgz`,
      dependencies: deps,
    };
    const next = Object.fromEntries(Object.keys(deps).map((d) => [d, "^1.1.0"]));
    registry[name(i)] = {
      latest: "1.1.0",
      versions: { "1.0.0": { dependencies: deps }, "1.0.1": { dependencies: deps }, "1.1.0": { dependencies: next }, "2.0.0": { dependencies: next } },
    };
  }
  for (let i = 0; i < direct; i++) (lock[""] as { dependencies: Record<string, string> }).dependencies[name(i)] = "^1.0.0";
  const advisories: Advisory[] = [];
  const picked = new Set<number>();
  while (picked.size < Math.min(vulnerable, packages)) picked.add(Math.floor(random() * packages));
  for (const i of picked) advisories.push({ id: `GHSA-syn-${i}`, name: name(i), fixed: "1.1.0" });
  return { lock, registry, advisories };
}
