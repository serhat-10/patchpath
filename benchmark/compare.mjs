// Compare patchpath output with the OSV reference.
// node compare.mjs --runs <dir> --ref <dir> --out <dir> [--only id,id] [--variants default,nodev,assume-public]
// Unit = package name@version + OSV advisory id. A patchpath unit counts as matching when its id, or one of its aliases,
// is an id the reference lists for the same name@version (and the other way round).
// Reference scope per variant (what patchpath is documented to check in that mode):
//   default        entries resolved over https from registry.npmjs.org / registry.yarnpkg.com (npm: "resolved" read from "packages" or, when missing there, from the "dependencies" section)
//   nodev          the same, minus npm entries flagged "dev"
//   assume-public  the same, plus entries without a "resolved" URL (npm) / integrity-only (pnpm)
// precision = matching patchpath units / patchpath units; recall = matching in-scope reference units / in-scope reference units.
// Reference units outside the scope that patchpath did not report are listed apart ("out of scope"), not counted as misses.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, fail, loadCorpus, readJSON, writeFile } from "./lib.mjs";

// Effective class of a reference entry. A lockfile entry without its own "resolved" URL is scoped by the class recorded by reference-osv.mjs:
// "viaDependencies" (the same name@version has a "resolved" URL in the legacy "dependencies" section) or "viaParent" (a bundled package takes the
// class of the package that bundles it). patchpath reads both. Entries with neither stay "no-resolved".
const eff = (e) => (e.cls === "no-resolved" ? e.viaDependencies || e.viaParent || e.cls : e.cls);
const PUBLIC = (e) => eff(e) === "https-registry" || eff(e) === "http-registry"; // patchpath accepts http://registry.npmjs.org/ and http://registry.yarnpkg.com/ as public
const SCOPE = {
  default: PUBLIC,
  nodev: (e) => PUBLIC(e) && e.dev !== true,
  "assume-public": (e) => PUBLIC(e) || eff(e) === "no-resolved",
};

const { opts } = parseArgs(process.argv.slice(2), { runs: "string", ref: "string", out: "string", only: "list", variants: "list", corpus: "string", group: "string" });
if (!opts.runs || !opts.ref || !opts.out) fail("usage: node compare.mjs --runs <dir> --ref <dir> --out <dir> [--only id,id]");
const variants = opts.variants?.length ? opts.variants : Object.keys(SCOPE);
for (const v of variants) if (!SCOPE[v]) fail(`unknown variant ${v}`);
const { list } = loadCorpus(opts);

const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
const fmt = (x) => (x === null ? "n/a" : x.toFixed(1) + "%");
const results = [];
const diffs = {};

for (const p of list) {
  const refFile = path.join(path.resolve(opts.ref), p.id + ".ref.json");
  if (!fs.existsSync(refFile)) { console.error(`no reference for ${p.id}, skipped`); continue; }
  const ref = readJSON(refFile);
  const refAll = new Map(ref.entries.map((e) => [e.name + "@" + e.version, e]));
  for (const v of variants) {
    const runFile = path.join(path.resolve(opts.runs), p.id, v + ".json");
    if (!fs.existsSync(runFile)) continue; // e.g. nodev for yarn/pnpm
    let run;
    try { run = readJSON(runFile); } catch { console.error(`${p.id}/${v}: patchpath output is not valid JSON, skipped`); continue; }

    // patchpath units
    const pp = new Map(); // key -> [{id, aliases}]
    let ppUnits = 0;
    for (const f of run.findings || []) {
      const key = f.name + "@" + f.version;
      for (const x of f.vulnerabilities || []) {
        if (!pp.has(key)) pp.set(key, []);
        pp.get(key).push({ id: x.id, aliases: x.aliases || [] });
        ppUnits++;
      }
    }
    let tpPp = 0;
    const fp = [];
    for (const [key, vs] of pp) {
      const r = refAll.get(key);
      for (const x of vs) {
        const hit = r && [x.id, ...x.aliases].some((i) => r.ids.includes(i));
        if (hit) tpPp++;
        else fp.push(`${key} ${x.id}` + (r ? " (reference has no such id for this version)" : " (name@version not in reference: excluded class or not queried)"));
      }
    }

    // reference units
    const inScope = SCOPE[v];
    let refIn = 0, tpRef = 0, refOut = 0, outFound = 0;
    const fn = [], outMissed = [];
    for (const e of ref.entries) {
      const mine = pp.get(e.name + "@" + e.version) || [];
      const scoped = inScope(e);
      for (const id of e.ids) {
        const found = mine.some((x) => x.id === id || x.aliases.includes(id));
        if (scoped) { refIn++; if (found) tpRef++; else fn.push(`${e.name}@${e.version} ${id}`); }
        else { refOut++; if (found) outFound++; else outMissed.push(`${e.name}@${e.version} ${id} [${eff(e)}${e.dev ? ", dev" : ""}]`); }
      }
    }
    results.push({
      id: p.id, type: p.type, variant: v, patchpathVersion: run.version ?? null,
      packages: run.summary?.packages ?? null, external: run.summary?.external ?? null,
      patchpathUnits: ppUnits, referenceUnitsInScope: refIn, matchedPatchpath: tpPp, matchedReference: tpRef,
      falsePositives: fp.length, falseNegatives: fn.length,
      precision: pct(tpPp, ppUnits), recall: pct(tpRef, refIn),
      referenceUnitsOutOfScope: refOut, outOfScopeReportedAnyway: outFound, outOfScopeNotReported: outMissed.length,
    });
    diffs[`${p.id}/${v}`] = { falsePositives: fp, falseNegatives: fn, outOfScopeNotReported: outMissed };
  }
}

// totals per variant (micro-average over all units)
const totals = {};
for (const v of variants) {
  const rs = results.filter((r) => r.variant === v);
  if (!rs.length) continue;
  const s = (k) => rs.reduce((n, r) => n + r[k], 0);
  totals[v] = { projects: rs.length, patchpathUnits: s("patchpathUnits"), referenceUnitsInScope: s("referenceUnitsInScope"), matchedPatchpath: s("matchedPatchpath"), matchedReference: s("matchedReference"),
    falsePositives: s("falsePositives"), falseNegatives: s("falseNegatives"), precision: pct(s("matchedPatchpath"), s("patchpathUnits")), recall: pct(s("matchedReference"), s("referenceUnitsInScope")),
    referenceUnitsOutOfScope: s("referenceUnitsOutOfScope"), outOfScopeNotReported: s("outOfScopeNotReported") };
}

const out = path.resolve(opts.out);
writeFile(path.join(out, "compare.json"), JSON.stringify({ unit: "name@version + OSV id", scope: Object.fromEntries(Object.entries({ default: "https registry entries", nodev: "https registry entries, npm dev flag excluded", "assume-public": "https registry entries + entries without resolved" })), totals, results, diffs }, null, 1) + "\n");

let md = "# Comparison\n\nUnit: package name@version + OSV advisory id. FP = patchpath unit with no matching reference id; FN = in-scope reference unit patchpath did not report.\n\n";
for (const v of variants) {
  const rs = results.filter((r) => r.variant === v);
  if (!rs.length) continue;
  const t = totals[v];
  md += `## Variant: ${v}\n\nTotals over ${t.projects} projects: patchpath ${t.patchpathUnits} units, reference (in scope) ${t.referenceUnitsInScope}; FP ${t.falsePositives}, FN ${t.falseNegatives}; precision ${fmt(t.precision)}, recall ${fmt(t.recall)}. Reference units out of scope: ${t.referenceUnitsOutOfScope} (not reported by patchpath: ${t.outOfScopeNotReported}).\n\n`;
  md += "| project | type | patchpath | reference | FP | FN | precision | recall | out of scope (not reported) |\n|---|---|---:|---:|---:|---:|---:|---:|---:|\n";
  for (const r of rs) md += `| ${r.id} | ${r.type} | ${r.patchpathUnits} | ${r.referenceUnitsInScope} | ${r.falsePositives} | ${r.falseNegatives} | ${fmt(r.precision)} | ${fmt(r.recall)} | ${r.referenceUnitsOutOfScope} (${r.outOfScopeNotReported}) |\n`;
  md += "\n";
}
writeFile(path.join(out, "compare.md"), md);
let dm = "# Differences\n\nOne list per project and variant. Package names and ids come from lockfiles and OSV (data).\n";
for (const [k, d] of Object.entries(diffs)) {
  if (!d.falsePositives.length && !d.falseNegatives.length && !d.outOfScopeNotReported.length) continue;
  dm += `\n## ${k}\n`;
  for (const [title, arr] of [["Reported by patchpath, not matched by the reference (FP)", d.falsePositives], ["In the reference, not reported by patchpath (FN)", d.falseNegatives], ["Outside the variant's scope and not reported (not a miss)", d.outOfScopeNotReported]]) {
    if (!arr.length) continue;
    dm += `\n${title}: ${arr.length}\n\n${arr.map((x) => "- " + x).join("\n")}\n`;
  }
}
writeFile(path.join(out, "differences.md"), dm);
console.log(md);
