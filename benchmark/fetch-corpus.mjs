// Download the pinned corpus files from raw.githubusercontent.com and verify their SHA-256 against corpus.lock.json.
// node fetch-corpus.mjs --out <dir> [--only id,id] [--corpus corpus.json] [--lock corpus.lock.json] [--update-lock]
// Files land in <dir>/<id>/<repo-relative path>. Downloaded files are data: they are never executed.
import fs from "node:fs";
import path from "node:path";
import { parseArgs, fail, loadCorpus, readJSON, sha256, writeFile, fetchRetry, RAW_BASE, KIT_DIR } from "./lib.mjs";

const { opts } = parseArgs(process.argv.slice(2), { out: "string", only: "list", corpus: "string", lock: "string", group: "string", "update-lock": "boolean" });
if (!opts.out) fail("usage: node fetch-corpus.mjs --out <dir> [--only id,id] [--group npm|yarn-pnpm]");
const { list } = loadCorpus(opts);
const lockFile = path.resolve(opts.lock || path.join(KIT_DIR, "corpus.lock.json"));
const lock = fs.existsSync(lockFile) ? readJSON(lockFile) : { schema: 1, algorithm: "sha256", files: {} };
const outDir = path.resolve(opts.out);

let ok = 0, bad = 0, cached = 0, bytes = 0;
for (const p of list) {
  const paths = [p.lockfilePath, p.manifestPath, ...(p.workspaceManifestPaths || []).map((w) => w)];
  for (const rel of [...new Set(paths)]) {
    const key = `${p.id}/${rel}`;
    const dest = path.join(outDir, p.id, ...rel.split("/"));
    const expected = lock.files[key]?.sha256;
    if (!expected && !opts["update-lock"]) { console.error(`NOLOCK ${key} (no entry in lock file)`); bad++; continue; }
    if (expected && fs.existsSync(dest) && sha256(fs.readFileSync(dest)) === expected) { cached++; continue; }
    const url = `${RAW_BASE}/${p.repo}/${p.sha}/${rel}`;
    let buf;
    try {
      const r = await fetchRetry(url);
      if (!r.ok) { console.error(`FAIL ${key}: HTTP ${r.status}`); bad++; continue; }
      buf = Buffer.from(await r.arrayBuffer());
    } catch (e) { console.error(`FAIL ${key}: ${e.message}`); bad++; continue; }
    const got = sha256(buf);
    if (opts["update-lock"] && !expected) lock.files[key] = { sha256: got, bytes: buf.length };
    else if (got !== expected) { console.error(`MISMATCH ${key}: expected ${expected}, got ${got} (not written)`); bad++; continue; }
    writeFile(dest, buf); bytes += buf.length; ok++;
  }
  console.log(`${p.id}: done`);
}
if (opts["update-lock"]) writeFile(lockFile, JSON.stringify(lock, null, 1) + "\n");
console.log(`downloaded ${ok} files (${(bytes / 1048576).toFixed(1)} MiB), already present and verified ${cached}, problems ${bad}`);
process.exitCode = bad ? 1 : 0; // not process.exit(): on Windows it can abort Node while fetch sockets are still closing
