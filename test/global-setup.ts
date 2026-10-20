import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Builds dist/ so the CLI tests run the same file users run. */
export default function setup(): void {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const tsup = fileURLToPath(new URL("../node_modules/tsup/dist/cli-default.js", import.meta.url));
  execFileSync(process.execPath, [tsup], { cwd: root, stdio: "pipe" });
}
