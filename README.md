# patchpath

One command, one report: known vulnerabilities, deprecated packages and outdated dependencies for your npm project, with the chain that pulled each problem in.

English | [Türkçe](README.tr.md)

patchpath does **not patch the code** of your dependencies (unlike tools such as patch-package); it suggests the upgrade path and the commands to follow it.

The Turkish translation, [README.tr.md](README.tr.md), is meant to say the same thing; if the two differ, this English version is authoritative.

> Status: early MVP (v0.0.1). Reads `package-lock.json`, and `yarn.lock` (yarn v1) and `pnpm-lock.yaml` (lockfile v9) without the upgrade plan (see [Lockfiles](#lockfiles)). Not published to npm yet, so build and run it from a checkout (see [Install](#install)).

## Why, and what it does not do

`npm audit` tells you which installed packages have known advisories. When the problem is three levels down, you are left to work out which of your direct dependencies to touch. patchpath reads the same kind of data and adds a view on top:

- the **chain** (`via`) that pulled each vulnerable package in;
- an **upgrade plan** that groups the fixes by the direct dependency you would bump, with ready-to-run commands;
- deprecated packages and direct dependencies a major version behind, in the same report.

It is **not a new vulnerability database**. The advisories come from [OSV](https://osv.dev) (which aggregates the GitHub advisory database, among others), so detection is essentially the same as `npm audit`; the difference is the grouping and the plan. The plan is an **estimate** from registry metadata, not a resolver run: apply it, then scan again. patchpath does not read your source code and does not check that an upgrade is compatible with it, and a clean report is not a guarantee.

## Install

Not on npm yet. From a checkout (Node 22 or newer):

```
git clone https://github.com/serhat-10/patchpath.git
cd patchpath
npm install
npm run build
node dist/cli.js            # scan the current directory
node dist/cli.js ./my-app   # scan another project
```

## Example

Excerpt of a real run on a small Express/socket.io project (95 packages, 7 direct), October 2026. The first line, the lockfile path, is left out; `[...]` marks skipped lines. Results change as OSV and the registry change.

```
95 packages (7 direct), 1 direct dependency a major version behind

22 known vulnerabilities in 12 packages: 1 critical, 10 high, 4 moderate, 7 low

Upgrade plan (estimated from registry metadata: apply it, then scan again)
  express 4.18.2 -> 4.22.3: clears 14 advisories in 8 packages (worst critical), non-breaking
  socket.io 4.7.2 -> 4.8.0: clears 7 advisories in 3 packages (worst high), non-breaking
  cookie-parser 1.4.6: no upgrade clears its 1 advisory (none of the 1 newer releases tried clears any)
    the in-range npm update below clears 1 of them without changing cookie-parser
  in-range updates (package.json unchanged): clears 1 advisory (worst low), non-breaking: the npm update line below

Commands (in this order, then scan again)
  # 1. non-breaking, estimated to clear 22 of 22 advisories
  npm install -- express@4.22.3 socket.io@4.8.0
  npm update -- cookie-parser proxy-addr socket.io-adapter socket.io-parser

Findings
proxy-addr@2.0.7 (transitive) 1 advisory, worst critical: covered by upgrading express
path-to-regexp@0.1.7 (transitive) 3 advisories, worst high: covered by upgrading express
ws@8.11.0 (transitive) 3 advisories, worst high: covered by upgrading socket.io
[...]
```

When an upgrade is breaking or likely to hit a peer-dependency conflict it is printed as its own command after the non-breaking step, with a `# name: may break (new major or 0.x minor)` comment line above it.

## What it does

- **Upgrade plan:** for each direct dependency that is vulnerable or pulls in something vulnerable, the version to upgrade it to, how many advisories that clears (in how many packages, worst severity), whether it crosses a breaking line, and what stays open. When no upgrade helps it says so, and says when the installed version is deprecated ("installed version deprecated, upgrade to X" when the target is a newer release, "deprecated: replace it" when there is none). It is an **estimate** (see [How the upgrade plan works](#how-the-upgrade-plan-works)): apply it, then scan again. Packages the plan fixes are marked "covered" in the list below it, and the `overrides` block only lists what the plan does not fix.
- **Vulnerabilities** from [OSV](https://osv.dev), with the **smallest version that is outside the affected range of every advisory** for that package. Non-breaking upgrades are preferred; a fix that crosses a breaking line (a new major, a new `0.x` minor, or a new `0.0.x` patch) is labelled "may break".
- **Deprecated packages** and **direct dependencies a major version behind** from the npm registry. Lag in transitive packages is not reported: you did not choose those. Lag names the semver position that differs, so `0.1.x` -> `0.2.0` counts as a "minor" gap, even though the fix labelling above treats the same step as breaking.
- **Where it comes from:** for a transitive package, the chain of installed packages from the direct dependency down to its parent (the package itself is not repeated), printed as `via <direct>@<version> > ... > <parent>@<version>`. For example, a `form-data` pulled in directly by `request@2.88.2` is printed as `via request@2.88.2`.
- **Overrides:** transitive fixes that do not cross a breaking line are collected into a ready-to-paste npm `overrides` block (see below for when a package is left out).
- **Malicious code:** an advisory whose id (or one of its aliases) starts with `MAL-` (summaries are not used: ordinary advisories often mention "malicious input") is labelled `MALWARE` in the list, counted in the summary (`N malicious packages`, `summary.malicious` in JSON) and, even when a plan upgrade covers the package, marked `MALICIOUS CODE (MAL-...)` on that line. Remove such a package; do not just upgrade it.
- **Ordering:** malicious packages first, then the worst vulnerability, then deprecations. Within a tier, direct beats transitive, production beats dev, more advisories beat fewer.
- npm aliases, workspaces, v1/v2/v3 lockfiles. `devOptional` packages (dev dependencies that are also optional dependencies of production packages) count as production, because `npm install --omit=dev` installs them. In v1 lockfiles, entries that nothing reachable from your production dependencies requires (leftovers under a package that dropped a dependency) are treated as non-production by `--no-dev`, like `npm audit --omit=dev` does; this needs package.json next to the lockfile.

### How the upgrade plan works

For each candidate version of a direct dependency, patchpath walks each vulnerable package's chain (`via`) down from that version, using the per-version `dependencies` in the registry's package documents. At each step it picks what a fresh install would pick: the `latest` tag if it satisfies the declared range, otherwise the newest non-deprecated version that does (ranges are evaluated with the [`semver`](https://www.npmjs.com/package/semver) package, bundled into `dist`). If a new version no longer depends on the next package, that package counts as gone. The version it ends up with is checked against the package's known advisories, and every estimated version is also sent to OSV, so advisories that the new version would **introduce** are counted as remaining instead of being missed.

Candidates are newer releases of the direct dependency that are not deprecated and not prereleases: the 20 newest on the installed version's breaking line, and the 20 newest on each of the 3 newest breaking lines above it. The plan recommends the smallest non-breaking version that clears everything; otherwise the non-breaking version that leaves the least open (weighted by severity), and names the smallest breaking version that would clear everything, if any; if no non-breaking version helps at all, the best breaking one.

It is an estimate, not a resolver run. npm can end up with something else:

- **Locked versions:** `npm install <dep>@<version>` keeps a locked transitive version if it still satisfies the new range. patchpath detects this and adds the name to the `npm update` line (the estimate assumes you run it; the plan line only repeats it when no command covers it, `alsoUpdate` in JSON).
- **Every chain:** every dependency edge in the lockfile that leads to a vulnerable copy is followed. A copy that another locked parent still pins counts as remaining, unless updating that parent in range lets it go (then the parent is added to `npm update`).
- **In-range updates:** when a vulnerable transitive copy has a fixed version inside the range its parents declare (or inside the range of a parent's newer in-range release, up to 3 levels up), the plan adds `npm update <names>` without any package.json change. This is what `npm audit fix` mostly does. These lines need **npm 7 or newer**: npm 6 only updates the names of direct dependencies with `npm update` and silently leaves transitive ones as they are.
- **Bundled copies** (`inBundle`) cannot be updated or overridden; they only change when the package that bundles them does.
- **Dedupe, peer dependencies and overrides:** npm may share one copy between dependents and apply `overrides`. A package named in the root `overrides`, at any depth (`{"express": {"qs": "6.5.1"}}` pins qs) or with a range (`"qs@6"`), is assumed to stay as installed, and the plan says which packages an override holds. Packages that a new version adds are not followed. Peer dependencies of each target (from the registry) and peer dependencies that other direct dependencies declare on it (from the lockfile) are checked against the installed tree; an upgrade with a likely conflict is kept out of the non-breaking command and labelled.

Peer dependencies marked `optional` in `peerDependenciesMeta` do not block an upgrade when the optional peer is only installed because the upgraded package itself pulled it in; if something else keeps it installed and it conflicts, the conflict is still reported.

The commands come in this order: **one non-breaking step** (`npm install` of every non-breaking upgrade without a likely peer conflict, then `npm update` of the in-range refreshes), and then **each breaking or conflicting upgrade as its own command**, so that one major that npm refuses (ERESOLVE) does not block the safe fixes. Upgrades with a likely peer conflict come last: npm sometimes accepts one and leaves a tree on which every later install stops with ERESOLVE. Scan again between those steps. Direct dependencies of one scope at one version (for example `@angular/*` at 14.2.0) move together in one command. A breaking target is the newest release on its new major that is not deprecated and has no known advisory, not the first one.

- Package arguments come after `--`, so nothing in them can be read as an npm option. Lockfile entries whose name npm would not accept (shell characters, a leading `-`, ...) are never checked or put in a command; a warning lists them and they count as unchecked.
- A dependency declared by a workspace is installed there: `npm install -w packages/a -- name@version` (one line per workspace; a package declared by the root and a workspace gets both). The `npm update` line runs from the root and also reaches the workspaces' transitive packages.
- An npm alias (`"sio4": "npm:socket.io-client@4.0.0"`) is planned on its own and installed as `sio4@npm:socket.io-client@4.1.0`; it never merges with the real name or another alias.
- A package that is only a `peerDependency` of your project (a library) is never in the non-breaking step: `npm install` would raise its range in your package.json, which is a requirement for your users. It gets its own command, labelled.
- When a peer conflict already exists (and the step does not resolve it), `npm install` and `npm update` stop with ERESOLVE, so both lines of the non-breaking step carry `--legacy-peer-deps`. If the lockfile has packages installed only as peers (`"peer": true`), that flag would remove them, so the step is not printed as runnable commands: the report names the conflict and those packages, and shows the commands to run once the conflict is resolved by hand (in JSON: `blocked`).
- When registry data cannot be read (or the chain passes through a package that is not from the public registry, which is never looked up), the plan says it has no estimate for that dependency instead of guessing.

Cost: the registry documents downloaded for the report are reused, so the plan usually needs no extra registry requests (at most 150 per scan, 8 at a time, spent on production dependencies and the worst advisories first; when the limit cuts the plan short, a warning says how many packages were not looked up yet; they are cached for 6 hours like the rest, so when the limit is reached a second run continues where the first stopped) and two or three extra OSV batch queries (plus the details of advisories not seen yet). `--no-plan` skips it. In JSON, `plan` holds one entry per direct dependency with `estimated: true`; `suggestedOverrides` still lists every safe override, including those the plan makes unnecessary.

### About the suggested overrides

An npm override replaces **every** installed copy of a package, in production and dev dependencies alike, whatever `--no-dev` says. patchpath only suggests one when that is safe for all copies in the lockfile:

- the package is not declared by the project itself, in any section and with any spec, git and file ones included (npm rejects such overrides with `EOVERRIDE`; upgrade the dependency itself instead);
- every copy comes from the public registry, is not newer than the suggested version (no downgrades), and is on the same breaking line (same major; same minor on `0.x`; same patch on `0.0.x`);
- the suggested version (like every "fixed in" version) has been checked against OSV and carries no advisory of its own. If it does, the next fixed version is tried; when none is left, no override is suggested and the report says so;
- bundled copies (`inBundle`) are left out: npm cannot override them. They are listed under "Bundled copies" with the package to upgrade instead.

Remaining risks: an override can move a package outside the range its parent declared (for example `~6.5.2` -> `6.16.0`); semver says that is compatible, but packages do not always follow semver. Review the block, run `npm install` and your tests.

## Lockfiles

| File | Report | Upgrade plan, commands, `overrides` |
|---|---|---|
| `package-lock.json`, `npm-shrinkwrap.json` (v1, v2, v3) | yes | yes |
| `yarn.lock` (yarn v1 / classic) | yes | no: the report says "upgrade plan is not available for yarn/pnpm lockfiles yet" (`planUnavailable` in JSON) |
| `pnpm-lock.yaml` (`lockfileVersion: '9.0'`, pnpm 9 and 10) | yes | no (same note) |

For yarn and pnpm the report has everything else: vulnerabilities with fixed versions, deprecations, lag, `via`, direct/dev, `--no-dev`, `--fail-on` and exit codes. No npm command or `overrides` block is printed for them. yarn v2+ (berry) and pnpm lockfiles older than v9 are rejected with an error. pnpm workspaces (`importers`), aliases (`npm:`) and peer variants (`react-dom@18.2.0(react@18.2.0)`, reported once) are read; pnpm v9 has no dev flag, so dev-only packages are worked out from `devDependencies` by reachability. A yarn v1 lockfile has no tree, so direct and dev-only packages come from `package.json` (and the `package.json` of workspaces listed as `dir` or `dir/*`); without `package.json` every package is reported as transitive production code and a warning says so.

When a folder has several lockfiles, the one matching `packageManager` in package.json (`npm@`, `pnpm@`, `yarn@1.`) is read; otherwise the first of `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`. A warning names the ones not read; pass a lockfile path to scan another.

## Options

| Option | Effect |
|---|---|
| `--json` | Full report as JSON |
| `--no-dev` | Skip packages installed only for development (what `npm install --omit=dev` leaves out) |
| `--no-cache` | Do not use the local cache |
| `--no-plan` | Skip the upgrade plan (also `ScanOptions.plan: false`) |
| `--fail-on <level>` | Exit with code 1 if a vulnerability is at or above `low`, `moderate`, `high` or `critical`. Unknown severity counts as moderate. |
| `--registry <url>` | Packages whose `resolved` URL starts with this prefix are treated as public registry packages and checked. Use it for a mirror or proxy of registry.npmjs.org (Artifactory, Nexus, Verdaccio). Repeatable. |
| `--include-pinned-lag` | Also warn about direct dependencies pinned to an exact version in package.json (`"pyodide": "0.27.2"`, no `^`/`~`) that are a major version behind. Hidden by default because pins are usually deliberate; their vulnerabilities are always reported (also `ScanOptions.includePinnedLag`). |
| `--assume-public` | Treat lockfile entries without a `resolved` URL as public registry packages (for lockfiles written with npm's `omit-lockfile-registry-resolved`). Not needed for npm 6 bundled or `"resolved": false` children of a registry package, nor for plain-`http://` registry.npmjs.org URLs: those are checked already. |
| `--allow-unchecked` | With `--fail-on`, do not exit 3 because some packages could not be checked. |

Exit codes:

| Code | Meaning |
|---|---|
| `0` | No vulnerability at or above `--fail-on` (or no `--fail-on` given) |
| `1` | A vulnerability is at or above `--fail-on` |
| `2` | Error: bad option, unreadable lockfile, network failure |
| `3` | `--fail-on` given and not reached, but some packages were not checked (see Privacy). A clean result would be misleading, so CI fails. Fix with `--registry` / `--assume-public`, or accept the gap with `--allow-unchecked`. |

## Privacy

Only the **names and versions** of packages whose lockfile `resolved` URL starts with `https://registry.npmjs.org/` or `https://registry.yarnpkg.com/` (or the plain `http://` form old npm versions wrote for the same hosts) are sent to `api.osv.dev` and `registry.npmjs.org`. Everything else is not checked and its name goes nowhere:

- packages from other registries, git, tarball URLs or local files;
- packages with **no `resolved` URL**: their origin is unknown, so they could be private. The exception are dependencies bundled by another package (`inBundle`, or `bundled` in v1 lockfiles), which have no URL of their own and follow the package that bundles them. A package that your own project (the root or a workspace) bundles is judged by its own `resolved` URL like any other. The same goes for npm 6 lockfiles that write `"resolved": false` for optional or bundled children of a registry package (the fsevents 1.x tree): they are checked only when their parent was resolved from the public registry.

For `yarn.lock` (v1) the same rule applies to each entry's `resolved` URL, and two more checks must pass: every spec in the entry's header is a registry range or tag (not git, a URL, `file:`, `link:` or a GitHub shorthand), and the URL is that registry's tarball path for the entry's own package name (`<name>/-/...`, so a public tarball listed under another name is not checked). An alias (`"x@npm:lodash@^4"`) is looked up as `lodash` only.

For `pnpm-lock.yaml` (v9), pnpm writes a `tarball` URL only when it is not the standard one of the registry configured at install time; an entry with only `integrity` came from that registry, but the lockfile does not say which one it was (it may be private, or a scope registry). Such entries are therefore treated like npm entries without `resolved`: unchecked, unless you pass `--assume-public` (which then sends their names). An entry with a `tarball` URL is checked when the URL is the public registry's (or a `--registry` prefix's) tarball path for that package; directories, git, `file:`, `link:` and workspace packages are never checked. With pnpm, `--registry` cannot open integrity-only entries (there is no URL to match), only `--assume-public` can.

Unchecked packages are counted in the report (`summary.external`) and listed in a warning that says how to check them. The two opt-ins widen what is sent:

- `--registry <url>` sends the names of packages resolved from that prefix. Only use it for a mirror of the public registry. If the same URL also serves private packages (a "virtual" repository that merges both), their names are sent too.
- `--assume-public` sends the names of all packages without a `resolved` URL. Only use it when you know those are public registry packages.

The upgrade plan follows the same rule. It asks `registry.npmjs.org` only for packages on a vulnerable chain, all of them installed packages that are checked anyway (usually the documents already downloaded for the report are reused), and sends `api.osv.dev` the names of those packages with the candidate versions it estimated. A chain that passes through an unchecked package is not followed, and that package is never requested.

One exception to "installed packages only" is the peer ERESOLVE prediction (npm lockfiles). To decide whether a non-breaking upgrade can go into the safe `npm install` step, the planner also asks `registry.npmjs.org` for the registry document of a peer that the new version of a public, checked package declares but that is **not installed** (npm loads such peers too, and may stop with ERESOLVE). The name comes from that public package's own registry metadata, not from your lockfile, and only the name goes out, as one request per such peer (peers of those peers count too): at most 30 of the 150 plan requests, and a warning says when the limit cut it short. A name your lockfile has from an unchecked source (private registry, git, file) is never requested, and unchecked packages are never asked about at all. Nothing is sent to `api.osv.dev` for these peers, and `--no-plan` turns the whole thing off.

Your source code and file paths never leave your machine. The report shows the scanned lockfile path (first line of the text output; `root` and `lockfile` in `--json`) relative to the current directory, or as `~/...` when it is outside it but under your home directory, so your user name is not in it. Only a project outside both is shown with its full absolute path (which may contain a user name); check that line before pasting a report somewhere public. Responses from OSV and the registry (public data only) are cached in a local directory (`%LOCALAPPDATA%\patchpath`, else `$XDG_CACHE_HOME/patchpath` or `~/.cache/patchpath`) for a few hours; `--no-cache` neither reads nor writes it. See [SECURITY.md](SECURITY.md).

Strings from the lockfile (package names, versions, the `via` chain), from advisories and from the registry are sanitised when they are read, and again before printing: control characters, invisible and bidirectional formatting characters and Unicode tag characters are replaced, whitespace is collapsed to one line, and length is capped (the exact list is in SECURITY.md). Still treat them as untrusted data if you feed the JSON to another program or an AI agent.

## Limits

- npm lockfiles, and yarn v1 and pnpm v9 without the upgrade plan. yarn berry, pnpm before v9, bun, PyPI and Cargo are not supported yet.
- pnpm: packages whose lockfile entry has only an `integrity` (no `tarball`) are unchecked unless `--assume-public` is given (see Privacy), so a pnpm scan without it usually checks very little.
- A clean report is not a guarantee: patchpath only knows what OSV knows, and only about the packages it checked.
- Suggested versions come from advisory data; they do not check compatibility with your code.
- A package marked malicious (`MAL-` advisory) is reported as such but there is no upgrade to suggest for it; remove it.
- The upgrade plan is an estimate from registry metadata, not an npm resolver run (see [How the upgrade plan works](#how-the-upgrade-plan-works)).

## Ideas (not commitments)

- Diff mode for pull requests and a GitHub Action
- MCP server so AI agents can ask "is this repo healthy?"
- Runtime and Docker end-of-life checks (endoflife.date)
- License checks

## Development

```
npm install
npm test        # builds dist/ first: the CLI tests run the real dist/cli.js
npm run build
node dist/cli.js <path>
```

Requires Node 22 or newer. `npm run typecheck` runs the type checker.

## Contributing

Issues and pull requests are welcome once the repository is public. Run `npm run typecheck` and `npm test` before sending a change, add a test for behaviour changes (the tests use fake network responses and never call the real OSV or registry), and add a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md). Keep the zero-runtime-dependency rule (`semver` is bundled at build time). Report security problems privately, see [SECURITY.md](SECURITY.md).

## License

MIT
