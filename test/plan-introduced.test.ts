import { describe, expect, it } from "vitest";
import { formatText } from "../src/core/format.js";
import { scan } from "../src/core/scan.js";
import { net, pub, useFakeNetwork, writeLock } from "./helpers/fake-registry.js";

useFakeNetwork();

const base = (appNext: Record<string, unknown>, extraLock: Record<string, unknown> = {}) => {
  writeLock({
    "": { dependencies: { app: "^1.0.0", beta: "^1.0.0" } },
    "node_modules/app": pub("app", "1.0.0", { dependencies: { shared: "^1.0.0" } }),
    "node_modules/beta": pub("beta", "1.0.0", { dependencies: { shared: "~1.0.0" } }),
    "node_modules/shared": pub("shared", "1.0.0"),
    ...extraLock,
  });
  net.advisories = [{ id: "GHSA-shared", name: "shared", fixed: "1.2.0" }];
  net.registry = {
    shared: { versions: { "1.0.0": {}, "1.2.0": {} } },
    beta: { versions: { "1.0.0": { dependencies: { shared: "~1.0.0" } } } },
    app: { versions: { "1.0.0": { dependencies: { shared: "^1.0.0" } }, "1.1.0": appNext } },
    fresh: { versions: { "1.0.0": {} } },
    other: { versions: { "1.0.0": {} } },
  };
};
const appStatus = async () => {
  const r = await scan(net.dir, { cache: false });
  return { r, status: r.plan.find((e) => e.name === "app")?.status, cmds: JSON.stringify(r.commands ?? []) };
};

describe("path-only candidates and added dependencies", () => {
  it("is recommended when it adds nothing", async () => {
    base({ dependencies: { shared: "^1.2.0" } });
    expect((await appStatus()).status).toBe("upgrade");
  });
  it("is dropped when it adds a dependency that is not vulnerable", async () => {
    base({ dependencies: { shared: "^1.2.0", fresh: "^1.0.0" } });
    expect((await appStatus()).status).toBe("no-fix");
  });
  it("is dropped when it swaps one dependency for another", async () => {
    base({ dependencies: { shared: "^1.2.0", other: "^1.0.0" } }, {
      "node_modules/gone": pub("gone", "1.0.0"),
    });
    net.registry.app!.versions["1.0.0"] = { dependencies: { shared: "^1.0.0", gone: "^1.0.0" } };
    expect((await appStatus()).status).toBe("no-fix");
  });
  it("is kept when it only removes a dependency", async () => {
    base({ dependencies: { shared: "^1.2.0" } });
    net.registry.app!.versions["1.0.0"] = { dependencies: { shared: "^1.0.0", gone: "^1.0.0" } };
    expect((await appStatus()).status).toBe("upgrade");
  });
  it("is kept when it adds only an optional peer dependency", async () => {
    base({ dependencies: { shared: "^1.2.0" }, peerDependencies: { other: "^1.0.0" }, peerDependenciesMeta: { other: { optional: true } } });
    expect((await appStatus()).status).toBe("upgrade");
  });
  it("is kept when the added dependency is already installed at a safe version", async () => {
    base({ dependencies: { shared: "^1.2.0", other: "^1.0.0" } }, { "node_modules/other": pub("other", "1.0.0") });
    expect((await appStatus()).status).toBe("upgrade");
  });
});

describe("clearing candidates that introduce advisories", () => {
  it("reports advisories brought in by a newly added dependency", async () => {
    net.advisories = [
      { id: "GHSA-a", name: "shared", fixed: "1.1.0" },
      // Four cleared against three introduced: net positive, so the upgrade is kept and the three are reported.
      ...["b", "c", "d"].map((x) => ({ id: `GHSA-${x}`, name: "shared", fixed: "1.1.0" })),
      ...[1, 2, 3].map((i) => ({ id: `GHSA-n${i}`, name: "newdep" })),
    ];
    net.registry = {
      shared: { versions: { "1.0.0": {}, "1.1.0": {} } },
      newdep: { versions: { "1.0.0": {} } },
      app: { versions: { "1.0.0": { dependencies: { shared: "1.0.0" } }, "1.1.0": { dependencies: { shared: "1.1.0", newdep: "1.0.0" } } } },
    };
    writeLock({
      "": { dependencies: { app: "^1.0.0" } },
      "node_modules/app": pub("app", "1.0.0", { dependencies: { shared: "1.0.0" } }),
      "node_modules/shared": pub("shared", "1.0.0"),
    });
    const r = await scan(net.dir, { cache: false });
    expect(r.planSummary?.advisoriesIntroduced).toBe(3);
    expect(formatText(r)).toContain("Advisories introduced: 3");
  });
});

describe("in-range credit re-run", () => {
  const setup = (twoDemoted: boolean) => {
    net.advisories = [
      { id: "GHSA-s1", name: "shared", fixed: "1.2.0" },
      { id: "GHSA-s2", name: "shared2", fixed: "1.2.0" },
    ];
    net.registry = {
      shared: { versions: { "1.0.0": {}, "1.2.0": {} } },
      shared2: { versions: { "1.0.0": {}, "1.2.0": {} } },
      react: { versions: { "1.0.0": {} } },
      alpha: { versions: { "1.0.0": { dependencies: { mid: "^1.0.0" } }, "2.0.0": { dependencies: { shared: "^1.2.0" } } } },
      mid: {
        versions: {
          "1.0.0": { dependencies: { shared: "~1.0.0" } },
          "1.0.5": { dependencies: { shared: "^1.2.0" }, peerDependencies: { react: "^99.0.0" } },
        },
      },
      gamma: { versions: { "1.0.0": { dependencies: { mid2: "^1.0.0" } }, "2.0.0": { dependencies: { shared2: "^1.2.0" } } } },
      mid2: { versions: { "1.0.0": { dependencies: { shared2: "~1.0.0" } }, "1.0.5": { dependencies: { shared2: "^1.2.0" } } } },
    };
    writeLock({
      "": { dependencies: { alpha: "^1.0.0", react: "^1.0.0", ...(twoDemoted ? { gamma: "^1.0.0" } : {}) } },
      "node_modules/alpha": pub("alpha", "1.0.0", { dependencies: { mid: "^1.0.0" } }),
      "node_modules/mid": pub("mid", "1.0.0", { dependencies: { shared: "~1.0.0" } }),
      "node_modules/react": pub("react", "1.0.0"),
      "node_modules/shared": pub("shared", "1.0.0"),
      ...(twoDemoted
        ? {
            "node_modules/gamma": pub("gamma", "1.0.0", { dependencies: { mid2: "^1.0.0" } }),
            "node_modules/mid2": pub("mid2", "1.0.0", { dependencies: { shared2: "~1.0.0" } }),
            "node_modules/shared2": pub("shared2", "1.0.0"),
          }
        : {}),
    });
  };
  it("restores credit only for the breaking upgrade whose in-range update is not in a command, deterministically", async () => {
    setup(true);
    const a = await scan(net.dir, { cache: false });
    const b = await scan(net.dir, { cache: false });
    const strip = (r: typeof a) => JSON.stringify({ ...r, requests: undefined, scannedAt: undefined });
    expect(strip(a)).toBe(strip(b));
    const safe = (a.commands ?? []).filter((c) => c.kind === "safe").flatMap((c) => c.update);
    expect(safe).toContain("mid2");
    expect(safe).not.toContain("mid");
    expect(a.plan.find((e) => e.name === "alpha")).toMatchObject({ status: "upgrade", target: "2.0.0" });
    expect(a.plan.find((e) => e.name === "gamma")?.status).not.toBe("upgrade");
    expect(a.planSummary?.advisoriesEliminated).toBe(2);
  });
  it("sends the same number of registry requests with and without a re-run", async () => {
    setup(false);
    await scan(net.dir, { cache: false });
    const rerun = net.requests.length;
    net.requests = [];
    // same tree, mid in range is fine: no demotion unmet, no re-run
    net.registry.mid!.versions["1.0.5"] = { dependencies: { shared: "^1.2.0" } };
    await scan(net.dir, { cache: false });
    
    expect(rerun).toBe(net.requests.length);
  });
});

describe("in-range credit when restoring one upgrade changes another's command", () => {
  it("leaves no advisory open that a plan command could clear", async () => {
    net.advisories = [
      { id: "GHSA-s1", name: "shared", fixed: "1.2.0" },
      { id: "GHSA-s2", name: "shared2", fixed: "1.2.0" },
    ];
    net.registry = {
      shared: { versions: { "1.0.0": {}, "1.2.0": {} } },
      shared2: { versions: { "1.0.0": {}, "1.2.0": {} } },
      react: { versions: { "1.0.0": {} } },
      alpha: { versions: { "1.0.0": { dependencies: { mid: "^1.0.0" } }, "2.0.0": { dependencies: { shared: "^1.2.0" } } } },
      mid: {
        versions: {
          "1.0.0": { dependencies: { shared: "~1.0.0" } },
          "1.0.5": { dependencies: { shared: "^1.2.0" }, peerDependencies: { react: "^99.0.0" } },
        },
      },
      gamma: { versions: { "1.0.0": { dependencies: { mid2: "^1.0.0" } }, "2.0.0": { dependencies: { shared2: "^1.2.0" } } } },
      mid2: {
        versions: {
          "1.0.0": { dependencies: { shared2: "~1.0.0" } },
          "1.0.5": { dependencies: { shared2: "^1.2.0" }, peerDependencies: { alpha: "^1.0.0" } },
        },
      },
    };
    writeLock({
      "": { dependencies: { alpha: "^1.0.0", react: "^1.0.0", gamma: "^1.0.0" } },
      "node_modules/alpha": pub("alpha", "1.0.0", { dependencies: { mid: "^1.0.0" } }),
      "node_modules/mid": pub("mid", "1.0.0", { dependencies: { shared: "~1.0.0" } }),
      "node_modules/react": pub("react", "1.0.0"),
      "node_modules/shared": pub("shared", "1.0.0"),
      "node_modules/gamma": pub("gamma", "1.0.0", { dependencies: { mid2: "^1.0.0" } }),
      "node_modules/mid2": pub("mid2", "1.0.0", { dependencies: { shared2: "~1.0.0" } }),
      "node_modules/shared2": pub("shared2", "1.0.0"),
    });
    const r = await scan(net.dir, { cache: false });
    expect(r.planSummary?.advisoriesEliminated).toBe(2);
  });
});
