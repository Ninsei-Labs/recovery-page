#!/usr/bin/env bun
// THE VERSION OF A RELEASE COMES FROM ITS TAG, NOT FROM A HAND-EDITED FILE.
//
// The release workflow used `npm version` for this, which brought a package manager the project does not use into a
// Bun-only build. This script does the same one thing: it reads package.json, writes the tag's version, and refuses a
// value that is not a version. `bun build/build.mjs` then stamps `build.json` from that number, so the archive and the
// release cannot disagree.
//
// Run: bun tools/version-from-tag.mjs v0.2.0   (the leading v is accepted)
import { readFileSync, writeFileSync } from "node:fs";

const raw = String(process.argv[2] || "").trim();
const version = raw.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("a release tag must be v<major>.<minor>.<patch>, got " + JSON.stringify(raw));
  process.exit(1);
}
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
pkg.version = version;
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n", "utf8");
console.log("package.json version: " + version);
