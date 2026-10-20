// Pure helpers for plan-eval.mjs (no I/O except reading the files they are given). Logic is unchanged from the measurement scripts of Round 6.
import fs from "node:fs";

// Count unique (package|advisory) pairs in the output of `npm audit --json`. The output may have text before/after the JSON object.
export function auditCount(file) {
  let j;
  try { const t = fs.readFileSync(file, "utf8"); j = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)); } catch { return null; }
  if (j.error) return { error: j.error.code || "err" };
  const adv = new Set();
  for (const [n, v] of Object.entries(j.vulnerabilities || {})) for (const x of v.via || []) if (typeof x === "object") adv.add((x.name || n) + "|" + (x.url || x.source));
  return { advisories: adv.size, pkgs: Object.keys(j.vulnerabilities || {}).length, total: j.metadata?.vulnerabilities?.total, sev: j.metadata?.vulnerabilities };
}

// Units "name@version|advisory id" of a patchpath --json output file.
export function ppKeys(file) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  const s = new Set();
  for (const f of j.findings) for (const v of f.vulnerabilities) s.add(f.name + "@" + f.version + "|" + v.id);
  return s;
}

// Parse the "Commands" block of patchpath's text report into [{ step, kind: "safe"|"brk", cmd, commented? }].
// kind "safe" = step 1 (non-breaking); "brk" = the separate commands that follow; commented = printed as a comment (conflict to resolve by hand).
export function parseCmds(txt) {
  const L = txt.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
  const i = L.findIndex((l) => l.startsWith("Commands"));
  if (i < 0) return [];
  const out = [];
  let kind = "", step = 0;
  for (const l of L.slice(i + 1)) {
    if (!l.startsWith("  ")) break;
    const s = l.trim();
    const m = s.match(/^#\s+resolve the conflict by hand, then run: (npm .*)$/) || s.match(/^#\s{3}(npm .*)$/);
    if (m) { out.push({ step, kind, cmd: m[1], commented: true }); continue; }
    if (s.startsWith("# 1. non-breaking")) { kind = "safe"; step = 1; continue; }
    if (s.startsWith("#")) {
      if (/^# \d+\. separately/.test(s)) continue;
      if (kind === "safe" && /existing peer conflict|not in npm update/.test(s)) continue;
      step++; kind = "brk"; continue;
    }
    if (s.startsWith("npm ")) out.push({ step, kind, cmd: s });
  }
  return out;
}

// Put npm flags before the "--" that separates flags from package names (flags after it would be read as package names).
export function inject(c, flags) {
  const k = c.indexOf(" -- ");
  return k < 0 ? c + " " + flags : c.slice(0, k) + " " + flags + c.slice(k);
}

// Only plain "npm install|update <args>" lines with harmless characters are executed. The lines come from patchpath's output,
// which is built from lockfile data; anything else is recorded and skipped, never passed to a shell.
export const SAFE_CMD = /^npm (install|update)( [-A-Za-z0-9@/._:]+)+$/;
export const isSafeCmd = (c) => SAFE_CMD.test(c);

export const isWorkspaceCmd = (c) => / -w | --workspace/.test(c);

// ---- totals and table over the per-project results of plan-eval.mjs (also used to render saved plan.json files) ----
const adv = (a) => (a && a.advisories !== undefined ? a.advisories : null);
export function planTotals(results) {
  const T = {
  projects: results.length,
  auditBefore: 0, auditPpSafe: 0, auditFix: 0, auditPpBrk: 0, claimedClears: 0, reallyClosed: 0,
  claimHeld: 0, ppBetterThanFix: 0, fixBetterThanPp: 0, tied: 0, separateOk: 0, separateTotal: 0, separateEresolve: 0,
  };
  for (const r of results) {
  T.auditBefore += adv(r.auditBefore) ?? 0; T.auditPpSafe += adv(r.auditPpSafe) ?? 0; T.auditFix += adv(r.auditFix) ?? 0;
  T.auditPpBrk += r.brk.length ? adv(r.auditPpBrk) ?? 0 : adv(r.auditPpSafe) ?? 0; // no separate commands: the state after the safe step
  T.claimedClears += r.claim?.count ?? 0; T.reallyClosed += r.closedByKey ?? 0;
  if (r.claim && r.closedByKey >= r.claim.count) T.claimHeld++;
  const a = adv(r.auditPpSafe), b = adv(r.auditFix);
  if (a !== null && b !== null) { if (a < b) T.ppBetterThanFix++; else if (b < a) T.fixBetterThanPp++; else T.tied++; }
  T.separateOk += r.brkOk; T.separateTotal += r.brkTotal; T.separateEresolve += r.brkEresolve;
  }

  return T;
}
export function renderPlanTable(results, T) {
  const rows = results.map((r) => {
    const bs = adv(r.auditBefore);
    const d = (x) => (x === null ? "n/a" : `${x} (${x - bs >= 0 ? "+" : "-"}${Math.abs(x - bs)})`);
    return `| ${r.id} | ${bs ?? "n/a"} | ${r.claim ? r.claim.count + "/" + r.claim.total : "-"} | ${r.closedByKey ?? "n/a"} | ${d(adv(r.auditPpSafe))} | ${d(adv(r.auditFix))} | ${r.brkOk}/${r.brkTotal}${r.brkEresolve ? ` (ERESOLVE ${r.brkEresolve})` : ""} | ${r.brk.length ? adv(r.auditPpBrk) : "-"} |`;
  });
  let md = `# Plan evaluation\n\nUnit for the npm audit columns: unique (package|advisory) pairs from \`npm audit --package-lock-only --json\`. "Claim" = the "clears N of M" estimate printed for the safe step; "really closed" = patchpath units (name@version|id) that a patchpath re-scan no longer reports after the safe step. Both are patchpath advisory units and are not directly comparable to the npm audit columns. In brackets: change against "before".\n\n`;
  md += `| project | before (npm audit) | claim (clears N of M) | really closed (patchpath re-scan) | npm audit after patchpath safe step | npm audit after \`npm audit fix\` | separate commands with exit 0 | npm audit after safe + all separate commands |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${rows.join("\n")}\n\n`;
  md += `Totals over ${T.projects} projects: before ${T.auditBefore}; after patchpath safe step ${T.auditPpSafe}; after \`npm audit fix\` ${T.auditFix}; after safe step + all separate commands ${T.auditPpBrk}.\n\n`;
  md += `Safe step better than \`npm audit fix\` in ${T.ppBetterThanFix} projects, worse in ${T.fixBetterThanPp}, equal in ${T.tied}.\n\n`;
  md += `Claim: sum of claimed ${T.claimedClears}, sum really closed ${T.reallyClosed}; really closed >= claimed in ${T.claimHeld} of ${T.projects} projects.\n\n`;
  md += `Separate commands: ${T.separateOk} of ${T.separateTotal} exited 0 (${T.separateEresolve} with ERESOLVE).\n`;

  return md;
}
