// THE MONERO BLOCKS AROUND THE LOCK, NOT ALL HISTORY.
//
// The page knows the order's start height and its t1 (settlement time, seconds). A withdrawal only needs the
// Monero blocks from the start to the block at or after t1, plus ten blocks of margin. The height at t1 is found
// by binary search over block-header timestamps: a Monero block's timestamp may run ahead of wall time, so the
// search is the only honest conversion from a settlement timestamp to a Monero height.

import { moneroHeaderTime } from "./node.js?v=0.3.7";

const TIMEOUT_MS = 8000;

const baseOf = (nodeUrl) => {
  let base = typeof nodeUrl === "string" ? nodeUrl.trim() : "";
  while (base.endsWith("/")) base = base.slice(0, -1);
  return base;
};

/**
 * The first Monero height at or after a timestamp, when the chain is already past it; otherwise the top block.
 * `tipHeight` is the node's height as get_info and the wallet's getDaemonHeight give it: the number of blocks, so
 * the top block is `tipHeight - 1`, and a header asked at `tipHeight` does not exist yet. The headers are read by
 * lib/node.js, which passes the genesis block's real timestamp of 0. A height whose header cannot be read is a named
 * failure, not a guessed number.
 */
export async function moneroHeightAtOrAfter({ nodeUrl, timestamp, tipHeight,
  fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const base = baseOf(nodeUrl);
  const target = Number(timestamp);
  const tip = Number(tipHeight);
  if (!base) throw new Error("window-node");
  if (!(target > 0)) throw new Error("window-time");
  if (!Number.isSafeInteger(tip) || tip < 1) throw new Error("window-tip");
  if (typeof fetchImpl !== "function") throw new Error("window-fetch");

  const at = (height) => moneroHeaderTime(base, height, fetchImpl, timeoutMs);
  const top = tip - 1;
  if ((await at(top)) < target) return top;              // t1 is past the newest block
  let low = 0;
  let high = top;
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
  // THE WINDOW ENDS AT THE TOP BLOCK AT THE LATEST: the SDK asks the node for every block in it, and a block past the
  // top would fail the whole restore.
  const toHeight = Math.min(tip - 1, Math.max(start, at + 10));
  if (!(toHeight > start)) return null;
  return { nodeUrl: baseOf(nodeUrl), toHeight, tipHeight: tip, fallback: true };
}
