# Dependency license policy

The recovery page is a static MIT project. Its `package.json` has no production dependencies because every
library it needs at run time is a devDependency bundled into `dist/` by esbuild. The licence check therefore reads
the installed Bun tree, not only `dependencies`.

## Allowed licences

A shipped package may use one of:

- MIT
- MIT-0
- ISC
- Apache-2.0
- BSD-2-Clause
- BSD-3-Clause
- Unlicense
- 0BSD
- CC0-1.0
- BlueOak-1.0.0

SPDX expressions are read as written: `MIT OR Apache-2.0` is allowed when one branch is allowed, `MIT AND
BSD-3-Clause` when every branch is. `WITH` exceptions keep the base licence's decision. `SEE LICENSE IN ...`,
`UNLICENSED`, `UNKNOWN` and every licence outside the list are refused.

## What is excluded, and why

`build/build.mjs` replaces the Node built-ins below with a stub that throws when a browser path reaches it. They
are never in `dist/`, so they are not shipped packages:

`tls`, `net`, `child_process`, `worker_threads`, `perf_hooks`, `ws`, `socks-proxy-agent`.

The optional `@esbuild/*-x64` native binaries are build tools, not page code, and their platform names differ
between a local checkout and the Linux runner. They are excluded for the same reason: the notices must be the same
bytes on every platform.

`querystring-es3` ships a `License.md` but has no `license` field in its manifest. Its licence is recorded as MIT
from that file in `tools/licenses.mjs`; the text itself is included in the notices, so the decision is visible.

## How the checks run

`bun run check:licenses` scans every installed package and prints the licences it found. Any shipped package
outside the allowlist prints its name and exits non-zero.

`bun run notices` regenerates `THIRD_PARTY_NOTICES.txt` from the same tree, including every licence file the
packages ship. A package that declares a licence but ships no file is named as such; the generator does not invent
a copyright holder. The file is copied into `dist/` and into the release archive.

`bun run check:notices` compares the committed file with the tree; a dependency change that edits `bun.lock` but not
the notices fails. The **License Compliance** workflow runs both checks on every pull request and push to `main`;
the release workflow runs them again before it builds the archive.
