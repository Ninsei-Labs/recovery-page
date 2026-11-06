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
//   later    - the deal is open; the money can be taken back after the deadline if it does not complete;
//   none     - nothing to do here: a buy refunded to the wallet that paid, a sell paid out to the person;
//   unknown  - the chain did not answer, or answered with an escrow that was never funded: never "nothing to do".
// `state` names the sentence: `<side>.<claimed|refunded|declined|open|late>`, or `unknown`.
export function swapState({ side, status, deadline = null, now = Date.now() } = {}) {
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
  return { state: `${side}.${now < deadline ? "open" : "late"}`, action: "later", params: { deadline } };
}

// THE STATUS FROM THE ESCROW'S EVENTS, WITHOUT ONE CALL PER ORDER. A found order starts funded. A claim emits
// `HalfRevealed(half, true)`; an ordinary refund emits `HalfRevealed(half, false)`; a decline emits `Declined`
// and sets the escrow's refunded flag without revealing any half. The last fact wins if an RPC returns duplicates.
export function statusFromEvents(events = []) {
  const status = { isFunded: true, isClaimed: false, isRefunded: false, isDeclined: false };
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== "object") continue;
    if (event.event === "HalfRevealed") {
      if (event.byClaimer === true) status.isClaimed = true;
      else status.isRefunded = true;
    } else if (event.event === "Declined") {
      status.isDeclined = true;
      status.isRefunded = true;
    }
  }
  return status;
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
