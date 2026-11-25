# Ninsei recovery page

A static page that moves XMR out of a swap wallet and settles the ETH side. A person opens it in a browser and enters their Ninsei key:
the twelve words, or the key file the swap widget saved
(`ninsei-recovery-key-DO-NOT-DELETE-<date>-<fingerprint>.txt`, optionally with a password). The page finds the
swaps the key made on the settlement chain, lists each with what it needs, and for a swap whose XMR can be taken
it rebuilds the wallet **in the tab**, syncs it against a Monero node, and sends a transfer to an address the
person types. When the ETH side is the remaining action, it asks the person's own browser wallet to sign one
refund or claim. The key, its password and the wallet keys never leave the tab; the page has no server of its own.

The Ninsei key is not a wallet seed and is never imported into a wallet. The SDK calls it the recovery key, and
its file keeps that name and its first line, `NINSEI RECOVERY KEY`, which is what people search for on disk.
The per-swap recovery file of earlier builds is no longer read.

This repository is the reference implementation. An operator can serve it from their own host and
list their own Monero node in it, with no dependency on us.

## Why the page exists

A swap wallet is opened with two halves of a spend key: the person's half, derived from the Ninsei key and
the swap's number, and the maker's half, which the maker publishes on the settlement chain when it takes the ETH
(a buy) or takes its ETH back (a failed sell). As long as the person's browser keeps the swap, the widget holds
the wallet. This page is the way out when it does not: it finds the swap's order by the key's commitments,
reads the maker's half from the escrow, combines the halves, verifies the sum against the address
(`(s_a + s_b)·G`), builds and signs the transfer locally, and only then puts the signed transaction on the wire.

What the page reads for a swap, and where:

| What                   | From                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the swaps of a key     | every known factory's `OrderCreated` logs, each from its deployment block, matched against the key's commitments in the tab (`findSwaps`)               |
| the swap's state       | `HalfRevealed`, `Ready` and `Declined` events, read for all found escrows in one request; the deadline comes from the order                             |
| the swap's date        | the time of the block that holds the order                                                                                                              |
| the Monero start block | the last Monero block at or before that time, minus 60: the SDK's rule in `findSwaps`, with the node's tip and headers read by the page (`lib/node.js`) |
| the maker's half       | the escrow's `revealedHalf()`, read by the SDK's `sweep.plan`                                                                                           |
| the blocks to scan     | from the start block (`sweep.restore`), scanned in full; a scan that does not finish is reported as incomplete, not as "nothing arrived"                |

The SDK's withdrawal (`sweep.plan`, `keys`, `sign`, `relay`) takes a per-swap payload. The page asks
`sweep.fromOrder` for that payload: the SDK takes the key and the found order, checks the points, builds the joint
address and returns the file the withdrawal accepts. The page keeps no payload rule of its own.

`sign` also needs the verified unspent key images of the outputs it may spend. The page reads its own node with
`swaps.readRecovery`, derives the images with `sweep.keyImages` from the verified funding outputs, and keeps the
wallet only as the unspent filter. It rereads that set, resuming from the SDK checkpoint, immediately before
`relay`; the SDK refuses a signature or a send whose inputs are not exactly that set. The `restore` and the
`sign` use the same wallet adapter, because the scan verdict belongs to that adapter.

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

The page lists public community nodes that pass CORS in a browser, and uses no other node: the page
holds the twelve words, so no link and no field can point it elsewhere. It opens on the first listed node
without probing any node; when a search begins or a person chooses a row, that node is asked for
`get_info`, and a row shows its state and round trip once checked. Those requests tell a listed node
only that a visitor asked for its height. A person can pick another row, and that choice is remembered
for the tab. Once a wallet exists the choice is locked until the wallet is forgotten.

To use a node of your own, serve your own copy of the page with that node in `NODES` in `lib/node.js`,
and build it: the page's policy is built from that list, so the browser lets the page reach your node and no
other host (see Hosting). A node behind an HTTPS proxy is enough; `deploy/xmr-proxy.conf` has the block and
`deploy/own-node.md` walks through the setup, including a public fallback and the exact headers.

## Build

Bun 1.4.5 or newer. There is no Node step: the build is esbuild plus file operations, and Bun runs both
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

`bun run test:page` runs the built page whole, with the SDK it ships, against a wallet, a Monero node and a settlement
chain that are the test's, and holds each of its waits open while a person does something newer. It takes about three minutes
and runs after `bun run build`; CI runs it once for each commit, and `bun run test` does not include it.

`bun run test:browser` opens the built page in Chrome (`CHROME_BIN`, or `google-chrome` or `chromium` on PATH),
served the same way and again by a host that sends no headers, where only the meta tag holds the policy: each time
the page must start under its policy, and the policy must refuse every host the page does not list while letting
the listed ones through. CI runs it after the build; it is not part of `bun run test`, which needs
no browser.

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
| **GitHub Pages**     | no      | The page works, with its policy from the meta tag in each page. A host that sets headers is better.                                                                        |
| **IPFS**             | no      | Works the same way, under its meta-tag CSP. Content addressing is a real gain for a page that handles keys: a CID cannot be edited. Pin the directory and publish the CID. |

A page served from a subdirectory works too: every path in the page is relative.

**The policy names every host the page calls.** Its `connect-src` is this origin, the listed Monero nodes
(`lib/node.js`) and the settlement RPCs (`lib/settlement.js`), built from those two lists by
`deploy/http-policy.mjs`. The build writes it into `dist/_headers` and the Bun servers send it. Nginx cannot
read a module: after a change to either list, copy the `Content-Security-Policy` line from the built
`dist/_headers` into `deploy/nginx.conf`; `bun run test` fails until the two agree.

The build also writes the policy into both pages as a `<meta http-equiv="Content-Security-Policy">` tag, so a
host that sends no headers still enforces `connect-src` in the page. A meta tag cannot carry `frame-ancestors`,
and it does not reach the wallet's worker, which takes its policy from its own response: a host that sends the
header is still the better one.

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

On a `v*` tag the release workflow also publishes the image:

```
ghcr.io/ninsei-labs/recovery-page:<tag>
ghcr.io/ninsei-labs/recovery-page:latest
```

The package is private by default. Pull it with a GitHub token that has `read:packages`:

```
echo "$GHCR_TOKEN" | docker login ghcr.io -u USERNAME --password-stdin
docker pull ghcr.io/ninsei-labs/recovery-page:<tag>
```

## Releases

A tag makes a release:

```
git tag v0.1.0
git push origin v0.1.0
```

The tag must point at a commit on `main` whose `build` run, on the push to `main`, passed: the
`release` workflow refuses any other before it builds anything, after waiting at most 20 minutes for
a `build` run still going. It then takes the version from the tag, installs the locked dependencies,
runs the checks, and attaches one archive to a GitHub release: the contents of `dist/`, plus a
`.sha256`. Nothing is published to npm - the page is not a library.

The workflow has six jobs with different access: `build` has `contents: read`, no write token and
no Cloudflare secret; `image` has `packages: write` and publishes the container image to GHCR under its
own tag; `latest` has `packages: write` and points `latest` at it;
`publish` has `contents: write` and only attaches the verified archive, after the image exists;
`deploy` has `contents: read` and uploads the same built `dist/` to Cloudflare Pages; `promotions` has no
access and says what moved. The deploy job
uses the protected `recovery-deploy` environment, which is where the required reviewers and the
`CLOUDFLARE_API_TOKEN` (Cloudflare Pages: Edit) and `CLOUDFLARE_ACCOUNT_ID` environment secrets
belong. A missing Cloudflare token leaves the archive published and skips the deploy, as before.

Only the newest tag on `main` moves the image's `latest` and the production page, one release at a time, and the
tags are read again at the moment of the move. An older tag that is dispatched, run again or approved late finishes
its own image tag, archive and release, and nothing else; going back to an older page is a manual act outside the
workflow. Nothing that is published is replaced: a missing checksum is made from the published archive, and an
archive that must be replaced is deleted from the release by hand first. All this holds for runs of the current
workflow: a run that began from an older commit, run again, keeps that commit's workflow.

One job of each kind runs and one waits. A third that arrives takes the place of the waiting one, whose job is then
cancelled and moves nothing. The run says so itself: its name carries the tag, and its last job, `promotions`, is red
and names the cancelled turn. If that tag is the newest on `main`, start the cancelled job of that run again; if not,
nothing is missing. A run that waits for the approval of its deploy is in the list with its tag.

To verify an archive before serving it, compare every file with `build.json` inside it, or check the
archive itself against the published `.sha256`.

## Security notes

- **The keys stay in the tab.** The page sends the node only what a wallet sends a node: height,
  block headers and blocks, the signed transaction. It never sends the Ninsei key, its password, a half or
  a spend key. The words are cleared from the field once read, never logged and never stored.
- **The settlement chain is read, and written only when the person asks.** The search sends a public RPC the
  factory, the `OrderCreated` topic and a block range, never the key or a commitment; the swap's state comes from
  one bulk `eth_getLogs` over the found escrows, and the maker's half is an `eth_call` (`sweep.plan`) only for
  the swap the person opens. The page holds no EVM key: a refund or claim is one transaction signed by the
  person's own browser wallet, through the SDK. A wallet that does not know the network is offered it with the public
  RPCs of `lib/settlement.js`; one that stays on another network gets no transaction. The person's half is in no
  request before the transaction the person confirmed, and "Refunded" or "Claimed" stands only after its receipt. One
  order has one submission at a time while the page is open, from the moment the wallet is handed the transaction: no
  second one is offered while it is asked or while the transaction has no receipt. Until then nothing holds the order,
  and another key entered ends the step. A receipt is asked only of the order's network: a wallet that moved is told where
  it must be. What the chain's events show is newer than a receipt, and a row they contradict says so. A network the SDK names a live factory for, but which this page cannot read, is said,
  not skipped.
- **A missing answer is unknown.** A swap whose state could not be read is shown as unknown, a network that did
  not answer makes the list say it is incomplete, and a start block the chain does not give is asked for.
- **Confirm sends the transfer on the screen, or nothing.** A changed address, another withdrawal, another swap, or words
  or a file of another key end a transfer at once, while it is built, shown, and while Confirm reads the node again; from
  the moment the node is given it until its answer, or four minutes without one, nothing newer can be started. Each press
  of Confirm leaves one result on the page: not sent with why, submitting, sent with its transaction, or may have been
  sent. An answer that comes late ends its own result; a success that comes late also closes its swap, if that is still
  the one that is open, and lets its key go. The list is kept only while the page stays open: a reload clears it.
- **A swap that is left keeps no key.** Its wallet, its signed sessions and its keys go with it.
- **No text of a wallet, a node or an RPC is shown or copied.** A failure is named by the page's own words, a code and
  fields that are a number, a name of at most 40 characters or an EVM address (`lib/reason.js`): a message may quote what
  it was given, in any language, and no filter can tell. A file that could not be read keeps its refusal, and Find does
  not fall back to an earlier key, until another file or words are entered.
- **Verify what you serve.** `dist/build.json` lists a SHA-256 for every file, and a release archive
  should be checked against it. On IPFS the CID is the check.
- **The page reaches only the hosts it lists.** Its `connect-src` names this origin, the listed nodes and the
  settlement RPCs, and nothing else, so even a script injected into the page cannot send the words to another
  host. A host that sends no header (GitHub Pages, IPFS gateways) keeps it in the page through the meta tag the
  build writes; there only the wallet's worker and the frame rule go without it.
- **A compromised host is a compromised page.** This page handles spend keys, so serve it from a host
  you control, or from IPFS with a pinned CID, and do not add third-party scripts to it.
- **Node trust.** A node sees which blocks a wallet scans and which transaction it relays. It cannot
  spend the funds and it never sees the key. If that is not acceptable, run the node yourself and serve a
  copy of the page that lists it.

## Adding a language

One folder: `locales/<tag>/index.js`, same shape as `locales/en/index.js`. The build reads the folders
and writes the list; nothing else is edited.

## Licence

MIT. See `LICENSE`. The licences of the packages bundled into the page are in
`THIRD_PARTY_NOTICES.txt`; the dependency policy is in `LICENSE-POLICY.md`. Both notices and the project
licence are copied into `dist/` and into the release archive.
