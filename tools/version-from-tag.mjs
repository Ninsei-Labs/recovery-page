#!/usr/bin/env bun
// THE VERSION OF A RELEASE COMES FROM ITS TAG, NOT FROM A HAND-EDITED FILE.
//
// The release workflow used `npm version` for this, which brought a package manager the project does not use into a
// Bun-only build. This script reads package.json and either writes the tag's version or checks that the two already
// agree. The release uses `--check`: a tag that does not match package.json fails before anything is built, exactly
// as the SDK release does. `bun build/build.mjs` then stamps `build.json` from the same number.
//
// Run: bun tools/version-from-tag.mjs v0.2.0   (the leading v is accepted)
//      bun tools/version-from-tag.mjs v0.2.0 --check
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const check = args.includes("--check");
const raw = String(args.find((arg) => arg !== "--check") || "").trim();
const version = raw.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("a release tag must be v<major>.<minor>.<patch>, got " + JSON.stringify(raw));
  process.exit(1);
}
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (check) {
  if (pkg.version !== version) {
    console.error("package.json says " + pkg.version + ", the tag says " + version);
    process.exit(1);
  }
  console.log("package.json version matches the tag: " + version);
  process.exit(0);
}
pkg.version = version;
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n", "utf8");
console.log("package.json version: " + version);
