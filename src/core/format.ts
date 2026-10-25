import {
  SEVERITY_ORDER,
  type PlanAdvisory,
  type PlanCommand,
  type PlanEntry,
  type Report,
  type Severity,
  type Vulnerability,
} from "./types.js";
import { isMalicious, sanitize, truncate } from "./util.js";

const MAX_LISTED = 15;
const MAX_VULNS_PER_PACKAGE = 3;

function painter(enabled: boolean) {
  const wrap = (code: string) => (text: string) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : text);
  return {
    bold: wrap("1"),
    dim: wrap("2"),
    red: wrap("31"),
    yellow: wrap("33"),
    cyan: wrap("36"),
    green: wrap("32"),
  };
}

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const advisories = (n: number) => `${n} ${n === 1 ? "advisory" : "advisories"}`;
const MAX_REMAINING_LISTED = 3;
const MAX_BUNDLED_LISTED = 10;
const MAX_ALSO_UPDATE_LISTED = 8;
/** Marks a package that the in-range `npm update` step covers (not a package name: names have no spaces). */
const REFRESH = " refresh";


/**
 * Every string that came from outside (lockfile, registry, advisories) passes through here
 * so that it cannot inject terminal escape sequences, even if a data source missed it.
 */
const safe = (text: string, max = 300) => sanitize(text, max);

/** An unknown severity could be anything, so for gating purposes it counts as moderate. */
const gatingSeverity = (s: Severity): Severity => (s === "unknown" ? "moderate" : s);

export function formatText(report: Report, { color = false } = {}): string {
  const c = painter(color);
  const { summary, findings, warnings } = report;
  const sev = summary.vulnerabilities;
  const severityColor: Record<Severity, (s: string) => string> = {
    critical: (s) => c.bold(c.red(s)),
    high: c.red,
    moderate: c.yellow,
    low: c.cyan,
    unknown: c.dim,
  };
  const label = (v: Vulnerability) =>
    isMalicious(v) ? c.bold(c.red("MALWARE ")) : severityColor[v.severity](v.severity.padEnd(8));
  const lines: string[] = [];

  lines.push(c.bold(`patchpath: ${safe(report.lockfile, 500)}`));
  const lag = summary.outdated.major;
  lines.push(
    `${plural(summary.packages, "package")} (${summary.direct} direct)` +
      (lag ? `, ${plural(lag, "direct dependency", "direct dependencies")} a major version behind` : ""),
  );
  lines.push("");

  const vulnTotal = Object.values(sev).reduce((a, b) => a + b, 0);
  if (vulnTotal === 0 && summary.external > 0) {
    // Never print an unqualified all-clear when part of the tree was not looked at.
    const checked = summary.packages - summary.external;
    const verb = summary.external === 1 ? "was" : "were";
    if (checked <= 0) {
      lines.push(
        c.bold(
          c.yellow(
            `Nothing was checked: ${plural(summary.external, "package")} ${verb} not checked (see warnings). This is not a clean result.`,
          ),
        ),
      );
      if (report.lockfileType === "pnpm-9") {
        lines.push(c.yellow("pnpm-lock.yaml does not say where packages came from by default: pass --assume-public if this project installs from registry.npmjs.org."));
      }
    } else {
      lines.push(
        c.yellow(
          `No known vulnerabilities in the ${plural(checked, "checked package")}; ` +
            `${summary.external} ${verb} not checked (see warnings).`,
        ),
      );
    }
  } else if (vulnTotal === 0) {
    lines.push(c.green("No known vulnerabilities."));
  } else {
    const parts = (["critical", "high", "moderate", "low", "unknown"] as Severity[])
      .filter((s) => sev[s] > 0)
      .map((s) => severityColor[s](`${sev[s]} ${s}`));
    const noun = vulnTotal === 1 ? "known vulnerability" : "known vulnerabilities";
    lines.push(`${vulnTotal} ${noun} in ${plural(summary.vulnerablePackages, "package")}: ${parts.join(", ")}`);
    if (summary.external > 0) {
      // The warnings sit at the end of a long report: say it here, next to the number it qualifies.
      const pct = Math.round((summary.external / summary.packages) * 100);
      lines.push(
        c.yellow(
          `${summary.external} of ${summary.packages} packages (${pct}%) ${summary.external === 1 ? "was" : "were"} not checked, so the list may be incomplete (see warnings).`,
        ),
      );
    }
  }
  if (summary.malicious) lines.push(c.bold(c.red(plural(summary.malicious, "malicious package"))));
  if (summary.deprecated > 0) lines.push(c.yellow(plural(summary.deprecated, "deprecated package")));

  // The plan, its commands and overrides are npm-only: for any other lockfile type they are never
  // printed, even if a caller hands in a report that has them.
  const npmOnly = report.lockfileType === undefined || report.lockfileType === "npm";
  // Installed packages (name@version) whose every advisory a recommended upgrade clears.
  const covered = new Map<string, string>();
  for (const e of npmOnly ? (report.plan ?? []) : []) {
    if (e.status !== "upgrade") continue;
    for (const id of e.clears.packages) {
      if (!e.remaining.some((a) => a.package === id && !a.introduced)) covered.set(id, e.name);
    }
  }
  for (const id of npmOnly ? (report.refresh?.covered ?? []) : []) if (!covered.has(id)) covered.set(id, REFRESH);

  if (report.planUnavailable || !npmOnly) {
    lines.push(
      "",
      c.dim(
        `Note: ${safe(report.planUnavailable ?? "upgrade plan is not available for this lockfile type", 200)}. ` +
          `No npm commands or overrides are suggested; fixed versions are listed per package.`,
      ),
    );
  }
  const plan = npmOnly ? (report.plan ?? []) : [];
  if (plan.length) {
    lines.push("", `${c.bold("Upgrade plan")} ${c.dim("(estimated from registry metadata: apply it, then scan again)")}`);
    for (const e of plan) lines.push(...planLines(e, c, severityColor, report.commands));
    if (report.refresh) {
      const r = report.refresh.clears;
      const worst = r.worst ?? "unknown";
      lines.push(
        `  ${c.bold("in-range updates")} ${c.dim("(package.json unchanged)")}: clears ${advisories(r.count)}` +
          `${r.packages.length > 1 ? ` in ${plural(r.packages.length, "package")}` : ""} (worst ${severityColor[worst](worst)}), ` +
          `non-breaking: the npm update line below`,
      );
    }
    lines.push(...commandLines(report.commands ?? [], c));
  }

  if (findings.length) {
    lines.push("", c.bold(plan.length ? "Findings" : "Fix first"));
    for (const f of findings.slice(0, MAX_LISTED)) {
      const tag = `${f.direct ? "direct" : "transitive"}${f.dev ? ", dev" : ""}`;
      const by = covered.get(`${f.name}@${f.version}`);
      if (by && f.vulnerabilities.length) {
        const worst = f.vulnerabilities[0]?.severity ?? "unknown";
        const mal = f.vulnerabilities.find(isMalicious);
        const what = by === REFRESH ? "the in-range npm update" : by === f.name ? "the upgrade above" : `upgrading ${safe(by, 214)}`;
        lines.push(
          `${c.bold(`${safe(f.name, 214)}@${safe(f.version, 100)}`)} ${c.dim(`(${tag})`)} ` +
            `${advisories(f.vulnerabilities.length)}, worst ${severityColor[worst](worst)}: ${c.green(`covered by ${what}`)}` +
            `${mal ? ` ${c.bold(c.red(`MALICIOUS CODE (${safe(mal.id, 100)})`))}` : ""}`,
        );
        continue;
      }
      let advice = "";
      // A direct dependency with an upgrade in the plan shows the plan's target, never a second one.
      const planned = plan.find((e) => e.status === "upgrade" && e.target && e.name === f.name && e.version === f.version);
      if (planned) {
        advice =
          ` ${c.green(`-> upgrade to ${safe(planned.target as string, 50)} (see the plan)`)}` +
          `${planned.breaking ? c.yellow(" (may break: new major or 0.x minor)") : ""}`;
      } else if (f.fixVersion) {
        const text = f.direct ? `upgrade to ${safe(f.fixVersion, 50)}` : `fixed in ${safe(f.fixVersion, 50)}`;
        advice = ` ${c.green(`-> ${text}`)}${f.fixIsBreaking ? c.yellow(" (may break: new major or 0.x minor)") : ""}`;
      }
      lines.push(`${c.bold(`${safe(f.name, 214)}@${safe(f.version, 100)}`)} ${c.dim(`(${tag})`)}${advice}`);
      if (f.via?.length) lines.push(c.dim(`  via ${f.via.map((id) => safe(id, 120)).join(" > ")}`));
      for (const v of f.vulnerabilities.slice(0, MAX_VULNS_PER_PACKAGE)) {
        lines.push(`  ${label(v)} ${safe(v.id, 100)} ${c.dim(truncate(safe(v.summary, 200), 70))}`);
      }
      const hidden = f.vulnerabilities.length - MAX_VULNS_PER_PACKAGE;
      if (hidden > 0) lines.push(c.dim(`  ...and ${hidden} more`));
      if (f.vulnerabilities.length && !f.fixVersion) {
        lines.push(c.dim("  no single version clears all of these (or none is published yet)"));
      }
      if (f.deprecated) lines.push(`  ${c.yellow("deprecated")} ${truncate(safe(f.deprecated), 160)}`);
      if (f.updateGap === "major" && f.latest) lines.push(`  ${c.dim(`latest is ${safe(f.latest, 100)}`)}`);
    }
    if (findings.length > MAX_LISTED) {
      lines.push("", c.dim(`...and ${findings.length - MAX_LISTED} more. Use --json for the full report.`));
    }
  }

  // Overrides are only shown for packages that the recommended upgrades do not already fix.
  const overrides = Object.entries(npmOnly ? report.suggestedOverrides : {}).filter(([name]) =>
    findings.some((f) => f.name === name && !f.direct && f.vulnerabilities.length && !covered.has(`${f.name}@${f.version}`)),
  );
  if (overrides.length) {
    lines.push("", c.bold("Transitive fixes without a breaking change"));
    lines.push(c.dim("An override replaces every installed copy of the package, dev ones included."));
    lines.push(c.dim("Add to package.json, run npm install, then run your tests:"));
    lines.push(
      JSON.stringify({ overrides: Object.fromEntries(overrides.map(([n, v]) => [safe(n, 214), safe(v, 50)])) }, null, 2)
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
    );
  }
  const open = (name: string) =>
    findings.some((f) => f.name === name && !f.direct && f.vulnerabilities.length && !covered.has(`${f.name}@${f.version}`));
  const omitted = (npmOnly ? (report.overridesOmitted ?? []) : []).filter((o) => open(o.name));
  if (omitted.length) {
    if (!overrides.length) lines.push("");
    for (const o of omitted) lines.push(c.dim(`No override for ${safe(o.name, 214)}: ${safe(o.reason, 200)}`));
  }
  const bundled = (npmOnly ? (report.bundled ?? []) : []).filter((b) => !covered.has(b.package));
  if (bundled.length) {
    lines.push("", c.bold("Bundled copies"), c.dim("npm cannot override or update a package bundled inside another; upgrade the package that bundles it:"));
    for (const b of bundled.slice(0, MAX_BUNDLED_LISTED)) {
      const by = b.bundledIn.map((id) => safe(id, 320));
      const parents = [...new Set(b.bundledIn.map((id) => safe(id.slice(0, id.lastIndexOf("@")), 214)))];
      lines.push(`  ${safe(b.package, 320)} (${advisories(b.advisories)}): bundled in ${by.join(", ")}: upgrade ${parents.join(", ")}`);
    }
    if (bundled.length > MAX_BUNDLED_LISTED) lines.push(c.dim(`  ...and ${bundled.length - MAX_BUNDLED_LISTED} more (see --json)`));
  }

  if (warnings.length) {
    lines.push("", c.yellow(plural(warnings.length, "warning")));
    for (const w of warnings.slice(0, 5)) lines.push(`  ${safe(w, 400)}`);
    if (warnings.length > 5) lines.push(`  ...and ${warnings.length - 5} more`);
  }

  return lines.join("\n");
}

type Painter = ReturnType<typeof painter>;

/** Two to four lines for one direct dependency of the upgrade plan. */
function planLines(
  e: PlanEntry,
  c: Painter,
  severityColor: Record<Severity, (s: string) => string>,
  /** The Commands block: what the command applying this entry already runs is not repeated here. */
  commands: PlanCommand[] | undefined,
): string[] {
  const where = e.workspaces?.length ? c.dim(` (in ${e.workspaces.map((w) => safe(w, 200)).join(", ")})`) : "";
  const label = e.alias ? `${safe(e.alias, 214)} (npm:${safe(e.name, 214)})` : safe(e.name, 214);
  const name = `${label} ${safe(e.version, 100)}${e.dev ? c.dim(" (dev)") : ""}${where}`;
  const out: string[] = [];
  const packages = (n: number) => (n > 1 ? ` in ${plural(n, "package")}` : "");
  // Candidate targets are never deprecated releases, so a target means the upgrade leaves the deprecation behind.
  const deprecated = !e.deprecated
    ? ""
    : e.status === "upgrade" && e.target
      ? `; ${c.yellow("installed version deprecated")}, upgrade to ${safe(e.target, 100)}`
      : `; ${c.yellow("deprecated")}: replace it`;
  if (e.status === "unavailable") {
    out.push(`  ${c.bold(name)}: ${c.dim(`no estimate, ${safe(e.reason ?? "registry data unavailable", 200)}`)}${deprecated}`);
    return out;
  }
  const held = e.heldByOverride?.length ? [c.dim(`    held by an override in package.json: ${e.heldByOverride.map((n) => safe(n, 214)).join(" ")} (change the override to move it)`)] : [];
  if (e.status === "no-fix") {
    const affected = new Set(e.remaining.map((a) => a.package)).size;
    const why = e.reason ? c.dim(` (${safe(e.reason, 200)})`) : "";
    out.push(`  ${c.bold(name)}: ${c.yellow(`no upgrade clears its ${advisories(e.total)}`)}${packages(affected)}${why}${deprecated}`);
    out.push(...held);
    if (e.refreshClears) out.push(c.dim(`    the in-range npm update below clears ${e.refreshClears} of them without changing ${safe(e.name, 214)}`));
    return out;
  }
  const worst = e.clears.worst ?? "unknown";
  const count = e.clears.count === e.total ? advisories(e.total) : `${e.clears.count} of ${advisories(e.total)}`;
  out.push(
    `  ${c.bold(name)} -> ${c.green(c.bold(safe(e.target as string, 100)))}: clears ${count}` +
      `${packages(e.clears.packages.length)} (worst ${severityColor[worst](worst)}), ` +
      `${e.breaking ? c.yellow("may break (new major or 0.x minor)") : "non-breaking"}${deprecated}`,
  );
  if (e.remaining.length) out.push(c.dim(`    still open: ${remainingText(e.remaining)}`));
  if (e.breakingAlternative) {
    out.push(c.dim(`    ${safe(e.breakingAlternative, 100)} would clear all of them (may break: new major or 0.x minor)`));
  }
  if (e.unresolved?.length) {
    out.push(c.dim(`    not estimated (counted as still open): ${e.unresolved.map((id) => safe(id, 320)).join(", ")}`));
  }
  const names = (list: string[]) =>
    list.slice(0, MAX_ALSO_UPDATE_LISTED).map((n) => safe(n, 214)).join(" ") +
    (list.length > MAX_ALSO_UPDATE_LISTED ? ` (+${list.length - MAX_ALSO_UPDATE_LISTED} more, see --json)` : "");
  // Only the commands that apply this entry count: another command updating the same name says
  // nothing about this one.
  const mine = (commands ?? []).filter((cmd) => cmd.entries.includes(e.alias ?? e.name));
  if (e.alsoUpdate?.length && !mine.length) {
    out.push(
      c.dim(`    the lockfile keeps ${names(e.alsoUpdate)} where ${e.alsoUpdate.length === 1 ? "it is" : "they are"}: also run npm update ${names(e.alsoUpdate)}`),
    );
  } else if (e.alsoUpdate?.length) {
    // What the commands leave out of npm update on purpose is never suggested here.
    const run = new Set(mine.flatMap((cmd) => [...cmd.update, ...(cmd.blocked?.update ?? []), ...installedNames(cmd)]));
    const held = new Set(mine.flatMap((cmd) => cmd.held ?? []).map((h) => h.slice(0, h.indexOf(": "))));
    const left = e.alsoUpdate.filter((n) => !run.has(n));
    const peer = left.filter((n) => held.has(n));
    const other = left.filter((n) => !held.has(n));
    if (peer.length) out.push(c.dim(`    not in npm update (likely peer conflict, see the commands below): ${names(peer)}`));
    if (other.length) out.push(c.dim(`    not in npm update (not checked or not accepted, see the warnings): ${names(other)}`));
  }
  out.push(...held);
  if (e.refreshClears) out.push(c.dim(`    the in-range npm update below clears ${e.refreshClears} more`));
  return out;
}

/** Package names (and aliases) a command installs: `name@version` or `alias@npm:name@version`. */
function installedNames(cmd: PlanCommand): string[] {
  const nameOf = (arg: string) => arg.slice(0, arg.indexOf("@", 1));
  const args = [cmd.install, cmd.blocked?.install ?? [], ...Object.values(cmd.workspaceInstall ?? {}), ...Object.values(cmd.blocked?.workspaceInstall ?? {})].flat();
  return args.flatMap((arg) => {
    const npm = arg.indexOf("@npm:");
    return npm === -1 ? [nameOf(arg)] : [nameOf(arg), nameOf(arg.slice(npm + 5))];
  });
}

/**
 * The commands that apply the plan: one non-breaking step to run first, then each breaking or
 * conflicting upgrade on its own. Labels are `#` comment lines, so the block can be pasted into
 * bash, zsh or PowerShell as it is.
 */
function commandLines(commands: PlanCommand[], c: Painter): string[] {
  if (!commands.length) return [];
  const out = ["", c.bold("Commands") + c.dim(" (in this order, then scan again)")];
  const args = (list: string[]) => list.map((a) => safe(a, 320)).join(" ");
  const conflict = (cmd: PlanCommand) =>
    cmd.existingConflicts?.length
      ? `existing peer conflict (${safe(cmd.existingConflicts[0] as string, 200)}` +
        `${cmd.existingConflicts.length > 1 ? `, +${cmd.existingConflicts.length - 1} more` : ""})`
      : "existing peer conflict";
  // `--` ends npm's options: nothing after it can be read as one, whatever the lockfile said.
  const lines = (step: Pick<PlanCommand, "install" | "workspaceInstall" | "update">, flag: string) => [
    ...(step.install.length ? [`npm install ${flag}-- ${args(step.install)}`] : []),
    ...Object.entries(step.workspaceInstall ?? {}).map(([folder, list]) => `npm install -w ${safe(folder, 200)} ${flag}-- ${args(list)}`),
    ...(step.update.length ? [`npm update ${flag}-- ${args(step.update)}`] : []),
  ];
  const npm = (cmd: PlanCommand) => {
    if (cmd.blocked) {
      const [first, ...rest] = lines(cmd.blocked, "");
      return [
        c.dim(
          `# ${conflict(cmd)}: npm install and npm update stop with ERESOLVE, and --legacy-peer-deps would remove packages ` +
            `installed only as peers (${args((cmd.peerOnly ?? []).slice(0, 5))}${(cmd.peerOnly?.length ?? 0) > 5 ? ", ..." : ""})`,
        ),
        c.dim(`# resolve the conflict by hand, then run: ${first ?? ""}`),
        ...rest.map((line) => c.dim(`#   ${line}`)),
      ];
    }
    return [
      ...(cmd.legacyPeerDeps ? [c.dim(`# ${conflict(cmd)}: npm install and npm update stop with ERESOLVE without --legacy-peer-deps`)] : []),
      ...lines(cmd, cmd.legacyPeerDeps ? "--legacy-peer-deps " : ""),
    ];
  };
  const heldLines = (cmd: PlanCommand) => {
    if (!cmd.held?.length) return [];
    const shown = cmd.held.slice(0, 3).map((x) => safe(x, 200)).join("; ");
    return [c.dim(`  # not in npm update (likely peer conflict): ${shown}${cmd.held.length > 3 ? ` (+${cmd.held.length - 3} more)` : ""}`)];
  };
  const first = commands.find((cmd) => cmd.kind === "safe");
  if (first) {
    const cl = first.clears;
    const estimate = cl ? `, estimated to clear ${cl.count} of ${advisories(cl.total)}` : "";
    out.push(c.dim(`  # 1. non-breaking${estimate}`));
    for (const line of npm(first)) out.push(`  ${line}`);
    out.push(...heldLines(first));
  }
  const rest = commands.filter((cmd) => cmd.kind !== "safe");
  if (rest.length) {
    out.push(
      c.dim(
        `  # ${first ? "2" : "1"}. separately, one at a time; test after each and scan again before the next ` +
          `(one upgrade changes what the next resolves to)`,
      ),
    );
    for (const cmd of rest) {
      const label = [
        cmd.kind === "breaking" ? "may break (new major or 0.x minor)" : "non-breaking",
        cmd.peerRange?.length
          ? `a peerDependency of this project: npm install raises its range in package.json (a requirement for your users)`
          : "",
        cmd.conflicts?.length
          ? `likely peer conflict, npm may refuse with ERESOLVE: ${cmd.conflicts.slice(0, 2).map((x) => safe(x, 200)).join("; ")}` +
            (cmd.conflicts.length > 2 ? ` (+${cmd.conflicts.length - 2} more)` : "") +
            "; run it last, on its own: even when npm accepts it, later installs may stop with ERESOLVE"
          : "",
      ].filter(Boolean);
      out.push(c.yellow(`  # ${cmd.entries.map((n) => safe(n, 214)).join(", ")}: ${label.join("; ")}`));
      for (const line of npm(cmd)) out.push(`  ${line}`);
      out.push(...heldLines(cmd));
    }
  }
  return out;
}

/** "cookie@0.4.0 (1 low), qs@6.5.5 -> 6.5.3 (1 high, new)" */
function remainingText(remaining: PlanAdvisory[]): string {
  const byPackage = new Map<string, PlanAdvisory[]>();
  for (const a of remaining) byPackage.set(a.package, [...(byPackage.get(a.package) ?? []), a]);
  const parts = [...byPackage].map(([pkg, list]) => {
    const after = list.find((a) => a.after)?.after;
    const moved = after && after !== pkg ? ` -> ${safe(after.slice(after.lastIndexOf("@") + 1), 100)}` : "";
    const counts = (["critical", "high", "moderate", "low", "unknown"] as Severity[])
      .map((s) => [s, list.filter((a) => a.severity === s).length] as const)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => `${n} ${s}`)
      .join(", ");
    const isNew = list.every((a) => a.introduced) ? ", new" : list.some((a) => a.introduced) ? ", some new" : "";
    return `${safe(pkg, 320)}${moved} (${counts}${isNew})`;
  });
  const shown = parts.slice(0, MAX_REMAINING_LISTED).join(", ");
  return parts.length > MAX_REMAINING_LISTED ? `${shown}, and ${parts.length - MAX_REMAINING_LISTED} more` : shown;
}

/** True when any vulnerability in the report is at or above `threshold` (unknown counts as moderate). */
export function exceedsThreshold(report: Report, threshold: Severity): boolean {
  const min = SEVERITY_ORDER.indexOf(threshold);
  return report.findings.some((f) =>
    f.vulnerabilities.some((v) => SEVERITY_ORDER.indexOf(gatingSeverity(v.severity)) >= min),
  );
}
