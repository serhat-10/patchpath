import { describe, expect, it } from "vitest";
import { scan } from "../src/core/scan.js";
import { net, useFakeNetwork, writeLock } from "./helpers/fake-registry.js";
import { syntheticProject, type SyntheticOptions } from "./helpers/synthetic.js";

// The full-size case (3400 packages) takes a while; run it with PATCHPATH_BENCH=1 npx vitest run test/plan-perf.test.ts
const FULL: SyntheticOptions = { packages: 3400, edges: 6, direct: 200, vulnerable: 400 };
const SMALL: SyntheticOptions = { packages: 700, edges: 6, direct: 40, vulnerable: 80 };

async function timed(options: SyntheticOptions, plan = true) {
  const project = syntheticProject(options);
  writeLock(project.lock);
  net.registry = project.registry;
  net.advisories = project.advisories;
  const started = performance.now();
  const report = await scan(net.dir, { cache: false, plan });
  return { report, ms: performance.now() - started };
}

describe("plan performance on a large synthetic lockfile", () => {
  useFakeNetwork();

  it("stays fast on a sized-down tree", async () => {
    const { report, ms } = await timed(SMALL);
    expect(report.plan.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(10_000);
  }, 60_000);

  it.skipIf(!process.env.PATCHPATH_BENCH)(
    "full size (benchmark)",
    async () => {
      const base = await timed(FULL, false);
      const { report, ms } = await timed(FULL);
      console.log(
        `synthetic ${FULL.packages} packages: --no-plan ${(base.ms / 1000).toFixed(1)} s, with plan ${(ms / 1000).toFixed(1)} s, ` +
          `${report.plan.length} plan entries (${report.plan.filter((e) => e.status === "unavailable").length} unavailable), ` +
          `${report.warnings.filter((w) => w.startsWith("Upgrade plan")).join(" | ")}`,
      );
      expect(ms).toBeLessThan(15_000 + base.ms);
      // What the work limit cut off is said, not guessed.
      const skipped = report.plan.filter((e) => e.reason?.includes("work limit"));
      if (skipped.length) expect(report.warnings.some((w) => w.includes("work limit reached"))).toBe(true);
      expect(skipped.every((e) => e.status === "unavailable" && !e.target)).toBe(true);
    },
    600_000,
  );
});
