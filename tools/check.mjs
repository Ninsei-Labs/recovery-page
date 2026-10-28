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
// LINE ENDINGS ARE NOT PART OF A SOURCE CHECK. A Windows checkout writes CRLF, and guards that slice a
// function by "\n}\n" then read the rest of the file instead of one body. Normalise once, here.
const read = (rel) => readFile(join(ROOT, rel), "utf8").then((text) => text.replace(/\r\n/g, "\n"));

// VISIBLE HTML WITHOUT COMMENTS, cut by index rather than a regex: a single replace of `<!--...-->` can leave a
// second opener behind, and a comment is not text a person reads. The page's own comments are not checked.
const withoutComments = (html) => {
  let out = "";
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf("<!--", at);
    if (open < 0) {
      out += html.slice(at);
      break;
    }
    out += html.slice(at, open);
    const close = html.indexOf("-->", open + 4);
    if (close < 0) break;
    at = close + 3;
  }
  return out;
};
// THE PAGE'S MODULES, read from the folder the build ships whole (build/build.mjs): every rule over the sources and
// the list of files a host must receive cover a new module without a second list to remember.
const LIB = (await readdir(join(ROOT, "lib")))
  .filter((name) => name.endsWith(".js"))
  .sort()
  .map((name) => `lib/${name}`);

// --- 1. the node address ----------------------------------------------------------------
const { parseNodeUrl, NODES, DEFAULT_NODE, nodeVerdict, medianHeight, fastestGood, pingNode } = await import(
  pathToFileURL(join(ROOT, "lib", "node.js")).href
);
const { moneroHeightAtOrAfter, restoreWindow } = await import(pathToFileURL(join(ROOT, "lib", "window.js")).href);

// A FAKE MONEROD, shaped as monerod answers (examples, not a recorded chain): get_info's `height` is the number of
// blocks, so the top block is one lower; a header past the top is refused with monerod's own error; the genesis
// block's timestamp is 0, as on every Monero network. Block h's time is `stamp(h)` for h > 0.
const fakeMonerod = (count, stamp, network = "stagenet") => {
  const asked = [];
  const fetchImpl = async (url, init) => {
    const request = JSON.parse(init.body);
    assert.equal(request.method, "get_block_header_by_height");
    const height = request.params.height;
    asked.push(height);
    const body =
      height > count - 1
        ? {
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: -2,
              message: `Requested block height: ${height} greater than current top block height: ${count - 1}`,
            },
          }
        : {
            jsonrpc: "2.0",
            id: request.id,
            result: { status: "OK", block_header: { height, timestamp: height === 0 ? 0 : stamp(height) } },
          };
    return { ok: true, status: 200, json: async () => body };
  };
  const probe = async () => ({ ok: true, network, nettype: network, height: count, synchronized: true });
  return { asked, fetchImpl, probe, top: count - 1 };
};
// THE SAME CASES ON EVERY RUN: a seeded generator, so a failure names a case that repeats.
const seeded = (seed) => () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};

await check("the lock window ends at the block at t1 plus ten, on a node that answers like monerod", async () => {
  const node = fakeMonerod(2_000, (h) => 1_000 + h * 1_000);
  const at = await moneroHeightAtOrAfter({
    nodeUrl: "https://node.example",
    timestamp: 1_000_500,
    tipHeight: 2_000,
    fetchImpl: node.fetchImpl,
  });
  assert.equal(at, 1_000, `height at t1 is ${at}`);
  const window = await restoreWindow({
    nodeUrl: "https://node.example",
    t1Sec: 1_000_500,
    startHeight: 500,
    tipHeight: 2_000,
    fetchImpl: node.fetchImpl,
  });
  assert.deepEqual(window, { nodeUrl: "https://node.example", toHeight: 1_010, tipHeight: 2_000, fallback: true });
  assert.ok(Math.max(...node.asked) <= node.top, `a header past the top block was asked: ${Math.max(...node.asked)}`);
});

// THE TOP BLOCK IS THE NODE'S HEIGHT MINUS ONE: the SDK asks the node for every block of the window, and one past the
// top fails the whole restore.
await check("a t1 past the newest block stops the window at the top block, never past it", async () => {
  const node = fakeMonerod(2_000, (h) => 1_000 + h * 1_000);
  const window = await restoreWindow({
    nodeUrl: "https://node.example",
    t1Sec: 9_000_000,
    startHeight: 500,
    tipHeight: 2_000,
    fetchImpl: node.fetchImpl,
  });
  assert.deepEqual(window, { nodeUrl: "https://node.example", toHeight: 1_999, tipHeight: 2_000, fallback: true });
  const random = seeded(24);
  let cases = 0;
  for (let k = 0; k < 200; k += 1) {
    const count = 100 + Math.floor(random() * 5_000);
    const steps = [0];
    for (let h = 1; h < count; h += 1) steps.push((steps[h - 1] || 1_700_000_000) + Math.floor(random() * 241));
    const chain = fakeMonerod(count, (h) => steps[h]);
    const t1 = 1_700_000_000 - 600 + Math.floor(random() * (steps[count - 1] - 1_700_000_000 + 1_200));
    const start = 1 + Math.floor(random() * (count - 1));
    let first = count - 1;
    for (let h = count - 1; h >= 0; h -= 1) if ((h === 0 ? 0 : steps[h]) >= t1) first = h;
    const toHeight = Math.min(count - 1, Math.max(start, first + 10));
    const got = await restoreWindow({
      nodeUrl: "https://node.example",
      t1Sec: t1,
      startHeight: start,
      tipHeight: count,
      fetchImpl: chain.fetchImpl,
    });
    assert.deepEqual(
      got,
      toHeight > start ? { nodeUrl: "https://node.example", toHeight, tipHeight: count, fallback: true } : null,
      `count ${count}, t1 ${t1}, start ${start}`,
    );
    assert.ok(
      chain.asked.every((h) => h <= count - 1),
      `count ${count}: a header past the top block was asked`,
    );
    cases += 1;
  }
  return `${cases + 1} cases`;
});

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

await check("every listed node is https and written the way the parser gives it back", () => {
  assert.ok(NODES.length >= 3, `only ${NODES.length} nodes listed`);
  assert.equal(new Set(NODES).size, NODES.length, "a node is listed twice");
  assert.equal(DEFAULT_NODE, NODES[0], "the default is not the first listed node");
  for (const url of NODES) {
    assert.match(url, /^https:\/\//, `${url} is not https`);
    const parsed = parseNodeUrl(url);
    assert.ok(parsed.ok, `${url} is refused: ${parsed.why}`);
    // A link or a stored choice is matched to its row by the parsed form.
    assert.equal(parsed.url, url, `${url} parses to ${parsed.url}`);
  }
  return `${NODES.length} nodes`;
});

// AN ANSWER as the SDK's probeMoneroNode gives it; heights and times are example values.
const answer = (fields) => ({
  ok: true,
  network: "mainnet",
  nettype: "mainnet",
  synchronized: true,
  height: 3_500_000,
  ms: 100,
  ...fields,
});

// [what it is, answer, median height, expected state, expected why, expected params]
const VERDICTS = [
  ["no answer yet", null, 3_500_000, "checking", "checking", {}],
  ["the probe could not run", { ok: false, why: "unchecked" }, null, "unknown", "unchecked", {}],
  ["at the median", answer({}), 3_500_000, "good", "good", { height: 3_500_000 }],
  ["three blocks behind", answer({ height: 3_499_997 }), 3_500_000, "good", "good", { height: 3_499_997 }],
  ["four blocks behind", answer({ height: 3_499_996 }), 3_500_000, "bad", "behind", { blocks: 4 }],
  ["three blocks ahead", answer({ height: 3_500_003 }), 3_500_000, "good", "good", { height: 3_500_003 }],
  ["four blocks ahead", answer({ height: 3_500_004 }), 3_500_000, "bad", "ahead", { blocks: 4 }],
  [
    "stagenet",
    answer({ network: "stagenet", nettype: "stagenet", height: 2_000_000 }),
    3_500_000,
    "bad",
    "network",
    { network: "stagenet" },
  ],
  ["not synchronized", answer({ synchronized: false }), 3_500_000, "bad", "sync", {}],
  [
    "no answer (CORS or offline)",
    { ok: false, why: "unreachable", ms: 40 },
    3_500_000,
    "bad",
    "unreachable",
    { status: "?" },
  ],
  ["timed out", { ok: false, why: "timeout", ms: 5000 }, 3_500_000, "bad", "timeout", { status: "?" }],
  ["an HTTP error", { ok: false, why: "http", status: 403, ms: 90 }, 3_500_000, "bad", "http", { status: 403 }],
  ["not JSON", { ok: false, why: "not-json", ms: 90 }, 3_500_000, "bad", "answer", { status: "?" }],
  ["an RPC error", { ok: false, why: "rpc", rpc: -1, ms: 90 }, 3_500_000, "bad", "answer", { status: "?" }],
  [
    "an unknown network",
    { ok: false, why: "nettype", nettype: "fakenet", ms: 90 },
    3_500_000,
    "bad",
    "network",
    { network: "fakenet" },
  ],
];
await check("a node is good only when it answers on mainnet, synchronized, within 3 blocks of the median", () => {
  for (const [what, a, top, state, why, params] of VERDICTS) {
    assert.deepEqual(nodeVerdict(a, top), { state, why, params }, what);
  }
  return `${VERDICTS.length} cases`;
});

await check("the reference height is the median of the mainnet answers, so one inflated height cannot move it", () => {
  assert.equal(medianHeight([]), null);
  assert.equal(medianHeight([null, { ok: false, why: "timeout" }]), null);
  // Another network's height and a syncing node's height never count.
  const others = [
    answer({ height: 3_500_002 }),
    answer({ network: "stagenet", height: 2_000_000 }),
    answer({ network: "testnet", height: 9_000_000 }),
    answer({ synchronized: false, height: 1_000 }),
    null,
  ];
  assert.equal(medianHeight(others), 3_500_002);
  // Five nodes, one claiming a million blocks more: the median stays with the four that agree.
  const inflated = [3_500_000, 3_500_001, 99_999_999, 3_500_000, 3_499_999].map((height) => answer({ height }));
  assert.equal(medianHeight(inflated), 3_500_000);
  // An even count takes the lower middle.
  assert.equal(medianHeight([3_500_000, 3_500_010].map((height) => answer({ height }))), 3_500_000);
  assert.equal(
    medianHeight([3_500_000, 3_500_001, 3_500_002, 3_500_003].map((height) => answer({ height }))),
    3_500_001,
  );
});

await check("the page picks the fastest good node, and nothing when none is good", () => {
  const entries = [
    { url: "https://a.example", answer: answer({ ms: 120 }) },
    { url: "https://b.example", answer: answer({ ms: 80 }) },
    { url: "https://c.example", answer: answer({ ms: 20, network: "stagenet", height: 2_000_000 }) },
    { url: "https://d.example", answer: answer({ ms: 30, height: 3_499_990 }) },
    { url: "https://e.example", answer: answer({ ms: 10, synchronized: false }) },
    { url: "https://f.example", answer: { ok: false, why: "timeout", ms: 5 } },
    { url: "https://g.example", answer: null },
  ];
  assert.equal(fastestGood(entries), "https://b.example");
  // One node claims a far higher height and answers fastest: the honest nodes stay good, and it is not picked.
  const liar = [
    { url: "https://h1.example", answer: answer({ ms: 90 }) },
    { url: "https://h2.example", answer: answer({ ms: 60, height: 3_500_001 }) },
    { url: "https://liar.example", answer: answer({ ms: 5, height: 4_500_000 }) },
    { url: "https://h3.example", answer: answer({ ms: 70, height: 3_499_999 }) },
    { url: "https://h4.example", answer: answer({ ms: 120 }) },
  ];
  assert.equal(fastestGood(liar), "https://h2.example");
  assert.equal(fastestGood(entries.filter((e) => !/[abd]\./.test(e.url))), null);
  assert.equal(fastestGood([]), null);
  // Equal times: the list order decides.
  assert.equal(
    fastestGood([
      { url: "https://x.example", answer: answer({ ms: 50 }) },
      { url: "https://y.example", answer: answer({ ms: 50 }) },
    ]),
    "https://x.example",
  );
});

await check("a ping asks twice and keeps the faster answer; a failed first answer is not asked again", async () => {
  const probeOf = (answers) => {
    const calls = [];
    const probe = async (req) => {
      calls.push(req);
      const next = answers[calls.length - 1];
      if (next instanceof Error) throw next;
      return next;
    };
    return { calls, probe };
  };
  const url = "https://node.example";
  const slowThenFast = probeOf([answer({ ms: 310 }), answer({ ms: 42 })]);
  assert.equal((await pingNode(url, slowThenFast.probe, 1234)).ms, 42);
  assert.deepEqual(slowThenFast.calls, [
    { url, timeoutMs: 1234 },
    { url, timeoutMs: 1234 },
  ]);
  const fastThenSlow = probeOf([answer({ ms: 42 }), answer({ ms: 310 })]);
  assert.equal((await pingNode(url, fastThenSlow.probe)).ms, 42);
  const failsFirst = probeOf([{ ok: false, why: "unreachable", ms: 12 }, answer({})]);
  assert.deepEqual(await pingNode(url, failsFirst.probe), { ok: false, why: "unreachable", ms: 12 });
  assert.equal(failsFirst.calls.length, 1);
  const failsSecond = probeOf([answer({ ms: 200 }), { ok: false, why: "timeout", ms: 5000 }]);
  assert.equal((await pingNode(url, failsSecond.probe)).ms, 200);
  const throws = probeOf([new Error("boom")]);
  assert.deepEqual(await pingNode(url, throws.probe), { ok: false, why: "unreachable" });
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
  for (const file of ["recovery.js", "diagnostics.js", ...LIB]) {
    const text = await read(file);
    for (const m of text.matchAll(/\bt\("([A-Za-z0-9._]+)"/g)) {
      // A key built by concatenation (`"sdk." + code`) is a prefix, not a key: it is covered by the
      // dictionary checks on the SDK side and cannot be resolved here.
      if (m[1].endsWith(".")) continue;
      if (!(m[1] in strings)) missing.push(`${file}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

await check("the node labels the module can return all exist", () => {
  for (const key of ["node.label.listed", "node.label.same", "node.label.custom"]) {
    if (!(key in strings)) throw new Error("missing " + key);
  }
});

await check("every word a node row or the note under the list can show exists", async () => {
  const keys = new Set(VERDICTS.map((v) => "node.state." + v[4]));
  // The note keys are written as data ([key, params]), not as t() calls, so the literal check misses them.
  for (const m of (await read("recovery.js")).matchAll(/"(node\.(?:note|state)\.[a-z]+)"/g)) keys.add(m[1]);
  for (const why of ["empty", "shape", "scheme", "credentials"]) keys.add("node.why." + why);
  keys.add("node.ms");
  const missing = [...keys].filter((key) => !(key in strings));
  assert.deepEqual(missing, []);
  return `${keys.size} keys`;
});

await check("the node list has no check button, and its rows are radios of one group", async () => {
  const html = await read("index.html");
  const page = await read("recovery.js");
  assert.ok(!/nodeCheck/.test(html) && !/nodeCheck/.test(page), "a node check button is still on the page");
  assert.match(html, /<fieldset id="nodeList"/, "no fieldset for the node list");
  assert.match(html, /<input type="radio" name="node"/, "the own node row has no radio");
  assert.match(page, /h\("input", \{ type: "radio", name: "node"/, "the listed rows are not radios of the same group");
});

// --- 2b. the recovery key, the swaps it finds, the state of their money --------------------------
const { swapState, moneyState } = await import(pathToFileURL(join(ROOT, "lib", "withdrawal.js")).href);
const { SETTLEMENT, settlementOf, evmCall, keyNetworks, evmLogs, LOG_WINDOW } = await import(
  pathToFileURL(join(ROOT, "lib", "settlement.js")).href
);
// THE 128-BIT TEST VECTORS OF THE BIP39 SPECIFICATION: valid twelve-word keys that are nobody's.
const TEST_WORDS = [
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  "legal winner thank year wave sausage worth useful legal winner thank yellow",
  "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
  "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
];
// The SDK binds one store per process: a second client with a different adapter is refused. Both checks below
// build a client, so they share the first adapter instead of creating a new one for each check.
let sdkStore = null;
// The body of one function of a source file, for the rules that must hold inside it.
const bodyOf = (text, name) => {
  const at = text.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(at >= 0, `no ${name}()`);
  return text.slice(at, text.indexOf("\n}\n", at));
};

// THE PASSWORD FIELD FOLLOWS THE SDK'S READING OF THE KEY FILE, so the page keeps no rule of its own that could
// drift from the files the widget writes. Both kinds below are written by the installed SDK itself.
await check("a key file's password is asked only when the SDK's reader stops at its passphrase stage", async () => {
  const { createRecoveryKeyFile, openRecoveryKeyFile, importRecoveryKey } = await import("@ninsei-labs/sdk/recovery");
  const words = TEST_WORDS[0];
  const plain = await createRecoveryKeyFile({ mnemonic: words, createdAt: "2026-10-21" });
  const sealed = await createRecoveryKeyFile({
    mnemonic: words,
    createdAt: "2026-10-21",
    passphrase: "example-password-1234",
  });
  const stageOf = async (text, pass) => {
    try {
      return (await openRecoveryKeyFile(text, pass)).mnemonic === words ? "opened" : "another key";
    } catch (e) {
      return `${e.code}:${e.params && e.params.stage}`;
    }
  };
  assert.equal(await stageOf(plain, ""), "opened", "a plain key file does not open without a password");
  assert.equal(await stageOf(sealed, ""), "recovery-failed:passphrase");
  assert.equal(await stageOf(sealed, "wrong-password-1234"), "recovery-failed:decrypt");
  assert.equal(await stageOf(sealed, "example-password-1234"), "opened");
  assert.equal(await stageOf("NOT A KEY\n\n" + words, ""), "recovery-failed:parse");
  assert.equal(
    (await openRecoveryKeyFile(sealed, "example-password-1234")).fingerprint,
    importRecoveryKey(words).fingerprint,
  );
  const page = await read("recovery.js");
  const chosen = bodyOf(page, "onKeyFileChosen");
  assert.match(
    chosen,
    /openRecoveryKeyFile\(keyFileText, ""\)/,
    "the page does not ask the SDK whether the key file needs a password",
  );
  assert.match(
    chosen,
    /e\.params\.stage === "passphrase"\) \{\s*keyPassField\.hidden = false;/,
    "the password field does not follow the SDK's stage",
  );
  assert.ok(!/startsWith\("\{"\)/.test(page), "the page keeps its own rule for a protected key file");
});

// WHAT A FOUND SWAP NEEDS, from the escrow's status() and its deadline. The expected answers come from the
// contract: a claim reveals the claimer's half and a refund the locker's; the person is the locker on a buy and the
// claimer on a sell, so the maker's half is on chain after a claim on a buy and after a refund on a sell.
const funded = (fields = {}) => ({
  isFunded: true,
  isClaimed: false,
  isRefunded: false,
  balance: 10n ** 16n,
  ...fields,
});
const DEADLINE = 1_800_000_000_000;
// [what it is, request, expected state, expected action, expected params]
const SWAP_STATES = [
  [
    "a buy the maker claimed",
    { side: "buy", status: funded({ isClaimed: true, balance: 0n }) },
    "buy.claimed",
    "withdraw",
    {},
  ],
  [
    "a buy refunded to the wallet that paid",
    { side: "buy", status: funded({ isRefunded: true, balance: 0n }) },
    "buy.refunded",
    "none",
    {},
  ],
  [
    "a buy still open",
    { side: "buy", status: funded(), deadline: DEADLINE, now: DEADLINE - 1 },
    "buy.open",
    "later",
    { deadline: DEADLINE },
  ],
  [
    "a buy at its deadline",
    { side: "buy", status: funded(), deadline: DEADLINE, now: DEADLINE },
    "buy.late",
    "later",
    { deadline: DEADLINE },
  ],
  [
    "a sell paid out to the person",
    { side: "sell", status: funded({ isClaimed: true, balance: 0n }) },
    "sell.claimed",
    "none",
    {},
  ],
  [
    "a sell the maker refunded",
    { side: "sell", status: funded({ isRefunded: true, balance: 0n }) },
    "sell.refunded",
    "withdraw",
    {},
  ],
  [
    "a sell still open",
    { side: "sell", status: funded(), deadline: DEADLINE, now: DEADLINE - 60_000 },
    "sell.open",
    "later",
    { deadline: DEADLINE },
  ],
  [
    "a sell past its deadline",
    { side: "sell", status: funded(), deadline: DEADLINE, now: DEADLINE + 1 },
    "sell.late",
    "later",
    { deadline: DEADLINE },
  ],
  ["the status read failed", { side: "buy", status: null }, "unknown", "unknown", {}],
  ["an escrow that was never funded", { side: "sell", status: funded({ isFunded: false }) }, "unknown", "unknown", {}],
  ["an order with no side", { side: null, status: funded({ isClaimed: true }) }, "unknown", "unknown", {}],
  ["an open swap without a deadline", { side: "buy", status: funded(), deadline: null }, "unknown", "unknown", {}],
  [
    "an open swap with a NaN deadline",
    { side: "sell", status: funded(), deadline: Number.NaN },
    "unknown",
    "unknown",
    {},
  ],
];
await check(
  "a found swap needs a withdrawal only once the maker's half is on chain; an unread chain is unknown",
  () => {
    for (const [what, request, state, action, params] of SWAP_STATES) {
      assert.deepEqual(swapState(request), { state, action, params }, what);
    }
    return `${SWAP_STATES.length} cases`;
  },
);

// [what it is, request, expected state]
const MONEY_STATES = [
  ["the maker's half was read", { plan: { revealedHalf: true } }, "ready"],
  ["the half could not be read", { plan: { revealedHalf: false } }, "unread"],
  ["no plan", { plan: null }, "unread"],
  ["synced and spendable", { plan: { revealedHalf: true }, balance: { total: 5n, unlocked: 5n, txs: 1 } }, "ready"],
  [
    "synced, the XMR still locked",
    { plan: { revealedHalf: true }, balance: { total: 5n, unlocked: 0n, txs: 1 } },
    "locked",
  ],
  [
    "synced, XMR came and left",
    { plan: { revealedHalf: true }, balance: { total: 0n, unlocked: 0n, txs: 2 } },
    "withdrawn",
  ],
  [
    "synced, nothing ever arrived",
    { plan: { revealedHalf: true }, balance: { total: 0n, unlocked: 0n, txs: 0 } },
    "unseen",
  ],
  [
    "synced, the wallet could not count",
    { plan: { revealedHalf: true }, balance: { total: 0n, unlocked: 0n, txs: null } },
    "nothing",
  ],
];
await check("the money of a found swap: ready, unread, locked, withdrawn, never arrived, or unknown", () => {
  for (const [what, request, state] of MONEY_STATES) {
    assert.deepEqual(moneyState(request), { state, params: {} }, what);
  }
  return `${MONEY_STATES.length} cases`;
});

await check("every word a swap row, the state of the money and the flow's stops can show exists", async () => {
  const keys = new Set();
  for (const [, , state, action] of SWAP_STATES) {
    keys.add("swap.state." + state);
    keys.add("swap.action." + action);
  }
  for (const [, , state] of MONEY_STATES) keys.add("money." + state);
  keys.add("money.reading");
  for (const why of ["side", "spend-point", "own-view-point", "maker-view-point"]) keys.add("log.order." + why);
  // The flow's keys are written as data (say(el, key)), not as t() calls.
  for (const m of (await read("recovery.js")).matchAll(/"((?:money|flow|key|swap)\.[A-Za-z.]+[A-Za-z])"/g))
    keys.add(m[1]);
  const missing = [...keys].filter((key) => !(key in strings));
  assert.deepEqual(missing, []);
  return `${keys.size} keys`;
});

// THE PAGE HANDS THE KEY AND THE FOUND ORDER TO THE SDK. sweep.fromOrder decides the side, checks the chain's
// points against the key, builds the joint address and returns the file plan/keys accept. The order is built the
// way the chain holds it, from two independent keys: the person's, and a stand-in for the maker's own spend half.
await check("sweep.fromOrder opens the address the maker paid, on a buy and a sell", async () => {
  const sdk = await import("@ninsei-labs/sdk");
  const { memoryAdapter } = await import("@ninsei-labs/sdk/adapters");
  const { takerHalves, validatePayload } = await import("@ninsei-labs/sdk/recovery");
  const { createHalves, spendKeysFromRevealedHalf, scalarFromMoneroHex, decodeAddressKeys } =
    await import("@ninsei-labs/sdk/xmr");
  const { ed25519 } = await import("@noble/curves/ed25519.js");
  const { secp256k1 } = await import("@noble/curves/secp256k1.js");
  const { keccak_256 } = await import("@noble/hashes/sha3.js");
  const { randomBytes } = await import("node:crypto");
  const halvesLib = createHalves({
    ed25519,
    secp256k1,
    keccak256: (data) => keccak_256(typeof data === "string" ? new TextEncoder().encode(data) : data),
    randomBytes: (n) => new Uint8Array(randomBytes(n)),
  });
  const word = (hex) => "0x" + String(hex).replace(/^0x/, "").padStart(64, "0");
  const escrow = "0x" + "e5".repeat(20);
  let revealed = null;
  const core = sdk.createNinsei({
    settlement: { chain: "arbitrum-sepolia" },
    xmrNetwork: "stagenet",
    mode: "live",
    fetch: async () => {
      throw new TypeError("no service");
    },
    storage: sdkStore || (sdkStore = memoryAdapter()),
    // revealedHalf() as the escrow answers it: one bytes32 word.
    evmCall: async ({ to, data }) => {
      assert.equal(to, escrow);
      assert.equal(data, "0x3f267bb6");
      return word(BigInt(revealed).toString(16));
    },
  });
  let cases = 0;
  for (let k = 0; k < TEST_WORDS.length; k += 1) {
    for (const index of [0, 1, 7, 99]) {
      for (const side of ["buy", "sell"]) {
        const person = takerHalves({ mnemonic: TEST_WORDS[k], chainId: 421614, index });
        // The maker's own spend half: any half the person's key does not give (here another key's number).
        const makerSpend = takerHalves({
          mnemonic: TEST_WORDS[(k + 1) % TEST_WORDS.length],
          chainId: 421614,
          index: index + 1000,
        }).spendHalf;
        const makerSpendPoint = halvesLib.publicHalves(BigInt(makerSpend)).ed;
        const buy = side === "buy";
        const found = {
          escrow,
          side: buy ? "locker" : "claimer",
          index,
          readyBy: 1_790_000_000,
          t1: 1_790_003_600,
          startHeight: 2_100_000,
          blockNumber: 321_000_000,
          edPointLocker: word(buy ? person.spendPoint : makerSpendPoint),
          edPointClaimer: word(buy ? makerSpendPoint : person.spendPoint),
          edViewPointLocker: word(buy ? person.viewPoint : person.makerViewPoint),
        };
        // THE MAKER'S OWN VIEW OF THE ADDRESS: its spend half and the view half the key gave it, the person's points.
        const paid = core.order.jointAddress({
          ownSpendHalf: makerSpend,
          ownViewHalf: person.makerViewHalf,
          otherSpendPoint: word(person.spendPoint),
          otherViewPoint: word(person.viewPoint),
          network: "stagenet",
        }).address;
        const what = `${side}, key ${k}, number ${index}`;
        const built = await core.sweep.fromOrder({
          mnemonic: TEST_WORDS[k],
          chainId: 421614,
          network: "arbitrum-sepolia",
          moneroNetwork: "stagenet",
          order: found,
        });
        assert.equal(built.address, paid, `${what}: the SDK's address is not the one the maker paid`);
        const payload = built.payload;
        validatePayload(payload);
        assert.equal(payload.swapId, escrow, what);
        assert.equal(payload.moneroWallet.escrowAddress, escrow, what);
        assert.equal(payload.receive.address, null, `${what}: a payload promising an address the chain does not hold`);
        revealed = makerSpend;
        const plan = await core.sweep.plan({ file: { contents: built.contents }, passphrase: "" });
        assert.equal(plan.address, paid, what);
        assert.equal(plan.restoreHeight, 2_100_000, what);
        assert.equal(plan.revealedHalf, true, what);
        // THE SUM, by the function sweep.keys runs, from the payload's own fields and the maker's whole half; the
        // keys are then checked against the address on the curve, not by the SDK.
        const w = payload.moneroWallet;
        const keys = spendKeysFromRevealedHalf({
          halves: halvesLib,
          ownSpendHalf: w.spendHalf,
          ownViewHalf: w.viewHalf,
          otherSpendPoint: w.otherSpendPoint,
          otherViewHalf: w.otherViewHalf,
          revealedHalf: makerSpend,
        });
        const address = decodeAddressKeys(paid);
        assert.equal(
          ed25519.Point.BASE.multiply(scalarFromMoneroHex(keys.privateSpendKey)).toHex(),
          String(address.spendPub).replace(/^0x/, ""),
          `${what}: spend key`,
        );
        assert.equal(
          ed25519.Point.BASE.multiply(scalarFromMoneroHex(keys.privateViewKey)).toHex(),
          String(address.viewPub).replace(/^0x/, ""),
          `${what}: view key`,
        );
        // The person's OWN half (a refunded buy, a sell they claimed) never gives keys: the sum check refuses it.
        assert.throws(
          () =>
            spendKeysFromRevealedHalf({
              halves: halvesLib,
              ownSpendHalf: w.spendHalf,
              ownViewHalf: w.viewHalf,
              otherSpendPoint: w.otherSpendPoint,
              otherViewHalf: w.otherViewHalf,
              revealedHalf: person.spendHalf,
            }),
          what,
        );
        cases += 1;
      }
    }
  }
  return `${cases} orders`;
});

await check("sweep.fromOrder refuses an order that does not fit the key, by what does not fit", async () => {
  const sdk = await import("@ninsei-labs/sdk");
  const { memoryAdapter } = await import("@ninsei-labs/sdk/adapters");
  const { takerHalves } = await import("@ninsei-labs/sdk/recovery");
  const core = sdk.createNinsei({
    settlement: { chain: "arbitrum-sepolia" },
    xmrNetwork: "stagenet",
    mode: "live",
    fetch: async () => {
      throw new TypeError("no service");
    },
    storage: sdkStore || (sdkStore = memoryAdapter()),
  });
  const person = takerHalves({ mnemonic: TEST_WORDS[1], chainId: 421614, index: 4 });
  const other = takerHalves({ mnemonic: TEST_WORDS[2], chainId: 421614, index: 4 });
  const word = (hex) => "0x" + String(hex).replace(/^0x/, "").padStart(64, "0");
  const base = { escrow: "0x" + "e5".repeat(20), index: 4, readyBy: 1_790_000_000, t1: 1_790_003_600 };
  const buy = {
    ...base,
    side: "locker",
    edPointLocker: word(person.spendPoint),
    edPointClaimer: word(other.spendPoint),
    edViewPointLocker: word(person.viewPoint),
  };
  const sell = {
    ...base,
    side: "claimer",
    edPointLocker: word(other.spendPoint),
    edPointClaimer: word(person.spendPoint),
    edViewPointLocker: word(person.makerViewPoint),
  };
  const verdict = async (order, mnemonic = TEST_WORDS[1], chainId = 421614) => {
    try {
      await core.sweep.fromOrder({ mnemonic, chainId, network: "arbitrum-sepolia", moneroNetwork: "stagenet", order });
      return "ok";
    } catch (e) {
      return (e.params && (e.params.why || e.params.field)) || e.code;
    }
  };
  assert.equal(await verdict(buy), "ok", "a buy that fits is refused");
  assert.equal(await verdict(sell), "ok", "a sell that fits is refused");
  // The same order read in the chain's other spelling (uppercase hex) fits as well.
  assert.equal(await verdict({ ...buy, edPointLocker: buy.edPointLocker.toUpperCase().replace("0X", "0x") }), "ok");
  const refusals = [
    ["a buy whose locker point is another key's", { ...buy, edPointLocker: word(other.spendPoint) }, "spend-point"],
    ["a sell whose claimer point is another key's", { ...sell, edPointClaimer: word(other.spendPoint) }, "spend-point"],
    ["a buy whose view point is another key's", { ...buy, edViewPointLocker: word(other.viewPoint) }, "own-view-point"],
    [
      "a sell whose maker chose its own view half",
      { ...sell, edViewPointLocker: word(other.makerViewPoint) },
      "maker-view-point",
    ],
    ["the person's halves read for another swap number", buy, "spend-point", TEST_WORDS[1], 421614, 5],
    ["the person's halves read on another chain", buy, "spend-point", TEST_WORDS[1], 42161, 4],
    ["an order with no side", { ...buy, side: "maker" }, "order.side"],
  ];
  for (const [what, order, why, mnemonic, chainId, index] of refusals) {
    const adjusted = index === undefined ? order : { ...order, index };
    assert.equal(await verdict(adjusted, mnemonic, chainId), why, what);
  }
  return `${refusals.length} refusals`;
});

await check("the page builds a withdrawal through sweep.fromOrder, not a local payload", async () => {
  const page = await read("recovery.js");
  assert.match(page, /sweep\.fromOrder\(\{/, "the page does not call sweep.fromOrder");
  assert.ok(!/found-swap|payloadOf|buildPayload/.test(page), "the page still builds a payload of its own");
  return "one call";
});

await check('the chain read is a real eth_call, never the "0x" stub', async () => {
  const page = await read("recovery.js");
  assert.ok(!/evmCall:\s*(?:async\s*)?\([^)]*\)\s*=>\s*["']0x["']/.test(page), "evmCall answers a constant");
  assert.match(
    page,
    /evmCall: \(request\) => evmCall\(chainId, request\)/,
    "the facade does not read the chain through lib/settlement.js",
  );
  const to = "0x" + "a".repeat(40);
  const data = "0x12345678";
  const fake = (answers) => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      const next = answers[calls.length - 1];
      if (next instanceof Error) throw next;
      return { ok: next.status === 200, status: next.status, json: async () => next.body };
    };
    return { calls, fetchImpl };
  };
  const [first, second, third] = SETTLEMENT["arbitrum-sepolia"].rpcs;
  // The first RPC answers: one POST, JSON, eth_call on the latest block with exactly the request.
  const ok = fake([{ status: 200, body: { jsonrpc: "2.0", id: 1, result: "0xbeef" } }]);
  assert.equal(await evmCall("arbitrum-sepolia", { to, data }, ok.fetchImpl), "0xbeef");
  assert.equal(ok.calls.length, 1);
  assert.equal(ok.calls[0].url, first);
  assert.equal(ok.calls[0].init.method, "POST");
  assert.equal(ok.calls[0].init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(ok.calls[0].init.body), {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to, data }, "latest"],
  });
  // A failed transport moves on; the next RPC's answer counts.
  const moves = fake([
    { status: 503, body: null },
    new TypeError("Failed to fetch"),
    { status: 200, body: { result: "0x" } },
  ]);
  assert.equal(await evmCall("arbitrum-sepolia", { to, data }, moves.fetchImpl), "0x");
  assert.deepEqual(
    moves.calls.map((c) => c.url),
    [first, second, third],
  );
  // A revert is the chain's answer: thrown at once, the next RPC is not asked.
  const reverts = fake([{ status: 200, body: { error: { code: 3, message: "execution reverted" } } }]);
  await assert.rejects(evmCall("arbitrum-sepolia", { to, data }, reverts.fetchImpl), /reverted/);
  assert.equal(reverts.calls.length, 1);
  // Nobody answers: unknown, thrown, never "0x".
  const none = fake([
    new TypeError("Failed to fetch"),
    { status: 429, body: null },
    { status: 200, body: { error: { code: -32005, message: "limit" } } },
  ]);
  await assert.rejects(evmCall("arbitrum-sepolia", { to, data }, none.fetchImpl), /no arbitrum-sepolia RPC answered/);
  assert.equal(none.calls.length, 3);
  // An unknown network or a malformed request is refused before any request.
  const idle = fake([]);
  await assert.rejects(evmCall("base", { to, data }, idle.fetchImpl), /unknown settlement network/);
  await assert.rejects(evmCall("arbitrum", { to: "0x12", data }, idle.fetchImpl), /bad address/);
  assert.equal(idle.calls.length, 0);
});

await check(
  "every settlement network is one the SDK knows, with its chain id, https RPCs and a Monero network of its kind",
  async () => {
    const { CHAINS } = await import("@ninsei-labs/sdk/networks");
    const names = Object.keys(SETTLEMENT);
    assert.ok(names.length > 0, "no settlement network listed");
    for (const name of names) {
      const chain = CHAINS.find((c) => c.id === name);
      assert.ok(chain, `${name} is not a chain the SDK knows`);
      assert.equal(SETTLEMENT[name].chainId, chain.chainId, `${name}: chain id`);
      assert.ok(SETTLEMENT[name].rpcs.length >= 2, `${name}: one RPC is one point of failure`);
      for (const url of SETTLEMENT[name].rpcs) assert.match(url, /^https:\/\/[^/?#]+\/?[^?#]*$/, `${name}: ${url}`);
      // TESTNET AND MAINNET NEVER MIX: a testnet settlement chain pairs with a test Monero network, a mainnet one with
      // mainnet, so a swap is never scanned on the other kind of chain.
      assert.ok(
        ["mainnet", "stagenet", "testnet"].includes(SETTLEMENT[name].monero),
        `${name}: Monero network ${SETTLEMENT[name].monero}`,
      );
      assert.equal(
        SETTLEMENT[name].monero === "mainnet",
        !chain.testnet,
        `${name}: a ${chain.testnet ? "testnet" : "mainnet"} chain paired with Monero ${SETTLEMENT[name].monero}`,
      );
      for (const [factory, since] of Object.entries(SETTLEMENT[name].factories)) {
        assert.match(factory, /^0x[0-9a-f]{40}$/, `${name}: factory ${factory} is not a lowercase address`);
        assert.ok(Number.isSafeInteger(since) && since > 0, `${name}: factory ${factory} starts at ${since}`);
      }
    }
    assert.equal(settlementOf("base"), null);
    assert.equal(settlementOf("__proto__"), null);
    return names.join(", ");
  },
);

// A KEY IS SEARCHED WHERE THE SDK HAS A LIVE FACTORY. A factory the SDK names that this page cannot read (no RPCs,
// no deployment block) must fail here, on the bump that brings it, instead of being searched from a guess or
// silently left out of "no swaps for this key".
await check(
  "the key is searched on every live factory the SDK names, from a block at or before its deployment",
  async () => {
    const { CHAINS } = await import("@ninsei-labs/sdk/networks");
    const { search, unreadable } = keyNetworks(CHAINS);
    assert.deepEqual(unreadable, [], "the SDK names a live factory this page cannot search");
    const live = CHAINS.filter((c) => c.escrow && c.escrow.mode === "live" && c.escrow.address && !c.hidden);
    assert.ok(live.length > 0, "the SDK names no live factory");
    assert.deepEqual(
      search.map((net) => net.id),
      live.map((c) => c.id),
    );
    for (const net of search) {
      const chain = CHAINS.find((c) => c.id === net.id);
      assert.equal(net.factory, chain.escrow.address);
      assert.equal(net.chainId, chain.chainId);
      assert.equal(net.since, SETTLEMENT[net.id].factories[chain.escrow.address.toLowerCase()]);
      assert.equal(net.monero, SETTLEMENT[net.id].monero);
    }
    // Examples, not the registry: a live chain the page has no RPCs for, a factory without a block, a hidden test
    // chain and a simulated one.
    const example = [
      { id: "base", chainId: 8453, escrow: { address: "0x" + "b".repeat(40), mode: "live" } },
      { id: "arbitrum", chainId: 42161, escrow: { address: "0x" + "c".repeat(40), mode: "live" } },
      {
        id: "arbitrum-sepolia",
        chainId: 421614,
        hidden: true,
        escrow: { address: "0x" + "d".repeat(40), mode: "live" },
      },
      {
        id: "arbitrum-sepolia",
        chainId: 1,
        escrow: { address: Object.keys(SETTLEMENT["arbitrum-sepolia"].factories)[0], mode: "live" },
      },
      { id: "mainnet", chainId: 1, escrow: { address: null, mode: "simulated" } },
    ];
    assert.deepEqual(keyNetworks(example), { search: [], unreadable: ["base", "arbitrum", "arbitrum-sepolia"] });
    return search.map((net) => `${net.id} from block ${net.since}`).join(", ");
  },
);

await check(
  "a log search is read in windows that cover its range exactly, and a window nobody answers fails it all",
  async () => {
    const factory = "0x" + "f".repeat(40);
    const topics = ["0x" + "1".repeat(64)];
    // Every window answers with one log naming the window it came from.
    const windowsOf = async (from, to) => {
      const asked = [];
      const fetchImpl = async (url, init) => {
        const filter = JSON.parse(init.body).params[0];
        asked.push(filter);
        return {
          ok: true,
          status: 200,
          json: async () => ({ result: [{ window: [filter.fromBlock, filter.toBlock] }] }),
        };
      };
      const logs = await evmLogs(
        "arbitrum-sepolia",
        { address: factory, topics, fromBlock: from, toBlock: to },
        fetchImpl,
      );
      return { asked, logs };
    };
    const ranges = [
      [0, 0],
      [5, 5 + LOG_WINDOW - 1],
      [5, 5 + LOG_WINDOW],
      [318_911_595, 321_471_445],
      [1, 3 * LOG_WINDOW + 7],
      [7, 7 + 10 * LOG_WINDOW - 1],
    ];
    for (const [from, to] of ranges) {
      const { asked, logs } = await windowsOf(from, to);
      const spans = asked.map((f) => [Number(BigInt(f.fromBlock)), Number(BigInt(f.toBlock))]);
      assert.equal(spans.length, Math.ceil((to - from + 1) / LOG_WINDOW), `${from}..${to}: ${spans.length} windows`);
      assert.equal(spans[0][0], from, `${from}..${to}: starts at ${spans[0][0]}`);
      assert.equal(spans[spans.length - 1][1], to, `${from}..${to}: ends at ${spans[spans.length - 1][1]}`);
      for (let i = 0; i < spans.length; i += 1) {
        assert.ok(
          spans[i][1] - spans[i][0] + 1 <= LOG_WINDOW && spans[i][1] >= spans[i][0],
          `${from}..${to}: window ${spans[i]}`,
        );
        if (i > 0)
          assert.equal(spans[i][0], spans[i - 1][1] + 1, `${from}..${to}: a gap or an overlap before ${spans[i]}`);
      }
      for (const filter of asked) {
        assert.equal(filter.address, factory);
        assert.deepEqual(filter.topics, topics);
      }
      assert.deepEqual(
        logs.map((log) => log.window),
        asked.map((f) => [f.fromBlock, f.toBlock]),
        `${from}..${to}: logs lost or out of order`,
      );
    }
    // The wide RPC refuses the range: the next RPC answers the same window.
    const [first, second] = SETTLEMENT["arbitrum-sepolia"].rpcs;
    const urls = [];
    const moved = await evmLogs(
      "arbitrum-sepolia",
      { address: factory, topics, fromBlock: 10, toBlock: 20 },
      async (url) => {
        urls.push(url);
        return url === first
          ? {
              ok: true,
              status: 200,
              json: async () => ({ error: { code: -32602, message: "query spans too many blocks" } }),
            }
          : { ok: true, status: 200, json: async () => ({ result: [{ n: 1 }] }) };
      },
    );
    assert.deepEqual(moved, [{ n: 1 }]);
    assert.deepEqual(urls, [first, second]);
    // One window that no RPC answers fails the whole read: no list with a hole in it.
    let calls = 0;
    await assert.rejects(
      evmLogs(
        "arbitrum-sepolia",
        { address: factory, topics, fromBlock: 0, toBlock: 2 * LOG_WINDOW },
        async (url, init) => {
          calls += 1;
          const filter = JSON.parse(init.body).params[0];
          return filter.fromBlock === "0x" + LOG_WINDOW.toString(16)
            ? { ok: false, status: 503, json: async () => null }
            : { ok: true, status: 200, json: async () => ({ result: [{ n: 1 }] }) };
        },
      ),
      /no arbitrum-sepolia RPC answered eth_getLogs/,
    );
    assert.ok(calls >= 2, `${calls} requests`);
    // A range that is not two block numbers is one request, as given.
    const { asked } = await windowsOf(1000, "latest");
    assert.deepEqual(
      asked.map((f) => [f.fromBlock, f.toBlock]),
      [["0x3e8", "latest"]],
    );
    return `${ranges.length} ranges`;
  },
);

// --- 2c. the start height of a found swap: the SDK's rule, the page's readers -------------------
const { evmBlockTime } = await import(pathToFileURL(join(ROOT, "lib", "settlement.js")).href);
const { moneroHeaderTime, moneroReaders, nodeFor, STAGENET_NODE } = await import(
  pathToFileURL(join(ROOT, "lib", "node.js")).href
);

// THE SDK OWNS THE START-HEIGHT RULE (findSwaps); the page owns the readers it hands over. The reported case: a
// reader that takes get_info's height for the top block, or refuses the genesis block's timestamp 0, gets no
// height from a real node. Orders are built the way the factory logs them, from a BIP39 test key.
await check(
  "the SDK's start height comes back through the page's readers from a node that answers like monerod",
  async () => {
    const { findSwaps, takerHalves } = await import("@ninsei-labs/sdk/recovery");
    const { ORDER_CREATED_TOPIC } = await import("@ninsei-labs/sdk/evm");
    const words = "legal winner thank year wave sausage worth useful legal winner thank yellow";
    const w = (v) => String(v).replace(/^0x/, "").padStart(64, "0");
    const logsFor = (blocks) =>
      blocks.map((block, index) => {
        const me = takerHalves({ mnemonic: words, chainId: 421614, index });
        return {
          topics: [
            ORDER_CREATED_TOPIC,
            "0x" + w((0xe000 + index).toString(16)),
            "0x" + w("44".repeat(20)),
            "0x" + w("55".repeat(20)),
          ],
          data:
            "0x" +
            [
              me.spendCommitment,
              "1".repeat(64),
              me.spendPoint,
              "2".repeat(64),
              me.viewPoint,
              "1",
              "0",
              "1",
              "1",
              "1",
              "0",
              "0",
              "0",
            ]
              .map(w)
              .join(""),
          blockNumber: "0x" + block.toString(16),
          transactionHash: "0x" + w((0xab00 + index).toString(16)),
          logIndex: "0x0",
        };
      });
    const search = async (node, times) => {
      const readers = await moneroReaders("https://node.example", "stagenet", node.probe, node.fetchImpl);
      assert.ok(readers, "no readers for a node on the swap's network");
      const blocks = times.map((_, i) => 1_000 + i);
      const found = await findSwaps({
        mnemonic: words,
        chainId: 421614,
        factory: "0x" + "f".repeat(40),
        // The five orders in this case use numbers 0..4. The SDK scans to `maxIndex`; the production default is
        // deliberately large, so the check names a small bound instead of deriving 100k unused numbers.
        maxIndex: 100,
        evmLogs: async () => logsFor(blocks),
        evmBlockTime: async (block) => times[block - 1_000],
        ...readers,
      });
      assert.equal(found.swaps.length, times.length, "not every order was found");
      return found.swaps.sort((a, b) => a.index - b.index);
    };
    const random = seeded(76);
    let cases = 0;
    for (let c = 0; c < 8; c += 1) {
      const count = 2 + Math.floor(random() * 3_000);
      const stamps = [0];
      let at = 1_700_000_000;
      for (let h = 1; h < count; h += 1) stamps.push((at += Math.floor(random() * 241)));
      const times = Array.from(
        { length: 5 },
        () => stamps[1] - 600 + Math.floor(random() * (stamps[count - 1] - stamps[1] + 1_200)),
      );
      const node = fakeMonerod(count, (h) => stamps[h]);
      const swaps = await search(node, times);
      for (let i = 0; i < times.length; i += 1) {
        // The expected answer reads every block, independently of the search: the last one at or before the order.
        let last = 0;
        for (let h = 0; h < count; h += 1) if (stamps[h] <= times[i]) last = h;
        assert.equal(
          swaps[i].startHeight,
          Math.max(0, last - 60),
          `count ${count}, order ${times[i]}: ${swaps[i].startHeightReason}`,
        );
        cases += 1;
      }
      assert.ok(
        node.asked.every((h) => h <= node.top),
        `count ${count}: a header past the top block was asked`,
      );
    }
    // A mainnet-sized chain at two minutes a block, and the ends: an order newer than the tip starts 60 below the top
    // block; one older than block 1 starts at 0.
    const t0 = 1_397_818_193;
    const mainnet = fakeMonerod(3_500_000, (h) => t0 + 120 * h);
    const ends = await search(mainnet, [
      t0 + 120 * 1_000_000,
      t0 + 120 * 3_400_000 + 119,
      t0 + 120 * 9_000_000,
      t0 + 60,
    ]);
    assert.deepEqual(
      ends.map((s) => s.startHeight),
      [1_000_000 - 60, 3_400_000 - 60, 3_499_999 - 60, 0],
    );
    return `${cases + 4} orders`;
  },
);

await check(
  "the page's Monero readers: the top block is get_info's height minus one, and genesis has the time 0",
  async () => {
    const node = fakeMonerod(1_000, (h) => 1_760_000_000 + 120 * h);
    const readers = await moneroReaders("https://node.example", "stagenet", node.probe, node.fetchImpl);
    assert.equal(await readers.moneroTip(), 999);
    assert.equal(await readers.moneroBlockTimestamp(0), 0);
    assert.equal(await readers.moneroBlockTimestamp(999), 1_760_000_000 + 120 * 999);
    await assert.rejects(readers.moneroBlockTimestamp(1_000), /get_block_header_by_height 1000: RPC -2/);
    // No reader for a node that does not answer on the swap's network, or does not answer at all.
    for (const [what, probe] of [
      ["another network", async () => ({ ok: true, network: "mainnet", height: 3_500_000 })],
      ["no answer", async () => ({ ok: false, why: "unreachable" })],
      [
        "a probe that throws",
        async () => {
          throw new Error("offline");
        },
      ],
      ["no blocks", async () => ({ ok: true, network: "stagenet", height: 0 })],
    ])
      assert.equal(await moneroReaders("https://node.example", "stagenet", probe, node.fetchImpl), null, what);
    assert.equal(await moneroReaders(null, "stagenet", node.probe, node.fetchImpl), null);
    // THE NODE FOR A SWAP: in this process the chosen node is the module's default (no link, no tab choice). On the
    // swap's network it is used; otherwise a stagenet swap takes the project's stagenet node and a mainnet one none.
    assert.equal(nodeFor("mainnet", "mainnet"), DEFAULT_NODE);
    assert.equal(nodeFor("stagenet", "stagenet"), DEFAULT_NODE);
    assert.equal(nodeFor("stagenet", "mainnet"), STAGENET_NODE);
    assert.equal(nodeFor("mainnet", "stagenet"), null);
    // The search hands findSwaps these readers, never the SDK's own node reader (xmrNodes), which asks for a header
    // past the top block.
    const page = (await read("recovery.js")).replace(/\/\/.*$/gm, "");
    const call = page.slice(page.indexOf("findSwaps({"), page.indexOf("});", page.indexOf("findSwaps({")));
    assert.match(call, /\.\.\.\(await moneroReaders\(/, "the search does not hand findSwaps the page's Monero readers");
    assert.match(
      call,
      /evmBlockTime: \(block\) => evmBlockTime\(/,
      "the search does not hand findSwaps the order's block time",
    );
    assert.ok(!/xmrNodes/.test(page), "the page hands findSwaps the SDK's own node reader");
    // The swap opens with the height the search returned; none is said with the SDK's reason.
    const open = bodyOf(page, "openSwap");
    assert.match(
      open,
      /const startHeight = Number\(row\.swap\.startHeight\) > 0 \? Number\(row\.swap\.startHeight\) : null;/,
      "the swap does not open with the SDK's start height",
    );
    assert.match(open, /row\.swap\.startHeightReason/, "a missing start height is not said with the SDK's reason");
  },
);

// THE TWO READERS: what they ask, and that a missing answer throws instead of reading as 0.
const fakeFetch = (answers) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = answers[calls.length - 1];
    if (next instanceof Error) throw next;
    return { ok: next.status === 200, status: next.status, json: async () => next.body };
  };
  return { calls, fetchImpl };
};

await check("the order's block time is one eth_getBlockByNumber, and no answer is unknown, never 0", async () => {
  const [first, second, third] = SETTLEMENT["arbitrum-sepolia"].rpcs;
  // The block of an example order; the answer is shaped as the JSON-RPC spec gives it (timestamp in hex seconds).
  const asks = fakeFetch([
    { status: 200, body: { jsonrpc: "2.0", id: 1, result: { number: "0x13293393", timestamp: "0x6a1c3f80" } } },
  ]);
  assert.equal(await evmBlockTime("arbitrum-sepolia", 321_467_283, asks.fetchImpl), 0x6a1c3f80);
  assert.equal(asks.calls.length, 1);
  assert.equal(asks.calls[0].url, first);
  assert.equal(asks.calls[0].init.method, "POST");
  assert.deepEqual(asks.calls[0].body, {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_getBlockByNumber",
    params: ["0x13293393", false],
  });
  // A failed transport, an unknown block (result null) and an RPC error move on; the next answer counts.
  const moves = fakeFetch([
    { status: 503, body: null },
    { status: 200, body: { result: null } },
    { status: 200, body: { result: { timestamp: "0x10" } } },
  ]);
  assert.equal(await evmBlockTime("arbitrum-sepolia", 7, moves.fetchImpl), 16);
  assert.deepEqual(
    moves.calls.map((c) => c.url),
    [first, second, third],
  );
  // Nobody answers with a time: thrown, never 0.
  const none = fakeFetch([
    new TypeError("Failed to fetch"),
    { status: 200, body: { error: { code: -32000, message: "header not found" } } },
    { status: 200, body: { result: { timestamp: "0x0" } } },
  ]);
  await assert.rejects(
    evmBlockTime("arbitrum-sepolia", 7, none.fetchImpl),
    /no arbitrum-sepolia RPC answered the time of block 7/,
  );
  assert.equal(none.calls.length, 3);
  // A bad block number or an unknown network is refused before any request.
  const idle = fakeFetch([]);
  for (const bad of [-1, 1.5, Number.NaN, "7", null])
    await assert.rejects(evmBlockTime("arbitrum-sepolia", bad, idle.fetchImpl), /bad block number/);
  await assert.rejects(evmBlockTime("base", 7, idle.fetchImpl), /unknown settlement network/);
  assert.equal(idle.calls.length, 0);
});

await check("a Monero block's time is one get_block_header_by_height, and no answer is unknown, never 0", async () => {
  const url = "https://node.example";
  // An answer shaped as monerod's get_block_header_by_height gives it; the height and the time are examples.
  const header = (height, timestamp) => ({
    status: 200,
    body: { jsonrpc: "2.0", id: "0", result: { status: "OK", block_header: { height, timestamp } } },
  });
  const asks = fakeFetch([header(2_000_000, 1_764_246_150)]);
  assert.equal(await moneroHeaderTime(url, 2_000_000, asks.fetchImpl), 1_764_246_150);
  assert.equal(asks.calls.length, 1);
  assert.equal(asks.calls[0].url, url + "/json_rpc");
  assert.equal(asks.calls[0].init.method, "POST");
  assert.equal(asks.calls[0].init.headers["content-type"], "application/json");
  assert.deepEqual(asks.calls[0].body, {
    jsonrpc: "2.0",
    id: "0",
    method: "get_block_header_by_height",
    params: { height: 2_000_000 },
  });
  assert.equal(await moneroHeaderTime(url, 0, fakeFetch([header(0, 0)]).fetchImpl), 0, "the genesis block's time is 0");
  const unknowns = [
    ["an HTTP error", { status: 500, body: null }],
    [
      "an RPC error",
      {
        status: 200,
        body: {
          error: {
            code: -2,
            message: "Requested block height: 2000000 greater than current top block height: 1999999",
          },
        },
      },
    ],
    ["another block's header", header(1_999_999, 1_764_246_000)],
    ["a header without a time", header(2_000_000, undefined)],
    ["a time of 0 for a block that is not the genesis block", header(2_000_000, 0)],
    ["a negative time", header(2_000_000, -5)],
    ["a time that is not a number", header(2_000_000, "1764246150")],
  ];
  for (const [what, answer] of unknowns) {
    await assert.rejects(
      moneroHeaderTime(url, 2_000_000, fakeFetch([answer]).fetchImpl),
      /get_block_header_by_height 2000000/,
      what,
    );
  }
  await assert.rejects(
    moneroHeaderTime(url, 2_000_000, fakeFetch([new TypeError("Failed to fetch")]).fetchImpl),
    TypeError,
  );
  const idle = fakeFetch([]);
  for (const bad of [-1, 2.5, Number.NaN, "5"])
    await assert.rejects(moneroHeaderTime(url, bad, idle.fetchImpl), /not a block height/);
  assert.equal(idle.calls.length, 0);
});

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
  for (const file of ["recovery.js", "diagnostics.js", "index.html", "diagnostics.html", ...LIB]) {
    const text = await read(file);
    for (const m of text.matchAll(/(?:src|href)="\/(?!\/)|from\s+"\/(?!\/)|import\("\/(?!\/)|fetch\("\/[a-z]/g)) {
      offenders.push(`${file}: ${m[0]}`);
    }
  }
  // The stylesheet's files (the fonts) follow the same rule, and a URL with a scheme would be another host.
  const css = await read("recovery.css");
  for (const m of css.matchAll(/url\(\s*["']?(?:\/|(?!data:)[a-z][a-z0-9+.-]*:)[^)]*\)/gi))
    offenders.push(`recovery.css: ${m[0]}`);
  assert.deepEqual(offenders, []);
});

// THE PAGE'S SCRIPTS ARE COPIED, NOT BUNDLED, so nothing in the build parses them: a name declared twice in one
// module is an early error that stops the whole page in the browser while every rule above reads the text happily.
await check("every script the page loads parses as a module", async () => {
  const { transform } = await import("esbuild");
  const files = ["recovery.js", "diagnostics.js", ...LIB, "locales/index.js", "locales/en/index.js"];
  const broken = [];
  for (const file of files) {
    try {
      await transform(await read(file), { loader: "js", format: "esm", logLevel: "silent" });
    } catch (e) {
      broken.push(`${file}: ${((e.errors && e.errors[0] && e.errors[0].text) || e.message).split("\n")[0]}`);
    }
  }
  assert.deepEqual(broken, []);
  return `${files.length} files`;
});

// A NAME THAT HIDES A BROWSER GLOBAL breaks every later use of the global in the same scope, and parses fine: a
// local `window` turned `window.__sweepFlow` after the scan into a TypeError, so no withdrawal could finish.
await check("no page code declares a name that hides the browser's window, document or location", async () => {
  const offenders = [];
  for (const file of ["recovery.js", "diagnostics.js", ...LIB]) {
    const text = (await read(file)).replace(/\/\/.*$/gm, "");
    for (const m of text.matchAll(
      /\b(?:let|const|var|function)\s+(window|document|location|self|navigator|globalThis)\b|[(,]\s*(window|document|location)\s*(?=[,)=])/g,
    )) {
      offenders.push(`${file}: ${m[0].trim()}`);
    }
  }
  assert.deepEqual(offenders, []);
});

// THE PAGE'S SCRIPTS ARE COPIED, NOT BUNDLED, so nothing in the build parses them: a name declared twice in one
// module is an early error that stops the whole page in the browser while every rule above reads the text happily.
await check("every script the page loads parses as a module", async () => {
  const { transform } = await import("esbuild");
  const files = ["recovery.js", "diagnostics.js", ...LIB, "locales/index.js", "locales/en/index.js"];
  const broken = [];
  for (const file of files) {
    try {
      await transform(await read(file), { loader: "js", format: "esm", logLevel: "silent" });
    } catch (e) {
      broken.push(`${file}: ${((e.errors && e.errors[0] && e.errors[0].text) || e.message).split("\n")[0]}`);
    }
  }
  assert.deepEqual(broken, []);
  return `${files.length} files`;
});

// THE WINDOW NEEDS THE ORDER'S DEADLINE, and a name the function does not have fails inside its try without a word:
// the window then never forms, and every withdrawal scans the whole chain.
await check("the lock window is given the found order's deadline", async () => {
  const sync = bodyOf(await read("recovery.js"), "syncWallet");
  assert.match(sync, /const deadline = deadlineOf\(current\.swap\);/, "the window's deadline is not the found order's");
  assert.match(sync, /restoreWindow\(\{[^}]*t1Sec[^}]*\}\)/, "the window is not given the deadline");
  assert.ok(!/\bpayload\b/.test(sync.replace(/\/\/.*$/gm, "")), "syncWallet reads a payload it does not have");
});

await check("no eval and no new Function in the page's own code", async () => {
  const offenders = [];
  for (const file of ["recovery.js", "diagnostics.js", ...LIB]) {
    const text = await read(file);
    if (/\beval\s*\(|new\s+Function\s*\(/.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

// THE KEYS LEAVE WITH THE TRANSFER. There is no "Forget" button: once the transaction is relayed the wallet closes
// and the file, its password and the signed transaction leave memory, while the txid stays on screen.
await check("the keys leave the tab once the transfer is sent", async () => {
  const page = await read("recovery.js");
  const html = await read("index.html");
  const send = bodyOf(page, "sendTx");
  assert.ok(/sweep\.relay\([\s\S]*await dropKeys\(\)/.test(send), "sendTx does not drop the keys after relaying");
  const drop = bodyOf(page, "dropKeys");
  for (const name of [
    "await closeWallet()",
    "key = null",
    "search = null",
    "contents = null",
    "signedToken = null",
    "clearKeyFields()",
  ]) {
    assert.ok(drop.includes(name), `dropKeys leaves ${name} out`);
  }
  assert.ok(bodyOf(page, "closeWallet").includes("adapter.close()"), "closeWallet does not close the wallet");
  assert.ok(!/id="forget"/.test(html), "index.html still has a Forget button");
});

// A RETRY MUST READ THE CHAIN AGAIN. A saved balance is a snapshot: a locked output can mature and a failed signature
// leaves a closed wallet behind the page's adapter. Every spending decision refreshes; a closed adapter is rebuilt.
await check("a withdrawal refreshes its balance and reopens a closed wallet", async () => {
  const page = await read("recovery.js");
  const withdraw = bodyOf(page, "withdraw");
  assert.match(withdraw, /await refreshBalance\(\)/, "withdraw decides on a saved balance");
  assert.ok(
    !/if \(!adapter\)[\s\S]{0,200}syncWallet\(\)/.test(withdraw),
    "withdraw still syncs only when there is no adapter",
  );
  const refresh = bodyOf(page, "refreshBalance");
  assert.match(refresh, /adapter\.sync\(\)/, "refreshBalance does not sync the open wallet");
  assert.match(refresh, /wallet\.getBalance\(\)/, "refreshBalance does not re-read the total");
  assert.match(refresh, /closeWallet\(\)[\s\S]*syncWallet\(\)/, "a closed wallet is not rebuilt");
});

// AN OPEN THAT A NEWER ROW REPLACED MUST NOT WRITE ITS CONTENTS OR PLAN UNDER THE NEW ROW. The delayed stagenet
// `get_info` is the measured case.
await check("an open swap has one context and drops a superseded continuation", async () => {
  const open = bodyOf(await read("recovery.js"), "openSwap");
  assert.match(open, /const stillCurrent = \(\) => current === row/, "openSwap has no row identity");
  assert.equal(
    (open.match(/if \(!stillCurrent\(\)\) return false/g) || []).length >= 3,
    true,
    "openSwap writes after an await without checking the row",
  );
});

// A LOST RELAY ANSWER IS NOT "NOT SENT". The transaction may be on the network; the session is consumed and the
// person must check the wallet before another attempt.
await check("a lost relay answer is reported as unknown, not as not sent", async () => {
  const send = bodyOf(await read("recovery.js"), "sendTx");
  assert.match(send, /flow\.err\.sendUnknown/, "sendTx still claims the transfer was not sent");
  assert.match(send, /signedToken = null/, "sendTx keeps a consumed session");
  assert.match(send, /confirmEl\.hidden = true/, "sendTx leaves the consumed confirmation visible");
});

// THE FACADE CACHES THE KEYED ADAPTER. Closing the adapter alone is not enough: the SDK must be disconnected and, when
// the key is dropped, the facades themselves must go.
await check("dropping the key disconnects the SDK wallet and clears the facades", async () => {
  const page = await read("recovery.js");
  assert.match(bodyOf(page, "closeWallet"), /core\.wallet\.disconnect\(\)/, "closeWallet leaves the facade connected");
  assert.match(bodyOf(page, "dropKeys"), /facades\.clear\(\)/, "dropKeys keeps a facade with the keyed adapter");
});

// A SPLIT SWEEP HAS MORE THAN ONE TRANSACTION. The completion panel must list every id, not only the first.
await check("the completion panel lists every transaction of a split sweep", async () => {
  const page = await read("recovery.js");
  assert.match(page, /showDone\(hashes\)/, "sendTx shows only one transaction");
  assert.match(bodyOf(page, "showDone"), /list\.map\(\(id\)/, "showDone does not draw every transaction");
});

// CACHING AND THE LOCAL SERVER. The nginx example must not keep unversioned page modules for a year; `bun run serve`
// must serve the checkout's dist; the Docker build must see the workflows its check reads.
await check("the nginx example revalidates page modules, serve uses dist, and Docker keeps .github", async () => {
  const nginx = await read("deploy/nginx.conf");
  assert.ok(!/\.\(css\|js\)\$ \{ expires 1y; \}/.test(nginx), "nginx still caches unversioned page code for a year");
  assert.ok(nginx.includes("expires -1;"), "nginx does not revalidate page code");
  const serve = await read("serve.bun.mjs");
  assert.match(serve, /process\.env\.ROOT \|\| "dist"/, "serve does not default to dist");
  const ignore = await read(".dockerignore");
  assert.ok(!/^\.github$/m.test(ignore), ".dockerignore hides the workflows the Docker check reads");
});

// THE FOUND ORDER ALREADY CARRIES ITS BLOCK TIME. Reading it again is a second chain call per row, and a null must
// stay unknown instead of becoming 1970.
await check("the search reuses the block time returned by findSwaps", async () => {
  const page = await read("recovery.js");
  assert.match(
    page,
    /const blockTime = swap\.blockTime === null \|\| swap\.blockTime === undefined \? NaN : Number\(swap\.blockTime\)/,
    "the search does not read the order's blockTime",
  );
  assert.match(
    page,
    /Number\.isFinite\(blockTime\) && blockTime >= 0[\s\S]{0,120}await evmBlockTime/,
    "the search still reads the block time first",
  );
});

// NOTHING LEAVES BEFORE "CONFIRM AND SEND": the search, the opening of a swap and the withdraw button read, build and
// sign; only the send button's step relays.
await check("nothing is sent before the confirmation", async () => {
  const html = await read("index.html");
  const page = await read("recovery.js");
  const confirm = /<div id="confirm"[^>]*>([\s\S]*?)<\/div>\s*<div id="done"/.exec(html);
  assert.ok(confirm, "no confirmation step");
  assert.match(confirm[1], /id="txInfo"/, "the confirmation does not show the transfer");
  assert.match(
    confirm[1],
    /<button id="send" [^>]*data-i18n="page\.btn\.send"/,
    "the send button is not in the confirmation",
  );
  for (const name of ["findKeySwaps", "openSwap", "withdraw", "syncWallet", "buildTx"]) {
    assert.ok(!/sweep\.relay|sendTx\(/.test(bodyOf(page, name)), `${name}() can send`);
  }
  assert.match(bodyOf(page, "sendTx"), /sweep\.relay\(/);
  assert.equal([...page.matchAll(/sweep\.relay\(/g)].length, 1, "sweep.relay is called from more than one place");
  assert.match(
    page,
    /sendBtn\.addEventListener\("click", \(\) => busy\(sendBtn, sendTx/,
    "the send button does not send",
  );
});

// THE START HEIGHT IS NEVER SHOWN AS 0: zero means "scan from Monero's first block", hours of work. The field is empty
// until the chain fills it, and a swap without a height is said in the step, with the field beside the warning.
await check(
  "the start height is empty until the chain fills it, and a missing one is asked for in the step",
  async () => {
    const page = await read("recovery.js");
    const html = await read("index.html");
    assert.match(html, /<input id="restoreHeight"[^>]*value=""/, "the height field starts with a value");
    assert.ok(!/heightInput\.value = "0"/.test(page), "the page writes 0 into the height field");
    const box = html.slice(html.indexOf('<div id="heightBox"'), html.indexOf('<div id="stepTransfer"'));
    assert.ok(box.length > 0, "no height box before the transfer");
    assert.match(box, /data-i18n="page\.warn\.height"/, "no warning for a swap without a start block");
    assert.match(box, /<input id="restoreHeight"/, "the height field is not beside the warning");
    assert.match(page, /heightBox\.hidden = height > 0/, "the field and the warning do not follow the height");
  },
);

// NOTHING OPENS BY ITSELF but what the person must answer: the start height (above) and the node list when no node
// answers well. The log is folded under the card, and no panel holds the flow.
await check("nothing folds the flow, and only the node list opens by itself, when the node fails", async () => {
  const page = await read("recovery.js");
  const html = await read("index.html");
  const card = html.slice(html.indexOf('<div class="card">'), html.indexOf('<section class="aside">'));
  assert.ok(card.length > 0, "no card in index.html");
  assert.ok(!/<details/.test(card), "a fold is back inside the card");
  assert.match(
    html,
    /<details class="techlog" id="techlog">[\s\S]*<pre id="log"/,
    "the log is not in the folded technical log",
  );
  assert.ok(!/\.open\s*=\s*true/.test(page), "the page opens a fold by itself");
  const opens = page.match(/setPanel\(true\)/g) || [];
  assert.equal(opens.length, 1, "the node list opens by itself in " + opens.length + " places");
  const drawAt = page.indexOf("function drawChecks(");
  const draw = page.slice(drawAt, page.indexOf("\n}\n", drawAt));
  assert.match(
    draw,
    /if \(checks\.node\.state === "bad" && !panelOpen\) setPanel\(true\);/,
    "the list does not open when the node fails",
  );
});

// THE PAGE TALKS TO NO SERVICE: its promise is that only the Monero node and the settlement chain hear from the tab.
// The SDK's service routes (height, the revealed half's fallback, the "withdrawn" mark) get a fetch that refuses
// without a request.
await check("the page talks to no service, so only the node and the chain hear from the tab", async () => {
  const page = await read("recovery.js");
  assert.ok(!/["']\.\/api["']|apiBase/.test(page), "the page names a service base");
  const build = bodyOf(page, "facadeFor");
  assert.match(build, /fetch: noService,/, "the SDK gets the browser's fetch for its service routes");
  assert.equal([...page.matchAll(/createNinsei\(/g)].length, 1, "a facade is built outside facadeFor");
  const at = page.indexOf("const noService =");
  const body = page.slice(at, page.indexOf("};", at) + 2);
  assert.match(body, /throw new TypeError/, "noService does not refuse");
  assert.ok(!/fetch\(/.test(body), "noService sends a request");
  assert.ok(
    !/sweep\.report|restoreHeight\(\{|reportRetry/.test(page),
    "the page still asks a service for the height or reports the withdrawal",
  );
});

// WHAT THE PAGE CHECKED IS SAID LINE BY LINE, and a change of node asks the node again, never the wallet: loading
// the wallet twice only repeated the same lines in the log.
await check("the checks are said line by line, and a change of node asks only the node", async () => {
  const page = await read("recovery.js");
  const html = await read("index.html");
  const { default: en } = await import(pathToFileURL(join(ROOT, "locales", "en", "index.js")).href);
  const names = ["wallet", "node", "secure"];
  for (const name of names) {
    assert.match(
      html,
      new RegExp(`<li id="check${name[0].toUpperCase() + name.slice(1)}"`),
      `no ${name} line in index.html`,
    );
    for (const state of ["wait", "ok", "bad"])
      assert.ok(en.strings[`check.${name}.${state}`], `no words for check.${name}.${state}`);
  }
  assert.match(page, /if \(!walletCheck\) walletCheck = loadWallet\(\);/, "the wallet is loaded again on every check");
  const run = page.slice(page.indexOf("async function runPreflight("), page.indexOf("function checkEnvironment("));
  assert.match(run, /checkWallet\(\)/, "the check runner does not go through checkWallet");
  assert.ok(!/loadWallet\(/.test(run), "the check runner loads the wallet itself");
  const choose = page.slice(page.indexOf("function chooseListed("), page.indexOf("function chooseOwn("));
  assert.match(choose, /checkEnvironment\(\)/, "picking a node does not ask it");
});

await check("the page stores nothing: no key, no word, no password in any storage", async () => {
  const page = await read("recovery.js");
  assert.ok(
    !/localStorage|sessionStorage|indexedDB|document\.cookie/.test(page),
    "recovery.js touches a browser storage",
  );
  // The one thing a module keeps is the node a person chose, for the tab.
  const writes = [];
  for (const file of LIB) {
    for (const m of (await read(file)).matchAll(/\b(?:localStorage|sessionStorage|indexedDB)\b[^;\n]*/g)) {
      if (/setItem|open\(/.test(m[0])) writes.push(`${file}: ${m[0].trim()}`);
    }
  }
  assert.deepEqual(writes, ["lib/node.js: sessionStorage.setItem(NODE_STORAGE_KEY, parsed.url)"]);
});

// THE WORDS STAY IN ONE VARIABLE: no log line, no window state and no field holds them after the search. A log line
// is built from SDK codes and public chain data; the window state carries the fingerprint, never the key.
await check("the 12 words never reach the log, the window state or a field after the search", async () => {
  const page = await read("recovery.js");
  const secret =
    /mnemonic|keyWordsInput\.value|keyPassInput\.value|keyFileText|spendHalf|viewHalf|privateSpendKey|privateViewKey/;
  const logs = [...page.matchAll(/\blog\((t\([^;]*)\);/g)].map((m) => m[1]);
  assert.ok(logs.length > 20, `only ${logs.length} log lines found`);
  for (const line of logs) assert.ok(!secret.test(line), `a log line names a secret: log(${line})`);
  const states = [...page.matchAll(/window\.__sweepFlow(?:\.\w+)? = ([^;]*);/g)].map((m) => m[1]);
  assert.ok(states.length > 5, `only ${states.length} window state writes found`);
  for (const state of states)
    assert.ok(!secret.test(state) && !/\bkey\b(?!\.fingerprint)/.test(state), `window state names a secret: ${state}`);
  const find = bodyOf(page, "findKeySwaps");
  assert.ok(
    find.indexOf("clearKeyFields()") >= 0 && find.indexOf("clearKeyFields()") < find.indexOf("keyNetworks("),
    "the words stay in the fields while the chain is searched",
  );
  assert.match(
    bodyOf(page, "clearKeyFields"),
    /keyWordsInput\.value = "";[\s\S]*keyFileText = null;[\s\S]*keyPassInput\.value = "";/,
  );
});

// IT IS THE "NINSEI KEY", NEVER A SEED. A word "seed" on the page only says that the key is not one, and "recovery
// key" appears only in the file's own first line (NINSEI RECOVERY KEY), which the SDK writes and people search for;
// the file name (ninsei-recovery-key-...) is the SDK's too.
await check(
  "the key is the Ninsei key, never a seed, and the page says it is not a wallet seed and Ninsei never asks for it",
  async () => {
    const html = await read("index.html");
    const texts = [...Object.entries(strings)].filter(([, v]) => typeof v === "string");
    // Every "seed" must be the one in "not a wallet seed": a text that says both still calls the key a seed once.
    const seeds = texts.filter(
      ([, v]) => (v.match(/seed/gi) || []).length !== (v.match(/not a wallet seed/gi) || []).length,
    );
    assert.deepEqual(
      seeds.map(([k]) => k),
      [],
      "a text calls something a seed",
    );
    assert.ok(!/seed/i.test(withoutComments(html)), "index.html says seed");
    assert.match(strings["page.hint.key"], /not a wallet seed/i);
    assert.match(strings["page.hint.key"], /Ninsei never asks for it/);
    assert.match(strings["page.hint.key"], /Ninsei key/);
    const named = texts.filter(([, v]) => /recovery key/i.test(v.replace(/NINSEI RECOVERY KEY/g, "")));
    assert.deepEqual(
      named.map(([k]) => k),
      [],
      "a text calls it a recovery key",
    );
    assert.ok(!/recovery key/i.test(withoutComments(html)), "index.html calls it a recovery key");
    assert.match(
      strings["page.find.lead"],
      /`ninsei-recovery-key`/,
      "the find block does not name the file the SDK writes",
    );
  },
);

// THE PER-SWAP FILE IS GONE WITH NO TRANSITION: no field opens one, and nothing the page loads reads one.
await check("no per-swap recovery file can be opened any more", async () => {
  const html = await read("index.html");
  const page = await read("recovery.js");
  const entry = await read("sdk-entry.js");
  assert.ok(!/id="file"|\.enc|page\.btn\.unlock|page\.step\.file/.test(html), "index.html still opens a per-swap file");
  assert.ok(
    !/decryptFile|isEncrypted|recovery\.open\(|onFileChosen|function openFile/.test(page),
    "recovery.js still reads a per-swap file",
  );
  assert.ok(
    !/decryptFile|isEncrypted|validatePayload/.test(entry),
    "the SDK entry still exports the per-swap file reader",
  );
  assert.match(html, /<input id="keyFile" type="file" accept="\.txt,text\/plain">/, "no field for the key file");
});

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
  "monero.worker.js",
  "assets/vendors/monero/monero-ts-browser.js",
  "assets/vendors/sdk/sdk-browser.js",
  "locales/index.js",
  "locales/available.js",
  "locales/en/index.js",
  "_headers",
  "build.json",
  "favicon.svg",
  ...LIB,
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

await check("both pages name the icon the build ships, so no browser asks for /favicon.ico", async () => {
  for (const file of ["index.html", "diagnostics.html"]) {
    const html = await readFile(join(DIST, file), "utf8");
    assert.match(html, /<link rel="icon" href="\.\/favicon\.svg" type="image\/svg\+xml">/, `${file} names no icon`);
  }
  const svg = await readFile(join(DIST, "favicon.svg"), "utf8");
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, "favicon.svg is not an SVG");
  // The CSP allows images from this origin and data: only; an icon that loads anything else would be blocked.
  assert.ok(!/(?:href|src)=|url\(/.test(svg), "favicon.svg loads another file");
});

// THE WALLET NEEDS NO ISOLATION (monero-ts 0.11.20 has no threads). A service worker that adds COEP would
// keep every request of the tab under require-corp for nothing, so none ships and none is registered.
await check("no isolation worker ships or is registered", async () => {
  for (const file of ["index.html", "diagnostics.html"]) {
    const html = await readFile(join(DIST, file), "utf8");
    assert.ok(!/coi\.js/.test(html), `${file} loads coi.js`);
  }
  assert.ok(!existsSync(join(DIST, "sw.js")) && !existsSync(join(DIST, "coi.js")), "dist/ ships an isolation worker");
  const page = await read("recovery.js");
  assert.ok(!/serviceWorker\.register\(/.test(page), "recovery.js registers a service worker");
});

await check("the header file sets the CSP and no COEP", async () => {
  const headers = await readFile(join(DIST, "_headers"), "utf8");
  assert.match(headers, /Content-Security-Policy:\s*default-src 'self'/i);
  assert.match(headers, /Cross-Origin-Opener-Policy:\s*same-origin/i);
  assert.ok(!/Cross-Origin-Embedder-Policy/i.test(headers), "_headers still sets COEP");
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
  if (!/workflow_dispatch:/.test(release))
    problems.push("release.yml cannot publish an existing tag whose first run failed");
  if (!/\$TAG/.test(release)) problems.push("release.yml does not use the tag it was asked about");
  const codeql = await readFile(join(dir, "codeql.yml"), "utf8");
  if (!/github\/codeql-action\/init@v\d/.test(codeql) || !/github\/codeql-action\/analyze@v\d/.test(codeql)) {
    problems.push("codeql.yml does not run the CodeQL init and analyze actions");
  }
  if (!/security-events:\s*write/.test(codeql))
    problems.push("codeql.yml cannot upload its findings: no security-events: write");
  if (!/build-mode:\s*none/.test(codeql)) problems.push("codeql.yml tries to build a language that has no compiler");
  assert.deepEqual(problems, []);
  return `${files.length} workflows`;
});

console.log(`\n${pass} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
