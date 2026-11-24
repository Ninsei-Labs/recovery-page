// Execute the page's send path against a fake facade and a small DOM. The production recovery.js is bundled in
// memory; only locale startup, the DOM and the wallet facade are substitutes. The relay is the boundary the checks
// count: it must be called once after the confirmation, and never from the steps that only build or sign.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { msFromOrderSeconds } from "@ninsei-labs/sdk/core";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function element(tag = "div") {
  const node = {
    tag,
    nodeType: 1,
    children: [],
    attributes: {},
    style: {},
    dataset: {},
    value: "",
    files: [],
    textContent: "",
    hidden: false,
    disabled: false,
    className: "",
    scrollTop: 0,
    scrollHeight: 0,
    listeners: {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false;
      },
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return this.attributes[name] ?? null;
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    append(...children) {
      this.children.push(...children);
    },
    insertBefore(child) {
      this.children.push(child);
      return child;
    },
    replaceChildren(...children) {
      this.children = [...children];
    },
    after() {},
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
    scrollIntoView() {},
    querySelector() {
      return element();
    },
  };
  return node;
}

async function pageBundle({ rowSdk: extraSdk = {}, context: extraContext = {} } = {}) {
  const source = await readFile(new URL("../recovery.js", import.meta.url), "utf8");
  const exports = [
    "sendTx",
    "dropKeys",
    "buildTx",
    "withdraw",
    "openSwap",
    "syncWallet",
    "findKeySwaps",
    "facadeFor",
    "facades",
    "onKeyFileChosen",
    "startNode",
    "recheck",
    "closeSwap",
    "refreshBalance",
    "showDone",
    "log",
    "openEth",
    "ethConnect",
    "ethSend",
    "drawEthGas",
    "actionCore",
    "runPreflight",
    "chooseListed",
  ];
  const built = await build({
    stdin: {
      // The appended exports expose existing bindings only in this in-memory test bundle.
      contents:
        source +
        `\nmod = globalThis.rowSdk;\nexport { ${exports.join(", ")} };\n` +
        `\nexport function __seed(values) {\n` +
        `  if ("signedToken" in values) signedToken = values.signedToken;\n` +
        `  if ("settlement" in values) settlement = values.settlement;\n` +
        `  if ("network" in values) network = values.network;\n` +
        `  if ("nodeNetwork" in values) nodeNetwork = values.nodeNetwork;\n` +
        `  if ("key" in values) key = values.key;\n` +
        `  if ("search" in values) search = values.search;\n` +
        `  if ("contents" in values) contents = values.contents;\n` +
        `  if ("plan" in values) plan = values.plan;\n` +
        `  if ("current" in values) current = values.current;\n` +
        `  if ("adapter" in values) adapter = values.adapter;\n` +
        `  if ("wallet" in values) wallet = values.wallet;\n` +
        `  if ("balance" in values) balance = values.balance;\n` +
        `  if ("lastTx" in values) lastTx = values.lastTx;\n` +
        `  if ("ethMaterial" in values) ethMaterial = values.ethMaterial;\n` +
        `  if ("ethProvider" in values) ethProvider = values.ethProvider;\n` +
        `  if ("ethAdapter" in values) ethAdapter = values.ethAdapter;\n` +
        `  if ("ethBusy" in values) ethBusy = values.ethBusy;\n` +
        `  if ("loadWallet" in values) loadWalletImpl = values.loadWallet;\n` +
        `  if ("walletCheck" in values) walletCheck = values.walletCheck;\n` +
        `  if ("dest" in values) destInput.value = values.dest;\n` +
        `  if ("height" in values) heightInput.value = String(values.height);\n` +
        `}\n` +
        `\nexport function __doneLinks() {\n` +
        `  const out = [];\n` +
        `  const walk = (node) => {\n` +
        `    if (!node) return;\n` +
        `    if (node.href) out.push(node.href);\n` +
        `    for (const child of node.children || []) walk(child);\n` +
        `  };\n` +
        `  walk(doneInfoEl);\n` +
        `  return out;\n` +
        `}\n` +
        `\nexport function __state() {\n` +
        `  return { signedToken, lastTx, key, search, contents, plan, current, adapter, wallet, network, settlement, balance,\n` +
        `    nodeNetwork, confirmHidden: confirmEl.hidden, doneHidden: doneEl.hidden, withdrawDisabled: withdrawBtn.disabled,\n` +
        `    withdrawText: withdrawErrorEl.textContent, keyText: keyErrorEl.textContent, openErrorText: openErrorEl.textContent, keyPassHidden: keyPassField.hidden,\n` +
        `    facades: facades.size, signed: window.__sweepFlow.signed, steps: window.__sweepFlow.steps.slice(),\n` +
        `    ethMaterial, ethProvider, ethAdapter, ethBusy, ethErrorText: ethErrorEl.textContent,\n` +
        `    ethDoneHidden: ethDoneEl.hidden, ethConfirmHidden: ethConfirmEl.hidden, ethWalletText: ethWalletEl.textContent,\n` +
        `    ethConnectHidden: ethConnectBtn.hidden, ethSendDisabled: ethSendBtn.disabled, ethBoxHidden: ethBox.hidden,\n` +
        `    ethInfoText: ethInfoEl.textContent };\n` +
        `}\n` +
        `export function __text(id) {\n` +
        `  const out = [];\n` +
        `  const walk = (node) => {\n` +
        `    if (!node) return;\n` +
        `    if (node.nodeType === 3) out.push(node.textContent);\n` +
        `    else if (!node.children || !node.children.length) out.push(node.textContent);\n` +
        `    for (const child of node.children || []) walk(child);\n` +
        `  };\n` +
        `  walk(document.getElementById(id));\n` +
        `  return out.join(" ");\n` +
        `}\n`,
      resolveDir: ROOT,
      sourcefile: "recovery.js",
    },
    bundle: true,
    write: false,
    format: "iife",
    globalName: "sendPage",
    plugins: [
      {
        name: "send-locale",
        setup(plugin) {
          plugin.onResolve({ filter: /locales\/index\.js$/ }, () => ({ path: "locale", namespace: "send-test" }));
          plugin.onLoad({ filter: /.*/, namespace: "send-test" }, () => ({
            // Startup waits for language loading; leave that promise pending so it cannot start preflight. A text is
            // its key, or what the context's `pageText(key, params)` makes of it when a check needs the parameters.
            contents:
              "export const t = (key, params) => (typeof pageText === 'function' ? pageText(key, params) : key)," +
              " n = String, d = String, init = () => new Promise(() => {});",
          }));
        },
      },
    ],
  });
  assert.equal(built.outputFiles.length, 1, "one executable page bundle");

  const elements = new Map();
  const document = {
    hidden: false,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    createElement: (tag) => element(tag),
    createElementNS: (_namespace, tag) => element(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
    addEventListener() {},
  };
  const window = { __sweepFlow: { steps: [], signed: false } };
  const rowSdk = {
    msFromOrderSeconds,
    formatXmr: (value) => String(value),
    memoryAdapter: () => ({}),
    decodeAddressKeys: () => ({ spendPub: "spend-pub" }),
    ...extraSdk,
  };
  const context = {
    rowSdk,
    document,
    window,
    navigator: {},
    self: { isSecureContext: true },
    location: { search: "", origin: "https://example.invalid", href: "https://example.invalid/" },
    sessionStorage: {
      getItem() {
        return null;
      },
      setItem() {},
      removeItem() {},
    },
    performance: { now: () => 0 },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    fetch: (...args) => globalThis.fetch(...args),
    AbortSignal: globalThis.AbortSignal,
    ...extraContext,
  };
  runInNewContext(built.outputFiles[0].text, context);
  const page = context.sendPage;
  assert.ok(page && typeof page.sendTx === "function", "the send bundle exposes the page functions");
  return { page, elements, window };
}

function fakeCore({ relay = async () => ({ txids: [] }), planResult = null } = {}) {
  const calls = {
    relay: 0,
    sign: 0,
    destination: 0,
    disconnect: 0,
    fromOrder: 0,
    plan: 0,
    wallet: 0,
    restore: 0,
    readRecovery: 0,
    keyImages: 0,
  };
  const core = {
    calls,
    lastSign: null,
    lastRead: null,
    lastRestore: null,
    restoreResult: null,
    wallet: {
      use() {},
      async connect() {},
      async disconnect() {
        calls.disconnect += 1;
      },
    },
    swaps: {
      async readRecovery(request) {
        calls.readRecovery += 1;
        core.lastRead = request;
        return {
          complete: true,
          spends: [],
          transfers: [
            {
              pool: false,
              locked: false,
              confirmations: 1,
              outputs: [
                {
                  index: 0,
                  key: "cd".repeat(32),
                  amountAtomic: "1",
                  amountVerified: true,
                  derivation: "ef".repeat(32),
                },
              ],
            },
          ],
        };
      },
    },
    sweep: {
      async keyImages(request) {
        calls.keyImages += 1;
        assert.ok(
          request.keys && request.arrival && request.arrival.outputs.length,
          "key images come from the page read",
        );
        return ["ab".repeat(32)];
      },
      async relay(request) {
        calls.relay += 1;
        return relay(request);
      },
      async sign(request) {
        calls.sign += 1;
        core.lastSign = request;
        if (!Array.isArray(request.keyImages) || !request.keyImages.length) {
          const error = new Error("the signed set has no key images");
          error.code = "bad-input";
          throw error;
        }
        return { token: "signed-token", amount: 5000n, fee: null, receive: null };
      },
      async destination() {
        calls.destination += 1;
        return { ok: true };
      },
      async restore(request) {
        calls.restore += 1;
        core.lastRestore = request;
        return core.restoreResult || { unlocked: 10n, total: 10n, passes: 1, lockedPass: false, scanComplete: true };
      },
      async plan() {
        calls.plan += 1;
        return planResult || { address: "address", restoreHeight: 1, missing: [], revealedHalf: true };
      },
      async fromOrder() {
        calls.fromOrder += 1;
        return { contents: { kind: "file" }, address: "address" };
      },
      async keys() {
        return { privateSpendKey: "spend", privateViewKey: "view", address: "address" };
      },
      wallet() {
        calls.wallet += 1;
        return { driver: () => wallet };
      },
    },
  };
  return core;
}

const wallet = {
  async getBalance() {
    return 10n;
  },
  async getOutputs(query) {
    assert.equal(query.isSpent, false, "the page asks for unspent outputs");
    return [
      {
        getIsLocked: () => false,
        getIsFrozen: () => false,
        getKeyImage: () => ({ getHex: () => "ab".repeat(32) }),
      },
    ];
  },
  async getTxs() {
    return [];
  },
  async getHeight() {
    return 100;
  },
  async getDaemonHeight() {
    return 100;
  },
};
const tipFetch =
  (timestamp = Math.floor(Date.now() / 1000)) =>
  async (_url, init) => {
    const request = JSON.parse(init.body);
    assert.equal(request.method, "get_block_header_by_height");
    return {
      ok: true,
      status: 200,
      json: async () => ({ result: { block_header: { height: request.params.height, timestamp } } }),
    };
  };

const address = "1".repeat(95);
const row = {
  swap: { escrow: "0x" + "11".repeat(20), amount: "1000", side: "locker", t1: 2_000_000_000, readyBy: 1_999_999_000 },
  net: { id: "testnet", monero: "testnet", chainId: 31337, name: "Test", native: { decimals: 18, symbol: "ETH" } },
  side: "buy",
  status: { isFunded: true, isClaimed: true, isRefunded: false, isReady: false },
  time: 1_700_000_000,
};

export async function checkOpenAndSync() {
  // OPENING A FOUND SWAP READS THE ORDER AND BUILDS ITS PLAN; SYNCING THE WALLET READS THE MONEY. Neither relays.
  const opened = await pageBundle();
  const openCore = fakeCore();
  opened.page.facades.set("testnet/testnet", openCore);
  opened.page.__seed({
    key: { mnemonic: "words", fingerprint: "fp" },
    search: null,
    current: null,
    plan: null,
    contents: null,
    balance: null,
    nodeNetwork: "testnet",
    dest: address,
  });
  assert.equal(await opened.page.openSwap(row), true);
  assert.equal(openCore.calls.relay, 0, "opening a swap must not relay");
  assert.equal(openCore.calls.fromOrder, 1, "opening a swap builds it through sweep.fromOrder");
  assert.equal(openCore.calls.plan, 1, "opening a swap builds its plan through the SDK");
  assert.equal(opened.page.__state().plan.revealedHalf, true);
  assert.equal(opened.elements.get("heightBox").hidden, true, "a known restore height hides the height field");
  assert.equal(opened.elements.get("restoreHeight").value, "1", "the field carries the plan's restore height");

  // A MISSING HEIGHT IS A NAMED STATE: the field is empty and the warning beside it is shown, never a zero scan.
  const missingHeight = await pageBundle();
  const missingCore = fakeCore({
    planResult: { address: "address", restoreHeight: 0, missing: [], revealedHalf: true },
  });
  missingHeight.page.facades.set("testnet/testnet", missingCore);
  missingHeight.page.__seed({
    key: { mnemonic: "words", fingerprint: "fp" },
    nodeNetwork: "testnet",
    current: null,
    plan: null,
    contents: null,
    balance: null,
    dest: address,
  });
  assert.equal(await missingHeight.page.openSwap(row), true);
  assert.equal(missingHeight.elements.get("heightBox").hidden, false, "a missing height shows the field and warning");
  assert.equal(missingHeight.elements.get("restoreHeight").value, "", "a missing height is not written as zero");

  // THE SEARCH'S START HEIGHT REACHES THE OPEN: a known height is logged, a missing one is named with the SDK's
  // reason. The field is filled from the plan's restore height, not guessed from a zero.
  const started = await pageBundle();
  const startCore = fakeCore();
  started.page.facades.set("testnet/testnet", startCore);
  started.page.__seed({
    key: { mnemonic: "words", fingerprint: "fp" },
    nodeNetwork: "testnet",
    current: null,
    plan: null,
    contents: null,
    balance: null,
    dest: address,
  });
  assert.equal(await started.page.openSwap({ ...row, swap: { ...row.swap, startHeight: 321 } }), true);
  assert.ok(
    started.page.__state().steps.some((line) => line.includes("log.height.found")),
    "a known start height must be logged",
  );
  assert.equal(
    await started.page.openSwap({ ...row, swap: { ...row.swap, startHeight: null, startHeightReason: "no-header" } }),
    true,
  );
  assert.ok(
    started.page.__state().steps.some((line) => line.includes("log.height.failed")),
    "a missing start height must be named with the SDK's reason",
  );

  const synced = await pageBundle({ context: { fetch: tipFetch() } });
  const syncCore = fakeCore();
  syncCore.sweep.wallet = () => ({
    driver: () => wallet,
    async addListener() {},
    async removeListener() {},
    async unlockedBalance() {
      return 10n;
    },
  });
  synced.page.facades.set("31337/testnet", syncCore);
  synced.page.__seed({
    key: { mnemonic: "words", fingerprint: "fp" },
    settlement: "31337",
    network: "testnet",
    nodeNetwork: "testnet",
    contents: { kind: "file" },
    plan: { address: "address", restoreHeight: 1, missing: [], revealedHalf: true },
    height: 2,
    dest: address,
    adapter: null,
    wallet: null,
  });
  assert.equal(await synced.page.syncWallet(), true);
  assert.equal(syncCore.calls.relay, 0, "syncing the wallet must not relay");
  assert.equal(syncCore.calls.restore, 1, "the sync must run the full restore");
  assert.equal(syncCore.lastRestore.fromHeight, 2, "the full scan must use the height field, not the plan's fallback");
  assert.equal(syncCore.lastRestore.scanBack, 10, "the full scan keeps the SDK's scan-back bound");
  assert.equal(synced.page.__state().balance.scanComplete, true, "a trusted tip must keep the SDK's complete scan");

  // A RESTORE THAT DID NOT FINISH IS NOT A COMPLETE ADDRESS: the page keeps the SDK's verdict and its reason.
  const incompleteSync = await pageBundle({ context: { fetch: tipFetch() } });
  const incompleteCore = fakeCore();
  incompleteCore.sweep.wallet = () => ({
    driver: () => wallet,
    async addListener() {},
    async removeListener() {},
    async unlockedBalance() {
      return 0n;
    },
  });
  incompleteCore.restoreResult = {
    unlocked: 0n,
    total: 0n,
    passes: 1,
    lockedPass: false,
    scanComplete: false,
    scanIncompleteReason: "behind-node",
  };
  incompleteSync.page.facades.set("31337/testnet", incompleteCore);
  incompleteSync.page.__seed({
    key: { mnemonic: "words", fingerprint: "fp" },
    settlement: "31337",
    network: "testnet",
    nodeNetwork: "testnet",
    contents: { kind: "file" },
    plan: { address: "address", restoreHeight: 1, missing: [], revealedHalf: true },
    height: 1,
    dest: address,
    adapter: null,
    wallet: null,
  });
  assert.equal(await incompleteSync.page.syncWallet(), true);
  assert.equal(
    incompleteSync.page.__state().balance.scanComplete,
    false,
    "an incomplete restore must not become a complete scan",
  );
  assert.equal(
    incompleteSync.page.__state().balance.scanIncompleteReason,
    "behind-node",
    "an incomplete restore must keep the SDK's reason",
  );

  // A START HEIGHT ABOVE THE NODE TIP IS REFUSED BEFORE THE SCAN: no restore is run.
  const aboveTip = await pageBundle({ context: { fetch: tipFetch() } });
  const aboveCore = fakeCore();
  aboveCore.sweep.wallet = () => ({
    driver: () => wallet,
    async addListener() {},
    async removeListener() {},
    async unlockedBalance() {
      return 0n;
    },
  });
  aboveTip.page.facades.set("31337/testnet", aboveCore);
  aboveTip.page.__seed({
    key: { mnemonic: "words", fingerprint: "fp" },
    settlement: "31337",
    network: "testnet",
    nodeNetwork: "testnet",
    contents: { kind: "file" },
    plan: { address: "address", restoreHeight: 1, missing: [], revealedHalf: true },
    height: 101,
    dest: address,
    adapter: null,
    wallet: null,
  });
  assert.equal(
    await aboveTip.page.syncWallet(),
    "flow.err.height",
    "a start height above the tip must be refused before scanning",
  );
  assert.equal(aboveCore.calls.restore, 0, "a start height above the tip must not run the scan");

  // A STALE TIP IS NOT CORROBORATION: a restore marked complete stays incomplete in the page.
  const staleSync = await pageBundle({ context: { fetch: tipFetch(Math.floor(Date.now() / 1000) - 3 * 60 * 60) } });
  const staleCore = fakeCore();
  staleCore.sweep.wallet = () => ({
    driver: () => wallet,
    async addListener() {},
    async removeListener() {},
    async unlockedBalance() {
      return 10n;
    },
  });
  staleSync.page.facades.set("31337/testnet", staleCore);
  staleSync.page.__seed({
    key: { mnemonic: "words", fingerprint: "fp" },
    settlement: "31337",
    network: "testnet",
    nodeNetwork: "testnet",
    contents: { kind: "file" },
    plan: { address: "address", restoreHeight: 1, missing: [], revealedHalf: true },
    height: 1,
    dest: address,
    adapter: null,
    wallet: null,
  });
  assert.equal(await staleSync.page.syncWallet(), true);
  assert.equal(
    staleSync.page.__state().balance.scanComplete,
    false,
    "a stale tip must leave the restored scan incomplete",
  );

  // A CLOSED OR INCOMPLETE WALLET IS REBUILT, NOT READ FROM THE OLD ADAPTER. The rebuilt scan is still incomplete,
  // so a refresh cannot upgrade the old verdict merely by opening the wallet again.
  const refreshed = await pageBundle();
  const refreshCore = fakeCore();
  refreshCore.restoreResult = {
    unlocked: 0n,
    total: 0n,
    passes: 1,
    lockedPass: false,
    scanComplete: false,
    scanIncompleteReason: "behind-node",
  };
  let rebuilt = 0;
  refreshCore.sweep.wallet = () => {
    rebuilt += 1;
    return {
      driver: () => wallet,
      async addListener() {},
      async removeListener() {},
      async unlockedBalance() {
        return 10n;
      },
    };
  };
  refreshed.page.facades.set("31337/testnet", refreshCore);
  refreshed.page.__seed({
    settlement: "31337",
    network: "testnet",
    nodeNetwork: "testnet",
    contents: { kind: "file" },
    plan: { address: "address", restoreHeight: 1, missing: [], revealedHalf: true },
    dest: address,
    adapter: {
      async sync() {},
      async unlockedBalance() {
        return 10n;
      },
      async close() {},
    },
    wallet,
    balance: { total: 10n, unlocked: 10n, txs: 1, scanComplete: false, scanIncompleteReason: "behind-node" },
  });
  assert.equal(await refreshed.page.refreshBalance(), true);
  assert.equal(rebuilt, 1, "an incomplete balance reopens the wallet");
  assert.equal(refreshCore.calls.restore, 1, "the rebuilt wallet runs the full scan");
  assert.equal(refreshed.page.__state().balance.scanComplete, false, "a refresh must not upgrade an incomplete scan");
  assert.equal(
    refreshed.page.__state().balance.scanIncompleteReason,
    "behind-node",
    "a refresh keeps the incomplete scan reason",
  );
  assert.equal(refreshCore.calls.relay, 0, "refreshing the balance must not relay");

  // A PLAIN SYNC MUST NOT UPGRADE A COMPLETE SCAN WHEN THE NODE'S TIP IS STALE. The node can stop advancing
  // while the wallet reaches the same height; the balance is then a view of a short chain, not of the swap's chain.
  const stale = await pageBundle({
    context: {
      fetch: tipFetch(Math.floor(Date.now() / 1000) - 3 * 60 * 60),
    },
  });
  stale.page.facades.set("31337/testnet", fakeCore());
  stale.page.__seed({
    settlement: "31337",
    network: "testnet",
    nodeNetwork: "testnet",
    current: { ...row, time: Math.floor(Date.now() / 1000) - 24 * 60 * 60 },
    contents: { kind: "file" },
    plan: { address: "address", restoreHeight: 1, missing: [], revealedHalf: true },
    dest: address,
    adapter: {
      async sync() {},
      async unlockedBalance() {
        return 10n;
      },
      async close() {},
    },
    wallet,
    balance: { total: 10n, unlocked: 10n, txs: 1, scanComplete: true },
  });
  assert.equal(await stale.page.refreshBalance(), true);
  assert.equal(
    stale.page.__state().balance.scanComplete,
    false,
    "a stale node tip must leave the refreshed scan incomplete",
  );
  // THE LOG IS COPIED TO THE CLIPBOARD. A future error message that includes the key must not put the words there.
  const redacted = await pageBundle();
  const mnemonic = "abandon ability able about above absent absorb abstract absurd abuse access accident";
  redacted.page.__seed({ key: { mnemonic, fingerprint: "fp" } });
  redacted.page.log("failure: " + mnemonic + " after");
  const steps = redacted.page.__state().steps.join("\n");
  assert.ok(!steps.includes(mnemonic), "the recovery words reached the log");
  assert.ok(steps.includes("[redacted]"), "the recovery words were not replaced in the log");
  return "openSwap and syncWallet run without a relay; an incomplete balance reopens the wallet; a stale tip stays incomplete; secrets never reach the log";
}

export async function checkSend() {
  const { page, elements } = await pageBundle();
  const core = fakeCore();
  page.facades.set("31337/testnet", core);

  // A SIGNED TRANSFER IS THE ONLY THING THE SEND BUTTON CAN RELAY, AND A SUCCESSFUL RELAY REMOVES THE KEYS.
  page.__seed({
    signedToken: "token",
    settlement: "31337",
    network: "testnet",
    key: { mnemonic: "words", fingerprint: "fp" },
    search: { rows: [], failed: [], done: true, searching: false, sources: [] },
    contents: { kind: "file" },
    plan: { address: "address", restoreHeight: 1, missing: [], revealedHalf: true },
    lastTx: { amount: 5000n, fee: null, receive: null, dest: address },
    adapter: { async close() {} },
    wallet,
    balance: { total: 10n, unlocked: 10n, txs: 1, scanComplete: true },
  });
  core.sweep.relay = async (request) => {
    core.calls.relay += 1;
    assert.equal(request.token, "token");
    assert.equal(
      JSON.stringify(request.keyImages),
      JSON.stringify(["ab".repeat(32)]),
      "the relay gets a fresh unspent set",
    );
    return { txids: ["tx-a", "tx-b"] };
  };
  assert.equal(await page.sendTx(), true);
  const after = page.__state();
  assert.equal(core.calls.relay, 1, "the relay is called once");
  assert.equal(core.calls.readRecovery, 1, "the relay uses one fresh page read of the node");
  assert.equal(core.calls.keyImages, 1, "the page derives the images from its own read, not the wallet");
  assert.equal(after.signedToken, null, "the consumed session is dropped");
  assert.equal(after.lastTx, null, "the signed transaction is dropped");
  assert.equal(after.key, null, "the recovery key is dropped");
  assert.equal(after.search, null, "the search is dropped");
  assert.equal(after.contents, null, "the swap payload is dropped");
  assert.equal(after.adapter, null, "the wallet adapter is dropped");
  assert.equal(after.facades, 0, "the facade is dropped");
  assert.equal(core.calls.disconnect, 1, "the SDK wallet is disconnected when the key is dropped");
  assert.equal(after.withdrawDisabled, true, "the withdraw button stays disabled after the send");
  assert.equal(after.doneHidden, false, "the sent view stays");
  assert.equal(after.confirmHidden, true, "the confirmation is closed");
  const links = page.__doneLinks();
  assert.equal(links.length, 2, "both transactions are listed");
  assert.equal(links[0], "https://testnet.xmrchain.net/tx/tx-a");
  assert.equal(links[1], "https://testnet.xmrchain.net/tx/tx-b");
  assert.ok(after.steps.includes("log.sent"), "a successful relay is logged");
  assert.ok(after.steps.includes("log.forgotten"), "the keys are dropped after the relay");
  return "one relay, keys and payload dropped, sent view kept";
}

export async function checkLostRelay() {
  const { page } = await pageBundle();
  const core = fakeCore();
  core.sweep.relay = async () => {
    core.calls.relay += 1;
    throw new Error("lost answer");
  };
  page.facades.set("31337/testnet", core);
  page.__seed({
    signedToken: "token",
    settlement: "31337",
    network: "testnet",
    key: { mnemonic: "words", fingerprint: "fp" },
    contents: { kind: "file" },
    plan: { address: "address", restoreHeight: 1, missing: [], revealedHalf: true },
    lastTx: { amount: 5000n, fee: null, receive: null, dest: address },
    adapter: { async close() {} },
    wallet,
  });
  assert.equal(await page.sendTx(), false);
  const after = page.__state();
  assert.equal(core.calls.relay, 1, "a lost relay answer is still one attempt");
  assert.equal(after.signedToken, null, "a consumed session is not reusable");
  assert.equal(after.lastTx, null, "a transaction that may be on chain is not shown as signed data");
  assert.equal(after.confirmHidden, true, "the consumed confirmation is hidden");
  assert.equal(after.withdrawText, "flow.err.sendUnknown", "a lost answer is unknown, not not-sent");
  assert.equal(after.signed, false, "the page does not claim the transfer is signed");
  assert.equal(after.key.mnemonic, "words", "the key is kept for a fresh balance read");
  return "lost relay answer reads as unknown and consumes the session";
}

export async function checkBeforeConfirm() {
  const { page } = await pageBundle();
  const core = fakeCore();
  page.facades.set("31337/testnet", core);
  let syncCalls = 0;
  page.__seed({
    settlement: "31337",
    network: "testnet",
    nodeNetwork: "testnet",
    contents: { kind: "file" },
    plan: { address: "address", restoreHeight: 1, missing: [], revealedHalf: true },
    current: row,
    adapter: {
      async sync() {
        syncCalls += 1;
      },
      async unlockedBalance() {
        return 10n;
      },
      async close() {},
    },
    wallet,
    balance: { total: 10n, unlocked: 10n, txs: 1, scanComplete: true },
    dest: address,
  });

  // SIGNING BUILDS THE CONFIRMATION; IT DOES NOT RELAY.
  assert.equal(await page.buildTx(), true);
  assert.equal(core.calls.sign, 1);
  assert.equal(core.calls.readRecovery, 1, "signing reads the page's own node");
  assert.equal(core.calls.keyImages, 1, "signing derives key images from the verified page read");
  assert.equal(core.calls.relay, 0, "buildTx must not relay");
  assert.equal(core.lastSign.maxFeeAtomic, 10_000_000_000n, "buildTx must name the fee ceiling");
  assert.equal(
    JSON.stringify(core.lastSign.keyImages),
    JSON.stringify(["ab".repeat(32)]),
    "buildTx must pass the unspent key images",
  );
  assert.equal(core.lastSign.wallet, page.__state().adapter, "buildTx must reuse the restored adapter");
  assert.ok(!("connectWallet" in core.lastSign), "buildTx must not replace the restored adapter");
  assert.equal(syncCalls, 0, "buildTx must not re-read the balance before confirming");
  assert.equal(page.__state().signedToken, "signed-token");

  // THE SAME PAGE, A FRESH STATE: WITHDRAW SIGNS AND SHOWS THE CONFIRMATION, STILL WITHOUT A RELAY.
  const second = await pageBundle({ context: { fetch: tipFetch() } });
  const core2 = fakeCore();
  second.page.facades.set("31337/testnet", core2);
  let syncCalls2 = 0;
  second.page.__seed({
    settlement: "31337",
    network: "testnet",
    nodeNetwork: "testnet",
    contents: { kind: "file" },
    plan: { address: "address", restoreHeight: 1, missing: [], revealedHalf: true },
    current: row,
    adapter: {
      async sync() {
        syncCalls2 += 1;
      },
      async unlockedBalance() {
        return 10n;
      },
      async close() {},
    },
    wallet,
    balance: { total: 10n, unlocked: 10n, txs: 1, scanComplete: true },
    dest: address,
  });
  assert.equal(await second.page.withdraw(), true);
  assert.equal(core2.calls.sign, 1);
  assert.equal(core2.calls.relay, 0, "withdraw must not relay");
  assert.equal(syncCalls2, 1, "withdraw refreshes the balance before signing");
  assert.equal(second.page.__state().confirmHidden, false, "withdraw opens the confirmation");

  // THE SEND BUTTON'S HANDLER REFUSES A MISSING SESSION, AND THAT REFUSAL DOES NOT REACH THE RELAY.
  const third = await pageBundle();
  const core3 = fakeCore();
  third.page.facades.set("31337/testnet", core3);
  third.page.__seed({ signedToken: null, settlement: "31337", network: "testnet" });
  assert.equal(await third.page.sendTx(), false);
  assert.equal(core3.calls.relay, 0, "sendTx must not relay without a signed session");
  assert.equal(third.page.__state().withdrawText, "flow.err.send");

  // A FEE REFUSAL NAMES THE FEE, NOT THE GENERIC SIGN ERROR.
  for (const code of ["sweep-fee-too-high", "sweep-fee-unknown"]) {
    const fee = await pageBundle();
    const feeCore = fakeCore();
    feeCore.sweep.sign = async () => {
      throw { code, params: {} };
    };
    fee.page.facades.set("31337/testnet", feeCore);
    fee.page.__seed({
      settlement: "31337",
      network: "testnet",
      nodeNetwork: "testnet",
      contents: { kind: "file" },
      plan: { address: "address", restoreHeight: 1, missing: [], revealedHalf: true },
      current: row,
      wallet,
      dest: address,
    });
    assert.equal(await fee.page.buildTx(), "sdk." + code, `${code} must reach the step`);
  }

  // AN INCOMPLETE NODE READ IS NOT A SET TO SIGN. A page that cannot see the whole range stops before the wallet.
  const incomplete = await pageBundle();
  const incompleteCore = fakeCore();
  incompleteCore.swaps.readRecovery = async () => ({ complete: false, transfers: [], spends: [] });
  incomplete.page.facades.set("31337/testnet", incompleteCore);
  incomplete.page.__seed({
    settlement: "31337",
    network: "testnet",
    nodeNetwork: "testnet",
    contents: { kind: "file" },
    plan: { address: "address", restoreHeight: 1, missing: [], revealedHalf: true },
    current: row,
    adapter: { async close() {} },
    wallet,
    balance: { total: 10n, unlocked: 10n, txs: 1, scanComplete: true },
    dest: address,
  });
  assert.equal(await incomplete.page.buildTx(), "flow.err.sign", "an incomplete node read must not sign");
  assert.equal(incompleteCore.calls.sign, 0, "the wallet is not asked to sign without a complete page read");

  // A SPENT OUTPUT IS REMOVED FROM THE PAGE SET, SO THE WALLET CANNOT SIGN IT EITHER.
  const spent = await pageBundle();
  const spentCore = fakeCore();
  spentCore.swaps.readRecovery = async () => ({
    complete: true,
    spends: [{ keyImage: "ab".repeat(32) }],
    transfers: [
      {
        pool: false,
        locked: false,
        confirmations: 1,
        outputs: [
          { index: 0, key: "cd".repeat(32), amountAtomic: "1", amountVerified: true, derivation: "ef".repeat(32) },
        ],
      },
    ],
  });
  spent.page.facades.set("31337/testnet", spentCore);
  spent.page.__seed({
    settlement: "31337",
    network: "testnet",
    nodeNetwork: "testnet",
    contents: { kind: "file" },
    plan: { address: "address", restoreHeight: 1, missing: [], revealedHalf: true },
    current: row,
    adapter: { async close() {} },
    wallet,
    balance: { total: 10n, unlocked: 10n, txs: 1, scanComplete: true },
    dest: address,
  });
  assert.equal(await spent.page.buildTx(), "flow.err.sign", "a spent output must not reach the signature");
  assert.deepEqual(spentCore.lastSign.keyImages, [], "the page removes the spent output from the set");

  // THE SEND BUTTON'S OWN HANDLER REACHES THE RELAY: the markup check above and this call together prove the
  // confirmation control is wired to the one function that can send.
  const button = await pageBundle();
  const core4 = fakeCore();
  button.page.facades.set("31337/testnet", core4);
  button.page.__seed({
    signedToken: "token",
    settlement: "31337",
    network: "testnet",
    key: { mnemonic: "words", fingerprint: "fp" },
    search: { rows: [], failed: [], done: true, searching: false, sources: [] },
    contents: { kind: "file" },
    plan: { address: "address", restoreHeight: 1, missing: [], revealedHalf: true },
    lastTx: { amount: 5000n, fee: null, receive: null, dest: address },
    adapter: { async close() {} },
    wallet,
  });
  const click = button.elements.get("send").listeners.click;
  assert.equal(typeof click, "function", "the send button has a click handler");
  await click();
  assert.equal(core4.calls.relay, 1, "the send button reaches the relay");
  return "build, sign and confirmation run without a relay; an unsigned send is refused; the button relays";
}

export async function checkEthAction() {
  const calls = { created: [], action: 0, request: null, adapter: null };
  const hash = "0x" + "a".repeat(64);
  const ethRow = { ...row, net: { ...row.net }, swap: { ...row.swap }, status: { ...row.status } };
  const material = {
    kind: "refund",
    escrow: "0x" + "e".repeat(20),
    half: "0x" + "1".repeat(64),
    expect: { amount: "100", chainId: ethRow.net.chainId, locker: "0x" + "11".repeat(20) },
  };
  const adapter = {
    connected: null,
    receiptStatus: "0x1",
    failConnect: false,
    async connect(args) {
      if (this.failConnect) throw new Error("wallet rejected the connection");
      this.connected = args;
    },
    async address() {
      return "0x" + "aa".repeat(20);
    },
    async chainId() {
      return ethRow.net.chainId;
    },
    async receipt() {
      return { status: this.receiptStatus };
    },
    disconnect() {},
  };
  const provider = {
    requests: [],
    async request(request) {
      this.requests.push(request);
      if (request.method === "eth_call") return "0x" + "0".repeat(64);
      throw new Error("the page must not ask the provider to " + request.method);
    },
  };
  const opened = await pageBundle({
    rowSdk: {
      createNinsei(options) {
        calls.created.push(options);
        return {
          sweep: {
            async fromOrder() {
              return material;
            },
          },
          actions: {
            async refund(request, walletAdapter) {
              if (calls.failWith) throw calls.failWith;
              calls.action += 1;
              calls.request = request;
              calls.adapter = walletAdapter;
              return { hash };
            },
            async claim(request, walletAdapter) {
              if (calls.failWith) throw calls.failWith;
              calls.action += 1;
              calls.request = request;
              calls.adapter = walletAdapter;
              return { hash };
            },
          },
        };
      },
      evmWallet(seen) {
        calls.walletProvider = seen;
        return adapter;
      },
    },
  });
  opened.window.ethereum = provider;
  opened.page.__seed({
    key: { mnemonic: "words", fingerprint: "fp" },
    current: ethRow,
    settlement: "testnet",
    network: "testnet",
    nodeNetwork: "testnet",
  });

  assert.equal(await opened.page.openEth(ethRow), true, "a refund row must open its ETH action");
  assert.equal(opened.page.__state().ethMaterial, material, "the SDK material is kept for the approval step");
  assert.equal(opened.page.__state().ethBoxHidden, false, "the ETH block is shown");

  // A FAILED CONNECT KEEPS THE PREPARED ACTION: only the connection is dropped, so the next click retries the same
  // material instead of asking for a new one.
  adapter.failConnect = true;
  assert.equal(await opened.page.ethConnect(), false, "a rejected connection must not report success");
  assert.equal(opened.page.__state().ethMaterial, material, "a failed connect must keep the prepared action");
  assert.equal(opened.page.__state().ethProvider, null, "a failed connect must not install a provider");
  adapter.failConnect = false;

  assert.equal(await opened.page.ethConnect(), true, "the injected wallet must connect");
  assert.equal(calls.walletProvider, provider, "the page's own provider is the one wrapped");
  assert.equal(adapter.connected.chainId, ethRow.net.chainId, "the adapter is asked for the row's chain");
  assert.equal(opened.page.__state().ethProvider, provider, "the connected provider is kept for the send");
  assert.equal(opened.page.__state().ethConfirmHidden, false, "the confirmation opens after a connection");
  assert.match(opened.page.__text("ethInfo"), /eth\.gas\.unknown/, "gas is not estimated or read from the provider");

  const action = opened.page.actionCore(ethRow, provider);
  const options = calls.created.at(-1);
  assert.ok(action, "the action facade is built from the row's chain");
  assert.equal(await options.evmCall({ to: "0x" + "22".repeat(20), data: "0x1234" }), "0x" + "0".repeat(64));
  assert.equal(provider.requests.length, 1);
  assert.equal(provider.requests[0].method, "eth_call");
  assert.equal(provider.requests[0].params[0].to, "0x" + "22".repeat(20));
  assert.equal(provider.requests[0].params[0].data, "0x1234");
  assert.equal(provider.requests[0].params[1], "latest");
  await assert.rejects(options.fetch(), /no service/, "the action facade must not reach a service");

  assert.equal(await opened.page.ethSend(), true, "a successful receipt must finish the action");
  assert.equal(calls.action, 1, "the SDK action is called once");
  assert.equal(calls.request.escrow, material.escrow, "the action gets the prepared escrow");
  assert.equal(calls.request.halfLocker, material.half, "the refund gets the prepared half");
  assert.equal(calls.adapter, adapter, "the action gets the connected wallet adapter");
  assert.equal(ethRow.status.isRefunded, true, "only the observed receipt moves the row");
  assert.ok(
    !provider.requests.some(
      (request) => request.method === "eth_sendTransaction" || request.method === "eth_estimateGas",
    ),
    "the page never sends or estimates through the provider",
  );
  assert.equal(opened.page.__state().ethDoneHidden, false, "the done panel opens after the receipt");

  // A WALLET THAT CHANGED ITS ACCOUNT IS NAMED, NOT REPORTED AS A GENERIC SEND FAILURE.
  calls.failWith = Object.assign(new Error("bad-input"), { code: "bad-input", params: { field: "wallet" } });
  assert.equal(await opened.page.ethSend(), false, "a changed wallet account must stop the send");
  assert.equal(opened.page.__state().ethErrorText, "eth.err.account", "a wallet account change is named");
  calls.failWith = null;

  // A REVERTED RECEIPT IS NOT A SUCCESS AND OPENS THE CONFIRMATION AGAIN; THE ROW STAYS UNTOUCHED UNTIL A RECEIPT.
  ethRow.status = { ...row.status };
  adapter.receiptStatus = "0x0";
  assert.equal(await opened.page.ethSend(), false, "a reverted receipt must not finish the action");
  assert.equal(opened.page.__state().ethErrorText, "eth.err.reverted", "a reverted receipt is named");
  assert.equal(opened.page.__state().ethConfirmHidden, false, "a reverted receipt opens the confirmation again");
  assert.equal(opened.page.__state().ethDoneHidden, true, "a reverted receipt must not show the done panel");
  assert.equal(ethRow.status.isRefunded, false, "a reverted receipt must not move the row");

  return "the ETH action is prepared from the order, connected through the injected wallet, sent by the SDK and moved only by a receipt";
}

export async function checkPreflight() {
  let loads = 0;
  let probes = 0;
  const opened = await pageBundle({
    rowSdk: {
      async probeMoneroNode() {
        probes += 1;
        return { ok: true, network: "testnet", height: 100, synchronized: true, nettype: "testnet" };
      },
    },
  });
  opened.page.__seed({
    loadWallet: async () => {
      loads += 1;
      return true;
    },
    walletCheck: null,
    nodeNetwork: "testnet",
  });

  assert.equal(await opened.page.runPreflight({ probeNode: false }), true, "a ready wallet makes the page ready");
  assert.equal(await opened.page.runPreflight({ probeNode: false }), true);
  assert.equal(loads, 1, "the wallet is loaded once across two preflights");
  assert.equal(opened.elements.get("findSwaps").disabled, false, "the search opens once the wallet is ready");

  await opened.page.startNode();
  opened.page.chooseListed("https://node.example");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probes, 1, "picking a node asks that node, not the wallet again");
  assert.equal(loads, 1, "picking a node does not load the wallet again");
  return "the wallet is loaded once, the search opens when it is ready, and a node change asks only the node";
}

export async function checkEthRace() {
  let release;
  let connectStarted = false;
  const material = {
    kind: "refund",
    escrow: "0x" + "e".repeat(20),
    half: "0x" + "1".repeat(64),
    expect: { amount: "100", chainId: row.net.chainId, locker: "0x" + "11".repeat(20) },
  };
  const adapter = {
    async connect() {
      connectStarted = true;
      await new Promise((resolve) => {
        release = resolve;
      });
    },
    async address() {
      return "0x" + "aa".repeat(20);
    },
    async chainId() {
      return row.net.chainId;
    },
    async receipt() {
      return { status: "0x1" };
    },
    disconnect() {},
  };
  const opened = await pageBundle({
    rowSdk: {
      createNinsei() {
        return {
          sweep: {
            async fromOrder() {
              return material;
            },
          },
          actions: {},
        };
      },
      evmWallet() {
        return adapter;
      },
    },
  });
  opened.window.ethereum = {
    async request() {
      throw new Error("no provider call expected");
    },
  };
  opened.page.__seed({
    key: { mnemonic: "words", fingerprint: "fp" },
    current: row,
    settlement: "testnet",
    network: "testnet",
    nodeNetwork: "testnet",
  });
  assert.equal(await opened.page.openEth(row), true);
  const pending = opened.page.ethConnect();
  while (!connectStarted) await Promise.resolve();
  await opened.page.openEth(row);
  release();
  assert.equal(await pending, false, "a connection from a superseded swap must not install");
  assert.equal(opened.page.__state().ethProvider, null, "a late connection must not keep its provider");
  assert.equal(opened.page.__state().ethAdapter, null, "a late connection must not keep its adapter");
  assert.equal(opened.page.__state().ethConfirmHidden, true, "a late connection must not open the confirmation");
  return "a connection that answers after another swap opens is ignored";
}

export async function checkEthRouting() {
  const material = {
    kind: "refund",
    escrow: "0x" + "e".repeat(20),
    half: "0x" + "1".repeat(64),
    expect: { amount: "100", chainId: row.net.chainId, locker: "0x" + "11".repeat(20) },
  };
  const ethRow = {
    ...row,
    swap: { ...row.swap, t1: 1_000_000_000 },
    side: "buy",
    status: { isFunded: true, isClaimed: false, isRefunded: false, isReady: false },
  };
  const opened = await pageBundle({
    rowSdk: {
      createNinsei() {
        return {
          sweep: {
            async fromOrder() {
              return material;
            },
          },
          actions: {},
        };
      },
    },
  });
  opened.page.__seed({
    key: { mnemonic: "words", fingerprint: "fp" },
    current: null,
    plan: null,
    contents: null,
    nodeNetwork: "testnet",
  });
  assert.equal(await opened.page.openSwap(ethRow), true, "an ETH row must open its ETH block");
  assert.equal(opened.page.__state().ethBoxHidden, false, "the ETH block is shown for a refund row");
  assert.equal(opened.elements.get("moneyState").hidden, true, "the XMR block is hidden for an ETH row");
  assert.equal(opened.elements.get("stepTransfer").hidden, true, "the transfer step is hidden for an ETH row");
  assert.equal(opened.page.__state().current, ethRow, "the ETH row is the current swap");
  return "an ETH row opens the ETH block, not the XMR flow";
}

export async function checkNoService() {
  let options = null;
  let created = 0;
  const opened = await pageBundle({
    rowSdk: {
      createNinsei(seen) {
        created += 1;
        options = seen;
        return { actions: {}, sweep: {} };
      },
    },
  });
  await opened.page.facadeFor(31337, "testnet");
  assert.equal(created, 1, "the search facade is built once");
  assert.equal(typeof options.fetch, "function", "the search facade gets a fetch");
  await assert.rejects(options.fetch(), /no service/, "the search facade must not reach a service");

  const action = opened.page.actionCore(row, { request() {} });
  assert.ok(action, "the action facade is built");
  assert.equal(created, 2, "the action facade is a second createNinsei");
  await assert.rejects(options.fetch(), /no service/, "the action facade must not reach a service");
  return "both facades get a fetch that refuses, so only the node and the chain hear from the tab";
}

export async function checkKeySecret() {
  const mnemonic = "abandon ability able about above absent absorb abstract absurd abuse access accident";
  const opened = await pageBundle({
    context: {
      pageText: (key, params) => key + (params ? " " + JSON.stringify(params) : ""),
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ result: "0x100" }) }),
    },
    rowSdk: {
      CHAINS: [
        {
          id: "arbitrum-sepolia",
          name: "Arbitrum Sepolia",
          chainId: 421614,
          escrow: { mode: "live", address: "0x" + "ab".repeat(20) },
          native: { decimals: 18, symbol: "ETH" },
        },
      ],
      importRecoveryKey(words) {
        return { mnemonic: words, fingerprint: "fp" };
      },
      async findSwaps() {
        throw new Error("search failed for " + mnemonic);
      },
      async probeMoneroNode() {
        return { ok: true, network: "testnet", height: 100, synchronized: true, nettype: "testnet" };
      },
      async readEscrowEventsByTopic() {
        return [];
      },
    },
  });
  opened.page.__seed({ key: null, search: null, current: null, nodeNetwork: "testnet" });
  opened.elements.get("keyWords").value = mnemonic;
  await opened.page.findKeySwaps();

  assert.equal(opened.elements.get("keyWords").value, "", "the words stay in the field after the search");
  assert.equal(opened.elements.get("keyPass").value, "", "the password stays in the field after the search");
  assert.ok(
    !JSON.stringify(opened.window.__sweepFlow, (_key, value) =>
      typeof value === "bigint" ? String(value) : value,
    ).includes(mnemonic),
    "the words reach the window state",
  );
  const steps = opened.page.__state().steps.join("\n");
  assert.ok(!steps.includes(mnemonic), "the words reach the log");
  assert.ok(steps.includes("[redacted]"), "a secret in an error is not redacted");
  return "the search clears the fields and keeps the words out of the log and the window state";
}

if (import.meta.main) {
  console.log("ok    " + (await checkOpenAndSync()));
  console.log("ok    " + (await checkSend()));
  console.log("ok    " + (await checkLostRelay()));
  console.log("ok    " + (await checkBeforeConfirm()));
  console.log("ok    " + (await checkEthAction()));
  console.log("ok    " + (await checkEthRace()));
  console.log("ok    " + (await checkEthRouting()));
  console.log("ok    " + (await checkPreflight()));
  console.log("ok    " + (await checkNoService()));
  console.log("ok    " + (await checkKeySecret()));
}

export { pageBundle, fakeCore, element, address, row, wallet };
