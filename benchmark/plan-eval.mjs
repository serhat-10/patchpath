// Evaluate patchpath's upgrade plan against `npm audit fix` on the corpus projects marked "planEval": true.
// node plan-eval.mjs --patchpath <cli.js | command> --data <dir> --runs <dir> --out <dir> [--only id,id]
//      [--work <dir>] [--cache <npm cache dir>] [--keep-work] [--timeout-sec 600] [--log-hosts <file>] [--npm <command>]
// --runs is the output folder of run-patchpath.mjs (needs <id>/default.json and <id>/default.txt: the plan and its "clears N of M" claim).
// For each project, in separate copies of package.json + package-lock.json (nothing is installed: --package-lock-only --ignore-scripts):
//   base   npm audit on the original lockfile                                 -> unique (package|advisory) pairs "before"
//   pp     the safe step of patchpath's plan, then npm audit and a patchpath re-scan -> "after safe"; claim vs really closed
//          then the separate (breaking) commands, one by one, cumulative, continuing after a failure -> "after all", exit codes
//   fix    `npm audit fix` (never --force), then npm audit                       -> "after npm audit fix"
// Output: <out>/plan-eval.json, <out>/plan-table.md and <out>/raw/<id>/ (audit JSON files, command output heads, plan.json).
import fs from "node:fs";
import path from "node:path";
import { parseArgs, fail, loadCorpus, writeFile, sh, q, patchpathCmd, hostLogEnv, summarizeHostLog } from "./lib.mjs";
import { auditCount, ppKeys, parseCmds, inject, isSafeCmd, isWorkspaceCmd, planTotals, renderPlanTable } from "./plan-lib.mjs";

const { opts } = parseArgs(process.argv.slice(2), { patchpath: "string", data: "string", runs: "string", out: "string", only: "list", corpus: "string", work: "string", cache: "string", "keep-work": "boolean", "timeout-sec": "string", "log-hosts": "string", npm: "string" });
if (!opts.patchpath || !opts.data || !opts.runs || !opts.out) fail("usage: node plan-eval.mjs --patchpath <cli.js or command> --data <dir> --runs <dir> --out <dir> [--only id,id]");
const dataDir = path.resolve(opts.data), runsDir = path.resolve(opts.runs), outDir = path.resolve(opts.out);
const workDir = path.resolve(opts.work || path.join(outDir, "_work"));
const cacheDir = path.resolve(opts.cache || path.join(workDir, "npmcache"));
const npm = opts.npm || "npm";
const timeoutMs = Number(opts["timeout-sec"] || 600) * 1000;
const env = hostLogEnv(opts["log-hosts"]);
const FLAGS = `--package-lock-only --ignore-scripts --no-audit --no-fund --cache ${q(cacheDir)}`;

// Projects: those marked planEval in the corpus; --only may name any npm project.
let list;
if (opts.only?.length) {
  list = loadCorpus({ corpus: opts.corpus, only: opts.only }).list;
  const bad = list.filter((p) => p.type !== "npm");
  if (bad.length) fail("plan evaluation needs npm projects: " + bad.map((p) => p.id).join(", "));
} else list = loadCorpus({ corpus: opts.corpus }).list.filter((p) => p.planEval === true);
if (!list.length) fail("no project selected (mark projects with \"planEval\": true in corpus.json or pass --only)");

const raw = (id) => path.join(outDir, "raw", id);
const mk = (id, name, src) => {
  const d = path.join(workDir, id, name);
  fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true });
  for (const f of ["package.json", "package-lock.json"]) fs.copyFileSync(path.join(src, f), path.join(d, f));
  return d;
};
const audit = (id, d, tag) => {
  const r = sh(`${npm} audit --package-lock-only --json --cache ${q(cacheDir)}`, d, { timeoutMs, env });
  const f = path.join(raw(id), tag + ".audit.json");
  writeFile(f, r.out);
  return auditCount(f);
};
const rescan = (id, d, tag) => { // patchpath on the changed lockfile; --no-plan keeps it fast, --no-cache avoids reusing answers
  const r = sh(`${patchpathCmd(opts.patchpath)} ${q(d)} --json --no-plan --no-cache`, d, { timeoutMs, env });
  const f = path.join(raw(id), tag + ".pp.json");
  writeFile(f, r.stdout);
  try { return ppKeys(f); } catch { return null; }
};
const runCmd = (c, d) => { // one printed command, with the npm flags put before "--"
  if (!isSafeCmd(c.cmd)) return { skipped: "command line has characters other than letters, digits and @ / . _ : -", code: null, ms: 0, out: "" };
  const line = npm === "npm" ? c.cmd : npm + c.cmd.slice(3);
  return sh(inject(line, FLAGS), d, { timeoutMs, env });
};

const results = [];
for (const p of list) {
  const id = p.id, t0 = Date.now();
  const src = path.join(dataDir, id, ...path.dirname(p.lockfilePath).split("/").filter((x) => x && x !== "."));
  const runDefault = path.join(runsDir, id, "default.json"), runText = path.join(runsDir, id, "default.txt");
  if (!fs.existsSync(path.join(src, "package-lock.json")) || !fs.existsSync(runDefault) || !fs.existsSync(runText)) { console.error(`${id}: missing lockfile or patchpath run (fetch-corpus.mjs and run-patchpath.mjs first), skipped`); continue; }
  fs.mkdirSync(raw(id), { recursive: true });
  const res = { id };
  const dj = JSON.parse(fs.readFileSync(runDefault, "utf8"));
  const before = ppKeys(runDefault);
  res.ppBefore = before.size;
  res.auditBefore = audit(id, mk(id, "base", src), "audit");
  const safeStep = (dj.commands || []).find((c) => c.kind === "safe");
  res.claim = safeStep?.clears ? { count: safeStep.clears.count, total: safeStep.clears.total } : null;
  const cmds = parseCmds(fs.readFileSync(runText, "utf8"));
  res.cmds = cmds.length; res.hasW = cmds.some((c) => isWorkspaceCmd(c.cmd)); res.commented = cmds.filter((c) => c.commented).length;

  // A: patchpath, safe step
  let d = mk(id, "pp", src);
  res.safe = [];
  for (const c of cmds.filter((c) => c.kind === "safe" && !c.commented)) {
    const r = runCmd(c, d);
    writeFile(path.join(raw(id), `pp.safe${res.safe.length}.out`), r.out.slice(0, 20000));
    res.safe.push({ cmd: c.cmd.slice(0, 60), exit: r.code, ms: r.ms, eresolve: /ERESOLVE/.test(r.out), ...(r.skipped ? { skipped: r.skipped } : {}) });
  }
  res.auditPpSafe = audit(id, d, "ppsafe");
  const after = rescan(id, d, "ppsafe");
  if (after) { res.ppAfter = after.size; res.closedByKey = [...before].filter((k) => !after.has(k)).length; res.newKeys = [...after].filter((k) => !before.has(k)).length; }

  // C: the separate (breaking) commands on top of the safe step; cumulative, continuing after a failure
  res.brk = []; let ok = 0, er = 0;
  for (const c of cmds.filter((c) => c.kind === "brk" && !c.commented)) {
    const r = runCmd(c, d);
    const e = /ERESOLVE/.test(r.out);
    res.brk.push({ cmd: c.cmd.slice(0, 80), exit: r.code, eresolve: e, ms: r.ms, ...(r.skipped ? { skipped: r.skipped } : {}) });
    if (r.code === 0) ok++;
    if (e) er++;
  }
  res.brkOk = ok; res.brkEresolve = er; res.brkTotal = res.brk.length;
  if (res.brk.length) res.auditPpBrk = audit(id, d, "ppbrk");

  // B: npm audit fix (no --force), in its own copy
  d = mk(id, "fix", src);
  const f = sh(`${npm} audit fix ${FLAGS}`, d, { timeoutMs, env });
  writeFile(path.join(raw(id), "fix.out"), f.out.slice(0, 20000));
  res.fix = { exit: f.code, ms: f.ms, eresolve: /ERESOLVE/.test(f.out) };
  res.auditFix = audit(id, d, "fix");
  res.seconds = Math.round((Date.now() - t0) / 100) / 10;
  writeFile(path.join(raw(id), "plan.json"), JSON.stringify(res, null, 1) + "\n");
  results.push(res);
  console.log(`${id}: before ${res.auditBefore?.advisories} | claim ${res.claim ? res.claim.count + "/" + res.claim.total : "-"} really closed ${res.closedByKey} | audit after safe ${res.auditPpSafe?.advisories}, after fix ${res.auditFix?.advisories} | separate commands ${ok}/${res.brkTotal} exit 0 | ${res.seconds}s`);
}

// ---- totals and tables ----
const T = planTotals(results);
const md = renderPlanTable(results, T);
writeFile(path.join(outDir, "plan-table.md"), md);
const info = { npmVersion: sh(`${npm} --version`, process.cwd()).stdout.trim(), node: process.version, flags: FLAGS.split(cacheDir).join("<cache>"), hosts: opts["log-hosts"] ? summarizeHostLog(opts["log-hosts"]) : undefined };
writeFile(path.join(outDir, "plan-eval.json"), JSON.stringify({ info, totals: T, results }, null, 1) + "\n");
if (!opts["keep-work"]) fs.rmSync(workDir, { recursive: true, force: true });
console.log(md);
