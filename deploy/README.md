# Hosting this page for your users

Everything below starts from a built `dist/`:

```
npm install
npm run build
```

The result is plain files. There is no server-side code, no database, no key on the host. Choose one
of the four ways below.

Before anything else, decide about the node. If you run `monerod`, put `deploy/xmr-proxy.conf` in front
of it; the page needs CORS and the wallet's binary paths. If you would rather not run a node, leave the
choice to the page: it lists public community nodes and picks the fastest one that answers well. The page
still works, but it depends on those nodes being up and allowing this page's origin. For a proxy of your own, with or without a public
fallback, see `own-node.md` in this directory.

## 1. nginx (recommended)

Copy `dist/` to the host and use `deploy/nginx.conf` as the server block. Then check the headers:

```
curl -sI https://recovery.example.com/ | grep -i -e content-security -e cross-origin
```

You should see the `content-security-policy` line and `cross-origin-opener-policy: same-origin`. Open
the page: the first status line must go green.

## 2. Cloudflare Pages

1. Create a Pages project.
2. Upload `dist/` (`npx wrangler pages deploy dist --project-name <name>`), or connect a repository and
   set the build command to `npm run build` and the output directory to `dist`.
3. `dist/_headers` (copied from `deploy/_headers` by the build) sets the CSP, COOP and caching.
4. Verify with the same `curl -sI` check.

A preview deployment and the production one have different host names. Both are fine: the node is
chosen by the visitor, not by the host.

## 3. GitHub Pages

Pages cannot set response headers, so the page runs without its CSP header. It works; a host that
sets headers is better.

1. Publish `dist/` to the `gh-pages` branch, or use a workflow with `actions/upload-pages-artifact`.
2. Enable Pages for that branch, and enforce HTTPS.
3. Open the page: the first status line goes green.

A project page under `/<repo>/` works: every path in the page is relative.

## 4. IPFS

```
ipfs add -r dist
```

Pin the resulting directory CID and publish it. A CID cannot be edited, which is the strongest promise
this page can make about itself: the bytes that handle a spend key are the bytes that were reviewed.

- Gateways differ in what they allow. Use one that serves the page over HTTPS; like GitHub Pages, it
  sends no CSP header.
- Publish the CID through DNSLink if you want a stable name.
- Keep the CID for the exact build next to its `build.json` hashes.

## Verifying a deployment

1. `build.json` is served and its hashes match the files.
2. The first status line is green (the wallet, the worker and the SDK core).
3. The node rows turn green or red by themselves, the chosen row is the node you expect, and the log
   reports its height and network.
   A `stagenet` node and a `mainnet` recovery file do not match; the page says so before anything is
   signed.
4. A recovery file from a real deal opens, and the page says what the money is doing: ready, not yet, or
   nothing there.
5. Only then does a real withdrawal make sense.

## Things not to do

- Do not add scripts, fonts or analytics from another host to this page. Its fonts ship in
  `assets/fonts/`, with their licences.
- Do not serve it over plain HTTP (except on `localhost`): workers and the browser's crypto require a
  secure context.
- Do not paste a node address with credentials into the field; the page refuses it on purpose.
