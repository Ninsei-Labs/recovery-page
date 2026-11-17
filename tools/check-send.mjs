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

async function pageBundle() {
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
        `  if ("dest" in values) destInput.value = values.dest;\n` +
        `  if ("height" in values) heightInput.value = String(values.height);\n` +
        `}\n` +
        `\nexport function __state() {\n` +
        `  return { signedToken, lastTx, key, search, contents, plan, current, adapter, wallet, network, settlement, balance,\n` +
        `    confirmHidden: confirmEl.hidden, doneHidden: doneEl.hidden, withdrawDisabled: withdrawBtn.disabled,\n` +
        `    withdrawText: withdrawErrorEl.textContent, keyText: keyErrorEl.textContent, facades: facades.size,\n` +
        `    signed: window.__sweepFlow.signed, steps: window.__sweepFlow.steps.slice() };\n` +
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
            // Startup waits for language loading; leave that promise pending so it cannot start preflight.
            contents: "export const t = key => key, n = String, d = String, init = () => new Promise(() => {});",
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
  };
  const context = {
    rowSdk,
    document,
    window,
    navigator: {},
    performance: { now: () => 0 },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
  };
  runInNewContext(built.outputFiles[0].text, context);
  const page = context.sendPage;
  assert.ok(page && typeof page.sendTx === "function", "the send bundle exposes the page functions");
  return { page, elements };
}

function fakeCore({ relay = async () => ({ txids: [] }) } = {}) {
  const calls = { relay: 0, sign: 0, destination: 0, disconnect: 0 };
  return {
    calls,
    wallet: {
      use() {},
      async connect() {},
      async disconnect() {
        calls.disconnect += 1;
      },
    },
    sweep: {
      async relay(request) {
        calls.relay += 1;
        return relay(request);
      },
      async sign() {
        calls.sign += 1;
        return { token: "signed-token", amount: 5000n, fee: null, receive: null };
      },
      async destination() {
        calls.destination += 1;
        return { ok: true };
      },
      async restore() {
        return { unlocked: 10n, total: 10n, passes: 1, lockedPass: false, scanComplete: true };
      },
      async plan() {
        return { address: "address", restoreHeight: 1, missing: [], revealedHalf: true };
      },
      async fromOrder() {
        return { contents: { kind: "file" }, address: "address" };
      },
      async keys() {
        return { privateSpendKey: "spend", privateViewKey: "view", address: "address" };
      },
      wallet() {
        return { driver: () => wallet };
      },
    },
  };
}

const wallet = {
  async getBalance() {
    return 10n;
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

const address = "1".repeat(95);
const row = {
  swap: { escrow: "0x" + "11".repeat(20), amount: "1000", side: "locker", t1: 2_000_000_000, readyBy: 1_999_999_000 },
  net: { id: "testnet", monero: "testnet", chainId: 31337, name: "Test", native: { decimals: 18, symbol: "ETH" } },
  side: "buy",
  status: { isFunded: true, isClaimed: true, isRefunded: false, isReady: false },
  time: 1_999_999_000,
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
  assert.equal(opened.page.__state().plan.revealedHalf, true);

  const synced = await pageBundle();
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
    dest: address,
    adapter: null,
    wallet: null,
  });
  assert.equal(await synced.page.syncWallet(), true);
  assert.equal(syncCore.calls.relay, 0, "syncing the wallet must not relay");
  assert.ok(synced.page.__state().balance, "the sync records the balance");
  return "openSwap and syncWallet run without a relay";
}

export async function checkSend() {
  const { page } = await pageBundle();
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
    lastTx: { amount: 5000n, fee: null, receive: null, dest: address },
    adapter: { async close() {} },
    wallet,
    balance: { total: 10n, unlocked: 10n, txs: 1, scanComplete: true },
  });
  core.sweep.relay = async (request) => {
    core.calls.relay += 1;
    assert.equal(request.token, "token");
    return { txids: ["tx-a", "tx-b"] };
  };
  assert.equal(await page.sendTx(), true);
  const after = page.__state();
  assert.equal(core.calls.relay, 1, "the relay is called once");
  assert.equal(after.signedToken, null, "the consumed session is dropped");
  assert.equal(after.lastTx, null, "the signed transaction is dropped");
  assert.equal(after.key, null, "the recovery key is dropped");
  assert.equal(after.search, null, "the search is dropped");
  assert.equal(after.contents, null, "the swap payload is dropped");
  assert.equal(after.adapter, null, "the wallet adapter is dropped");
  assert.equal(after.facades, 0, "the facade is dropped");
  assert.equal(after.withdrawDisabled, true, "the withdraw button stays disabled after the send");
  assert.equal(after.doneHidden, false, "the sent view stays");
  assert.equal(after.confirmHidden, true, "the confirmation is closed");
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
  page.__seed({
    settlement: "31337",
    network: "testnet",
    nodeNetwork: "testnet",
    contents: { kind: "file" },
    plan: { address: "address", restoreHeight: 1, missing: [], revealedHalf: true },
    current: row,
    adapter: {
      async sync() {},
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
  assert.equal(core.calls.relay, 0, "buildTx must not relay");
  assert.equal(page.__state().signedToken, "signed-token");

  // THE SAME PAGE, A FRESH STATE: WITHDRAW SIGNS AND SHOWS THE CONFIRMATION, STILL WITHOUT A RELAY.
  const second = await pageBundle();
  const core2 = fakeCore();
  second.page.facades.set("31337/testnet", core2);
  second.page.__seed({
    settlement: "31337",
    network: "testnet",
    nodeNetwork: "testnet",
    contents: { kind: "file" },
    plan: { address: "address", restoreHeight: 1, missing: [], revealedHalf: true },
    current: row,
    adapter: {
      async sync() {},
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
  assert.equal(second.page.__state().confirmHidden, false, "withdraw opens the confirmation");

  // THE SEND BUTTON'S HANDLER REFUSES A MISSING SESSION, AND THAT REFUSAL DOES NOT REACH THE RELAY.
  const third = await pageBundle();
  const core3 = fakeCore();
  third.page.facades.set("31337/testnet", core3);
  third.page.__seed({ signedToken: null, settlement: "31337", network: "testnet" });
  assert.equal(await third.page.sendTx(), false);
  assert.equal(core3.calls.relay, 0, "sendTx must not relay without a signed session");
  assert.equal(third.page.__state().withdrawText, "flow.err.send");

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

if (import.meta.main) {
  console.log("ok    " + (await checkOpenAndSync()));
  console.log("ok    " + (await checkSend()));
  console.log("ok    " + (await checkLostRelay()));
  console.log("ok    " + (await checkBeforeConfirm()));
}
