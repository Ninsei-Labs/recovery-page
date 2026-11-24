// Run the page's node, key-file, search and swap-opening paths. These checks replace source regexes: the page module
// is bundled in memory and driven with a small DOM and fake SDK/chain seams, so a correct-looking string cannot pass.
import assert from "node:assert/strict";
import { DEFAULT_NODE, NODES } from "../lib/node.js";
import { SETTLEMENT } from "../lib/settlement.js";
import { address, fakeCore, pageBundle, row } from "./check-send.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function response(result) {
  return { ok: true, status: 200, json: async () => ({ result }) };
}

export async function checkNodeProbe() {
  const probes = [];
  const sdk = {
    probeMoneroNode: async ({ url }) => {
      probes.push(url);
      return { ok: true, network: "mainnet", synchronized: true, height: 100, ms: 1 };
    },
  };
  const { page } = await pageBundle({ rowSdk: sdk });
  await page.startNode();
  assert.equal(probes.length, 0, "opening the page must not probe a node");
  await page.recheck();
  assert.ok(probes.length > 0, "a tab return rechecks the chosen node");
  assert.ok(
    probes.every((url) => url === DEFAULT_NODE),
    "a tab return probes a node that is not chosen",
  );
  assert.ok(
    !probes.some((url) => NODES.includes(url) && url !== DEFAULT_NODE),
    "a tab return probes every listed node",
  );
  return `${probes.length} probes of the chosen node only`;
}

// THE PAGE USES A LISTED NODE, WHATEVER THE LINK OR THE TAB HOLDS. A link names nothing (`?node=` is not read), a
// value kept by an earlier build that is not on the list is ignored, and only a listed node this tab chose is taken.
// Which node the page uses is read from what it asks: the tab-return check probes the chosen node.
export async function checkListedNodeOnly() {
  const cases = [
    { name: "a link to another host", search: "?node=https://example.test", kept: null, uses: DEFAULT_NODE },
    {
      name: "a link to a listed node",
      search: `?node=${encodeURIComponent(NODES[2])}`,
      kept: null,
      uses: DEFAULT_NODE,
    },
    { name: "a loopback link", search: "?node=http://127.0.0.1:18081", kept: null, uses: DEFAULT_NODE },
    { name: "another host kept for the tab", search: "", kept: "https://kept.example.test", uses: DEFAULT_NODE },
    { name: "a listed node kept for the tab", search: "", kept: NODES[1], uses: NODES[1] },
    { name: "a link beside a listed node kept", search: "?node=https://example.test", kept: NODES[1], uses: NODES[1] },
  ];
  for (const { name, search, kept, uses } of cases) {
    const probes = [];
    const sdk = {
      probeMoneroNode: async ({ url }) => {
        probes.push(url);
        return { ok: true, network: "mainnet", synchronized: true, height: 100, ms: 1 };
      },
    };
    const stored = new Map(kept ? [["ninsei.recovery.node", kept]] : []);
    const { page } = await pageBundle({
      rowSdk: sdk,
      context: {
        // The web's URL classes, as a browser has them: without them a reader of `?node=` would fail quietly.
        URL,
        URLSearchParams,
        location: { search, origin: "https://example.invalid", href: "https://example.invalid/" + search },
        sessionStorage: {
          getItem: (key) => (stored.has(key) ? stored.get(key) : null),
          setItem: (key, value) => stored.set(key, value),
          removeItem: (key) => stored.delete(key),
        },
      },
    });
    await page.startNode();
    await page.recheck();
    assert.ok(probes.length > 0, `${name}: the page asked no node`);
    assert.deepEqual([...new Set(probes)], [uses], `${name}: the page asked ${[...new Set(probes)].join(", ")}`);
  }
  return `${cases.length} links and kept values, a listed node used each time`;
}

export async function checkKeyFile() {
  const calls = [];
  const sdk = {
    openRecoveryKeyFile: async (text, pass) => {
      calls.push({ text, pass });
      if (text === "sealed") throw { code: "recovery-failed", params: { stage: "passphrase" } };
      if (text === "plain") return { mnemonic: "words", fingerprint: "fp" };
      throw { code: "recovery-failed", params: { stage: "parse" } };
    },
  };
  const { page, elements } = await pageBundle({ rowSdk: sdk });
  const file = elements.get("keyFile");
  const passField = elements.get("keyPassField");
  const words = elements.get("keyWords");

  file.files = [{ size: 10, text: async () => "sealed" }];
  await page.onKeyFileChosen();
  assert.equal(passField.hidden, false, "a sealed file must ask for its password");
  assert.equal(calls[0].pass, "", "the page asks the SDK without guessing a password");
  assert.equal(words.value, "", "a chosen file must clear the typed words");

  file.files = [{ size: 10, text: async () => "plain" }];
  await page.onKeyFileChosen();
  assert.equal(passField.hidden, true, "a plain file must not ask for a password");

  file.files = [{ size: 10, text: async () => "broken" }];
  await page.onKeyFileChosen();
  assert.equal(page.__state().keyText, "flow.err.keyFile", "an unreadable key file must be named");
  assert.equal(passField.hidden, true, "an unreadable file must not ask for a password");

  const before = calls.length;
  file.files = [{ size: 1_000_001, text: async () => "too large" }];
  await page.onKeyFileChosen();
  assert.equal(calls.length, before, "an oversized file must be refused before it is read");
  assert.equal(page.__state().keyText, "flow.err.keyFileTooLarge");
  return "passphrase, plain, malformed and oversized key files follow the SDK stage";
}

export async function checkFindSwaps() {
  const events = [];
  const filters = [];
  const blockReads = [];
  const fetches = [];
  let findInput = null;
  const chain = "0x" + "12".repeat(20);
  const escrow = "0x" + "ab".repeat(20);
  const sdk = {
    CHAINS: [{ id: "arbitrum-sepolia", chainId: 421614, escrow: { mode: "live", address: chain } }],
    probeMoneroNode: async () => ({ ok: true, network: "stagenet", height: 100, synchronized: true, ms: 1 }),
    findSwaps: async (input) => {
      findInput = input;
      return {
        complete: true,
        swaps: [
          { escrow, side: "locker", blockNumber: 100, blockTime: 1234 },
          { escrow: "0x" + "cd".repeat(20), side: "locker", blockNumber: 200, blockTime: null },
        ],
      };
    },
    readEscrowEventsByTopic: async (input) => {
      events.push(input);
      await input.evmLogs({
        topics: ["0x" + "11".repeat(32)],
        fromBlock: input.fromBlock,
        toBlock: input.toBlock,
      });
      return [];
    },
  };
  const fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    fetches.push(request.method);
    if (request.method === "eth_blockNumber") return response("0x100");
    if (request.method === "eth_getBlockByNumber") {
      blockReads.push(request);
      return response({ timestamp: "0x7b" });
    }
    if (request.method === "eth_getLogs") {
      filters.push(request.params[0]);
      return response([]);
    }
    throw new Error("unexpected request: " + request.method);
  };
  const { page } = await pageBundle({ rowSdk: sdk, context: { fetch } });
  page.__seed({
    key: { mnemonic: "words", fingerprint: "fp" },
    nodeNetwork: "stagenet",
  });
  assert.equal(await page.findKeySwaps(), true);
  assert.equal(events.length, 1, "the escrow events must be read once");
  assert.deepEqual(
    Object.keys(events[0]).sort(),
    ["evmLogs", "fromBlock", "toBlock"],
    "the escrow read must not name the visitor's escrows",
  );
  assert.equal(events[0].fromBlock, 100, "the escrow read must start at the earliest found order");
  assert.equal(events[0].toBlock, 256, "the escrow read must end at the current chain head");
  assert.equal(filters.length, 1, "the topic read must reach the RPC");
  assert.deepEqual(
    Object.keys(filters[0]).sort(),
    ["fromBlock", "toBlock", "topics"],
    "the RPC filter must carry no escrow address",
  );
  assert.equal(typeof findInput.moneroTip, "function", "the SDK must receive the node's tip reader");
  assert.equal(typeof findInput.moneroBlockTimestamp, "function", "the SDK must receive the block-time reader");
  assert.equal(blockReads.length, 1, "a null block time must be read from the chain");
  assert.equal(blockReads[0].params[0], "0xc8", "the block read must name the null-time order's block");
  assert.deepEqual(
    fetches,
    ["eth_blockNumber", "eth_getBlockByNumber", "eth_getLogs"],
    "only the head, the missing time and the topic read are requested",
  );
  return "the search reads events without addresses, reuses a returned block time and reads a null time";
}

// THE KEY SEARCH OVER SEVERAL NETWORKS, read from what the page shows and what it asks the SDK. A network that does
// not answer completely (findSwaps throws or says `complete: false`, or its swaps' escrow events cannot be read) is
// named, keeps "no swaps" hidden and leaves the retry on; the swaps another network found stay through the failure
// and every retry. Once every network has answered completely the retry goes, and "no swaps" shows if none was found.
//
// lib/settlement.js reads one settlement chain today, so the second network is a second registry entry for the same
// chain under another name: a synthetic example. Both send findSwaps the same request, so the fake SDK answers the
// calls in the order the registry lists the networks, and each step checks its number of calls before anything else.
const FIRST = "First network";
const SECOND = "Second network";
// THE REQUEST FIELDS findSwaps DECLARES (@ninsei-labs/sdk, recovery.d.ts). Its search is complete in one call: an index
// range, an abort signal or a progress callback is not among them, so a control built on one (a range, Stop,
// progress) would show the person something the search does not do.
const FIND_SWAPS_FIELDS = [
  "mnemonic",
  "chainId",
  "factory",
  "factories",
  "address",
  "evmLogs",
  "fromBlock",
  "deploymentBlock",
  "toBlock",
  "evmBlockTime",
  "evmBlockTimes",
  "evmCode",
  "moneroTip",
  "moneroBlockTimestamp",
  "xmrNodes",
  "moneroNetwork",
  "fetchImpl",
];

export async function checkKeySearchRetry() {
  // EVERY FACTORY THE CHAIN HAD, each with its own deployment block, as findSwaps declares `factories`. More than one,
  // so a search that names only the current factory cannot pass.
  const factories = Object.entries(SETTLEMENT["arbitrum-sepolia"].factories).map(([address, deploymentBlock]) => ({
    address,
    deploymentBlock,
  }));
  assert.ok(factories.length > 1, "the settlement chain lists one factory: the check needs its history");

  // SYNTHETIC ANSWERS. Two buys (the person locked the ETH): 1.5 and 0.25 ETH, open until t1 in 2033. Their escrow
  // events claim the first: the maker revealed its half, so that XMR can be withdrawn; the second has no event and
  // waits. A decline of an escrow this key did not find must change neither.
  const empty = { complete: true, swaps: [] };
  const incomplete = { complete: false, swaps: [] };
  const thrown = () => new Error("example: no RPC answered");
  const escrowA = "0x" + "a1".repeat(20);
  const escrowB = "0x" + "a2".repeat(20);
  const terms = { side: "locker", t1: 2_000_000_000, readyBy: 1_999_999_000 };
  const found = {
    complete: true,
    swaps: [
      { ...terms, escrow: escrowA, amount: "1500000000000000000", blockNumber: 210, blockTime: 1_700_000_000 },
      { ...terms, escrow: escrowB, amount: "250000000000000000", blockNumber: 200, blockTime: 1_700_000_100 },
    ],
  };
  const events = [
    { escrow: escrowA, event: "HalfRevealed", half: "0x" + "3".repeat(64), byClaimer: true, blockNumber: 220 },
    { escrow: "0x" + "ee".repeat(20), event: "Declined", by: "0x" + "4".repeat(40), blockNumber: 230 },
  ];
  // What the list shows for those two swaps: with their events read, or unknown while they cannot be read.
  const rows = (network, read) => [
    { network, amount: "swap.amount(amount=0.25, symbol=ETH)", action: read ? "later" : "unknown" },
    { network, amount: "swap.amount(amount=1.5, symbol=ETH)", action: read ? "withdraw" : "unknown" },
  ];

  // Each step: the answers findSwaps and the escrow-event read give, in the order they are asked, then what the page
  // must show: the network named as not searched (or none), the rows, "no swaps" and the retry.
  const cases = [];
  for (const [kind, failure] of [
    ["throws", thrown],
    ["answers complete: false", () => incomplete],
  ]) {
    for (const failing of [FIRST, SECOND]) {
      const other = failing === FIRST ? SECOND : FIRST;
      const inOrder = (mine, theirs) => (failing === FIRST ? [mine, theirs] : [theirs, mine]);
      cases.push({
        name: `${failing} ${kind} and ${other} finds nothing`,
        steps: [
          { finds: inOrder(failure(), empty), events: [], failed: failing, rows: [], none: false, retry: true },
          { finds: [failure()], events: [], failed: failing, rows: [], none: false, retry: true },
          { finds: [empty], events: [], failed: null, rows: [], none: true, retry: false },
        ],
      });
      const two = rows(other, true);
      cases.push({
        name: `${failing} ${kind} and ${other} finds two swaps`,
        steps: [
          { finds: inOrder(failure(), found), events: [events], failed: failing, rows: two, none: false, retry: true },
          { finds: [failure()], events: [], failed: failing, rows: two, none: false, retry: true },
          { finds: [empty], events: [], failed: null, rows: two, none: false, retry: false },
        ],
      });
    }
  }
  cases.push({
    name: `${FIRST} finds two swaps whose events cannot be read and ${SECOND} finds nothing`,
    steps: [
      { finds: [found, empty], events: [thrown()], failed: FIRST, rows: rows(FIRST, false), none: false, retry: true },
      { finds: [found], events: [thrown()], failed: FIRST, rows: rows(FIRST, false), none: false, retry: true },
      { finds: [found], events: [events], failed: null, rows: rows(FIRST, true), none: false, retry: false },
    ],
  });

  for (const { name, steps } of cases) {
    const finds = [];
    const reads = [];
    const filters = [];
    const asked = [];
    const perEscrow = [];
    let answers = { finds: [], events: [] };
    const perOrder = (what) => async (escrow) => {
      perEscrow.push(`${what} ${escrow}`);
      return { isFunded: true, isClaimed: false, isRefunded: false, isReady: false };
    };
    const sdk = {
      CHAINS: [FIRST, SECOND].map((chainName) => ({
        id: "arbitrum-sepolia",
        name: chainName,
        chainId: 421614,
        escrow: { mode: "live", address: "0x" + "12".repeat(20) },
      })),
      probeMoneroNode: async () => ({ ok: true, network: "stagenet", height: 100, synchronized: true, ms: 1 }),
      findSwaps: async (input) => {
        finds.push(input);
        const answer = answers.finds.length ? answers.finds.shift() : empty;
        if (answer instanceof Error) throw answer;
        return answer;
      },
      readEscrowEventsByTopic: async (input) => {
        reads.push(input);
        await input.evmLogs({
          topics: [["0x" + "11".repeat(32), "0x" + "22".repeat(32), "0x" + "33".repeat(32)]],
          fromBlock: input.fromBlock,
          toBlock: input.toBlock,
        });
        const answer = answers.events.length ? answers.events.shift() : [];
        if (answer instanceof Error) throw answer;
        return answer;
      },
      // The per-order reads of the facade: the search must not name the found escrows one by one.
      createNinsei: () => ({
        order: { status: perOrder("status"), deadlines: perOrder("deadlines"), decline: perOrder("decline") },
      }),
    };
    const fetch = async (_url, init) => {
      const request = JSON.parse(init.body);
      asked.push(request.method);
      if (request.method === "eth_blockNumber") return response("0x100");
      if (request.method === "eth_getLogs") {
        filters.push(request.params[0]);
        return response([]);
      }
      throw new Error("unexpected request: " + request.method);
    };
    // A text with its parameters, so a line that names a network or an amount can be read.
    const pageText = (key, params) => {
      const shown = Object.entries(params || {}).map(([k, v]) => `${k}=${v}`);
      return shown.length ? `${key}(${shown.join(", ")})` : key;
    };
    const { page, elements } = await pageBundle({ rowSdk: sdk, context: { fetch, pageText } });
    page.__seed({ key: { mnemonic: "words", fingerprint: "fp" }, nodeNetwork: "stagenet" });
    const result = elements.get("keyResult");
    const none = elements.get("keyNone");
    const partial = elements.get("keyPartial");
    let retry = null;
    let retryRow = null;
    walk(result, (node, parent) => {
      if (node.id === "keyMore") [retry, retryRow] = [node, parent];
    });
    assert.ok(retry, `${name}: the page builds no retry in the key result`);

    for (const [at, step] of steps.entries()) {
      const label = `${name}, ${at ? `retry ${at}` : "the search"}`;
      answers = { finds: [...step.finds], events: [...step.events] };
      const before = { finds: finds.length, reads: reads.length };
      await (at ? retry.listeners.click() : page.findKeySwaps());
      assert.equal(
        finds.length - before.finds,
        step.finds.length,
        `${label}: findSwaps asked ${finds.length - before.finds} times, not once for each network still unread`,
      );
      assert.equal(
        reads.length - before.reads,
        step.events.length,
        `${label}: ${reads.length - before.reads} escrow-event reads, not one for each network with swaps`,
      );
      assert.deepEqual(
        [...new Set(asked)].filter((method) => method !== "eth_blockNumber" && method !== "eth_getLogs"),
        [],
        `${label}: the search asked the RPC for more than the head and the topic logs`,
      );

      assert.equal(result.hidden, false, `${label}: the key result is hidden`);
      const shown = swapsShown(elements.get("swapList"));
      assert.equal(shown.length, step.rows.length, `${label}: ${shown.length} rows shown, not ${step.rows.length}`);
      assert.deepEqual(shown, step.rows, `${label}: the rows shown`);
      if (step.none) assert.equal(none.hidden, false, `${label}: "no swaps" is hidden after a complete empty search`);
      else assert.equal(none.hidden, true, `${label}: "no swaps" is shown while a network is unread or swaps exist`);
      if (step.retry) {
        assert.equal(retry.hidden || retryRow.hidden, false, `${label}: the retry is hidden after a failed network`);
        assert.equal(retry.disabled, false, `${label}: the retry is disabled after a failed network`);
      } else {
        assert.equal(retry.hidden || retryRow.hidden, true, `${label}: the retry is shown after a complete search`);
      }
      if (step.failed) {
        assert.equal(partial.hidden, false, `${label}: the unread network is not named`);
        assert.ok(partial.textContent.includes(step.failed), `${label}: "${partial.textContent}" does not name it`);
        const answered = step.failed === FIRST ? SECOND : FIRST;
        assert.ok(!partial.textContent.includes(answered), `${label}: "${partial.textContent}" names ${answered}`);
      } else {
        assert.equal(partial.hidden, true, `${label}: a network is named as unread after every network answered`);
      }
    }

    // WHAT THE SEARCH ASKED, over every call of every step. The page's arrays come from another realm, so the
    // factories are compared as data.
    for (const input of finds) {
      const extra = Object.keys(input).filter((field) => !FIND_SWAPS_FIELDS.includes(field));
      assert.deepEqual(extra, [], `${name}: the search passes ${extra.join(", ")}, which findSwaps does not take`);
      assert.equal(input.mnemonic, "words", `${name}: the search does not use the key's words`);
      assert.equal(input.chainId, 421614, `${name}: the search names another chain`);
      assert.deepEqual(
        JSON.parse(JSON.stringify(input.factories)),
        factories,
        `${name}: the search does not name every factory`,
      );
      assert.equal(input.toBlock, 256, `${name}: the search does not end at the chain head`);
    }
    for (const read of reads)
      assert.deepEqual(
        Object.keys(read).sort(),
        ["evmLogs", "fromBlock", "toBlock"],
        `${name}: the escrow-event read names more than its range`,
      );
    assert.equal(filters.length, reads.length, `${name}: an escrow-event read did not reach the RPC`);
    assert.ok(
      filters.every((filter) => !("address" in filter)),
      `${name}: an escrow address reached the RPC`,
    );
    assert.deepEqual(perEscrow, [], `${name}: the search read the found escrows one by one`);
    const controls = [];
    walk(result, (node) => {
      if (["button", "input", "select"].includes(node.tag)) controls.push(node.id || node.tag);
    });
    assert.deepEqual(controls, ["keyMore"], `${name}: the key result has controls besides the retry`);
  }
  return `${cases.length} failures on one of two networks: named, retried twice, rows kept, "no swaps" only at the end`;
}

function walk(node, visit, parent = null) {
  visit(node, parent);
  for (const child of node.children || []) walk(child, visit, node);
}

// The rows of the swap list: the network from the date line, the amount as written, and the action the row offers,
// ordered by amount so the check does not depend on the list's order.
function swapsShown(list) {
  return list.children
    .map((item) => {
      const text = (className) => {
        let value = null;
        walk(item, (node) => {
          if (node.className === className) value = node.textContent;
        });
        return value;
      };
      return {
        network: String(text("swap-date")).split(" · ").pop(),
        amount: text("swap-amount"),
        action: item.attributes["data-action"],
      };
    })
    .sort((a, b) => a.amount.localeCompare(b.amount));
}

export async function checkSwapRace() {
  const first = { ...row, swap: { ...row.swap, escrow: "0x" + "a1".repeat(20) } };
  const second = { ...row, swap: { ...row.swap, escrow: "0x" + "b2".repeat(20) } };
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  };
  const makeRace = async () => {
    const core = fakeCore();
    const from = new Map();
    const plans = [];
    core.sweep.fromOrder = ({ order }) => {
      const gate = deferred();
      from.set(order.escrow, gate);
      return gate.promise;
    };
    core.sweep.plan = () => {
      const gate = deferred();
      plans.push(gate);
      return gate.promise;
    };
    const { page } = await pageBundle();
    page.facades.set("testnet/testnet", core);
    page.__seed({ key: { mnemonic: "words", fingerprint: "fp" }, nodeNetwork: "testnet" });
    return { page, from, plans };
  };

  // A PLAN THAT RESOLVES AFTER A NEWER ROW WAS OPENED MUST NOT WRITE UNDER IT.
  {
    const { page, from, plans } = await makeRace();
    const a = page.openSwap(first);
    await tick();
    assert.ok(from.has(first.swap.escrow), "the first swap reaches fromOrder");
    from.get(first.swap.escrow).resolve({ contents: { id: "A" }, address: "A" });
    await tick();
    assert.equal(plans.length, 1, "the first swap reaches its plan");

    const b = page.openSwap(second);
    await tick();
    assert.ok(from.has(second.swap.escrow), "the second swap reaches fromOrder");
    from.get(second.swap.escrow).resolve({ contents: { id: "B" }, address: "B" });
    await tick();
    assert.equal(plans.length, 2, "the second swap reaches its plan");
    plans[1].resolve({ address: "B", restoreHeight: 1, missing: [], revealedHalf: true });
    assert.equal(await b, true);

    plans[0].resolve({ address: "A", restoreHeight: 1, missing: [], revealedHalf: true });
    assert.equal(await a, false, "a superseded plan must stop");
    const state = page.__state();
    assert.equal(state.current, second, "the second swap stays current");
    assert.equal(state.plan.address, "B", "the first plan must not overwrite the second");
    assert.equal(state.contents.id, "B", "the first contents must not overwrite the second");
  }

  // A fromOrder THAT RESOLVES AFTER A NEWER ROW WAS OPENED MUST STOP before it builds a plan.
  {
    const { page, from, plans } = await makeRace();
    const a = page.openSwap(first);
    await tick();
    const b = page.openSwap(second);
    await tick();
    assert.ok(from.has(second.swap.escrow), "the second swap reaches fromOrder");
    from.get(first.swap.escrow).resolve({ contents: { id: "A" }, address: "A" });
    await tick();
    assert.equal(plans.length, 0, "a superseded fromOrder must not build a plan");
    assert.equal(await a, false, "a superseded fromOrder must stop");
    assert.equal(page.__state().contents, null, "the first contents must not be written under the second");

    from.get(second.swap.escrow).resolve({ contents: { id: "B" }, address: "B" });
    await tick();
    assert.equal(plans.length, 1, "the second swap reaches its plan");
    plans[0].resolve({ address: "B", restoreHeight: 1, missing: [], revealedHalf: true });
    assert.equal(await b, true);
    assert.equal(page.__state().contents.id, "B", "the second contents are written");
  }

  // A fromOrder THAT FAILS AFTER A NEWER ROW WAS OPENED MUST NOT WRITE ITS ERROR UNDER IT.
  {
    const { page, from, plans } = await makeRace();
    const a = page.openSwap(first);
    await tick();
    const b = page.openSwap(second);
    await tick();
    assert.ok(from.has(second.swap.escrow), "the second swap reaches fromOrder");
    from.get(first.swap.escrow).reject(new Error("fromOrder failed for a superseded row"));
    await tick();
    assert.equal(await a, false, "a superseded failure must stop");
    assert.equal(page.__state().openErrorText, "", "a superseded failure must not write under the new row");
    assert.equal(page.__state().contents, null, "the first failure must not write under the new row");

    from.get(second.swap.escrow).resolve({ contents: { id: "B" }, address: "B" });
    await tick();
    assert.equal(plans.length, 1, "the second swap reaches its plan");
    plans[0].resolve({ address: "B", restoreHeight: 1, missing: [], revealedHalf: true });
    assert.equal(await b, true);
    assert.equal(page.__state().contents.id, "B", "the second contents are written");
  }

  return "a superseded open, error and plan do not overwrite the current swap";
}

if (import.meta.main) {
  console.log("ok    " + (await checkNodeProbe()));
  console.log("ok    " + (await checkListedNodeOnly()));
  console.log("ok    " + (await checkKeyFile()));
  console.log("ok    " + (await checkFindSwaps()));
  console.log("ok    " + (await checkKeySearchRetry()));
  console.log("ok    " + (await checkSwapRace()));
}
