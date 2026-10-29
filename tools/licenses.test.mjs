import assert from "node:assert/strict";
import test from "node:test";
import { licenseAllowed, licenseOf, NON_SHIPPED, violations } from "./licenses.mjs";

test("the same permissive allowlist and SPDX expressions as the SDK", () => {
  for (const license of ["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "Unlicense", "0BSD"]) {
    assert.equal(licenseAllowed(license), true, license);
  }
  for (const license of ["GPL-3.0-only", "AGPL-3.0", "UNLICENSED", "UNKNOWN", ""]) {
    assert.equal(licenseAllowed(license), false, license);
  }
  assert.equal(licenseAllowed("(MIT AND BSD-3-Clause)"), true);
  assert.equal(licenseAllowed("(Unlicense OR Apache-2.0)"), true);
  assert.equal(licenseAllowed("MIT AND GPL-3.0-only"), false);
});

test("a licence object and the one file-backed declaration are read, not guessed", () => {
  assert.equal(licenseOf({ license: { type: "MIT", url: "https://example.invalid" } }), "MIT");
  assert.equal(licenseOf({}, "querystring-es3@0.2.1"), "MIT");
  assert.equal(licenseOf({}, "other@1.0.0"), null);
  assert.equal(NON_SHIPPED.has("tls"), true);
});

test("a shipped package outside the allowlist is a violation", () => {
  assert.deepEqual(
    violations([
      { key: "a@1.0.0", license: "MIT" },
      { key: "b@2.0.0", license: "GPL-3.0-only" },
      { key: "c@3.0.0", license: null },
    ]),
    [
      { package: "b@2.0.0", license: "GPL-3.0-only" },
      { package: "c@3.0.0", license: "(none)" },
    ],
  );
});
