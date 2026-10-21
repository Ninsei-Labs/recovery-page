// WHERE THE PAGE FINDS A MONERO NODE, AND WHY IT IS A CHOICE AND NOT A CONSTANT.
//
// The page is a reference implementation: an operator can serve it from their own host and point it at
// a node of their own. A hard-coded address would tie every copy to us, which is the opposite of why
// this repository exists. The node is therefore a choice with a stated list behind it:
//
//   1. `?node=<url>` in the address bar (a link someone can hand over; nothing is stored);
//   2. the choice kept for this tab (sessionStorage), made by the person on the page;
//   3. otherwise the page picks: it asks every listed node for `get_info` and takes the fastest one
//      that passes `nodeVerdict`. A page that cannot ask (diagnostics) uses the first listed node.
//
// WHAT A NODE MUST DO to serve this page: answer the wallet's paths (`/json_rpc`, `/getblocks.bin`,
// `/gethashes.bin`, `/get_blocks.bin`) and allow the page's origin in CORS, including the
// `Content-Type: application/json` header monero-ts sends. A node without CORS fails in the browser,
// not on the wire, and the page reports that as a node that does not answer.
//
// NOTHING SECRET LIVES HERE. A node address is public by nature; the wallet's keys never leave the tab.

// THE LIST: public nodes run by a wallet, a known community member or a named public RPC service, that
// serve the wallet paths over HTTPS and allow any origin in CORS with the JSON content type, checked
// from this page's own origin. A node sees the person's IP address and the moment the withdrawal is
// sent, so a node on a private domain with no named operator is not listed even when it answers. Most public nodes cannot be listed anyway: they send no CORS headers, or
// no Access-Control-Allow-Headers, and fail in a browser while answering curl. The order is the fallback
// order; the first one is the default where nothing picks.
export const NODES = Object.freeze([
  "https://xmr-node.cakewallet.com:18081",
  "https://node.sethforprivacy.com",
  "https://xmr.0xrpc.io",
]);
export const DEFAULT_NODE = NODES[0];
// THE PROJECT'S OWN STAGENET NODE. It is not in the mainnet list above: the page chooses it when a key
// names a testnet factory, because the settlement network then pairs with stagenet.
export const STAGENET_NODE = "https://xmr.arrakisswap.trade";

// A NODE MORE THAN THIS MANY BLOCKS FROM THE MEDIAN ANSWER is out of step. Behind: a wallet synced
// against it would miss the newest blocks, which is where a fresh swap's XMR is. Ahead: the other
// nodes disagree with the height it claims.
export const MAX_BEHIND = 3;

// A PING THAT TAKES LONGER than this is a node not worth picking; the wallet's own calls have their
// own, longer patience.
export const PING_TIMEOUT_MS = 5000;

// THE SETTING IS KEPT FOR THE TAB, NOT FOR THE BROWSER: a node address is a choice about this session,
// and a shared machine must not remember one person's node for the next.
export const NODE_STORAGE_KEY = "ninsei.recovery.node";

// ONE PARSER FOR THE FIELD, THE LINK AND THE STORED VALUE. Three readers with three rules is how a
// page ends up talking to one node while its report names another.
//   ok:true  -> `url` is the address to use, without a trailing slash
//   ok:false -> `why` is a code the page turns into words: "empty" | "shape" | "credentials" | "scheme"
export function parseNodeUrl(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (text === "") return { ok: false, why: "empty", url: null };
  let u;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, why: "shape", url: null };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, why: "scheme", url: null };
  // Credentials in the address would be sent by the browser and shown in the log: refuse them here
  // rather than let a pasted link put a password into a screenshot.
  if (u.username || u.password) return { ok: false, why: "credentials", url: null };
  // A query or a fragment is not part of a node address: the page appends its own paths, so keeping
  // either would glue `/json_rpc` onto something that is not a base.
  if (u.hash || u.search) return { ok: false, why: "shape", url: null };
  const path = u.pathname.replace(/\/+$/, "");
  return { ok: true, why: null, url: u.origin + path };
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

// --- the address this tab uses ---------------------------------------------------------------

// `source` says who chose: "link" | "tab" | "default" (nobody yet) | "pick" (the page) | "person" | "none".
let current = DEFAULT_NODE;
let source = "default";

function stored() {
  try {
    return sessionStorage.getItem(NODE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function fromLink() {
  try {
    return new URLSearchParams(location.search).get("node");
  } catch {
    return null;
  }
}

// READ ONCE AT START: the wallet binds to the node when it is created, and a change afterwards means a
// new wallet, so the choice closes once a wallet exists.
function resolveAtStart() {
  const linked = parseNodeUrl(fromLink());
  if (linked.ok) {
    current = linked.url;
    source = "link";
    return;
  }
  const kept = parseNodeUrl(stored());
  if (kept.ok) {
    current = kept.url;
    source = "tab";
    return;
  }
  current = DEFAULT_NODE;
  source = "default";
}

resolveAtStart();

export function nodeUrl() {
  return current;
}

export function nodeSource() {
  return source;
}

// SET THE ADDRESS THE TAB USES. Returns the parse result, so the caller can show the same reason the
// parser used; a refused value changes nothing. Only a person's choice is kept for the tab: the page's
// own pick is made again on the next load, against the nodes that answer then.
export function setNodeUrl(raw, { remember = true, by = "person" } = {}) {
  const parsed = parseNodeUrl(raw);
  if (!parsed.ok) return parsed;
  current = parsed.url;
  source = by;
  if (remember) {
    try {
      sessionStorage.setItem(NODE_STORAGE_KEY, parsed.url);
    } catch {
      // A tab that refuses storage still works: the address lives for the page's life.
    }
  }
  return parsed;
}

// NO NODE: nothing answers well enough to be picked, or the person's own address was refused. The page
// then says so instead of falling back to a node nobody chose.
export function clearNodeUrl() {
  current = null;
  source = "none";
}

// THE LABEL IS A KEY AND ITS PARAMS, NOT A SENTENCE: words live in locales/<tag>/, and this module
// stays free of them. A listed node, the page's own origin and any other address read differently.
export function nodeLabelKey() {
  if (NODES.includes(current)) return "node.label.listed";
  try {
    if (current === location.origin) return "node.label.same";
  } catch {
    // No location (a test): fall through to the custom label.
  }
  return "node.label.custom";
}

export function nodeLabelParams() {
  return { url: current };
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
  if (!response.ok) throw new Error(`get_block_header_by_height ${height}: HTTP ${response.status}`);
  const body = await response.json();
  const header = body && body.result && body.result.block_header;
  const time = header ? header.timestamp : undefined;
  if (!header || header.height !== height || !Number.isSafeInteger(time) || time < 0 || (time === 0 && height !== 0)) {
    throw new Error(`get_block_header_by_height ${height}: ${body && body.error ? `RPC ${body.error.code ?? "error"}` : "no block time"}`);
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
  if (!answer || !answer.ok || answer.network !== network || !Number.isSafeInteger(answer.height) || answer.height < 1) return null;
  return {
    moneroTip: async () => answer.height - 1,
    moneroBlockTimestamp: (height) => moneroHeaderTime(url, height, fetchImpl),
  };
}

// THE NODE FOR A SWAP'S MONERO NETWORK: the chosen one when it answers on that network; for stagenet, the project's
// stagenet node otherwise, since the listed nodes are all mainnet; for mainnet, none when the chosen node is on
// another network. `chosenNetwork` is the network the chosen node answered with.
export function nodeFor(network, chosenNetwork) {
  if (current && chosenNetwork === network) return current;
  return network === "stagenet" ? STAGENET_NODE : null;
}

// THE MEDIAN HEIGHT of the synchronized mainnet answers, or null when there are none: the measure of
// "behind" and "ahead". The median, not the highest: one node claiming a height far above the rest must
// not turn the others red and leave itself the only good one. With an even count the lower middle
// counts. Another network's height is a different chain, and a node that says it is still syncing does
// not know the tip, so neither counts.
export function medianHeight(answers) {
  const heights = [];
  for (const a of answers) {
    if (a && a.ok && a.network === "mainnet" && a.synchronized === true && Number.isInteger(a.height)) heights.push(a.height);
  }
  if (heights.length === 0) return null;
  heights.sort((x, y) => x - y);
  return heights[Math.floor((heights.length - 1) / 2)];
}

// GOOD OR BAD, AND WHY: a node is good when it answered, is on mainnet, says it is synchronized and is
// at most MAX_BEHIND blocks from `median`, either way. No answer yet is "checking", never a guess. `why` names a
// word in the language (node.state.<why>), with `params` for its numbers.
const FAILED = { unreachable: "unreachable", timeout: "timeout", http: "http" };
export function nodeVerdict(answer, median) {
  if (!answer) return { state: "checking", why: "checking", params: {} };
  // The page could not ask (no probe): unknown, never bad and never good.
  if (answer.why === "unchecked") return { state: "unknown", why: "unchecked", params: {} };
  if (!answer.ok) {
    if (answer.why === "nettype") return { state: "bad", why: "network", params: { network: answer.nettype ?? "?" } };
    const why = FAILED[answer.why] || "answer";
    return { state: "bad", why, params: { status: answer.status ?? "?" } };
  }
  if (answer.network !== "mainnet") return { state: "bad", why: "network", params: { network: answer.network } };
  if (answer.synchronized !== true) return { state: "bad", why: "sync", params: {} };
  const off = median === null ? 0 : answer.height - median;
  if (-off > MAX_BEHIND) return { state: "bad", why: "behind", params: { blocks: -off } };
  if (off > MAX_BEHIND) return { state: "bad", why: "ahead", params: { blocks: off } };
  return { state: "good", why: "good", params: { height: answer.height } };
}

// THE PAGE'S PICK: the fastest good node, or null when none is good. Ties go to the list order.
// `entries` is [{ url, answer }] for the listed nodes.
export function fastestGood(entries) {
  const median = medianHeight(entries.map((e) => e.answer));
  let best = null;
  for (const e of entries) {
    if (nodeVerdict(e.answer, median).state !== "good") continue;
    if (best === null || e.answer.ms < best.answer.ms) best = e;
  }
  return best ? best.url : null;
}

// The name of the network as monero-ts takes it (lowercase). The node answers with its own nettype,
// and the wallet MUST be built from that: a mainnet wallet against a stagenet node looks like a
// broken sweep, and did once.
export function networkFromNode(info) {
  const t = String((info && info.nettype) || "").toLowerCase();
  return t === "mainnet" || t === "testnet" || t === "stagenet" ? t : "stagenet";
}
