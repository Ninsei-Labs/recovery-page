// WHAT THE PAGE CAN SAY ABOUT A SWAP FOUND BY THE KEY: what it needs, from the chain, and the state of its XMR in
// the withdrawal step.
//
// The page has one job: move the XMR from a swap's one-time address to the person's own wallet. That happens in
// two cases, and both need the half the maker published on the settlement chain:
//   - a buy the maker completed: it took the ETH by revealing its half (claimed);
//   - a sell that failed: the maker took its ETH back after the deadline, revealing its half (refunded).
// Every other state needs nothing from this page, or needs time. The words live in locales/<tag>/.

// WHAT A SWAP NEEDS, from the escrow's events and its deadline (`deadline` in ms, `now` in ms):
//   withdraw - the maker's half is on chain: a buy it claimed, a sell it refunded;
//   refund   - a buy whose deposit deadline passed: the person's ETH can go back to the locker;
//   claim    - a sell the person may take before t1, once the maker marked ready or readyBy passed;
//   later    - the deal is open; the money can be taken back after the deadline if it does not complete;
//   none     - nothing to do here: a buy refunded to the wallet that paid, a sell paid out to the person;
//   unknown  - the chain did not answer, or answered with an escrow that was never funded: never "nothing to do".
// `state` names the sentence: `<side>.<claimed|refunded|declined|open|late>`, or `unknown`.
export function swapState({ side, status, deadline = null, readyBy = null, now = Date.now() } = {}) {
  const unknown = { state: "unknown", action: "unknown", params: {} };
  if ((side !== "buy" && side !== "sell") || !status || typeof status !== "object" || status.isFunded !== true)
    return unknown;
  // A DECLINE IS NOT AN ORDINARY REFUND. It reveals no half, so a sell has nothing to withdraw even though the
  // escrow's `refunded` flag is set. The event reader names it; status() alone cannot.
  if (status.isDeclined === true)
    return { state: side === "buy" ? "buy.refunded" : "sell.declined", action: "none", params: {} };
  if (status.isClaimed === true)
    return { state: `${side}.claimed`, action: side === "buy" ? "withdraw" : "none", params: {} };
  if (status.isRefunded === true)
    return { state: `${side}.refunded`, action: side === "buy" ? "none" : "withdraw", params: {} };
  if (!Number.isFinite(deadline) || deadline <= 0 || !Number.isFinite(now)) return unknown;
  // THE PERSON'S SIDE DECIDES THE ACTION. On a buy the person deposited the ETH (locker): after t1 the deposit can be
  // refunded. On a sell the person is the claimer: before t1 they may claim once the maker marked ready or readyBy
  // passed; at t1 the claim window closes and the maker's refund is awaited.
  if (side === "buy") {
    return now >= deadline
      ? { state: "buy.late", action: "refund", params: { deadline } }
      : { state: "buy.open", action: "later", params: { deadline } };
  }
  if (now >= deadline) return { state: "sell.late", action: "none", params: {} };
  const claimOpen = status.isReady === true || (Number.isFinite(readyBy) && readyBy > 0 && now >= readyBy);
  return { state: "sell.open", action: claimOpen ? "claim" : "later", params: { deadline } };
}

// THE STATUS FROM THE ESCROW'S EVENTS, WITHOUT ONE CALL PER ORDER. A found order starts funded. A claim emits
// `HalfRevealed(half, true)`; an ordinary refund emits `HalfRevealed(half, false)`; a decline emits `Declined`
// and sets the escrow's refunded flag without revealing any half. The last fact wins if an RPC returns duplicates.
export function statusFromEvents(events = []) {
  const status = { isFunded: true, isClaimed: false, isRefunded: false, isDeclined: false, isReady: false };
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== "object") continue;
    if (event.event === "Ready") {
      // Ready(address(0)) is a DEPOSIT MARKER, not a readiness mark: only the depositor's non-zero address opens
      // the claim before readyBy.
      const by = String(event.by || "").toLowerCase();
      if (/^0x[0-9a-f]{40}$/.test(by) && !/^0x0{40}$/.test(by)) status.isReady = true;
    } else if (event.event === "HalfRevealed") {
      if (event.byClaimer === true) status.isClaimed = true;
      else status.isRefunded = true;
    } else if (event.event === "Declined") {
      status.isDeclined = true;
      status.isRefunded = true;
    }
  }
  return status;
}

// THE START HEIGHT THE PAGE MAY SCAN FROM. A height in the future is not a scan: the wallet would read no blocks and
// report a complete, empty balance, while the XMR is below the tip the node already has. The tip is the node's own
// height; an unavailable tip is left unknown and does not turn a valid request into a refusal.
export function scanStartHeight(value, tip) {
  const height = value === null || value === undefined || value === "" ? 0 : Number(value);
  if (!Number.isSafeInteger(height) || height < 0) return { ok: false, reason: "bad" };
  const top = tip === null || tip === undefined || tip === "" ? null : Number(tip);
  if (Number.isSafeInteger(top) && top >= 0 && height > top) return { ok: false, reason: "above-tip", tip: top };
  return { ok: true, height };
}

// A NODE'S TIP IS READ AS A COUNT OF BLOCKS, NOT AS A BLOCK HEIGHT. monero's `get_info.height` is the number of
// blocks (top + 1); a header asked at that value does not exist. The header of the top block is one below it.
export function tipHeaderHeight(daemonHeight) {
  const height = Number(daemonHeight);
  return Number.isSafeInteger(height) && height >= 1 ? height - 1 : null;
}

export const TIP_MAX_AGE_MS = 2 * 60 * 60 * 1000;
// THE SETTLEMENT CHAIN AND MONERO DO NOT SHARE A CLOCK. A lock can be mined a little before the EVM order's block
// timestamp by seconds; a block of margin prevents a fresh swap from being called a short chain on that difference.
export const TIP_ORDER_MARGIN_SECONDS = 10 * 60;

export function tipTrusted({
  tipTime = null,
  orderTime = null,
  now = Date.now(),
  maxAgeMs = TIP_MAX_AGE_MS,
  marginSeconds = TIP_ORDER_MARGIN_SECONDS,
} = {}) {
  if (!Number.isFinite(tipTime) || !Number.isFinite(now) || tipTime < 0) return false;
  if (Math.abs(now - tipTime * 1000) > maxAgeMs) return false;
  if (Number.isFinite(orderTime) && orderTime > 0 && tipTime < orderTime - marginSeconds) return false;
  return true;
}

// THE STATE OF THE MONEY in the withdrawal step, for a swap whose action is "withdraw":
//   ready     - the SDK read the maker's half: the wallet can be built;
//   unread    - the swap says the half is on chain, but the SDK could not read it: unknown, never "not yet";
//   locked    - synced: the XMR is there but not spendable yet (fresh outputs unlock after 10 blocks);
//   withdrawn - synced: XMR arrived at the address and has left it;
//   unseen    - a COMPLETE scan shows no transaction at all, so the key does not see this swap's XMR;
//   incomplete - the scan did not finish or could not verify spent outputs: nothing may be claimed about arrival;
//   nothing   - synced: nothing there, and the wallet could not say whether anything ever arrived.
// `balance` is { total, unlocked, txs, scanComplete } in atomic units (BigInt), `txs` the number of transactions
// the wallet sees (null when it could not say), and `scanComplete` true only when the SDK named a completed scan.
// A missing verdict is not a completed scan: a restore that stopped at block N cannot say what is above N.
export function moneyState({ plan = null, balance = null } = {}) {
  if (balance) {
    if (balance.scanComplete !== true) return { state: "incomplete", params: {} };
    if (balance.total <= 0n) {
      if (balance.txs === null || balance.txs === undefined) return { state: "nothing", params: {} };
      return { state: balance.txs > 0 ? "withdrawn" : "unseen", params: {} };
    }
    if (balance.unlocked <= 0n) return { state: "locked", params: {} };
  }
  if (!plan || plan.revealedHalf !== true) return { state: "unread", params: {} };
  return { state: "ready", params: {} };
}
