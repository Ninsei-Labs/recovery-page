// A CHECK OF THE RECOVERY PAGE'S LIVE ENVIRONMENT (a technical report, not the withdrawal interface).
//
// Why a separate page: the recovery page's origin has its own policy (a CSP with a strict script-src - 'unsafe-eval' is
// gone now that monero-ts is 0.11.16 - plus COOP/COEP and a worker) and its own way to the node (our proxy),
// and when a transfer does not go it has to be clear what broke. The checks are the ones the withdrawal page
// runs before work, but verbose and with measurements.
//
// THE WORDS ARE DATA (locales/<tag>/): a step is named by a KEY and its detail is a draw function, so a
// language change redraws the report from the same measurements instead of leaving half the lines behind.
//
// What the page does NOT do: it accepts no secrets, prints no mnemonic (the wallet is created with a random
// seed inside and never shown) and sends no transactions.

import { t, n, bindValues, init as initLocale } from "./locales/index.js?v=0.2.0";
import { nodeUrl, nodeLabelKey, nodeLabelParams, setNodeUrl, networkFromNode } from "./lib/node.js?v=0.2.0";

// The node address comes from the shared module: the field on the page, the `?node=` link, this tab's value or
// the default. nodeInfo is what the node answered on the first successful call: height and network. The wallet
// is built for that network, otherwise the probe asks a stagenet node for another chain's ranges and that
// looks like a broken withdrawal.
let nodeInfo = null;
const BUNDLE = "./assets/vendors/monero/monero-ts-browser.js?v=cf687c3e";
const WORKER = "./monero.worker.js?v=fd2e8b51";
const SCAN_LOOKBACK = 3000;

const out = document.getElementById("out");
const stateEl = document.getElementById("state");
const rerunBtn = document.getElementById("rerun");
const scanBtn = document.getElementById("scan");
const nodeInput = document.getElementById("node");

if (nodeInput) {
  nodeInput.value = nodeUrl();
  nodeInput.addEventListener("change", () => {
    const parsed = setNodeUrl(nodeInput.value);
    if (!parsed.ok) {
      nodeInput.value = nodeUrl();
      out.textContent = String(t("log.node.bad", { why: t("node.why." + parsed.why) }));
      return;
    }
    location.reload();
  });
}

// CSP violations are collected from the start: the page running under its own policy is the best way to learn
// that the policy blocks something. Otherwise the console would have to be read by hand.
const violations = [];
document.addEventListener("securitypolicyviolation", (e) => {
  violations.push(`${e.violatedDirective} <- ${e.blockedURI || "(inline)"}`);
  render();
});

const results = [];
window.__diag = { results, violations, done: false, failed: 0 };

const now = () => performance.now();

// A STEP DETAIL IS A DRAW FUNCTION: the measurements are collected here, the words are taken at draw time.
const words = (value) => (typeof value === "function" ? String(value())
  : (typeof value === "string" ? value : JSON.stringify(value ?? "")));

function render() {
  out.textContent = results
    .map((r) => {
      const mark = r.error
        ? t("diag.mark.error")
        : r.unproven
        ? t("diag.mark.unproven")
        : r.ms != null
          ? r.ms < 3000
            ? t("diag.mark.ms", { value: n(Math.round(r.ms)) })
            : t("diag.mark.s", { value: n(r.ms / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })
          : t("diag.mark.ok");
      const flag = r.unproven ? "—" : r.ok === false ? "✗" : "✓";
      const name = typeof r.step === "string" ? t(r.step) : t(r.step.key, r.step.params);
      return `${flag} ${name.padEnd(46)} ${mark.padStart(9)}  ${words(r.detail)}${r.error ? "  " + r.error : ""}`;
    })
    .join("\n");
}

// A LANGUAGE CHANGE REDRAWS THE REPORT: steps and details are stored as keys and data.
document.addEventListener("i18n:applied", render);

// THE WALLET PATH AGAINST A NODE REFUSAL. In createTx the library asks the node for the hard fork height
// (hard_fork_info) and headers (get_block_headers_range) BEFORE the balance check, so a node refusal comes out
// as a RAW library error ("Failed to get earliest fork height") instead of the expected "not enough money".
// That is not a broken path - the node did not answer and there is nothing to measure. What separates them is
// not a substring in someone else's text but REPEATING the same node calls from this page: the node answers -
// the path broke (red); the node refuses - "not measured".
class NodeUnproven extends Error {}
async function nodeRefusedItsCalls() {
  const refused = [];
  for (const body of [
    { method: "hard_fork_info" },
    { method: "get_block_headers_range", params: { start_height: 1, end_height: 1 } },
  ]) {
    try {
      const r = await fetch(nodeUrl() + "/json_rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "0", ...body }),
      });
      const j = r.ok ? await r.json().catch(() => null) : null;
      if (!r.ok) refused.push(body.method + " -> HTTP " + r.status);
      else if (j && j.error) refused.push(body.method + " -> " + JSON.stringify(j.error));
    } catch (e) {
      refused.push(body.method + " -> " + String((e && e.message) || e));
    }
  }
  return refused;
}

const push = (step, extra = {}) => {
  if (extra.error) window.__diag.failed++;
  results.push({ step, ok: !extra.error && !extra.unproven, ...extra });
  render();
};

// Each step is written at once: if the next one throws, the numbers already collected survive.
async function measure(step, fn) {
  const t0 = now();
  try {
    const detail = await fn();
    push(step, { ms: now() - t0, detail });
    return detail;
  } catch (e) {
    // "Not measured" is its own outcome: it does not paint the run red and does not hide inside "ok". It marks a
    // step the path never reached because of a node refusal (see nodeRefusedItsCalls), not because of code.
    if (e instanceof NodeUnproven) push(step, { ms: now() - t0, unproven: true, detail: () => String((e && e.message) || e) });
    else push(step, { ms: now() - t0, error: String((e && e.message) || e) });
    return null;
  }
}

const resources = () =>
  performance
    .getEntriesByType("resource")
    .filter((r) => /monero|worker/.test(r.name))
    .map((r) => t("diag.detail.resource", { name: r.name.split("/").pop(),
      kb: n(Math.round((r.transferSize || r.decodedBodySize || 0) / 1024)), ms: n(Math.round(r.duration)) }))
    .join(" | ");

async function quickCheck() {
  results.length = 0;
  violations.length = 0;
  window.__diag.done = false;
  window.__diag.failed = 0;
  stateEl.textContent = t("diag.state.running");
  stateEl.className = "wait";
  rerunBtn.disabled = true;
  scanBtn.disabled = true;

  let moneroTs = null;
  let wallet = null;

  push("diag.step.env", {
    detail: () => t("diag.detail.env", {
      origin: location.origin,
      isolation: self.crossOriginIsolated,
      sab: typeof SharedArrayBuffer !== "undefined",
      secure: self.isSecureContext,
      cores: navigator.hardwareConcurrency ?? null,
      memory: navigator.deviceMemory ? navigator.deviceMemory * 1024 : null,
    }),
  });

  await measure("diag.step.bundle", async () => {
    const mod = await import(BUNDLE);
    window.__moneroTs = mod;
    moneroTs = mod;
    return () => t("diag.detail.bundle", { version: mod.getVersion(), exports: n(Object.keys(mod).length), defaults: n(Object.keys(mod.default).length) });
  });
  if (!moneroTs) return finish(null);
  const api = moneroTs.default;

  await measure({ key: "diag.step.worker", params: { path: WORKER.split("?")[0] } }, async () => {
    const r = await fetch(WORKER, { method: "GET" });
    const buf = await r.arrayBuffer();
    if (r.status !== 200) throw new Error(t("diag.error.http", { status: r.status }));
    // If the file is missing, the SPA fallback serves index.html (~5 KB) - that is the "not built" sign.
    if (buf.byteLength < 1_000_000) throw new Error(t("diag.error.worker", { bytes: n(buf.byteLength) }));
    return () => t("diag.detail.mb", { mb: n(buf.byteLength / 1048576, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) });
  });

  await measure("diag.step.worker.path", async () => {
    api.LibraryUtils.setWorkerDistPath(WORKER);
    return () => t("diag.detail.worker.path", { path: WORKER });
  });

  // --- the node proxy: without it the wallet does not sync ---------------------------------------
  await measure("diag.step.node", async () => {
    const r = await fetch(nodeUrl() + "/json_rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "0", method: "get_info" }),
    });
    const j = await r.json();
    if (r.status !== 200 || !j.result?.height) throw new Error(t("diag.error.http", { status: r.status }));
    nodeInfo = j.result;
    if (window.__diag) window.__diag.nodeInfo = j.result;
    const info = j.result;
    return () => t("diag.detail.node", { status: r.status, node: t(nodeLabelKey(), nodeLabelParams()), height: n(info.height),
      sync: info.synchronized, nettype: info.nettype });
  });

  for (const [path, stepKey] of [
    ["/getblocks.bin", "diag.step.path.blocks"],
    ["/gethashes.bin", "diag.step.path.hashes"],
  ]) {
    await measure({ key: stepKey, params: { path } }, async () => {
      const r = await fetch(nodeUrl() + path, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array([1, 0, 0, 0, 8, 0, 0, 0]),
      });
      // WHAT THIS LINE DOES NOT MEAN. A deliberately truncated body is sent, so any answer other than 404/403 only
      // means the path IS PROXIED. Whether sync works through it is shown by the sync() check below, not by this
      // one. Do not read this line as proof that a withdrawal works.
      if (r.status === 404 || r.status === 403) throw new Error(t("diag.error.path", { status: r.status }));
      return () => t("diag.detail.http", { status: r.status });
    });
  }

  // --- the wallet -------------------------------------------------------------------------------
  let walletRestoreFrom = 0;
  await measure("diag.step.wallet", async () => {
    // The network comes FROM THE NODE, and the wallet starts from a recent height: a full-chain scan takes tens of
    // hours, and a wallet on the wrong network simply finds no block hashes. A mainnet probe against a stagenet
    // node already looked like a breakage once.
    const net = networkFromNode(nodeInfo);
    const tip = nodeInfo && nodeInfo.height ? nodeInfo.height : 0;
    // The wallet is made LIKE A REAL withdrawal: its own seed plus a recent restore height. The library forbids
    // restoreHeight on a random wallet without a seed ("Cannot provide restoreHeight when creating random
    // wallet"), so the seed is created explicitly. Restoring from the payout height is not an optimisation but a
    // condition of work: a full-chain scan in a browser runs for tens of hours.
    const keys = await moneroTs.createWalletKeys({ networkType: net });
    const seed = await keys.getSeed();
    walletRestoreFrom = tip > 300 ? tip - 300 : 1;
    wallet = await moneroTs.createWalletFull({
      networkType: net,
      seed,
      server: { uri: nodeUrl(), rejectUnauthorized: false },
      password: "diag",
      restoreHeight: walletRestoreFrom,
    });
    window.__wallet = wallet;
    return () => t("diag.detail.wallet");
  });

  if (wallet) {
    await measure("diag.step.heights", async () => {
      const [h, dh, bal] = [await wallet.getHeight(), await wallet.getDaemonHeight(), await wallet.getBalance()];
      return () => t("diag.detail.heights", { own: n(h), node: n(dh), balance: n(bal) });
    });

    await measure("diag.step.sync", async () => {
      const t0 = now();
      await wallet.sync();
      const ms = Math.round(now() - t0);
      const height = await wallet.getHeight();
      return () => t("diag.detail.sync", { ms: n(ms), height: n(height) });
    });

    await measure("diag.step.sign", async () => {
      const addr = await wallet.getAddress(0, 0);
      const sig = await wallet.signMessage("ninsei-recovery-check", addr);
      let verified = null;
      try {
        verified = JSON.stringify(await wallet.verifyMessage("ninsei-recovery-check", addr, sig));
      } catch (e) {
        verified = () => t("diag.detail.sign.failed", { why: String((e && e.message) || e).slice(0, 60) });
      }
      return () => t("diag.detail.sign", { len: n(sig.length), verified: verified === null ? t("diag.detail.sign.unchecked") : words(verified) });
    });

    // ON AN EMPTY WALLET THE BUILD MUST FAIL FOR LACK OF FUNDS - that is the success: the path reached the balance
    // check. "not enough money" is the expected branch, not an error. What stays RED:
    //   * the wallet built a transaction anyway - so there is no balance check on the path;
    //   * the library failed DIFFERENTLY while the node answers - the path broke before the check;
    //   * a node refusal on ITS OWN calls - not a broken path but "not measured" (nodeRefusedItsCalls).
    await measure("diag.step.tx", async () => {
      const addr = await wallet.getAddress(0, 0);
      let failure = null;
      try {
        await wallet.createTx({ accountIndex: 0, address: addr, amount: 1_000_000_000_000n });
      } catch (e) {
        failure = e;
      }
      if (!failure) throw new Error(t("diag.error.tx.built"));
      const msg = String((failure && failure.message) || failure);
      if (/not enough money/i.test(msg)) return () => t("diag.detail.tx.expected", { message: msg });
      const refused = await nodeRefusedItsCalls();
      if (refused.length) throw new NodeUnproven(t("diag.error.node.refused", { list: refused.join("; "), message: msg }));
      throw failure;
    });

    await measure("diag.step.validate", async () => {
      // The network comes from the node. A stagenet address checked as mainnet is refused with "Invalid address",
      // which looks like a broken validator while the probe was wrong: the chains have different address prefixes.
      const net = api.MoneroNetworkType[String(networkFromNode(nodeInfo)).toUpperCase()];
      const own = await wallet.getAddress(0, 0);
      await api.MoneroUtils.validateAddress(own, net);
      let corrupted = null;
      try {
        await api.MoneroUtils.validateAddress(own.slice(0, -1) + (own.endsWith("1") ? "2" : "1"), net);
        corrupted = () => t("diag.detail.validate.accepted");
      } catch (e) {
        corrupted = () => t("diag.detail.validate.rejected", { why: String(e.message || e).slice(0, 40) });
      }
      return () => t("diag.detail.validate", { corrupted: words(corrupted) });
    });

    await measure("diag.step.wasm", async () => {
      const used = api.LibraryUtils.getWasmMemoryUsed();
      return () => (Number.isFinite(used) ? t("diag.detail.mb", { mb: n(Math.round(used / 1048576)) }) : t("diag.detail.wasm.none"));
    });
  }

  finish(wallet);
}

function finish(wallet) {
  push("diag.step.csp", {
    detail: () => (violations.length ? t("diag.detail.csp.some", { count: n(violations.length), list: violations.slice(0, 3).join("; ") }) : t("diag.detail.csp.none")),
    ok: violations.length === 0,
  });
  push("diag.step.resources", { detail: () => resources() });
  push("diag.step.total", { detail: () => t("diag.detail.total", {
    checks: n(results.length) + " " + t("diag.plural.checks", { count: results.length, }),
    errors: n(window.__diag.failed) + " " + t("diag.plural.errors", { count: window.__diag.failed }),
  }) });
  stateEl.textContent = window.__diag.failed ? t("diag.state.done.failed", { count: n(window.__diag.failed) }) : t("diag.state.done.ok");
  stateEl.className = window.__diag.failed ? "bad" : "ok";
  rerunBtn.disabled = false;
  scanBtn.disabled = false;
  window.__diag.done = true;
  document.title = window.__diag.failed ? t("diag.doc.title.failed") : t("diag.doc.title.ok");
}

// The scan measurement is separate and on a button: it takes minutes, and "does it work at all" is visible
// without it.
async function scanCheck() {
  scanBtn.disabled = true;
  rerunBtn.disabled = true;
  stateEl.textContent = t("diag.state.scan.running");
  stateEl.className = "wait";
  const moneroTs = window.__moneroTs;
  if (!moneroTs) {
    push("diag.step.scan", { error: t("diag.error.scan.bundle") });
    scanBtn.disabled = false;
    rerunBtn.disabled = false;
    return;
  }
  await measure({ key: "diag.step.scanBlocks", params: { blocks: n(SCAN_LOOKBACK) } }, async () => {
    // The network comes from the node: measuring on another network would measure the wrong scan (and fail on the
    // hash lookup).
    const net = networkFromNode(nodeInfo || (window.__diag && window.__diag.nodeInfo));
    const keys = await moneroTs.createWalletKeys({ networkType: net });
    const seed = await keys.getSeed();
    // The first pass only needs to learn the node height.
    const probe = await moneroTs.createWalletFull({ networkType: net, seed, server: { uri: nodeUrl() }, password: "diag", restoreHeight: 0 });
    const daemonHeight = await probe.getDaemonHeight();
    await probe.close();
    const from = Math.max(1, daemonHeight - SCAN_LOOKBACK);
    const w = await moneroTs.createWalletFull({ networkType: net, seed, server: { uri: nodeUrl() }, password: "diag", restoreHeight: from });
    const t0 = now();
    await w.sync();
    const ms = now() - t0;
    const height = await w.getHeight();
    await w.close();
    return () => t("diag.detail.scan", { from: n(from),
      sec: n(ms / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
      height: n(height), rate: n(Math.round((SCAN_LOOKBACK / ms) * 1000)) });
  });
  push("diag.step.reminder", { detail: () => t("diag.reminder") });
  stateEl.textContent = t("diag.state.scan.done");
  stateEl.className = "ok";
  scanBtn.disabled = false;
  rerunBtn.disabled = false;
}

rerunBtn.addEventListener("click", () => quickCheck().catch((e) => push("diag.step.fatal", { error: String((e && e.message) || e) })));
scanBtn.addEventListener("click", () => scanCheck().catch((e) => push("diag.step.fatal.scan", { error: String((e && e.message) || e) })));

scanBtn.disabled = true;
// THE WORKER PATH IN THE LEGEND TEXT COMES FROM THE SAME PLACE AS THE REQUEST (WORKER): the words hold
// {workerPath} and the value comes from code. A link to a built file without ?v=<hash> turns the asset version
// check red, and rightly so: a second copy of the path would drift from the real one.
bindValues({ workerPath: WORKER.split("?")[0] });
// THE LANGUAGE LOADS BEFORE THE FIRST STEP: step names and markup labels come from the loaded language.
initLocale()
  .catch(() => { /* the language did not load: the report shows step keys, which is visible */ })
  .then(() => quickCheck())
  .catch((e) => push("diag.step.fatal", { error: String((e && e.message) || e) }))
  .finally(() => {
    window.__diag.done = true;
    scanBtn.disabled = false;
  });
