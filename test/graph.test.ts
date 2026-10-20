import { describe, expect, it } from "vitest";
import { buildLockGraph, stripAlias } from "../src/core/graph.js";

const edges = (graph: ReturnType<typeof buildLockGraph>, path: string) =>
  graph?.nodes.get(path)?.in.map((e) => `${e.from || "<root>"} ${e.key}@${e.spec}${e.peer ? " (peer)" : ""}`).sort();

describe("buildLockGraph", () => {
  it("keeps every edge into a shared copy (v3), not only the shortest chain", () => {
    const graph = buildLockGraph(
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { d: "^4.7.0" }, devDependencies: { t: "^1.0.0" } },
          "node_modules/d": { version: "4.7.2", dependencies: { engine: "~6.5.0", adapter: "~2.5.2" } },
          "node_modules/engine": { version: "6.5.2", dependencies: { ws: "~8.11.0" } },
          "node_modules/adapter": { version: "2.5.2", dependencies: { ws: "~8.11.0" }, peerDependencies: { d: "^4.0.0" } },
          "node_modules/ws": { version: "8.11.0" },
          "node_modules/t": { version: "1.0.0", dev: true },
          "node_modules/t/node_modules/ws": { version: "7.0.0" },
        },
      }),
    );
    expect(edges(graph, "node_modules/ws")).toEqual(["node_modules/adapter ws@~8.11.0", "node_modules/engine ws@~8.11.0"]);
    expect(edges(graph, "node_modules/d")).toEqual(["<root> d@^4.7.0", "node_modules/adapter d@^4.0.0 (peer)"]);
    expect(edges(graph, "node_modules/t")).toEqual(["<root> t@^1.0.0"]);
    // Nothing declares the nested copy: no edge, but the node is there.
    expect(graph?.nodes.get("node_modules/t/node_modules/ws")?.in).toEqual([]);
    expect(graph?.locate("node_modules/t", "ws")).toBe("node_modules/t/node_modules/ws");
    expect(graph?.locate("node_modules/engine", "ws")).toBe("node_modules/ws");
  });

  it("marks bundled copies with the package that bundles them, through nested bundles", () => {
    const graph = buildLockGraph(
      JSON.stringify({
        lockfileVersion: 2,
        packages: {
          "": { dependencies: { npm: "^3.0.0" } },
          "node_modules/npm": { version: "3.10.10", dependencies: { tar: "~2.2.1" } },
          "node_modules/npm/node_modules/tar": { version: "2.2.1", inBundle: true, dependencies: { fstream: "^1.0.2" } },
          "node_modules/npm/node_modules/tar/node_modules/fstream": { version: "1.0.10", inBundle: true },
        },
      }),
    );
    expect(graph?.nodes.get("node_modules/npm/node_modules/tar")).toMatchObject({ bundled: true, bundler: "node_modules/npm" });
    expect(graph?.nodes.get("node_modules/npm/node_modules/tar/node_modules/fstream")).toMatchObject({
      bundled: true,
      bundler: "node_modules/npm",
    });
  });

  it("follows workspace links and npm aliases", () => {
    const graph = buildLockGraph(
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { workspaces: ["packages/a"], dependencies: { "my-lodash": "npm:lodash@^4.17.0" } },
          "packages/a": { name: "a", version: "1.0.0", dependencies: { qs: "^6.0.0" } },
          "node_modules/a": { resolved: "packages/a", link: true },
          "node_modules/my-lodash": { name: "lodash", version: "4.17.15" },
          "node_modules/qs": { version: "6.7.0" },
          "node_modules/b": { version: "1.0.0", dependencies: { a: "*" } },
        },
      }),
    );
    expect(graph?.nodes.get("node_modules/my-lodash")).toMatchObject({ name: "lodash", version: "4.17.15" });
    expect(edges(graph, "node_modules/my-lodash")).toEqual(["<root> my-lodash@^4.17.0"]);
    expect(graph?.nodes.get("packages/a")?.root).toBe(true);
    expect(edges(graph, "node_modules/qs")).toEqual(["packages/a qs@^6.0.0"]);
    expect(edges(graph, "packages/a")).toEqual(["node_modules/b a@*"]);
  });

  it("reads v1 lockfiles: nesting, requires, bundled, root edges from package.json", () => {
    const graph = buildLockGraph(
      JSON.stringify({
        lockfileVersion: 1,
        dependencies: {
          express: { version: "4.17.1", requires: { qs: "6.7.0", cookie: "0.4.0" } },
          qs: { version: "6.7.0" },
          cookie: { version: "0.4.0" },
          fsevents: {
            version: "1.2.9",
            requires: { tar: "^4" },
            dependencies: { tar: { version: "4.4.8", bundled: true } },
          },
          sio: { version: "npm:socket.io-client@2.4.0" },
        },
      }),
      JSON.stringify({ dependencies: { express: "^4.17.1", sio: "npm:socket.io-client@^2.4.0" }, optionalDependencies: { fsevents: "^1.2.0" } }),
    );
    expect(edges(graph, "node_modules/qs")).toEqual(["node_modules/express qs@6.7.0"]);
    expect(edges(graph, "node_modules/express")).toEqual(["<root> express@^4.17.1"]);
    expect(graph?.nodes.get("node_modules/fsevents/node_modules/tar")).toMatchObject({ bundled: true, bundler: "node_modules/fsevents" });
    expect(graph?.nodes.get("node_modules/sio")).toMatchObject({ name: "socket.io-client", version: "2.4.0" });
    expect(edges(graph, "node_modules/sio")).toEqual(["<root> sio@^2.4.0"]);
  });

  it("returns null for text that is not a lockfile", () => {
    expect(buildLockGraph("not json")).toBeNull();
    expect(buildLockGraph("{}")).toBeNull();
  });

  it("strips npm alias prefixes from ranges", () => {
    expect(stripAlias("npm:lodash@^4.17.0")).toBe("^4.17.0");
    expect(stripAlias("npm:@scope/pkg@1.2.3")).toBe("1.2.3");
    expect(stripAlias("^1.0.0")).toBe("^1.0.0");
  });
});
