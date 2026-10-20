# Plan evaluation

Unit for the npm audit columns: unique (package|advisory) pairs from `npm audit --package-lock-only --json`. "Claim" = the "clears N of M" estimate printed for the safe step; "really closed" = patchpath units (name@version|id) that a patchpath re-scan no longer reports after the safe step. Both are patchpath advisory units and are not directly comparable to the npm audit columns. In brackets: change against "before".

| project | before (npm audit) | claim (clears N of M) | really closed (patchpath re-scan) | npm audit after patchpath safe step | npm audit after `npm audit fix` | separate commands with exit 0 | npm audit after safe + all separate commands |
|---|---:|---:|---:|---:|---:|---:|---:|
| typescript | 49 | 60/65 | 61 | 5 (-44) | 13 (-36) | 3/3 (ERESOLVE 1) | 4 |
| socketio | 77 | 73/90 | 75 | 23 (-54) | 21 (-56) | 7/7 | 16 |
| gatsby-blog | 130 | 116/143 | 116 | 25 (-105) | 28 (-102) | 0/0 | - |
| nextjs-blog | 132 | 108/159 | 131 | 46 (-86) | 50 (-82) | 12/13 (ERESOLVE 1) | 37 |
| vscode | 150 | 135/211 | 138 | 73 (-77) | 87 (-63) | 11/11 | 29 |
| bookshelf | 179 | 143/228 | 188 | 86 (-93) | 179 (+0) | 3/3 | 84 |
| parse-server | 182 | 127/227 | 181 | 89 (-93) | 182 (+0) | 6/6 | 84 |
| nodegoat | 197 | 91/320 | 104 | 162 (-35) | 197 (+0) | 9/9 | 134 |
| chartjs | 210 | 159/240 | 195 | 66 (-144) | 71 (-139) | 3/3 (ERESOLVE 1) | 66 |
| nightscout | 214 | 150/298 | 197 | 120 (-94) | 115 (-99) | 13/13 (ERESOLVE 1) | 108 |

Totals over 10 projects: before 1520; after patchpath safe step 695; after `npm audit fix` 943; after safe step + all separate commands 587.

Safe step better than `npm audit fix` in 8 projects, worse in 2, equal in 0.

Claim: sum of claimed 1162, sum really closed 1386; really closed >= claimed in 10 of 10 projects.

Separate commands: 67 of 68 exited 0 (4 with ERESOLVE).
