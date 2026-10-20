// Shared helpers for the benchmark kit scripts. No dependencies, Node >= 22.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

if (Number(process.versions.node.split(".")[0]) < 22) {
  console.error(`Node >= 22 is required (found ${process.versions.node}).`);
  process.exit(2);
}

export const KIT_DIR = path.dirname(fileURLToPath(import.meta.url));

// Hosts. The overrides exist only so the scripts can be tested against a local fake server.
export const RAW_BASE = (process.env.KIT_RAW_BASE || "https://raw.githubusercontent.com").replace(/\/+$/, "");
export const OSV_BASE = (process.env.KIT_OSV_BASE || "https://api.osv.dev").replace(/\/+$/, "");

// parseArgs(argv, { name: "string" | "boolean" | "list" }) -> { opts, rest }
export function parseArgs(argv, spec) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { rest.push(a); continue; }
    let [k, v] = a.slice(2).split(/=(.*)/s, 2);
    const t = spec[k];
    if (!t) fail(`unknown option --${k}`);
    if (t === "boolean") { opts[k] = true; continue; }
    if (v === undefined) { v = argv[++i]; if (v === undefined) fail(`--${k} needs a value`); }
    if (t === "list") (opts[k] ||= []).push(...v.split(",").filter(Boolean));
    else opts[k] = v;
  }
  return { opts, rest };
}

export function fail(msg) { console.error("error: " + msg); process.exit(2); }

export const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
export const readJSON = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
export function writeFile(p, data) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); }
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Corpus entries, optionally filtered by --only id,id
export function loadCorpus(opts) {
  const file = path.resolve(opts.corpus || path.join(KIT_DIR, "corpus.json"));
  const c = readJSON(file);
  let list = c.projects;
  if (opts.only?.length) {
    const unknown = opts.only.filter((id) => !list.some((p) => p.id === id));
    if (unknown.length) fail("unknown project id(s): " + unknown.join(", "));
    list = list.filter((p) => opts.only.includes(p.id));
  }
  if (opts.group) list = list.filter((p) => p.group === opts.group);
  return { file, list };
}

// fetch with retries on network errors, 429 and 5xx
export async function fetchRetry(url, init = {}, tries = 4) {
  let last;
  for (let n = 0; n < tries; n++) {
    try {
      const r = await fetch(url, init);
      if (r.status === 429 || r.status >= 500) { last = new Error(`HTTP ${r.status}`); await sleep(1000 * 2 ** n); continue; }
      return r;
    } catch (e) { last = e; await sleep(1000 * 2 ** n); }
  }
  throw last;
}

// ---- helpers shared by run-patchpath.mjs and plan-eval.mjs ----
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Environment that loads hostlog.mjs into every Node process started below (patchpath, npm). Returns {} when no log file is wanted.
export function hostLogEnv(logFile) {
  if (!logFile) return {};
  const imp = `--import=${pathToFileURL(path.join(KIT_DIR, "hostlog.mjs")).href}`;
  return { NODE_OPTIONS: [process.env.NODE_OPTIONS, imp].filter(Boolean).join(" "), KIT_REQLOG: path.resolve(logFile) };
}

// Count the requests recorded by hostlog.mjs: { total, byHost: {host: n}, blocked: n, blockedHosts: {host: n} }
export function summarizeHostLog(logFile) {
  const s = { total: 0, byHost: {}, blocked: 0, blockedHosts: {} };
  if (!fs.existsSync(logFile)) return s;
  for (const line of fs.readFileSync(logFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    s.total++;
    s.byHost[r.host] = (s.byHost[r.host] || 0) + 1;
    if (r.ok === false) { s.blocked++; s.blockedHosts[r.host] = (s.blockedHosts[r.host] || 0) + 1; }
  }
  return s;
}

// Run a shell command string (cwd, optional env additions). Never throws. Used for npm and for patchpath's printed commands.
export function sh(cmd, cwd, { timeoutMs = 600000, env = {} } = {}) {
  const t0 = Date.now();
  const r = spawnSync(cmd, { cwd, shell: true, encoding: "utf8", timeout: timeoutMs, maxBuffer: 1 << 28, windowsHide: true, env: { ...process.env, ...env } });
  return { code: r.status, ms: Date.now() - t0, out: (r.stdout || "") + (r.stderr || ""), stdout: r.stdout || "", signal: r.signal };
}

// Quote one argument for the platform shell.
export const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;

// Command line that runs patchpath: a .js/.mjs/.cjs path runs with the current Node, anything else is taken as a command on PATH.
export const patchpathCmd = (p) => (/\.(m?js|cjs)$/i.test(p) ? `${q(process.execPath)} ${q(path.resolve(p))}` : p);
