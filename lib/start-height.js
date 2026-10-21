// THE MONERO HEIGHT A SWAP FOUND BY THE RECOVERY KEY STARTS FROM.
//
// A per-swap file carried its start height; one key carries none, so the height is derived from the chain
// (sdk#76, task 3): take the time of the settlement block that holds the order's OrderCreated, find the last
// Monero block at or before that time by a binary search over the node's block headers, and start 60 blocks
// lower. A Monero block's timestamp may run up to two hours ahead of the clock (60 blocks of two minutes) and
// about an hour behind it (the median of the last 60 blocks), so the margin keeps the scan below the first block
// that can hold the swap's XMR. A scan that starts below the money finds it; one that starts above never does.
//
// THE SDK HAS THE SAME RULE SINCE 0.49.0, inside findSwaps, when the search is handed a Monero node of the swap's
// network (xmrNodes). This page searches before a node is chosen for the swap's network, so it derives the height
// when a swap is opened, from the node chosen then; this file goes when the page hands findSwaps that node. The
// readers are seams: the rule lives here, the transport in lib/settlement.js (the block time) and lib/node.js (the
// Monero headers).
//
// A FAILED READ IS UNKNOWN, NEVER 0. Zero means "scan from Monero's first block", hours of work that would look
// like a choice. The function throws, and the page asks the person for a height instead.

export const START_HEIGHT_MARGIN = 60;

// SECONDS SINCE 1970, OR NULL. A value above 1e11 is not seconds (that is the year 5138): a time in milliseconds
// read as seconds would put the order after every block and start the scan 60 blocks below the tip, above the
// money. It is refused here instead of being guessed at.
const seconds = (value) => {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 && n < 1e11 ? Math.floor(n) : null;
};

// `orderTime` is the settlement block's time in seconds. `tip()` gives the height of the node's newest block,
// `headerTime(height)` the timestamp of a block in seconds. Both may throw; an answer that is not a time throws.
export async function startHeightAt(orderTime, { tip, headerTime } = {}) {
  const at = seconds(orderTime);
  if (at === null) throw new Error(`not an order time: ${orderTime}`);
  if (typeof tip !== "function" || typeof headerTime !== "function") throw new Error("no Monero header reader");
  const top = Number(await tip());
  if (!Number.isSafeInteger(top) || top < 0) throw new Error(`not a Monero height: ${top}`);
  const time = async (height) => {
    const value = seconds(await headerTime(height));
    if (value === null) throw new Error(`no time for Monero block ${height}`);
    return value;
  };
  // THE LAST BLOCK AT OR BEFORE THE ORDER. `low` always names a block whose time is at or before it, so the
  // answer holds even where timestamps step back, and an order newer than the tip starts below the tip. Block 0 is
  // never read: Monero's genesis block carries the timestamp 0, which no reader may pass as a time, and it is older
  // than every order anyway.
  let low = 0;
  if ((await time(top)) <= at) low = top;
  else {
    let high = top;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if ((await time(mid)) <= at) low = mid;
      else high = mid - 1;
    }
  }
  return Math.max(0, low - START_HEIGHT_MARGIN);
}
