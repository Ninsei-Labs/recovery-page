// THE BUILD: sources live in the repository root, everything a browser loads is written to `dist/`.
//
// WHY TWO ARTEFACTS AND NOT ONE. The page is static, and an operator must be able to serve it from an
// nginx of their own, from GitHub Pages, from Cloudflare Pages or from IPFS without running Node. So
// the build produces a directory of files (`dist/`) that is uploaded as it is - no server runtime, no
// package manager on the host.
//
// WHAT IS BUILT AND WHAT IS COPIED:
//   * monero-ts and the wallet worker - bundled from the pinned package, because both are CommonJS
//     with Node built-ins and do not run in a browser as published;
//   * the SDK core - bundled from the pinned @ninsei-labs/sdk, so the page's rules (plan, keys,
//     sign, relay) come from the package and not from a second copy inside this repository;
//   * the page itself (HTML, CSS, JS, locales, fonts, the service worker) - copied as written.
//
// THE STAMPED HASH in `?v=` is the content hash of the file it names. It is not a cache trick for its
// own sake: an operator who replaces `dist/` must not have a returning visitor run the old bundle
// against the new page. The hash is computed here, never typed by hand.
//
// THIS SCRIPT IS THE WHOLE PIPELINE. There is no second build, no watcher and no generated file that
// is committed: `dist/` is the output of this file and nothing else writes there.

import { build } from "esbuild";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DIST = join(ROOT, "dist");
const require = createRequire(import.meta.url);

const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));

// --- 1. Node modules the browser needs under their own names --------------------------------
// monero-ts was written for Node: `assert`, `path`, `fs`, `crypto`, `stream` and friends are
// resolved to browser implementations here. A few modules have no browser meaning at all
// (`net`, `tls`, `child_process`, ...): they are replaced with a stub that throws on first real use,
// which is honest - the code paths that reach them are the ones the page never takes.
const POLYFILLS = {
  assert: "assert/",
  path: "path-browserify",
  fs: "memfs",
  crypto: "crypto-browserify",
  stream: "stream-browserify",
  buffer: "buffer/",
  process: "process/browser.js",
  os: "os-browserify/browser",
  url: "url/",
  util: "util/",
  events: "events/",
  http: "stream-http",
  https: "https-browserify",
  querystring: "querystring-es3",
};

const STUBS = ["net", "tls", "child_process", "worker_threads", "perf_hooks", "ws", "socks-proxy-agent", "web-worker"];

const builtinNames = Object.keys(POLYFILLS).join("|");
const polyfillPlugin = {
  name: "recovery-polyfills",
  setup(b) {
    b.onResolve({ filter: new RegExp(`^(node:)?(${builtinNames})$`) }, (args) => ({
      path: require.resolve(POLYFILLS[args.path.replace(/^node:/, "")]),
    }));
    b.onResolve({ filter: /^process\/browser(\.js)?$/ }, () => ({ path: require.resolve("process/browser.js") }));
    b.onResolve({ filter: /^buffer\/?$/ }, () => ({ path: require.resolve("buffer/") }));
    for (const name of STUBS) {
      b.onResolve({ filter: new RegExp(`^(node:)?${name}$`) }, () => ({ path: name, namespace: "recovery-stub" }));
    }
    b.onLoad({ filter: /.*/, namespace: "recovery-stub" }, (args) => ({
      loader: "js",
      contents: `
        const fail = () => { throw new Error("node module '${args.path}' is not available in the browser"); };
        export default new Proxy(function () {}, { get: () => fail, apply: fail, construct: fail });
      `,
    }));
  },
};

const common = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  sourcemap: false,
  logLevel: "warning",
  define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
  inject: [join(HERE, "monero-shims.js")],
  plugins: [polyfillPlugin],
  // Two dynamic imports inside the SDK point at page artifacts, not at package files: the atomic
  // primitives and the WalletConnect bundle. They stay as written and resolve at run time against the
  // SDK bundle's own directory (`dist/assets/vendors/...`). The page builds the first; the second is
  // only reachable from EVM wallet code, which this page never calls.
  external: ["../../assets/vendors/atomic/*", "../../assets/vendors/walletconnect/*"],
};

// --- 2. Hash, stamp, report -----------------------------------------------------------------
const sha = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 8);
const size = (n) => (n / 1024 / 1024 >= 1 ? `${(n / 1048576).toFixed(2)} MB` : `${Math.round(n / 1024)} KB`);
const written = [];

async function emit(rel, bytes) {
  const path = join(DIST, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  const info = await stat(path);
  written.push({ file: rel, bytes: info.size, sha256: sha(bytes) });
  console.log(`  ${rel.padEnd(46)} ${size(info.size).padStart(8)}  ${sha(bytes)}`);
}

// --- 3. Clean -------------------------------------------------------------------------------
await rm(DIST, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
await mkdir(DIST, { recursive: true });
console.log(`building ${pkg.name} ${pkg.version} into dist/`);

// --- 4. The two bundles ---------------------------------------------------------------------
const MONERO_BUNDLE = "assets/vendors/monero/monero-ts-browser.js";
const SDK_BUNDLE = "assets/vendors/sdk/sdk-browser.js";

console.log("\nbundles:");
await build({
  ...common,
  entryPoints: [join(HERE, "monero-entry.mjs")],
  outfile: join(DIST, MONERO_BUNDLE),
  minify: true,
});
await build({
  ...common,
  // The entry names package subpaths only; the bundle is built from the INSTALLED package, which is
  // the copy named by an exact version in package.json.
  entryPoints: [join(ROOT, "sdk-entry.js")],
  outfile: join(DIST, SDK_BUNDLE),
  minify: true,
});

// The worker is not built: monero-ts ships it prebuilt, and it is the exact copy the library expects.
await build({
  ...common,
  entryPoints: [join(HERE, "atomic-entry.mjs")],
  outfile: join(DIST, "assets/vendors/atomic/atomic-browser.js"),
  minify: true,
});

const worker = await readFile(join(ROOT, "node_modules", "monero-ts", "dist", "monero.worker.js"));
await emit("monero.worker.js", worker);

const ATOMIC_BUNDLE = "assets/vendors/atomic/atomic-browser.js";
const moneroBytes = await readFile(join(DIST, MONERO_BUNDLE));
const sdkBytes = await readFile(join(DIST, SDK_BUNDLE));
const atomicBytes = await readFile(join(DIST, ATOMIC_BUNDLE));
await emit(MONERO_BUNDLE, moneroBytes);
await emit(SDK_BUNDLE, sdkBytes);
await emit(ATOMIC_BUNDLE, atomicBytes);

// --- 5. The page, copied and stamped --------------------------------------------------------
const STAMP = {
  __V_MONERO__: sha(moneroBytes),
  __V_WORKER__: sha(worker),
  __V_SDK__: sha(sdkBytes),
};

console.log("\npage:");
const PAGE_TEXT = ["recovery.js", "diagnostics.js"];
const PAGE_COPY = ["index.html", "recovery.css", "diagnostics.html", "favicon.svg", "coi.js", "sw.js", "lib/node.js", "lib/codes.js"];

// The locale list is derived from the folders, not edited by hand: a third language is one folder.
const localesDir = join(ROOT, "locales");
const tags = [];
for (const entry of await readdir(localesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  try {
    await stat(join(localesDir, entry.name, "index.js"));
    tags.push(entry.name);
  } catch {
    // A folder without index.js is not a language.
  }
}
tags.sort();
await emit(
  "locales/available.js",
  Buffer.from(
    "// GENERATED BY build/build.mjs: the page's language list, read from locales/<tag>/ folders.\n" +
      `export const AVAILABLE = ${JSON.stringify(tags)};\n`,
  ),
);
for (const tag of tags) {
  await emit(`locales/${tag}/index.js`, await readFile(join(localesDir, tag, "index.js")));
}
await emit("locales/index.js", await readFile(join(localesDir, "index.js")));

for (const rel of PAGE_COPY) {
  await emit(rel, await readFile(join(ROOT, rel)));
}
// The fonts and their licences are the folder's contents, like the languages: recovery.css names the
// files it loads, and every licence travels with its font.
const fontsDir = join(ROOT, "assets", "fonts");
for (const name of (await readdir(fontsDir)).sort()) {
  await emit(`assets/fonts/${name}`, await readFile(join(fontsDir, name)));
}
// Hosts that cannot be configured (Cloudflare Pages) read their headers from a file in the published
// directory. It travels with the build so an operator does not have to remember it.
await emit("_headers", await readFile(join(ROOT, "deploy", "_headers")));
for (const rel of PAGE_TEXT) {
  let text = await readFile(join(ROOT, rel), "utf8");
  // Each page file names only the artefacts it loads: the withdrawal page names all three, the
  // diagnostics page only the wallet pair. A placeholder that is missing where it is expected is a
  // failure; one that a file does not use is not.
  if (rel === "recovery.js") {
    for (const placeholder of Object.keys(STAMP)) {
      if (!text.includes(placeholder)) throw new Error(`${rel}: expected ${placeholder}, which names a built file`);
    }
  }
  for (const [placeholder, value] of Object.entries(STAMP)) {
    text = text.split(placeholder).join(value);
  }
  await emit(rel, Buffer.from(text));
}

// --- 6. What this build is ------------------------------------------------------------------
// A file an operator can check after upload: the version, the commit when the checkout knows one, and
// the hash of every file. It is not a substitute for the page's own release fields - it describes the
// directory, not a running node.
let commit = null;
try {
  const { checkoutCommit } = await import(pathToFileURL(join(ROOT, "build", "commit.mjs")).href);
  commit = checkoutCommit();
} catch {
  commit = null;
}
await emit(
  "build.json",
  Buffer.from(
    JSON.stringify(
      {
        name: pkg.name,
        version: pkg.version,
        commit,
        builtAt: new Date().toISOString(),
        files: written.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 })),
      },
      null,
      2,
    ) + "\n",
  ),
);

console.log(`\ndone: ${written.length} files, dist/ is ready to upload as it is.`);
