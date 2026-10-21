// THE MONERO BLOCKS AROUND THE LOCK, NOT ALL HISTORY.
//
// The page knows the order's start height and its t1 (settlement time, seconds). A withdrawal only needs the
// Monero blocks from the start to the block at or after t1, plus ten blocks of margin. The height at t1 is found
// by binary search over block-header timestamps: a Monero block's timestamp may run ahead of wall time, so the
// search is the only honest conversion from a settlement timestamp to a Monero height.

const TIMEOUT_MS = 8000;

const baseOf = (nodeUrl) => {
  let base = typeof nodeUrl === "string" ? nodeUrl.trim() : "";
  while (base.endsWith("/")) base = base.slice(0, -1);
  return base;
};

async function headerTimestamp({ base, height, fetchImpl, timeoutMs }) {
  let response;
  try {
    response = await fetchImpl(base + "/json_rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "header", method: "get_block_header_by_height", params: { height },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error("window-header-unreachable");
  }
  if (!response || !response.ok) throw new Error("window-header-http");
  let body = null;
  try { body = await response.json(); } catch { throw new Error("window-header-json"); }
  if (!body || body.error || !body.result) throw new Error("window-header-rpc");
  const timestamp = Number(body.result.block_header && body.result.block_header.timestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error("window-header-time");
  return timestamp;
}

/**
 * The last Monero height at or before a timestamp, when the chain is already past it; otherwise the tip.
 * A height whose header cannot be read is a named failure, not a guessed number.
 */
export async function moneroHeightAtOrAfter({ nodeUrl, timestamp, tipHeight,
  fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const base = baseOf(nodeUrl);
  const target = Number(timestamp);
  const tip = Number(tipHeight);
  if (!base) throw new Error("window-node");
  if (!(target > 0)) throw new Error("window-time");
  if (!Number.isSafeInteger(tip) || tip < 0) throw new Error("window-tip");
  if (typeof fetchImpl !== "function") throw new Error("window-fetch");

  const at = (height) => headerTimestamp({ base, height, fetchImpl, timeoutMs });
  const tipTime = await at(tip);
  if (tipTime < target) return tip;              // t1 is still in the future
  const zeroTime = await at(0);
  if (zeroTime >= target) return 0;
  let low = 0;
  let high = tip;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((await at(mid)) < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** The SDK's `sweep.restore({ window })`: from the order's start to the block at t1 plus ten. */
export async function restoreWindow({ nodeUrl, t1Sec, startHeight, tipHeight,
  fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const start = Number(startHeight);
  const tip = Number(tipHeight);
  const t1 = Number(t1Sec);
  if (!Number.isSafeInteger(start) || start <= 0) return null;
  if (!Number.isSafeInteger(tip) || tip <= 0) return null;
  if (!(t1 > 0)) return null;
  let at = null;
  try { at = await moneroHeightAtOrAfter({ nodeUrl, timestamp: t1, tipHeight: tip, fetchImpl, timeoutMs }); }
  catch { return null; }
  const toHeight = Math.min(tip, Math.max(start, at + 10));
  if (!(toHeight > start)) return null;
  return { nodeUrl: baseOf(nodeUrl), toHeight, tipHeight: tip, fallback: true };
}
