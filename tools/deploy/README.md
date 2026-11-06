# Deploy tool

`wrangler` is the Cloudflare Pages CLI used by the release workflow. It is **not** part of the page: nothing under
this directory is bundled into `dist/` or served to a visitor.

It has its own manifest and `bun.lock` so the release installs one exact dependency tree instead of letting `bunx`
resolve Wrangler's dependencies at deploy time, while the Cloudflare token is in the environment.

Run it from the repository root after installing here:

```bash
(cd tools/deploy && bun install --frozen-lockfile)
bun tools/deploy/node_modules/wrangler/bin/wrangler.js --version
```

The release workflow runs this install step and then uses that binary for `wrangler pages ...`. The version is checked
again at install time, so a lock-file change cannot silently deploy with another Wrangler.
