// Independent reference: read name+version pairs straight from each lockfile (own simple parsers, no patchpath code)
// and ask api.osv.dev/v1/querybatch which OSV ids affect them.
// node reference-osv.mjs --data <dir> --out <dir> [--only id,id]
// Output: <out>/<id>.ref.json  { entries: [{ name, version, cls, dev, ids }], excluded: { reason: count } }
// cls: https-registry        resolved from https://registry.npmjs.org or registry.yarnpkg.com
//      http-registry         same hosts over plain http
//      no-resolved           npm entry without "resolved", or pnpm entry with only an integrity (registry assumed)
//      other-registry        resolved from any other host
// Git, file, link, directory and workspace entries are not queried (counted in "excluded").
// Two optional fields only exist on entries of class no-resolved; compare.mjs uses them to scope such entries:
//   viaDependencies  npm v2/v3: class of the "resolved" URL the same name@version has in the legacy "dependencies" section.
//   viaParent        npm: class of the package that bundles this one. Bundled packages (npm v2/v3 "inBundle", v1 "bundled", and the v1
//                    "resolved": false + "optional" children of a public package, e.g. the fsevents tree) have no URL of their own.
// dev: true / false for npm lockfiles (the "dev" flag; devOptional counts as not dev), null for yarn and pnpm.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, fail, loadCorpus, writeFile, fetchRetry, OSV_BASE } from "./lib.mjs";

const SEMVERISH = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/;

function classifyUrl(u) {
  const m = /^(https?):\/\/([^/]+)\//.exec(u);
  if (!m) return null;
  const pub = m[2] === "registry.npmjs.org" || m[2] === "registry.yarnpkg.com";
  if (!pub) return "other-registry";
  return m[1] === "https" ? "https-registry" : "http-registry";
}
const looksLikeGit = (u) =>
  /^(git[+:@]|github:|gitlab:|bitbucket:|ssh:)/.test(u) || /\.git(#|$)/.test(u) || /^https?:\/\/(codeload\.github\.com|github\.com|gitlab\.com|bitbucket\.org)\//.test(u);

// Collects one entry per name@version; counts what was left out.
function makeSink() {
  const map = new Map();
  const excluded = {};
  const cnt = (r) => { excluded[r] = (excluded[r] || 0) + 1; };
  const RANK = { "https-registry": 0, "http-registry": 1, "other-registry": 2, "no-resolved": 3 };
  return {
    excluded,
    cnt,
    add(name, version, cls, dev, via = {}) {
      if (!name || !SEMVERISH.test(version || "")) { cnt("non-semver-version"); return; }
      const k = name + "@" + version;
      const e = map.get(k);
      if (!e) { map.set(k, { name, version, cls, dev, ...(via.viaDependencies ? { viaDependencies: via.viaDependencies } : {}), ...(via.viaParent ? { viaParent: via.viaParent } : {}) }); return; }
      if (RANK[cls] < RANK[e.cls]) e.cls = cls;
      for (const f of ["viaDependencies", "viaParent"]) if (via[f] && !e[f]) e[f] = via[f];
      if (e.dev === true && dev === false) e.dev = false;
    },
    entries: () => [...map.values()],
  };
}

// npm package-lock.json / npm-shrinkwrap.json (v1 "dependencies", v2/v3 "packages")
// name@version -> best class of any "resolved" URL in the legacy "dependencies" section (only used for entries without "resolved")
function dependenciesClasses(j) {
  const RANK = { "https-registry": 0, "http-registry": 1, "other-registry": 2 };
  const m = new Map();
  (function walk(deps) {
    for (const [n, e] of Object.entries(deps || {})) {
      if (typeof e.resolved === "string" && typeof e.version === "string" && !e.version.startsWith("npm:") && !/^(file|link):/.test(e.resolved) && !looksLikeGit(e.resolved)) {
        const cls = classifyUrl(e.resolved) || "other-registry";
        const k = n + "@" + e.version;
        if (!m.has(k) || RANK[cls] < RANK[m.get(k)]) m.set(k, cls);
      }
      walk(e.dependencies);
    }
  })(j.dependencies);
  return m;
}

function parseNpm(text, sink) {
  const j = JSON.parse(text);
  const depCls = j.packages && j.dependencies ? dependenciesClasses(j) : null;
  // class of the URL on an entry, or of the bundling package for a bundled entry (undefined when neither is known)
  const one = (name, entry, parentCls) => {
    let version = entry.version;
    const resolved = entry.resolved;
    if (typeof version === "string" && version.startsWith("npm:")) { // v1 alias "npm:real@1.2.3"
      const body = version.slice(4);
      const i = body.lastIndexOf("@");
      name = body.slice(0, i);
      version = body.slice(i + 1);
    }
    if (typeof resolved === "string" && /^(file|link):/.test(resolved)) return sink.cnt("file-or-link");
    if (typeof resolved === "string" && looksLikeGit(resolved)) return sink.cnt("git");
    if (typeof version === "string" && (looksLikeGit(version) || /^(file|link):/.test(version))) return sink.cnt("git-or-file");
    const cls = typeof resolved === "string" ? classifyUrl(resolved) || "other-registry" : "no-resolved";
    const unresolved = cls === "no-resolved";
    const viaParent = unresolved ? parentCls : undefined;
    sink.add(name, version, cls, entry.dev === true, unresolved ? { viaDependencies: depCls?.get(name + "@" + version), viaParent } : {});
    return unresolved ? viaParent : cls;
  };
  const classOfKey = (key, seen = 0) => { // npm v2/v3: class of the "packages" entry at key, following inBundle upwards
    const e = j.packages[key];
    if (!e || seen > 50) return undefined;
    if (typeof e.resolved === "string") return /^(file|link):/.test(e.resolved) || looksLikeGit(e.resolved) ? undefined : classifyUrl(e.resolved) || "other-registry";
    return bundlerClass(key, e, seen + 1);
  };
  const bundlerClass = (key, e, seen = 0) => {
    if (!e.inBundle) return undefined;
    const cut = key.lastIndexOf("/node_modules/");
    // the closest ancestor folder; when that is the project itself (no node_modules before it) the entry is an ordinary dependency
    return cut > 0 && key.slice(0, cut).includes("node_modules/") ? classOfKey(key.slice(0, cut), seen) : undefined;
  };
  if (j.packages) {
    for (const [key, entry] of Object.entries(j.packages)) {
      if (key === "") continue;
      if (entry.link) { sink.cnt("link"); continue; }
      const i = key.lastIndexOf("node_modules/");
      if (i < 0) { sink.cnt("workspace-or-local"); continue; }
      one(entry.name || key.slice(i + "node_modules/".length), entry, bundlerClass(key, entry));
    }
  } else if (j.dependencies) {
    (function walk(deps, parentCls) {
      for (const [n, e] of Object.entries(deps)) {
        const inherit = e.bundled === true || (e.resolved === false && e.optional === true) ? (e.bundled === true ? parentCls : parentCls === "https-registry" || parentCls === "http-registry" ? parentCls : undefined) : undefined;
        const own = one(n, e, inherit);
        if (e.dependencies) walk(e.dependencies, own);
      }
    })(j.dependencies, undefined);
  } else fail("no packages/dependencies in npm lockfile");
}

// yarn.lock v1
function parseYarn(text, sink) {
  if (/^__metadata:/m.test(text)) fail("yarn berry lockfile (not v1)");
  const blocks = text.replace(/\r\n/g, "\n").split(/\n(?=\S)/);
  for (const b of blocks) {
    const head = b.split("\n")[0];
    if (!head.endsWith(":") || head.startsWith("#")) continue;
    const specs = head.slice(0, -1).split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
    const field = (f) => { const m = new RegExp(`^  ${f} "?([^"\\n]+)"?$`, "m").exec(b); return m ? m[1] : null; };
    const version = field("version");
    const resolved = field("resolved");
    const first = specs[0];
    const at = first.indexOf("@", 1);
    const range = first.slice(at + 1);
    let name = first.slice(0, at);
    if (specs.every((s) => /@(link|file):/.test(s))) { sink.cnt("file-or-link"); continue; }
    if (!resolved) { sink.cnt("no-resolved-yarn"); continue; }
    const url = resolved.split("#")[0];
    if (looksLikeGit(url) || /^git/.test(range)) { sink.cnt("git-or-tarball-url"); continue; }
    const cls = classifyUrl(url);
    if (!cls) { sink.cnt("unknown-resolved"); continue; }
    const m = /^https?:\/\/[^/]+\/((?:@[^/]+\/)?[^/]+)\/-\//.exec(url); // real package name (also for npm: aliases)
    if (m) name = decodeURIComponent(m[1]);
    sink.add(name, version, cls, null);
  }
}

// pnpm-lock.yaml, lockfileVersion 9: the "packages:" section only
function parsePnpm(text, sink) {
  if (!/^lockfileVersion: *'?9/m.test(text)) fail("pnpm lockfile is not version 9");
  let inPk = false;
  let key = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) { inPk = line.startsWith("packages:"); key = null; continue; }
    if (!inPk) continue;
    let m = /^ {2}('?)([^ ].*?)\1:\s*$/.exec(line);
    if (m) { key = m[2]; continue; }
    m = /^ {4}resolution: (.*)$/.exec(line);
    if (!m || !key) continue;
    const res = m[1];
    const i = key.indexOf("@", 1);
    const name = key.slice(0, i);
    const version = key.slice(i + 1);
    if (/directory:|type: *git|repo:/.test(res) || !SEMVERISH.test(version)) {
      sink.cnt(/directory:/.test(res) ? "directory" : "git-or-nonsemver");
    } else {
      const t = /tarball: *([^,}\s]+)/.exec(res);
      sink.add(name, version, t ? classifyUrl(t[1]) || "other-registry" : "no-resolved", null);
    }
    key = null;
  }
}

async function queryOsv(entries) {
  const out = new Map();
  const B = 500;
  for (let i = 0; i < entries.length; i += B) {
    let qs = entries.slice(i, i + B).map((e) => ({ e, q: { package: { name: e.name, ecosystem: "npm" }, version: e.version } }));
    while (qs.length) {
      const r = await fetchRetry(OSV_BASE + "/v1/querybatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ queries: qs.map((x) => x.q) }),
      });
      if (!r.ok) throw new Error("OSV HTTP " + r.status);
      const j = await r.json();
      if (!Array.isArray(j.results) || j.results.length !== qs.length) throw new Error("unexpected OSV response shape");
      const next = [];
      j.results.forEach((res, k) => {
        const key = qs[k].e.name + "@" + qs[k].e.version;
        const set = out.get(key) || new Set();
        for (const v of res.vulns || []) set.add(v.id);
        out.set(key, set);
        if (res.next_page_token) next.push({ e: qs[k].e, q: { ...qs[k].q, page_token: res.next_page_token } });
      });
      qs = next;
    }
  }
  return out;
}

const { opts } = parseArgs(process.argv.slice(2), { data: "string", out: "string", only: "list", corpus: "string", group: "string", "add-via-dependencies": "boolean" });
if (!opts.data || !opts.out) fail("usage: node reference-osv.mjs --data <dir> --out <dir> [--only id,id] [--add-via-dependencies]");
const { list } = loadCorpus(opts);
for (const p of list) {
  const lock = path.join(path.resolve(opts.data), p.id, ...p.lockfilePath.split("/"));
  if (!fs.existsSync(lock)) { console.error(`MISSING ${p.id}: run fetch-corpus.mjs first`); process.exitCode = 1; continue; }
  const sink = makeSink();
  ({ npm: parseNpm, yarn: parseYarn, pnpm: parsePnpm })[p.type](fs.readFileSync(lock, "utf8"), sink);
  const entries = sink.entries();
  if (opts["add-via-dependencies"]) {
    // Offline: no OSV request. Adds "viaDependencies" to an existing <id>.ref.json written by an older version of this script; ids are kept.
    const file = path.join(path.resolve(opts.out), p.id + ".ref.json");
    if (!fs.existsSync(file)) { console.error(`MISSING ${file}`); process.exitCode = 1; continue; }
    const old = JSON.parse(fs.readFileSync(file, "utf8"));
    const via = new Map(entries.map((e) => [e.name + "@" + e.version, e]));
    let n = 0;
    for (const e of old.entries) {
      const v = via.get(e.name + "@" + e.version);
      for (const f of ["viaDependencies", "viaParent"]) { if (v?.[f] && e.cls === "no-resolved") { e[f] = v[f]; n++; } else delete e[f]; }
    }
    writeFile(file, JSON.stringify(old, null, 1) + "\n");
    console.log(`${p.id}: viaDependencies/viaParent set ${n} times (offline)`);
    continue;
  }
  const ids = await queryOsv(entries);
  for (const e of entries) e.ids = [...(ids.get(e.name + "@" + e.version) || [])].sort();
  const byClass = {};
  for (const e of entries) byClass[e.cls] = (byClass[e.cls] || 0) + 1;
  writeFile(
    path.join(path.resolve(opts.out), p.id + ".ref.json"),
    JSON.stringify({ id: p.id, type: p.type, queriedAt: new Date().toISOString(), queried: entries.length, byClass, excluded: sink.excluded, entries }, null, 1) + "\n",
  );
  console.log(`${p.id}: ${entries.length} name@version pairs queried, ${entries.filter((e) => e.ids.length).length} with advisories, ${entries.reduce((n, e) => n + e.ids.length, 0)} ids`);
}
