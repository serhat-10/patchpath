// Run patchpath on every fetched lockfile and save the JSON and text output.
// node run-patchpath.mjs --patchpath <path/to/dist/cli.js | command> --data <dir> --out <dir>
//      [--only id,id] [--variants default,nodev,assume-public] [--cache] [--timeout-sec 900] [--log-hosts <file>]
// Variants: default = no extra flag; nodev = --no-dev (npm lockfiles only); assume-public = --assume-public.
// Each variant runs twice: once with --json (<variant>.json) and once for the text report (<variant>.txt).
// --no-cache is passed unless --cache is given. Runs are sequential on purpose. patchpath contacts api.osv.dev and registry.npmjs.org.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseArgs, fail, loadCorpus, writeFile, hostLogEnv } from "./lib.mjs";

const { opts } = parseArgs(process.argv.slice(2), { patchpath: "string", data: "string", out: "string", only: "list", variants: "list", corpus: "string", group: "string", cache: "boolean", "timeout-sec": "string", "log-hosts": "string" });
if (!opts.patchpath || !opts.data || !opts.out) fail("usage: node run-patchpath.mjs --patchpath <cli.js or command> --data <dir> --out <dir>");
const VARIANT_FLAGS = { default: [], nodev: ["--no-dev"], "assume-public": ["--assume-public"] };
const variants = opts.variants?.length ? opts.variants : Object.keys(VARIANT_FLAGS);
for (const v of variants) if (!VARIANT_FLAGS[v]) fail(`unknown variant ${v} (known: ${Object.keys(VARIANT_FLAGS).join(", ")})`);
const timeoutMs = Number(opts["timeout-sec"] || 900) * 1000;
const hostEnv = hostLogEnv(opts["log-hosts"]); // optional: record every request of patchpath in a file (see hostlog.mjs)
const dataDir = path.resolve(opts.data), outDir = path.resolve(opts.out);

const isScript = /\.(m?js|cjs)$/i.test(opts.patchpath);
function run(args, cwd) {
  return new Promise((resolve) => {
    const [cmd, argv] = isScript ? [process.execPath, [path.resolve(opts.patchpath), ...args]] : [opts.patchpath, args];
    const t0 = Date.now();
    const child = spawn(cmd, argv, { cwd, shell: !isScript && process.platform === "win32", windowsHide: true, env: { ...process.env, ...hostEnv } });
    const out = [], err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: null, error: String(e), stdout: "", stderr: "", ms: Date.now() - t0 }); });
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), ms: Date.now() - t0 }); });
  });
}

const ver = await run(["--version"], process.cwd());
if (ver.code !== 0) fail(`cannot run patchpath (${opts.patchpath}): ${ver.error || ver.stderr || "exit " + ver.code}`);
const info = { patchpathVersion: ver.stdout.trim(), node: process.version, platform: process.platform, startedAt: new Date().toISOString(), variants, cache: !!opts.cache };
console.log(`patchpath: ${info.patchpathVersion}`);

const { list } = loadCorpus(opts);
let problems = 0;
for (const p of list) {
  const lockPath = path.join(dataDir, p.id, ...p.lockfilePath.split("/"));
  if (!fs.existsSync(lockPath)) { console.error(`MISSING ${p.id}: ${lockPath} (run fetch-corpus.mjs first)`); problems++; continue; }
  const cwd = path.dirname(lockPath);
  for (const v of variants) {
    if (v === "nodev" && p.type !== "npm") continue;
    const flags = [...VARIANT_FLAGS[v], ...(opts.cache ? [] : ["--no-cache"])];
    const base = path.join(outDir, p.id, v);
    const j = await run([cwd, "--json", ...flags], cwd);
    const t = await run([cwd, ...flags], cwd);
    let jsonOk = false;
    try { JSON.parse(j.stdout); jsonOk = true; } catch { /* recorded below */ }
    writeFile(base + ".json", j.stdout);
    writeFile(base + ".txt", t.stdout);
    writeFile(base + ".meta.json", JSON.stringify({ id: p.id, variant: v, args: { json: ["<dir>", "--json", ...flags], text: ["<dir>", ...flags] }, jsonExit: j.code, textExit: t.code, jsonMs: j.ms, textMs: t.ms, jsonValid: jsonOk, jsonStderr: j.stderr.slice(0, 4000), textStderr: t.stderr.slice(0, 4000) }, null, 1) + "\n");
    const bad = !jsonOk || j.code !== 0 || t.code !== 0;
    if (bad) problems++;
    console.log(`${p.id} ${v}: json exit ${j.code} (${(j.ms / 1000).toFixed(1)}s, ${jsonOk ? "valid" : "INVALID"}), text exit ${t.code}${bad ? "  <-- check .meta.json" : ""}`);
  }
}
info.finishedAt = new Date().toISOString();
writeFile(path.join(outDir, "run-info.json"), JSON.stringify(info, null, 1) + "\n");
console.log(problems ? `${problems} run(s) with problems` : "all runs ok");
process.exitCode = problems ? 1 : 0;
