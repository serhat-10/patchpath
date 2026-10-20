# Unrecoverable projects

None.

All 34 candidates from the earlier measurements (22 npm, 12 yarn/pnpm) were checked, and all 34 are in the corpus.

What was checked for each project, using only read-only requests to api.github.com and raw.githubusercontent.com:

1. The recorded commit SHA exists in the recorded repository (`GET /repos/{repo}/commits/{sha}` returned the same full SHA).
2. The lockfile, the root `package.json` and (for the yarn/pnpm projects) every workspace `package.json` used earlier were downloaded from raw.githubusercontent.com at that SHA. The SHA-256 of each download equals the SHA-256 of the local copy kept from the earlier measurements (196 files in total, 0 differences).
3. The lockfile path exists in that commit (`GET /repos/{repo}/contents/{path}?ref={sha}` returned a blob).

Caveats that are not failures:

- `electron-qs`, `heroku-node` and `gatsby-blog` were originally picked from a moving branch (`main` or `master`). Only the pinned SHA is part of the corpus, and the files at that SHA match the local copies, so they are reproducible.
- The earlier records do not contain a file hash. The local copies were matched to the remote files by content hash now. A match proves that the local copy is the file at that commit; it does not prove that an earlier round used exactly that copy (the copies were moved between round folders).
- A repository can later be renamed, made private or deleted, and then its SHAs stop resolving. `corpus.lock.json` lets you detect any change of content.
