# Troubleshooting

## Network and proxy

The kit talks to `raw.githubusercontent.com` (download), `api.osv.dev` (reference, patchpath) and `registry.npmjs.org` (patchpath, npm). Failures look like `FAIL <project>/<file>: fetch failed` (fetch step) or `fetch failed` / `OSV HTTP 5xx` (reference step). The scripts retry network errors, HTTP 429 and 5xx four times with growing waits.

- Behind a proxy: Node's built-in `fetch` (used by `fetch-corpus.mjs` and `reference-osv.mjs`) does not read `HTTP_PROXY`/`HTTPS_PROXY` by default. With Node 24 you can set `NODE_USE_ENV_PROXY=1` together with `HTTPS_PROXY=<url>`; with Node 22 use a proxy-aware launcher or run the fetch step on a machine with direct access and copy the `data` folder (the `--skip-fetch` option of `run-all.mjs` reuses it). patchpath and npm have their own proxy settings (`npm config set proxy`/`https-proxy`; see patchpath's documentation).
- Corporate TLS inspection: set `NODE_EXTRA_CA_CERTS=<path to your CA file>` for Node and `npm config set cafile <path>` for npm.
- With `--log-hosts`, a request to any other host fails on purpose with `hostlog: blocked host <name>` and is recorded in `requests.jsonl` with `"ok": false`. If patchpath is configured for a mirror (`--registry`), pass the allowed host through the environment variable `KIT_ALLOW` (comma separated, replaces the default list), or do not use `--log-hosts`.
- Git dependencies in some lockfiles make npm contact `codeload.github.com`. Under `--log-hosts` that is blocked; the plan evaluation records it (the commands usually still succeed). Without `--log-hosts` npm will contact that host.
- `MISMATCH <file>: expected ..., got ...`: the file at the pinned SHA no longer has the recorded hash (the repository was rewritten, or a proxy changed the content). The file is not written. Do not use `--update-lock` to hide this.
- `HTTP 404` for a file: the repository was renamed, made private or deleted. Record the project in `unrecoverable.md`.
- Rate limits: raw.githubusercontent.com may answer 429 after many requests from one address; the scripts back off, a re-run continues where it stopped (verified files are skipped).

## Disk

- Corpus 26 MB, reference 6 MB, patchpath output 14 MB, comparison under 1 MB. The plan evaluation keeps copies of two files per variant plus an npm cache under `<out>/plan/_work`; it is deleted at the end unless `--keep-work` is given. If a run was interrupted, delete `<out>/plan/_work` yourself (it can reach tens or hundreds of MB).
- `--npm-cache <dir>` puts the npm cache elsewhere (a different drive, or a warm cache you want to reuse). The default is inside the work folder so that the evaluation does not touch your normal npm cache.

## npm versions

- Plan results depend on the npm version: `npm audit` output, `npm audit fix` choices and ERESOLVE behaviour all changed between npm 8, 9, 10 and 11. The snapshot used npm 11.16.0. The version is stored in `plan/plan-eval.json`; compare like with like.
- `npm audit` needs `registry.npmjs.org` even with `--package-lock-only`. If it prints `{"error":...}` the project's count is `null` and shows as `n/a`. Check `plan/raw/<id>/audit.audit.json`.
- Old lockfile versions (v1) are upgraded by npm when it rewrites the lockfile, so the changed file is not directly comparable line by line. The evaluation only counts advisories.
- `npm audit fix` exits 1 when advisories remain. That is normal and not treated as a failure.
- Use `--npm <command>` to run another npm (for example a specific version through `npx npm@10 ...`; the value is used as the command prefix).

## Windows and Linux

- All commands are single lines that work in bash and PowerShell. Use forward slashes or quote paths that contain spaces.
- On Windows the kit runs npm and patchpath commands through the shell (`npm.cmd`); on Linux and macOS through `sh`. Paths and the npm cache folder are quoted.
- `--patchpath` accepts a path ending in `.js`, `.mjs` or `.cjs` (run with the current Node) or any command on PATH (run through the shell on Windows).
- A Node crash message such as `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` after the scripts finished is a Windows/libuv shutdown issue; the scripts set `process.exitCode` instead of calling `process.exit()` to avoid it. If you see it in a changed script, do the same.
- Long paths: on Windows keep the output folder path short (for example `C:\bench\work`); npm and some lockfile paths can be long.
- Line endings do not matter for the JSON files; the hash check works on bytes, so do not convert line endings of files in `data`.

## Other symptoms

- `cannot run patchpath (...)`: `patchpath --version` failed. Check the path to `dist/cli.js` and that the project is built.
- `MISSING <id>: ... (run fetch-corpus.mjs first)`: a later step could not find the downloaded lockfile.
- `plan-eval.mjs`: `missing lockfile or patchpath run`: the project was skipped because `runs/<id>/default.json` or `default.txt` does not exist. Run `run-patchpath.mjs` for it first.
- `no reference for <id>, skipped` in `compare.mjs`: run `reference-osv.mjs` for that project.
- A project whose patchpath output is not valid JSON is reported and skipped by `compare.mjs`; see `<variant>.meta.json` for stderr and the exit code.
