# Which dependency do I bump? Measuring an upgrade planner for npm on 34 real lockfiles

*Numbers are from one benchmark run on patchpath 0.0.1, October 2026.*

## The problem

You run `npm audit` and it tells you that a package three levels down has a known advisory. That part is useful. What it does not tell you is the part you actually have to do: which of *your* direct dependencies to upgrade, to which version, and with which command. You can trace the chain by hand through `npm ls`, or you can run `npm audit fix`, which works often enough, until it stops on an ERESOLVE peer-dependency conflict and fixes nothing at all.

I wanted a report that answers the practical question: "bump `express` to 4.22.3 and `socket.io` to 4.8.0, run this one command, then this separate one for the breaking upgrade." So I wrote patchpath, a small CLI, and then spent more time measuring it than I expected. This post describes what it does, how I tested it and where it falls short.

## What patchpath does, and what it does not

For an npm project, patchpath reads `package-lock.json` and prints:

- every known vulnerability, with the chain (`via`) from the direct dependency that pulled it in;
- an **upgrade plan** grouped by direct dependency: the target version, how many advisories that is estimated to clear, and whether it crosses a breaking line;
- ready-to-run commands in a fixed order: one non-breaking step first, then each breaking or peer-conflicting upgrade as its own command, so that one refused major does not block the safe fixes;
- deprecated packages and direct dependencies a major version behind.

Just as important is what it does not do:

- **It is not a new vulnerability database.** Advisories come from [OSV](https://osv.dev), which aggregates the GitHub advisory database among others. Detection is therefore essentially what `npm audit` already gives you; the difference is the grouping and the plan.
- **The plan is an estimate**, built from registry metadata by walking each vulnerable chain down from candidate versions. It is not an npm resolver run. Apply it, then scan again.
- **It does not read your source code** and does not check that an upgrade is compatible with it.
- **It does not patch your dependencies' code.** Unlike patch-package, it only suggests versions and commands.
- **The plan is npm only.** For `yarn.lock` (v1) and `pnpm-lock.yaml` (v9) you get the report (vulnerabilities, fixed versions, chains, deprecations), but no plan and no commands yet.

## How I measured it

I wanted numbers that someone else could reproduce, so the measurement is a separate kit with no shared code. It lives in the repository under [`benchmark/`](https://github.com/serhat-10/patchpath/tree/main/benchmark).

**Corpus.** 34 public GitHub projects: 22 with `package-lock.json` (lockfile versions 1, 2 and 3), 6 with yarn v1 and 6 with pnpm 9 lockfiles. Each is pinned to a full commit SHA, and every downloaded file is checked against a recorded SHA-256. The list includes NodeGoat, the TypeScript and VS Code repositories, Chart.js, socket.io, parse-server, Nightscout, directus, the npm CLI, vite, Vue core and others.

**Unit.** One unit is a package `name@version` plus an OSV advisory id. Counting packages instead gives different numbers; I only report the advisory-level unit.

**Reference.** An independent script with its own lockfile parsers (npm v1/v2/v3, yarn v1, pnpm 9) queries OSV directly for every `name@version` it finds. Because patchpath deliberately skips packages it cannot tell are public (more on that below), the comparison is done in three variants with matching scopes: `default`, `nodev` (npm only, `--no-dev`) and `assume-public` (entries without a `resolved` URL are treated as public).

**npm audit.** For the 22 npm projects I also compared against `npm audit`, which uses a different advisory source and id scheme.

**Plans.** For 10 npm projects I applied the plans on separate copies of each project with `npm install --package-lock-only --ignore-scripts`, then counted what `npm audit` still reported. I compared that against `npm audit fix` (without `--force`) on another copy.

## Results

### Detection

| variant | projects | patchpath units | reference units in scope | false positives | false negatives | precision | recall |
|---|---|---|---|---|---|---|---|
| default | 34 | 6669 | 6748 | 0 | 79 | 100.0% | 98.8% |
| nodev (npm) | 22 | 1738 | 1825 | 0 | 87 | 100.0% | 95.2% |
| assume-public | 34 | 8807 | 8807 | 0 | 0 | 100.0% | 100.0% |

"Reference units in scope" are the units the reference expects patchpath to check under each variant's rules. In each row it equals patchpath's units plus the false negatives, so nothing patchpath reported is outside the reference. My first version of the kit missed two cases patchpath handles on purpose, which made patchpath look like it reported 202 extra units: bundled packages, which have no URL of their own and follow the package that bundles them (142 units, mostly NodeGoat), and optional children of a public package in older npm lockfiles that write `"resolved": false` (59 units). One plain-`http` registry URL in Chart.js made up the rest. The misses are explained in the limits section.

Against `npm audit` on the 22 npm projects (with `--assume-public`, unit package plus GHSA id): patchpath 3840, npm audit 3827, 3826 in common. 20 of 22 projects match exactly. The differences are 14 units reported only by patchpath (13 in one project, 1 in another) and 1 reported only by npm audit. I assume the cause is a difference between the advisory databases, but I have not verified it.

### Upgrade plans

The 10 projects were chosen from the npm corpus as those with between 49 and 214 open advisories, no workspace (`-w`) commands in the plan, and a scan under 20 seconds. The counts below are unique package-plus-advisory pairs from `npm audit --package-lock-only --json`.

| project | before | after patchpath non-breaking step | after `npm audit fix` | after patchpath step + separate commands |
|---|---|---|---|---|
| typescript | 49 | 5 | 13 | 4 |
| socketio | 77 | 23 | 21 | 16 |
| gatsby-blog | 130 | 25 | 28 | (no separate commands) |
| nextjs-blog | 132 | 46 | 50 | 37 |
| vscode | 150 | 73 | 87 | 29 |
| bookshelf | 179 | 86 | 179 | 84 |
| parse-server | 182 | 89 | 182 | 84 |
| nodegoat | 197 | 162 | 197 | 134 |
| chartjs | 210 | 66 | 71 | 66 |
| nightscout | 214 | 120 | 115 | 108 |
| **total** | **1520** | **695** | **943** | **587** |

Comparing only the non-breaking step with `npm audit fix`: patchpath left fewer open advisories in 8 of 10 projects and more in 2 (socketio: 23 left against 21; nightscout: 120 against 115). In bookshelf, parse-server and nodegoat, `npm audit fix` closed nothing; I saw ERESOLVE warnings or errors from `npm audit fix` in gatsby-blog, bookshelf and parse-server.

Some other observations from the same run:

- **The estimate is conservative.** Across the 10 projects the plans claimed to clear 1162 advisories; a rescan with patchpath after applying them showed 1386 cleared, and in every project the actual number was at least the claim. This count uses patchpath's own advisory unit, so it is not directly comparable to the npm audit columns above.
- **Separate commands mostly run.** Of 68 separate (breaking) commands, 67 exited 0; one failed with ERESOLVE (`eslint@10.13.0` in nextjs-blog).
- **No crashes.** 90 scans (34 default, 22 nodev, 34 assume-public), each with JSON and text output: all exited 0, all JSON was valid, stderr was empty.
- **Speed.** Median 11.6 seconds per project for the default scan, cold cache, sequential, maximum 30.5 seconds. The pnpm default scans finish in under a second for a bad reason: without `--assume-public` they check almost nothing (see below).
- **Network.** I logged every outgoing request during the scans. All of them went to `registry.npmjs.org` and `api.osv.dev`; there were no other hosts.

## Honest limits

**The 79 false negatives.** All 79 (nest 19, ngx-admin 14, directus 46) have the same cause, which I checked with a script for every one: the same `name@version` appears in the lockfile both with and without a `resolved` URL. patchpath merges the two, the entry without a URL wins, and the version is counted as "not checked". That is fail-closed by design (a package with no URL could be private, so its name is not sent anywhere), and it is not silent: the names appear in the "N packages were not checked" warning. With `--assume-public` the count drops to 0. It is still a miss, and the merge should prefer the resolved entry.

**The extra `nodev` misses.** Of the 87, 60 are the same cause as above. The other 27 are in Nightscout, where patchpath's reachability check treats some entries as non-production that the reference counts as production. I believe patchpath is right there, but I only checked two packages by hand, so I counted them as misses.

**A misleading headline.** On directus, the report starts with "48 known vulnerabilities in 18 packages", while 2849 of its 3141 packages (91%) were not checked. The warning that says so is at the end of a long report. nest and ngx-admin show the same pattern on a smaller scale. That is a known UX problem and I plan to fix it by putting the unchecked count in the headline. (pnpm scans without `--assume-public` already say "Nothing was checked ... This is not a clean result" instead of reporting zero.)

**Worse than `npm audit fix` in 2 of 10 projects.** In socketio and nightscout the non-breaking step left more open than `npm audit fix` did. The plan is an estimate and npm's resolver sometimes does better.

**The corpus.** It is hand-picked, mostly old (most commits are from 2019 to 2024) and front-end heavy. It is not a sample of npm, and 34 projects is a small number.

**The reference shares the data source.** The detection reference queries OSV, the same source patchpath uses. Agreement shows that lockfile reading and matching are consistent; it does not show that either is complete or correct.

**What I could not measure.** The Mailspring plan could not be evaluated: it has a git dependency, my test setup only allowed the two hosts above, and npm stopped with ERESOLVE, so I replaced it with Nightscout. Plans that need workspace (`-w`) commands (bitwarden, npm CLI, directus) and the mattermost plan were not measured either, and neither was `npm audit fix --force`.

**`npm audit` moves.** Its advisory set changes over time, so the npm audit columns cannot be reproduced exactly later from the same lockfiles. OSV answers change too; the kit stores the query date with every reference result.

## Try it

patchpath is not on npm yet. From a checkout, with Node 22 or newer:

```
git clone https://github.com/serhat-10/patchpath.git
cd patchpath
npm install
npm run build
node dist/cli.js ./my-app
```

Add `--json` for machine-readable output, `--no-dev` to skip development-only packages, and `--fail-on high` for CI.

**Privacy.** Only the names and versions of packages that the lockfile says come from the public npm registry are sent, to `api.osv.dev` and `registry.npmjs.org`. Packages from other registries, git, tarball URLs or local files, and packages without a `resolved` URL, are never sent; they are counted as unchecked and listed in a warning. `--assume-public` and `--registry` widen that on purpose. Your source code and file paths stay on your machine.

**Reproduce the numbers.** The kit in `benchmark/` needs Node 22 and no `npm install`; `node run-all.mjs` does everything in order. It downloads the pinned corpus (refusing any file whose hash differs), builds the OSV reference, runs patchpath, compares the results and, for the 10 plan projects, applies the plans next to `npm audit fix` on separate copies. The plan step needs npm and takes a while: about three minutes for the TypeScript project on my machine, so plan for 30 to 40 minutes for all ten (an estimate, I have not timed the full run). `--skip-plan` limits it to detection. `results/round6/` holds a snapshot of the numbers in this post, with the Node and npm versions they were measured with, and `ADD-A-PROJECT.md` explains how to add a project to the corpus.

## Feedback

If you try it on your own project and the plan is wrong, or a number here does not hold up, please open an issue at https://github.com/serhat-10/patchpath/issues; I would like to hear about it.
