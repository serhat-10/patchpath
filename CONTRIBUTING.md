# Contributing

Issues and pull requests are welcome, in English or Turkish.

## Setup

```
npm ci
npm run typecheck
npm test
npm run build
```

Node 22 or newer is required.

## Rules

- **Tests never touch the real network.** `test/setup-no-network.ts` blocks real network access, and tests use fake OSV and registry responses. A test that needs the network is a bug.
- **Behaviour changes need a test and a CHANGELOG line** under "Unreleased" in [CHANGELOG.md](CHANGELOG.md).
- **Zero runtime dependencies.** `semver` is bundled at build time.
- **Privacy matters.** patchpath only sends package names and versions from the lockfile to OSV and the npm registry. Private or unverifiable packages must not be sent. See [SECURITY.md](SECURITY.md) for why.
- **New lockfile types fail closed.** When adding a lockfile format, any package whose origin cannot be established as public must be treated as private and left out of network requests, never the other way around.

## Security

Report security problems privately through the [advisory form](https://github.com/serhat-10/patchpath/security/advisories/new), not in a public issue.
