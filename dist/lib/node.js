// WHERE THE PAGE FINDS A MONERO NODE: ONLY IN ITS OWN LIST.
//
// The page holds the twelve words in memory, so it talks to no host it does not name. The node is one of the listed
// nodes below, nothing else:
//
//   1. the person's choice among the rows, kept for this tab (sessionStorage);
//   2. otherwise the first listed node, and for a stagenet swap the project's stagenet node (`nodeFor`).
//
// No link and no field adds a node. The page's Content-Security-Policy is built from this list and the settlement
// RPCs (deploy/http-policy.mjs), so the browser itself refuses every other host, an injected script's requests
// included: the page's own checks cannot stop code that is not the page's.
//
// AN OPERATOR WHO SERVES THEIR OWN COPY lists their node here and builds again; the policy follows the list.
//
// WHAT A NODE MUST DO to serve this page: answer the wallet's paths (`/json_rpc`, `/getblocks.bin`,
// `/gethashes.bin`, `/get_blocks.bin`) and allow the page's origin in CORS, including the
// `Content-Type: application/json` header monero-ts sends. A node without CORS fails in the browser,
// not on the wire, and the page reports that as a node that does not answer.
//
// NOTHING SECRET LIVES HERE. A node address is public by nature; the wallet's keys never leave the tab.

import { nameOf, pageFailure } from "./reason.js?v=0.4.5";

// THE LIST: public nodes run by a wallet, a known community member or a named public RPC service, plus the
// project's own stagenet node. A node sees the person's IP address and the moment the withdrawal is sent, so a
// node on a private domain with no named operator is not listed even when it answers. Most public nodes cannot
// be listed anyway: they send no CORS headers, or no Access-Control-Allow-Headers, and fail in a browser while
// answering curl. The order is the fallback order; the first one is the default where nothing picks. Each entry is
// an https address without a trailing slash, matched exactly.
//
// THE PROJECT'S OWN STAGENET NODE, served through its restricted RPC port with CORS for this page's origin.
// It is listed with a network badge and can be chosen by hand; it is not auto-picked for a mainnet search,
// because the page chooses a node on the requested network.
export const STAGENET_NODE = "https://xmr-stagenet.ninsei.finance";
export const NODES = Object.freeze([
  "https://xmr-node.cakewallet.com:18081",
  "https://node.sethforprivacy.com",
  "https://xmr.0xrpc.io",
  STAGENET_NODE,
]);
export const DEFAULT_NODE = NODES[0];
// The network a listed node serves. A listed node outside this map is a mainnet node; the page checks the node's
// own answer before it lets a wallet use it.
export const NODE_NETWORKS = Object.freeze({ [STAGENET_NODE]: "stagenet" });
export function nodeNetwork(url) {
  return NODE_NETWORKS[url] || "mainnet";
}

// A NODE MORE THAN THIS MANY BLOCKS FROM THE MEDIAN ANSWER is out of step. Behind: a wallet synced
// against it would miss the newest blocks, which is where a fresh swap's XMR is. Ahead: the other
// nodes disagree with the height it claims.
export const MAX_BEHIND = 3;

// A PING THAT TAKES LONGER than this is a node not worth picking; the wallet's own calls have their
// own, longer patience.
export const PING_TIMEOUT_MS = 5000;

// THE SETTING IS KEPT FOR THE TAB, NOT FOR THE BROWSER: a node is a choice about this session, and a shared machine
// must not remember one person's node for the next.
export const NODE_STORAGE_KEY = "ninsei.recovery.node";

// ONE RULE FOR A STORED VALUE AND A CHOICE: a listed node, as the list writes it, or nothing.
export function isListedNode(url) {
  return typeof url === "string" && NODES.includes(url);
}

// THE NAME A ROW SHOWS: the host without the scheme or the port. The full address is in the row's
// title and in the log.
export function nodeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return String(url);
  }
}

// --- the node this tab uses ------------------------------------------------------------------

// `source` says who chose: "tab" (this tab's earlier choice) | "default" (nobody yet) | "pick" (the page) | "person".
let current = DEFAULT_NODE;
let source = "default";

function stored() {
  try {
    return sessionStorage.getItem(NODE_STORAGE_KEY);
  } catch {
    return null;
  }
}

// READ ONCE AT START: the wallet binds to the node when it is created, and a change afterwards means a new wallet, so
// the choice closes once a wallet exists. A kept value that is not on the list (an earlier build kept any address)
// is ignored, and the tab starts on the default.
function resolveAtStart() {
  const kept = stored();
  if (isListedNode(kept)) {
    current = kept;
    source = "tab";
  }
}

resolveAtStart();

export function nodeUrl() {
  return current;
}

export function nodeSource() {
  return source;
}

// SET THE NODE THE TAB USES: a listed node, or nothing changes and the answer is false. Only a person's choice is
// kept for the tab: the page's own pick is made again on the next load, against the nodes that answer then.
export function setNodeUrl(url, { remember = true, by = "person" } = {}) {
  if (!isListedNode(url)) return false;
  current = url;
  source = by;
  if (remember) {
    try {
      sessionStorage.setItem(NODE_STORAGE_KEY, url);
    } catch {
      // A tab that refuses storage still works: the choice lives for the page's life.
    }
  }
  return true;
}

// --- asking the nodes ------------------------------------------------------------------------
//
// WHAT A PING TELLS A NODE: that a visitor asked for its height (`get_info`), from the visitor's
// address. Nothing about the recovery file, the wallet or its keys; those never leave the tab.

// TWO REQUESTS, THE FASTER ONE COUNTS: the first pays for the TLS handshake and the CORS preflight,
// the second is the round trip the wallet will see. A node that fails the first is not asked again.
// `probe` is the SDK's probeMoneroNode (one get_info, a named reason when it refuses).
export async function pingNode(url, probe, timeoutMs = PING_TIMEOUT_MS) {
  const ask = async () => {
    try {
      return (await probe({ url, timeoutMs })) || { ok: false, why: "unreachable" };
    } catch {
      return { ok: false, why: "unreachable" };
    }
  };
  const first = await ask();
  if (!first.ok) return first;
  const second = await ask();
  return second.ok && second.ms < first.ms ? second : first;
}

// THE TIMESTAMP OF ONE MONERO BLOCK, in seconds: one `get_block_header_by_height`. The heights asked converge on a
// swap's time, which the node learns anyway once the wallet asks for blocks from there. The genesis block carries
// the timestamp 0 on every network, and that is its real time, so block 0 is the one 0 passed on; no answer, an
// RPC error (a height past the top block), another block's header or any other 0 throws: unknown, never 0.
export async function moneroHeaderTime(url, height, fetchImpl = globalThis.fetch, timeoutMs = PING_TIMEOUT_MS) {
  if (!Number.isSafeInteger(height) || height < 0) throw new Error(`not a block height: ${height}`);
  const response = await fetchImpl(String(url) + "/json_rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "0", method: "get_block_header_by_height", params: { height } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw pageFailure("header", {}, `get_block_header_by_height ${height}: HTTP ${response.status}`);
  const body = await response.json();
  const header = body && body.result && body.result.block_header;
  const time = header ? header.timestamp : undefined;
  if (!header || header.height !== height || !Number.isSafeInteger(time) || time < 0 || (time === 0 && height !== 0)) {
    throw pageFailure(
      "header",
      {},
      `get_block_header_by_height ${height}: ${body && body.error ? `RPC ${body.error.code ?? "error"}` : "no block time"}`,
    );
  }
  return time;
}

// THE MONERO READERS THE SDK'S START-HEIGHT RULE TAKES (findSwaps: moneroTip, moneroBlockTimestamp), over one node,
// or null when the node does not answer on `network`. get_info's `height` is the number of blocks, so the top block
// is one lower: a header asked at `height` does not exist yet, and a reader that asks for it never gets a height.
export async function moneroReaders(url, network, probe, fetchImpl = globalThis.fetch) {
  if (!url || typeof probe !== "function") return null;
  let answer = null;
  try {
    answer = await probe({ url });
  } catch {
    return null;
  }
  if (!answer || !answer.ok || answer.network !== network || !Number.isSafeInteger(answer.height) || answer.height < 1)
    return null;
  return {
    moneroTip: async () => answer.height - 1,
    moneroBlockTimestamp: (height) => moneroHeaderTime(url, height, fetchImpl),
  };
}

// THE NODE FOR A SWAP'S MONERO NETWORK: the chosen one when it answers on that network; for stagenet, the project's
// stagenet node otherwise; for mainnet, none when the chosen node is on another network. `chosenNetwork` is the
// network the chosen node answered with.
export function nodeFor(network, chosenNetwork) {
  if (current && chosenNetwork === network) return current;
  return network === "stagenet" ? STAGENET_NODE : null;
}

// THE MEDIAN HEIGHT of the synchronized answers on one network, or null when there are none: the measure of
// "behind" and "ahead". The median, not the highest: one node claiming a height far above the rest must
// not turn the others red and leave itself the only good one. With an even count the lower middle
// counts. Another network's height is a different chain, and a node that says it is still syncing does
// not know the tip, so neither counts.
export function medianHeight(answers, network = "mainnet") {
  const heights = [];
  for (const a of answers) {
    if (a && a.ok && a.network === network && a.synchronized === true && Number.isInteger(a.height))
      heights.push(a.height);
  }
  if (heights.length === 0) return null;
  heights.sort((x, y) => x - y);
  return heights[Math.floor((heights.length - 1) / 2)];
}

// GOOD OR BAD, AND WHY: a node is good when it answered, is on `network`, says it is synchronized and is
// at most MAX_BEHIND blocks from `median`, either way. No answer yet is "checking", never a guess. `why` names a
// word in the language (node.state.<why>), with `params` for its numbers.
const FAILED = { unreachable: "unreachable", timeout: "timeout", http: "http" };
export function nodeVerdict(answer, median, network = "mainnet") {
  if (!answer) return { state: "checking", why: "checking", params: {} };
  // The page could not ask (no probe): unknown, never bad and never good.
  if (answer.why === "unchecked") return { state: "unknown", why: "unchecked", params: {} };
  if (!answer.ok) {
    if (answer.why === "nettype")
      return { state: "bad", why: "network", params: { network: nameOf(answer.nettype) || "?" } };
    const why = FAILED[answer.why] || "answer";
    return { state: "bad", why, params: { status: answer.status ?? "?" } };
  }
  if (answer.network !== network) return { state: "bad", why: "network", params: { network: answer.network } };
  if (answer.synchronized !== true) return { state: "bad", why: "sync", params: {} };
  const off = median === null ? 0 : answer.height - median;
  if (-off > MAX_BEHIND) return { state: "bad", why: "behind", params: { blocks: -off } };
  if (off > MAX_BEHIND) return { state: "bad", why: "ahead", params: { blocks: off } };
  return { state: "good", why: "good", params: { height: answer.height } };
}

// The name of the network as monero-ts takes it (lowercase). The node answers with its own nettype,
// and the wallet MUST be built from that: a mainnet wallet against a stagenet node looks like a
// broken sweep, and did once. An unknown nettype is null: a caller must refuse it, not guess another chain.
export function networkFromNode(info) {
  const t = String((info && info.nettype) || "").toLowerCase();
  return t === "mainnet" || t === "testnet" || t === "stagenet" ? t : null;
}
