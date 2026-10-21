// THE CHECKS THIS REPOSITORY RUNS ON ITSELF.
//
// Three kinds, and nothing else:
//   1. rules that must hold in the SOURCES - one parser for the node address, no absolute asset paths,
//      no eval, the SDK entry naming package subpaths and not files inside the package, one key set
//      for the single language;
//   2. facts about the BUILD - every stamped file exists, no placeholder survives, and the hashes in
//      `build.json` match the files they name;
//   3. the page files a host must receive - the isolation fallback, the header file and the fonts.
//
// Run: bun run test   (builds first, then runs this file)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");

let pass = 0;
let failed = 0;
const ok = (name, detail) => {
  pass += 1;
  console.log(`ok    ${name}${detail ? " - " + detail : ""}`);
};
const bad = (name, why) => {
  failed += 1;
  console.log(`FAIL  ${name} - ${why}`);
};
async function check(name, fn) {
  try {
    const detail = await fn();
    ok(name, detail);
  } catch (e) {
    bad(name, String((e && e.message) || e));
  }
}
const read = (rel) => readFile(join(ROOT, rel), "utf8");

// --- 1. the node address ----------------------------------------------------------------
const { parseNodeUrl, DEFAULT_NODE } = await import(pathToFileURL(join(ROOT, "lib", "node.js")).href);

await check("an empty address is refused with its own reason", () => {
  assert.deepEqual(parseNodeUrl(""), { ok: false, why: "empty", url: null });
  assert.deepEqual(parseNodeUrl("   "), { ok: false, why: "empty", url: null });
});
await check("a plain https address is accepted and loses a trailing slash", () => {
  assert.equal(parseNodeUrl("https://node.example/").url, "https://node.example");
  assert.equal(parseNodeUrl("https://node.example/xmr/").url, "https://node.example/xmr");
});
await check("http is accepted (a node behind a local proxy is a real case)", () => {
  assert.equal(parseNodeUrl("http://127.0.0.1:38081").url, "http://127.0.0.1:38081");
});
await check("another scheme is refused by name", () => {
  assert.equal(parseNodeUrl("ftp://node.example").why, "scheme");
  assert.equal(parseNodeUrl("node.example").why, "shape");
});
await check("credentials in the address are refused, never stored", () => {
  assert.equal(parseNodeUrl("https://user:pass@node.example").why, "credentials");
});
await check("a query or a fragment is refused: the page appends its own paths", () => {
  assert.equal(parseNodeUrl("https://node.example/?x=1").why, "shape");
  assert.equal(parseNodeUrl("https://node.example/#top").why, "shape");
});
await check("the default is an https proxy, not a bare node", () => {
  assert.match(DEFAULT_NODE, /^https:\/\//);
});

// --- 2. one key set for the one language ------------------------------------------------
const localesDir = join(ROOT, "locales");
const tags = (await readdir(localesDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
await check("exactly one language folder is present", () => {
  assert.deepEqual(tags.sort(), ["en"]);
});
const en = (await import(pathToFileURL(join(localesDir, "en", "index.js")).href)).default;
const strings = en.strings;

await check("each section of the language file has no duplicate keys (a duplicate would silently win)", async () => {
  const text = await read(join("locales", "en", "index.js"));
  const sections = new Map();
  let section = "(top)";
  for (const line of text.split("\n")) {
    const head = /^  (strings|sdk|params):\s*\{/.exec(line);
    if (head) {
      section = head[1];
      continue;
    }
    const key = /^    "([^"]+)":/.exec(line);
    if (!key) continue;
    const seen = sections.get(section) || new Map();
    seen.set(key[1], (seen.get(key[1]) || 0) + 1);
    sections.set(section, seen);
  }
  const dupes = [];
  for (const [name, seen] of sections) {
    for (const [key, n] of seen) if (n > 1) dupes.push(`${name}: ${key} x${n}`);
  }
  assert.deepEqual(dupes, []);
  return [...sections].map(([name, seen]) => `${name}: ${seen.size}`).join(", ");
});

await check("every key the HTML asks for exists", async () => {
  const missing = [];
  for (const file of ["index.html", "diagnostics.html"]) {
    const html = await read(file);
    for (const m of html.matchAll(/data-i18n(?:-placeholder|-title)?="([^"]+)"/g)) {
      if (!(m[1] in strings)) missing.push(`${file}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

await check("every literal t() key in the page exists", async () => {
  const missing = [];
  for (const file of ["recovery.js", "diagnostics.js", "lib/node.js"]) {
    const text = await read(file);
    for (const m of text.matchAll(/\bt\("([a-z0-9._]+)"/g)) {
      // A key built by concatenation (`"sdk." + code`) is a prefix, not a key: it is covered by the
      // dictionary checks on the SDK side and cannot be resolved here.
      if (m[1].endsWith(".")) continue;
      if (!(m[1] in strings)) missing.push(`${file}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

await check("the node labels the module can return all exist", () => {
  for (const key of ["node.label.default", "node.label.same", "node.label.custom"]) {
    if (!(key in strings)) throw new Error("missing " + key);
  }
});

// --- 3. the page's own rules ------------------------------------------------------------
await check("the SDK entry names package subpaths, not files inside the package", async () => {
  const text = await read("sdk-entry.js");
  const specifiers = [...text.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(specifiers.length > 0, "no imports found");
  for (const s of specifiers) {
    assert.ok(!s.startsWith(".") && !s.startsWith("/"), `a path into the package: ${s}`);
    assert.ok(s.startsWith("@ninsei-labs/sdk"), `not from the SDK: ${s}`);
  }
  return specifiers.join(", ");
});

await check("no absolute asset paths: the page must work in a subdirectory", async () => {
  const offenders = [];
  for (const file of ["recovery.js", "diagnostics.js", "index.html", "diagnostics.html", "lib/node.js"]) {
    const text = await read(file);
    for (const m of text.matchAll(/(?:src|href)="\/(?!\/)|from\s+"\/(?!\/)|import\("\/(?!\/)|fetch\("\/[a-z]/g)) {
      offenders.push(`${file}: ${m[0]}`);
    }
  }
  // The stylesheet's files (the fonts) follow the same rule, and a URL with a scheme would be another host.
  const css = await read("recovery.css");
  for (const m of css.matchAll(/url\(\s*["']?(?:\/|(?!data:)[a-z][a-z0-9+.-]*:)[^)]*\)/gi)) offenders.push(`recovery.css: ${m[0]}`);
  assert.deepEqual(offenders, []);
});

await check("no eval and no new Function in the page's own code", async () => {
  const offenders = [];
  for (const file of ["recovery.js", "diagnostics.js", "lib/node.js", "lib/codes.js", "coi.js", "sw.js"]) {
    const text = await read(file);
    if (/\beval\s*\(|new\s+Function\s*\(/.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

await check("the page never writes the recovery file or the password anywhere", async () => {
  for (const file of ["recovery.js"]) {
    const text = await read(file);
    assert.ok(!/localStorage\.setItem\([^)]*(contents|passphrase|seed|mnemonic)/i.test(text), file);
  }
});

// --- 4. the build -----------------------------------------------------------------------
await check("dist/ was built", async () => {
  const info = await stat(DIST).catch(() => null);
  assert.ok(info && info.isDirectory(), "run npm run build first");
});

const REQUIRED = [
  "index.html",
  "diagnostics.html",
  "recovery.css",
  "recovery.js",
  "diagnostics.js",
  "coi.js",
  "sw.js",
  "monero.worker.js",
  "assets/vendors/monero/monero-ts-browser.js",
  "assets/vendors/sdk/sdk-browser.js",
  "locales/index.js",
  "locales/available.js",
  "locales/en/index.js",
  "_headers",
  "build.json",
  // The fonts are licensed under the SIL OFL, which travels with them.
  "assets/fonts/hanken-grotesk-OFL.txt",
  "assets/fonts/geist-mono-OFL.txt",
  "assets/fonts/chakra-petch-OFL.txt",
  "assets/fonts/silkscreen-OFL.txt",
];
await check("every file a host must receive is in dist/", async () => {
  // The stylesheet names its fonts: each file it loads is one a host must receive.
  const css = await readFile(join(DIST, "recovery.css"), "utf8");
  const loaded = [...css.matchAll(/url\(\s*["']?\.\/([^"')?#]+)/g)].map((m) => m[1]);
  assert.ok(loaded.length > 0, "recovery.css loads no files: the fonts are missing from it");
  const files = [...REQUIRED, ...loaded];
  const missing = files.filter((rel) => !existsSync(join(DIST, rel)));
  assert.deepEqual(missing, []);
  return `${files.length} files, ${loaded.length} named by recovery.css`;
});

await check("no build placeholder survives in dist/", async () => {
  const leftovers = [];
  for (const file of ["recovery.js", "diagnostics.js"]) {
    const text = await readFile(join(DIST, file), "utf8");
    for (const m of text.matchAll(/__V_[A-Z]+__/g)) leftovers.push(`${file}: ${m[0]}`);
  }
  assert.deepEqual(leftovers, []);
});

await check("build.json lists every built file with its real hash", async () => {
  const manifest = JSON.parse(await readFile(join(DIST, "build.json"), "utf8"));
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0, "no files listed");
  const wrong = [];
  for (const entry of manifest.files) {
    const path = join(DIST, entry.file);
    if (!existsSync(path)) {
      wrong.push(`${entry.file}: missing`);
      continue;
    }
    const bytes = await readFile(path);
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
    if (hash !== entry.sha256 || bytes.length !== entry.bytes) wrong.push(`${entry.file}: hash or size differs`);
  }
  assert.deepEqual(wrong, []);
  return `${manifest.files.length} files, version ${manifest.version}`;
});

await check("the stamped page names the hashes of the files it loads", async () => {
  const page = await readFile(join(DIST, "recovery.js"), "utf8");
  const bundle = await readFile(join(DIST, "assets", "vendors", "sdk", "sdk-browser.js"));
  const expected = createHash("sha256").update(bundle).digest("hex").slice(0, 8);
  assert.ok(page.includes(expected), `sdk-browser.js?v=${expected} is not named by the page`);
  return `?v=${expected}`;
});

await check("the isolation fallback ships with the page", async () => {
  const html = await readFile(join(DIST, "index.html"), "utf8");
  assert.ok(html.includes('src="./coi.js"'), "coi.js is not loaded by index.html");
  assert.ok(existsSync(join(DIST, "sw.js")), "sw.js is missing");
});

await check("the header file carries both isolation headers", async () => {
  const headers = await readFile(join(DIST, "_headers"), "utf8");
  assert.match(headers, /Cross-Origin-Opener-Policy:\s*same-origin/i);
  assert.match(headers, /Cross-Origin-Embedder-Policy:\s*require-corp/i);
});

await check("the workflows run Bun and never npm", async () => {
  const dir = join(ROOT, ".github", "workflows");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".yml"));
  const problems = [];
  const BUILD_WORKFLOWS = ["ci.yml", "release.yml"];
  for (const file of files) {
    const text = await readFile(join(dir, file), "utf8");
    if (/\bnpm (ci|test|version)\b|actions\/setup-node/.test(text)) problems.push(`${file}: names npm or node`);
    // The build workflows install and run the page with Bun; CodeQL reads the sources and needs no
    // toolchain, so the setup-bun rule belongs to the two that build.
    if (BUILD_WORKFLOWS.includes(file) && !/oven-sh\/setup-bun/.test(text)) problems.push(`${file}: no setup-bun`);
  }
  const release = await readFile(join(dir, "release.yml"), "utf8");
  if (!/workflow_dispatch:/.test(release)) problems.push("release.yml cannot publish an existing tag whose first run failed");
  if (!/\$TAG/.test(release)) problems.push("release.yml does not use the tag it was asked about");
  const codeql = await readFile(join(dir, "codeql.yml"), "utf8");
  if (!/github\/codeql-action\/init@v\d/.test(codeql) || !/github\/codeql-action\/analyze@v\d/.test(codeql)) {
    problems.push("codeql.yml does not run the CodeQL init and analyze actions");
  }
  if (!/security-events:\s*write/.test(codeql)) problems.push("codeql.yml cannot upload its findings: no security-events: write");
  if (!/build-mode:\s*none/.test(codeql)) problems.push("codeql.yml tries to build a language that has no compiler");
  assert.deepEqual(problems, []);
  return `${files.length} workflows`;
});

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
