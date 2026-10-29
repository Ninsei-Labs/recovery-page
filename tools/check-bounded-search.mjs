// The recovery page must keep an incomplete search open: one page at a time, a cursor, and no "no swaps" before
// the range is complete. This is a source guard; the page itself is exercised only in a browser.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../recovery.js", import.meta.url), "utf8");
const search = page.slice(page.indexOf("async function findKeySwaps"), page.indexOf("// THE DEADLINE"));
const draw = page.slice(page.indexOf("function drawSwaps"), page.indexOf("function swapRow"));

assert.match(search, /fromIndex: source\.nextIndex/, "the next page does not start at the saved cursor");
assert.match(search, /maxIndex: 1000/, "one page is not bounded");
assert.match(search, /signal: controller\.signal/, "a page cannot be stopped");
assert.match(search, /onProgress: \(\{ scanned, index \}\)/, "the page reports no progress");
assert.match(search, /source\.complete = found\.complete === true/, "completeness is not recorded");
assert.match(search, /source\.nextIndex = source\.complete \? null : found\.nextIndex/, "the next cursor is not kept");
assert.match(search, /failedAt/, "a failed network is not retried cleanly");
assert.match(
  page,
  /keyMoreEl\.addEventListener\("click", \(\) => busy\(keyMoreEl, \(\) => findKeySwaps\(\{ more: true \}\)/,
  "Search more does not continue",
);
assert.match(
  page,
  /keyStopEl\.addEventListener\("click",[\s\S]{0,120}controller\.abort\(\)/,
  "Stop does not abort the page",
);
assert.match(
  draw,
  /keyMoreEl\.hidden = search\.done \|\| search\.searching/,
  "Search more is not tied to an incomplete page",
);
assert.match(draw, /keyRangeEl\.hidden = search\.done/, "an incomplete page does not name its range");
assert.match(page, /keyNoneEl\.hidden = !search\.done/, "an incomplete page can say there are no swaps");
assert.match(page, /incompleteReason:/, "the page does not expose why a page stopped");

console.log("ok    a bounded key search keeps its cursor and offers Search more");
