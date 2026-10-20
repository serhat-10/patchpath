import type { Severity } from "./types.js";

const AV: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const AC: Record<string, number> = { L: 0.77, H: 0.44 };
const UI: Record<string, number> = { N: 0.85, R: 0.62 };
const CIA: Record<string, number> = { H: 0.56, L: 0.22, N: 0 };

// CVSS 3.1 "Roundup": smallest number, to one decimal, that is >= the input.
function roundUp(x: number): number {
  const i = Math.round(x * 100000);
  return i % 10000 === 0 ? i / 100000 : (Math.floor(i / 10000) + 1) / 10;
}

/** Base score of a CVSS v3.x vector string, or null if it is not a valid v3 vector. */
export function cvss3Score(vector: string): number | null {
  if (!/^CVSS:3\.[01]\//.test(vector)) return null;
  const m = new Map(vector.split("/").slice(1).map((p) => p.split(":") as [string, string]));
  const scopeChanged = m.get("S") === "C";
  if (!scopeChanged && m.get("S") !== "U") return null;

  const pr = { N: 0.85, L: scopeChanged ? 0.68 : 0.62, H: scopeChanged ? 0.5 : 0.27 }[
    m.get("PR") as "N" | "L" | "H"
  ];
  const av = AV[m.get("AV") ?? ""];
  const ac = AC[m.get("AC") ?? ""];
  const ui = UI[m.get("UI") ?? ""];
  const c = CIA[m.get("C") ?? ""];
  const i = CIA[m.get("I") ?? ""];
  const a = CIA[m.get("A") ?? ""];
  if ([pr, av, ac, ui, c, i, a].some((v) => v === undefined)) return null;

  const iss = 1 - (1 - (c as number)) * (1 - (i as number)) * (1 - (a as number));
  const impact = scopeChanged
    ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15
    : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * (av as number) * (ac as number) * (pr as number) * (ui as number);
  return roundUp(Math.min((scopeChanged ? 1.08 : 1) * (impact + exploitability), 10));
}

export function severityFromScore(score: number): Severity {
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "moderate";
  return score > 0 ? "low" : "unknown";
}
