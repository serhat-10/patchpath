# Limitations

What the numbers of this kit do not show.

## The corpus

- It is hand-picked, not a sample of npm or of any population. Nobody drew it at random and it was not balanced for ecosystems, sizes or age.
- It is old: most commits are from 2019 to 2024 (a few from 2026). Old lockfiles have many advisories and old formats (npm lockfile v1, yarn v1), which suits a scanner test but says little about lockfiles written today.
- It is front-end heavy: React, Angular, Vue, Next.js, Gatsby, Electron apps, plus several servers and libraries. Python, Go, Rust, Java and other ecosystems are not covered (patchpath does not scan them).
- Projects were chosen partly because they exercise edge cases (git dependencies, workspaces, npm aliases, plain-http registry URLs, lockfiles without `resolved`). Edge cases are over-represented compared with ordinary projects.
- Only the root manifest is fetched for npm projects, so projects with npm workspaces are measured as one root.

## The reference

- The reference is OSV, the same advisory source patchpath uses. Agreement shows consistent lockfile reading and matching. It does not show that either side is complete: an advisory missing from OSV is missing from both. Precision 100% means "everything patchpath reports is in OSV for that version", not "everything patchpath reports is exploitable or correct".
- The reference skips git, file, link, directory and workspace entries and non-semver versions. Their counts are in each `*.ref.json` under `excluded`.
- OSV answers change as advisories are added or edited. Keep the `ref` folder with every result set; each `*.ref.json` has the query date. A rerun later will not give the same totals even on the same lockfiles.
- The scope table in `METHOD.md` is the kit's reading of patchpath's rules. If a rule is wrong, the false negatives or the out-of-scope counts move, not the precision.
- `nodev` compares patchpath's reachability analysis with the lockfile's `dev` flag. The two answer slightly different questions.

## npm audit

- `npm audit` results change over time as advisories are added, and between npm versions. The plan evaluation compares two states measured with the same npm on the same day; it cannot be reproduced later from the same lockfile and will drift.
- npm audit and OSV are different databases. The detection numbers and the plan numbers use different units and must not be put in one column.
- The comparison of patchpath with `npm audit` for the 22 npm projects that is in the results snapshot (section 2) was made with a one-off script that is not included in the kit.

## What the plan evaluation cannot measure

- It does not install anything (`--package-lock-only --ignore-scripts`). It does not run builds or tests, so it cannot tell whether an upgrade breaks the project. "Exit 0" means npm resolved a tree.
- Workspace commands (`-w`/`--workspace`) are not run, so npm workspace monorepos (bitwarden, npmcli, directus) are not part of it.
- Git dependencies that npm resolves through codeload.github.com cannot be resolved when only `registry.npmjs.org` and `api.osv.dev` are allowed. mailspring (`slate@github:`) could not be measured for this reason; nodegoat and parse-server had blocked codeload requests but their commands still succeeded. If you allow that host, results for those projects may differ.
- mattermost was left out because of its size (a scan alone risked ten minutes, 283 advisories).
- `npm audit fix --force` is not run. It makes breaking changes by design and is not what a careful user would do first.
- A patchpath re-scan after the commands and an `npm audit` after the commands can disagree because of their different databases and units; the table shows both.
- Breaking commands are applied cumulatively on top of the safe step and not in an isolated way; a failing command leaves the lockfile as it was, and the next one still runs. A user who stops at the first failure would end up elsewhere.

## Timings and robustness

- Times in the snapshot are from one machine, sequential runs, cold cache, without controlling other load. Use them as an order of magnitude only.
- "All exit codes 0, no crash" is a statement about these 34 files. It says nothing about malformed or huge lockfiles outside the corpus.
- Request counts in the snapshot come from a preload that wraps `fetch` and `http/https.request`. A process that opened sockets in another way would not be seen.

## The kit itself

- The scripts were exercised on a small synthetic corpus with a fake OSV server, a stub patchpath and a stub npm (end to end, without network), and on real data for one small project of the plan evaluation. The detection path was run on all 34 real lockfiles in the snapshot run. Other platforms (Linux, macOS) were not exercised.
- Results of one run are not a guarantee for another version of patchpath. Record the version and commit with every result (`run-info.json` does).
