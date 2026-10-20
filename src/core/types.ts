export type Severity = "critical" | "high" | "moderate" | "low" | "unknown";

export const SEVERITY_ORDER: Severity[] = ["unknown", "low", "moderate", "high", "critical"];

export interface Dependency {
  name: string;
  version: string;
  /** Declared directly by the root project or one of its workspaces. */
  direct: boolean;
  dev: boolean;
  /**
   * Not installed from the public npm registry (private registry, git, tarball, file).
   * Such packages are never looked up, so their names are not sent to any service.
   */
  external: boolean;
  /**
   * Set (with `external`) when the lockfile has no `resolved` URL for this package, so its
   * origin is unknown. `--assume-public` treats such packages as public instead.
   */
  unresolved?: boolean;
  /**
   * Set (with `external`) when the lockfile names the package (or the alias it is installed under)
   * in a way npm would not accept. Never checked, requested or printed in a command.
   */
  invalidName?: boolean;
  /**
   * Set (with `external`) for a yarn v1 entry whose header mixes names or an `npm:` alias with a plain
   * range, so it is not known which package was installed. Never checked.
   */
  mixedHeader?: boolean;
  /** For transitive packages: the chain from a direct dependency down to the parent. */
  via?: string[];
}

export interface Vulnerability {
  id: string;
  aliases: string[];
  summary: string;
  severity: Severity;
  /** Versions in which this vulnerability is fixed, as published by the advisory. */
  fixedIn: string[];
  url: string;
}

export type UpdateGap = "major" | "minor" | "patch";

export interface Finding {
  name: string;
  version: string;
  direct: boolean;
  dev: boolean;
  vulnerabilities: Vulnerability[];
  deprecated?: string;
  /** Only set for direct dependencies. */
  latest?: string;
  updateGap?: UpdateGap;
  /**
   * Smallest newer version that is outside the affected range of every vulnerability
   * in this package. Absent when no such version is known.
   */
  fixVersion?: string;
  /** The fix is a new major (or a new 0.x minor), so it may break callers. */
  fixIsBreaking?: boolean;
  /** For transitive packages: the chain from a direct dependency to the parent. */
  via?: string[];
  /** Higher means fix sooner: malware, then severity, then direct/prod, then count. */
  priority: number;
}

export interface Summary {
  packages: number;
  direct: number;
  /** Packages not installed from the public registry; they were not checked. */
  external: number;
  vulnerablePackages: number;
  vulnerabilities: Record<Severity, number>;
  deprecated: number;
  /** Packages with at least one malicious-code advisory (id `MAL-...` or a summary saying "malicious"). */
  malicious?: number;
  /** Direct dependencies behind their latest release, by size of the gap. */
  outdated: Record<UpdateGap, number>;
}

/** An advisory that would still be open after the recommended upgrade. */
export interface PlanAdvisory {
  id: string;
  severity: Severity;
  /** The installed package it is in today, `name@version`. */
  package: string;
  /**
   * The estimated version after the upgrade (`name@version`). Absent when it could not be
   * estimated (see `PlanEntry.unresolved`).
   */
  after?: string;
  /** Not present today: the estimated new version brings it in (OSV says so). */
  introduced?: boolean;
}

/**
 * Remediation for one direct dependency and everything vulnerable below it.
 *
 * `estimated` is always true: the plan is worked out from registry metadata by resolving each
 * vulnerable chain hop by hop with the newest version that satisfies the declared range. npm can
 * resolve differently (dedupe, versions already locked, peer dependencies, overrides), so apply
 * the upgrade and scan again. Every chain in the lockfile that leads to a vulnerable copy is
 * followed, so a copy that something else still pins counts as remaining.
 */
export interface PlanEntry {
  name: string;
  /** The key it is declared under when that differs from `name` (npm alias: `"sio4": "npm:socket.io-client@4"`). */
  alias?: string;
  /** Workspace folders that declare it (absent when only the root project does). */
  workspaces?: string[];
  /** Installed version. */
  version: string;
  dev: boolean;
  /**
   * `upgrade`: `target` clears at least one advisory. `no-fix`: no candidate version clears any.
   * `unavailable`: the registry data needed for an estimate could not be read (see `reason`).
   */
  status: "upgrade" | "no-fix" | "unavailable";
  /** Recommended version of this direct dependency. */
  target?: string;
  /** `target` crosses a breaking line (new major, new 0.x minor or new 0.0.x patch). */
  breaking?: boolean;
  /**
   * Advisories open today in this dependency and the packages it pulls in. Each vulnerable package
   * is counted under one direct dependency: the one its shortest chain starts with.
   */
  total: number;
  /** What the target clears. `packages` lists every installed package with at least one cleared advisory. */
  clears: { count: number; packages: string[]; worst?: Severity };
  /** Advisories still open after the target, including any the target is estimated to introduce. */
  remaining: PlanAdvisory[];
  /** When `target` leaves something open: the smallest breaking version estimated to clear everything. */
  breakingAlternative?: string;
  /** Deprecation message of the installed version, if it is deprecated. */
  deprecated?: string;
  /**
   * Packages (names) whose locked version still satisfies the range declared after the upgrade, so
   * npm will probably keep it: run `npm update <name>` as well (the estimate assumes you do, except
   * for a name the commands leave out of `npm update`: see the command's `held`).
   */
  alsoUpdate?: string[];
  /** Installed packages (`name@version`) whose version after the upgrade could not be estimated. */
  unresolved?: string[];
  /**
   * Likely peer-dependency conflicts of `target` with the installed tree, e.g.
   * "webpack-dev-server@5.2.6 needs webpack@^5.0.0 (installed 4.41.2)". npm will probably refuse
   * the install with ERESOLVE, so the upgrade is kept out of the non-breaking command.
   */
  peerConflicts?: string[];
  /**
   * Names of vulnerable packages that stay open because the root package.json `overrides` pins
   * them (at any depth, e.g. `{"express": {"qs": "6.5.1"}}`): no upgrade moves them until the
   * override is changed.
   */
  heldByOverride?: string[];
  /** Of `total`, the advisories that the in-range `npm update` step (Report.refresh) clears. */
  refreshClears?: number;
  /** Why there is no estimate (`unavailable`) or no upgrade (`no-fix`). */
  reason?: string;
  estimated: true;
}

/** One step of the commands that apply the plan, in the order they should run. */
export interface PlanCommand {
  /**
   * `safe`: non-breaking upgrades without a known peer conflict, plus in-range `npm update`s; run
   * it first. `breaking`: may break (new major or 0.x minor); run one at a time and test.
   * `conflict`: non-breaking, but a peer-dependency conflict is likely.
   * `peer`: non-breaking, but for a package that is only a `peerDependency` of the project:
   * `npm install` raises its range in package.json, which is a requirement for the project's users.
   */
  kind: "safe" | "breaking" | "conflict" | "peer";
  /**
   * `npm install` arguments for the root project (`name@version`, or `alias@npm:name@version`);
   * may be empty for a pure update step.
   */
  install: string[];
  /** `npm install -w <folder>` arguments, per workspace folder that declares the package. */
  workspaceInstall?: Record<string, string[]>;
  /** `npm update` arguments (package names) to run after the install. */
  update: string[];
  /** Plan entries (direct dependency names, or the alias they are declared under) this step applies. */
  entries: string[];
  /** Of the packages installed, those that are only a `peerDependency` of the project. */
  peerRange?: string[];
  /** Likely peer-dependency conflicts (npm may refuse with ERESOLVE). */
  conflicts?: string[];
  /**
   * Packages left out of `npm update` because moving them would probably hit a peer dependency the
   * tree does not satisfy ("name: reason"). Checked for the safe step; a later command leaves the
   * same names out.
   */
  held?: string[];
  /**
   * Peer conflicts of direct dependencies that exist before the step (after the steps before it)
   * and that the step does not resolve. npm then stops `npm install` and `npm update` with ERESOLVE.
   */
  existingConflicts?: string[];
  /** Run `npm install` and `npm update` with `--legacy-peer-deps` (because of `existingConflicts`). */
  legacyPeerDeps?: boolean;
  /**
   * What the step would run, when `existingConflicts` stop npm and `--legacy-peer-deps`
   * cannot be used because the lockfile has packages installed only as peers (`peerOnly`), which
   * that flag removes. `install`, `workspaceInstall` and `update` are then empty: resolve the
   * conflict by hand first. `clears` is the estimate for running it afterwards.
   */
  blocked?: { install: string[]; workspaceInstall?: Record<string, string[]>; update: string[] };
  /** Packages installed only because something declares them as a peer (with `blocked`). */
  peerOnly?: string[];
  /**
   * For `safe`: what the step is estimated to clear across the whole report, with everything
   * listed in it applied together.
   */
  clears?: { count: number; total: number; packages: string[]; worst?: Severity };
}

/**
 * Locked transitive packages that `npm update <name>` moves to a fixed version without any
 * package.json change, because the fixed version is already inside the range their parents declare.
 */
export interface PlanRefresh {
  /** Names for `npm update`, beyond those the upgrades themselves need. */
  update: string[];
  /** Advisories the refresh clears (beyond what the upgrades in the same step clear). */
  clears: { count: number; packages: string[]; worst?: Severity };
  /** Installed packages (`name@version`) left with no advisory by the safe step, thanks to the refresh. */
  covered: string[];
}

/** A vulnerable copy that ships inside another package's tarball (npm cannot override or update it). */
export interface BundledCopy {
  /** `name@version` of the bundled copy. */
  package: string;
  /** `name@version` of the package(s) that bundle it: upgrade those instead. */
  bundledIn: string[];
  advisories: number;
}

export interface Report {
  root: string;
  lockfile: string;
  /**
   * Which lockfile format was read: `npm` (package-lock.json / npm-shrinkwrap.json), `yarn-v1`
   * (yarn.lock of yarn 1.x) or `pnpm-9` (pnpm-lock.yaml, lockfileVersion 9.0).
   */
  lockfileType?: "npm" | "yarn-v1" | "pnpm-9";
  /**
   * Set when this lockfile type gets no upgrade plan: `plan` is empty and there are no `commands`,
   * `refresh` or `suggestedOverrides`, because those are npm commands and npm `overrides`.
   * Findings (vulnerabilities, fixed versions, deprecations, lag, `via`) are still complete.
   */
  planUnavailable?: string;
  scannedAt: string;
  summary: Summary;
  /** Packages with at least one notable signal, sorted by priority (highest first). */
  findings: Finding[];
  /**
   * Transitive packages that can be pinned to a fixed, non-breaking version with an
   * npm `overrides` entry. Test after applying.
   */
  suggestedOverrides: Record<string, string>;
  /**
   * Upgrade plan: one entry per direct dependency that is vulnerable or pulls in something
   * vulnerable, best first. An estimate (see PlanEntry). Empty when planning was skipped.
   */
  plan: PlanEntry[];
  /** Commands that apply the plan, in order (safe first). Absent or empty when there is nothing to run. */
  commands?: PlanCommand[];
  /** In-range updates of locked transitive packages (part of the `safe` command). */
  refresh?: PlanRefresh;
  /** Vulnerable bundled copies: no override is suggested for them. */
  bundled?: BundledCopy[];
  /**
   * Vulnerable transitive packages for which no override is suggested because every fixed version
   * found carries a known advisory itself (or could not be verified).
   */
  overridesOmitted?: { name: string; reason: string }[];
  /** Non-fatal problems, e.g. a registry lookup that failed. */
  warnings: string[];
}
