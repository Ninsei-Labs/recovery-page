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
      { key: "a@1.0.0", name: "a", license: "MIT" },
      { key: "b@2.0.0", name: "b", license: "GPL-3.0-only" },
      { key: "c@3.0.0", name: "c", license: null },
    ]),
    [
      { package: "b@2.0.0", license: "GPL-3.0-only" },
      { package: "c@3.0.0", license: "(none)" },
    ],
  );
});

test("the SDK's LGPL expression is allowed for the SDK only", () => {
  const expression = "(MIT AND LGPL-3.0-only)";
  assert.deepEqual(violations([{ key: "@ninsei-labs/sdk@0.58.0", name: "@ninsei-labs/sdk", license: expression }]), []);
  assert.deepEqual(violations([{ key: "other@1.0.0", name: "other", license: expression }]), [
    { package: "other@1.0.0", license: expression },
  ]);
  assert.equal(licenseAllowed(expression), false, "the exception did not widen the general allowlist");
});
