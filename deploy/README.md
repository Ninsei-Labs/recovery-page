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
field at its default, which points at a public community node - the page still works, but it depends on
that node being up and allowing this page's origin. For a proxy of your own, with or without a public
fallback, see `own-node.md` in this directory.

## 1. nginx (recommended)

Copy `dist/` to the host and use `deploy/nginx.conf` as the server block. Then check the headers:

```
curl -sI https://sweep.example.com/ | grep -i cross-origin
```

You should see `cross-origin-opener-policy: same-origin` and
`cross-origin-embedder-policy: require-corp`. Open the page: the first status line must go green
without a reload. If it complains about isolation, the headers are missing - that is the whole
diagnosis.

## 2. Cloudflare Pages

1. Create a Pages project.
2. Upload `dist/` (`npx wrangler pages deploy dist --project-name <name>`), or connect a repository and
   set the build command to `npm run build` and the output directory to `dist`.
3. `dist/_headers` (copied from `deploy/_headers` by the build) sets COOP/COEP, the CSP and caching.
4. Verify with the same `curl -sI` check.

A preview deployment and the production one have different host names. Both are fine: the node is
chosen by the visitor, not by the host.

## 3. GitHub Pages

Pages cannot set response headers, so the page uses its own service worker to add them.

1. Publish `dist/` to the `gh-pages` branch, or use a workflow with `actions/upload-pages-artifact`.
2. Enable Pages for that branch, and enforce HTTPS.
3. Open the page. The first load is **not** isolated: the worker registers and the page reloads once.
   The second load is isolated and the status line goes green. This reload is expected, not a bug.
4. If the status still reports missing isolation after the reload, the browser is not running the
   worker (a gateway or an extension stripped it, or the page is not on HTTPS). Use another host.

A project page under `/<repo>/` works: every path in the page is relative.

## 4. IPFS

```
ipfs add -r dist
```

Pin the resulting directory CID and publish it. A CID cannot be edited, which is the strongest promise
this page can make about itself: the bytes that handle a spend key are the bytes that were reviewed.

- Gateways differ in what they allow. A gateway that serves the page over HTTPS and lets the service
  worker register covers the header problem the same way GitHub Pages does (one reload).
- Publish the CID through DNSLink if you want a stable name.
- Keep the CID for the exact build next to its `build.json` hashes.

## Verifying a deployment

1. `build.json` is served and its hashes match the files.
2. The first status line is green (isolation and bundles).
3. The node field shows the address you expect, and "check the node" reports a height and a network.
   A `stagenet` node and a `mainnet` recovery file do not match; the page says so before anything is
   signed.
4. A recovery file from a real deal decrypts and the promised address is shown.
5. Only then does a real withdrawal make sense.

## Things not to do

- Do not add third-party scripts, fonts or analytics to this page.
- Do not serve it over plain HTTP (except on `localhost`): `SharedArrayBuffer` and workers require a
  secure context.
- Do not paste a node address with credentials into the field; the page refuses it on purpose.
