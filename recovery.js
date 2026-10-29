// The recovery page: the recovery key -> the swaps it made, found on chain -> one swap that needs it -> your
// address -> one button that syncs, builds and signs -> confirm -> send.
//
// THE RULES LIVE IN @ninsei-labs/sdk: importRecoveryKey, openRecoveryKeyFile, takerHalves, findSwaps, order.status,
// order.jointAddress, sweep.plan, sweep.fromOrder, sweep.keys, sweep.wallet, sweep.restore, sweep.destination,
// sweep.sign, sweep.relay, formatXmr, probeMoneroNode. A found swap reaches the sweep through sweep.fromOrder: the
// SDK takes the key and the order, checks the points, builds the joint address and returns the same file plan/keys
// accept, so the page keeps no payload rule of its own.
//
// The page keeps the DOM, the node address, state, display and texts. What it says about a swap and its money
// comes from lib/withdrawal.js. A found swap's start height is the SDK's (findSwaps), from the page's readers of the
// settlement chain and the Monero node (lib/settlement.js, lib/node.js).
//
// Keys never leave the tab: only requests for public chain data go out (the Monero node, the settlement chain's
// RPCs). The 12 words are never logged, never put into window state and never kept in a field after the search;
// they live in one variable until the transfer is sent.

// CORE CODE -> WORDS: the demo dictionary (a copy of www/js/sdk/codes.js). Unknown codes pass through.
import { t, n, d, init as initLocale } from "./locales/index.js";
import {
  NODES,
  STAGENET_NODE,
  nodeUrl,
  nodeSource,
  nodeLabelKey,
  nodeLabelParams,
  setNodeUrl,
  clearNodeUrl,
  parseNodeUrl,
  nodeHost,
  nodeNetwork as nodeNetworkOf,
  pingNode,
  medianHeight,
  nodeVerdict,
  fastestGood,
  moneroReaders,
  nodeFor,
} from "./lib/node.js";
import { keyNetworks, evmCall, evmLogs, evmBlockNumber, evmBlockTime } from "./lib/settlement.js";
import { restoreWindow } from "./lib/window.js";
import { swapState, moneyState } from "./lib/withdrawal.js";

// THE PERSON'S SIDE OF A FOUND ORDER, for display. The SDK's sweep.fromOrder reads the same field and refuses
// anything else; this function only names the row before the withdrawal is opened.
function sideOf(found) {
  if (found && found.side === "locker") return "buy";
  if (found && found.side === "claimer") return "sell";
  return null;
}

// PATHS ARE RELATIVE: a domain root and a subdirectory must both work. The `?v=` hash is stamped by build/build.mjs.
const BUNDLE = "./assets/vendors/monero/monero-ts-browser.js?v=__V_MONERO__";
const WORKER = "./monero.worker.js?v=__V_WORKER__";
const SDK_BUNDLE = "./assets/vendors/sdk/sdk-browser.js?v=__V_SDK__";
// THIS PAGE TALKS TO NO SERVICE. The SDK's service routes (a height the app remembers, the revealed half's
// fallback, the "withdrawn" mark) get this fetch, which answers "unavailable" without a request: the height comes
// from the chain or the person, the half from the chain, and a withdrawal needs nobody told. So only the Monero
// node and the settlement chain's RPCs ever hear from this tab, as the page promises.
const noService = async () => {
  throw new TypeError("this page talks to no service");
};

const EXPLORER = {
  mainnet: "https://xmrchain.net/tx/",
  stagenet: "https://stagenet.xmrchain.net/tx/",
  testnet: "https://testnet.xmrchain.net/tx/",
};

const $ = (id) => document.getElementById(id);
const logEl = $("log");
const keyWordsInput = $("keyWords");
const keyFileInput = $("keyFile");
const keyPassField = $("keyPassField");
const keyPassInput = $("keyPass");
const findSwapsBtn = $("findSwaps");
const keyErrorEl = $("keyError");
const keyResultEl = $("keyResult");
const keyPrintEl = $("keyPrint");
const keyCountEl = $("keyCount");
const keyNoneEl = $("keyNone");
const keyRangeEl = $("keyRange");
const keyPartialEl = $("keyPartial");
const keyActionsEl = $("keyActions");
const keyMoreEl = $("keyMore");
const keyStopEl = $("keyStop");
const swapListEl = $("swapList");
const stepSwap = $("stepSwap");
const openErrorEl = $("openError");
const moneyEl = $("moneyState");
const moneyHeadEl = $("moneyHead");
const swapInfoEl = $("swapInfo");
const heightInput = $("restoreHeight");
const heightBox = $("heightBox");
const stepTransfer = $("stepTransfer");
const destInput = $("dest");
const withdrawBtn = $("withdraw");
const progressEl = $("progress");
const progressHeadEl = $("progressHead");
const progressBarEl = progressEl.querySelector(".progress-bar");
const progressFillEl = $("progressFill");
const progressSubEl = $("progressSub");
const withdrawErrorEl = $("withdrawError");
const confirmEl = $("confirm");
const txInfoEl = $("txInfo");
const sendBtn = $("send");
const doneEl = $("done");
const doneInfoEl = $("doneInfo");

let api = null; // monero-ts namespace
let mod = null; // built SDK core
const facades = new Map(); // "<settlement>/<monero network>" -> core facade (createNinsei)
let adapter = null; // core wallet adapter (connect/sync/unlockedBalance/driver)
let wallet = null; // library wallet: driver() of the adapter
let keyFileText = null; // the chosen key file's text, until the search reads it
let key = null; // { mnemonic, fingerprint } of the last search: the words live here and nowhere else
let search = null; // the last search: { rows, failed } - rows are { swap, net, side, status, time }
let current = null; // the row being withdrawn
let contents = null; // the current swap's file from sweep.fromOrder, a plain envelope in memory
let plan = null; // core plan: address, height, missing, revealed half
let network = null; // Monero network of the current swap
let nodeNetwork = null; // Monero network the chosen node answered with (checkNode)
let settlement = null; // settlement network of the current swap, one lib/settlement.js knows
let balance = null; // { total, unlocked, txs } after a sync, null before one
let signedToken = null; // signing token (sweep.sign -> sweep.relay)
let lastTx = null; // signed transfer data for the confirmation

// Console and test state: no secrets (no words, no keys, no halves).
window.__sweepFlow = {
  ready: false,
  network: null,
  address: null,
  restoreHeight: null,
  unlocked: 0n,
  signed: false,
  steps: [],
};

const looksLikeXmrAddress = (text) => /^[1-9A-HJ-NP-Za-km-z]{95}$|^[1-9A-HJ-NP-Za-km-z]{106}$/.test(text);
const wordCount = () => keyWordsInput.value.trim().split(/\s+/).filter(Boolean).length;
const currentState = () => (current ? moneyState({ plan, balance }) : null);

// VIOLET IS THE NEXT ACTION: "Find my swaps" once twelve words or a key file (and its password) are there,
// "Withdraw XMR" once the money is ready and an address is named.
function updateButtons() {
  const keyReady = keyFileText ? keyPassField.hidden || Boolean(keyPassInput.value) : wordCount() === 12;
  findSwapsBtn.classList.toggle("ready", keyReady);
  const state = currentState();
  withdrawBtn.classList.toggle(
    "ready",
    Boolean(state && state.state === "ready") &&
      looksLikeXmrAddress(destInput.value.trim()) &&
      !signedToken &&
      doneEl.hidden,
  );
}

// ONE PLAIN LINE PER STEP for a stop; the detail is in the technical log. `tone` is "bad" for an error and
// "wait" for a stop that is not one (nothing there yet).
const said = new Map();
function say(el, key, params = {}, tone = "bad") {
  said.set(el, [key, params]);
  el.textContent = t(key, params);
  el.dataset.tone = tone;
  el.hidden = false;
  return false;
}
function quiet(el) {
  said.delete(el);
  el.textContent = "";
  el.hidden = true;
}
// PROGRESS IS A STAGE AND A BAR. `fraction` fills the bar (the scan, block by block); null runs it without an
// end (connecting, signing, sending). `sub` returns the line under the bar. Drawn from this state, so a language
// change redraws the same numbers.
let progress = null;
function drawProgress() {
  if (!progress) {
    progressEl.hidden = true;
    return;
  }
  const { key: words, params, fraction, sub } = progress;
  const percent = fraction === null ? null : Math.max(0, Math.min(100, Math.floor(fraction * 100)));
  progressHeadEl.textContent = t(words, { ...params, percent: percent === null ? "" : n(percent) });
  progressEl.dataset.mode = percent === null ? "busy" : "fill";
  progressFillEl.style.width = percent === null ? "" : percent + "%";
  if (percent === null) progressBarEl.removeAttribute("aria-valuenow");
  else progressBarEl.setAttribute("aria-valuenow", String(percent));
  const text = sub ? sub() : "";
  progressSubEl.textContent = text;
  progressSubEl.hidden = !text;
  progressEl.hidden = false;
}
function showProgress(words, { params = {}, fraction = null, sub = null } = {}) {
  progress = { key: words, params, fraction, sub };
  drawProgress();
}
function hideProgress() {
  progress = null;
  drawProgress();
}

// TIME LEFT OF A SCAN, from its own pace so far: said only once there is a pace to go by.
function timeLeft(seconds) {
  if (!(seconds > 0) || !Number.isFinite(seconds)) return "";
  return seconds < 90
    ? t("flow.time.sec", { n: n(Math.max(1, Math.round(seconds))) })
    : t("flow.time.min", { n: n(Math.round(seconds / 60)) });
}

// A SIGNED TRANSFER BELONGS TO THE ADDRESS IT WAS SIGNED FOR: a changed address puts the confirmation away, and the
// button signs again.
function dropSigned() {
  signedToken = null;
  lastTx = null;
  confirmEl.hidden = true;
}

destInput.addEventListener("input", () => {
  if (signedToken) dropSigned();
  quiet(withdrawErrorEl);
  updateButtons();
});

// --- small interface helpers ---

function log(text, cls = "") {
  // The placeholder in the markup is a sentence, not a log line: the first real line replaces it,
  // otherwise the report starts with half a sentence glued to the first step.
  if (!logEl.dataset.started) {
    logEl.textContent = "";
    logEl.dataset.started = "1";
  }
  const line = document.createElement("span");
  line.className = cls;
  line.textContent = text + "\n";
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  window.__sweepFlow.steps.push(text);
}

// WHAT THE PAGE CHECKED: the wallet in this tab, the chosen node and a secure connection, each a line with its
// state and, when it failed, the reason. Drawn from this record, so a language change redraws it.
const checks = {
  wallet: { el: $("checkWallet"), state: "wait", why: null },
  node: { el: $("checkNode"), state: "wait", why: null },
  secure: { el: $("checkSecure"), state: "wait", why: null },
};
function setCheck(name, state, why = null) {
  checks[name].state = state;
  checks[name].why = why;
  drawChecks();
}
const checksHelp = $("checksHelp");
const nodeLine = $("nodeLine");
const LINE_STATES = { wait: "checking", ok: "good", bad: "bad" };
function drawChecks() {
  for (const [name, c] of Object.entries(checks)) {
    c.el.dataset.state = c.state;
    c.el.querySelector(".check-text").textContent = t(`check.${name}.${c.state}`);
    c.el.querySelector(".check-why").textContent = c.state === "bad" && c.why ? c.why() : "";
  }
  // A BROWSER THAT FAILS is pointed to the check of this browser; a node that fails opens the list, since then
  // the person has to choose another one. Nothing else opens by itself.
  checksHelp.hidden = checks.wallet.state !== "bad" && checks.secure.state !== "bad";
  if (checks.node.state === "bad" && !panelOpen) setPanel(true);
  // The node line under the checks burns with the same answer.
  nodeLine.dataset.state = LINE_STATES[checks.node.state];
}

function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v;
    else if (k === "class") node.className = v;
    else if (k === "href") node.href = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.appendChild(c);
  return node;
}

// PANELS REMEMBER THEIR ROWS: [label key, value, class]; a language change REDRAWS from the same data.
const panels = new Map();
function renderInfo(node, rows) {
  const draw = () => {
    node.textContent = "";
    const dl = h("dl");
    for (const [labelKey, value, cls] of rows) {
      dl.appendChild(h("dt", { "data-i18n": labelKey, text: t(labelKey) }));
      const dd = h("dd", { class: cls || "" });
      const shown = typeof value === "function" ? value() : value;
      if (shown && shown.nodeType === 1) dd.appendChild(shown);
      else dd.textContent = String(shown);
      dl.appendChild(dd);
    }
    node.appendChild(dl);
    node.hidden = false;
  };
  panels.set(node, draw);
  draw();
}

document.addEventListener("i18n:applied", () => {
  for (const draw of panels.values()) draw();
  for (const [el, [words, params]] of said) el.textContent = t(words, params);
  drawSwaps();
  if (current) drawMoney();
  drawChecks();
  drawProgress();
});

// XMR AMOUNTS ARE A PACKAGE RULE (formatXmr, BigInt): one atomic unit is "0.000000000001", and above 9007 XMR
// nothing is rounded the way Number rounded it.
const xmr = (atomic) => {
  try {
    return mod.formatXmr(atomic);
  } catch {
    return String(atomic);
  }
};
// REFUSAL IN WORDS BY CODE: the core holds SdkError.code, the language holds the wording. A plain Error (a
// transport of the page's own) is its message.
const sdkWords = (error) => t("sdk." + ((error && error.code) || "unknown"), (error && error.params) || {});
const errorWords = (error) => (error && error.code ? sdkWords(error) : String((error && error.message) || error));
const short = (address) => String(address).slice(0, 10) + "…";

// A BUTTON IS BUSY WHILE ITS STEP RUNS. An exception nobody named is logged in full and said in one plain line.
async function busy(btn, fn, errorEl = null) {
  const wasDisabled = btn.disabled;
  btn.disabled = true;
  try {
    return await fn();
  } catch (e) {
    const msg = String((e && e.message) || e);
    log(t("log.error", { message: msg }), "bad");
    hideProgress();
    if (errorEl) say(errorEl, "flow.err.generic");
    return null;
  } finally {
    btn.disabled = wasDisabled;
    updateButtons();
  }
}

// --- 0. SDK core: built under sweep/, loaded once ---

async function sdkBundle() {
  if (!mod) mod = await import(SDK_BUNDLE);
  return mod;
}

// CORE FACADE PER SETTLEMENT NETWORK AND MONERO NETWORK: a swap is read and withdrawn through the facade built for
// its own chain, never a default one.
//
// THE CHAIN READ IS REAL: `evmCall` is an eth_call over the settlement network's public RPCs (lib/settlement.js),
// and a failed read throws instead of answering "0x". order.status reads the escrow through it, and sweep.plan
// the revealed half; the plan's app route fallback meets `noService`, which it reads as "not revealed".
async function facadeFor(chainId, xmrNetwork) {
  const m = await sdkBundle();
  const id = chainId + "/" + xmrNetwork;
  if (!facades.has(id)) {
    facades.set(
      id,
      m.createNinsei({
        settlement: { chain: chainId },
        xmrNetwork,
        mode: "live",
        fetch: noService,
        storage: m.memoryAdapter(),
        evmCall: (request) => evmCall(chainId, request),
      }),
    );
  }
  return facades.get(id);
}

// --- 0b. Environment: without these checks nothing makes sense ---

// THE WALLET IN THIS TAB: the monero-ts bundle, the built SDK core and the worker file. Checked once: they do not
// change when the person picks another node, and loading them again would only repeat the same lines.
let walletCheck = null;
function checkWallet() {
  if (!walletCheck) walletCheck = loadWallet();
  return walletCheck;
}
async function loadWallet() {
  setCheck("wallet", "wait");
  const failed = [];
  try {
    const m = await import(BUNDLE);
    api = m.default || m;
    log(t("log.lib.loaded", { version: api.getVersion?.() ?? "?" }));
  } catch (e) {
    failed.push(["preflight.fail.bundle", { message: e.message }]);
  }

  // CORE. A load failure is named in the log, never swallowed.
  try {
    await sdkBundle();
    log(t("log.core.loaded", { file: SDK_BUNDLE.split("/").pop() }));
  } catch (e) {
    failed.push(["preflight.fail.core", { message: (e && e.message) || e }]);
  }

  if (api) {
    api.LibraryUtils.setWorkerDistPath(WORKER);
    try {
      const r = await fetch(WORKER);
      const buf = await r.arrayBuffer();
      if (r.status !== 200 || buf.byteLength < 1_000_000)
        throw new Error(t("preflight.fail.workerBytes", { bytes: n(buf.byteLength) }));
      log(
        t("log.worker.ok", { mb: n(buf.byteLength / 1048576, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }),
      );
    } catch (e) {
      failed.push(["preflight.fail.worker", { message: e.message }]);
    }
  }

  const why = () => failed.map(([words, params]) => t(words, params)).join("; ");
  if (failed.length) {
    log(t("log.env.notready", { list: why() }), "bad");
    setCheck("wallet", "bad", why);
    return false;
  }
  setCheck("wallet", "ok");
  return true;
}

// THE CHOSEN NODE: one get_info through the package rule (probeMoneroNode), its height and network. This is the one
// check a change of node runs again. No node chosen is a failure in its own words, never a silent fallback to one
// nobody chose. `isCurrent` is false once a newer check has started: an older answer must not paint the line or
// set the network for a node that is no longer chosen.
async function checkNode(isCurrent) {
  setCheck("node", "wait");
  if (!nodeUrl()) {
    nodeNetwork = null;
    setCheck("node", "bad", () => t("preflight.fail.noNode"));
    return false;
  }
  let core = null;
  try {
    core = await sdkBundle();
  } catch {
    // Without the core there is no probe; the wallet line names the failure.
  }
  if (!isCurrent()) return false;
  if (!core) {
    nodeNetwork = null;
    setCheck("node", "bad", () => t("node.state.unchecked"));
    return false;
  }
  const probe = await core.probeMoneroNode({ url: nodeUrl() });
  if (!isCurrent()) return false;
  nodeNetwork = probe.ok ? probe.network || null : null;
  if (!probe.ok) {
    // THE REASON IN THE NODE LIST'S OWN WORDS (nodeVerdict), with the node's name.
    const verdict = nodeVerdict(probe, null);
    const host = nodeHost(nodeUrl());
    const why = () => host + ": " + t("node.state." + verdict.why, verdict.params);
    log(t("preflight.fail.node", { message: why() }), "bad");
    setCheck("node", "bad", why);
    return false;
  }
  log(
    t("log.node.answering", {
      height: n(probe.height),
      sync: probe.synchronized,
      nettype: probe.nettype,
      node: t(nodeLabelKey(), nodeLabelParams()),
    }),
  );
  setCheck("node", "ok");
  return true;
}

// --- 1. The recovery key and the swaps it made ---

// THE WORDS OR THE FILE, NOT BOTH: typing words puts a chosen file away, and choosing a file empties the words, so
// the search never reads one while the person looks at the other.
keyWordsInput.addEventListener("input", () => {
  if (keyFileText && keyWordsInput.value.trim()) {
    keyFileText = null;
    keyFileInput.value = "";
    keyPassInput.value = "";
    keyPassField.hidden = true;
  }
  quiet(keyErrorEl);
  updateButtons();
});
keyPassInput.addEventListener("input", updateButtons);

// THE PASSWORD IS ASKED ONLY FOR A KEY FILE WRITTEN WITH ONE, and the SDK's reader says which: opening the file
// without a password stops at the stage "passphrase" for a protected file, reads a plain one, and refuses anything
// that is not a key file.
async function onKeyFileChosen() {
  quiet(keyErrorEl);
  const file = keyFileInput.files && keyFileInput.files[0];
  keyFileText = file ? await file.text() : null;
  keyPassInput.value = "";
  keyPassField.hidden = true;
  if (keyFileText) {
    keyWordsInput.value = "";
    try {
      await (await sdkBundle()).openRecoveryKeyFile(keyFileText, "");
    } catch (e) {
      if (e && e.params && e.params.stage === "passphrase") {
        keyPassField.hidden = false;
      } else {
        log(t("log.key.refused", { words: sdkWords(e) }), "bad");
        keyFileText = null;
        keyFileInput.value = "";
        say(keyErrorEl, "flow.err.keyFile");
      }
    }
  }
  updateButtons();
}

// THE KEY FROM THE FIELDS, or null with the reason said. The words are never part of a log line: a refusal names
// the SDK's code and the field, nothing typed.
async function readKey() {
  const m = await sdkBundle();
  if (keyFileText) {
    try {
      return await m.openRecoveryKeyFile(keyFileText, keyPassInput.value);
    } catch (e) {
      log(t("log.key.refused", { words: sdkWords(e) }), "bad");
      const stage = e && e.params && e.params.stage;
      if (stage === "passphrase") {
        keyPassField.hidden = false;
        say(keyErrorEl, keyPassInput.value ? "flow.err.keyDecrypt" : "flow.err.keyPass");
      } else {
        say(keyErrorEl, stage === "decrypt" || stage === "fingerprint" ? "flow.err.keyDecrypt" : "flow.err.keyFile");
      }
      return null;
    }
  }
  if (!keyWordsInput.value.trim()) {
    say(keyErrorEl, "flow.err.noKey");
    return null;
  }
  try {
    return m.importRecoveryKey(keyWordsInput.value);
  } catch (e) {
    log(t("log.key.refused", { words: sdkWords(e) }), "bad");
    say(keyErrorEl, "flow.err.words");
    return null;
  }
}

function clearKeyFields() {
  keyWordsInput.value = "";
  keyFileInput.value = "";
  keyFileText = null;
  keyPassInput.value = "";
  keyPassField.hidden = true;
}

// FIND THE SWAPS OF A KEY on every settlement network the SDK names a live factory for (lib/settlement.js,
// keyNetworks). The search reads the factory's orders and matches their commitments in this tab: only the factory,
// the topic and the block range reach the RPC. Each found swap's state and date are read from the chain; a read
// that fails is "unknown", never "nothing to do". With empty fields the button searches again with the same key.
async function findKeySwaps(options = {}) {
  const more = options && options.more === true;
  quiet(keyErrorEl);
  if (!more) {
    const typed = Boolean(keyFileText || keyWordsInput.value.trim());
    const read = typed || !key ? await readKey() : key;
    if (!read) {
      // A REFUSED NEW KEY puts the old one's answer away: under the refusal it would read as the answer to the words
      // just typed. The old key is forgotten with it; the person is trying another one.
      if (current) await closeSwap();
      key = null;
      search = null;
      drawSwaps();
      return false;
    }
    // A NEW KEY STARTS CLEAN: the swap being withdrawn closes, and the words leave the fields at once.
    if (current) await closeSwap();
    key = { mnemonic: read.mnemonic, fingerprint: read.fingerprint };
    clearKeyFields();
    search = { rows: [], failed: [], done: false, searching: true, sources: [], progress: null, aborted: false, controller: null };
    drawSwaps();
  } else if (!search || search.done || search.searching) {
    return false;
  }
  if (!key) return false;
  const m = await sdkBundle();
  if (!more) {
    const { search: networks, unreadable } = keyNetworks(m.CHAINS);
    for (const id of unreadable) {
      log(t("log.key.unreadable", { network: id }), "bad");
      search.failed.push(id);
    }
    if (!networks.length) {
      search.done = true;
      search.searching = false;
      drawSwaps();
      return say(keyErrorEl, "flow.err.keyChain");
    }
    search.sources = networks.map((net) => ({ net, nextIndex: 0, complete: false, searchedUpTo: null, error: null }));
    log(t("log.key.searching", { fp: key.fingerprint, networks: networks.map((net) => net.name).join(", ") }));
  }
  search.searching = true;
  search.aborted = false;
  search.progress = null;
  const controller = new AbortController();
  search.controller = controller;
  drawSwaps();
  for (const source of search.sources) {
    if (source.complete) continue;
    const net = source.net;
    let found;
    let latest;
    try {
      latest = await evmBlockNumber(net.id);
      found = await m.findSwaps({
        mnemonic: key.mnemonic,
        chainId: net.chainId,
        factory: net.factory,
        evmLogs: (request) => evmLogs(net.id, request),
        fromBlock: net.since,
        toBlock: latest,
        // ONE BOUNDED PAGE. The SDK default is the same 1000; a strict page is passed so a future default cannot
        // turn this continuation into a silent full scan.
        fromIndex: source.nextIndex,
        maxIndex: 1000,
        signal: controller.signal,
        onProgress: ({ scanned, index }) => {
          search.progress = { network: net.name, scanned, index };
          drawSwaps();
        },
        // THE START HEIGHT IS THE SDK'S RULE: the page hands it the order's block time and a Monero node's tip and
        // headers, read the way a node answers them (lib/node.js), from the node a swap of this network uses.
        evmBlockTime: (block) => evmBlockTime(net.id, block),
        ...(await moneroReaders(nodeFor(net.monero, nodeNetwork), net.monero, m.probeMoneroNode)),
      });
    } catch (e) {
      source.error = errorWords(e);
      if (!search.failed.includes(net.name)) search.failed.push(net.name);
      log(t("log.key.searchFailed", { network: net.name, words: errorWords(e) }), "bad");
      continue;
    }
    // A PREVIOUS FAILURE OF THIS NETWORK IS CLEARED BY A SUCCESSFUL PAGE; unreadable networks (not in sources)
    // stay named.
    const failedAt = search.failed.indexOf(net.name);
    if (failedAt >= 0) search.failed.splice(failedAt, 1);
    source.searchedUpTo = found.searchedUpTo === null || found.searchedUpTo === undefined ? null : Number(found.searchedUpTo);
    source.complete = found.complete === true;
    source.nextIndex = source.complete ? null : found.nextIndex;
    source.incompleteReason = found.complete ? null : (found.incompleteReason || "max-index");
    if (found.incompleteReason === "aborted") search.aborted = true;
    log(
      t("log.key.searched", {
        network: net.name,
        count: n(found.swaps.length),
        numbers: n(found.scanned),
        from: n(net.since),
        to: n(latest),
      }),
      found.swaps.length ? "ok" : "",
    );
    log(t("log.key.range", {
      network: net.name,
      to: n(source.searchedUpTo === null ? 0 : source.searchedUpTo),
      complete: source.complete ? t("log.key.complete") : t("log.key.incomplete", { next: n(source.nextIndex || 0) }),
    }), "wait");
    const core = await facadeFor(net.id, net.monero);
    const seen = new Set(search.rows.map((row) => String(row.swap.escrow || "").toLowerCase()));
    for (const swap of found.swaps) {
      const escrow = String(swap.escrow || "").toLowerCase();
      if (seen.has(escrow)) continue;
      seen.add(escrow);
      const row = { swap, net, side: sideOf(swap), status: null, time: null };
      try {
        row.status = await core.order.status(swap.escrow);
      } catch (e) {
        log(t("log.swap.statusFailed", { escrow: short(swap.escrow), words: errorWords(e) }), "bad");
      }
      // THE BLOCK TIME CAME BACK WITH THE SEARCH. Read it again only when the SDK did not return it; a genuine
      // genesis timestamp of 0 is a value, not a missing one.
      const blockTime = swap.blockTime === null || swap.blockTime === undefined ? NaN : Number(swap.blockTime);
      try {
        row.time =
          Number.isFinite(blockTime) && blockTime >= 0
            ? blockTime
            : Number.isSafeInteger(swap.blockNumber)
              ? await evmBlockTime(net.id, swap.blockNumber)
              : null;
      } catch (e) {
        log(t("log.swap.timeFailed", { escrow: short(swap.escrow), words: errorWords(e) }), "wait");
      }
      search.rows.push(row);
    }
  }
  search.searching = false;
  search.controller = null;
  // NEWEST FIRST, by the block that holds the order.
  search.rows.sort((a, b) => (b.swap.blockNumber ?? -1) - (a.swap.blockNumber ?? -1));
  // A FAILED NETWORK IS NOT A COMPLETE RANGE: the person can try again, and "no swaps" must stay hidden.
  search.done = search.sources.every((source) => source.complete) && search.failed.length === 0;
  const pending = search.sources.filter((source) => !source.complete);
  window.__sweepFlow.search = {
    fingerprint: key.fingerprint,
    failed: [...search.failed],
    complete: search.done,
    searchedUpTo: search.sources.reduce((top, source) => (
      source.searchedUpTo !== null && (top === null || source.searchedUpTo > top) ? source.searchedUpTo : top
    ), null),
    nextIndex: pending.length ? Math.min(...pending.map((source) => Number(source.nextIndex || 0))) : null,
    incompleteReason: search.done ? null : (search.aborted ? "aborted" : (pending[0] && pending[0].incompleteReason) || "max-index"),
    swaps: search.rows.map((row) => ({ escrow: row.swap.escrow, side: row.side, ...swapStateOf(row) })),
  };
  drawSwaps();
  if (search.failed.length && !search.rows.length && search.failed.length >= search.sources.length) {
    return say(keyErrorEl, "flow.err.search");
  }
  return true;
}

// THE DEADLINE OF A FOUND ORDER in ms, by the SDK's one conversion; a value of the wrong scale is unknown.
function deadlineOf(swap) {
  try {
    return mod.msFromOrderSeconds(swap.t1, "t1");
  } catch {
    return null;
  }
}
const swapStateOf = (row) =>
  swapState({ side: row.side, status: row.status, deadline: deadlineOf(row.swap), now: Date.now() });

// THE ORDER'S AMOUNT in the settlement chain's coin, for display: the escrow holds it in its smallest unit.
function coinAmount(row) {
  const decimals = Number(row.net.native && row.net.native.decimals) || 18;
  const symbol = (row.net.native && row.net.native.symbol) || "ETH";
  try {
    const units = BigInt(row.swap.amount);
    const scale = 10n ** BigInt(decimals);
    const whole = units / scale;
    const fraction = (units % scale).toString().padStart(decimals, "0").slice(0, 6);
    return t("swap.amount", { amount: n(Number(`${whole}.${fraction}`), { maximumFractionDigits: 6 }), symbol });
  } catch {
    return t("swap.amount.unknown");
  }
}

// THE LIST, drawn from the last search, so a language change redraws the same rows. An incomplete page keeps its
// rows, names the range it covered and offers the next page; "no swaps" waits for a complete range.
function drawSwaps() {
  keyResultEl.hidden = !key || !search;
  if (keyResultEl.hidden) {
    swapListEl.replaceChildren();
    return;
  }
  keyPrintEl.textContent = t("key.print", { fp: key.fingerprint });
  const rows = search.rows;
  keyCountEl.textContent = search.searching
    ? (search.progress ? t("key.progress", { count: n(search.progress.scanned) }) : t("key.searching"))
    : rows.length
      ? (search.done ? t("key.count", { count: rows.length }) : t("key.count.partial", { count: rows.length }))
      : "";
  keyNoneEl.hidden = !search.done || rows.length > 0 || search.failed.length > 0;
  keyPartialEl.hidden = !search.failed.length;
  keyPartialEl.textContent = search.failed.length ? t("key.partial", { list: search.failed.join(", ") }) : "";
  const pending = (search.sources || []).filter((source) => !source.complete);
  const top = pending.reduce((best, source) => (
    source.searchedUpTo !== null && (best === null || source.searchedUpTo > best) ? source.searchedUpTo : best
  ), null);
  keyRangeEl.hidden = search.done || !pending.length || (search.searching && top === null);
  keyRangeEl.textContent = keyRangeEl.hidden ? "" : t("key.range", { to: n(top === null ? 0 : top) });
  keyMoreEl.hidden = search.done || search.searching || !pending.length;
  keyStopEl.hidden = !search.searching;
  keyActionsEl.hidden = keyMoreEl.hidden && keyStopEl.hidden;
  swapListEl.replaceChildren(...rows.map(swapRow));
}

function swapRow(row) {
  const state = swapStateOf(row);
  const when = row.time ? d(row.time * 1000, { dateStyle: "medium" }) : t("swap.date.unknown");
  const side = t(row.side === "buy" ? "value.side.buy" : row.side === "sell" ? "value.side.sell" : "swap.side.unknown");
  let action;
  if (state.action === "withdraw") {
    action = h("button", {
      type: "button",
      class: current === row ? "small ready" : "small",
      text: t("swap.action.withdraw"),
    });
    action.addEventListener("click", () => busy(action, () => openSwap(row), openErrorEl));
  } else {
    action = h("span", {
      class: "swap-action",
      text: t("swap.action." + state.action, { deadline: state.params.deadline ? d(state.params.deadline) : "" }),
    });
  }
  return h(
    "li",
    { class: "swap", "data-action": state.action, ...(current === row ? { "aria-current": "true" } : {}) },
    [
      h("div", { class: "swap-top" }, [
        h("span", { class: "swap-side", text: side }),
        h("span", { class: "swap-amount", text: coinAmount(row) }),
        h("span", { class: "swap-date", text: `${when} · ${row.net.name}` }),
      ]),
      h("p", {
        class: "swap-state",
        text: t("swap.state." + state.state, { deadline: state.params.deadline ? d(state.params.deadline) : "" }),
      }),
      h("div", { class: "swap-do" }, [action]),
    ],
  );
}

// --- 2. One swap: its keys, its start height, the SDK's plan ---

// OPEN ONE SWAP FOR THE WITHDRAWAL. sweep.fromOrder takes the key and the order, checks the chain's points against
// the key, builds the joint address and returns the file the plan reads. Nothing is written to disk.
async function openSwap(row) {
  quiet(openErrorEl);
  if (!key) return say(keyErrorEl, "key.gone", {}, "wait");
  // ONE SWAP AT A TIME: a wallet of another swap closes first, so a withdrawal never goes from the wrong address.
  if (current) await closeSwap();
  current = row;
  // AN OPEN IS A FIXED CONTEXT. A later open of another row supersedes this one; its continuations must not write
  // contents, plan or balance under the newly selected row.
  const stillCurrent = () => current === row;
  settlement = row.net.id;
  network = row.net.monero;
  window.__sweepFlow.network = network;
  stepSwap.hidden = false;
  moneyEl.hidden = false;
  moneyEl.dataset.state = "wait";
  moneyHeadEl.textContent = t("money.reading");
  swapInfoEl.hidden = true;
  drawSwaps();
  stepSwap.scrollIntoView({ block: "nearest" });
  // A TESTNET SWAP NEEDS A STAGENET NODE. If the current pick is on another network, the project's stagenet node is
  // chosen; the withdrawal still refuses a node of another network instead of scanning the wrong chain.
  if (network === "stagenet" && nodeNetwork !== "stagenet" && !nodeLocked()) {
    setNodeUrl(STAGENET_NODE, { remember: false, by: "pick" });
    try {
      await checkNode(() => true);
      drawCurrent();
    } catch {
      /* the withdrawal names the node failure */
    }
  }
  if (!stillCurrent()) return false;
  const core = await facadeFor(settlement, network);
  if (!stillCurrent()) return false;
  // THE SDK BUILDS THE WITHDRAWAL FROM THE KEY AND THE ORDER. It decides the side, checks the chain's points against
  // the key, builds the joint address and returns the file plan/keys accept. The page keeps no payload rule.
  let material;
  try {
    material = await core.sweep.fromOrder({
      mnemonic: key.mnemonic,
      chainId: row.net.chainId,
      network: settlement,
      moneroNetwork: network,
      order: row.swap,
    });
    if (!stillCurrent()) return false;
  } catch (e) {
    const why = e && e.params && e.params.why;
    log(t("log.order." + (why || "bad"), { escrow: row.swap.escrow }), "bad");
    moneyEl.hidden = true;
    return say(openErrorEl, why === "maker-view-point" ? "flow.err.view" : "flow.err.order");
  }
  const address = material.address;
  // The chain holds the locker's view point. On a buy that is the person's own, so the maker's view half is on no
  // chain and only the scan can show it; on a sell the maker's point was checked against the key by fromOrder.
  log(
    t(row.side === "buy" ? "log.swap.address.unchecked" : "log.swap.address.checked", {
      address,
      escrow: row.swap.escrow,
    }),
  );
  // THE START HEIGHT CAME WITH THE SEARCH (findSwaps). None is said with the SDK's reason, and the step asks for one.
  const startHeight = Number(row.swap.startHeight) > 0 ? Number(row.swap.startHeight) : null;
  if (startHeight) log(t("log.height.found", { height: n(startHeight), block: n(row.swap.blockNumber) }));
  else log(t("log.height.failed", { why: row.swap.startHeightReason || "?" }), "wait");
  contents = material.contents;
  // PLAN IS THE CORE'S (sweep.plan): the address, the height and the maker's half, read from the escrow.
  // THE PLAN IS HELD IN A LOCAL UNTIL THE CONTEXT IS CHECKED. Assigning the global first let a slow plan for
  // row A land after row B was opened: the screen and contents were B's, the plan was A's, and B's withdrawal
  // was refused until it was reopened.
  try {
    const planned = await core.sweep.plan({ file: { contents }, passphrase: "" });
    if (!stillCurrent()) return false;
    plan = planned;
  } catch (e) {
    log(t("log.plan.failed", { words: sdkWords(e) }), "bad");
    contents = null;
    moneyEl.hidden = true;
    return say(openErrorEl, "flow.err.plan");
  }
  window.__sweepFlow.plan = {
    address: plan.address,
    restoreHeight: plan.restoreHeight,
    missing: [...plan.missing],
    revealedHalf: plan.revealedHalf,
  };
  window.__sweepFlow.address = plan.address;
  if (plan.missing.includes("revealed-half")) log(t("log.miss.revealedHalf"), "wait");
  const height = Number(plan.restoreHeight) > 0 ? Number(plan.restoreHeight) : 0;
  heightInput.value = height > 0 ? String(height) : "";
  window.__sweepFlow.restoreHeight = height;
  // NO HEIGHT IS A NAMED STATE: the scan would start from Monero's first block and take hours, so the step says it
  // and shows the field for the person to fill. A known height stays out of sight.
  heightBox.hidden = height > 0;
  balance = null;
  drawMoney();
  const ready = currentState().state === "ready";
  stepTransfer.hidden = !ready;
  updateButtons();
  if (ready) log(t("log.next.address"));
  return true;
}

// --- 3. The state of the money, in words ---

const STATE_TONES = { ready: "ok", unread: "wait", locked: "wait", withdrawn: "none", unseen: "wait", nothing: "none" };

function drawMoney() {
  const m = currentState();
  moneyEl.dataset.state = STATE_TONES[m.state] || "none";
  moneyHeadEl.textContent = t("money." + m.state);
  const row = current;
  const rows = [
    ["info.swap", row.swap.escrow],
    ["info.side", () => t(row.side === "buy" ? "value.side.buy" : "value.side.sell")],
    ["info.amount.order", () => coinAmount(row)],
    ["info.date", () => (row.time ? d(row.time * 1000) : t("swap.date.unknown"))],
    ["info.network", () => t("value.network", { settlement: row.net.name, monero: row.net.monero })],
  ];
  renderInfo(swapInfoEl, rows);
  moneyEl.hidden = false;
}

// --- 4. Withdraw: refresh, build and sign, then confirm ---

// THE SAME WALLET, A FRESH BALANCE. `sync` is enough while the adapter is open; a closed adapter (the SDK closes it
// after a failed signature and after every relay) is discarded and rebuilt from the same key and plan. The returned
// value is `true` or the key of the plain line that says why not.
async function refreshBalance() {
  if (!adapter || !wallet) return syncWallet();
  try {
    await adapter.sync();
    const total = BigInt(await wallet.getBalance());
    const unlocked = BigInt(await adapter.unlockedBalance());
    let txs = null;
    try {
      txs = (await wallet.getTxs()).length;
    } catch {
      /* how many transactions the wallet sees stays unknown */
    }
    balance = { total, unlocked, txs };
    return true;
  } catch (e) {
    log(t("log.wallet.closed", { words: sdkWords(e) }), "wait");
    await closeWallet();
    return syncWallet();
  }
}

async function withdraw() {
  quiet(withdrawErrorEl);
  dropSigned();
  if (!current || !plan || !contents) return say(withdrawErrorEl, "flow.err.open");
  if (!destInput.value.trim()) return say(withdrawErrorEl, "flow.err.dest.empty");
  // THE NODE AND THE SWAP MUST BE ON ONE NETWORK: a stagenet swap against a mainnet node finds nothing and would look
  // like an empty wallet.
  if (!nodeNetwork) return say(withdrawErrorEl, "flow.err.noNode");
  if (nodeNetwork !== network) return say(withdrawErrorEl, "flow.err.networks", { swap: network, node: nodeNetwork });
  // EVERY SPENDING DECISION IS TAKEN ON A FRESH BALANCE. A saved balance is a snapshot: after "locked" the outputs may
  // have matured, and after a failed signature the SDK has closed the wallet while the page still holds the adapter.
  // Refresh the wallet in place when it is still open, and rebuild it when it is not.
  const synced = await refreshBalance();
  if (synced !== true) {
    hideProgress();
    return say(withdrawErrorEl, synced);
  }
  drawMoney();
  const m = currentState();
  if (m.state !== "ready") {
    hideProgress();
    return say(withdrawErrorEl, "money." + m.state, {}, "wait");
  }
  showProgress("flow.progress.sign");
  const built = await buildTx();
  hideProgress();
  if (built !== true) return say(withdrawErrorEl, built);
  showTx();
  confirmEl.hidden = false;
  updateButtons();
  confirmEl.scrollIntoView({ block: "nearest" });
  log(t("log.next.send"));
  return true;
}

// A WALLET THAT DID NOT OPEN, said by cause: the core refused to build it, the keys do not give the swap's address,
// or the node did not serve it.
const WALLET_STOPS = {
  "bad-input": "flow.err.walletBuild",
  "wrong-chain": "flow.err.walletBuild",
  "recovery-failed": "flow.err.keys",
};

// THE WALLET OF THE SWAP + SYNC. Returns true, or the key of the plain line that says why not; the detail is logged.
async function syncWallet() {
  const dest = destInput.value.trim();
  const height = Number(heightInput.value.trim() || 0) || Number(plan.restoreHeight) || 0;
  const core = await facadeFor(settlement, network);

  // ADDRESS IS A PACKAGE RULE (sweep.destination): shape and network; monero-ts is not a second judge.
  let verdict;
  try {
    verdict = await core.sweep.destination({ file: { contents }, passphrase: "", dest });
  } catch (e) {
    log(t("log.dest.refused", { words: sdkWords(e) }), "bad");
    return "flow.err.dest";
  }
  if (!verdict.ok) {
    log(t("log.dest.refused", { words: verdict.reason || "?" }), "bad");
    return "flow.err.dest";
  }
  log(t("log.dest.accepted", { network }));

  // KEYS ARE THE CORE'S: sweep.keys sums the key's half and the maker's REVEALED half and checks (s_a + s_b)*G.
  let keys;
  try {
    keys = await core.sweep.keys({ file: { contents }, passphrase: "" });
  } catch (e) {
    log(t("log.keys.failed", { words: sdkWords(e) }), "bad");
    return "flow.err.keys";
  }
  const fields = {
    privateSpendKey: keys.privateSpendKey,
    privateViewKey: keys.privateViewKey,
    primaryAddress: keys.address,
  };
  log(t("log.keys.summed"), "ok");

  // WALLET IS THE CORE'S (sweep.wallet), including network name to library enum; the page passes monero-ts and the facts.
  showProgress("flow.progress.connect");
  adapter = core.sweep.wallet({
    moneroTs: api,
    network,
    serverUri: nodeUrl(),
    password: "ninsei-sweep-session",
    keys: fields,
    restoreHeight: height,
    expectedAddress: plan.address,
  });
  // THE WALLET IS BOUND TO THIS NODE NOW: the choice closes until the wallet is forgotten.
  updateNodeLock();
  // THE CORE WALLET UNDER ITS OWN NAME, so (...balances) is not read as a call on monero-ts by the API check.
  const coreWallet = core.wallet;
  coreWallet.use(adapter);
  try {
    await coreWallet.connect();
  } catch (e) {
    log(t("log.wallet.notConnected", { words: sdkWords(e) }), "bad");
    adapter = null;
    updateNodeLock();
    return WALLET_STOPS[e && e.code] || "flow.err.wallet";
  }
  wallet = adapter.driver();
  log(t("log.wallet.restored"), "ok");

  // PROGRESS IS SHOWN, NOT NEEDED. The scan is sweep.restore's rescanBlockchain, which tells no listener how far it
  // is, so the bar runs without an end over the start block and the time so far. The count of new blocks is not
  // shown: measured on stagenet, 321 blocks and 4,015 blocks both took about three minutes, spent fetching the
  // chain's block hashes. A wallet that does report (a sync pass) fills the bar and says the time left.
  const scanStarted = performance.now();
  const scanFrom = Math.max(0, Number(height) - 10);
  const soFar = () => {
    const sec = Math.floor((performance.now() - scanStarted) / 1000);
    const clock = Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
    return t("flow.progress.since", { from: n(scanFrom), time: clock });
  };
  let listener = null;
  try {
    listener = new (class extends api.MoneroWalletListener {
      async onSyncProgress(at, start, end, done) {
        const fraction = Math.min(1, Math.max(0, Number(done) || 0));
        const elapsed = (performance.now() - scanStarted) / 1000;
        const left = fraction >= 0.03 && elapsed > 3 ? timeLeft((elapsed * (1 - fraction)) / fraction) : "";
        showProgress("flow.progress.scan", {
          fraction,
          sub: () => {
            const blocks = t("flow.progress.blocks", { at: n(Number(at)), end: n(Number(end)) });
            return left ? blocks + " · " + t("flow.progress.left", { time: left }) : blocks;
          },
        });
      }
    })();
    await wallet.addListener(listener);
  } catch {
    listener = null;
  }
  showProgress("flow.progress.scanning", { sub: soFar });
  const ticker = setInterval(() => {
    if (progress && progress.sub === soFar) drawProgress();
  }, 1000);

  // RESTORE IS A PACKAGE RULE (sweep.restore): the blocks around the lock first, then the full scan only if
  // that window holds nothing. The window ends at the Monero block at or after the order's t1, plus ten.
  // THE WINDOW HAS ITS OWN NAME: a local `window` would hide the browser's, and this function still writes
  // window.__sweepFlow after the scan.
  let lockWindow = null;
  try {
    const tipHeight = Number(await wallet.getDaemonHeight());
    // The found order's deadline, by the SDK's one conversion (deadlineOf); a deadline of the wrong scale is no
    // window. The swap is `current`: this page holds no per-swap payload outside the SDK's envelope text.
    const deadline = deadlineOf(current.swap);
    const t1Sec = deadline ? Math.floor(deadline / 1000) : 0;
    lockWindow = await restoreWindow({ nodeUrl: nodeUrl(), t1Sec, startHeight: height, tipHeight });
  } catch {
    lockWindow = null;
  }
  const t0 = performance.now();
  let restored;
  try {
    log(t("log.scan.start", { from: n(scanFrom), height: n(height) }));
    restored = await core.sweep.restore({ wallet: adapter, fromHeight: height, scanBack: 10, window: lockWindow });
  } catch (e) {
    log(t("log.rescan.failed", { why: (e && e.message) || e }), "bad");
    return "flow.err.sync";
  } finally {
    clearInterval(ticker);
    if (listener) {
      try {
        await wallet.removeListener(listener);
      } catch {
        /* the wallet may be closing; progress is display only */
      }
    }
  }
  const ms = Math.round(performance.now() - t0);
  const unlocked = BigInt(restored.unlocked);
  const total = BigInt(restored.total);
  // HOW MANY TRANSACTIONS THE WALLET SEES tells "withdrawn" (XMR came and left) from "unseen" (nothing ever came to
  // the address this key gives); a wallet that cannot say leaves it unknown.
  let txs = null;
  try {
    txs = (await wallet.getTxs()).length;
  } catch (e) {
    log(t("log.diag.failed", { why: String((e && e.message) || e) }), "wait");
  }
  balance = { total, unlocked, txs };
  log(
    t("log.restored.passes", {
      passes: n(restored.passes),
      locked: restored.lockedPass ? t("value.yes") : t("value.no"),
    }),
    "ok",
  );
  if (restored.window && restored.window.used) {
    log(
      t("log.scan.window", {
        from: n(restored.window.fromHeight),
        to: n(restored.window.toHeight),
        txs: n(restored.window.txs),
      }),
      "ok",
    );
  } else if (lockWindow) {
    log(
      t("log.scan.window.skipped", {
        why: restored.window && restored.window.skipped ? restored.window.skipped : t("value.no"),
      }),
      "wait",
    );
  }

  const walletHeight = await wallet.getHeight();
  const nodeHeight = await wallet.getDaemonHeight();
  window.__sweepFlow.unlocked = unlocked;
  window.__sweepFlow.syncInfo = {
    walletHeight,
    nodeHeight,
    txs,
    balance: String(total),
    unlocked: String(unlocked),
    scanHeight: height,
  };
  log(t("log.sync.took", { ms: n(ms), height: n(height || 0) }));
  if (unlocked > 0n)
    log(t("log.synced.ok", { xmr: xmr(unlocked), walletHeight: n(walletHeight), nodeHeight: n(nodeHeight) }), "ok");
  else if (total > 0n) log(t("log.synced.zero.locked", { total: xmr(total) }), "wait");
  else if (txs === 0) log(t("log.synced.unseen", { address: plan.address, height: n(height) }), "warn");
  else log(t("log.synced.zero.empty", { txs: txs === null ? "?" : n(txs) }), "wait");
  return true;
}

// BUILD AND SIGN, NOT SEND. Returns true, or the key of the plain line that says why not.
async function buildTx() {
  const dest = destInput.value.trim();
  // THE ADDRESS AGAINST THE SWAP'S NETWORK IS A PACKAGE RULE (sweep.destination); the person names the address. A
  // swap found by the key promised no address: the chain holds none.
  const core = await facadeFor(settlement, network);
  let verdict;
  try {
    verdict = await core.sweep.destination({ file: { contents }, passphrase: "", dest });
  } catch (e) {
    log(t("log.dest.refused", { words: sdkWords(e) }), "bad");
    return "flow.err.dest";
  }
  if (!verdict.ok) {
    log(t("log.dest.refused", { words: verdict.reason || "?" }), "bad");
    return "flow.err.dest";
  }

  // SIGNING IS THE CORE'S (sweep.sign): plan -> wallet -> sync -> unlocked balance -> signature WITHOUT sending.
  // An empty balance stops with `insufficient-funds` BEFORE signing, on the SAME wallet scanned above.
  let signed;
  try {
    signed = await core.sweep.sign({
      file: { contents },
      passphrase: "",
      to: dest,
      connectWallet: async () =>
        mod.moneroWallet({
          createWallet: async () => wallet,
          serverUri: nodeUrl(),
          password: "ninsei-sweep-session",
          fields: {},
        }),
    });
  } catch (e) {
    const words = sdkWords(e);
    log(t("log.sign.stopped", { words }), "bad");
    // The code goes to state and log: words for the person, the code for debugging.
    window.__sweepFlow.sdkError = { code: (e && e.code) || null, params: (e && e.params) || null, words };
    return "flow.err.sign";
  }
  signedToken = signed.token;
  window.__sweepFlow.signed = true;

  // FEE AND RECEIVE COME FROM sweep.sign. The whole unlocked balance is withdrawn, so the fee is subtracted and
  // `receive` is what arrives; a missing fee is null, shown as "unknown", never as zero.
  lastTx = { amount: BigInt(signed.amount), fee: signed.fee, receive: signed.receive, dest };
  log(t("log.signed", { token: signedToken }));
  return true;
}

function explorerLink(id) {
  const a = document.createElement("a");
  a.href = EXPLORER[network] + id;
  a.target = "_blank";
  a.rel = "noreferrer noopener";
  a.className = "explorer-link";
  a.appendChild(document.createTextNode(t("link.explorer")));
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("d", "M10 1h5v5h-2V4.4L7.7 9.7 6.3 8.3 11.6 3H10V1zM2 3h5v2H4v7h7V9h2v7H2V3z");
  svg.appendChild(path);
  a.appendChild(svg);
  return a;
}

// THE CONFIRMATION: drawn from lastTx, so a language change keeps the same numbers and addresses.
function showTx() {
  if (!lastTx) return;
  const tx = lastTx;
  renderInfo(txInfoEl, [
    ["info.amount", () => t("value.amount", { xmr: xmr(tx.amount) })],
    [
      "info.fee",
      () => (tx.fee === null ? t("value.fee.unknown") : xmr(BigInt(tx.fee)) + " XMR"),
      tx.fee === null ? "warn" : "",
    ],
    [
      "info.receive",
      () => (tx.receive === null ? t("value.receive.unknown") : xmr(BigInt(tx.receive)) + " XMR"),
      tx.receive === null ? "warn" : "good",
    ],
    ["info.recipient", tx.dest],
  ]);
}

async function sendTx() {
  quiet(withdrawErrorEl);
  if (!signedToken) {
    log(t("log.nothing.toSend"), "bad");
    return say(withdrawErrorEl, "flow.err.send");
  }
  showProgress("flow.progress.send");
  let out;
  try {
    // SENDING IS THE CORE'S (sweep.relay). Its "withdrawn" mark for a service meets `noService` and goes nowhere.
    out = await (await facadeFor(settlement, network)).sweep.relay({ token: signedToken });
  } catch (e) {
    hideProgress();
    // THE NODE MAY HAVE ACCEPTED THE TRANSACTION AND LOST ONLY THE REPLY. A definite "not sent" would be false, and a
    // second Confirm would use a session that no longer exists. Drop the session, leave the wallet for a fresh balance
    // check, and ask the person to look at the wallet before trying again.
    log(t("log.send.unknown", { words: sdkWords(e) }), "bad");
    signedToken = null;
    lastTx = null;
    confirmEl.hidden = true;
    window.__sweepFlow.signed = false;
    updateButtons();
    return say(withdrawErrorEl, "flow.err.sendUnknown");
  }
  hideProgress();
  signedToken = null;
  const hashes = Array.isArray(out.txids) ? out.txids : [];
  log(t("log.sent", { txids: hashes.join(", ") }), "ok");
  confirmEl.hidden = true;
  showDone(hashes);
  // THE WALLET IS EMPTY NOW: the button would only sign for zero. The keys have done their job, so they leave the
  // tab's memory at once instead of waiting for the tab to close; the sent view and the txid stay.
  withdrawBtn.disabled = true;
  await dropKeys();
  log(t("log.done"), "ok");
  return true;
}

// SENT: every transaction of a split sweep and where to see each one.
function showDone(txids) {
  const list = (Array.isArray(txids) ? txids : []).filter((id) => typeof id === "string" && id);
  const rows = list.length
    ? list.map((id) => ["info.txid", () => explorerLink(id)])
    : [["info.txid", t("value.txid.none")]];
  renderInfo(doneInfoEl, rows);
  doneEl.hidden = false;
  updateButtons();
}

// THE WALLET CLOSES and the node choice opens again; a failed close must not keep the rest in memory. The facade is
// told as well: its `wallet` object caches the keyed adapter and would otherwise rebuild the same wallet on the next
// `connect()` without asking for the key again.
async function closeWallet() {
  const core = settlement && network ? facades.get(settlement + "/" + network) : null;
  try {
    if (adapter) await adapter.close();
  } catch {
    /* the keys go below either way */
  }
  adapter = null;
  wallet = null;
  if (core) {
    try {
      await core.wallet.disconnect();
    } catch {
      /* the adapter is already gone */
    }
  }
  updateNodeLock();
}

// ANOTHER SWAP OR ANOTHER KEY: the wallet closes, the swap's payload and the signed transfer go, and the step is
// back to "choose a swap". The key and the list stay: the person is choosing among them.
async function closeSwap() {
  await closeWallet();
  current = null;
  contents = null;
  plan = null;
  network = null;
  settlement = null;
  balance = null;
  signedToken = null;
  lastTx = null;
  window.__sweepFlow = {
    ready: window.__sweepFlow.ready,
    network: null,
    address: null,
    restoreHeight: null,
    unlocked: 0n,
    signed: false,
    steps: window.__sweepFlow.steps,
    search: window.__sweepFlow.search,
  };
  stepSwap.hidden = true;
  stepTransfer.hidden = true;
  moneyEl.hidden = true;
  confirmEl.hidden = true;
  doneEl.hidden = true;
  quiet(openErrorEl);
  quiet(withdrawErrorEl);
  hideProgress();
  withdrawBtn.disabled = false;
  destInput.value = "";
  heightInput.value = "";
  heightBox.hidden = true;
  drawSwaps();
  updateButtons();
}

// THE KEYS LEAVE WITH THE TRANSFER: the wallet closes, and the recovery key, the swap's payload and the signed
// transfer go. The sent view and the txid stay; the list goes with the key, since every action in it needs the key.
async function dropKeys() {
  await closeWallet();
  // THE FACADES HOLD THE ONLY CACHED ADAPTERS. Disconnecting is not enough if the facade itself survives in this map:
  // clear it, so a later `createNinsei` starts from the key it is given and not from a wallet built from this one.
  facades.clear();
  key = null;
  search = null;
  contents = null;
  signedToken = null;
  lastTx = null;
  clearKeyFields();
  drawSwaps();
  say(keyErrorEl, "key.gone", {}, "wait");
  log(t("log.forgotten"), "ok");
}

// --- 0c. Node: a checked list, the page's pick or the person's own ---
// The choice can change BEFORE the wallet exists; afterwards it would be a different wallet, so it cannot.
//
// WHAT THE CHECK SENDS: each listed node is asked for `get_info`, which tells it only that a visitor asked for
// its height. The recovery file, the password and the keys never leave the tab.
const nodeList = $("nodeList");
const nodeInput = $("node");
const nodeNote = $("nodeNote");
const ownRow = nodeList.querySelector(".node-own");
const ownRadio = ownRow.querySelector('input[type="radio"]');
// The badge reuses the label style the node line already has: no new stylesheet rule, and the page's CSP
// permits the stylesheet it already loads.
const nodeOwnBadge = h("span", { class: "node-label", hidden: "" });
ownRow.querySelector(".node-name").after(nodeOwnBadge);
const nodePanel = $("nodePanel");
const nodeCurrentEl = $("nodeCurrent");
const nodeChangeBtn = $("nodeChange");

// THE LIST IS FOLDED INTO ONE LINE: the chosen node and how fast it answered. "Change" opens the list; the page
// opens it by itself only when no node answers well, since then the person has to choose.
let panelOpen = false;
function setPanel(open) {
  panelOpen = open;
  nodePanel.hidden = !open;
  nodeChangeBtn.setAttribute("aria-expanded", String(open));
  drawCurrent();
}
nodeChangeBtn.addEventListener("click", () => setPanel(!panelOpen));

function drawCurrent() {
  const url = nodeUrl();
  const row = url ? rowFor(url) : null;
  const ms = row && row.answer && row.answer.ok ? " · " + t("node.ms", { ms: n(row.answer.ms) }) : "";
  nodeCurrentEl.textContent = url ? nodeHost(url) + ms : t("node.current.none");
  nodeChangeBtn.textContent = t(panelOpen ? "page.node.hide" : "page.node.change");
}

// A HIDDEN TAB IS ASKED AGAIN when it comes back after this long: a node that answered an hour ago may not now.
const RECHECK_AFTER_MS = 60_000;

// ONE ENTRY PER ROW: the listed nodes in list order, then the person's own. `answer` is the faster of two
// probeMoneroNode results, null while the page is asking; `ask` numbers the requests, so an answer to an
// older one (another address in the own field, an earlier round) is dropped.
const listed = NODES.map((url) => ({ url, network: nodeNetworkOf(url), answer: null, ask: 0, el: null, radio: null }));
const own = { url: null, network: null, answer: null, ask: 0, refused: null, el: ownRow };
let picking = false; // the page holds the choice, not the person: a re-check may pick again
let note = null; // [key, params] of the line under the list

function nodeLocked() {
  return Boolean(adapter || wallet);
}

function rowFor(url) {
  return listed.find((row) => row.url === url) || (url && own.url === url ? own : null);
}

function networkOfRow(row) {
  return row === own ? (own.answer && own.answer.ok ? own.answer.network : "mainnet") : row.network;
}

function verdictOf(row) {
  if (row === own && !own.url) return own.refused ? { state: "bad", why: null } : { state: "idle", why: null };
  const network = networkOfRow(row);
  const peers = [...listed, own].filter((peer) => networkOfRow(peer) === network);
  return nodeVerdict(
    row.answer,
    medianHeight(
      peers.map((peer) => peer.answer),
      network,
    ),
    network,
  );
}

function stateOf(url) {
  const row = url ? rowFor(url) : null;
  return row ? verdictOf(row).state : null;
}

function buildRows() {
  for (const row of listed) {
    row.radio = h("input", { type: "radio", name: "node", value: row.url });
    row.radio.addEventListener("change", () => {
      if (row.radio.checked) chooseListed(row.url);
    });
    row.el = h("div", { class: "node", "data-state": "checking" }, [
      h("label", { class: "node-pick", title: row.url }, [
        row.radio,
        h("span", { class: "node-text" }, [
          h("span", { class: "node-name" }, [
            h("span", { class: "node-host", text: nodeHost(row.url) }),
            h("span", { class: "node-label", text: "· " + t("node.badge." + row.network) }),
          ]),
          h("span", { class: "node-why" }),
        ]),
        h("span", { class: "node-signal" }, [
          h("span", { class: "node-dot", "aria-hidden": "true" }),
          h("span", { class: "node-ms" }),
        ]),
      ]),
    ]);
    nodeList.insertBefore(row.el, ownRow);
  }
}

// A ROW IS DRAWN FROM ITS ANSWER, so a language change or a new answer elsewhere (a new median) redraws it.
function drawRows() {
  for (const row of [...listed, own]) {
    const verdict = verdictOf(row);
    row.el.dataset.state = verdict.state;
    let why = "";
    if (row === own && own.refused) why = t("node.why." + own.refused);
    else if (verdict.why) {
      const p = verdict.params;
      why = t("node.state." + verdict.why, {
        ...p,
        height: p.height === undefined ? undefined : n(p.height),
        blocks: p.blocks === undefined ? undefined : n(p.blocks),
      });
    }
    row.el.querySelector(".node-why").textContent = why;
    row.el.querySelector(".node-ms").textContent =
      row.answer && row.answer.ok ? t("node.ms", { ms: n(row.answer.ms) }) : "";
  }
  const ownNetwork = own.answer && own.answer.ok ? own.answer.network : null;
  nodeOwnBadge.hidden = !ownNetwork;
  nodeOwnBadge.textContent = ownNetwork ? "· " + t("node.badge." + ownNetwork) : "";
  drawCurrent();
}

function drawNote() {
  const locked = nodeLocked();
  const words = locked ? t("log.node.locked") : note ? t(note[0], note[1]) : "";
  nodeNote.textContent = words;
  nodeNote.hidden = !words;
  drawCurrent();
}

function updateNodeLock() {
  nodeList.disabled = nodeLocked();
  drawNote();
}

// THE RADIOS SHOW THE MODULE'S CHOICE; the own row is checked when the choice is the person's own address,
// or when the person chose the own row and its field is empty or refused.
function markChoice(url, ownChosen = false) {
  for (const row of listed) row.radio.checked = row.url === url;
  ownRadio.checked = ownChosen || Boolean(url && own.url === url && !NODES.includes(url));
}

async function pingRows(rows) {
  let core = null;
  try {
    core = await sdkBundle();
  } catch {
    // Without the core there is no probe: the rows say "not checked" and the wallet line names the failure.
  }
  const asked = rows.map((row) => {
    row.ask += 1;
    row.answer = core ? null : { ok: false, why: "unchecked" };
    return { row, url: row.url, ask: row.ask };
  });
  drawRows();
  if (!core) return;
  await Promise.all(
    asked.map(async ({ row, url, ask }) => {
      const answer = await pingNode(url, core.probeMoneroNode);
      if (row.ask !== ask || row.url !== url) return;
      row.answer = answer;
      drawRows();
    }),
  );
}

const pingAll = () => pingRows(own.url ? [...listed, own] : listed);

// THE PAGE'S PICK: the fastest good listed node, or nothing - said plainly - when none is good.
function autoPick() {
  if (!picking) return false;
  const before = nodeUrl();
  const url = fastestGood(listed, "mainnet");
  if (url) {
    setNodeUrl(url, { remember: false, by: "pick" });
    note = ["node.note.picked", { host: nodeHost(url) }];
  } else {
    clearNodeUrl();
    note = ["node.note.none"];
  }
  markChoice(url);
  drawNote();
  return nodeUrl() !== before;
}

function chooseListed(url) {
  if (nodeLocked()) {
    markChoice(nodeUrl());
    drawNote();
    return;
  }
  picking = false;
  setNodeUrl(url);
  markChoice(url);
  note = null;
  drawNote();
  checkEnvironment();
}

// THE OWN ROW: chosen by its radio or by a change in its field. The field goes through the one parser; a
// refusal is said in its own words and leaves no node chosen, never the previous one in disguise.
function chooseOwn() {
  if (nodeLocked()) {
    markChoice(nodeUrl());
    drawNote();
    return;
  }
  picking = false;
  const parsed = parseNodeUrl(nodeInput.value);
  if (parsed.ok && NODES.includes(parsed.url)) {
    nodeInput.value = "";
    own.url = null;
    own.refused = null;
    chooseListed(parsed.url);
    return;
  }
  if (!parsed.ok) {
    own.url = null;
    own.answer = null;
    own.ask += 1;
    own.refused = parsed.why === "empty" ? null : parsed.why;
    if (own.refused) log(t("log.node.bad", { why: t("node.why." + parsed.why) }), "bad");
    clearNodeUrl();
    markChoice(null, true);
    note = parsed.why === "empty" ? ["node.note.own"] : null;
  } else {
    nodeInput.value = parsed.url;
    const changed = own.url !== parsed.url;
    own.url = parsed.url;
    own.refused = null;
    setNodeUrl(parsed.url);
    markChoice(parsed.url, true);
    note = null;
    if (changed || !own.answer) pingRows([own]);
  }
  drawRows();
  drawNote();
  checkEnvironment();
}

ownRadio.addEventListener("change", () => {
  if (ownRadio.checked) chooseOwn();
});
nodeInput.addEventListener("change", chooseOwn);

// A TAB BACK FROM A LONG ABSENCE asks again, and only while no wallet holds the choice. The page's own pick
// moves only when its node is no longer good; the person's choice never moves.
let hiddenAt = null;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    hiddenAt = performance.now();
    return;
  }
  const away = hiddenAt === null ? 0 : performance.now() - hiddenAt;
  hiddenAt = null;
  if (away > RECHECK_AFTER_MS && !nodeLocked()) recheck();
});

async function recheck() {
  const before = stateOf(nodeUrl());
  if (picking) {
    note = ["node.note.checking"];
    drawNote();
  }
  await pingAll();
  if (nodeLocked()) return;
  let moved = false;
  if (picking) {
    if (stateOf(nodeUrl()) !== "good") moved = autoPick();
    else {
      note = ["node.note.picked", { host: nodeHost(nodeUrl()) }];
      drawNote();
    }
  }
  if (moved || stateOf(nodeUrl()) !== before) checkEnvironment();
}

// THE FIRST CHOICE: a link or this tab's earlier choice is taken at once and the list is checked beside it;
// otherwise the page waits for the answers and picks.
async function startNode() {
  buildRows();
  const source = nodeSource();
  if (source === "link" || source === "tab") {
    const url = nodeUrl();
    if (!NODES.includes(url)) {
      own.url = url;
      nodeInput.value = url;
    }
    markChoice(url);
    note = source === "link" ? ["node.note.link", { host: nodeHost(url) }] : null;
    drawRows();
    drawNote();
    await Promise.all([runPreflight(), pingAll()]);
    return;
  }
  picking = true;
  clearNodeUrl();
  note = ["node.note.checking"];
  drawNote();
  await pingAll();
  autoPick();
  await runPreflight();
}

// ONE CHECK AT A TIME COUNTS: a person who clicks through the rows gets the answer for the last one. The wallet is
// loaded once; a change of node asks only the node.
let preflightRun = 0;
let announced = false;
async function runPreflight() {
  const mine = ++preflightRun;
  const isCurrent = () => mine === preflightRun;
  findSwapsBtn.disabled = true;
  // ISOLATION IS NOT A REQUIREMENT. monero-ts 0.11.20 has no pthreads and needs no SharedArrayBuffer; the headers
  // are still served when the host has them, and the diagnostics report the fact. WebCrypto needs a secure context.
  setCheck("secure", self.isSecureContext ? "ok" : "bad", () => t("preflight.fail.https"));
  const [walletOk, nodeOk] = await Promise.all([checkWallet(), checkNode(isCurrent)]);
  if (!isCurrent()) return false;
  const ready = walletOk && nodeOk && self.isSecureContext;
  window.__sweepFlow.ready = ready;
  // THE SEARCH NEEDS THE SDK AND THE BROWSER'S CRYPTO, NOT THE NODE: a key can be read and its swaps listed while the
  // person still picks a node. The withdrawal checks the node itself.
  findSwapsBtn.disabled = !(walletOk && self.isSecureContext);
  if (ready && !announced) {
    announced = true;
    log(t("log.ready"));
  }
  return ready;
}
function checkEnvironment() {
  return runPreflight().catch((e) => log(String((e && e.message) || e), "bad"));
}

document.addEventListener("i18n:applied", () => {
  drawRows();
  drawNote();
});

// THE LOG LEAVES ONLY BY HAND: the person copies it for whoever helps. It holds no key and no password, but it
// names addresses, so sharing it is their choice.
const copyLogBtn = $("copyLog");
copyLogBtn.addEventListener("click", async () => {
  let key = "page.log.copied";
  try {
    await navigator.clipboard.writeText(logEl.textContent);
  } catch {
    key = "page.log.copyFailed";
  }
  copyLogBtn.textContent = t(key);
  setTimeout(() => {
    copyLogBtn.textContent = t("page.log.copy");
  }, 2000);
});

keyFileInput.addEventListener("change", () => {
  onKeyFileChosen().catch((e) => log(String((e && e.message) || e), "bad"));
});
findSwapsBtn.addEventListener("click", () => busy(findSwapsBtn, findKeySwaps, keyErrorEl));
keyMoreEl.addEventListener("click", () => busy(keyMoreEl, () => findKeySwaps({ more: true }), keyErrorEl));
keyStopEl.addEventListener("click", () => {
  if (search && search.controller) search.controller.abort();
});
withdrawBtn.addEventListener("click", () => busy(withdrawBtn, withdraw, withdrawErrorEl));
sendBtn.addEventListener("click", () => busy(sendBtn, sendTx, withdrawErrorEl));

// AN OLDER BUILD OF THIS PAGE REGISTERED A SERVICE WORKER (sw.js) that added COEP to every answer. The wallet
// needs no isolation, and a worker outlives its file, so a tab that met the old build stays under require-corp
// until the registration is removed. Removing it changes nothing for this load and costs nothing when there is none.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .getRegistrations()
    .then((found) => Promise.all(found.map((r) => r.unregister())))
    .catch(() => {});
}

// LANGUAGE IS CHOSEN BEFORE THE FIRST LOG LINE; if loading fails the log shows raw keys, visible and not hidden.
initLocale()
  .then(async () => {
    // Node rows are drawn AFTER the language loads: before that t() returns keys.
    await startNode();
  })
  .catch((e) => log(t("log.error", { message: String((e && e.message) || e) }), "bad"));
findSwapsBtn.disabled = true;
