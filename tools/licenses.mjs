// THE INSTALLED TREE, AND THE LICENCE WE CAN SHIP.
//
// The recovery page has no production dependencies in package.json: everything it needs at run time is a
// devDependency, bundled into dist/ by esbuild. The page is static, so the check has to look at the installed tree
// rather than `--prod`; packages the build replaces with a stub are not shipped and are named here, not silently
// ignored.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));

// `build/build.mjs` resolves these Node built-ins to a stub. A package by one of these names never reaches dist/.
export const NON_SHIPPED = new Set([
  "tls",
  "net",
  "child_process",
  "worker_threads",
  "perf_hooks",
  "ws",
  "socks-proxy-agent",
]);

// The package ships a licence file but its package.json has no `license` field. The text in License.md is MIT;
// naming the evidence here keeps the decision visible instead of making the scanner guess.
export const LICENSE_OVERRIDES = new Map([["querystring-es3@0.2.1", "MIT"]]);

// The same permissive set as the SDK's policy. A copyleft, source-available, unknown or missing licence is a
// decision for a person, not a silent dependency.
export const ALLOWED = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Unlicense",
  "0BSD",
  "CC0-1.0",
  "BlueOak-1.0.0",
]);

const stripOuter = (text) => {
  let value = String(text || "").trim();
  while (value.startsWith("(") && value.endsWith(")")) {
    let depth = 0;
    let closesAt = -1;
    for (let i = 0; i < value.length; i += 1) {
      if (value[i] === "(") depth += 1;
      else if (value[i] === ")") depth -= 1;
      if (depth === 0) {
        closesAt = i;
        break;
      }
    }
    if (closesAt !== value.length - 1) break;
    value = value.slice(1, -1).trim();
  }
  return value;
};

function splitTop(text, operator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  const needle = ` ${operator} `;
  for (let i = 0; i <= text.length - needle.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") depth -= 1;
    if (depth === 0 && text.slice(i, i + needle.length).toUpperCase() === needle) {
      parts.push(text.slice(start, i).trim());
      start = i + needle.length;
      i = start - 1;
    }
  }
  if (!parts.length) return null;
  parts.push(text.slice(start).trim());
  return parts;
}

export function licenseAllowed(expression) {
  const text = stripOuter(expression);
  if (!text) return false;
  const ors = splitTop(text, "OR");
  if (ors) return ors.some((part) => licenseAllowed(part));
  const ands = splitTop(text, "AND");
  if (ands) return ands.every((part) => licenseAllowed(part));
  return ALLOWED.has(text.replace(/\s+WITH\s+.+$/i, "").trim());
}

export function licenseOf(manifest, key = null) {
  const value = manifest && manifest.license;
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && typeof value.type === "string" && value.type.trim())
    return value.type.trim();
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => (typeof entry === "string" ? entry : entry && entry.type))
      .filter(Boolean)
      .map(String);
    if (parts.length) return parts.join(" OR ");
  }
  return key && LICENSE_OVERRIDES.has(key) ? LICENSE_OVERRIDES.get(key) : null;
}

/** Every installed package, including nested node_modules, deduplicated by name and version. */
export function scanPackages(root = ROOT) {
  const found = new Map();
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(join(dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const child = join(dir, entry.name);
      if (entry.name.startsWith("@")) {
        let scoped;
        try {
          scoped = readdirSync(child, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const item of scoped) if (item.isDirectory()) visitPackage(join(child, item.name));
        continue;
      }
      visitPackage(child);
    }
  };
  const visitPackage = (dir) => {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
      manifest = null;
    }
    if (manifest && manifest.name && manifest.version) {
      const key = `${manifest.name}@${manifest.version}`;
      if (!found.has(key)) {
        found.set(key, {
          key,
          name: manifest.name,
          version: manifest.version,
          dir,
          license: licenseOf(manifest, key),
          manifest,
        });
      }
    }
    visit(join(dir, "node_modules"));
  };
  visit(join(root, "node_modules"));
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

export function shippedPackages(root = ROOT) {
  // The `@esbuild/*-x64` packages are optional native binaries chosen by the OS. They are build tools, not page
  // code, and their names differ between a Windows checkout and the Linux CI runner; excluding them keeps the
  // generated notices byte-identical across both.
  return scanPackages(root).filter((pkg) => !NON_SHIPPED.has(pkg.name) && !pkg.name.startsWith("@esbuild/"));
}

export function violations(packages) {
  return packages
    .filter((pkg) => !licenseAllowed(pkg.license))
    .map((pkg) => ({
      package: pkg.key,
      license: pkg.license || "(none)",
    }));
}

export function summary(packages) {
  const counts = new Map();
  for (const pkg of packages) {
    const key = pkg.license || "(none)";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return {
    packages: packages.length,
    licenses: [...counts]
      .map(([license, count]) => ({ license, count }))
      .sort((a, b) => a.license.localeCompare(b.license)),
  };
}

export function licenseFiles(dir) {
  try {
    return readdirSync(dir)
      .filter((name) => /^(?:licen[cs]e|copying|notice)(?:\..+)?$/i.test(name))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}
