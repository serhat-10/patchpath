# patchpath benchmark kit

A small, dependency-free kit that measures [patchpath](../README.md) on 34 real lockfiles in two ways:

1. **Detection**: do the vulnerabilities patchpath reports match an independent, OSV-based reference built from the same lockfiles? (precision, recall, three scope variants)
2. **Upgrade plan**: for 10 npm projects, how many advisories are left after applying patchpath's safe step, compared with `npm audit fix`; did patchpath's "clears N" estimate hold; how many of its separate (breaking) commands run.

The kit contains the corpus (pinned commits and file hashes), the scripts, the method and a snapshot of one set of results (`results/round6/`). The scripts themselves contain no results; run them to get your own.

| file | what it is |
|---|---|
| `run-all.mjs` | runs every step below in order |
| `fetch-corpus.mjs` | downloads the pinned lockfiles and verifies their SHA-256 |
| `reference-osv.mjs` | independent reference: own lockfile parsers + OSV queries |
| `run-patchpath.mjs` | runs patchpath on every lockfile, three variants |
| `compare.mjs` | detection comparison (tables, differences) |
| `plan-eval.mjs`, `plan-lib.mjs` | upgrade-plan evaluation |
| `hostlog.mjs`, `lib.mjs` | optional host recorder; shared helpers |
| `corpus.json`, `corpus.lock.json`, `CORPUS.md`, `unrecoverable.md` | the corpus, its hashes, a readable table, projects that could not be reproduced |
| `METHOD.md` | what is measured and how |
| `LIMITATIONS.md` | what the numbers do not show |
| `ADD-A-PROJECT.md` | how to extend the corpus |
| `TROUBLESHOOTING.md` | network, proxy, disk, npm versions, Windows/Linux |
| `results/round6/` | snapshot of the results of one run (tables only) |

## Requirements

- Node 22 or newer. No `npm install` is needed for the kit.
- npm, for the plan evaluation. The snapshot was recorded with npm 11.16.0. `npm audit` and `npm audit fix` differ between npm versions, so note yours (it is saved in `plan/plan-eval.json`).
- A built patchpath: the path to its `dist/cli.js`, or a command on PATH.
- Network access only to `raw.githubusercontent.com` (corpus download), `api.osv.dev` (reference and patchpath) and `registry.npmjs.org` (patchpath and npm). `api.github.com` is needed only to verify new corpus entries by hand (see `ADD-A-PROJECT.md`).
- Disk, as measured in the snapshot run: corpus 26 MB, reference 6 MB, patchpath output 14 MB, comparison under 1 MB; the plan evaluation adds its results plus a temporary npm cache and lockfile copies, which are deleted at the end unless you pass `--keep-work`. Plan for about 100 MB free.
- Time, snapshot run (sequential, desktop PC, home connection, no cache): download and reference a few minutes; patchpath on 34 lockfiles in three variants (JSON and text each) about 34 minutes; comparison seconds; plan evaluation: about 15 minutes of wall time for the 10 projects in the snapshot (some were run side by side), and 3 minutes for typescript alone when run by itself with a cold npm cache, so budget 30 to 40 minutes for a sequential run. Allow about an hour and a half for everything.

## Quick start

The commands are single lines and work the same in bash and PowerShell. Use an output folder outside the kit.

```
node run-all.mjs --patchpath <path-to-patchpath>/dist/cli.js --out work
```

This downloads the corpus, builds the reference, runs patchpath, compares, and evaluates the plans. Read `work/compare/compare.md` (detection), `work/compare/differences.md` (every false positive and false negative) and `work/plan/plan-table.md` (plans).

Options of `run-all.mjs`:

- `--only id,id` runs a subset (for example `--only typescript,chartjs`); `--group npm|yarn-pnpm`
- `--skip-fetch`, `--skip-reference`, `--skip-run`, `--skip-compare`, `--skip-plan` leave a step out and reuse what is already in the output folder
- `--keep-going` continues after a step that failed (default: stop)
- `--log-hosts` records every request that patchpath and npm make in `requests.jsonl` and refuses hosts other than `api.osv.dev` and `registry.npmjs.org`
- `--cache` lets patchpath use its cache (default: `--no-cache`, so timings are cold)
- `--lock`, `--corpus` use another lock file or corpus file; `--npm`, `--npm-cache`, `--keep-work` apply to the plan evaluation

The steps can also be run one at a time:

```
node fetch-corpus.mjs --out work/data
node reference-osv.mjs --data work/data --out work/ref
node run-patchpath.mjs --patchpath <path-to-patchpath>/dist/cli.js --data work/data --out work/runs
node compare.mjs --runs work/runs --ref work/ref --out work/compare
node plan-eval.mjs --patchpath <path-to-patchpath>/dist/cli.js --data work/data --runs work/runs --out work/plan
```

A quick check on one small project: `node run-all.mjs --patchpath <cli.js> --out work --only typescript`.

## What the steps do

- `fetch-corpus.mjs` downloads every file from raw.githubusercontent.com at the pinned SHA and refuses (exit 1, file not written) any file whose SHA-256 differs from `corpus.lock.json`. A re-run skips files that are already present and correct. Downloaded files are data and are never executed.
- `reference-osv.mjs` has its own small parsers for npm v1/v2/v3, yarn v1 and the `packages:` section of pnpm 9. It shares no code with patchpath. It sends 500 queries per request and follows `next_page_token`. Only package names and versions are sent to OSV.
- `run-patchpath.mjs` runs patchpath on each lockfile in three variants and saves `<variant>.json` (`--json`), `<variant>.txt` (text report) and `<variant>.meta.json` (exit codes, durations, JSON validity), plus `run-info.json` with the patchpath version. Runs are sequential.
- `compare.mjs` writes `compare.json`, `compare.md` and `differences.md`.
- `plan-eval.mjs` copies `package.json` and `package-lock.json` of the 10 projects marked `planEval` into scratch folders, applies the commands, and writes `plan-eval.json` and `plan-table.md`. Nothing is installed (`--package-lock-only --ignore-scripts`).

Options common to the scripts: `--only id,id`, `--group npm|yarn-pnpm`, `--corpus <file>`. `fetch-corpus.mjs` also takes `--lock <file>` and `--update-lock` (adds missing hashes, never overwrites existing ones). `run-patchpath.mjs` also takes `--variants`, `--timeout-sec` and `--log-hosts <file>`.

To test the scripts without network, the environment variables `KIT_RAW_BASE` and `KIT_OSV_BASE` replace the two hosts (for example with a local fake server). Leave them unset for real runs.

## Which patchpath

Record the exact version and commit you measured; the scripts store the output of `patchpath --version`. The JSON fields that `compare.mjs` and `plan-eval.mjs` read (`findings`, `vulnerabilities`, `id`, `aliases`, `name`, `version`, `commands[].kind`, `commands[].clears`) match patchpath 0.0.1. `plan-eval.mjs` also parses the `Commands` block of the text report; if its wording changes, `parseCmds` in `plan-lib.mjs` has to follow.

## Before quoting numbers

The corpus is hand-picked, mostly old and front-end heavy; the reference uses the same advisory source as patchpath; `npm audit` results change over time. Read `LIMITATIONS.md`.
