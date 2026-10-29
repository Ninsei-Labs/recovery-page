#!/usr/bin/env node
// THIRD-PARTY NOTICES FOR THE PAGE.
//
// The page is static: every package it ships is bundled into dist/, so the notices are served beside the page
// rather than installed from a registry. The file is deterministic and includes every licence text the packages
// actually ship. A package that declares a licence but ships no licence file is named as such; the scanner does not
// invent a copyright holder.
//
// Run: bun run notices        (write THIRD_PARTY_NOTICES.txt)
//      bun run check:notices  (compare, no write)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { licenseFiles, NON_SHIPPED, ROOT, shippedPackages } from "./licenses.mjs";

const OUT = join(ROOT, "THIRD_PARTY_NOTICES.txt");
const textOf = (file) => readFileSync(file, "utf8").replace(/\r\n/g, "\n").trimEnd();

function sourceOf(manifest) {
  const repo = manifest && manifest.repository;
  const value = typeof repo === "string" ? repo : repo && typeof repo.url === "string" ? repo.url : null;
  return value || (manifest && manifest.homepage) || null;
}

export function notices() {
  const packages = shippedPackages();
  const lines = [
    "THIRD-PARTY NOTICES",
    "",
    "This page ships the packages below in its browser bundles. Their licences and the licence texts they",
    "ship are reproduced here. The project's own licence is in LICENSE.",
    "",
    `Packages replaced by a browser stub at build time are not shipped and are not listed: ${[...NON_SHIPPED].sort().join(", ")}.`,
    "",
  ];
  for (const pkg of packages) {
    lines.push("=".repeat(100), `${pkg.name} ${pkg.version}`, `License: ${pkg.license || "(none declared)"}`);
    const source = sourceOf(pkg.manifest);
    if (source) lines.push(`Source: ${source}`);
    lines.push("");
    const files = licenseFiles(pkg.dir);
    if (!files.length) {
      lines.push(
        `No licence file was included by the package; the declared licence is ${pkg.license || "not stated"}.`,
        "",
      );
    } else {
      for (const file of files) lines.push(`--- ${file} ---`, textOf(join(pkg.dir, file)), "");
    }
  }
  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const check = process.argv.includes("--check");
  let expected;
  try {
    expected = notices();
  } catch (error) {
    console.error("third-party notices: " + (error?.message || error));
    process.exit(2);
  }
  if (check) {
    const actual = existsSync(OUT) ? readFileSync(OUT, "utf8").replace(/\r\n/g, "\n") : "";
    if (actual !== expected) {
      console.error("third-party notices: THIRD_PARTY_NOTICES.txt is stale; run `bun run notices`");
      process.exit(1);
    }
    console.log(
      `third-party notices: ${expected.split("\n").filter((line) => line.startsWith("License: ")).length} package(s), current`,
    );
  } else {
    writeFileSync(OUT, expected, "utf8");
    console.log(`third-party notices: wrote ${OUT}`);
  }
}
