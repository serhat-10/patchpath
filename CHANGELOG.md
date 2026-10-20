# Changelog

## Unreleased

### Added
- yarn v1 lockfiles (`yarn.lock`), detection side only: vulnerabilities, deprecations, lag, `via`, direct/dev
  (from package.json and simple `dir` / `dir/*` workspaces), `--no-dev`, `--fail-on` and exit codes, `--json`.
  No upgrade plan, no npm commands and no `overrides` for them: the report says "upgrade plan is not available
  for yarn/pnpm lockfiles yet" (`Report.planUnavailable`). yarn berry lockfiles are rejected. New
  `Report.lockfileType`. A folder with several lockfiles: package.json `packageManager` decides, else a fixed
  order (npm first), with a warning naming the files not read.
- pnpm lockfiles with `lockfileVersion: '9.0'` (pnpm 9 and 10), detection side only, same scope and same
  "upgrade plan is not available" note as yarn: importers (workspaces), `npm:` aliases, peer variants merged
  into one package, dev by reachability. Integrity-only entries do not say which registry they came from, so
  they are unchecked unless `--assume-public` is given. The YAML is read with the `yaml` package, a
  devDependency bundled into dist like semver (still no runtime dependencies). Older pnpm lockfiles are rejected.
- Upgrade plan commands: one non-breaking step first (`npm install` of the safe upgrades plus an in-range
  `npm update`), then each breaking or peer-conflicting upgrade as its own command, so one major that npm
  refuses (ERESOLVE) does not block the safe fixes. Upgrades of one scope at one version move together.
- In-range `npm update`: locked transitive packages whose fixed version is already inside the range their
  parents declare are updated without a package.json change (`Report.refresh`, `Report.commands`).
  `--legacy-peer-deps` is added when a direct dependency's peer is already broken before any change.
- The plan follows every dependency chain in the lockfile (not just the shortest) to a vulnerable copy; a
  copy another locked parent still pins counts as still open.
- Checked targets: every "fixed in" version and every suggested override is checked against OSV and moves
  on to the next fixed version if it carries an advisory of its own; otherwise no override is suggested
  and the report says why.
- Bundled copies (`inBundle`) are excluded from `overrides` and listed under "Bundled copies" with the
  package to upgrade instead.
- Request cap for the plan is 150 extra registry requests, spent on production dependencies and the worst
  advisories first; when it is reached the warning says how many packages were not looked up and that a
  rerun continues from the cache.
- Better breaking-target choice: the newest release of the new major that is not deprecated and has no
  known advisory, not the first release of it.
- Coverage: npm 6 children with `"resolved": false` and plain-`http://` registry.npmjs.org URLs are
  checked (`--assume-public` is no longer needed for them).
- `--no-dev` on v1 lockfiles ignores extraneous entries nothing reachable from production requires.
- `--include-pinned-lag` (also `ScanOptions.includePinnedLag`): direct dependencies pinned to an exact
  version are no longer reported as a major version behind unless this flag is given. Vulnerabilities of
  pinned dependencies are always reported.
- Deprecated wording: "installed version deprecated, upgrade to X" when the plan has a non-deprecated
  target; "deprecated: replace it" only when there is no target.
- Malicious packages: a `MALICIOUS CODE (MAL-...)` marker on the "covered by upgrading X" line, and a
  "N malicious packages" summary line (`summary.malicious`). Only advisories with a `MAL-` id (or alias) count; summaries are not used.
- Optional peer dependencies (`peerDependenciesMeta`) no longer produce a peer-conflict warning when the
  optional peer is only installed because the upgraded package pulled it in; one that something else keeps
  installed and that conflicts is still reported.
- Upgrade plan: for each direct dependency that is vulnerable or pulls in vulnerable packages, the
  version to upgrade to, the advisories it clears (count, packages, worst severity), whether it is
  breaking, what stays open (including advisories OSV reports for the estimated new versions), a
  breaking version that clears everything when the non-breaking one does not, an "also run npm update"
  hint when the lockfile would keep an old transitive version, and "replace it" for deprecated
  dependencies without a fix. It is an estimate from registry metadata (`estimated: true`), printed
  first; the per-package list marks packages it covers, and the text `overrides` block only lists
  packages it does not fix. JSON: `Report.plan`. Skip it with `--no-plan` / `ScanOptions.plan: false`.
  Candidates: up to 20 newest releases per breaking line (current line and the 3 newest above); at
  most 150 extra registry requests per scan (registry documents fetched for the report are reused and
  the per-version dependency data is cached separately for 6 hours).
- `semver` (range matching) as a devDependency bundled into `dist`; the package still has no runtime
  dependencies.
- npm lockfile (v1, v2, v3) scanning against OSV and the npm registry.
- Report: vulnerabilities, deprecated packages, and direct dependencies a major version behind.
- For transitive packages: the chain from the direct dependency, and a suggested `overrides` block for
  fixes that do not cross a breaking line.
- `--json`, `--no-dev`, `--no-cache`, `--fail-on`.
- `--registry <url>` (repeatable): check packages resolved through a mirror or proxy of the public
  registry. Also `ScanOptions.registries`.
- `--assume-public`: check lockfile entries that have no `resolved` URL. Also `ScanOptions.assumePublic`.
- Exit code 3: `--fail-on` was given and not reached, but some packages could not be checked.
  `--allow-unchecked` turns this back into exit code 0.
- CVSS v3 scoring for advisories that only carry a vector.

### Changed
- The project is now named patchpath: CLI/bin name, `PATCHPATH_*` environment variables and the cache
  directory (`patchpath`). The old cache directory is not migrated; delete it if you want the space back.
- The paths in the report no longer carry the local user name: text line 1 and `--json` `root` / `lockfile`
  (field names unchanged, values changed) are relative to the current directory (`.` for the project
  folder itself), else `~/...` (`~\...` on Windows) under the home directory. A project outside both stays
  an absolute path. Files are still read by their real path.
- Lag ("a major version behind") is counted for direct dependencies only; transitive packages were
  counted before.
- `devOptional` packages are now production, not dev: `npm install --omit=dev` installs them, so
  `--no-dev` no longer hides them.
- A `0.0.x` patch upgrade now counts as breaking, like a `0.x` minor (npm's caret ranges agree).
- Node 20 is no longer supported (end of life); Node 22+ is required.
- An all-clear is no longer printed when some packages were not checked; the text says how many were
  skipped, and the warning says how to check them.

### Documentation
- Privacy (README, README.tr, SECURITY): the peer ERESOLVE prediction asks `registry.npmjs.org` for the
  document of each peer a public package's new version declares but that is not installed (one request per
  peer, at most 30 of the 150 plan requests; names come from the public package's metadata, never from
  unchecked packages; nothing goes to OSV for them).

### Fixed (found in review)
- yarn v1: "N dependencies declared in package.json have no yarn.lock entry (run yarn install)" no longer
  counts dependencies between workspace packages (yarn never writes lock entries for them): a spec on a
  workspace's name that is `workspace:`, `*` or a range its version satisfies is skipped. Only really
  missing ones are counted.
- yarn v1: declared workspaces whose package.json is missing (a literal folder, or a `dir/*` pattern that
  matches nothing) are no longer skipped silently; one warning gives the count and up to 3 examples.
- yarn v1: an entry whose header mixes a plain range with an `npm:` alias for another name stays
  unchecked (unchanged), but the warning now says "N with a header mixing a range and an npm: alias"
  instead of counting it as "from another registry, git or a file".
- An existing peer conflict now gets `--legacy-peer-deps` (or the "resolve it by hand" note) on the
  breaking, conflict and peer commands too, not only on the safe step; checked as if the steps before
  had run, and not added for a conflict the command resolves or starts itself.
- A peer range of `*` or `""` no longer counts an installed prerelease as a conflict (npm accepts it).
- A root `overrides` entry for the peer's name is now honoured when looking for an existing peer
  conflict: npm checks the peer edge against the override's range (`"tailwindcss": "$tailwindcss"` means
  the root's own range), so bitwarden's `eslint-plugin-tailwindcss` wants `^3.2.2`, installed `3.1.6`
  no longer turned every command into a "resolve the conflict by hand" comment (npm 11 installs it
  without ERESOLVE). Only a single plain top-level rule is trusted; keyed, nested, `*`, unresolvable
  references and values npm rejects with EOVERRIDE are checked against the peer range as before.
- A non-breaking upgrade whose new version has a peer that is not installed (optional ones too) can now
  be kept out of the safe step: npm still loads that peer into the peer set, at the newest release in
  range, and checks its peers against the tree. bitwarden: `@angular-devkit/build-angular@14.2.11` ->
  optional `@angular/localize@14.3.0` -> `@angular/compiler@14.3.0`, installed `14.1.0`, held at
  `14.1.0` by `@angular/platform-browser-dynamic`: the printed safe `npm install` stopped with ERESOLVE
  (npm 11.16). Claimed only when every release npm may take for that peer needs a version the root's
  own copy does not have, and a peer edge of a direct dependency outside the peer set (not moved by the
  step) holds that copy at a range none of the new versions meets; an override, a workspace or alias
  install, a document not read or a peer set over 80 names leaves the plan as it was. Costs one
  registry document per such peer (at most 30 of the 150 plan requests; a warning says when cut off).
- A plan line no longer says "also run npm update X" for a name held back for a peer conflict, cut off
  by the work limit or refused; only the command applying that entry counts, and "+N more" points at
  `--json` when there is no Commands block.
- A name held back from `npm update` (peer conflict), unchecked or refused is no longer assumed for the
  plan entry that wanted it: "clears N" and "covered by upgrading X" only count what the commands run.
  A held name is also left out of a later breaking/conflict/peer command's `npm update`, with the reason
  printed under that command.
- An install refused for its name, alias or workspace folder is checked before the estimate: it no
  longer counts towards "estimated to clear N of M" or "covered by the upgrade above".
- A nested override (`{"express": {"qs": ...}}`) only holds the copies below that parent; another
  copy of the same name can still be updated.
- On Windows with Node 24 the CLI could abort on exit with a libuv assertion (exit code 127) when it
  had reused a keep-alive connection (e.g. two OSV queries with a warm cache). It now lets Node exit
  on its own once the output is written, and forces the exit only if something is still running a
  second later.
- Lockfile entries without a `resolved` URL were assumed to come from the public registry, so a
  private package written with `omit-lockfile-registry-resolved` had its name sent to OSV and the
  registry. They are now unchecked unless `--assume-public` is given (bundled dependencies follow the
  package that bundles them).
- A lockfile resolved through a mirror marked every package as external, printed "No known
  vulnerabilities" and passed `--fail-on`, although nothing had been checked.
- Suggested overrides could downgrade another copy of the same package, force 0.x copies on different
  minor lines onto one version, or target a package that is also a direct dependency (which npm
  rejects with `EOVERRIDE`). A package is now only suggested when every installed copy, dev copies
  included, is on the fix's breaking line and not newer than it, and it is not a direct dependency.
- Offline, the error appeared after ~3.5 s but the process kept retrying registry lookups for ~28 s
  (376 requests on a 95-package project). The registry lookups are now cancelled when the OSV query
  fails, a per-host circuit breaker stops retrying a host that is down (one warning instead of one per
  package), and the CLI exits as soon as its output is flushed: ~3.6 s and 40 requests.
- `via` chains from the lockfile were only cleaned when printed, not in the JSON report.
- Sanitising missed Unicode tag characters, U+2060-U+2064, soft hyphen, U+061C and U+180E, and
  truncation could split a surrogate pair.
- npm aliases (`"x": "npm:lodash@4"`) were looked up under the alias name and silently missed.
- `fixVersion` could point at a release still affected by another advisory. It is now the smallest
  version outside every affected range, preferring non-breaking upgrades.
- Terminal escape sequences in deprecation messages and advisory text were printed unchanged.
- One failed advisory lookup aborted the whole scan; it is now a warning and the advisory is kept.
- Network failures printed a stack trace; they now produce a one-line message.
- Vulnerabilities of unknown severity never tripped `--fail-on`; they now count as moderate.
- Workspace dependencies were never reported as direct.
- Private, git and tarball packages were looked up on the public registry, leaking their names.
- Findings were ranked by a sum, so several moderate issues could outrank one critical.
- A byte-order mark in `package-lock.json` caused a parse error.
