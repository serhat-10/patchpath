// Run the whole benchmark: fetch -> reference -> run -> compare -> plan-eval.
// node run-all.mjs --patchpath <cli.js | command> --out <dir> [--only id,id] [--group npm|yarn-pnpm] [--corpus <file>] [--lock <file>]
//      [--skip-fetch] [--skip-reference] [--skip-run] [--skip-compare] [--skip-plan] [--cache] [--log-hosts]
//      [--keep-going] [--timeout-sec 900] [--npm-cache <dir>] [--npm <command>] [--keep-work]
// Layout of <dir>: data/ (downloaded files), ref/ (OSV reference), runs/ (patchpath output), compare/ (tables),
// plan/ (plan evaluation), requests.jsonl (with --log-hosts), run-all.json (what ran, exit codes, durations).
// --skip-* leaves a step out and reuses what is already in <dir>. Without --keep-going the run stops at the first step that fails.
// --only applies to every step; plan-eval then takes the planEval projects among them (all planEval projects when --only is not given).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseArgs, fail, loadCorpus, writeFile, KIT_DIR, summarizeHostLog } from "./lib.mjs";

const { opts } = parseArgs(process.argv.slice(2), {
  patchpath: "string", out: "string", only: "list", group: "string", corpus: "string", lock: "string", cache: "boolean", "timeout-sec": "string", "npm-cache": "string", npm: "string",
  "skip-fetch": "boolean", "skip-reference": "boolean", "skip-run": "boolean", "skip-compare": "boolean", "skip-plan": "boolean",
  "log-hosts": "boolean", "keep-going": "boolean", "keep-work": "boolean",
});
if (!opts.out) fail("usage: node run-all.mjs --patchpath <cli.js or command> --out <dir> [--only id,id] [--skip-plan] ...");
const needPatchpath = !(opts["skip-run"] && opts["skip-compare"] && opts["skip-plan"]);
if (needPatchpath && !opts.patchpath) fail("--patchpath is required unless the run, compare and plan steps are all skipped");

const out = path.resolve(opts.out);
const D = { data: path.join(out, "data"), ref: path.join(out, "ref"), runs: path.join(out, "runs"), compare: path.join(out, "compare"), plan: path.join(out, "plan") };
const hostLog = opts["log-hosts"] ? path.join(out, "requests.jsonl") : null;
const { list } = loadCorpus(opts);
const planIds = list.filter((p) => p.type === "npm" && (opts.only?.length ? true : p.planEval === true)).map((p) => p.id);

const sel = [...(opts.only?.length ? ["--only", opts.only.join(",")] : []), ...(opts.group ? ["--group", opts.group] : []), ...(opts.corpus ? ["--corpus", opts.corpus] : [])];
const steps = [
  { name: "fetch", skip: opts["skip-fetch"], script: "fetch-corpus.mjs", args: ["--out", D.data, ...sel, ...(opts.lock ? ["--lock", opts.lock] : [])] },
  { name: "reference", skip: opts["skip-reference"], script: "reference-osv.mjs", args: ["--data", D.data, "--out", D.ref, ...sel] },
  { name: "run", skip: opts["skip-run"], script: "run-patchpath.mjs", args: ["--patchpath", opts.patchpath, "--data", D.data, "--out", D.runs, ...sel, ...(opts.cache ? ["--cache"] : []), ...(opts["timeout-sec"] ? ["--timeout-sec", opts["timeout-sec"]] : []), ...(hostLog ? ["--log-hosts", hostLog] : [])] },
  { name: "compare", skip: opts["skip-compare"], script: "compare.mjs", args: ["--runs", D.runs, "--ref", D.ref, "--out", D.compare, ...sel] },
  {
    name: "plan-eval", skip: opts["skip-plan"] || !planIds.length, skipWhy: !planIds.length && !opts["skip-plan"] ? "no npm project with planEval among the selected projects" : null,
    script: "plan-eval.mjs",
    args: ["--patchpath", opts.patchpath, "--data", D.data, "--runs", D.runs, "--out", D.plan, "--only", planIds.join(","), ...(opts.corpus ? ["--corpus", opts.corpus] : []), ...(opts["npm-cache"] ? ["--cache", opts["npm-cache"]] : []), ...(opts.npm ? ["--npm", opts.npm] : []), ...(opts["keep-work"] ? ["--keep-work"] : []), ...(hostLog ? ["--log-hosts", hostLog] : [])],
  },
];

function runStep(s) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [path.join(KIT_DIR, s.script), ...s.args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const prefix = `[${s.name}] `;
    const pipe = (stream, sink) => {
      let buf = "";
      stream.on("data", (d) => { buf += d; const lines = buf.split("\n"); buf = lines.pop(); for (const l of lines) sink.write(prefix + l + "\n"); });
      stream.on("end", () => { if (buf) sink.write(prefix + buf + "\n"); });
    };
    pipe(child.stdout, process.stdout); pipe(child.stderr, process.stderr);
    child.on("error", (e) => { console.error(prefix + "cannot start: " + e.message); resolve({ code: 2, ms: Date.now() - t0 }); });
    child.on("close", (code) => resolve({ code, ms: Date.now() - t0 }));
  });
}

fs.mkdirSync(out, { recursive: true });
const summary = { startedAt: new Date().toISOString(), node: process.version, platform: process.platform, options: { only: opts.only ?? null, group: opts.group ?? null }, steps: [] };
let stopped = false;
steps.forEach((s, i) => console.log(`step ${i + 1}/${steps.length} ${s.name}: ${s.skip ? "skipped" + (s.skipWhy ? " (" + s.skipWhy + ")" : "") : "will run"}`));
for (const [i, s] of steps.entries()) {
  if (s.skip) { summary.steps.push({ name: s.name, status: "skipped", reason: s.skipWhy || "flag" }); continue; }
  if (stopped) { summary.steps.push({ name: s.name, status: "not run (earlier step failed)" }); continue; }
  console.log(`\n=== step ${i + 1}/${steps.length}: ${s.name} ===`);
  const r = await runStep(s);
  console.log(`=== ${s.name}: exit ${r.code}, ${(r.ms / 1000).toFixed(1)} s ===`);
  summary.steps.push({ name: s.name, status: r.code === 0 ? "ok" : "failed", exit: r.code, seconds: Math.round(r.ms / 100) / 10 });
  // exit 1 of fetch/reference/run means "some items had problems"; later steps still work on the rest only with --keep-going
  if (r.code !== 0 && !opts["keep-going"]) stopped = true;
}
summary.finishedAt = new Date().toISOString();
if (hostLog) summary.hosts = summarizeHostLog(hostLog);
writeFile(path.join(out, "run-all.json"), JSON.stringify(summary, null, 1) + "\n");
console.log("\nsummary:");
for (const s of summary.steps) console.log(`  ${s.name}: ${s.status}${s.seconds !== undefined ? ` (${s.seconds} s)` : ""}`);
if (summary.hosts) console.log(`  requests: ${summary.hosts.total}, by host ${JSON.stringify(summary.hosts.byHost)}, blocked ${summary.hosts.blocked}`);
console.log(`results in ${out}: compare/compare.md, compare/differences.md, plan/plan-table.md`);
process.exitCode = summary.steps.some((s) => s.status === "failed") ? 1 : 0;
