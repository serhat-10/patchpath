import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", cli: "src/cli/index.ts" },
  format: ["esm"],
  target: "node22",
  dts: { entry: { index: "src/index.ts" } },
  clean: true,
  sourcemap: true,
  // semver and yaml are devDependencies bundled into dist, so the published package has no runtime dependencies.
  noExternal: ["semver", "yaml"],
  // yaml's Node build is CommonJS and requires the built-ins "process" and "buffer"; an ESM bundle
  // has no `require`, so give it one (esbuild's shim uses it when it exists).
  banner: {
    js: 'import { createRequire as __patchpathCreateRequire } from "node:module"; const require = __patchpathCreateRequire(import.meta.url);',
  },
});
