// The recovery page: the recovery key -> the swaps it made, found on chain -> one swap that needs it -> your
// address -> one button that syncs, builds and signs -> confirm -> send.
//
// THE RULES LIVE IN @ninsei-labs/sdk: importRecoveryKey, openRecoveryKeyFile, findSwaps, readEscrowEventsByTopic,
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

// WORDS, NUMBERS AND DATES come from the page's locale module; the page keeps no refusal dictionary of its own.
import { t, n, d, init as initLocale } from "./locales/index.js";
import {
  NODES,
  DEFAULT_NODE,
  STAGENET_NODE,
  nodeUrl,
  nodeSource,
  setNodeUrl,
  nodeHost,
  nodeNetwork as nodeNetworkOf,
  pingNode,
  medianHeight,
  nodeVerdict,
  moneroReaders,
  moneroHeaderTime,
  nodeFor,
} from "./lib/node.js";
import { keyNetworks, settlementOf, evmCall, evmLogs, evmBlockNumber, evmBlockTime } from "./lib/settlement.js";
import { nameOf, pageFailure, reasonOf, txIds } from "./lib/reason.js";
import {
  swapState,
  moneyState,
  statusFromEvents,
  scanStartHeight,
  tipHeaderHeight,
  tipTrusted as tipIsTrusted,
} from "./lib/withdrawal.js";
import { sideOf, deadlineOf, newOrders, orderId, swapStateOf, ethRecipient } from "./lib/rows.js";

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

// A NODE MUST NOT SET THE WITHDRAWAL FEE. The SDK has the same 0.01 XMR ceiling by default; the page passes it
// explicitly so a later SDK default cannot quietly raise the amount this page signs. The SDK also refuses an
// unreported fee, because a cost the page cannot see is not a free withdrawal.
const SWEEP_FEE_LIMIT_ATOMIC = 10_000_000_000n; // 0.01 XMR
// A KEY FILE IS TEXT WITH A FEW HUNDRED BYTES OF WORDS. Read it only after the size check: a huge file must not be
// pulled into the tab's memory before the page can say it is not a key.
const MAX_KEY_FILE_BYTES = 1_000_000;

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
// THE RETRY CONTROL IS BUILT HERE, not in index.html: the page keeps its static markup free of controls that
// only make sense after a network read failed. The SDK's search is complete in one call, so there is no cursor.
const keyPartialEl = $("keyPartial");
const keyActionsEl = document.createElement("p");
keyActionsEl.className = "key-actions";
keyActionsEl.hidden = true;
keyActionsEl.style.cssText = "display:flex;gap:8px;margin:8px 0 12px";
const keyMoreEl = document.createElement("button");
keyMoreEl.id = "keyMore";
keyMoreEl.type = "button";
keyMoreEl.className = "small";
keyMoreEl.setAttribute("data-i18n", "key.more");
keyMoreEl.hidden = true;
const swapListEl = $("swapList");
const swapHeadEl = $("swapHead");
const ethBox = $("ethAction");
const ethStateEl = $("ethState");
const ethFactsEl = $("ethFacts");
const ethConnectBtn = $("ethConnect");
const ethWalletEl = $("ethWallet");
const ethRecipientEl = $("ethRecipient");
const ethErrorEl = $("ethError");
const ethConfirmEl = $("ethConfirm");
const ethInfoEl = $("ethInfo");
const ethSendBtn = $("ethSend");
const ethDoneEl = $("ethDone");
const ethDoneHeadEl = $("ethDoneHead");
const ethDoneInfoEl = $("ethDoneInfo");
keyActionsEl.append(keyMoreEl);
keyResultEl.insertBefore(keyActionsEl, swapListEl);
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
const resultsEl = $("results");
const resultListEl = $("resultList");

let api = null; // monero-ts namespace
let mod = null; // built SDK core
let keyFile = null; // { text, refused } of the chosen file, until the search reads it: text is null while it is read
let finding = null; // the "Find my swaps" press that is running; null when none is
let key = null; // { mnemonic, fingerprint } of the last search: the words live here and nowhere else
let search = null; // the last search: { rows, failed } - rows are { swap, net, side, status, time }
let searchReady = false; // the wallet and the browser's crypto answered (runPreflight)
let nodeAnswer = null; // { url, network }: the last node that answered, and the Monero network it named (checkNode)

// ONE OPENED SWAP IS ONE OBJECT, and its state is kept nowhere else: the row and the key it was opened with, its own SDK
// facade, its payload and plan, its wallet with the node and height it was restored from, what the wallet saw, the
// transfer being built, shown or sent, and the ETH action with the person's wallet. Opening a row makes a new one;
// closing it lets go of everything but the row, so no key, no payload, no signed session and no wallet outlives it.
//
// THE ONE RULE. A step that waits takes its swap (and its transfer) when it starts, reads and writes only that object
// after a wait, and asks `holds` before it shows, signs or gives anything. A newer act never edits what a running
// step works on: it replaces `current`, or drops the swap's transfer, and the older step finds it no longer holds.
let current = null;
function openedSwap(row) {
  return {
    row,
    key,
    settlement: row.net.id, // settlement network, one lib/settlement.js knows
    network: row.net.monero, // Monero network
    core: null, // its own SDK facade: the signed sessions and their adapters live and end with it
    contents: null, // the file from sweep.fromOrder, a plain envelope in memory
    plan: null, // core plan: address, height, missing, revealed half
    node: null, // the node its wallet was built on
    height: null, // the height its wallet was restored from
    adapter: null, // core wallet adapter (connect/sync/unlockedBalance/driver)
    wallet: null, // library wallet: driver() of the adapter
    balance: null, // { total, unlocked, txs } after a sync, null before one
    checkpoint: null, // the page's own node read, resumed before a second observation
    transfer: null, // the transfer Withdraw started (newTransfer), until it ends
    building: false, // a Withdraw is running
    outcome: null, // "sent" once its XMR left, "unsure" while that is not known and the balance was not read again
    progress: null, // the stage the bar under the button shows
    eth: null, // the ETH action of a swap whose ETH can be taken (openEth)
  };
}

// ONE WITHDRAWAL: the address it is for from the press of Withdraw on, and the signed session and figures the
// confirmation shows. `pressed` is a Confirm that is running, `given` is the node having it, `dropped` is why it ended.
function newTransfer(swap, dest) {
  return {
    dest,
    network: swap.network,
    fingerprint: swap.key.fingerprint,
    token: null,
    amount: null,
    fee: null,
    receive: null,
    pressed: false,
    given: false,
    dropped: null,
  };
}

// WHAT A STEP ASKS AFTER A WAIT: its swap is still the one on the screen, and its transfer is still the swap's and is
// for the address in the field.
const holds = (swap, transfer = null) =>
  swap === current && (!transfer || (swap.transfer === transfer && destInput.value.trim() === transfer.dest));

// FROM THE MOMENT THE NODE IS GIVEN A TRANSFER until its answer nothing newer can be started: it could not stop it.
const sending = () => Boolean(current && current.transfer && current.transfer.given);

const looksLikeXmrAddress = (text) => /^[1-9A-HJ-NP-Za-km-z]{95}$|^[1-9A-HJ-NP-Za-km-z]{106}$/.test(text);
const wordCount = () => keyWordsInput.value.trim().split(/\s+/).filter(Boolean).length;
const currentState = () => (current ? moneyState(current) : null);
const nodeNetwork = () => (nodeAnswer && nodeAnswer.url === nodeUrl() ? nodeAnswer.network : null);
// THE SDK'S DEADLINE CONVERSION IS LOADED ASYNCHRONOUSLY. The row rules live in lib/rows.js; this binding supplies
// the converter once the bundle is present, without moving the decision back into the page.
const rowStateOf = (row) => swapStateOf(settled(row), { msFromOrderSeconds: mod && mod.msFromOrderSeconds });
const rowDeadlineOf = (swap) => deadlineOf(swap, mod && mod.msFromOrderSeconds);

// VIOLET IS THE NEXT ACTION: "Find my swaps" once twelve words or a key file (and its password) are there,
// "Withdraw XMR" once the money is ready and an address is named.
//
// A BUTTON IS OPEN OR CLOSED BY THE STATE, never by the step that pressed it: an older step that ends must not open
// the button of a newer one.
function updateButtons() {
  const reading = Boolean(keyFile && keyFile.text === null);
  const refused = Boolean(keyFile && keyFile.refused);
  const keyReady = keyFile ? !reading && (keyPassField.hidden || Boolean(keyPassInput.value)) : wordCount() === 12;
  findSwapsBtn.classList.toggle("ready", keyReady);
  findSwapsBtn.disabled = !searchReady || reading || refused || Boolean(finding) || sending();
  for (const input of [keyWordsInput, keyFileInput, keyPassInput]) input.disabled = Boolean(finding) || sending();
  keyMoreEl.disabled = sending();
  destInput.disabled = sending();
  heightInput.disabled = sending() || Boolean(current && current.building);
  const state = currentState();
  const transfer = current && current.transfer;
  const signed = Boolean(transfer && transfer.token);
  const sent = Boolean(current && current.outcome === "sent");
  withdrawBtn.disabled = !current || current.building || sent || sending();
  sendBtn.disabled = !signed || transfer.pressed;
  withdrawBtn.classList.toggle(
    "ready",
    Boolean(state && state.state === "ready") && looksLikeXmrAddress(destInput.value.trim()) && !signed && !sent,
  );
  updateNodeLock();
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
// end (connecting, signing, sending). `sub` returns the line under the bar. It is kept on its swap and drawn for the
// swap on the screen, so a scan of another swap moves nothing here and a language change redraws the same numbers.
function drawProgress() {
  const progress = current && current.progress;
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
function showProgress(swap, words, { params = {}, fraction = null, sub = null } = {}) {
  swap.progress = { key: words, params, fraction, sub };
  drawProgress();
}
function hideProgress(swap) {
  swap.progress = null;
  drawProgress();
}

// TIME LEFT OF A SCAN, from its own pace so far: said only once there is a pace to go by.
function timeLeft(seconds) {
  if (!(seconds > 0) || !Number.isFinite(seconds)) return "";
  return seconds < 90
    ? t("flow.time.sec", { n: n(Math.max(1, Math.round(seconds))) })
    : t("flow.time.min", { n: n(Math.round(seconds / 60)) });
}

// A TRANSFER BELONGS TO THE ADDRESS IT WAS STARTED FOR, from the press of Withdraw on: a changed address ("changed",
// changed back or not), another Withdraw ("again"), another swap or search ("left"), or words typed or a file chosen for
// another key ("key") drops it at once, whatever step it is in, and the confirmation goes with it. A pressed Confirm ends
// here as not sent: it was not given to the node, and now it cannot be. One that was given is the node's to answer, and
// is never dropped.
function dropTransfer(swap, why) {
  const transfer = swap && swap.transfer;
  if (!transfer || transfer.given) return;
  swap.transfer = null;
  transfer.dropped = why;
  if (transfer.pressed) {
    hideProgress(swap);
    record(transfer, "unsent", why);
    log(t("log.send.stopped", { dest: transfer.dest }), "wait");
  }
  if (swap === current) {
    confirmEl.hidden = true;
    if (why === "key") say(withdrawErrorEl, "flow.err.key", {}, "wait");
  }
  updateButtons();
}

// WHAT BECAME OF EACH PRESS OF CONFIRM in this page, newest first. A result is a small public record, not the transfer: it
// belongs to no open swap, so opening another swap or key leaves it where the person can find it, named by its key; the
// end of a press touches its own record only. It says only what is known: "unsent" with why, "given" while the node has
// it and has not answered, "sent" with its transaction, or "unknown".
const results = [];
function record(transfer, state, why = null) {
  const { fingerprint, dest, network, receive } = transfer;
  const result = { fingerprint, dest, network, receive, state, why, txids: [] };
  results.unshift(result);
  drawResults();
  return result;
}
function endResult(result, state, { why = null, txids = [] } = {}) {
  result.state = state;
  result.why = why;
  result.txids = txids;
  drawResults();
}
function drawResults() {
  resultsEl.hidden = !results.length;
  resultListEl.replaceChildren(
    ...results.map((result) => {
      const info = h("div", { class: "info" });
      const ids = result.txids.map((id) => ["info.txid", () => explorerLink(result.network, id)]);
      const none = result.state === "unsent" ? [] : [["info.txid", t("value.txid." + result.state)]];
      drawInfo(info, [
        ["info.recipient", result.dest],
        ["info.receive", receives(result)],
        ["info.key", t("key.print", { fp: result.fingerprint })],
        ...(ids.length ? ids : none),
      ]);
      const hint = result.state === "unsent" ? "result.unsent." + result.why : `result.${result.state}.hint`;
      return h("div", { class: "done", "data-state": result.state }, [
        h("p", { class: "done-head", text: t("result." + result.state) }),
        info,
        h("p", { class: "hint", text: t(hint) }),
      ]);
    }),
  );
}

destInput.addEventListener("input", () => {
  if (sending()) return;
  dropTransfer(current, "changed");
  if (current && current.building) say(withdrawErrorEl, "flow.err.changed", {}, "wait");
  else quiet(withdrawErrorEl);
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
}

// THE ONE RULE FOR A TEXT THAT MAY BE SHOWN OR COPIED (lib/reason.js): the page's own words for a code, names and
// numbers. No message of a wallet, a node, an RPC or a library is.
const reason = (error) => reasonOf(error, t);

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
const LINE_STATES = { idle: "idle", wait: "checking", ok: "good", bad: "bad" };
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

// A PANEL OF ROWS: [label key, value, class]. It keeps none of them: a language change draws it again from what is open.
function drawInfo(node, rows) {
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
}

document.addEventListener("i18n:applied", () => {
  for (const [el, [words, params]] of said) el.textContent = t(words, params);
  drawSwaps();
  if (current && current.plan) drawMoney();
  drawConfirm();
  drawChecks();
  drawProgress();
  drawResults();
  drawEth();
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
const short = (address) => String(address).slice(0, 10) + "…";

// AN EXCEPTION NOBODY NAMED is logged with its cause and said in one plain line, under the swap its step began with.
async function step(fn, errorEl) {
  const swap = current;
  try {
    return await fn();
  } catch (e) {
    log(t("log.error", { message: reason(e) }), "bad");
    if (swap === current) say(errorEl, "flow.err.generic");
    return null;
  } finally {
    updateButtons();
  }
}

// --- 0. SDK core: built under sweep/, loaded once ---

async function sdkBundle() {
  if (!mod) mod = await import(SDK_BUNDLE);
  return mod;
}

// ONE SWAP'S CORE FACADE, built for its own networks and ended with it: the SDK keeps every signed session and its wallet
// adapter in the facade that made them, so a facade shared by swaps would keep the keys of those that were left.
//
// THE CHAIN READ IS REAL: `evmCall` is an eth_call over the settlement network's public RPCs (lib/settlement.js),
// and a failed read throws instead of answering "0x". The escrow events are read in bulk by readEscrowEventsByTopic, and
// sweep.plan reads the revealed half; the plan's app route fallback meets `noService`, which it reads as "not revealed".
async function newFacade(settlement, xmrNetwork) {
  const m = await sdkBundle();
  return m.createNinsei({
    settlement: { chain: settlement },
    xmrNetwork,
    mode: "live",
    fetch: noService,
    storage: m.memoryAdapter(),
    evmCall: (request) => evmCall(settlement, request),
  });
}

// --- 0b. Environment: without these checks nothing makes sense ---

// THE WALLET IN THIS TAB: the monero-ts bundle, the built SDK core and the worker file. Checked once: they do not
// change when the person picks another node, and loading them again would only repeat the same lines.
let walletCheck = null;
let loadWalletImpl = loadWallet;
function checkWallet() {
  if (!walletCheck) walletCheck = loadWalletImpl();
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
    failed.push(["preflight.fail.bundle", { message: reason(e) }]);
  }

  // CORE. A load failure is named in the log, never swallowed.
  try {
    await sdkBundle();
    log(t("log.core.loaded", { file: SDK_BUNDLE.split("/").pop() }));
  } catch (e) {
    failed.push(["preflight.fail.core", { message: reason(e) }]);
  }

  if (api) {
    api.LibraryUtils.setWorkerDistPath(WORKER);
    try {
      const r = await fetch(WORKER);
      const buf = await r.arrayBuffer();
      if (r.status !== 200 || buf.byteLength < 1_000_000) throw pageFailure("worker", { bytes: buf.byteLength });
      log(
        t("log.worker.ok", { mb: n(buf.byteLength / 1048576, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }),
      );
    } catch (e) {
      failed.push(["preflight.fail.worker", { message: reason(e) }]);
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
// nobody chose. An answer belongs to the node that gave it and to the question it answers: it must not paint the line
// or name the network once another node is chosen, or once the same node was asked again.
let nodeAsk = 0;
async function checkNode() {
  const url = nodeUrl();
  const ask = ++nodeAsk;
  const stands = () => ask === nodeAsk && nodeUrl() === url;
  setCheck("node", "wait");
  if (!url) {
    setCheck("node", "bad", () => t("preflight.fail.noNode"));
    return false;
  }
  let core = null;
  try {
    core = await sdkBundle();
  } catch {
    // Without the core there is no probe; the wallet line names the failure.
  }
  if (!stands()) return false;
  if (!core) {
    nodeAnswer = null;
    setCheck("node", "bad", () => t("node.state.unchecked"));
    return false;
  }
  const probe = await core.probeMoneroNode({ url });
  if (!stands()) return false;
  nodeAnswer = probe.ok ? { url, network: probe.network || null } : null;
  if (!probe.ok) {
    // THE REASON IN THE NODE LIST'S OWN WORDS (nodeVerdict), with the node's name.
    const verdict = nodeVerdict(probe, null);
    const host = nodeHost(url);
    const why = () => host + ": " + t("node.state." + verdict.why, verdict.params);
    log(t("preflight.fail.node", { message: why() }), "bad");
    setCheck("node", "bad", why);
    return false;
  }
  log(
    t("log.node.answering", {
      height: n(probe.height),
      sync: probe.synchronized === true,
      nettype: nameOf(probe.nettype) || "?",
      node: t("node.label.listed", { url }),
    }),
  );
  setCheck("node", "ok");
  return true;
}

// --- 1. The recovery key and the swaps it made ---

// THE WORDS OR THE FILE, NOT BOTH, AND NO TRANSFER OF THE KEY BEFORE: what a person enters last is the key they mean, from
// the moment they enter it. Typed words put a chosen file away; a chosen file empties the words at once, also while it is
// read and when it cannot be; and either ends a transfer that has not been given to the node, shown or pressed.
function enterKey({ file = null } = {}) {
  keyFile = file;
  keyPassInput.value = "";
  keyPassField.hidden = true;
  if (file) keyWordsInput.value = "";
  else keyFileInput.value = "";
  quiet(keyErrorEl);
  dropTransfer(current, "key");
  dropCheck(current);
  updateButtons();
}
keyWordsInput.addEventListener("input", () => {
  if (!sending()) enterKey();
});
keyPassInput.addEventListener("input", updateButtons);

// THE PASSWORD IS ASKED ONLY FOR A KEY FILE WRITTEN WITH ONE, and the SDK's reader says which: opening the file
// without a password stops at the stage "passphrase" for a protected file, reads a plain one, and refuses anything
// that is not a key file. A file that is still being read when the person enters another key is no longer the chosen one.
async function onKeyFileChosen() {
  const picked = keyFileInput.files && keyFileInput.files[0];
  if (sending()) {
    keyFileInput.value = "";
    return false;
  }
  if (!picked) {
    enterKey();
    return false;
  }
  const file = { text: null, refused: null };
  enterKey({ file });
  // A FILE THAT COULD NOT BE READ STAYS THE KEY THAT WAS ENTERED, and its refusal stands until the person types or
  // chooses again: nothing is searched in its place.
  const refuse = (words) => {
    file.refused = words;
    updateButtons();
    return say(keyErrorEl, words);
  };
  if (picked.size > MAX_KEY_FILE_BYTES) return refuse("flow.err.keyFileTooLarge");
  let text;
  try {
    text = await picked.text();
  } catch (e) {
    if (keyFile !== file) return false;
    log(t("log.key.refused", { words: reason(e) }), "bad");
    return refuse("flow.err.keyFileRead");
  }
  if (keyFile !== file) return false;
  file.text = text;
  try {
    await (await sdkBundle()).openRecoveryKeyFile(text, "");
  } catch (e) {
    if (keyFile !== file) return false;
    if (e && e.params && e.params.stage === "passphrase") keyPassField.hidden = false;
    else {
      log(t("log.key.refused", { words: reason(e) }), "bad");
      return refuse("flow.err.keyFile");
    }
  } finally {
    updateButtons();
  }
  return true;
}

// THE KEY FROM THE FIELDS, or null with the reason said. The words are never part of a log line: a refusal names
// the SDK's code and the field, nothing typed.
async function readKey(press) {
  const m = await sdkBundle();
  if (keyFile) {
    try {
      return await m.openRecoveryKeyFile(keyFile.text, keyPassInput.value);
    } catch (e) {
      log(t("log.key.refused", { words: reason(e) }), "bad");
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
    log(t("log.key.refused", { words: reason(e) }), "bad");
    say(keyErrorEl, "flow.err.words");
    return null;
  }
}

function clearKeyFields() {
  keyWordsInput.value = "";
  keyFileInput.value = "";
  keyFile = null;
  keyPassInput.value = "";
  keyPassField.hidden = true;
}

// FIND THE SWAPS OF A KEY on every settlement network the SDK names a live factory for (lib/settlement.js,
// keyNetworks). The search reads the factory's orders and matches their commitments in this tab: only the factory,
// the topic and the block range reach the RPC. Each found swap's state and date are read from the chain; a read
// that fails is "unknown", never "nothing to do". With empty fields the button searches again with the same key.
//
// A NEW KEY STARTS CLEAN, when its press begins: the swap being withdrawn closes and the old key's answer goes, before
// the new key is read. Under a refusal the old answer would read as the answer to the words just typed, and an open
// swap would go on with a key the person has left. The words leave the fields once they are read.
async function findKeySwaps(options = {}) {
  if (sending()) return false;
  const refused = keyFile && keyFile.refused;
  if (!refused) quiet(keyErrorEl);
  if (options && options.more === true) return searchKey(search, { more: true });
  if (refused) return say(keyErrorEl, refused);
  const press = (finding = {});
  const again = keyFile || keyWordsInput.value.trim() ? null : key;
  closeSwap();
  key = null;
  search = null;
  drawSwaps();
  updateButtons();
  try {
    const read = again || (await readKey(press));
    if (!read || finding !== press) return false;
    key = { mnemonic: read.mnemonic, fingerprint: read.fingerprint };
    clearKeyFields();
    search = { key, rows: [], failed: [], done: false, searching: false, sources: [] };
    return await searchKey(search);
  } catch (e) {
    log(t("log.error", { message: reason(e) }), "bad");
    return say(keyErrorEl, "flow.err.generic");
  } finally {
    if (finding === press) finding = null;
    updateButtons();
  }
}

// ONE SEARCH, OF ONE KEY: it reads its own key and writes its own rows, and stops when another has replaced it.
async function searchKey(mine, { more = false } = {}) {
  if (!mine || mine.done || mine.searching) return false;
  mine.searching = true;
  drawSwaps();
  try {
    return await readSwaps(mine, more);
  } catch (e) {
    if (search !== mine) return false;
    log(t("log.error", { message: reason(e) }), "bad");
    return say(keyErrorEl, "flow.err.generic");
  } finally {
    mine.searching = false;
    drawSwaps();
  }
}
async function readSwaps(mine, more) {
  // THE NODE IS PROBED WHEN A SEARCH BEGINS, not when the page opens. The answer names the network of the swap's
  // start height; a failed probe leaves the search on the settlement chain alone and the swap says its height is
  // missing, rather than contacting every listed node on every visit.
  if (!nodeNetwork() && nodeUrl()) await checkNode();
  const m = await sdkBundle();
  if (search !== mine) return false;
  if (!more) {
    const { search: networks, unreadable } = keyNetworks(m.CHAINS);
    for (const id of unreadable) {
      log(t("log.key.unreadable", { network: id }), "bad");
      mine.failed.push(id);
    }
    if (!networks.length) {
      mine.done = true;
      return say(keyErrorEl, "flow.err.keyChain");
    }
    mine.sources = networks.map((net) => ({ net, complete: false, error: null }));
    log(t("log.key.searching", { fp: mine.key.fingerprint, networks: networks.map((net) => net.name).join(", ") }));
  }
  for (const source of mine.sources) {
    if (source.complete) continue;
    const net = source.net;
    let found;
    let latest;
    try {
      latest = await evmBlockNumber(net.id);
      found = await m.findSwaps({
        mnemonic: mine.key.mnemonic,
        chainId: net.chainId,
        factories: net.factories,
        evmLogs: (request) => evmLogs(net.id, request),
        toBlock: latest,
        // THE START HEIGHT IS THE SDK'S RULE: the page hands it the order's block time and a Monero node's tip and
        // headers, read the way a node answers them (lib/node.js), from the node a swap of this network uses.
        evmBlockTime: (block) => evmBlockTime(net.id, block),
        ...(await moneroReaders(nodeFor(net.monero, nodeNetwork()), net.monero, m.probeMoneroNode)),
      });
      if (search !== mine) return false;
    } catch (e) {
      if (search !== mine) return false;
      if (!mine.failed.includes(net.name)) mine.failed.push(net.name);
      log(t("log.key.searchFailed", { network: net.name, words: reason(e) }), "bad");
      continue;
    }
    // A PREVIOUS FAILURE OF THIS NETWORK IS CLEARED BY A SUCCESSFUL READ; unreadable networks (not in sources)
    // stay named.
    const failedAt = mine.failed.indexOf(net.name);
    if (failedAt >= 0) mine.failed.splice(failedAt, 1);
    // THE SDK'S RESULT IS COMPLETE BY CONSTRUCTION: there is no index range, so there is no cursor to carry.
    // A false `complete` is named as a failed read rather than shown as a partial list.
    source.complete = found.complete === true;
    if (!source.complete) {
      if (!mine.failed.includes(net.name)) mine.failed.push(net.name);
      log(t("log.key.searchFailed", { network: net.name, words: "incomplete" }), "bad");
      continue;
    }
    log(
      t("log.key.searched", {
        network: net.name,
        count: n(found.swaps.length),
        from: n(net.since),
        to: n(latest),
      }),
      found.swaps.length ? "ok" : "",
    );
    for (const swap of newOrders(mine.rows, net, found.swaps)) {
      const row = { swap, net, side: sideOf(swap), status: null, time: null };
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
        log(t("log.swap.timeFailed", { escrow: short(swap.escrow), words: reason(e) }), "wait");
      }
      mine.rows.push(row);
    }
    if (search !== mine) return false;
    // THE ESCROW EVENTS ARE READ IN ONE TOPIC-ONLY REQUEST. Asking status() for every found escrow named each of
    // them to the public RPC next to the visitor's IP; one eth_getLogs by the three event topics returns the claim,
    // refund and decline facts for every escrow in the range, and the page keeps those of its own rows. A failed
    // bulk read leaves the rows unknown instead of falling back to per-order calls.
    const networkRows = mine.rows.filter((row) => row.net === net);
    if (networkRows.length) {
      try {
        const events = await m.readEscrowEventsByTopic({
          // NO ESCROW ADDRESSES REACH THE RPC: the SDK asks for the three event topics over the block range and
          // carries no address filter. The page keeps the events of its own rows below. The range starts at the
          // earliest order this key actually found, not at the earliest factory: a factory older than every order
          // is a range the RPC does not have to scan.
          evmLogs: (request) => evmLogs(net.id, request),
          fromBlock: (() => {
            const earliest = networkRows.reduce((first, row) => {
              const block = Number(row.swap.blockNumber);
              return Number.isSafeInteger(block) && block < first ? block : first;
            }, Infinity);
            return Number.isSafeInteger(earliest) ? earliest : net.since;
          })(),
          toBlock: latest,
        });
        if (search !== mine) return false;
        const byEscrow = new Map();
        for (const event of events) {
          const key = String(event.escrow || "").toLowerCase();
          if (!byEscrow.has(key)) byEscrow.set(key, []);
          byEscrow.get(key).push(event);
        }
        for (const row of networkRows)
          row.status = statusFromEvents(byEscrow.get(String(row.swap.escrow).toLowerCase()) || []);
      } catch (e) {
        if (search !== mine) return false;
        // THE EVENT READ FAILED, SO THE ROW STATE IS UNKNOWN. Do not leave the search marked complete: the person
        // can retry the same network instead of being stuck with rows whose state cannot be shown.
        source.complete = false;
        if (!mine.failed.includes(net.name)) mine.failed.push(net.name);
        log(t("log.key.eventsFailed", { network: net.name, words: reason(e) }), "bad");
      }
    }
  }
  // NEWEST FIRST, by the block that holds the order.
  mine.rows.sort((a, b) => (b.swap.blockNumber ?? -1) - (a.swap.blockNumber ?? -1));
  // A FAILED NETWORK IS NOT A COMPLETE SEARCH: the person can try again, and "no swaps" must stay hidden.
  mine.done = mine.sources.every((source) => source.complete) && mine.failed.length === 0;
  if (mine.failed.length && !mine.rows.length && mine.failed.length >= mine.sources.length) {
    return say(keyErrorEl, "flow.err.search");
  }
  return true;
}

// THE ORDER'S AMOUNT in the settlement chain's coin, for display: the escrow holds it in its smallest unit.
function formatCoin(net, value) {
  const decimals = Number(net.native && net.native.decimals) || 18;
  const symbol = (net.native && net.native.symbol) || "ETH";
  try {
    const units = BigInt(value);
    const scale = 10n ** BigInt(decimals);
    const whole = units / scale;
    const fraction = (units % scale).toString().padStart(decimals, "0").slice(0, 6);
    // A NUMBER CANNOT HOLD A LARGE ORDER'S WHOLE UNITS EXACTLY. Keep the BigInt decimal string when the atomic
    // amount is beyond Number's safe integer; only a display path needs the fallback, the signed amount stays BigInt.
    const exact = `${whole}.${fraction}`.replace(/\.?0+$/, "");
    const amount = units <= BigInt(Number.MAX_SAFE_INTEGER) ? n(Number(exact), { maximumFractionDigits: 6 }) : exact;
    return t("swap.amount", { amount, symbol });
  } catch {
    return t("swap.amount.unknown");
  }
}
function coinAmount(row) {
  return formatCoin(row.net, row.swap.amount);
}

// THE LIST, drawn from the last search, so a language change redraws the same rows. The SDK reads every matching
// order in one complete result; a failed network keeps its rows, names itself, and offers a retry. "No swaps"
// waits for a complete search.
function drawSwaps() {
  keyResultEl.hidden = !key || !search;
  if (keyResultEl.hidden) {
    swapListEl.replaceChildren();
    return;
  }
  keyPrintEl.textContent = t("key.print", { fp: key.fingerprint });
  const rows = search.rows;
  keyCountEl.textContent = search.searching
    ? t("key.searching")
    : rows.length
      ? search.done
        ? t("key.count", { count: rows.length })
        : t("key.count.partial", { count: rows.length })
      : "";
  keyNoneEl.hidden = !search.done || rows.length > 0 || search.failed.length > 0;
  keyPartialEl.hidden = !search.failed.length;
  keyPartialEl.textContent = search.failed.length ? t("key.partial", { list: search.failed.join(", ") }) : "";
  const pending = (search.sources || []).some((source) => !source.complete);
  keyMoreEl.hidden = search.done || search.searching || !pending;
  keyActionsEl.hidden = keyMoreEl.hidden;
  swapListEl.replaceChildren(...rows.map(swapRow));
}

function swapRow(row) {
  const state = rowStateOf(row);
  const when = row.time ? d(row.time * 1000, { dateStyle: "medium" }) : t("swap.date.unknown");
  const side = t(row.side === "buy" ? "value.side.buy" : row.side === "sell" ? "value.side.sell" : "swap.side.unknown");
  let action;
  if (state.action === "withdraw" || state.action === "refund" || state.action === "claim") {
    action = h("button", {
      type: "button",
      class: current && current.row === row ? "small ready" : "small",
      text: t("swap.action." + state.action),
    });
    action.disabled = sending();
    action.addEventListener("click", () => openSwap(row));
  } else {
    action = h("span", {
      class: "swap-action",
      text:
        state.action === "later" && row.side === "sell"
          ? t("swap.action.sell.later", { deadline: state.params.deadline ? d(state.params.deadline) : "" })
          : t("swap.action." + state.action, { deadline: state.params.deadline ? d(state.params.deadline) : "" }),
    });
  }
  return h(
    "li",
    {
      class: "swap",
      "data-action": state.action,
      ...(current && current.row === row ? { "aria-current": "true" } : {}),
    },
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
      ...(contradicted(row) ? [h("p", { class: "swap-state", "data-conflict": "", text: t("swap.conflict") })] : []),
      h("div", { class: "swap-do" }, [action, ...(contradicted(row) ? [checkAgain(row)] : [])]),
    ],
  );
}
// THE CHAIN IS READ AGAIN for the network of a row, as a repeated search reads it.
function checkAgain(row) {
  const button = h("button", { type: "button", class: "small", "data-check": "", text: t("swap.check") });
  button.disabled = sending() || search.searching;
  button.addEventListener("click", () => {
    const mine = search;
    mine.sources.find((source) => source.net === row.net).complete = false;
    mine.done = false;
    return searchKey(mine, { more: true });
  });
  return button;
}

// --- 2. The ETH side: refund a buy, claim a sell ------------------------------------------------

// NO GAS ESTIMATE HERE. eth_estimateGas carries the action's calldata, and for a claim or a refund that
// calldata contains the half. The wallet forwards the estimate to its RPC before Confirm, so the page
// shows the limit the wallet will use at send instead. The SDK builds and sends the actual call.

function injectedProvider() {
  const eth = window.ethereum;
  if (!eth || typeof eth.request !== "function") return null;
  if (Array.isArray(eth.providers) && eth.providers.length) {
    return eth.providers.find((p) => p && p.isMetaMask && typeof p.request === "function") || eth.providers[0];
  }
  return eth;
}

// THE ACTION FACADE HAS NO CHAIN READ OF ITS OWN, so the SDK's slot check and clock read through the wallet that will
// send; the page's public RPC here would let the check and the signature see two different chains.
function actionCore(swap) {
  return mod.createNinsei({
    settlement: { chain: swap.settlement },
    xmrNetwork: swap.network,
    mode: "live",
    fetch: noService,
    storage: mod.memoryAdapter(),
  });
}

// ONE ORDER HAS ONE SUBMISSION, from the moment its request is handed to the wallet until it is known to have ended. The
// entry is made at the hand-over and nowhere else, so a step that has not reached the wallet holds no order: it belongs
// to the view that made it, and ends with that view, with another key, or with a failure. "asking" until the wallet
// answers, "waiting" with a hash and no receipt, "elsewhere" while the wallet is on another network, "done" by its
// receipt, "unknown" when neither came: then the page never offers another by itself. Public values only.
const ethOrders = new Map();
const idOf = (row) => orderId(row.net, row.swap.escrow);
const ethOrder = (row) => ethOrders.get(idOf(row)) || null;
const viewing = (row) => Boolean(current && current.eth && idOf(current.row) === idOf(row));

// WHAT THE CHAIN'S EVENTS SHOW IS NEWER THAN A RECEIPT. A row whose action was executed here is settled, also in a list
// read before the events show it; events that show another end of the order win, and the row says so.
const ended = ({ status }) => Boolean(status && (status.isClaimed || status.isRefunded || status.isDeclined));
function settled(row) {
  const tx = ethOrder(row);
  if (!tx || tx.state !== "done" || ended(row)) return row;
  const status = { ...row.status, isRefunded: tx.kind === "refund", isClaimed: tx.kind === "claim", isDeclined: false };
  return { ...row, status };
}
function contradicted(row) {
  const tx = ethOrder(row);
  if (!tx || tx.state !== "done" || !ended(row)) return false;
  const { isRefunded, isClaimed, isDeclined } = row.status;
  return tx.kind === "refund" ? !isRefunded || isDeclined === true || isClaimed === true : !isClaimed;
}

// THE PERSON'S WALLET, AS ONE STEP MAY USE IT. What the SDK asks goes to it unchanged, but for three things: a transaction
// is handed over only by `hand`, which makes the order's entry, or refuses a step that was left; a network the wallet does
// not know is offered with the page's own public RPCs (the SDK's registry may name the machine it runs on); and a network
// that was added is selected, once, if the wallet did not (the SDK leaves it added). `code` is the wallet's own number for
// the request that failed, which the SDK replaces by a code of its own.
function walletFor(swap, injected, hand = null) {
  const wallet = {
    code: null,
    async request(request) {
      try {
        if (request.method === "eth_sendTransaction") {
          if (!hand) throw pageFailure("left");
          hand();
        }
        if (request.method !== "wallet_addEthereumChain") return await injected.request(request);
        const { rpcs } = settlementOf(swap.settlement);
        const network = { ...request.params[0], rpcUrls: [...rpcs] };
        const added = await injected.request({ ...request, params: [network] });
        const { chainId } = network;
        if (Number(await injected.request({ method: "eth_chainId" })) !== Number(chainId))
          await injected.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
        return added;
      } catch (error) {
        wallet.code = Number.isSafeInteger(error && error.code) ? error.code : null;
        throw error;
      }
    },
  };
  return wallet;
}
const walletReason = (error, { code }) =>
  reason(error) + (code === null ? "" : "; " + t("reason.wallet", { code: String(code) }));

// THE ETH BLOCK IS DRAWN FROM THE SWAP ON THE SCREEN, its own step and its order's submission, so nothing of another swap
// can stand in it: the action's facts once they are prepared, then Connect, then the confirmation, or what became of it.
function drawEth() {
  const eth = current && current.eth;
  ethBox.hidden = !eth;
  if (!eth) return;
  const { row } = current;
  const { material } = eth;
  const tx = ethOrder(row);
  for (const el of [ethStateEl, ethFactsEl, ethRecipientEl]) el.hidden = !material;
  if (material) {
    const deadline = rowDeadlineOf(row.swap);
    const until = { deadline: deadline ? d(deadline) : "" };
    const done = tx && tx.state === "done";
    ethStateEl.textContent = t((done ? "eth.done." : "eth.state.") + material.kind, until);
    ethRecipientEl.textContent = t("eth.recipient", { address: ethRecipient(row, material) });
    drawInfo(ethFactsEl, [
      ["info.swap", material.escrow],
      ["eth.kind.label", t("eth.kind." + material.kind)],
      ["info.amount.order", formatCoin(row.net, material.expect.amount)],
      ["eth.recipient.label", ethRecipient(row, material)],
      ["eth.window.label", t("eth.window." + material.kind, until)],
    ]);
    // NO ESTIMATE: it would send the action's calldata to the wallet's RPC before Confirm, and the half must stay in the
    // tab until the SDK builds the send, with a gas limit of its own.
    drawInfo(ethInfoEl, [
      ["eth.gas.label", t("eth.gas.fixed")],
      ["eth.recipient.label", ethRecipient(row, material)],
    ]);
  }
  const is = tx ? (tx.state === "unknown" && !tx.hash ? "lost" : tx.state) : eth.checking ? "checking" : null;
  ethConnectBtn.hidden = !material || Boolean(is) || Boolean(eth.injected);
  ethConnectBtn.disabled = eth.connecting;
  ethWalletEl.hidden = !eth.injected;
  ethWalletEl.textContent = eth.injected ? t("eth.wallet", { address: eth.account, chain: row.net.name }) : "";
  ethConfirmEl.hidden = !eth.injected || Boolean(is);
  ethDoneEl.hidden = !is;
  if (!is) return;
  ethDoneHeadEl.textContent = t("eth.tx.head." + is);
  drawInfo(ethDoneInfoEl, [
    ...(tx && tx.hash ? [["info.txid", ethExplorerLink(tx.hash, row)]] : []),
    ["eth.state.label", t(is === "done" ? "eth.done." + tx.kind : "eth.tx." + is, { network: row.net.name })],
  ]);
}

async function openEth(swap) {
  const { row } = swap;
  swap.eth = { material: null, injected: null, account: null, connecting: false, checking: null };
  quiet(ethErrorEl);
  drawEth();
  // A HASH WHOSE RECEIPT WAS NOT READ is asked for again, before anything else can be offered.
  const tx = ethOrder(row);
  if (tx && tx.hash && (tx.state === "unknown" || tx.state === "elsewhere")) ethReceipt(row, tx);
  try {
    swap.core = await newFacade(swap.settlement, swap.network);
    if (!holds(swap)) return false;
    const built = await swap.core.sweep.fromOrder({
      mnemonic: swap.key.mnemonic,
      chainId: row.net.chainId,
      network: swap.settlement,
      moneroNetwork: swap.network,
      order: row.swap,
    });
    if (!holds(swap)) return false;
    if (!built || (built.kind !== "refund" && built.kind !== "claim")) throw pageFailure("action");
    swap.eth.material = built;
    drawEth();
    log(t("log.eth.opened", { kind: built.kind, escrow: short(built.escrow) }));
    return true;
  } catch (e) {
    if (!holds(swap)) return false;
    log(t("log.eth.prepareFailed", { words: reason(e) }), "bad");
    return say(ethErrorEl, "eth.err.prepare");
  }
}

async function ethConnect() {
  const swap = current;
  const eth = swap && swap.eth;
  if (eth && eth.connecting) return false;
  quiet(ethErrorEl);
  if (!eth || !eth.material) return say(ethErrorEl, "eth.err.prepare");
  const injected = injectedProvider();
  if (!injected) {
    log(t("log.eth.connectFailed", { words: t("eth.err.noProvider") }), "bad");
    return say(ethErrorEl, "eth.err.noProvider");
  }
  const { row } = swap;
  const { material } = eth;
  const wallet = walletFor(swap, injected);
  eth.connecting = true;
  drawEth();
  try {
    const adapter = mod.evmWallet(wallet);
    await adapter.connect({ chainId: row.net.chainId });
    const account = await adapter.address();
    const chainId = await adapter.chainId();
    if (!holds(swap)) return false;
    if (!account) throw Object.assign(new Error("wallet-not-connected"), { code: "wallet-not-connected" });
    if (chainId !== Number(material.expect.chainId)) {
      throw Object.assign(new Error("wrong-chain"), {
        code: "wrong-chain",
        params: { want: material.expect.chainId, got: chainId },
      });
    }
    if (material.kind === "claim") {
      const expected = String(material.claimer || material.expect.claimer || "").toLowerCase();
      if (account.toLowerCase() !== expected) {
        log(t("log.eth.connectFailed", { words: t("eth.err.claimer", { account, expected }) }), "bad");
        return say(ethErrorEl, "eth.err.claimer", { account, expected });
      }
    }
    // THE WALLET IS THE SWAP'S ONLY ONCE THE WHOLE CHECK PASSED. A failed connection keeps the prepared action, so the
    // next press of Connect tries the same one again.
    Object.assign(eth, { injected, account });
    log(t("log.eth.connected", { address: account, chainId }));
    return true;
  } catch (e) {
    if (!holds(swap)) return false;
    log(t("log.eth.connectFailed", { words: walletReason(e, wallet) }), "bad");
    return say(
      ethErrorEl,
      e && e.code === "wrong-chain"
        ? "eth.err.chain"
        : e && e.code === "wallet-rejected"
          ? "eth.err.rejected"
          : "eth.err.connect",
    );
  } finally {
    eth.connecting = false;
    drawEth();
  }
}

// ANOTHER KEY ENDS A STEP THAT HAS NOT REACHED THE WALLET, as it drops a transfer: it is not handed over, and says so. One
// the wallet has is its own, and only its outcome is said.
function dropCheck(swap) {
  const eth = swap && swap.eth;
  if (!eth || !eth.checking) return;
  eth.checking = null;
  log(t("log.eth.stopped"), "wait");
  drawEth();
  say(ethErrorEl, "eth.err.key", {}, "wait");
}

async function ethSend() {
  const swap = current;
  const eth = swap && swap.eth;
  quiet(ethErrorEl);
  if (!eth || !eth.material || !eth.injected) return say(ethErrorEl, "eth.err.prepare");
  const { row } = swap;
  if (eth.checking || ethOrder(row)) return false;
  const { material, injected } = eth;
  const { kind } = material;
  const check = {};
  eth.checking = check;
  drawEth();
  // THE ORDER IS HELD FROM HERE ON: the wallet is given the transaction in the same turn. A step that was left, or that
  // another key ended, is refused, and nothing is held.
  let tx = null;
  const wallet = walletFor(swap, injected, () => {
    if (!holds(swap) || eth.checking !== check) throw pageFailure("left");
    eth.checking = null;
    ethOrders.set(idOf(row), (tx = { kind, state: "asking", hash: null, injected }));
    drawEth();
  });
  const mine = () => holds(swap) && eth.checking === check;
  try {
    const request = { escrow: material.escrow, expect: material.expect };
    if (kind === "claim") {
      request.halfClaimer = material.half;
      request.claimer = material.claimer;
    } else {
      request.halfLocker = material.half;
    }
    const sent = await actionCore(swap).actions[kind](request, mod.evmWallet(wallet));
    const hash = sent && sent.hash;
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw pageFailure("hash");
    tx.hash = hash;
  } catch (e) {
    // ENDED OR LEFT BEFORE THE WALLET WAS ASKED: nothing was handed over, and there is nothing of it to say here.
    if (!tx && !mine()) {
      if (!holds(swap)) log(t("log.eth.stopped"), "wait");
      return false;
    }
    log(t("log.eth.failed", { words: walletReason(e, wallet) }), "bad");
    const words = ethStop(e, wallet.code, Boolean(tx));
    if (tx && words === "eth.err.unknown") tx.state = "unknown";
    else if (tx) ethOrders.delete(idOf(row));
    if (eth.checking === check) eth.checking = null;
    drawSwaps();
    drawEth();
    return viewing(row) ? say(ethErrorEl, words) : false;
  }
  log(t("log.eth.sent", { kind, hash: tx.hash }));
  return ethReceipt(row, tx);
}

// WHY A SEND STOPPED. A step that did not reach the wallet sent nothing; a wallet that was given the transaction and did
// not refuse it by name may have sent it. A wallet that does not support the method (4200, and the JSON-RPC number for an
// unknown method) has sent nothing either, whatever code the SDK makes of it.
function ethStop(e, number, handed) {
  const code = e && e.code;
  const { why, field } = (e && e.params) || {};
  if (handed && (number === 4200 || number === -32601)) return "eth.err.refused";
  if (code === "wrong-account") return "eth.err.account";
  if (code === "bad-input" && (field === "wallet" || field === "wallet.address")) return "eth.err.account";
  if (code === "wrong-chain") return "eth.err.chain";
  if (code === "wallet-rejected") return "eth.err.rejectSend";
  if (code === "contract-reverted") {
    if (["too-early", "window-closed", "not-ready", "ready-window-closed"].includes(why)) return "eth.err.window";
    return handed ? "eth.err.refused" : "eth.err.check";
  }
  if (code === "wallet-not-connected" && why !== "transport") return "eth.err.connect";
  return handed && code !== "insufficient-funds" ? "eth.err.unknown" : "eth.err.send";
}

// SENT IS NOT DONE. Only a successful receipt of this transaction settles its order, whatever swap is on the screen by
// then; one that failed opens the action again; none in time is unknown, and the page sends no second one by itself.
async function ethReceipt(row, tx) {
  const { kind, hash } = tx;
  tx.state = "waiting";
  drawEth();
  tx.state = await waitForEthReceipt(tx, row.net.chainId);
  if (tx.state === "failed") ethOrders.delete(idOf(row));
  log(t("log.eth.receipt." + tx.state, { kind, hash, network: row.net.name }), tx.state === "done" ? "ok" : "bad");
  drawSwaps();
  drawEth();
  if (tx.state === "done") return true;
  const words = { failed: "eth.err.failed", elsewhere: "eth.err.elsewhere" }[tx.state] || "eth.err.receipt";
  return viewing(row) ? say(ethErrorEl, words, { network: row.net.name }) : false;
}

// "done", "failed", "elsewhere", or "unknown" once the limit passes, also when the wallet never answers a read. A receipt
// counts only when it is this transaction's, and is asked only of the order's own network: a wallet that moved elsewhere
// has not lost it, so the page says where it must be.
const ETH_RECEIPT_LIMIT_MS = 120_000;
const ETH_RECEIPT_EVERY_MS = 2_000;
async function waitForEthReceipt(tx, chainId) {
  const { hash, injected } = tx;
  let over = false;
  const limit = after(ETH_RECEIPT_LIMIT_MS).then(() => {
    over = true;
    return null;
  });
  const ask = (method, params) =>
    Promise.race([
      limit,
      (async () => {
        try {
          return await injected.request({ method, params });
        } catch {
          return null;
        }
      })(),
    ]);
  let elsewhere = false;
  while (!over) {
    const chain = await ask("eth_chainId", []);
    if (over) break;
    elsewhere = typeof chain === "string" && Number(chain) !== chainId;
    // A receipt that cannot be read is not a success and not a failure: ask again until the limit.
    const receipt = elsewhere ? null : await ask("eth_getTransactionReceipt", [hash]);
    const own = receipt && String(receipt.transactionHash).toLowerCase() === hash.toLowerCase();
    if (own && Number(receipt.status) === 1) return "done";
    if (own && Number(receipt.status) === 0) return "failed";
    const state = elsewhere ? "elsewhere" : "waiting";
    if (!over && tx.state !== state) {
      tx.state = state;
      drawEth();
    }
    await Promise.race([after(ETH_RECEIPT_EVERY_MS), limit]);
  }
  return elsewhere ? "elsewhere" : "unknown";
}

function ethExplorerLink(hash, row) {
  const a = document.createElement("a");
  a.href = ((row && row.net.explorer) || "") + hash;
  a.target = "_blank";
  a.rel = "noreferrer noopener";
  a.className = "explorer-link";
  a.appendChild(document.createTextNode(t("link.explorer")));
  return a;
}

// --- 2. One swap: its keys, its start height, the SDK's plan ---

// OPEN ONE SWAP FOR THE WITHDRAWAL. sweep.fromOrder takes the key and the order, checks the chain's points against
// the key, builds the joint address and returns the file the plan reads. Nothing is written to disk. The swap open
// before closes: its transfer, its wallet and its steps end with it.
async function openSwap(row) {
  if (sending()) return false;
  if (!key) return say(keyErrorEl, "key.gone", {}, "wait");
  closeSwap();
  const swap = (current = openedSwap(row));
  return step(() => readSwap(swap), openErrorEl);
}
async function readSwap(swap) {
  const { row } = swap;
  stepSwap.hidden = false;
  const openState = rowStateOf(row);
  if (openState.action === "refund" || openState.action === "claim") {
    // THE ETH PATH NEEDS NO MONERO NODE, NO WALLET SCAN AND NO START HEIGHT. It stops at this block.
    moneyEl.hidden = true;
    heightBox.hidden = true;
    stepTransfer.hidden = true;
    swapHeadEl.textContent = t("page.step.eth");
    drawSwaps();
    stepSwap.scrollIntoView({ block: "nearest" });
    return await openEth(swap);
  }
  moneyEl.hidden = false;
  moneyEl.dataset.state = "wait";
  swapHeadEl.textContent = t("page.step.swap");
  moneyHeadEl.textContent = t("money.reading");
  swapInfoEl.hidden = true;
  drawSwaps();
  stepSwap.scrollIntoView({ block: "nearest" });
  // A TESTNET SWAP NEEDS A STAGENET NODE. If the current pick is on another network, the project's stagenet node is
  // chosen; the withdrawal still refuses a node of another network instead of scanning the wrong chain.
  if (swap.network === "stagenet" && nodeNetwork() !== "stagenet" && !nodeLocked()) {
    setNodeUrl(STAGENET_NODE, { remember: false, by: "pick" });
    markChoice(nodeUrl());
    try {
      await checkNode();
      drawCurrent();
    } catch {
      /* the withdrawal names the node failure */
    }
  }
  if (!holds(swap)) return false;
  swap.core = await newFacade(swap.settlement, swap.network);
  if (!holds(swap)) return false;
  // THE SDK BUILDS THE WITHDRAWAL FROM THE KEY AND THE ORDER. It decides the side, checks the chain's points against
  // the key, builds the joint address and returns the file plan/keys accept. The page keeps no payload rule.
  let material;
  try {
    material = await swap.core.sweep.fromOrder({
      mnemonic: swap.key.mnemonic,
      chainId: row.net.chainId,
      network: swap.settlement,
      moneroNetwork: swap.network,
      order: row.swap,
    });
  } catch (e) {
    if (!holds(swap)) return false;
    const why = e && e.params && e.params.why;
    const named = ["side", "spend-point", "own-view-point", "maker-view-point"].includes(why) ? why : "bad";
    log(t("log.order." + named, { escrow: row.swap.escrow }), "bad");
    moneyEl.hidden = true;
    return say(openErrorEl, why === "maker-view-point" ? "flow.err.view" : "flow.err.order");
  }
  if (!holds(swap)) return false;
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
  else log(t("log.height.failed", { why: nameOf(row.swap.startHeightReason) || "?" }), "wait");
  // PLAN IS THE CORE'S (sweep.plan): the address, the height and the maker's half, read from the escrow.
  let plan;
  try {
    plan = await swap.core.sweep.plan({ file: { contents: material.contents }, passphrase: "" });
  } catch (e) {
    if (!holds(swap)) return false;
    log(t("log.plan.failed", { words: reason(e) }), "bad");
    moneyEl.hidden = true;
    return say(openErrorEl, "flow.err.plan");
  }
  if (!holds(swap)) return false;
  swap.contents = material.contents;
  swap.plan = plan;
  if (plan.missing.includes("revealed-half")) log(t("log.miss.revealedHalf"), "wait");
  const height = Number(plan.restoreHeight) > 0 ? Number(plan.restoreHeight) : 0;
  heightInput.value = height > 0 ? String(height) : "";
  // NO HEIGHT IS A NAMED STATE: the scan would start from Monero's first block and take hours, so the step says it
  // and shows the field for the person to fill. A known height stays out of sight.
  heightBox.hidden = height > 0;
  drawMoney();
  const ready = currentState().state === "ready";
  stepTransfer.hidden = !ready;
  updateButtons();
  if (ready) log(t("log.next.address"));
  return true;
}

// --- 3. The state of the money, in words ---

const STATE_TONES = {
  ready: "ok",
  unread: "wait",
  locked: "wait",
  withdrawn: "none",
  unseen: "wait",
  incomplete: "wait",
  nothing: "none",
  sent: "none",
  unsure: "wait",
};

function drawMoney() {
  const state = current.outcome || currentState().state;
  moneyEl.dataset.state = STATE_TONES[state] || "none";
  moneyHeadEl.textContent = t("money." + state);
  const { row } = current;
  const rows = [
    ["info.swap", row.swap.escrow],
    ["info.side", () => t(row.side === "buy" ? "value.side.buy" : "value.side.sell")],
    ["info.amount.order", () => coinAmount(row)],
    ["info.date", () => (row.time ? d(row.time * 1000) : t("swap.date.unknown"))],
    ["info.network", () => t("value.network", { settlement: row.net.name, monero: row.net.monero })],
  ];
  drawInfo(swapInfoEl, rows);
  moneyEl.hidden = false;
}

// --- 4. Withdraw: refresh, build and sign, then confirm ---

// THE SAME WALLET, A FRESH BALANCE. `sync` is enough while the adapter is open; a closed adapter (the SDK closes it
// after a failed signature and after every relay) is discarded and rebuilt from the same key and plan. The returned
// value is `true` or the key of the plain line that says why not.
async function refreshBalance(swap, from) {
  // A RETRY AFTER AN INCOMPLETE SCAN MUST RUN THE SCAN AGAIN. A plain sync cannot see a spend or a block the earlier
  // pass never read, and keeping the old verdict would leave the page incomplete until the swap is reopened. Close
  // the wallet and let syncWallet restore from the swap's height, which is the pass that can return a new verdict.
  // ANOTHER START HEIGHT IS ANOTHER SCAN: the open wallet answers for the height it was restored from. `from` is the node
  // and the height Withdraw took when it was pressed.
  const { adapter, wallet } = swap;
  const incomplete = swap.balance && swap.balance.scanComplete === false;
  if (!adapter || !wallet) return syncWallet(swap, from);
  if (incomplete || from.height !== swap.height) {
    await closeWallet(swap);
    return syncWallet(swap, from);
  }
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
    // A SYNC THAT STOPPED BEHIND THE NODE IS NOT A COMPLETE VIEW. The restore above names this once; a later
    // refresh must not lose the verdict and turn a partial balance into "ready". Once the SDK has said the scan
    // was incomplete, a plain sync cannot prove otherwise (it does not read spent status or rescan the range), so
    // the incomplete verdict is kept until a full restore names a complete pass.
    const previous = swap.balance;
    let scanComplete = false;
    let scanIncompleteReason = previous && previous.scanIncompleteReason ? previous.scanIncompleteReason : "no-heights";
    try {
      const walletHeight = Number(await wallet.getHeight());
      const nodeHeight = Number(await wallet.getDaemonHeight());
      if (Number.isFinite(walletHeight) && Number.isFinite(nodeHeight)) {
        // A MATCHING HEIGHT IS NOT ENOUGH: a node that stopped advancing claims the same short tip as the wallet.
        // The plain sync used to upgrade that short chain to a complete scan; keep the same corroboration the full
        // restore uses, so a stale tip leaves the balance incomplete rather than "unseen" or "nothing".
        const tipTrusted = walletHeight >= nodeHeight && (await tipCorroborated(swap, tipHeaderHeight(nodeHeight)));
        scanComplete = walletHeight >= nodeHeight && tipTrusted;
        scanIncompleteReason = scanComplete ? null : walletHeight >= nodeHeight ? "tip-unconfirmed" : "behind-node";
      }
    } catch {
      /* no heights: the scan stays incomplete, never assumed complete */
    }
    swap.balance = {
      total,
      unlocked,
      txs,
      scanComplete,
      ...(scanIncompleteReason ? { scanIncompleteReason } : {}),
    };
    return true;
  } catch (e) {
    if (!holds(swap)) return false;
    log(t("log.wallet.closed", { words: reason(e) }), "wait");
    await closeWallet(swap);
    return syncWallet(swap, from);
  }
}

// THE TIP BLOCK'S OWN TIME says whether a node's chain can hold the swap; a node that cannot name it proves nothing.
async function tipCorroborated(swap, tipHeight) {
  if (tipHeight === null) return false;
  try {
    const tipTime = await moneroHeaderTime(swap.node, tipHeight);
    const orderTime = Number.isFinite(Number(swap.row.time)) ? Number(swap.row.time) : null;
    return tipIsTrusted({ tipTime, orderTime });
  } catch {
    return false;
  }
}

// WITHDRAW BUILDS ONE TRANSFER, for the address in the field when it is pressed. The scan belongs to the swap and is
// kept; the transfer ends with any change, and then there is no signature or no confirmation for it.
async function withdraw() {
  const swap = current;
  if (sending() || (swap && swap.building)) return false;
  quiet(withdrawErrorEl);
  dropTransfer(swap, "again");
  if (!swap || !swap.plan || !swap.contents) return say(withdrawErrorEl, "flow.err.open");
  const transfer = newTransfer(swap, destInput.value.trim());
  if (!transfer.dest) return say(withdrawErrorEl, "flow.err.dest.empty");
  // THE NODE AND THE SWAP MUST BE ON ONE NETWORK: a stagenet swap against a mainnet node finds nothing and would look
  // like an empty wallet. The node and the height are the ones chosen now, and both are closed until this ends: what
  // the page shows is what the wallet reads.
  const from = { node: nodeUrl(), height: selectedHeight(swap) };
  const answered = nodeNetwork();
  if (!answered) return say(withdrawErrorEl, "flow.err.noNode");
  if (answered !== swap.network)
    return say(withdrawErrorEl, "flow.err.networks", { swap: swap.network, node: answered });
  swap.transfer = transfer;
  swap.building = true;
  updateButtons();
  // WHY IT STOPPED is said in the swap's own step, and only while that swap is on the screen.
  const stop = (words, tone) => {
    if (swap.transfer === transfer) dropTransfer(swap, "changed");
    return say(withdrawErrorEl, words, {}, tone);
  };
  const moved = () => stop(transfer.dropped === "key" ? "flow.err.key" : "flow.err.changed", "wait");
  try {
    const refused = await refusedDestination(swap, transfer);
    // EVERY SPENDING DECISION IS TAKEN ON A FRESH BALANCE. A saved balance is a snapshot: after "locked" the outputs
    // may have matured, and after a failed signature the SDK has closed the wallet while the page still holds the
    // adapter. Refresh the wallet in place when it is still open, and rebuild it when it is not.
    const synced = refused || !holds(swap) ? refused : await refreshBalance(swap, from);
    if (!holds(swap)) return false;
    if (synced !== true) return stop(synced);
    if (swap.outcome === "unsure") swap.outcome = null;
    drawMoney();
    const m = currentState();
    if (m.state !== "ready") return stop("money." + m.state, "wait");
    if (!holds(swap, transfer)) return moved();
    showProgress(swap, "flow.progress.sign");
    const built = await buildTx(swap, transfer);
    if (!holds(swap)) return false;
    if (!holds(swap, transfer)) return moved();
    if (built !== true) return stop(built);
    drawConfirm();
    confirmEl.scrollIntoView({ block: "nearest" });
    log(t("log.next.send"));
    return true;
  } finally {
    swap.building = false;
    hideProgress(swap);
    updateButtons();
  }
}

// ADDRESS IS A PACKAGE RULE (sweep.destination): shape and network; monero-ts is not a second judge. A swap found by
// the key promised no address: the chain holds none. Returns null, or the key of the plain line that says why not.
async function refusedDestination(swap, transfer) {
  let verdict;
  try {
    verdict = await swap.core.sweep.destination({
      file: { contents: swap.contents },
      passphrase: "",
      dest: transfer.dest,
    });
  } catch (e) {
    if (holds(swap)) log(t("log.dest.refused", { words: reason(e) }), "bad");
    return "flow.err.dest";
  }
  if (!verdict.ok) {
    if (holds(swap)) log(t("log.dest.refused", { words: nameOf(verdict.reason) || "?" }), "bad");
    return "flow.err.dest";
  }
  if (holds(swap)) log(t("log.dest.accepted", { network: swap.network }));
  return null;
}

// A WALLET THAT DID NOT OPEN, said by cause: the core refused to build it, the keys do not give the swap's address,
// or the node did not serve it.
const WALLET_STOPS = {
  "bad-input": "flow.err.walletBuild",
  "wrong-chain": "flow.err.walletBuild",
  "recovery-failed": "flow.err.keys",
};

// THE HEIGHT THE PERSON CHOSE: the field wins over the plan's finder value. A blank field with no plan height is
// refused, never read as the genesis block. The wallet keeps the height it was restored from, and the node reads of
// its transfers start at the same block.
function selectedHeight(swap) {
  const typed = heightInput.value.trim();
  return typed ? Number(typed) : Number(swap.plan.restoreHeight) || 0;
}

// THE WALLET OF THE SWAP + SYNC. Returns true, or the key of the plain line that says why not; the detail is logged.
// A swap that was closed while this ran gets no wallet: one that still opened is closed here.
async function syncWallet(swap, { node, height }) {
  if (height === 0) {
    log(t("log.height.blank"), "bad");
    return "flow.err.height.blank";
  }
  if (!Number.isSafeInteger(height) || height <= 0) {
    log(t("log.height.invalid"), "bad");
    return "flow.err.height.invalid";
  }

  // KEYS ARE THE CORE'S: sweep.keys sums the key's half and the maker's REVEALED half and checks (s_a + s_b)*G.
  let keys;
  try {
    keys = await swap.core.sweep.keys({ file: { contents: swap.contents }, passphrase: "" });
  } catch (e) {
    if (holds(swap)) log(t("log.keys.failed", { words: reason(e) }), "bad");
    return "flow.err.keys";
  }
  if (!holds(swap)) return false;
  const fields = {
    privateSpendKey: keys.privateSpendKey,
    privateViewKey: keys.privateViewKey,
    primaryAddress: keys.address,
  };
  log(t("log.keys.summed"), "ok");

  // WALLET IS THE CORE'S (sweep.wallet), including network name to library enum; the page passes monero-ts and the facts.
  showProgress(swap, "flow.progress.connect");
  const adapter = swap.core.sweep.wallet({
    moneroTs: api,
    network: swap.network,
    serverUri: node,
    password: "ninsei-sweep-session",
    keys: fields,
    restoreHeight: height,
    expectedAddress: swap.plan.address,
  });
  swap.adapter = adapter;
  swap.node = node;
  swap.height = height;
  // AN OPENING THAT FAILS AFTER THE LIBRARY MADE ITS WALLET leaves that wallet open behind the adapter, with the keys: the
  // adapter is closed whatever its opening came to, unless it is the swap's.
  try {
    await adapter.connect();
  } catch (e) {
    if (holds(swap)) log(t("log.wallet.notConnected", { words: reason(e) }), "bad");
    if (swap.adapter === adapter) await closeWallet(swap);
    else await adapter.close();
    return WALLET_STOPS[e && e.code] || "flow.err.wallet";
  }
  if (swap.adapter !== adapter) {
    await adapter.close();
    return false;
  }
  const wallet = adapter.driver();
  swap.wallet = wallet;
  log(t("log.wallet.restored"), "ok");

  // A HEIGHT ABOVE THE NODE'S TIP is refused before the scan: it would read no blocks and look like a complete empty
  // balance, while the XMR is below the tip. The helper also rejects a negative or fractional field value.
  let nodeTip = null;
  try {
    nodeTip = Number(await wallet.getDaemonHeight());
  } catch (e) {
    if (holds(swap)) log(t("log.diag.failed", { why: reason(e) }), "wait");
  }
  if (!holds(swap)) return false;
  const daemonTip = tipHeaderHeight(nodeTip);
  const start = scanStartHeight(height, daemonTip);
  if (!start.ok) {
    log(t("log.height.aboveTip", { height: n(height), tip: daemonTip === null ? "?" : n(daemonTip) }), "bad");
    await closeWallet(swap);
    return "flow.err.height";
  }

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
        showProgress(swap, "flow.progress.scan", {
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
  showProgress(swap, "flow.progress.scanning", { sub: soFar });
  const ticker = setInterval(() => {
    if (swap.progress && swap.progress.sub === soFar) drawProgress();
  }, 1000);

  // THE SCAN IS THE PACKAGE'S (sweep.restore), FROM THE START BLOCK. It used to read the blocks around the
  // order's deadline first, but that window cannot see a spend made after `t1`; the SDK then reported an
  // incomplete pass while the page still showed the balance as ready. A full scan from the start block is the
  // answer the page can trust, and `restored.scanComplete` below names a pass that still did not finish.
  const t0 = performance.now();
  let restored;
  try {
    log(t("log.scan.start", { from: n(scanFrom), height: n(height) }));
    restored = await swap.core.sweep.restore({ wallet: adapter, fromHeight: height, scanBack: 10 });
  } catch (e) {
    if (holds(swap)) log(t("log.rescan.failed", { why: reason(e) }), "bad");
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
  if (!holds(swap)) return false;
  const ms = Math.round(performance.now() - t0);
  const unlocked = BigInt(restored.unlocked);
  const total = BigInt(restored.total);
  // A COMPLETE SCAN IS NOT ENOUGH IF THE NODE'S CHAIN IS TOO SHORT TO HOLD THE SWAP. The SDK compares the wallet
  // height with the height the daemon claims; a daemon that is days behind claims a matching short tip and would turn
  // a complete, empty scan into "nothing ever arrived". The tip block's own timestamp is the corroboration: it must
  // be recent, and not older than the order.
  const tipTrusted = await tipCorroborated(swap, daemonTip);
  // THE SCAN'S VERDICT TRAVELS WITH THE BALANCE. Only an explicit `true` from the SDK, corroborated by a recent tip,
  // is a completed scan: a missing verdict (an older package), a false one, and a short chain all mean the address's
  // total is unknown, never zero.
  const scanComplete = restored.scanComplete === true && tipTrusted;
  const scanIncompleteReason = scanComplete
    ? null
    : restored.scanIncompleteReason || (tipTrusted ? "scan-incomplete" : "tip-unconfirmed");
  // HOW MANY TRANSACTIONS THE WALLET SEES tells "withdrawn" (XMR came and left) from "unseen" (nothing ever came to
  // the address this key gives); a wallet that cannot say leaves it unknown.
  let txs = null;
  try {
    txs = (await wallet.getTxs()).length;
  } catch (e) {
    if (holds(swap)) log(t("log.diag.failed", { why: reason(e) }), "wait");
  }
  swap.balance = {
    total,
    unlocked,
    txs,
    scanComplete,
    ...(scanIncompleteReason ? { scanIncompleteReason } : {}),
  };
  const walletHeight = await wallet.getHeight();
  const nodeHeight = await wallet.getDaemonHeight();
  if (!holds(swap)) return false;
  log(
    t("log.restored.passes", {
      passes: n(restored.passes),
      locked: restored.lockedPass ? t("value.yes") : t("value.no"),
    }),
    "ok",
  );

  log(t("log.sync.took", { ms: n(ms), height: n(height || 0) }));
  if (!scanComplete) log(t("log.synced.incomplete", { why: nameOf(scanIncompleteReason) || "?" }), "warn");
  else if (unlocked > 0n)
    log(t("log.synced.ok", { xmr: xmr(unlocked), walletHeight: n(walletHeight), nodeHeight: n(nodeHeight) }), "ok");
  else if (total > 0n) log(t("log.synced.zero.locked", { total: xmr(total) }), "wait");
  else if (txs === 0) log(t("log.synced.unseen", { address: swap.plan.address, height: n(height) }), "warn");
  else log(t("log.synced.zero.empty", { txs: txs === null ? "?" : n(txs) }), "wait");
  return true;
}

// THE UNSPENT SET THE PACKAGE MUST SEE. `sweep.sign` compares the signed inputs with this exact list, so it is read
// from the same wallet and the same pass: unspent, unlocked and not frozen outputs are what `sweepUnlocked` may
// select. A missing or malformed key image is a refusal, never a reason to sign without the guard.
async function unspentKeyImages(wallet) {
  const outputs = await wallet.getOutputs({ isSpent: false });
  const images = [];
  for (const output of outputs) {
    if (typeof output.getIsLocked === "function" && output.getIsLocked()) continue;
    if (typeof output.getIsFrozen === "function" && output.getIsFrozen()) continue;
    const keyImage = typeof output.getKeyImage === "function" ? output.getKeyImage() : null;
    const hex = keyImage && (typeof keyImage.getHex === "function" ? keyImage.getHex() : keyImage.hex);
    if (typeof hex !== "string" || !/^[0-9a-f]{64}$/.test(hex.replace(/^0x/i, "").toLowerCase())) {
      throw pageFailure("key-image");
    }
    images.push(hex.replace(/^0x/i, "").toLowerCase());
  }
  return images;
}

// THE PAGE'S OWN READ DECIDES WHICH OUTPUTS MAY BE SPENT. The signing wallet chooses the inputs; its own output list
// cannot prove that the set it chose is the set the page's node sees. This read carries the view key, derives the key
// images from the verified funding outputs, and keeps the wallet only as the unspent filter. The SDK receives that
// page-read set at `sweep.sign` and again at `sweep.relay`, where a spent or changed output stops the send.
//
// The checkpoint is the caller-owned one from the SDK's one-read path. It is bound to the address, network and start
// height, so a second read after signing resumes instead of walking the same blocks again.
async function pageKeyImages(swap, transfer) {
  // A swap that was left has let go of what this reads: the read ends with the swap.
  const still = () => {
    if (!holds(swap)) throw pageFailure("left");
  };
  const walletImages = await unspentKeyImages(swap.wallet);
  still();
  const keys = await swap.core.sweep.keys({ file: { contents: swap.contents }, passphrase: "" });
  still();
  const addressKeys = mod.decodeAddressKeys(swap.plan.address);
  if (!Number.isSafeInteger(swap.height) || swap.height <= 0) throw pageFailure("height");
  const read = await swap.core.swaps.readRecovery({
    node: swap.node,
    address: swap.plan.address,
    viewSecret: keys.privateViewKey,
    spendPub: addressKeys.spendPub,
    fromHeight: swap.height,
    network: swap.network,
    // A node read that cannot see the whole range cannot prove an unspent set.
    keyImages: walletImages,
    // THE PAGE'S OWN TRANSPORT. The facade is built with `noService` so its other routes cannot call a host; this
    // read is the one place where the chosen node is asked directly.
    fetch: globalThis.fetch,
    onProgress: (event) => {
      if (!holds(swap, transfer)) return;
      const total = Number(event && event.blocksTotal);
      const done = Number(event && event.blocksVerified);
      const fraction = Number.isFinite(total) && total > 0 && Number.isFinite(done) ? Math.min(1, done / total) : null;
      showProgress(swap, "flow.progress.scan", {
        fraction,
        sub:
          Number.isFinite(total) && total > 0 ? () => t("flow.progress.blocks", { at: n(done), end: n(total) }) : null,
      });
    },
    checkpoint: {
      read: () => swap.checkpoint,
      save: (record) => {
        swap.checkpoint = record;
      },
      discard: () => {
        swap.checkpoint = null;
      },
    },
  });
  if (!read || read.complete !== true) throw pageFailure("node-read");
  const spent = new Set((read.spends || []).map((spend) => String(spend.keyImage || "").toLowerCase()));
  const outputs = [];
  for (const transfer of read.transfers || []) {
    if (transfer.pool || transfer.locked || (transfer.unlock && transfer.unlock.locked)) continue;
    if (Number(transfer.confirmations) < 1) continue;
    for (const output of transfer.outputs || []) {
      if (output.amountVerified !== true || output.amountAtomic === null || output.amountAtomic === undefined) continue;
      outputs.push(output);
    }
  }
  still();
  const fromNode = await swap.core.sweep.keyImages({ keys, arrival: { outputs } });
  const available = new Set(walletImages);
  return fromNode
    .map((entry) => (typeof entry === "string" ? entry : entry.keyImage))
    .map((image) => String(image).replace(/^0x/i, "").toLowerCase())
    .filter((image) => available.has(image) && !spent.has(image));
}

// BUILD AND SIGN, NOT SEND. Returns true, or the key of the plain line that says why not. A transfer that was dropped
// while the node was read is not signed, and a signature that returns for one that was dropped is dropped too.
async function buildTx(swap, transfer) {
  // SIGNING IS THE CORE'S (sweep.sign): plan -> wallet -> sync -> unlocked balance -> signature WITHOUT sending.
  // An empty balance stops with `insufficient-funds` BEFORE signing, on the SAME wallet scanned above.
  let signed;
  try {
    const keyImages = await pageKeyImages(swap, transfer);
    if (!holds(swap, transfer)) return "flow.err.changed";
    signed = await swap.core.sweep.sign({
      file: { contents: swap.contents },
      passphrase: "",
      to: transfer.dest,
      keyImages,
      maxFeeAtomic: SWEEP_FEE_LIMIT_ATOMIC,
      // THE SAME ADAPTER THE RESTORE USED. A second adapter for the same wallet would not carry the scan verdict,
      // and 0.62 refuses to sign without a completed restore on this exact adapter.
      wallet: swap.adapter,
    });
  } catch (e) {
    if (!holds(swap)) return false;
    log(t("log.sign.stopped", { words: reason(e) }), "bad");
    // A FEE REFUSAL IS THE PERSON'S NEXT DECISION, not a generic "could not build": name it on the step.
    if (e && (e.code === "sweep-fee-too-high" || e.code === "sweep-fee-unknown")) return "sdk." + e.code;
    return "flow.err.sign";
  }
  if (!holds(swap, transfer)) return "flow.err.changed";
  // FEE AND RECEIVE COME FROM sweep.sign. The whole unlocked balance is withdrawn, so the fee is subtracted and
  // `receive` is what arrives; a missing fee is null, shown as "unknown", never as zero.
  transfer.token = signed.token;
  transfer.amount = BigInt(signed.amount);
  transfer.fee = signed.fee;
  transfer.receive = signed.receive;
  log(t("log.signed", { token: transfer.token }));
  return true;
}

function explorerLink(network, id) {
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

// THE CONFIRMATION: drawn from the open swap's signed transfer, so a language change keeps its numbers and addresses.
const receives = ({ receive }) => (receive === null ? t("value.receive.unknown") : xmr(BigInt(receive)) + " XMR");
function drawConfirm() {
  const transfer = current && current.transfer;
  const signed = Boolean(transfer && transfer.token);
  confirmEl.hidden = !signed;
  if (!signed) return;
  const { amount, fee, receive, dest } = transfer;
  drawInfo(txInfoEl, [
    ["info.amount", t("value.amount", { xmr: xmr(amount) })],
    ["info.fee", fee === null ? t("value.fee.unknown") : xmr(BigInt(fee)) + " XMR", fee === null ? "warn" : ""],
    ["info.receive", receives(transfer), receive === null ? "warn" : "good"],
    ["info.recipient", dest],
  ]);
}

// CONFIRM GIVES THE NODE THE TRANSFER ON THE SCREEN, OR NOTHING. The press holds the transfer it was made for; the
// node is read again, and only if the press still holds is that transfer given. From then until the answer nothing
// newer can be started, and the attempt stands in the results. A press that was dropped meanwhile has already been said
// as not sent (dropTransfer), and its end touches nothing.
async function sendTx() {
  const swap = current;
  const transfer = swap && swap.transfer;
  if (transfer && transfer.pressed) return false;
  quiet(withdrawErrorEl);
  if (!transfer || !transfer.token) {
    log(t("log.nothing.toSend"), "bad");
    return say(withdrawErrorEl, "flow.err.send");
  }
  transfer.pressed = true;
  showProgress(swap, "flow.progress.check");
  updateButtons();
  const moved = () => {
    if (swap !== current || swap.transfer !== transfer) return false;
    dropTransfer(swap, "changed");
    return say(withdrawErrorEl, "flow.err.changed", {}, "wait");
  };
  if (!holds(swap, transfer)) return moved();
  // NOTHING WAS GIVEN, SO NOTHING WAS SENT: the confirmation stays, and Confirm can be pressed again.
  const unsent = (e, result) => {
    log(t("log.send.failed", { words: reason(e) }), "bad");
    if (result) endResult(result, "unsent", { why: "check" });
    else record(transfer, "unsent", "check");
    transfer.pressed = transfer.given = false;
    hideProgress(swap);
    drawSwaps();
    updateButtons();
    return say(withdrawErrorEl, "flow.err.send");
  };
  let freshImages;
  try {
    // THE RELAY CHECK READS THE NODE AGAIN. The signed bytes cannot change, but the page's view can: a fresh list
    // that differs from the signed inputs keeps the session open and sends nothing. The checkpoint resumes the read.
    freshImages = await pageKeyImages(swap, transfer);
  } catch (e) {
    return holds(swap, transfer) ? unsent(e) : moved();
  }
  if (!holds(swap, transfer)) return moved();
  showProgress(swap, "flow.progress.send");
  transfer.given = true;
  const result = record(transfer, "given");
  drawSwaps();
  updateButtons();
  // SENDING IS THE CORE'S (sweep.relay). Its "withdrawn" mark for a service meets `noService` and goes nowhere.
  const relay = swap.core.sweep.relay({ token: transfer.token, keyImages: freshImages }).then(
    (out) => ({ txids: txIds(out && out.txids) }),
    (error) => ({ error, txids: txIds(error && error.params && error.params.txids) }),
  );
  const answer = await Promise.race([relay, after(RELAY_LIMIT_MS)]);
  if (!answer) {
    // NO ANSWER IS UNKNOWN, NOT NOT-SENT. What can be started opens again, and nothing is sent by itself; an answer that
    // still comes ends its own result.
    log(t("log.send.silent", { minutes: n(RELAY_LIMIT_MS / 60_000) }), "bad");
    endResult(result, "unknown");
    unsure(swap);
    // A SUCCESS THAT COMES LATE ends the swap it belongs to, if that is still the one that is open, and with it whatever
    // of it contradicts the success: a newer confirmation, a Withdraw or a Confirm that is running, the warning, the
    // key. What a person has started since is theirs: another swap or key, or a newer transfer the node already has.
    relay.then(({ error, txids }) => {
      log(t(error ? "log.send.unknown" : "log.sent", { words: reason(error), txids: txids.join(", ") || "?" }));
      endResult(result, error ? "unknown" : "sent", { txids });
      if (error || !holds(swap) || sending()) return;
      closeSwap("sent");
      forgetKey();
    });
    return say(withdrawErrorEl, "flow.err.sendUnknown");
  }
  const { error, txids } = answer;
  // THE CORE REFUSES BY A NAME BEFORE IT GIVES ANYTHING (a token or an input set that does not fit); from the moment
  // it gives the transfer its only answer is `sweep-relay-unknown`. An error without a name is not proof of either.
  if (error && typeof error.code === "string" && error.code !== "sweep-relay-unknown") return unsent(error, result);
  if (error) {
    // THE NODE MAY HAVE ACCEPTED THE TRANSACTION. A definite "not sent" would be false, and a second Confirm would use a
    // session that no longer exists. Drop it, leave the wallet for a fresh balance check, and ask the person to look.
    log(t("log.send.unknown", { words: reason(error), txids: txids.join(", ") || "?" }), "bad");
    endResult(result, "unknown", { txids });
    unsure(swap);
    return say(withdrawErrorEl, "flow.err.sendUnknown");
  }
  log(t("log.sent", { txids: txids.join(", ") }), "ok");
  endResult(result, "sent", { txids });
  // THE WALLET IS EMPTY NOW: the button would only sign for zero. The keys have done their job, so they leave the
  // tab's memory at once instead of waiting for the tab to close; the result and the txid stay.
  swap.outcome = "sent";
  finishTransfer(swap);
  drawMoney();
  await dropKeys(swap);
  log(t("log.done"), "ok");
  return true;
}

// LONGER THAN THE WALLET LIBRARY'S OWN REQUEST LIMIT (180 s), so its answer comes first when it gives one.
const RELAY_LIMIT_MS = 240_000;
const after = (ms) => new Promise((resolve) => setTimeout(resolve, ms, null));

// WHETHER IT WAS SENT IS NOT KNOWN: neither is what the wallet holds, until it is read again.
function unsure(swap) {
  swap.outcome = "unsure";
  finishTransfer(swap);
  drawMoney();
}

// THE NODE'S ANSWER, OR ITS ABSENCE, ENDS THE TRANSFER: what can be started opens again.
function finishTransfer(swap) {
  swap.transfer = null;
  drawConfirm();
  hideProgress(swap);
  drawSwaps();
  updateButtons();
}

// THE WALLET OF ONE SWAP CLOSES and the node choice opens again; a failed close must not keep the rest in memory. The
// swap lets go of it first, so a step of that swap that is still running cannot use it.
async function closeWallet(swap) {
  const { adapter } = swap;
  swap.adapter = null;
  swap.wallet = null;
  swap.checkpoint = null;
  updateButtons();
  try {
    if (adapter) await adapter.close();
  } catch {
    /* the keys go either way */
  }
}

// A SWAP THAT IS LEFT KEEPS ITS ROW AND NOTHING ELSE: its key, its payload, its facade with every signed session, and its
// wallet go, so a step of it that is still running has nothing left to use. Its wallet closes behind it.
function leaveSwap(swap) {
  closeWallet(swap);
  const { row, settlement, network } = swap;
  for (const name of Object.keys(swap)) swap[name] = null;
  Object.assign(swap, { row, settlement, network });
}

// ANOTHER SWAP OR ANOTHER KEY: the open swap ends here, at once. Its transfer is dropped and the step is back to "choose a
// swap". The key and the list stay: the person is choosing among them.
function closeSwap(why = "left") {
  const swap = current;
  if (!swap) return;
  dropTransfer(swap, why);
  current = null;
  leaveSwap(swap);
  stepSwap.hidden = true;
  stepTransfer.hidden = true;
  drawEth();
  quiet(ethErrorEl);
  moneyEl.hidden = true;
  confirmEl.hidden = true;
  quiet(openErrorEl);
  quiet(withdrawErrorEl);
  drawProgress();
  destInput.value = "";
  heightInput.value = "";
  heightBox.hidden = true;
  drawSwaps();
  updateButtons();
}

// THE KEYS LEAVE WITH THE TRANSFER: the swap's wallet closes, and the recovery key and the swap's payload go. The
// result and the txid stay; the list goes with the key, since every action in it needs the key. The key is this
// swap's: no other could be read while the node held the transfer. Words typed before that are another key's, and stay.
// What the step still shows of the swap (its address, its amounts) stays on the screen.
async function dropKeys(swap) {
  const closing = closeWallet(swap);
  Object.assign(swap, { key: null, core: null, contents: null });
  forgetKey();
  await closing;
  log(t("log.forgotten"), "ok");
}
function forgetKey() {
  key = null;
  search = null;
  say(keyErrorEl, "key.gone", {}, "wait");
  drawSwaps();
  updateButtons();
}

// --- 0c. Node: a checked list of the listed nodes, the page's pick or the person's choice among them ---
// The choice can change BEFORE the wallet exists; afterwards it would be a different wallet, so it cannot.
//
// WHAT THE CHECK SENDS: each listed node is asked for `get_info`, which tells it only that a visitor asked for
// its height. The recovery file, the password and the keys never leave the tab.
const nodeList = $("nodeList");
const nodeNote = $("nodeNote");
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

// ONE ENTRY PER ROW: the listed nodes in list order. `answer` is the faster of two probeMoneroNode results, null
// while the page is asking; `ask` numbers the requests, so an answer to an older round is dropped.
const listed = NODES.map((url) => ({ url, network: nodeNetworkOf(url), answer: null, ask: 0, el: null, radio: null }));
let note = null; // [key, params] of the line under the list

function nodeLocked() {
  return Boolean(current && (current.building || current.adapter));
}

function rowFor(url) {
  return listed.find((row) => row.url === url) || null;
}

function verdictOf(row) {
  const network = row.network;
  const peers = listed.filter((peer) => peer.network === network);
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
    nodeList.append(row.el);
  }
}

// A ROW IS DRAWN FROM ITS ANSWER, so a language change or a new answer elsewhere (a new median) redraws it.
function drawRows() {
  for (const row of listed) {
    const verdict = verdictOf(row);
    row.el.dataset.state = verdict.state;
    let why = "";
    if (verdict.why) {
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

// THE RADIOS SHOW THE MODULE'S CHOICE.
function markChoice(url) {
  for (const row of listed) row.radio.checked = row.url === url;
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

function chooseListed(url) {
  if (nodeLocked()) {
    markChoice(nodeUrl());
    drawNote();
    return;
  }
  setNodeUrl(url);
  markChoice(url);
  note = null;
  drawNote();
  checkEnvironment();
}

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
  // ONLY THE CHOSEN NODE IS ASKED AGAIN. Probing every listed node on a tab return tells three unrelated operators
  // the visitor is back, and the choice itself does not need their answers.
  const row = rowFor(nodeUrl());
  if (row) await pingRows([row]);
  if (nodeLocked()) return;
  if (stateOf(nodeUrl()) !== before) checkEnvironment();
}

// THE FIRST CHOICE: this tab's earlier choice is taken at once; otherwise the default listed node is used WITHOUT
// probing the others. The chosen node is checked by the preflight, and the list is there for a person who wants a
// different one.
async function startNode() {
  buildRows();
  if (nodeSource() === "tab") {
    markChoice(nodeUrl());
    note = null;
    drawRows();
    drawNote();
    await runPreflight({ probeNode: false });
    return;
  }
  const url = DEFAULT_NODE;
  setNodeUrl(url, { remember: false, by: "default" });
  markChoice(url);
  note = ["node.note.default", { host: nodeHost(url) }];
  drawRows();
  drawNote();
  await runPreflight({ probeNode: false });
}

// ONE CHECK AT A TIME COUNTS: a person who clicks through the rows gets the answer for the last one. The wallet is
// loaded once; a change of node asks only the node.
let preflightRun = 0;
let announced = false;
async function runPreflight({ probeNode = true } = {}) {
  const mine = ++preflightRun;
  const isCurrent = () => mine === preflightRun;
  searchReady = false;
  updateButtons();
  // ISOLATION IS NOT A REQUIREMENT. monero-ts 0.11.20 has no pthreads and needs no SharedArrayBuffer; the headers
  // are still served when the host has them, and the diagnostics report the fact. WebCrypto needs a secure context.
  setCheck("secure", self.isSecureContext ? "ok" : "bad", () => t("preflight.fail.https"));
  if (!probeNode) setCheck("node", "idle");
  const [walletOk, nodeOk] = await Promise.all([checkWallet(), probeNode ? checkNode() : Promise.resolve(true)]);
  if (!isCurrent()) return false;
  const ready = walletOk && nodeOk && self.isSecureContext;
  // THE SEARCH NEEDS THE SDK AND THE BROWSER'S CRYPTO, NOT THE NODE: a key can be read and its swaps listed while the
  // person still picks a node. The withdrawal checks the node itself.
  searchReady = walletOk && self.isSecureContext;
  updateButtons();
  if (ready && !announced) {
    announced = true;
    log(t("log.ready"));
  }
  return ready;
}
function checkEnvironment() {
  return runPreflight().catch((e) => log(reason(e), "bad"));
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

keyFileInput.addEventListener("change", onKeyFileChosen);
findSwapsBtn.addEventListener("click", findKeySwaps);
keyMoreEl.addEventListener("click", () => findKeySwaps({ more: true }));
withdrawBtn.addEventListener("click", () => step(withdraw, withdrawErrorEl));
sendBtn.addEventListener("click", () => step(sendTx, withdrawErrorEl));
ethConnectBtn.addEventListener("click", () => step(ethConnect, ethErrorEl));
ethSendBtn.addEventListener("click", () => step(ethSend, ethErrorEl));

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
  .catch((e) => log(t("log.error", { message: reason(e) }), "bad"));
findSwapsBtn.disabled = true;
