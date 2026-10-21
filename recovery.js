// The recovery page: recovery file -> the state of the money -> your address -> one button that syncs, builds
// and signs -> confirm -> send.
//
// THE WITHDRAWAL RULES LIVE IN @ninsei-labs/sdk 0.44: recovery.open, sweep.plan, sweep.keys, sweep.wallet,
// sweep.restore, recovery.restoreHeight, sweep.destination, sweep.sign, sweep.relay, formatXmr, probeMoneroNode.
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
  NODES, nodeUrl, nodeSource, nodeLabelKey, nodeLabelParams, setNodeUrl, clearNodeUrl, parseNodeUrl, nodeHost,
  pingNode, medianHeight, nodeVerdict, fastestGood,
} from "./lib/node.js";
import { settlementOf, evmCall } from "./lib/settlement.js";
import { fileIsEncrypted, isSell, promisedXmrAddress, fileAmount, moneyState } from "./lib/withdrawal.js";

// PATHS ARE RELATIVE: a domain root and a subdirectory must both work. The `?v=` hash is stamped by build/build.mjs.
const BUNDLE = "./assets/vendors/monero/monero-ts-browser.js?v=__V_MONERO__";
const WORKER = "./monero.worker.js?v=__V_WORKER__";
const SDK_BUNDLE = "./assets/vendors/sdk/sdk-browser.js?v=__V_SDK__";
// THE APP IS OPTIONAL: a third-party operator has none, so the height is typed by hand. A 404 is not an error.
const API = "./api";

const EXPLORER = {
  mainnet: "https://xmrchain.net/tx/",
  stagenet: "https://stagenet.xmrchain.net/tx/",
  testnet: "https://testnet.xmrchain.net/tx/",
};

// SCAN HEIGHT IS A PACKAGE RULE (recovery.restoreHeight): the service wins, the file is the fallback, "no height" is a named state.
async function restoreHeightFor(contentsText, pass) {
  try {
    const answer = await (await facade()).recovery.restoreHeight({ file: { contents: contentsText }, passphrase: pass });
    const height = Number(answer && answer.height) || 0;
    if (height > 0) log(t("log.height.source", { height: n(height), source: String(answer.source || "?") }), "wait");
    else log(t("log.height.none"), "wait");
    return height;
  } catch (e) {
    // A refusal here does not close the way: the height can be typed by hand.
    log(t("log.height.failed", { words: sdkWords(e) }), "wait");
    return 0;
  }
}

const $ = (id) => document.getElementById(id);
const preflightEl = $("preflight");
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
const withdrawErrorEl = $("withdrawError");
const confirmEl = $("confirm");
const txInfoEl = $("txInfo");
const sendBtn = $("send");
const doneEl = $("done");
const doneInfoEl = $("doneInfo");
const forgetBtn = $("forget");
const heightInput = $("restoreHeight");

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
let nodeNetwork = null;  // Monero network the chosen node answered with (preflight)
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

// ONE PLAIN LINE PER STEP for a stop; the detail is in the log under Details. `tone` is "bad" for an error and
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
function showProgress(key, params = {}) {
  said.set(progressEl, [key, params]);
  progressEl.textContent = t(key, params);
  progressEl.hidden = false;
}
const hideProgress = () => quiet(progressEl);

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

function setStatus(node, text, cls) {
  node.className = "status" + (cls ? " " + cls : "");
  node.textContent = text;
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
// and a failed read throws instead of answering "0x". SDK 0.44's sweep.plan still asks the page's own host for
// the revealed half (./api), which a static host does not serve, so there the plan says "not revealed" until the
// SDK reads the half through this seam.
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
      apiBase: API,
      storage: m.memoryAdapter(),
      evmCall: (request) => evmCall(chain, request),
    });
    sdkFor = key;
  }
  return sdk;
}

// --- 0b. Environment: without these checks nothing makes sense ---

// `isCurrent` is false once a newer run has started (the person picked another node meanwhile): an older
// run's answer must not paint the status line or set the network for a node that is no longer chosen.
async function preflight(isCurrent = () => true) {
  const failed = [];
  // ISOLATION IS NOT A REQUIREMENT. monero-ts 0.11.20 has no pthreads and needs no SharedArrayBuffer; the
  // headers are still served when the host has them, and the diagnostics report the fact. A host without them
  // runs the same wallet.
  if (!self.isSecureContext) failed.push(t("preflight.fail.https"));

  try {
    const m = await import(BUNDLE);
    api = m.default || m;
    log(t("log.lib.loaded", { version: api.getVersion?.() ?? "?" }));
  } catch (e) {
    failed.push(t("preflight.fail.bundle", { message: e.message }));
  }

  // CORE. A load failure is named in the log, never swallowed.
  let core = null;
  try {
    core = await sdkBundle();
    log(t("log.core.loaded", { file: SDK_BUNDLE.split("/").pop() }));
  } catch (e) {
    failed.push(t("preflight.fail.core", { message: (e && e.message) || e }));
  }

  if (api) {
    api.LibraryUtils.setWorkerDistPath(WORKER);
    try {
      const r = await fetch(WORKER);
      const buf = await r.arrayBuffer();
      if (r.status !== 200 || buf.byteLength < 1_000_000) throw new Error(t("preflight.fail.workerBytes", { bytes: n(buf.byteLength) }));
      log(t("log.worker.ok", { mb: n(buf.byteLength / 1048576, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }));
    } catch (e) {
      failed.push(t("preflight.fail.worker", { message: e.message }));
    }
  }

  // NODE IS A PACKAGE RULE (probeMoneroNode): one get_info, height, network, named refusal reason.
  // No node chosen is a failure in its own words, never a silent fallback to one nobody chose.
  if (!nodeUrl()) {
    nodeNetwork = null;
    failed.push(t("preflight.fail.noNode"));
  } else if (core) {
    const probe = await core.probeMoneroNode({ url: nodeUrl() });
    if (!isCurrent()) return false;
    nodeNetwork = probe.ok ? probe.network || null : null;
    if (!probe.ok) {
      failed.push(t("preflight.fail.node", { message: probe.why }));
    } else {
      log(t("log.node.answering", { height: n(probe.height), sync: probe.synchronized, nettype: probe.nettype, node: t(nodeLabelKey(), nodeLabelParams()) }));
    }
  }

  if (!isCurrent()) return false;
  if (failed.length) {
    setStatus(preflightEl, t("preflight.status.bad", { list: failed.join("; ") }), "bad");
    log(t("log.env.notready", { list: failed.join("; ") }), "bad");
    window.__sweepFlow.ready = false;
    return false;
  }
  setStatus(preflightEl, t("preflight.status.ok"), "ok");
  window.__sweepFlow.ready = true;
  return true;
}

// --- 1. Opening the file ---

// THE PASSWORD IS ASKED ONLY FOR AN ENCRYPTED FILE, and the envelope says which it is. Picking another file
// forgets the open one: two files in one tab is how a withdrawal goes to the wrong deal.
async function onFileChosen() {
  if (payload || adapter) await forget({ keepFile: true });
  quiet(openErrorEl);
  const file = fileInput.files && fileInput.files[0];
  chosen = null;
  if (file) {
    const text = await file.text();
    let envelope = null;
    try { envelope = JSON.parse(text); } catch { envelope = null; }
    chosen = { text, envelope, encrypted: fileIsEncrypted(envelope) };
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
  // A PLAIN FILE is not opened yet: the SDK's plan still takes a password (sdk#70 makes it optional).
  if (!chosen.encrypted) return say(openErrorEl, "flow.err.plain");
  const pass = passInput.value;
  if (!pass) {
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
  let fileHeight = Number(payload.moneroWallet.restoreHeight) || 0;
  if (!fileHeight) {
    const fromApp = await restoreHeightFor(text, pass);
    if (fromApp) fileHeight = fromApp;
  }
  // THE HEIGHT FROM THE PLAN WINS; the file value is the fallback when the plan is silent.
  const height = Number(plan.restoreHeight) > 0 ? Number(plan.restoreHeight) : fileHeight;
  heightInput.value = String(height);
  window.__sweepFlow.restoreHeight = height;
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

  // PROGRESS IS SHOWN, NOT NEEDED: the library tells its listeners how far the scan is; a wallet that cannot is
  // still synced, only without the percentage.
  let listener = null;
  try {
    listener = new (class extends api.MoneroWalletListener {
      async onSyncProgress(at, start, end, done) {
        showProgress("flow.progress.scan", { percent: n(Math.min(100, Math.floor(Number(done) * 100)) || 0) });
      }
    })();
    await wallet.addListener(listener);
  } catch {
    listener = null;
  }
  showProgress("flow.progress.scan", { percent: n(0) });

  // RESTORE IS A PACKAGE RULE (sweep.restore): height with a downward margin, a rescan, and a SECOND pass
  // (rescanSpent + sync) when coins exist but are locked.
  const t0 = performance.now();
  let restored;
  try {
    log(t("log.scan.start", { from: n(Math.max(0, Number(height) - 10)), height: n(height) }));
    restored = await core.sweep.restore({ wallet: adapter, fromHeight: height, scanBack: 10 });
  } catch (e) {
    log(t("log.rescan.failed", { why: (e && e.message) || e }), "bad");
    return "flow.err.sync";
  } finally {
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
    // SENDING AND REPORTING ARE THE CORE'S (sweep.relay): the signed transaction goes out and the service is told.
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
  window.__sweepFlow.report = { attempted: true, ok: Boolean(out.reported), txid: hashes[0] || null };
  confirmEl.hidden = true;
  showDone(hashes[0] || null);
  if (out.reported) {
    log(t("log.report.accepted"), "ok");
  } else {
    log(t("log.report.failed"), "warn");
    showReportRetry(hashes[0]);
  }
  // THE WALLET IS EMPTY NOW: the button would only sign for zero.
  withdrawBtn.disabled = true;
  log(t("log.done"), "ok");
  return true;
}

// SENT: the transaction and where to see it. The keys go when the tab closes.
function showDone(txid) {
  const rows = [["info.txid", txid || t("value.txid.none")]];
  if (txid) rows.push(["info.explorer", () => explorerLink(txid)]);
  renderInfo(doneInfoEl, rows);
  doneEl.hidden = false;
  updateButtons();
}

// RETRY REPORT IS THE CORE'S (sweep.report), same path as relay; it does not affect the transfer.
function showReportRetry(txid) {
  if (!txid || $("reportRetry")) return;
  const btn = h("button", { id: "reportRetry", class: "ghost", type: "button", text: t("btn.report.retry") });
  btn.addEventListener("click", () => busy(btn, async () => {
    const r = await (await facade()).sweep.report({ swapId: plan && plan.swapId, txid });
    window.__sweepFlow.report.ok = Boolean(r && r.reported);
    log(r && r.reported ? t("log.report.retry.ok") : t("log.report.retry.failed"), r && r.reported ? "ok" : "warn");
  }));
  doneInfoEl.appendChild(btn);
}

// FORGET: the wallet closes, every value from the file goes, and the page is back at "choose a file". The node
// choice opens again.
async function forget({ keepFile = false } = {}) {
  try { if (adapter) await adapter.close(); } catch { /* closing must not break the report */ }
  adapter = null;
  wallet = null;
  updateNodeLock();
  signedToken = null;
  lastTx = null;
  payload = null;
  plan = null;
  contents = null;
  passphrase = null;
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
  const retry = $("reportRetry");
  if (retry) retry.remove();
  withdrawBtn.disabled = false;
  destInput.value = "";
  heightInput.value = "0";
  passInput.value = "";
  if (!keepFile) {
    chosen = null;
    fileInput.value = "";
  }
  passField.hidden = !(chosen && chosen.encrypted);
  updateDestWarning();
  updateButtons();
  log(t("log.forgotten"), "ok");
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
}

function drawNote() {
  const locked = nodeLocked();
  const words = locked ? t("log.node.locked") : note ? t(note[0], note[1]) : "";
  nodeNote.textContent = words;
  nodeNote.hidden = !words;
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
    // Without the core there is no probe: the rows say "not checked" and the preflight names the failure.
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

// ONE PREFLIGHT AT A TIME COUNTS: a person who clicks through the rows gets the answer for the last one.
let preflightRun = 0;
async function runPreflight() {
  const mine = ++preflightRun;
  openBtn.disabled = true;
  setStatus(preflightEl, t("page.preflight"), "wait");
  const ready = await preflight(() => mine === preflightRun);
  if (mine !== preflightRun) return false;
  openBtn.disabled = !ready;
  if (ready) log(t("log.ready"));
  return ready;
}
function checkEnvironment() {
  return runPreflight().catch((e) => log(String((e && e.message) || e), "bad"));
}

document.addEventListener("i18n:applied", () => { drawRows(); drawNote(); });

fileInput.addEventListener("change", () => { onFileChosen().catch((e) => log(String((e && e.message) || e), "bad")); });
openBtn.addEventListener("click", () => busy(openBtn, openFile, openErrorEl));
withdrawBtn.addEventListener("click", () => busy(withdrawBtn, withdraw, withdrawErrorEl));
sendBtn.addEventListener("click", () => busy(sendBtn, sendTx, withdrawErrorEl));
forgetBtn.addEventListener("click", () => busy(forgetBtn, () => forget()));

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
