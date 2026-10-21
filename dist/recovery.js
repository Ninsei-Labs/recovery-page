// The recovery page: recovery file -> the state of the money -> your address -> one button that syncs, builds
// and signs -> confirm -> send.
//
// THE WITHDRAWAL RULES LIVE IN @ninsei-labs/sdk: isEncrypted, recovery.open, sweep.plan, sweep.keys, sweep.wallet,
// sweep.restore, sweep.destination, sweep.sign, sweep.relay, formatXmr, probeMoneroNode.
//
// The page keeps the DOM, node address, state, display and texts, and parses the payload for display and OLD
// mnemonic files. What it says about the money comes from lib/withdrawal.js.
//
// Keys never leave the tab: only requests for public chain data go out (the Monero node, the settlement
// chain's RPCs). The mnemonic is never logged or put into state; it lives in the wallet object and dies on
// close().

// CORE CODE -> WORDS: the demo dictionary (a copy of www/js/sdk/codes.js). Unknown codes pass through.
import { t, n, d, init as initLocale } from "./locales/index.js";
import {
  NODES, STAGENET_NODE, nodeUrl, nodeSource, nodeLabelKey, nodeLabelParams, setNodeUrl, clearNodeUrl, parseNodeUrl, nodeHost,
  pingNode, medianHeight, nodeVerdict, fastestGood,
} from "./lib/node.js";
import { settlementOf, evmCall, evmLogs, evmBlockNumber } from "./lib/settlement.js";
import { isSell, promisedXmrAddress, fileAmount, moneyState } from "./lib/withdrawal.js";

// PATHS ARE RELATIVE: a domain root and a subdirectory must both work. The `?v=` hash is stamped by build/build.mjs.
const BUNDLE = "./assets/vendors/monero/monero-ts-browser.js?v=cf687c3e";
const WORKER = "./monero.worker.js?v=fd2e8b51";
const SDK_BUNDLE = "./assets/vendors/sdk/sdk-browser.js?v=7cdaa53c";
// THIS PAGE TALKS TO NO SERVICE. The SDK's service routes (a height the app remembers, the revealed half's
// fallback, the "withdrawn" mark) get this fetch, which answers "unavailable" without a request: the height comes
// from the file or the person, the half from the chain, and a withdrawal needs nobody told. So only the Monero
// node and the settlement chain's RPCs ever hear from this tab, as the page promises.
const noService = async () => { throw new TypeError("this page talks to no service"); };

const EXPLORER = {
  mainnet: "https://xmrchain.net/tx/",
  stagenet: "https://stagenet.xmrchain.net/tx/",
  testnet: "https://testnet.xmrchain.net/tx/",
};

const $ = (id) => document.getElementById(id);
const logEl = $("log");
const fileInput = $("file");
const passField = $("passField");
const passInput = $("pass");
const openBtn = $("unlock");
const openErrorEl = $("openError");
const moneyEl = $("moneyState");
const moneyHeadEl = $("moneyHead");
const fileInfoEl = $("fileInfo");
const stepTransfer = $("stepTransfer");
const destInput = $("dest");
const destWarnEl = $("destWarn");
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
const heightInput = $("restoreHeight");
const heightBox = $("heightBox");
const keyWordsInput = $("keyWords");
const keyFileInput = $("keyFile");
const keyPassField = $("keyPassField");
const keyPassInput = $("keyPass");
const keyAddressInput = $("keyAddress");
const findSwapsBtn = $("findSwaps");
const keyErrorEl = $("keyError");
const swapListEl = $("swapList");
let keyFileText = null;

let api = null;          // monero-ts namespace
let mod = null;          // built SDK core
let sdk = null;          // core facade createNinsei
let sdkFor = null;       // the settlement and Monero networks the facade was built for
let adapter = null;      // core wallet adapter (connect/sync/unlockedBalance/driver)
let wallet = null;       // library wallet: driver() of the adapter
let chosen = null;       // the picked file before it is opened: { text, envelope, encrypted }
let payload = null;      // decrypted payload (display + old files)
let plan = null;         // core plan: height, missing, revealed half
let contents = null;     // recovery file text, needed at every step
let passphrase = null;   // file password: needed by the core, never left in the input
let network = null;      // Monero network from the file
let nodeNetwork = null;  // Monero network the chosen node answered with (checkNode)
let settlement = null;   // settlement network from the file, one lib/settlement.js knows
let balance = null;      // { total, unlocked } in atomic units after a sync, null before one
let signedToken = null;  // signing token (sweep.sign -> sweep.relay)
let lastTx = null;       // signed transfer data for the confirmation

// Console and test state: no secrets (no mnemonic, no keys).
window.__sweepFlow = { ready: false, network: null, address: null, restoreHeight: null, unlocked: 0n, signed: false, steps: [] };

// A DIFFERENT ADDRESS THAN PROMISED IS SAID OUT LOUD, with both addresses: otherwise the withdrawal goes somewhere
// unseen. Only a buy promised an XMR address; a sell takes the XMR back to wherever the person names.
function updateDestWarning() {
  const typed = destInput.value.trim();
  if (!payload || !typed || isSell(payload.side)) {
    destWarnEl.hidden = true;
    destWarnEl.textContent = "";
    window.__sweepFlow.destWarning = null;
    return;
  }
  const promised = promisedXmrAddress(payload);
  if (!promised) {
    destWarnEl.textContent = t("warn.dest.none");
    destWarnEl.hidden = false;
    window.__sweepFlow.destWarning = "no-promised-address";  // state is a CODE: the checks read it
    return;
  }
  const same = typed === promised;
  destWarnEl.textContent = same ? "" : t("warn.dest.other", { promised, typed });
  destWarnEl.hidden = same;
  window.__sweepFlow.destWarning = same ? null : "other-recipient";
}

const looksLikeXmrAddress = (text) => /^[1-9A-HJ-NP-Za-km-z]{95}$|^[1-9A-HJ-NP-Za-km-z]{106}$/.test(text);
const currentState = () => (payload ? moneyState({ payload, plan, balance }) : null);

// VIOLET IS THE NEXT ACTION: "Open file" once a file (and its password) is there, "Withdraw XMR" once the money is
// ready and an address is named.
function updateButtons() {
  const passReady = !chosen || !chosen.encrypted || Boolean(passInput.value);
  openBtn.classList.toggle("ready", Boolean(chosen) && !payload && passReady);
  const state = currentState();
  withdrawBtn.classList.toggle("ready", Boolean(state && state.state === "ready") && looksLikeXmrAddress(destInput.value.trim())
    && !signedToken && doneEl.hidden);
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
  const { key, params, fraction, sub } = progress;
  const percent = fraction === null ? null : Math.max(0, Math.min(100, Math.floor(fraction * 100)));
  progressHeadEl.textContent = t(key, { ...params, percent: percent === null ? "" : n(percent) });
  progressEl.dataset.mode = percent === null ? "busy" : "fill";
  progressFillEl.style.width = percent === null ? "" : percent + "%";
  if (percent === null) progressBarEl.removeAttribute("aria-valuenow");
  else progressBarEl.setAttribute("aria-valuenow", String(percent));
  const words = sub ? sub() : "";
  progressSubEl.textContent = words;
  progressSubEl.hidden = !words;
  progressEl.hidden = false;
}
function showProgress(key, { params = {}, fraction = null, sub = null } = {}) {
  progress = { key, params, fraction, sub };
  drawProgress();
}
function hideProgress() {
  progress = null;
  drawProgress();
}

// TIME LEFT OF A SCAN, from its own pace so far: said only once there is a pace to go by.
function timeLeft(seconds) {
  if (!(seconds > 0) || !Number.isFinite(seconds)) return "";
  return seconds < 90 ? t("flow.time.sec", { n: n(Math.max(1, Math.round(seconds))) }) : t("flow.time.min", { n: n(Math.round(seconds / 60)) });
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
  updateDestWarning();
  updateButtons();
});
passInput.addEventListener("input", updateButtons);

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
  for (const [el, [key, params]] of said) el.textContent = t(key, params);
  if (payload) drawMoney();
  updateDestWarning();
  drawChecks();
  drawProgress();
});

// XMR AMOUNTS ARE A PACKAGE RULE (formatXmr, BigInt): one atomic unit is "0.000000000001", and above 9007 XMR
// nothing is rounded the way Number rounded it.
const xmr = (atomic) => {
  try { return mod.formatXmr(atomic); } catch { return String(atomic); }
};
// REFUSAL IN WORDS BY CODE: the core holds SdkError.code, the language holds the wording.
const sdkWords = (error) => t("sdk." + ((error && error.code) || "unknown"), (error && error.params) || {});

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

// CORE FACADE, built for the open file: its settlement network and its Monero network. There is no facade before
// a file is open, so nothing can run against a chain the file did not name.
//
// THE CHAIN READ IS REAL: `evmCall` is an eth_call over the settlement network's public RPCs (lib/settlement.js),
// and a failed read throws instead of answering "0x". sweep.plan reads the revealed half through it; its app
// route fallback meets `noService`, which the plan reads as "not revealed", the same answer the chain gave.
async function facade() {
  const m = await sdkBundle();
  if (!settlement || !network) throw new Error("no recovery file is open");
  const key = settlement + "/" + network;
  if (!sdk || sdkFor !== key) {
    const chain = settlement;
    sdk = m.createNinsei({
      settlement: { chain },
      xmrNetwork: network,
      mode: "live",
      fetch: noService,
      storage: m.memoryAdapter(),
      evmCall: (request) => evmCall(chain, request),
    });
    sdkFor = key;
  }
  return sdk;
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
      if (r.status !== 200 || buf.byteLength < 1_000_000) throw new Error(t("preflight.fail.workerBytes", { bytes: n(buf.byteLength) }));
      log(t("log.worker.ok", { mb: n(buf.byteLength / 1048576, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }));
    } catch (e) {
      failed.push(["preflight.fail.worker", { message: e.message }]);
    }
  }

  const why = () => failed.map(([key, params]) => t(key, params)).join("; ");
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
  log(t("log.node.answering", { height: n(probe.height), sync: probe.synchronized, nettype: probe.nettype, node: t(nodeLabelKey(), nodeLabelParams()) }));
  setCheck("node", "ok");
  return true;
}

// --- 1. Opening the file ---

// --- 0d. One recovery key: find the swaps, then open one through the SAME withdrawal path ---

// THE CHAIN A KEY BELONGS TO IS NOT IN THE KEY. A key is derived per chain id, so the page names the live
// testnet factory from the package registry; the search sends only that factory, the OrderCreated topic and the
// optional address. Mainnet factories join this list in the package, not in the page.
function keyChainOf(m) {
  const chains = Array.isArray(m.CHAINS) ? m.CHAINS : [];
  return chains.find((c) => c && c.escrow && c.escrow.address && c.escrow.mode === "live") || null;
}

async function onKeyFileChosen() {
  const file = keyFileInput.files && keyFileInput.files[0];
  keyFileText = file ? await file.text() : null;
  // An encrypted key file is JSON; a plain one starts with its readable header.
  keyPassField.hidden = !(keyFileText && keyFileText.trim().startsWith("{"));
  if (!keyFileText) keyPassField.hidden = true;
}

// FIND OPEN SWAPS BY THE KEY'S COMMITMENTS. The words or the file are used here only; neither is put into the
// result, the log or window state. A found row is a button: the person chooses which swap to recover.
async function findKeySwaps() {
  quiet(keyErrorEl);
  swapListEl.hidden = true;
  swapListEl.replaceChildren();
  let key;
  try {
    const m = await sdkBundle();
    key = keyFileText
      ? await m.openRecoveryKeyFile(keyFileText, keyPassInput.value)
      : m.importRecoveryKey(keyWordsInput.value);
  } catch (e) {
    log(t("log.key.refused", { words: sdkWords(e) }), "bad");
    return say(keyErrorEl, "flow.err.key");
  }
  const m = await sdkBundle();
  const chain = keyChainOf(m);
  if (!chain) return say(keyErrorEl, "flow.err.keyChain");
  let found;
  try {
    // PUBLIC RPCS REFUSE A SPAN OF TENS OF MILLIONS OF BLOCKS (the testnet already has 321M). The factory and
    // every swap this page can recover are recent, so the search starts inside one allowed window; an older
    // deployment gets its own start block when the registry names one.
    let fromBlock = "earliest";
    try {
      const latest = await evmBlockNumber(chain.id);
      if (Number.isFinite(latest) && latest > 0) fromBlock = Math.max(0, latest - 9_000_000);
    } catch { /* the log call will name the failure */ }
    found = await m.findSwaps({
      mnemonic: key.mnemonic,
      chainId: chain.chainId,
      factory: chain.escrow.address,
      address: keyAddressInput.value.trim() || null,
      evmLogs: (request) => evmLogs(chain.id, request),
      fromBlock,
    });
  } catch (e) {
    log(t("log.key.searchFailed", { words: String((e && e.message) || e) }), "bad");
    return say(keyErrorEl, "flow.err.search");
  }
  log(t("log.key.found", { n: n(found.swaps.length) }), found.swaps.length ? "ok" : "wait");
  if (!found.swaps.length) return say(keyErrorEl, "flow.err.noSwaps", {}, "wait");
  swapListEl.hidden = false;
  for (const swap of found.swaps) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "swap-row";
    const side = swap.side === "locker" ? t("value.side.buy") : t("value.side.sell");
    button.textContent = t("key.result", { side, escrow: String(swap.escrow).slice(0, 10) + "…" });
    button.addEventListener("click", () => busy(button, () => openFoundSwap(swap, key.mnemonic, chain, m), keyErrorEl));
    li.appendChild(button);
    swapListEl.appendChild(li);
  }
  return true;
}

// OPEN A FOUND SWAP WITHOUT A FILE. The payload is assembled from the key and the on-chain order, written
// through the same envelope module (unencrypted, in memory), and then the ordinary openFile path runs: plan,
// height, destination, withdraw. No secret is written to disk.
async function openFoundSwap(found, mnemonic, chain, m) {
  quiet(keyErrorEl);
  settlement = chain.id;
  // A key names no Monero network; the settlement network decides it. The testnet factory is paired with
  // stagenet, and the node check later refuses a node of another network instead of silently scanning the wrong chain.
  network = chain.testnet ? "stagenet" : "mainnet";
  // THE KEY DOES NOT NAME A NODE, BUT A TESTNET KEY NEEDS STAGENET. If the page's current pick is on another
  // network, use the project's stagenet node; the destination check below still refuses a wrong-network node.
  if (network === "stagenet" && nodeNetwork !== "stagenet") {
    setNodeUrl(STAGENET_NODE, { remember: false, by: "pick" });
    try { await checkNode(() => true); drawCurrent(); } catch { /* the open will name the node failure */ }
  }
  const halves = m.takerHalves({ mnemonic, chainId: chain.chainId, index: found.index });
  const ownIsLocker = found.side === "locker";
  const otherSpendPoint = ownIsLocker ? found.edPointClaimer : found.edPointLocker;
  const otherViewPoint = ownIsLocker ? halves.makerViewPoint : found.edViewPointLocker;
  const otherViewHalf = halves.makerViewHalf;
  const core = await facade();
  let joint;
  try {
    joint = core.order.jointAddress({
      ownSpendHalf: halves.spendHalf, ownViewHalf: halves.viewHalf,
      otherSpendPoint, otherViewPoint, network,
    });
  } catch (e) {
    log(t("log.key.addressFailed", { words: String((e && e.message) || e) }), "bad");
    return say(keyErrorEl, "flow.err.keys");
  }
  const payload = m.buildPayload({
    swap: {
      id: found.escrow, side: ownIsLocker ? "buy" : "sell", network: chain.id, moneroNetwork: network,
      createdAt: new Date().toISOString(), payToken: "ETH", payAmount: found.amount, xmrAmount: null,
      rate: null, maker: null, quoteSignature: null,
      escrow: { address: found.escrow },
      timeline: { readyBy: found.readyBy * 1000, t1: found.t1 * 1000 },
    },
    swapWallet: {
      source: "halves", network, address: joint.address,
      spendHalf: halves.spendHalf, viewHalf: halves.viewHalf,
      otherSpendPoint, otherViewPoint, otherViewHalf,
      escrowAddress: found.escrow, restoreHeight: 0,
    },
    escrow: { address: found.escrow },
    receiveAddress: null,
    restoreHeight: 0,
  });
  const text = await m.createRecoveryFile(payload, "");
  keyWordsInput.value = "";
  keyFileInput.value = "";
  keyFileText = null;
  keyPassInput.value = "";
  keyPassField.hidden = true;
  swapListEl.hidden = true;
  swapListEl.replaceChildren();
  chosen = { text, envelope: JSON.parse(text), encrypted: false };
  passInput.value = "";
  passField.hidden = true;
  await openFile();
  return true;
}

// THE PASSWORD IS ASKED ONLY FOR AN ENCRYPTED FILE, and the SDK's reader of the envelope says which it is: a
// file written without a password names that fact. Picking another file forgets the open one: two files in one
// tab is how a withdrawal goes to the wrong deal.
async function onFileChosen() {
  if (payload || adapter) await forget({ keepFile: true });
  quiet(openErrorEl);
  const file = fileInput.files && fileInput.files[0];
  chosen = null;
  if (file) {
    const text = await file.text();
    let envelope = null;
    try { envelope = JSON.parse(text); } catch { envelope = null; }
    const m = await sdkBundle();
    chosen = { text, envelope, encrypted: Boolean(envelope && typeof envelope === "object") && m.isEncrypted(envelope) };
  }
  passField.hidden = !(chosen && chosen.encrypted);
  updateButtons();
}

async function openFile() {
  quiet(openErrorEl);
  if (!chosen) return say(openErrorEl, "flow.err.noFile");
  if (!chosen.envelope || typeof chosen.envelope !== "object") {
    log(t("log.not.json"), "bad");
    return say(openErrorEl, "flow.err.notFile");
  }
  // A FILE WITHOUT A PASSWORD opens with an empty one; the SDK refuses an empty one for an encrypted file.
  const pass = chosen.encrypted ? passInput.value : "";
  if (chosen.encrypted && !pass) {
    passField.hidden = false;
    return say(openErrorEl, "flow.err.noPass");
  }
  // OPENING AGAIN STARTS CLEAN: a wallet from the previous opening is closed first.
  if (payload || adapter) await forget({ keepFile: true });

  // DECRYPT FIRST, with the SDK's own reader: the file names its settlement network, and the facade is built for
  // that network, never for a default one.
  const m = await sdkBundle();
  let opened;
  try {
    opened = await m.decryptFile(chosen.envelope, pass);
  } catch (e) {
    log(t("log.decrypt.failed", { why: String((e && e.message) || e) }), "bad");
    return say(openErrorEl, "flow.err.decrypt");
  }
  if (!settlementOf(opened.network)) {
    log(t("log.settlement.unknown", { network: String(opened.network) }), "bad");
    return say(openErrorEl, "flow.err.settlement", { network: String(opened.network ?? "?") });
  }
  const { warnings } = m.validatePayload(opened);
  settlement = opened.network;
  network = opened.moneroWallet.network || opened.moneroNetwork;
  const text = chosen.text;
  const core = await facade();

  // FILE PARSING IS THE CORE'S (recovery.open); a refusal is not swallowed. A halves file opens here, but an OLD
  // mnemonic file needs the monero-js build this origin lacks, so parsing falls back to the ./recovery rule.
  try {
    const known = await core.recovery.open({ contents: text }, pass);
    log(t("log.core.opened", { address: String(known.address || "").slice(0, 12), control: known.spendable ? t("value.control.full") : t("value.control.watch") }), "ok");
  } catch (e) {
    log(t("log.core.openFailed", { words: sdkWords(e) }), "wait");
  }

  // PLAN IS THE CORE'S (sweep.plan): restore height (also from the app by address), missing parts, revealed half.
  try {
    plan = await core.sweep.plan({ file: { contents: text }, passphrase: pass });
  } catch (e) {
    log(t("log.plan.failed", { words: sdkWords(e) }), "bad");
    settlement = null;
    network = null;
    return say(openErrorEl, "flow.err.plan");
  }
  window.__sweepFlow.plan = { address: plan.address, restoreHeight: plan.restoreHeight, missing: [...plan.missing], revealedHalf: plan.revealedHalf };
  payload = opened;
  contents = text;
  passphrase = pass;
  passInput.value = ""; // password only in memory for core steps
  passField.hidden = true;
  if (nodeNetwork && nodeNetwork !== network) log(t("log.networks.differ", { file: network, node: nodeNetwork }), "warn");

  window.__sweepFlow.network = network;
  window.__sweepFlow.address = payload.moneroWallet.address;
  const fileHeight = Number(payload.moneroWallet.restoreHeight) || 0;
  // THE HEIGHT FROM THE PLAN WINS; the file value is the fallback when the plan is silent.
  const height = Number(plan.restoreHeight) > 0 ? Number(plan.restoreHeight) : fileHeight;
  heightInput.value = height > 0 ? String(height) : "";
  window.__sweepFlow.restoreHeight = height;
  // NO HEIGHT IS A NAMED STATE: the scan would start from Monero's first block and take hours, so the step says it
  // and shows the field for the person to fill. A known height stays out of sight.
  heightBox.hidden = height > 0;
  for (const w of warnings) log(t("log.warning", { text: w }), "wait");
  // "revealed half" is a state of the money, not a breakage.
  for (const miss of plan.missing) {
    if (miss === "revealed-half") log(t("log.miss.revealedHalf"), "wait");
    if (miss === "spendable") log(t("log.miss.spendable"), "wait");
    if (miss === "restore-height") log(t("log.miss.restoreHeight"), "wait");
  }
  log(t("log.file.parsed"));

  balance = null;
  drawMoney();
  const ready = currentState().state === "ready";
  stepTransfer.hidden = !ready;
  // ON A BUY the file names the address the XMR was bought for: it is filled in, and a change is said out loud.
  const promised = promisedXmrAddress(payload);
  if (ready && promised && !destInput.value.trim()) destInput.value = promised;
  updateDestWarning();
  updateButtons();
  if (ready) log(t("log.next.address"));
}

// --- 2. The state of the money, in words ---

const STATE_KEYS = { ready: "money.ready", waitBuy: "money.waitBuy", waitSell: "money.waitSell", empty: "money.empty", locked: "money.locked" };
const STATE_TONES = { ready: "ok", waitBuy: "wait", waitSell: "wait", empty: "none", locked: "wait" };

function moneyWords({ state, params }) {
  if (state === "ready" && params.amount === null) return t("money.ready.unknown");
  if (state === "ready") return t("money.ready", { amount: n(params.amount, { maximumFractionDigits: 12 }) });
  if (state === "waitSell" && params.deadline) return t("money.waitSell.deadline", { deadline: d(params.deadline) });
  return t(STATE_KEYS[state]);
}

function drawMoney() {
  const m = currentState();
  moneyEl.dataset.state = STATE_TONES[m.state];
  moneyHeadEl.textContent = moneyWords(m);
  const amount = fileAmount(payload);
  const rows = [
    ["info.deal", payload.swapId],
    ["info.side", () => t(isSell(payload.side) ? "value.side.sell" : "value.side.buy")],
    ["info.amount.file", () => (amount === null ? t("value.amount.unknown") : t("value.amount.file", { amount: n(amount, { maximumFractionDigits: 12 }) }))],
  ];
  if (m.state === "waitSell" && m.params.deadline) rows.push(["info.deadline", () => d(m.params.deadline)]);
  renderInfo(fileInfoEl, rows);
  moneyEl.hidden = false;
}

// --- 3. Withdraw: sync if needed, build and sign, then confirm ---

async function withdraw() {
  quiet(withdrawErrorEl);
  dropSigned();
  if (!payload || !plan) return say(withdrawErrorEl, "flow.err.open");
  if (!destInput.value.trim()) return say(withdrawErrorEl, "flow.err.dest.empty");
  // THE NODE AND THE FILE MUST BE ON ONE NETWORK: a stagenet file against a mainnet node finds nothing and
  // would look like an empty wallet.
  if (!nodeNetwork) return say(withdrawErrorEl, "flow.err.noNode");
  if (nodeNetwork !== network) return say(withdrawErrorEl, "flow.err.networks", { file: network, node: nodeNetwork });
  if (!adapter) {
    const synced = await syncWallet();
    if (synced !== true) {
      hideProgress();
      return say(withdrawErrorEl, synced);
    }
  }
  drawMoney();
  const m = currentState();
  if (m.state !== "ready") {
    hideProgress();
    return say(withdrawErrorEl, STATE_KEYS[m.state], {}, "wait");
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
const WALLET_STOPS = { "bad-input": "flow.err.walletBuild", "wrong-chain": "flow.err.walletBuild", "recovery-failed": "flow.err.keys" };

// WALLET FROM THE FILE + SYNC. Returns true, or the key of the plain line that says why not; the detail is logged.
async function syncWallet() {
  contents = contents || JSON.stringify(payload);
  const dest = destInput.value.trim();
  const height = Number(heightInput.value.trim() || 0) || Number(plan.restoreHeight) || 0;
  const core = await facade();

  // ADDRESS IS A PACKAGE RULE (sweep.destination): shape, network, promise; monero-ts is not a second judge.
  let verdict;
  try {
    verdict = await core.sweep.destination({ file: { contents }, passphrase, dest });
  } catch (e) {
    log(t("log.dest.refused", { words: sdkWords(e) }), "bad");
    return "flow.err.dest";
  }
  if (!verdict.ok) { log(t("log.dest.refused", { words: verdict.reason || "?" }), "bad"); return "flow.err.dest"; }
  log(t("log.dest.accepted", { network }));

  // KEYS ARE THE CORE'S: sweep.keys sums its half and the REVEALED counterparty half and checks (s_a + s_b)*G.
  // Old mnemonic files carry the spend key themselves.
  let fields;
  if (payload.moneroWallet.spendHalf) {
    let keys;
    try {
      keys = await core.sweep.keys({ file: { contents }, passphrase });
    } catch (e) {
      log(t("log.keys.failed", { words: sdkWords(e) }), "bad");
      return "flow.err.keys";
    }
    fields = { privateSpendKey: keys.privateSpendKey, privateViewKey: keys.privateViewKey, primaryAddress: keys.address };
    log(t("log.keys.summed"), "ok");
  } else {
    fields = { seed: payload.moneroWallet.mnemonic }; // mnemonic exists only in old files
    log(t("log.keys.mnemonic"), "wait");
  }

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
  const ticker = setInterval(() => { if (progress && progress.sub === soFar) drawProgress(); }, 1000);

  // RESTORE IS A PACKAGE RULE (sweep.restore): height with a downward margin, a rescan, and a SECOND pass
  // (rescanSpent + sync) when coins exist but are locked.
  const t0 = performance.now();
  let restored;
  try {
    log(t("log.scan.start", { from: n(scanFrom), height: n(height) }));
    restored = await core.sweep.restore({ wallet: adapter, fromHeight: height, scanBack: 10 });
  } catch (e) {
    log(t("log.rescan.failed", { why: (e && e.message) || e }), "bad");
    return "flow.err.sync";
  } finally {
    clearInterval(ticker);
    if (listener) {
      try { await wallet.removeListener(listener); } catch { /* the wallet may be closing; progress is display only */ }
    }
  }
  const ms = Math.round(performance.now() - t0);
  const unlocked = BigInt(restored.unlocked);
  const total = BigInt(restored.total);
  balance = { total, unlocked };
  log(t("log.restored.passes", { passes: n(restored.passes), locked: restored.lockedPass ? t("value.yes") : t("value.no") }), "ok");

  const walletHeight = await wallet.getHeight();
  const nodeHeight = await wallet.getDaemonHeight();
  window.__sweepFlow.unlocked = unlocked;
  window.__sweepFlow.wallet = wallet;
  try {
    window.__sweepFlow.syncInfo = {
      walletHeight,
      nodeHeight,
      txs: (await wallet.getTxs()).length,
      transfers: (await wallet.getTransfers()).length,
      balance: String(total),
      unlocked: String(unlocked),
      scanHeight: height,
      walletRestoreHeight: await wallet.getRestoreHeight(),
    };
  } catch (e) {
    window.__sweepFlow.syncError = String((e && e.message) || e);
    log(t("log.diag.failed", { why: window.__sweepFlow.syncError }), "wait");
  }
  log(t("log.sync.took", { ms: n(ms), height: n(height || 0) }));
  log(
    unlocked > 0n
      ? t("log.synced.ok", { xmr: xmr(unlocked), walletHeight: n(walletHeight), nodeHeight: n(nodeHeight) })
      : t(total > 0n ? "log.synced.zero.locked" : "log.synced.zero.empty", { total: xmr(total) }),
    unlocked > 0n ? "ok" : "wait"
  );
  return true;
}

// BUILD AND SIGN, NOT SEND. Returns true, or the key of the plain line that says why not.
async function buildTx() {
  const dest = destInput.value.trim();
  // CHECK AGAINST THE PROMISE AND THE NETWORK IS A PACKAGE RULE (sweep.destination); the person names the address.
  const core = await facade();
  let verdict;
  try {
    verdict = await core.sweep.destination({ file: { contents }, passphrase, dest });
  } catch (e) {
    log(t("log.dest.refused", { words: sdkWords(e) }), "bad");
    return "flow.err.dest";
  }
  if (!verdict.ok) { log(t("log.dest.refused", { words: verdict.reason || "?" }), "bad"); return "flow.err.dest"; }
  // Only a buy promised an XMR address; on a sell the file's recipient is a payout address on another chain.
  const promised = isSell(payload.side) ? null : verdict.promised || null;
  const differs = Boolean(promised) && verdict.matches === false;
  if (differs) {
    log(t("log.dest.differs"), "warn");
    log(t("log.dest.file", { address: promised }), "warn");
    log(t("log.dest.typed", { address: dest }), "warn");
    log(t("log.dest.same.allowed"), "warn");
  } else if (promised) {
    log(t("log.dest.matches"));
  }

  // SIGNING IS THE CORE'S (sweep.sign): plan -> wallet -> sync -> unlocked balance -> signature WITHOUT sending.
  // An empty balance stops with `insufficient-funds` BEFORE signing, on the SAME wallet scanned above.
  let signed;
  try {
    signed = await core.sweep.sign({
      file: { contents },
      passphrase,
      to: dest,
      connectWallet: async () => mod.moneroWallet({
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
  lastTx = { amount: BigInt(signed.amount), fee: signed.fee, receive: signed.receive, dest, differs };
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
    ["info.fee", () => (tx.fee === null ? t("value.fee.unknown") : xmr(BigInt(tx.fee)) + " XMR"), tx.fee === null ? "warn" : ""],
    ["info.receive", () => (tx.receive === null ? t("value.receive.unknown") : xmr(BigInt(tx.receive)) + " XMR"), tx.receive === null ? "warn" : "good"],
    ["info.recipient", () => t(tx.differs ? "value.recipient.differs" : "value.recipient.same", { address: tx.dest }), tx.differs ? "warn" : ""],
  ]);
}

async function sendTx() {
  quiet(withdrawErrorEl);
  if (!signedToken) { log(t("log.nothing.toSend"), "bad"); return say(withdrawErrorEl, "flow.err.send"); }
  showProgress("flow.progress.send");
  let out;
  try {
    // SENDING IS THE CORE'S (sweep.relay). Its "withdrawn" mark for a service meets `noService` and goes nowhere.
    out = await (await facade()).sweep.relay({ token: signedToken });
  } catch (e) {
    hideProgress();
    log(t("log.send.failed", { words: sdkWords(e) }), "bad");
    return say(withdrawErrorEl, "flow.err.send");
  }
  hideProgress();
  signedToken = null;
  const hashes = Array.isArray(out.txids) ? out.txids : [];
  log(t("log.sent", { txids: hashes.join(", ") }), "ok");
  confirmEl.hidden = true;
  showDone(hashes[0] || null);
  // THE WALLET IS EMPTY NOW: the button would only sign for zero. The keys have done their job, so they leave the
  // tab's memory at once instead of waiting for the tab to close; the sent view and the txid stay.
  withdrawBtn.disabled = true;
  await dropKeys();
  log(t("log.done"), "ok");
  return true;
}

// SENT: the transaction and where to see it.
function showDone(txid) {
  const rows = [["info.txid", txid || t("value.txid.none")]];
  if (txid) rows.push(["info.explorer", () => explorerLink(txid)]);
  renderInfo(doneInfoEl, rows);
  doneEl.hidden = false;
  updateButtons();
}

// THE KEYS LEAVE: the wallet closes and the file's contents, its password and the signed transaction go. The node
// choice opens again. `plan` stays: it holds the public facts the sent view reads. `keepFile`
// keeps the file just picked: onFileChosen calls this before it reads the input.
async function dropKeys({ keepFile = false } = {}) {
  try { if (adapter) await adapter.close(); } catch { /* a failed close must not keep the rest in memory */ }
  adapter = null;
  wallet = null;
  updateNodeLock();
  signedToken = null;
  lastTx = null;
  payload = null;
  contents = null;
  passphrase = null;
  passInput.value = "";
  if (!keepFile) {
    chosen = null;
    fileInput.value = "";
  }
  log(t("log.forgotten"), "ok");
}

// FORGET: the keys go (dropKeys), and the page is back at "choose a file". Picking another file does this, so two
// files never share a tab.
async function forget({ keepFile = false } = {}) {
  await dropKeys({ keepFile });
  plan = null;
  network = null;
  settlement = null;
  balance = null;
  window.__sweepFlow = { ready: window.__sweepFlow.ready, network: null, address: null, restoreHeight: null, unlocked: 0n, signed: false, steps: [] };
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
  passField.hidden = !(chosen && chosen.encrypted);
  updateDestWarning();
  updateButtons();
}

// --- events ---

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
const listed = NODES.map((url) => ({ url, answer: null, ask: 0, el: null, radio: null }));
const own = { url: null, answer: null, ask: 0, refused: null, el: ownRow };
let picking = false;  // the page holds the choice, not the person: a re-check may pick again
let note = null;      // [key, params] of the line under the list

function nodeLocked() {
  return Boolean(adapter || wallet);
}

function rowFor(url) {
  return listed.find((row) => row.url === url) || (url && own.url === url ? own : null);
}

function verdictOf(row) {
  if (row === own && !own.url) return own.refused ? { state: "bad", why: null } : { state: "idle", why: null };
  return nodeVerdict(row.answer, medianHeight([...listed, own].map((r) => r.answer)));
}

function stateOf(url) {
  const row = url ? rowFor(url) : null;
  return row ? verdictOf(row).state : null;
}

function buildRows() {
  for (const row of listed) {
    row.radio = h("input", { type: "radio", name: "node", value: row.url });
    row.radio.addEventListener("change", () => { if (row.radio.checked) chooseListed(row.url); });
    row.el = h("div", { class: "node", "data-state": "checking" }, [
      h("label", { class: "node-pick", title: row.url }, [
        row.radio,
        h("span", { class: "node-text" }, [h("span", { class: "node-name", text: nodeHost(row.url) }), h("span", { class: "node-why" })]),
        h("span", { class: "node-signal" }, [h("span", { class: "node-dot", "aria-hidden": "true" }), h("span", { class: "node-ms" })]),
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
      why = t("node.state." + verdict.why, { ...p, height: p.height === undefined ? undefined : n(p.height), blocks: p.blocks === undefined ? undefined : n(p.blocks) });
    }
    row.el.querySelector(".node-why").textContent = why;
    row.el.querySelector(".node-ms").textContent = row.answer && row.answer.ok ? t("node.ms", { ms: n(row.answer.ms) }) : "";
  }
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
  await Promise.all(asked.map(async ({ row, url, ask }) => {
    const answer = await pingNode(url, core.probeMoneroNode);
    if (row.ask !== ask || row.url !== url) return;
    row.answer = answer;
    drawRows();
  }));
}

const pingAll = () => pingRows(own.url ? [...listed, own] : listed);

// THE PAGE'S PICK: the fastest good listed node, or nothing - said plainly - when none is good.
function autoPick() {
  if (!picking) return false;
  const before = nodeUrl();
  const url = fastestGood(listed);
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
  if (nodeLocked()) { markChoice(nodeUrl()); drawNote(); return; }
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
  if (nodeLocked()) { markChoice(nodeUrl()); drawNote(); return; }
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

ownRadio.addEventListener("change", () => { if (ownRadio.checked) chooseOwn(); });
nodeInput.addEventListener("change", chooseOwn);

// A TAB BACK FROM A LONG ABSENCE asks again, and only while no wallet holds the choice. The page's own pick
// moves only when its node is no longer good; the person's choice never moves.
let hiddenAt = null;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { hiddenAt = performance.now(); return; }
  const away = hiddenAt === null ? 0 : performance.now() - hiddenAt;
  hiddenAt = null;
  if (away > RECHECK_AFTER_MS && !nodeLocked()) recheck();
});

async function recheck() {
  const before = stateOf(nodeUrl());
  if (picking) { note = ["node.note.checking"]; drawNote(); }
  await pingAll();
  if (nodeLocked()) return;
  let moved = false;
  if (picking) {
    if (stateOf(nodeUrl()) !== "good") moved = autoPick();
    else { note = ["node.note.picked", { host: nodeHost(nodeUrl()) }]; drawNote(); }
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
  openBtn.disabled = true;
  // ISOLATION IS NOT A REQUIREMENT. monero-ts 0.11.20 has no pthreads and needs no SharedArrayBuffer; the headers
  // are still served when the host has them, and the diagnostics report the fact. WebCrypto needs a secure context.
  setCheck("secure", self.isSecureContext ? "ok" : "bad", () => t("preflight.fail.https"));
  const [walletOk, nodeOk] = await Promise.all([checkWallet(), checkNode(isCurrent)]);
  if (!isCurrent()) return false;
  const ready = walletOk && nodeOk && self.isSecureContext;
  window.__sweepFlow.ready = ready;
  openBtn.disabled = !ready;
  if (ready && !announced) {
    announced = true;
    log(t("log.ready"));
  }
  return ready;
}
function checkEnvironment() {
  return runPreflight().catch((e) => log(String((e && e.message) || e), "bad"));
}

document.addEventListener("i18n:applied", () => { drawRows(); drawNote(); });

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
  setTimeout(() => { copyLogBtn.textContent = t("page.log.copy"); }, 2000);
});

keyFileInput.addEventListener("change", () => { onKeyFileChosen().catch((e) => log(String((e && e.message) || e), "bad")); });
findSwapsBtn.addEventListener("click", () => busy(findSwapsBtn, findKeySwaps, keyErrorEl));
fileInput.addEventListener("change", () => { onFileChosen().catch((e) => log(String((e && e.message) || e), "bad")); });
openBtn.addEventListener("click", () => busy(openBtn, openFile, openErrorEl));
withdrawBtn.addEventListener("click", () => busy(withdrawBtn, withdraw, withdrawErrorEl));
sendBtn.addEventListener("click", () => busy(sendBtn, sendTx, withdrawErrorEl));

// AN OLDER BUILD OF THIS PAGE REGISTERED A SERVICE WORKER (sw.js) that added COEP to every answer. The wallet
// needs no isolation, and a worker outlives its file, so a tab that met the old build stays under require-corp
// until the registration is removed. Removing it changes nothing for this load and costs nothing when there is none.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations()
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
openBtn.disabled = true;
