# Corpus

34 projects, each pinned to a full commit SHA. Machine-readable version: `corpus.json`; file hashes: `corpus.lock.json`.

Every lockfile, manifest and workspace manifest listed here was re-downloaded from raw.githubusercontent.com at the pinned SHA and its SHA-256 matched the copy used in earlier measurements; the commit SHA was confirmed to exist through the GitHub API. Projects for which that could not be shown are not in the list (see `unrecoverable.md`).

## npm (package-lock.json), 22 projects

| id | type | repo | sha (full in corpus.json) | commit date | lockfile | manifest | workspace manifests | notes |
|---|---|---|---|---|---|---|---|---|
| nodegoat | npm (npm-v2) | [OWASP/NodeGoat](https://github.com/OWASP/NodeGoat/tree/c5cb68a7084e4ae7dcc60e6a98768720a81841e8) | `c5cb68a7084e` | 2023-06-21 | `package-lock.json` | `package.json` |  | Express app (deliberately vulnerable training app); originally picked from ref master |
| nightscout | npm (npm-v1) | [nightscout/cgm-remote-monitor](https://github.com/nightscout/cgm-remote-monitor/tree/0bf616be873dd819b1842105dca14499d078dd5d) | `0bf616be873d` | 2022-09-30 | `package-lock.json` | `package.json` |  | Express app; originally picked from ref 14.2.6 |
| mattermost | npm (npm-v1) | [mattermost/mattermost-webapp](https://github.com/mattermost/mattermost-webapp/tree/fc08a2b49f1a994164697d2c51442baf21812d1f) | `fc08a2b49f1a` | 2020-02-12 | `package-lock.json` | `package.json` |  | React webapp, git deps; originally picked from ref v5.20.0 |
| bitwarden | npm (npm-v2) | [bitwarden/clients](https://github.com/bitwarden/clients/tree/3f05a1772ea7f321768a13ec42beee1e5e1f9033) | `3f05a1772ea7` | 2023-02-14 | `package-lock.json` | `package.json` |  | Angular + Electron monorepo, npm workspaces, very large; originally picked from ref web-v2023.2.0 |
| parse-server | npm (npm-v1) | [parse-community/parse-server](https://github.com/parse-community/parse-server/tree/1045eeb700798ac081b1d0731963312647daa436) | `1045eeb70079` | 2020-04-03 | `package-lock.json` | `package.json` |  | Express-based server library; originally picked from ref 4.2.0 |
| chartjs | npm (npm-v1) | [chartjs/Chart.js](https://github.com/chartjs/Chart.js/tree/8780e15c73c96db58034466e47174eb21b724857) | `8780e15c73c9` | 2021-04-02 | `package-lock.json` | `package.json` |  | library, plain-http resolved URLs; originally picked from ref v3.0.0 |
| nest | npm (npm-v1) | [nestjs/nest](https://github.com/nestjs/nest/tree/96ad0258236953fe26bbbf8da2380f393bfa0d2f) | `96ad02582369` | 2020-03-13 | `package-lock.json` | `package.json` |  | framework monorepo; originally picked from ref v7.0.0 |
| typescript | npm (npm-v2) | [microsoft/TypeScript](https://github.com/microsoft/TypeScript/tree/a7e3374f13327483fbe94e32806d65785b0b6cda) | `a7e3374f1332` | 2024-08-30 | `package-lock.json` | `package.json` |  | compiler (2024); originally picked from ref v5.6.2 |
| npmcli | npm (npm-v3) | [npm/cli](https://github.com/npm/cli/tree/977fd5784f875fdc2e3436ed15c444ddca63e3d7) | `977fd5784f87` | 2024-10-03 | `package-lock.json` | `package.json` |  | npm itself, workspaces (2024); originally picked from ref v10.9.0 |
| vscode | npm (npm-v3) | [microsoft/vscode](https://github.com/microsoft/vscode/tree/912bb683695358a54ae0c670461738984cbb5b95) | `912bb6836953` | 2024-10-28 | `package-lock.json` | `package.json` |  | Electron app (2024); originally picked from ref 1.95.0 |
| ngx-admin | npm (npm-v1) | [akveo/ngx-admin](https://github.com/akveo/ngx-admin/tree/6925fd5e3a8d7a7109d0fdb3af8fe7bc4954b8fa) | `6925fd5e3a8d` | 2019-07-02 | `package-lock.json` | `package.json` |  | Angular 8 app; originally picked from ref v4.0.0 |
| mailspring | npm (npm-v1) | [Foundry376/Mailspring](https://github.com/Foundry376/Mailspring/tree/65435390ade4c4a42973fcda71b43f8e8c8894c4) | `65435390ade4` | 2019-10-14 | `app/package-lock.json` | `app/package.json` |  | Electron app, git deps; originally picked from ref 1.7.0 |
| electron-qs | npm (npm-v3) | [electron/electron-quick-start](https://github.com/electron/electron-quick-start/tree/841329e9c54afcdde476c3ef7b8507cce8aa0f73) | `841329e9c54a` | 2026-10-16 | `package-lock.json` | `package.json` |  | Electron starter, tiny, current; originally picked from ref main |
| gatsby-blog | npm (npm-v2) | [gatsbyjs/gatsby-starter-blog](https://github.com/gatsbyjs/gatsby-starter-blog/tree/d75052245100ae3c98807c5f38c6e7ec68910e74) | `d75052245100` | 2026-05-11 | `package-lock.json` | `package.json` |  | Gatsby site, current; originally picked from ref master |
| heroku-node | npm (npm-v3) | [heroku/node-js-getting-started](https://github.com/heroku/node-js-getting-started/tree/8b8dec11fcf027522a857e0c831ee01b7124f673) | `8b8dec11fcf0` | 2026-10-15 | `package-lock.json` | `package.json` |  | small Express app, current; originally picked from ref main |
| jitsi | npm (npm-v1) | [jitsi/jitsi-meet](https://github.com/jitsi/jitsi-meet/tree/2572ba9a65569544abcf434f4e63a1a130108f46) | `2572ba9a6556` | 2021-10-05 | `package-lock.json` | `package.json` |  | React webapp, git/tarball deps; originally picked from ref stable/jitsi-meet_6433 |
| bookshelf | npm (npm-v2) | [kentcdodds/bookshelf](https://github.com/kentcdodds/bookshelf/tree/32e9e87db958de863bead65761bfbe2dec0eafd4) | `32e9e87db958` | 2024-11-25 | `package-lock.json` | `package.json` |  | create-react-app app; originally picked from ref main |
| nextjs-blog | npm (npm-v1) | [timlrx/tailwind-nextjs-starter-blog](https://github.com/timlrx/tailwind-nextjs-starter-blog/tree/08fb1d4690b1b1233da3925c4f78882d9580dcf2) | `08fb1d4690b1` | 2021-08-08 | `package-lock.json` | `package.json` |  | Next.js site; originally picked from ref v1.0.0 |
| jhipster-vue | npm (npm-v2) | [jhipster/jhipster-sample-app-vuejs](https://github.com/jhipster/jhipster-sample-app-vuejs/tree/f866f4fad1f2174b7b0c3aaf4250e99984d5bfa3) | `f866f4fad1f2` | 2021-03-21 | `package-lock.json` | `package.json` |  | Vue + Spring sample (webpack); originally picked from ref v7.0.0 |
| socketio | npm (npm-v1) | [socketio/socket.io](https://github.com/socketio/socket.io/tree/5eaeffc8e2244b73dd13fd2562c9684ad289997b) | `5eaeffc8e224` | 2021-03-10 | `package-lock.json` | `package.json` |  | library, npm alias (socket.io-client-v2); originally picked from ref 4.0.0 |
| voting-result | npm (npm-v2) | [dockersamples/example-voting-app](https://github.com/dockersamples/example-voting-app/tree/63e9150ca17af4ed05880d4245e486481f73fcb4) | `63e9150ca17a` | 2024-10-10 | `result/package-lock.json` | `result/package.json` |  | small Express + socket.io app; originally picked from ref main |
| directus | npm (npm-v2) | [directus/directus](https://github.com/directus/directus/tree/c95add08ef1386cab6e54546f03d541d889148ed) | `c95add08ef13` | 2021-11-05 | `package-lock.json` | `package.json` |  | Vue 3 + API monorepo, workspaces, entries without resolved; originally picked from ref v9.0.0 |

## yarn v1 and pnpm 9, 12 projects

| id | type | repo | sha (full in corpus.json) | commit date | lockfile | manifest | workspace manifests | notes |
|---|---|---|---|---|---|---|---|---|
| prettier | yarn (yarn-v1) | [prettier/prettier](https://github.com/prettier/prettier/tree/a4a0e1ebdd80bb4d6f669b33979e549a8d046987) | `a4a0e1ebdd80` | 2020-07-31 | `yarn.lock` | `package.json` |  | 2 git/codeload entries (ci-info, parse-srcset); single package |
| hyper | yarn (yarn-v1) | [vercel/hyper](https://github.com/vercel/hyper/tree/606746210f91112d448f631d8613d05861ff2c44) | `606746210f91` | 2020-07-30 | `yarn.lock` | `package.json` |  | 1 codeload entry (mousetrap); single package |
| docusaurus | yarn (yarn-v1) | [facebook/docusaurus](https://github.com/facebook/docusaurus/tree/e442ac95ee87b8187468cd250c73b491fefd9302) | `e442ac95ee87` | 2020-07-31 | `yarn.lock` | `package.json` | 32 | yarn workspaces; yarn workspaces, sub-package.json downloaded |
| storybook | yarn (yarn-v1) | [storybookjs/storybook](https://github.com/storybookjs/storybook/tree/0a18da8cdd0300f2871ae221aad2c3286559fccc) | `0a18da8cdd03` | 2020-07-29 | `yarn.lock` | `package.json` | 81 | yarn workspaces; 1 github: dependency; yarn workspaces, sub-package.json downloaded |
| babel | yarn (yarn-v1) | [babel/babel](https://github.com/babel/babel/tree/374a253d0c3635e1373c79b1d928d7de0a3e8ff7) | `374a253d0c36` | 2020-07-30 | `yarn.lock` | `package.json` |  | root only (single package.json); 4 link: and 1 git entry; all deps are devDependencies; single package |
| material-ui | yarn (yarn-v1) | [mui/material-ui](https://github.com/mui/material-ui/tree/e6a871f22367e44d692278996b07ef9508c7ce6a) | `e6a871f22367` | 2020-07-31 | `yarn.lock` | `package.json` | 15 | yarn workspaces; npm: aliases; yarn workspaces, sub-package.json downloaded |
| vuecore | pnpm (pnpm-9) | [vuejs/core](https://github.com/vuejs/core/tree/b1d1f44e9f488b049dc33544e819c6590caca560) | `b1d1f44e9f48` | 2024-06-28 | `pnpm-lock.yaml` | `package.json` |  | pnpm importers; pnpm importers (incl. root) |
| vite | pnpm (pnpm-9) | [vitejs/vite](https://github.com/vitejs/vite/tree/24c799b121c4d72cc08a52a46f82a831b64b1e6f) | `24c799b121c4` | 2024-06-27 | `pnpm-lock.yaml` | `package.json` |  | pnpm importers; 76 file: directory packages (playground); pnpm importers (incl. root) |
| svelte-kit | pnpm (pnpm-9) | [sveltejs/kit](https://github.com/sveltejs/kit/tree/670608adab4c414120cdedbf93f258b4e5ca10bf) | `670608adab4c` | 2024-06-29 | `pnpm-lock.yaml` | `package.json` |  | pnpm importers; 1 directory package; pnpm importers (incl. root) |
| shadcn-ui | pnpm (pnpm-9) | [shadcn-ui/ui](https://github.com/shadcn-ui/ui/tree/79254d6b8084f9d5b66cccd168452252d3a60e51) | `79254d6b8084` | 2024-07-24 | `pnpm-lock.yaml` | `package.json` |  | pnpm importers; pnpm importers (incl. root) |
| tanstack-query | pnpm (pnpm-9) | [TanStack/query](https://github.com/TanStack/query/tree/46bed749c6f35841a45c5a73c73141f1b68bebca) | `46bed749c6f3` | 2024-06-30 | `pnpm-lock.yaml` | `package.json` |  | pnpm importers; pnpm importers (incl. root) |
| vitesse | pnpm (pnpm-9) | [antfu-collective/vitesse](https://github.com/antfu-collective/vitesse/tree/de4341d582698d5b67e2e58ded316b25900c8523) | `de4341d58269` | 2024-05-19 | `pnpm-lock.yaml` | `package.json` |  | single package; single package |

Notes:
- For npm workspaces projects (bitwarden, vscode, npmcli, directus) only the root `package.json` and the root lockfile are part of the corpus; workspace manifests were not used in the earlier npm measurements. For yarn/pnpm the workspace manifests that earlier measurements used are listed and fetched.
- The "originally picked from ref" text is only how the project was found; the SHA is what counts. Branches such as main/master move; the SHA does not.

## Plan evaluation projects

Ten npm projects carry `"planEval": true` in `corpus.json` and are used by `plan-eval.mjs`: typescript, socketio, gatsby-blog, nextjs-blog, vscode, bookshelf, parse-server, nodegoat, chartjs, nightscout. Selection rule: at least 49 and at most 214 advisories in `npm audit` at the pinned commit, no `-w` (workspace) command and no commented-out command in patchpath's plan, patchpath scan under 20 seconds.

Not selected, and why: mattermost (283 advisories, a ten-minute run was a risk), nest (274), ngx-admin (325) and jhipster-vue (272) (large), bitwarden, npmcli and directus (their plans contain workspace `-w` commands), voting-result (21 advisories, too small), electron-qs and heroku-node (no advisories), mailspring (87 advisories; it has a git dependency `slate@github:` that npm fetches from codeload.github.com, which the run did not allow, so it could not be measured). Yarn and pnpm projects are not evaluated: the plan commands are npm commands.
