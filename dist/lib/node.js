// WHERE THE PAGE FINDS A MONERO NODE, AND WHY IT IS A FIELD AND NOT A CONSTANT.
//
// The page is a reference implementation: an operator can serve it from their own host and point it at
// a node of their own. A hard-coded address would tie every copy to us, which is the opposite of why
// this repository exists. The node address is therefore a setting with a stated default:
//
//   1. `?node=<url>` in the address bar (a link someone can hand over; nothing is stored);
//   2. the value kept for this tab (sessionStorage), set by the field on the page;
//   3. the default below, which is what the page uses when nobody chooses.
//
// WHAT A NODE MUST DO to serve this page: answer the wallet's paths (`/json_rpc`, `/getblocks.bin`,
// `/gethashes.bin`, `/get_blocks.bin`) and allow the page's origin in CORS. Under the page's
// `COEP: require-corp` an answer that passes CORS also passes the cross-origin check. A node without
// CORS fails in the browser, not on the wire, and the page reports that as a refused node.
//
// NOTHING SECRET LIVES HERE. A node address is public by nature; the wallet's keys never leave the tab.

// THE DEFAULT IS A PUBLIC COMMUNITY NODE: a browser can use a node only when the node serves the wallet
// paths over HTTPS and allows this page's origin in CORS, and only some public nodes do both. The
// default is one of those; an operator who runs a node can put a proxy in front of it and enter that
// address instead. The field on the page and the link override it for the tab.
export const DEFAULT_NODE = "https://monero.openinternet.io";

// THE SETTING IS KEPT FOR THE TAB, NOT FOR THE BROWSER: a node address is a choice about this session,
// and a shared machine must not remember one person's node for the next.
export const NODE_STORAGE_KEY = "ninsei.recovery.node";

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/;
const isLocalHost = (h) => LOCAL_HOST.test(h) || /\.local$/.test(h);

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

// THE ADDRESS THIS TAB USES, read once at start: the wallet binds to it when it is created, and a
// change afterwards means a new wallet, so the field closes once a wallet exists.
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
  // A LOCAL STAND IS ITS OWN PROXY: on localhost the page is served by the stand, which forwards the
  // wallet's paths to a local node. Using the public node there would send a stand's traffic to
  // production, which is both wrong and invisible.
  if (isLocalPage()) {
    current = location.origin;
    source = "local";
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
// parser used; a refused value changes nothing.
export function setNodeUrl(raw, { remember = true } = {}) {
  const parsed = parseNodeUrl(raw);
  if (!parsed.ok) return parsed;
  current = parsed.url;
  source = "field";
  if (remember) {
    try {
      sessionStorage.setItem(NODE_STORAGE_KEY, parsed.url);
    } catch {
      // A tab that refuses storage still works: the address lives for the page's life.
    }
  }
  return parsed;
}

export function resetNodeUrl() {
  current = DEFAULT_NODE;
  source = "default";
  try {
    sessionStorage.removeItem(NODE_STORAGE_KEY);
  } catch {
    // See above: storage is an optimisation, not a requirement.
  }
}

// THE LABEL IS A KEY AND ITS PARAMS, NOT A SENTENCE: words live in locales/<tag>/, and this module
// stays free of them. The default names the public node, the page's own origin names a local stand,
// and any other address is shown in full.
export function nodeLabelKey() {
  if (source === "local") return "node.label.same";
  if (source === "default") return "node.label.default";
  try {
    if (current === location.origin) return "node.label.same";
  } catch {
    // No location (a test): fall through to the custom label.
  }
  return "node.label.custom";
}

export function nodeLabelParams() {
  return { url: current, default: DEFAULT_NODE };
}

// The name of the network as monero-ts takes it (lowercase). The node answers with its own nettype,
// and the wallet MUST be built from that: a mainnet wallet against a stagenet node looks like a
// broken sweep, and did once.
export function networkFromNode(info) {
  const t = String((info && info.nettype) || "").toLowerCase();
  return t === "mainnet" || t === "testnet" || t === "stagenet" ? t : "stagenet";
}

export function isLocalPage() {
  try {
    return isLocalHost(location.hostname);
  } catch {
    return false;
  }
}
