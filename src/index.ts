export { scan, type ScanOptions } from "./core/scan.js";
export { formatText, exceedsThreshold } from "./core/format.js";
export { parseNpmLockfile } from "./core/lockfile/npm.js";
export { parseYarnLockfile } from "./core/lockfile/yarn.js";
export { parsePnpmLockfile } from "./core/lockfile/pnpm.js";
export { compareVersions, crossesBreaking, updateGap } from "./core/semver.js";
export { sanitize } from "./core/util.js";
export type {
  Dependency,
  Finding,
  PlanAdvisory,
  PlanEntry,
  Report,
  Severity,
  Summary,
  UpdateGap,
  Vulnerability,
} from "./core/types.js";
