# Comparison

Unit: package name@version + OSV advisory id. FP = patchpath unit with no matching reference id; FN = in-scope reference unit patchpath did not report.

## Variant: default

Totals over 34 projects: patchpath 6669 units, reference (in scope) 6546; FP 0, FN 79; precision 100.0%, recall 98.8%. Reference units out of scope: 2261 (not reported by patchpath: 2059).

| project | type | patchpath | reference | FP | FN | precision | recall | out of scope (not reported) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| nodegoat | npm | 320 | 206 | 0 | 0 | 100.0% | 100.0% | 114 (0) |
| nightscout | npm | 298 | 298 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| mattermost | npm | 352 | 333 | 0 | 0 | 100.0% | 100.0% | 19 (0) |
| bitwarden | npm | 370 | 370 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| parse-server | npm | 227 | 225 | 0 | 0 | 100.0% | 100.0% | 2 (0) |
| chartjs | npm | 240 | 239 | 0 | 0 | 100.0% | 100.0% | 1 (0) |
| nest | npm | 352 | 352 | 0 | 19 | 100.0% | 94.6% | 37 (18) |
| typescript | npm | 65 | 65 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| npmcli | npm | 181 | 173 | 0 | 0 | 100.0% | 100.0% | 8 (0) |
| vscode | npm | 211 | 211 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| ngx-admin | npm | 471 | 447 | 0 | 14 | 100.0% | 96.9% | 38 (0) |
| mailspring | npm | 107 | 107 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| electron-qs | npm | 0 | 0 | 0 | 0 | n/a | n/a | 0 (0) |
| gatsby-blog | npm | 143 | 143 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| heroku-node | npm | 1 | 1 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| jitsi | npm | 313 | 312 | 0 | 0 | 100.0% | 100.0% | 1 (0) |
| bookshelf | npm | 228 | 228 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| nextjs-blog | npm | 159 | 159 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| jhipster-vue | npm | 346 | 346 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| socketio | npm | 90 | 90 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| voting-result | npm | 22 | 22 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| directus | npm | 48 | 94 | 0 | 46 | 100.0% | 51.1% | 468 (468) |
| prettier | yarn | 154 | 154 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| hyper | yarn | 275 | 275 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| docusaurus | yarn | 428 | 428 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| storybook | yarn | 711 | 711 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| babel | yarn | 177 | 177 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| material-ui | yarn | 380 | 380 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| vuecore | pnpm | 0 | 0 | 0 | 0 | n/a | n/a | 152 (152) |
| vite | pnpm | 0 | 0 | 0 | 0 | n/a | n/a | 194 (194) |
| svelte-kit | pnpm | 0 | 0 | 0 | 0 | n/a | n/a | 155 (155) |
| shadcn-ui | pnpm | 0 | 0 | 0 | 0 | n/a | n/a | 213 (213) |
| tanstack-query | pnpm | 0 | 0 | 0 | 0 | n/a | n/a | 646 (646) |
| vitesse | pnpm | 0 | 0 | 0 | 0 | n/a | n/a | 213 (213) |

## Variant: nodev

Totals over 22 projects: patchpath 1738 units, reference (in scope) 1804; FP 0, FN 87; precision 100.0%, recall 95.2%. Reference units out of scope: 3305 (not reported by patchpath: 3284).

| project | type | patchpath | reference | FP | FN | precision | recall | out of scope (not reported) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| nodegoat | npm | 90 | 70 | 0 | 0 | 100.0% | 100.0% | 250 (230) |
| nightscout | npm | 199 | 226 | 0 | 27 | 100.0% | 88.1% | 72 (72) |
| mattermost | npm | 84 | 84 | 0 | 0 | 100.0% | 100.0% | 268 (268) |
| bitwarden | npm | 92 | 92 | 0 | 0 | 100.0% | 100.0% | 278 (278) |
| parse-server | npm | 163 | 163 | 0 | 0 | 100.0% | 100.0% | 64 (64) |
| chartjs | npm | 0 | 0 | 0 | 0 | n/a | n/a | 240 (240) |
| nest | npm | 84 | 84 | 0 | 0 | 100.0% | 100.0% | 305 (305) |
| typescript | npm | 0 | 0 | 0 | 0 | n/a | n/a | 65 (65) |
| npmcli | npm | 50 | 50 | 0 | 0 | 100.0% | 100.0% | 131 (131) |
| vscode | npm | 27 | 27 | 0 | 0 | 100.0% | 100.0% | 184 (184) |
| ngx-admin | npm | 115 | 129 | 0 | 14 | 100.0% | 89.1% | 356 (356) |
| mailspring | npm | 107 | 107 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| electron-qs | npm | 0 | 0 | 0 | 0 | n/a | n/a | 0 (0) |
| gatsby-blog | npm | 143 | 143 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| heroku-node | npm | 0 | 0 | 0 | 0 | n/a | n/a | 1 (1) |
| jitsi | npm | 195 | 194 | 0 | 0 | 100.0% | 100.0% | 119 (118) |
| bookshelf | npm | 183 | 183 | 0 | 0 | 100.0% | 100.0% | 45 (45) |
| nextjs-blog | npm | 122 | 122 | 0 | 0 | 100.0% | 100.0% | 37 (37) |
| jhipster-vue | npm | 33 | 33 | 0 | 0 | 100.0% | 100.0% | 313 (313) |
| socketio | npm | 10 | 10 | 0 | 0 | 100.0% | 100.0% | 80 (80) |
| voting-result | npm | 22 | 22 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| directus | npm | 19 | 65 | 0 | 46 | 100.0% | 29.2% | 497 (497) |

## Variant: assume-public

Totals over 34 projects: patchpath 8807 units, reference (in scope) 8806; FP 0, FN 0; precision 100.0%, recall 100.0%. Reference units out of scope: 1 (not reported by patchpath: 0).

| project | type | patchpath | reference | FP | FN | precision | recall | out of scope (not reported) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| nodegoat | npm | 320 | 320 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| nightscout | npm | 298 | 298 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| mattermost | npm | 352 | 352 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| bitwarden | npm | 370 | 370 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| parse-server | npm | 227 | 227 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| chartjs | npm | 240 | 239 | 0 | 0 | 100.0% | 100.0% | 1 (0) |
| nest | npm | 389 | 389 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| typescript | npm | 65 | 65 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| npmcli | npm | 181 | 181 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| vscode | npm | 211 | 211 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| ngx-admin | npm | 485 | 485 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| mailspring | npm | 107 | 107 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| electron-qs | npm | 0 | 0 | 0 | 0 | n/a | n/a | 0 (0) |
| gatsby-blog | npm | 143 | 143 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| heroku-node | npm | 1 | 1 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| jitsi | npm | 313 | 313 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| bookshelf | npm | 228 | 228 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| nextjs-blog | npm | 159 | 159 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| jhipster-vue | npm | 346 | 346 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| socketio | npm | 90 | 90 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| voting-result | npm | 22 | 22 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| directus | npm | 562 | 562 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| prettier | yarn | 154 | 154 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| hyper | yarn | 275 | 275 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| docusaurus | yarn | 428 | 428 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| storybook | yarn | 711 | 711 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| babel | yarn | 177 | 177 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| material-ui | yarn | 380 | 380 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| vuecore | pnpm | 152 | 152 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| vite | pnpm | 194 | 194 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| svelte-kit | pnpm | 155 | 155 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| shadcn-ui | pnpm | 213 | 213 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| tanstack-query | pnpm | 646 | 646 | 0 | 0 | 100.0% | 100.0% | 0 (0) |
| vitesse | pnpm | 213 | 213 | 0 | 0 | 100.0% | 100.0% | 0 (0) |

