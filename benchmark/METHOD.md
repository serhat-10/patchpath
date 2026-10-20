# Method

What the kit measures and how. The scripts are the exact definition; this file explains the reasoning.

## Unit

One unit = package `name@version` + advisory id. The same package in two places of a lockfile (two paths, same version) is one unit. The same advisory on two versions is two units.

- patchpath units come from `findings[].vulnerabilities[]` in its `--json` output (`id` and `aliases`).
- Reference units come from OSV `querybatch` answers for the name@version pairs found in the lockfile.
- Two units match when the ids are equal, or when one of patchpath's aliases equals the reference id.

Counting packages instead of advisories, or counting by `npm audit` advisories (GHSA only, one per package|advisory), gives different numbers. This kit reports the advisory-level unit above for detection, and the `npm audit` unit (unique `package|advisory-url` pairs) only for the plan evaluation. The two are not interchangeable (see the end of this file).

## Detection

For each lockfile, `reference-osv.mjs` parses the lockfile with its own code, classifies every entry, and asks OSV (`api.osv.dev/v1/querybatch`, ecosystem `npm`) which advisories affect each name@version. `run-patchpath.mjs` runs patchpath on the same file in three variants. `compare.mjs` matches the two lists.

- precision = patchpath units that match a reference unit / all patchpath units
- recall = in-scope reference units that patchpath reported / all in-scope reference units
- Totals are micro averages over all units of the projects in the variant.
- Differences are listed per project in `differences.md`: false positives (FP), false negatives (FN), and reference units outside the variant's scope that patchpath did not report. The last group is not counted as misses.

### Classes and scope

The reference classifies every lockfile entry (`cls` in `*.ref.json`):

| class | meaning |
|---|---|
| `https-registry` | `resolved` URL on registry.npmjs.org or registry.yarnpkg.com over https |
| `http-registry` | the same hosts over plain http |
| `other-registry` | `resolved` URL on any other host |
| `no-resolved` | npm entry without `resolved`, or pnpm entry with only an integrity |
| (not queried) | git, file, link, directory and workspace entries, and non-semver versions; counted under `excluded` |

An entry of class `no-resolved` may carry two more fields that explain where patchpath finds a public origin for it:

- `viaParent`: the entry is bundled (npm v2/v3 `inBundle`, v1 `bundled`) or is a v1 child written as `"resolved": false` with `optional` (the fsevents tree), and the package that contains it has a registry URL. The entry takes the class of that package.
- `viaDependencies`: in an npm v2/v3 lockfile the entry has no `resolved` in `packages`, but the same name@version has a `resolved` URL in the legacy `dependencies` section.

`compare.mjs` uses the effective class: `viaDependencies`, else `viaParent`, else the entry's own class.

Each patchpath run variant is compared against one scope:

| variant | patchpath flags | reference scope (effective class) |
|---|---|---|
| `default` | none | `https-registry` and `http-registry` |
| `nodev` (npm only) | `--no-dev` | same, without entries carrying the npm `dev` flag |
| `assume-public` | `--assume-public` | same, plus `no-resolved` |

This table is the kit's reading of how patchpath decides what it may look up (`patchpath --help` and its documented behaviour). The kit does not verify it. If patchpath's rules differ, edit `SCOPE` in `compare.mjs`. In the snapshot run, the earlier rule (only `https-registry`, no `viaParent`) made 202 units that patchpath reported look like out-of-scope reports; with the rule above, patchpath's units equal the in-scope reference units minus the false negatives. That agreement does not prove the rule is the right one, only that it describes patchpath's behaviour on this corpus.

The `nodev` reference uses the lockfile's `dev` flag only, while patchpath's `--no-dev` also does a reachability check on v1 lockfiles, so differences there are to be inspected, not assumed to be bugs. yarn and pnpm lockfiles carry no dev flag in the reference, and `nodev` is not run for them.

Reference files written before `viaParent`/`viaDependencies` existed can be updated without network: `node reference-osv.mjs --data <dir> --out <ref dir> --add-via-dependencies` (the OSV answers in the files are kept).

### Why the reference is independent

`reference-osv.mjs` does not import or call any patchpath code and has its own lockfile parsers for npm v1/v2/v3, yarn v1 and the `packages:` section of pnpm 9. The only thing the two sides share is the advisory source (OSV). So the comparison tests lockfile reading, version matching, alias handling, de-duplication and scoping, which is where a scanner usually goes wrong. It does not test whether OSV itself is complete or correct (see `LIMITATIONS.md`).

## Plan evaluation

`plan-eval.mjs` runs on the corpus projects with `"planEval": true`: 10 npm projects. It starts from the `default` run of patchpath: the JSON gives the safe step's claim (`commands[].clears`, "clears N of M"), the text report gives the commands. For each project, in separate scratch copies of `package.json` and `package-lock.json` (nothing is installed):

1. `base`: `npm audit --package-lock-only --json`; unique `package|advisory` pairs = "before".
2. `pp`: patchpath's safe step (`npm install -- ...` and `npm update -- ...` as printed), with the npm flags placed before the `--`, always `--package-lock-only --ignore-scripts --no-audit --no-fund`. Then `npm audit` ("after safe step") and a patchpath re-scan (`--json --no-plan --no-cache`) of the changed lockfile. "Really closed" = patchpath units (name@version|id) from the first run that the re-scan no longer reports. The claim and the really-closed number are both in patchpath's unit, so they can be compared with each other; neither equals the `npm audit` unit.
3. The separate (breaking) commands of the plan, one by one on top of the `pp` copy, cumulative, continuing after a command that fails. Exit 0 per command is counted; ERESOLVE in the output is counted separately. Then `npm audit` ("after safe + all separate commands").
4. `fix`: `npm audit fix` (never `--force`) in a fresh copy, then `npm audit`.

Commands that patchpath prints as comments (a conflict to resolve by hand) are not run. Only lines of the form `npm install|update` followed by words made of letters, digits and `@ / . _ : -` are executed; any other line is recorded as skipped and counts as failed. Commands with `-w`/`--workspace` are flagged (`hasW`); the selected projects have none.

Selection rule for the 10 projects: npm projects of the corpus with at least 49 and at most 214 advisories in `npm audit`, no `-w` command and no commented-out command in the plan, and a patchpath scan under 20 seconds. Excluded and why: see `results/round6/RESULTS.md` section 3 and `CORPUS.md`. The rule is a convenience to keep the run to a few tens of minutes; it is not a sampling design.

Why the plan evaluation does not install anything: `--package-lock-only` resolves versions against the registry and rewrites the lockfile only. It cannot show that the application still builds or its tests pass, so a command that exits 0 here only means npm found a consistent tree.

## Why units are not the same as `npm audit`

- patchpath counts (name@version, OSV id). `npm audit` counts advisories per package name (a range of versions) and reports each as a `via` entry; this kit counts unique `package|advisory-url` pairs, one per advisory and package, regardless of how many versions of the package exist in the lockfile.
- OSV and the GitHub advisory database used by `npm audit` overlap but are not identical, and they are updated at different times. An advisory can exist in one and not in the other, or have different ids (GHSA, CVE, OSV-specific).
- `npm audit` has no `--assume-public` or `--no-dev` equivalents with the same meaning. Its output depends on the npm version and the date.

For the plan columns this means: use the npm audit numbers to compare patchpath's plan with `npm audit fix` (same tool measures both), use the claim/really-closed numbers to judge patchpath's own estimate (same tool, same unit), and do not mix the two.
