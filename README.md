# NinseiSwap sweep

A static page that moves XMR out of a swap wallet. A person opens it in a browser, supplies the
recovery file and its password, and the page rebuilds the wallet **in the tab**, syncs it against a
Monero node, and sends a transfer to an address the person types. Keys and the password never leave
the tab; the page has no server of its own.

This repository is the reference implementation. An operator can serve it from their own host and
point it at their own Monero node, with no dependency on us.

## Why the page exists

A swap wallet is opened with two halves of a spend key: one half in the deal, one half in the recovery
file. As long as the service is running, the service's node holds the wallet. This page is the way out
when it is not: it combines the halves, verifies the sum against the address (`(s_a + s_b)·G`), builds
and signs the transfer locally, and only then puts the signed transaction on the wire.

That is also why the page must be hostable anywhere. A recovery page that only works while our domain
answers is not a recovery page.

## What a node must do

The page speaks to a Monero node through the wallet's own paths:

| Path | Purpose |
|---|---|
| `/json_rpc` | `get_info`, fee estimate, hard fork info |
| `/getblocks.bin` | blocks with transactions (the main sync channel) |
| `/gethashes.bin` | block hashes |
| `/get_blocks.bin` | the same range in another shape |

Two conditions apply in a browser:

1. **CORS** - the node (or a proxy in front of it) must allow the page's origin.
2. **Cross-origin isolation** - the document must be served with `Cross-Origin-Opener-Policy:
   same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, because the wallet uses
   `SharedArrayBuffer`. A CORS-passing answer also passes `require-corp`.

The node address is a field on the page. It defaults to a public community node, can be given in the link
(`?node=https://node.example`), and is remembered for the tab. A node of your own behind an HTTPS
proxy is enough; `deploy/xmr-proxy.conf` shows the CORS part.

## Build

Bun 1.4 or newer. There is no Node step: the build is esbuild plus file operations, and Bun runs both
the build and the checks.

```
bun install
bun run build
```

`dist/` is the result: HTML, CSS, the page's JavaScript, the locale files, the wallet worker, two
bundles and `build.json` with the version, the commit and a SHA-256 of every file. Nothing in `dist/`
needs a build step on the host and nothing there is fetched from a CDN.

The bundles are built from **exact** versions of `monero-ts` and `@ninsei-labs/sdk` (see
`package.json`); the versions are not ranges on purpose - a page that handles spend keys should change
only when someone changes it.

`bun run serve` serves `dist/` with the two isolation headers, for looking at a change locally.

## Hosting

| Host | Headers | Notes |
|---|---|---|
| **Your nginx** | yes | `deploy/nginx.conf`. Best option: nothing between the page and the browser. |
| **Cloudflare Pages** | yes | Upload `dist/`; `_headers` in the same folder sets COOP/COEP and the CSP. |
| **GitHub Pages** | no | The page's service worker adds the headers and reloads once. Works, but it is a fallback. |
| **IPFS** | no | Same worker fallback. Content addressing is a real gain for a page that handles keys: a CID cannot be edited. Pin the directory and publish the CID. |

A page served from a subdirectory works too: every path in the page is relative.

**A single HTML file cannot run the wallet.** Isolation comes from response headers, and a service
worker - the only workaround - must be a separate file of the same origin. One file is possible only
with a wallet build that does not use threads, which this page does not ship.

HTTPS is required in every case except `localhost`: `SharedArrayBuffer` and service workers exist
only in a secure context.

## Docker

```
docker build -t ninsei-sweep .
docker run --rm -p 8080:8080 ninsei-sweep
```

The image is built in two stages: Bun installs the locked dependencies and runs the checks, then the
built `dist/` is served by Bun from `serve.bun.mjs`. The server is one file with no dependencies, and
it sets the isolation headers itself - that is the part a generic static server gets wrong. Running as
UID 10001, `TZ=UTC`, and a health check that fetches `index.html` over HTTP and looks for the page's own marker.

The container speaks **HTTP**. Terminate TLS in front of it and make sure the reverse proxy passes
`Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` through untouched; without them the
wallet cannot start.

## Releases

A tag makes a release:

```
git tag v0.1.0
git push origin v0.1.0
```

The `release` workflow takes the version from the tag, installs the locked dependencies, runs the
checks, and attaches one archive to a GitHub release: the contents of `dist/`, plus a `.sha256`.
Nothing is published to npm - the page is not a library. GitHub Pages is not wired yet; when it is,
it will consume the same `dist/` directory.

To verify an archive before serving it, compare every file with `build.json` inside it, or check the
archive itself against the published `.sha256`.

## Security notes

- **The keys stay in the tab.** The page sends the node only what a wallet sends a node: height,
  block requests, the signed transaction. It never sends the recovery file, the password, the spend
  key or a seed.
- **The file is decrypted in the browser**, with the same code path the SDK uses; the page does not
  carry a second implementation of the format.
- **Verify what you serve.** `dist/build.json` lists a SHA-256 for every file, and a release archive
  should be checked against it. On IPFS the CID is the check.
- **A compromised host is a compromised page.** This page handles spend keys, so serve it from a host
  you control, or from IPFS with a pinned CID, and do not add third-party scripts to it.
- **Node trust.** A node sees which blocks a wallet scans and which transaction it relays. It cannot
  spend the funds and it never sees the key. If that is not acceptable, run the node yourself.

## Adding a language

One folder: `locales/<tag>/index.js`, same shape as `locales/en/index.js`. The build reads the folders
and writes the list; nothing else is edited.

## Licence

MIT. See `LICENSE`.
