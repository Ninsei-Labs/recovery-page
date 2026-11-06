// The SDK's salt-based search returns every matching order in one complete result. The page must not keep the
// old index cursor, the abort signal or the progress callback: 0.57 ignores them, so leaving them in would make
// "Search more" and "Stop" lie. A failed network keeps its rows and offers a retry instead.
//
// This is a source guard; the page itself is exercised only in a browser.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../recovery.js", import.meta.url), "utf8");
const search = page.slice(page.indexOf("async function findKeySwaps"), page.indexOf("// THE DEADLINE"));
const draw = page.slice(page.indexOf("function drawSwaps"), page.indexOf("function swapRow"));

assert.ok(
  !/fromIndex|maxIndex|onProgress|signal:\s*controller/.test(search),
  "the page still passes the removed search API",
);
assert.ok(
  !/nextIndex|searchedUpTo|incompleteReason|search\.aborted|search\.controller/.test(search),
  "the page still keeps a search cursor",
);
assert.match(search, /factory: net\.factory/, "the search does not name the factory");
assert.match(search, /source\.complete = found\.complete === true/, "completeness is not recorded");
assert.match(
  search,
  /search\.done = search\.sources\.every\(\(source\) => source\.complete\) && search\.failed\.length === 0/,
  "a failed network can make the search look complete",
);
assert.match(
  page,
  /keyMoreEl\.addEventListener\("click", \(\) => busy\(keyMoreEl, \(\) => findKeySwaps\(\{ more: true \}\), keyErrorEl\)/,
  "a failed network cannot be retried",
);
assert.match(
  draw,
  /keyMoreEl\.hidden = search\.done \|\| search\.searching \|\| !pending/,
  "retry is not tied to a failed network",
);
assert.match(
  draw,
  /keyNoneEl\.hidden = !search\.done \|\| rows\.length > 0 \|\| search\.failed\.length > 0/,
  "a failed search can say there are no swaps",
);
assert.ok(
  !/keyStopEl|keyRangeEl|key\.progress|key\.range/.test(page),
  "the page still shows a control the SDK cannot honour",
);

console.log("ok    a key search is one complete SDK call, with a retry after a failed network");
