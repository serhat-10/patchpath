import { describe, expect, it } from "vitest";
import { formatText } from "../src/core/format.js";
import type { PlanCommand, PlanEntry, Report } from "../src/core/types.js";
import { isMalicious } from "../src/core/util.js";

const report = (major: number): Report => ({
  root: "",
  lockfile: "package-lock.json",
  scannedAt: "",
  warnings: [],
  suggestedOverrides: {},
  plan: [],
  findings: [],
  summary: {
    packages: 10,
    direct: 4,
    external: 0,
    vulnerablePackages: 0,
    vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0, unknown: 0 },
    deprecated: 0,
    outdated: { major, minor: 0, patch: 0 },
  },
});

describe("formatText wording", () => {
  it("pluralises 'dependency' correctly", () => {
    expect(formatText(report(1))).toContain("1 direct dependency a major version behind");
    expect(formatText(report(4))).toContain("4 direct dependencies a major version behind");
    expect(formatText(report(4))).not.toContain("dependencys");
  });

  it("says nothing about lag when there is none", () => {
    expect(formatText(report(0))).not.toContain("major version behind");
  });
});

describe("'also run npm update' on a plan line", () => {
  const upgrade = (name: string, alsoUpdate: string[]): PlanEntry => ({
    name,
    version: "1.0.0",
    dev: false,
    status: "upgrade",
    target: "1.1.0",
    breaking: false,
    total: 1,
    clears: { count: 1, packages: [`${name}@1.0.0`], worst: "high" },
    remaining: [],
    alsoUpdate,
    estimated: true,
  });
  const withPlan = (plan: PlanEntry[], commands?: PlanCommand[]): Report => ({ ...report(0), plan, commands });

  it("does not take a held name for covered because an unrelated command updates it", () => {
    const text = formatText(
      withPlan(
        [upgrade("app", ["mid"]), { ...upgrade("tool", ["mid"]), target: "2.0.0", breaking: true }],
        [
          { kind: "safe", install: ["app@1.1.0"], update: [], entries: ["app"], held: ["mid: mid@1.1.0 needs graphql@^14.0.0 (installed 15.0.0)"] },
          { kind: "breaking", install: ["tool@2.0.0"], update: ["mid"], entries: ["tool"] },
        ],
      ),
    );
    const appLines = text.slice(text.indexOf("app 1.0.0 ->"), text.indexOf("tool 1.0.0 ->"));
    expect(appLines).not.toContain("also run npm update");
    expect(appLines).toContain("not in npm update (likely peer conflict, see the commands below): mid");
    // tool's own command runs it: nothing to add on its line.
    expect(text.slice(text.indexOf("tool 1.0.0 ->"), text.indexOf("Commands"))).not.toContain("npm update");
  });

  it("points at --json, not at a Commands block that is not there", () => {
    const names = Array.from({ length: 10 }, (_, i) => `p${i}`);
    const text = formatText(withPlan([upgrade("app", names)]));
    expect(text).toContain("also run npm update p0 p1 p2 p3 p4 p5 p6 p7 (+2 more, see --json)");
    expect(text).not.toContain("see the commands below");
  });
});

describe("malicious packages", () => {
  const finding = (id: string, summary: string) => ({
    name: "evil",
    version: "1.0.0",
    direct: false,
    dev: false,
    via: ["host"],
    priority: 1,
    vulnerabilities: [{ id, aliases: [] as string[], summary, severity: "critical" as const, fixedIn: [] as string[], url: "" }],
  });
  const withFinding = (f: ReturnType<typeof finding>): Report => ({
    ...report(0),
    summary: { ...report(0).summary, vulnerablePackages: 1, vulnerabilities: { critical: 1, high: 0, moderate: 0, low: 0, unknown: 0 }, malicious: 1 },
    findings: [f],
    plan: [
      {
        name: "host",
        version: "1.0.0",
        dev: false,
        status: "upgrade",
        target: "1.0.1",
        breaking: false,
        total: 1,
        clears: { count: 1, packages: ["evil@1.0.0"], worst: "critical" },
        remaining: [],
        estimated: true,
      },
    ],
  });

  it("marks a malicious advisory on the 'covered by' line and in the summary", () => {
    const text = formatText(withFinding(finding("MAL-2025-1", "Malware in evil")));
    expect(text).toContain("1 malicious package");
    expect(text).toMatch(/evil@1\.0\.0 .*covered by upgrading host MALICIOUS CODE \(MAL-2025-1\)/);
  });

  it("recognises a record whose alias is a MAL- id", () => {
    const f = finding("GHSA-x", "Embedded Malicious Code in evil");
    f.vulnerabilities[0]!.aliases = ["MAL-2025-7"];
    expect(formatText(withFinding(f))).toContain("MALICIOUS CODE (GHSA-x)");
  });

  it.each(["Prototype pollution", "Malicious input can crash the server", "Allows execution of malicious code via crafted templates"])(
    "stays quiet for an ordinary advisory, even when its summary says malicious: %s",
    (summary) => {
      const plain = withFinding(finding("GHSA-y", summary));
      expect(isMalicious(plain.findings[0]!.vulnerabilities[0]!)).toBe(false);
      plain.summary.malicious = 0;
      const text = formatText(plain);
      expect(text).not.toContain("MALICIOUS");
      expect(text).not.toContain("MALWARE");
      expect(text).not.toContain("malicious package");
    },
  );
});

describe("nothing was checked", () => {
  const unchecked = (packages: number, external: number, type?: Report["lockfileType"]): Report => ({
    ...report(0),
    lockfileType: type,
    summary: { ...report(0).summary, packages, external },
  });

  it("does not read as clean when every package was left unchecked", () => {
    const text = formatText(unchecked(5, 5, "pnpm-9"));
    expect(text).toContain("Nothing was checked: 5 packages were not checked (see warnings). This is not a clean result.");
    expect(text).toContain("--assume-public");
    expect(text).not.toMatch(/No known vulnerabilities/);
  });

  it("keeps the 'in the K checked packages' wording when some were checked", () => {
    expect(formatText(unchecked(5, 2))).toContain("No known vulnerabilities in the 3 checked packages; 2 were not checked (see warnings).");
  });
});
