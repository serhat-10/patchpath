import { describe, expect, it } from "vitest";
import { scan } from "../src/core/scan.js";
import type { Doc } from "./helpers/fake-registry.js";
import { net, pub, useFakeNetwork, writeLock, writePackageJson } from "./helpers/fake-registry.js";

useFakeNetwork();

type Sev = "CRITICAL" | "HIGH" | "MODERATE" | "LOW" | "WEIRD";
const ids = (prefix: string, n: number, name: string, severity: Sev, fixed?: string) =>
  Array.from({ length: n }, (_, i) => ({ id: `GHSA-${prefix}${i}`, name, severity, ...(fixed ? { fixed } : {}) }));

/** app 1.0.0 depends on shared 1.0.0; app 1.1.0 depends on shared 1.1.0 plus the extra dependencies. */
function setup(extra: Record<string, string>, extraDocs: Record<string, Doc> = {}) {
  net.registry = {
    shared: { versions: { "1.0.0": {}, "1.1.0": {} } },
    app: {
      versions: {
        "1.0.0": { dependencies: { shared: "1.0.0" } },
        "1.1.0": { dependencies: { shared: "1.1.0", ...extra } },
      },
    },
    newdep: { versions: { "1.0.0": {} } },
    ...extraDocs,
  };
  writeLock({
    "": { dependencies: { app: "^1.0.0" } },
    "node_modules/app": pub("app", "1.0.0", { dependencies: { shared: "1.0.0" } }),
    "node_modules/shared": pub("shared", "1.0.0"),
  });
}
const run = async () => {
  const r = await scan(net.dir, { cache: false });
  return { r, app: r.plan.find((e) => e.name === "app")! };
};

describe("severity weighting of cleared versus brought-in advisories", () => {
  it("keeps one critical cleared against three low brought in", async () => {
    net.advisories = [...ids("c", 1, "shared", "CRITICAL", "1.1.0"), ...ids("n", 3, "newdep", "LOW")];
    setup({ newdep: "1.0.0" });
    const { app, r } = await run();
    expect(app.status).toBe("upgrade");
    expect(r.planSummary?.advisoriesIntroduced).toBe(3);
  });
  it("rejects three low cleared against one critical brought in", async () => {
    net.advisories = [...ids("c", 3, "shared", "LOW", "1.1.0"), ...ids("n", 1, "newdep", "CRITICAL")];
    setup({ newdep: "1.0.0" });
    const { app } = await run();
    expect(app.status).toBe("no-fix");
    expect(app.reason).toMatch(/clears 3 but brings in 1 \(newdep@1\.0\.0\)/);
  });
  it("rejects a tie: one high cleared, one high brought in", async () => {
    net.advisories = [...ids("c", 1, "shared", "HIGH", "1.1.0"), ...ids("n", 1, "newdep", "HIGH")];
    setup({ newdep: "1.0.0" });
    expect((await run()).app.status).toBe("no-fix");
  });
  it("weighs an advisory without a severity like a moderate one", async () => {
    net.advisories = [...ids("c", 1, "shared", "HIGH", "1.1.0"), ...ids("n", 5, "newdep", "WEIRD")];
    setup({ newdep: "1.0.0" });
    expect((await run()).app.status).toBe("upgrade");
    net.advisories = [...ids("c", 1, "shared", "LOW", "1.1.0"), ...ids("n", 1, "newdep", "MODERATE")];
    expect((await run()).app.status).toBe("no-fix");
  });
});

describe("added packages whose registry data is missing", () => {
  const unchecked = (app: { reason?: string; remaining?: unknown }) =>
    /newdep|unchecked|not checked|could not|unknown/i.test(`${app.reason ?? ""} ${JSON.stringify(app.remaining ?? [])}`);
  it("does not crash and does not silently recommend when the added package is a 404", async () => {
    net.advisories = [...ids("c", 1, "shared", "HIGH", "1.1.0"), ...ids("n", 3, "newdep", "CRITICAL")];
    setup({ newdep: "1.0.0" });
    delete net.registry.newdep;
    const { app } = await run();
    expect(app.status !== "upgrade" || unchecked(app)).toBe(true);
  });
  it("does not silently recommend when no version of the added package satisfies the range", async () => {
    net.advisories = [...ids("c", 1, "shared", "HIGH", "1.1.0")];
    setup({ newdep: "^9.0.0" });
    const { app } = await run();
    expect(app.status !== "upgrade" || unchecked(app)).toBe(true);
  });
  it("handles a cycle through added packages", async () => {
    net.advisories = [...ids("c", 1, "shared", "HIGH", "1.1.0")];
    setup(
      { a: "1.0.0" },
      { a: { versions: { "1.0.0": { dependencies: { b: "1.0.0" } } } }, b: { versions: { "1.0.0": { dependencies: { a: "1.0.0" } } } } },
    );
    const { app } = await run();
    expect(["upgrade", "no-fix"]).toContain(app.status);
  });
});

describe("added packages of other kinds", () => {
  it("looks up an alias target by its real name", async () => {
    net.advisories = [...ids("c", 4, "shared", "HIGH", "1.1.0"), ...ids("n", 3, "newdep", "HIGH")];
    setup({ alias: "npm:newdep@1.0.0" });
    const { r } = await run();
    expect(net.registryPaths).toContain("/newdep");
    expect(r.planSummary?.advisoriesIntroduced).toBe(3);
  });
  it("looks up a scoped added package", async () => {
    net.advisories = [...ids("c", 4, "shared", "HIGH", "1.1.0"), ...ids("n", 3, "@s/dep", "HIGH")];
    setup({ "@s/dep": "1.0.0" }, { "@s/dep": { versions: { "1.0.0": {} } } });
    const { r } = await run();
    expect(r.planSummary?.advisoriesIntroduced).toBe(3);
  });
  it("does not query the registry for git, file or tarball dependencies", async () => {
    net.advisories = ids("c", 1, "shared", "HIGH", "1.1.0");
    setup({ g: "github:user/repo", f: "file:../x", t: "https://example.com/x.tgz" });
    const { app } = await run();
    expect(app).toBeDefined();
    expect(net.registryPaths.filter((p) => ["/g", "/f", "/t"].includes(p))).toEqual([]);
  });
  it("does not follow the dependencies of an added package", async () => {
    net.advisories = [...ids("c", 4, "shared", "HIGH", "1.1.0"), ...ids("n", 3, "deep", "CRITICAL")];
    setup({ newdep: "1.0.0" }, { newdep: { versions: { "1.0.0": { dependencies: { deep: "1.0.0" } } } }, deep: { versions: { "1.0.0": {} } } });
    const { r } = await run();
    expect(r.planSummary?.advisoriesIntroduced).toBeUndefined();
    expect(net.registryPaths).not.toContain("/deep");
  });
});

describe("added packages and dev dependencies", () => {
  it("does not count a package that the new version only lists as a devDependency", async () => {
    net.advisories = [...ids("c", 1, "shared", "HIGH", "1.1.0"), ...ids("n", 3, "newdep", "CRITICAL")];
    setup({});
    net.registry.app!.versions["1.1.0"] = { dependencies: { shared: "1.1.0" }, devDependencies: { newdep: "1.0.0" } } as never;
    const { app, r } = await run();
    expect(app.status).toBe("upgrade");
    expect(r.planSummary?.advisoriesIntroduced).toBeUndefined();
  });
});

describe("request counts for added packages", () => {
  it("makes no extra registry request when no candidate adds a package", async () => {
    net.advisories = ids("c", 1, "shared", "HIGH", "1.1.0");
    setup({});
    await run();
    expect([...new Set(net.registryPaths)].sort()).toEqual(["/app", "/shared"]);
  });
  it("asks the registry once for a package that twenty candidates add", async () => {
    net.advisories = ids("c", 1, "shared", "HIGH", "1.20.0");
    const versions: Record<string, { dependencies: Record<string, string> }> = { "1.0.0": { dependencies: { shared: "1.0.0" } } };
    const shared: Record<string, object> = { "1.0.0": {} };
    for (let i = 1; i <= 20; i++) {
      versions[`1.${i}.0`] = { dependencies: { shared: `1.${i}.0`, newdep: "1.0.0" } };
      shared[`1.${i}.0`] = {};
    }
    net.registry = { app: { versions }, shared: { versions: shared }, newdep: { versions: { "1.0.0": {} } } };
    writeLock({
      "": { dependencies: { app: "^1.0.0" } },
      "node_modules/app": pub("app", "1.0.0", { dependencies: { shared: "1.0.0" } }),
      "node_modules/shared": pub("shared", "1.0.0"),
    });
    await scan(net.dir, { cache: false });
    expect(net.registryPaths.filter((p) => p === "/newdep").length).toBe(1);
    expect(net.requests.filter((q) => q.includes("/v1/querybatch")).length).toBeLessThanOrEqual(3);
  });
});

describe("plan summary when two upgrades add the same vulnerable package", () => {
  it("counts the brought-in advisories once and keeps the other numbers consistent", async () => {
    net.advisories = [
      ...ids("a", 2, "shared", "HIGH", "1.1.0"),
      ...ids("b", 2, "shared2", "HIGH", "1.1.0"),
      ...ids("n", 2, "newdep", "LOW"),
    ];
    const lib = (s: string) => ({
      versions: {
        "1.0.0": { dependencies: { [s]: "1.0.0" } },
        "1.1.0": { dependencies: { [s]: "1.1.0", newdep: "1.0.0" } },
      },
    });
    net.registry = {
      app: lib("shared"),
      app2: lib("shared2"),
      shared: { versions: { "1.0.0": {}, "1.1.0": {} } },
      shared2: { versions: { "1.0.0": {}, "1.1.0": {} } },
      newdep: { versions: { "1.0.0": {} } },
    };
    writeLock({
      "": { dependencies: { app: "~1.0.0", app2: "~1.0.0" } },
      "node_modules/app": pub("app", "1.0.0", { dependencies: { shared: "1.0.0" } }),
      "node_modules/app2": pub("app2", "1.0.0", { dependencies: { shared2: "1.0.0" } }),
      "node_modules/shared": pub("shared", "1.0.0"),
      "node_modules/shared2": pub("shared2", "1.0.0"),
    });
    const { r } = await run();
    const s = r.planSummary!;
    expect(r.plan.map((e) => e.status)).toEqual(["upgrade", "upgrade"]);
    expect(s.advisoriesTotal).toBe(4);
    expect(s.advisoriesEliminated).toBe(4);
    expect(s.advisoriesIntroduced).toBe(2);
    expect(s.pathsFixed + s.pathsRemaining).toBe(s.pathsTotal);
    expect(s.pathsFixed).toBe(2);
  });
});

describe("determinism with added packages", () => {
  it("gives the same JSON twice", async () => {
    net.advisories = [...ids("c", 4, "shared", "HIGH", "1.1.0"), ...ids("n", 3, "newdep", "HIGH")];
    setup({ newdep: "1.0.0" });
    writePackageJson({ name: "x", dependencies: { app: "^1.0.0" } });
    const a = await scan(net.dir, { cache: false });
    const b = await scan(net.dir, { cache: false });
    const strip = (r: typeof a) => JSON.stringify({ ...r, requests: undefined, scannedAt: undefined });
    expect(strip(a)).toBe(strip(b));
  });
});
