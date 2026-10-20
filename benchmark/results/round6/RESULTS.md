# Results snapshot: Round 6

One complete run of this kit (the sixth measurement round of the project). Numbers are copied from the run's report; they are a snapshot, not a promise about other lockfiles, dates or versions. Read `../../LIMITATIONS.md` before quoting them.

## Environment

| item | value |
|---|---|
| patchpath | 0.0.1, commit 9a353a5, `dist/cli.js` built from that commit without local changes |
| Node | v24.18.0 |
| npm | 11.16.0 |
| OS | Windows 11 (win32) |
| date | 2026-10-20 |
| corpus | 34 projects, 196 files, 25 MiB, all SHA-256 hashes verified, 0 problems |
| patchpath runs | 90 (34 `default` + 22 `nodev` + 34 `assume-public`), each with JSON and text output |

Files in this folder: `RESULTS.md` (this file), `compare.md` (per-project detection table, corrected scope), `compare-original-scope.md` (the same run with the earlier scope rule, see section 1), `false-negatives.md`, `plan-table.md`, `run-info.json`. Raw outputs (lockfiles, OSV answers, patchpath output, npm output, request logs, about 45 MB) are not included; rerun the kit to regenerate them.

## 1. Detection against the OSV reference

Unit: package name@version + OSV advisory id. See `../../METHOD.md`.

Scope rule used for the numbers below: `compare.mjs` as shipped in this kit. An entry without its own `resolved` URL takes the class of the package that bundles it, or of a `resolved` URL found in the lockfile's legacy `dependencies` section (see `METHOD.md`), and plain-http registry URLs count as public.

| variant | projects | patchpath units | reference units in scope | FP | FN | precision | recall |
|---|---:|---:|---:|---:|---:|---:|---:|
| default | 34 | 6669 | 6748 | 0 | 79 | 100.0% | 98.8% |
| nodev (npm only) | 22 | 1738 | 1825 | 0 | 87 | 100.0% | 95.2% |
| assume-public | 34 | 8807 | 8807 | 0 | 0 | 100.0% | 100.0% |

Reference units outside the scope: default 2059 (none reported by patchpath), nodev 3284 (none reported), assume-public 0.

Before the scope rule was corrected (`compare-original-scope.md`), the same run showed reference units in scope of 6546 / 1804 / 8806 for the three variants and the same FP and FN. The difference is only in which reference units were counted as "in scope": patchpath had reported 202 units that the earlier rule called "out of scope". They are real reference units, not false positives. What they are (checked on the lockfiles): 142 are bundled packages without a URL of their own (nodegoat 114, parse-server 2, npmcli 8, ngx-admin 18), 59 are children written as `"resolved": false` with `optional` in npm v1 lockfiles (the fsevents tree: mattermost 19, nest 19, ngx-admin 20, jitsi 1), and 1 is a plain-http registry URL (chartjs). After the correction, in-scope reference units equal patchpath units plus false negatives for the default variant (6669 + 79 = 6748).

False negatives (all listed in `false-negatives.md`):

- default, 79 (nest 19, ngx-admin 14, directus 46): the same name@version appears in the lockfile both with and without a `resolved` URL; patchpath counts that version as "not checked" (de-duplication, and the entry without URL wins). Checked for 79 of 79. This is not silent: the warning "N packages were not checked" names them. With `--assume-public` the false negatives are 0.
- nodev, 87: the same 46 (directus) and 14 (ngx-admin), plus 27 in nightscout. In nightscout the lockfile has no `dev` flag on those entries (js-yaml@4.1.0, nanoid@3.2.0, and entries under minimed-connect-to-nightscout) but they are not in the `requires` list of any production package (extraneous). patchpath's reachability analysis is stricter than the reference, which only reads the `dev` flag; patchpath is probably right here, so these were not counted as bugs (only 2 packages were checked by hand).
- Differences caused by aliases, prereleases or extra de-duplication: 0.

## 2. Comparison with npm audit (22 npm projects, assume-public, unit package|GHSA)

patchpath 3840, npm audit 3827, in common 3826. Only patchpath: 14 (bitwarden 13, for example multer GHSA-44fp-w29j-9vj5; ngx-admin 1, webpack-subresource-integrity GHSA-4fc4-chg7-h8gh). Only npm audit: 1 (bitwarden, duo_web_sdk GHSA-gwjw-ph82-w683). 20 of 22 projects are equal. The suspected reason (different advisory databases) was not verified. This comparison was made with a one-off script that is not part of the kit.

## 3. Plan evaluation (10 npm projects)

Method in `../../METHOD.md`. Flags: `--package-lock-only --ignore-scripts --no-audit --no-fund`, separate copies for each variant. Table in `plan-table.md`; the same table:

| project | before | claim (clears N of M) | really closed | npm audit after safe step | after `npm audit fix` | separate commands exit 0 | after safe + all separate |
|---|---:|---:|---:|---:|---:|---:|---:|
| typescript | 49 | 60/65 | 61 | 5 | 13 | 3/3 | 4 |
| socketio | 77 | 73/90 | 75 | 23 | 21 | 7/7 | 16 |
| gatsby-blog | 130 | 116/143 | 116 | 25 | 28 | 0/0 | - |
| nextjs-blog | 132 | 108/159 | 131 | 46 | 50 | 12/13 | 37 |
| vscode | 150 | 135/211 | 138 | 73 | 87 | 11/11 | 29 |
| bookshelf | 179 | 143/228 | 188 | 86 | 179 | 3/3 | 84 |
| parse-server | 182 | 127/227 | 181 | 89 | 182 | 6/6 | 84 |
| nodegoat | 197 | 91/320 | 104 | 162 | 197 | 9/9 | 134 |
| chartjs | 210 | 159/240 | 195 | 66 | 71 | 3/3 | 66 |
| nightscout | 214 | 150/298 | 197 | 120 | 115 | 13/13 | 108 |

"before" and the npm audit columns are unique (package|advisory) pairs from `npm audit --package-lock-only --json`. `npm audit fix` was run without `--force`; it exits 1 because advisories remain (normal). ERESOLVE warnings or errors were seen for gatsby-blog, bookshelf and parse-server.

Selection (10 projects): the npm projects left after excluding the ones below, with between 49 and 214 advisories in `npm audit`, no `-w` command and no commented-out command in patchpath's plan, and a patchpath scan under 20 seconds: typescript 49, socketio 77, gatsby-blog 130, nextjs-blog 132, vscode 150, bookshelf 179, parse-server 182, nodegoat 197, chartjs 210, nightscout 214. Excluded: mattermost (risk of a ten-minute run, 283 advisories); nest 274, ngx-admin 325 and jhipster-vue 272 (large); bitwarden, npmcli, directus (workspace `-w` commands); voting-result (21, small); electron-qs and heroku-node (no advisories). mailspring (87) was first selected and could not be measured: its git dependency `slate@github:` needs codeload.github.com, which was not an allowed host in the run (only OSV and npmjs were); npm stopped with ERESOLVE. nightscout replaced it. nodegoat and parse-server also had 3 blocked codeload requests each; their commands still exited 0.

Totals over the 10 projects:

- before 1520; after patchpath safe step 695; after `npm audit fix` 943; after safe step and all separate commands 587.
- patchpath's safe step is better than `npm audit fix` in 8 of 10 projects and worse in 2 (socketio 23 against 21, nightscout 120 against 115). In bookshelf, parse-server and nodegoat `npm audit fix` closed no advisory at all (patchpath closed 93, 93 and 35).
- Estimate ("clears N"): claimed in total 1162, really closed 1386 (a patchpath re-scan, key name@version|id). In 10 of 10 projects the real number is at least the claim, so the estimate is conservative; widest gaps: nightscout 150 to 197, chartjs 159 to 195, nextjs-blog 108 to 131, bookshelf 143 to 188. The unit is the patchpath advisory unit and is not equal to the npm audit unit.
- Separate (breaking) commands: 67 of 68 exited 0 (cumulative, continuing after an error); 1 failed with ERESOLVE (`npm install -- eslint@10.13.0` in nextjs-blog).

## 4. Robustness, time, false "clean"

- 90 runs, JSON and text: all exit 0, JSON valid, stderr empty, no crash. A nonexistent directory exits 2; pnpm `default` with `--fail-on critical` exits 3; `--assume-public --fail-on critical` exits 1.
- Time (cold, `--no-cache`, sequential, machine not otherwise idle; JSON runs): `default` median 11.6 s (maximum 30.5 s, storybook; pnpm `default` takes 0.3 to 0.8 s because nothing is checked), `nodev` median 7.7 s (maximum 20.7 s), `assume-public` median 13.0 s (maximum 34.8 s, directus).
- Hosts (a preload recorded `fetch` and `http/https.request` and blocked everything outside the allow list): patchpath made 184349 requests: registry.npmjs.org 156139, api.osv.dev 28210, other hosts 0, blocked 0. During the plan stage npm itself ran under the preload: the two allowed hosts, plus blocked codeload.github.com requests (git dependencies of mailspring, nodegoat and parse-server).
- False "clean": pnpm `default` on 6 of 6 lockfiles prints "Nothing was checked: N packages were not checked. This is not a clean result." (an earlier round printed "No known vulnerabilities in the 0 checked packages"; fixed). Remaining risk: directus prints the headline "48 known vulnerabilities in 18 packages" while 2849 of 3141 packages (91%) were not checked; the warning is at the very end of the text (line 87). nest (66) and ngx-admin (19) are similar.

## 5. Side by side with earlier rounds

Units differ (round 4 used the npm audit key, rounds 5 and 6 the OSV reference), so the columns are not directly comparable.

| measure | round 4 (bc73849, 22 npm) | round 5 (c64cbd7, 6 yarn + 6 pnpm) | round 6 (9a353a5, 34) |
|---|---|---|---|
| precision | 99.6% (npm audit key) | 100% (OSV reference) | 100% (OSV reference, 3 variants) |
| recall | 89.7% (npm audit; directus 366 by design) | 100% (3698 of 3698) | default 98.8%, assume-public 100% |
| exit / crash | 22 of 22 exit 0 | 12 of 12 exit 0 | 90 of 90 exit 0 |
| median time (cold) | 12.9 s (max 29.4) | yarn about 14 s; pnpm assume-public 7.9 to 29.6 s | default 11.6 s (max 30.5) |
| hosts | 2 | allowed | 2, other 0 |
| pnpm default | - | "No known vulnerabilities in the 0 checked", exit 0 | "Nothing was checked ... not a clean result" |
| left after safe step (typescript, nodegoat, nightscout, chartjs, gatsby, socketio, nextjs, vscode, bookshelf, parse) | 5, 162, 120, 65, 25, 23, 46, 73, 86, 88 | - | 5, 162, 120, 66, 25, 23, 46, 73, 86, 89 |
| after all separate commands (typescript, socketio, chartjs, nextjs, nodegoat, nightscout, vscode, bookshelf, parse) | 4, 16, 65, 37, 134, 108, 29, 84, 83 | - | 4, 16, 66, 37, 134, 108, 29, 84, 84 |
| separate commands exit 0 | nextjs-blog 12 of 13 | - | nextjs-blog 12 of 13 (total 67 of 68) |

## 6. Worse than before, and open items

1. chartjs (safe step 65 to 66, after separate commands 65 to 66) and parse-server (88 to 89, 83 to 84): one more npm audit advisory each. Whether patchpath's commands were identical to round 4 was not checked; the npm audit database may have changed and the unit is different. The cause was not measured. No proven regression.
2. Still open (not new): the directus headline (section 4).
3. Not measured: the mailspring plan (network policy), `-w` commands, the mattermost plan, `npm audit fix --force`.
