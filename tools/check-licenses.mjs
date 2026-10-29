#!/usr/bin/env node
// Every installed package that reaches the page must carry a permissive licence. Packages the build replaces with
// a stub are named in tools/licenses.mjs and are not part of the shipped page.
//
// Run: bun run check:licenses
import { shippedPackages, summary, violations } from "./licenses.mjs";

const packages = shippedPackages();
const totals = summary(packages);
console.log("=== RECOVERY PAGE DEPENDENCY LICENSES ===");
for (const row of totals.licenses) console.log(`  ${row.license}: ${row.count} package(s)`);
if (!totals.packages) {
  console.error("license check: no installed packages were read - the scanner is looking at nothing");
  process.exit(1);
}
const bad = violations(packages);
if (bad.length) {
  console.error("RESTRICTED LICENSES:");
  for (const row of bad) console.error(`  ${row.license}: ${row.package}`);
  console.error(`license check: ${bad.length} package(s) outside the allowlist`);
  process.exit(1);
}
console.log(`license check: ${totals.packages} shipped package(s), all on the allowlist`);
