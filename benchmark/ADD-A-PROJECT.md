# Add a project to the corpus

A corpus entry is a public GitHub repository at a full commit SHA, plus the paths of the files the kit needs. The kit never clones a repository; it downloads single files from raw.githubusercontent.com and checks their SHA-256.

## 1. Pick the commit

Use a tag or a commit and resolve it to the full 40-character SHA. Branch names move; the SHA does not. Anonymous read-only requests are enough:

```
curl -s https://api.github.com/repos/<owner>/<repo>/commits/<tag-or-branch>
```

Copy `sha` and `commit.committer.date` (the date part). Check that the lockfile exists at that commit:

```
curl -sI https://raw.githubusercontent.com/<owner>/<repo>/<sha>/<path-to-lockfile>
```

(`HTTP/2 200`). The GitHub API allows about 60 anonymous requests per hour.

## 2. Edit `corpus.json`

Add an object to `projects`:

```
{
  "id": "myproject",
  "group": "npm",
  "repo": "owner/repo",
  "sha": "<40 hex characters>",
  "commitDate": "2024-05-01",
  "lockfilePath": "package-lock.json",
  "manifestPath": "package.json",
  "type": "npm",
  "lockfileFormat": "npm-v3",
  "workspaceManifestPaths": [],
  "notes": "what is special about it"
}
```

- `id`: short, unique, lower case; it names folders.
- `group`: `npm` for `package-lock.json`, `yarn-pnpm` for `yarn.lock` and `pnpm-lock.yaml`. `--group` filters by it.
- `type`: `npm`, `yarn` (v1 only; Berry is not supported by the reference) or `pnpm` (lockfile version 9 only).
- `lockfileFormat`: free text for readers (`npm-v1`, `npm-v2`, `npm-v3`, `yarn-v1`, `pnpm-9`). npm lockfile `lockfileVersion` is at the top of the file.
- `lockfilePath` and `manifestPath` are repository-relative with forward slashes; a project in a sub-folder uses for example `app/package-lock.json` and `app/package.json`.
- `workspaceManifestPaths`: every workspace `package.json` that patchpath needs next to a yarn or pnpm lockfile (empty for single packages and for npm workspaces, where only the root manifest is used).
- `"planEval": true`: only for npm projects that should be part of the plan evaluation. Check the selection rule in `METHOD.md` first: the project must have a root `package-lock.json` and `package.json` in the same folder, no `-w` command in patchpath's plan, and a plan run that finishes in a reasonable time. Leave it out otherwise.

## 3. Create the hashes

Hashes of all downloaded files live in `corpus.lock.json` (SHA-256 and size per `<id>/<path>`). Add the new project's entries with:

```
node fetch-corpus.mjs --out work/data --only myproject --update-lock
```

`--update-lock` only adds missing entries and never overwrites an existing one. A hash that differs from an existing entry is reported as MISMATCH and the file is not written. Review the new entries in `corpus.lock.json` (they are the only change), then run without `--update-lock` once to confirm that the download verifies:

```
node fetch-corpus.mjs --out work/data --only myproject
```

Commit the `corpus.json` and `corpus.lock.json` changes together. The lock file is what makes a later change of the remote file visible.

## 4. Check it

```
node reference-osv.mjs --data work/data --out work/ref --only myproject
node run-patchpath.mjs --patchpath <cli.js> --data work/data --out work/runs --only myproject
node compare.mjs --runs work/runs --ref work/ref --out work/compare --only myproject
```

Look at `byClass` and `excluded` in `work/ref/myproject.ref.json`: the queried count plus the excluded count should be close to the package count of the lockfile. Entries that land in `other-registry` or `no-resolved` usually point to a private registry or an unusual lockfile and are worth a note in `notes`.

Finally add a row to `CORPUS.md` so the table stays in step with `corpus.json`.

## Unrecoverable projects

If a project cannot be reproduced (the repository was deleted or renamed, or a downloaded file no longer matches its hash), do not guess: leave it out and describe it in `unrecoverable.md`.
