# Ninsei recovery page

A static page that moves XMR out of a swap wallet. A person opens it in a browser and enters their Ninsei key:
the twelve words, or the key file the swap widget saved
(`ninsei-recovery-key-DO-NOT-DELETE-<date>-<fingerprint>.txt`, optionally with a password). The page finds the
swaps the key made on the settlement chain, lists each with what it needs, and for a swap whose XMR can be taken
it rebuilds the wallet **in the tab**, syncs it against a Monero node, and sends a transfer to an address the
person types. The key, its password and the wallet keys never leave the tab; the page has no server of its own.

The Ninsei key is not a wallet seed and is never imported into a wallet. The SDK calls it the recovery key, and
its file keeps that name and its first line, `NINSEI RECOVERY KEY`, which is what people search for on disk.
The per-swap recovery file of earlier builds is no longer read.

This repository is the reference implementation. An operator can serve it from their own host and
point it at their own Monero node, with no dependency on us.

## Why the page exists

A swap wallet is opened with two halves of a spend key: the person's half, derived from the Ninsei key and
the swap's number, and the maker's half, which the maker publishes on the settlement chain when it takes the ETH
(a buy) or takes its ETH back (a failed sell). As long as the person's browser keeps the swap, the widget holds
the wallet. This page is the way out when it does not: it finds the swap's order by the key's commitments,
reads the maker's half from the escrow, combines the halves, verifies the sum against the address
(`(s_a + s_b)·G`), builds and signs the transfer locally, and only then puts the signed transaction on the wire.

What the page reads for a swap, and where:

| What                   | From                                                                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the swaps of a key     | the factory's `OrderCreated` logs, matched against the key's commitments in the tab (`findSwaps`)                                                                                   |
| the swap's state       | the escrow's `status()`: claimed, refunded or open, and its deadline from the order                                                                                                 |
| the swap's date        | the time of the block that holds the order                                                                                                                                          |
| the Monero start block | the last Monero block at or before that time, minus 60: the SDK's rule in `findSwaps`, with the node's tip and headers read by the page (`lib/node.js`)                             |
| the maker's half       | the escrow's `revealedHalf()`, read by the SDK's `sweep.plan`                                                                                                                       |
| the blocks to scan     | from the start block to the block at the order's deadline plus ten (`lib/window.js`), scanned by the SDK's `sweep.restore({ window })`; an empty window falls back to the full scan |

The SDK's withdrawal (`sweep.plan`, `keys`, `sign`, `relay`) takes a per-swap payload. The page asks
`sweep.fromOrder` for that payload: the SDK takes the key and the found order, checks the points, builds the joint
address and returns the file the withdrawal accepts. The page keeps no payload rule of its own.

That is also why the page must be hostable anywhere. A recovery page that only works while our domain
answers is not a recovery page.

## What a node must do

The page speaks to a Monero node through the wallet's own paths. A scan on stagenet called these:

| Path                               | Purpose                                                               |
| ---------------------------------- | --------------------------------------------------------------------- |
| `/json_rpc`                        | `get_info`, chain height, fee estimate                                |
| `/gethashes.bin`                   | the chain's block hashes up to the start block, most of a scan's time |
| `/getblocks.bin`                   | block bodies from the start block on                                  |
| `/get_transaction_pool_hashes.bin` | transactions not yet in a block                                       |

The transfer adds paths of its own, so a node for this page runs with `--restricted-rpc` and its proxy
passes every path (`deploy/own-node.md`).

Two conditions apply in a browser:

1. **CORS** - the node (or a proxy in front of it) must allow the page's origin.
2. **Cross-origin isolation is not required.** The wallet does not use `SharedArrayBuffer`. When the host does
   send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, the page
   reports it in the diagnostics and nothing changes. A CORS-passing answer also passes `require-corp`.

The page lists public community nodes that pass CORS in a browser. When it opens, it asks each of
them for `get_info` and picks the fastest one that is on mainnet, synchronized and within three blocks
of the median answer; each row shows its state and round trip. That request tells a listed node only
that a visitor asked for its height. A person can pick another row or enter their own node, a link can
name one (`?node=https://node.example`), and a person's choice is remembered for the tab. Once a wallet
exists the choice is locked until the wallet is forgotten. A node of your own behind an HTTPS
proxy is enough; `deploy/xmr-proxy.conf` has the block and `deploy/own-node.md` walks through the setup,
including a public fallback and the exact headers.

## Build

Bun 1.4.4 or newer. There is no Node step: the build is esbuild plus file operations, and Bun runs both
the build and the checks.

```
bun install
bun run build
```

`dist/` is the result: HTML, CSS, the fonts with their licences, the page's JavaScript, the locale
files, the wallet worker, two bundles and `build.json` with the version, the commit and a SHA-256 of every file. Nothing in `dist/`
needs a build step on the host and nothing there is fetched from a CDN.

The bundles are built from **exact** versions of `monero-ts` and `@ninsei-labs/sdk` (see
`package.json`); the versions are not ranges on purpose - a page that handles spend keys should change
only when someone changes it.

`bun run serve` serves `dist/` with the page's headers, for looking at a change locally.

## Formatting and the pre-commit hook

The tree uses Bun's built-in formatter, configured in `bunfig.toml`. Install the tracked hook once per clone:

```
bun run hooks:install
```

Every commit formats the staged files with `bun fmt --staged`, rebuilds `dist/`, runs `bun run test`, and
stages the rebuilt page. `bun run fmt` formats the whole tree and `bun run fmt:check` verifies it without writing.

## Hosting

| Host                 | Headers | Notes                                                                                                                                                                      |
| -------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Your nginx**       | yes     | `deploy/nginx.conf`. Best option: nothing between the page and the browser.                                                                                                |
| **Cloudflare Pages** | yes     | Upload `dist/`; `_headers` in the same folder sets the CSP and caching.                                                                                                    |
| **GitHub Pages**     | no      | The page works, without the CSP header. A host that sets headers is better.                                                                                                |
| **IPFS**             | no      | Works the same way, without the CSP header. Content addressing is a real gain for a page that handles keys: a CID cannot be edited. Pin the directory and publish the CID. |

A page served from a subdirectory works too: every path in the page is relative.

**The page is a folder, not one file.** The wallet's worker and the two bundles are separate files of
the same origin.

HTTPS is required in every case except `localhost`: workers and the browser's crypto, which decrypts
the Ninsei key file, exist only in a secure context.

## Docker

```
docker build -t ninsei-recovery .
docker run --rm -p 8080:8080 ninsei-recovery
```

The image is built in two stages: Bun installs the locked dependencies and runs the checks, then the
built `dist/` is served by Bun from `serve.bun.mjs`. The server is one file with no dependencies, and
it sets the CSP and the caching headers itself. Running as
UID 10001, `TZ=UTC`, and a health check that fetches `index.html` over HTTP and looks for the page's own marker.

The container speaks **HTTP**. Terminate TLS in front of it and make sure the reverse proxy passes the
`Content-Security-Policy` through untouched.

## Releases

A tag makes a release:

```
git tag v0.1.0
git push origin v0.1.0
```

The `release` workflow takes the version from the tag, installs the locked dependencies, runs the
checks, and attaches one archive to a GitHub release: the contents of `dist/`, plus a `.sha256`.
Nothing is published to npm - the page is not a library. The same run then deploys that `dist/` to
Cloudflare Pages (project `ninsei-recovery`), which serves it at `https://recovery.ninsei.finance`;
it needs the repository secrets `CLOUDFLARE_API_TOKEN` (Cloudflare Pages: Edit) and
`CLOUDFLARE_ACCOUNT_ID`.

To verify an archive before serving it, compare every file with `build.json` inside it, or check the
archive itself against the published `.sha256`.

## Security notes

- **The keys stay in the tab.** The page sends the node only what a wallet sends a node: height,
  block headers and blocks, the signed transaction. It never sends the Ninsei key, its password, a half or
  a spend key. The words are cleared from the field once read, never logged and never stored.
- **The settlement chain is read, never written.** The search sends a public RPC the factory, the
  `OrderCreated` topic and a block range, never the key or a commitment; the swap's state and the maker's
  half are `eth_call`s on the escrow (`lib/settlement.js`). The page holds no EVM key and sends no EVM
  transaction. A network the SDK names a live factory for, but which this page cannot read, is said, not
  skipped.
- **A missing answer is unknown.** A swap whose state could not be read is shown as unknown, a network that did
  not answer makes the list say it is incomplete, and a start block the chain does not give is asked for.
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
