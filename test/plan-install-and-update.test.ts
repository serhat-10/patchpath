import { describe, expect, it } from "vitest";
import { formatText } from "../src/core/format.js";
import { scan } from "../src/core/scan.js";
import { net, pub, useFakeNetwork, writeLock } from "./helpers/fake-registry.js";

useFakeNetwork();

const safe = (r: Awaited<ReturnType<typeof scan>>) => (r.commands ?? []).find((c) => c.kind === "safe");

describe("a name that the safe step installs directly", () => {
  it("is also in npm update when another copy of that name is cleared by an in-range update", async () => {
    net.advisories = [{ id: "GHSA-x", name: "x", fixed: "1.2.0" }];
    net.registry = {
      x: { versions: { "0.5.0": {}, "1.0.0": {}, "1.2.0": {} } },
      holder: { versions: { "1.0.0": { dependencies: { x: "<2.0.0" } } } },
    };
    writeLock({
      "": { dependencies: { x: "^1.0.0", holder: "^1.0.0" } },
      "node_modules/x": pub("x", "1.0.0"),
      "node_modules/holder": pub("holder", "1.0.0", { dependencies: { x: "<2.0.0" } }),
      "node_modules/holder/node_modules/x": pub("x", "0.5.0"),
    });
    const cmd = safe(await scan(net.dir, { cache: false }));
    expect(cmd?.install).toContain("x@1.2.0");
    expect(cmd?.update).toContain("x");
  });

  it("is left out of npm update when the install moves every copy of it", async () => {
    net.advisories = [{ id: "GHSA-x", name: "x", fixed: "1.2.0" }];
    net.registry = { x: { versions: { "1.0.0": {}, "1.2.0": {} } } };
    writeLock({
      "": { dependencies: { x: "^1.0.0" } },
      "node_modules/x": pub("x", "1.0.0"),
    });
    const cmd = safe(await scan(net.dir, { cache: false }));
    expect(cmd?.install).toContain("x@1.2.0");
    expect(cmd?.update ?? []).not.toContain("x");
  });
});

describe("the npm update line in the text output", () => {
  const count = (text: string, line: string) => text.split("\n").filter((l) => l.trim() === line).length;

  it("is printed twice after an install, and the JSON update list stays as it is", async () => {
    net.advisories = [{ id: "GHSA-x", name: "x", fixed: "1.2.0" }];
    net.registry = {
      x: { versions: { "0.5.0": {}, "1.0.0": {}, "1.2.0": {} } },
      holder: { versions: { "1.0.0": { dependencies: { x: "<2.0.0" } } } },
    };
    writeLock({
      "": { dependencies: { x: "^1.0.0", holder: "^1.0.0" } },
      "node_modules/x": pub("x", "1.0.0"),
      "node_modules/holder": pub("holder", "1.0.0", { dependencies: { x: "<2.0.0" } }),
      "node_modules/holder/node_modules/x": pub("x", "0.5.0"),
    });
    const report = await scan(net.dir, { cache: false });
    const cmd = safe(report);
    expect(cmd?.install).toContain("x@1.2.0");
    expect(cmd?.update).toEqual(["x"]);
    const text = formatText(report);
    expect(count(text, "npm install -- x@1.2.0")).toBe(1);
    expect(count(text, "npm update -- x")).toBe(2);
  });

  it("is printed once when the step has no install", async () => {
    net.advisories = [{ id: "GHSA-y", name: "y", fixed: "1.2.0" }];
    net.registry = {
      app: { versions: { "1.0.0": { dependencies: { y: "^1.0.0" } } } },
      y: { versions: { "1.0.0": {}, "1.2.0": {} } },
    };
    writeLock({
      "": { dependencies: { app: "^1.0.0" } },
      "node_modules/app": pub("app", "1.0.0", { dependencies: { y: "^1.0.0" } }),
      "node_modules/y": pub("y", "1.0.0"),
    });
    const report = await scan(net.dir, { cache: false });
    const cmd = safe(report);
    expect(cmd?.install ?? []).toEqual([]);
    expect(cmd?.update).toEqual(["y"]);
    expect(count(formatText(report), "npm update -- y")).toBe(1);
  });
});
