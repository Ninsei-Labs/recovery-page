// WHAT THE PAGE CAN SAY ABOUT A RECOVERY FILE AND THE MONEY BEHIND IT, before and after a sync.
//
// The page has one job: move the XMR from the deal's one-time address to the person's own wallet. That
// happens in two cases: a buy that completed while the swap tab was lost, and a sell that failed after
// the person sent XMR, where the maker refunded its ETH after the deadline. Both need the key half the
// settlement published; until then the money is safe and simply not yet movable. These rules turn the
// file, the SDK's plan and the wallet's balance into one named state; the words live in locales/<tag>/.

// AN ENCRYPTED FILE is told by its envelope's own fields, never by its name: a renamed file is the
// same file. Every file issued so far is encrypted; a plain one carries the payload's mark instead.
export function fileIsEncrypted(envelope) {
  return Boolean(envelope && typeof envelope === "object"
    && typeof envelope.alg === "string" && typeof envelope.ciphertext === "string");
}

// A SELL is the reverse flow: the person sent the XMR and was to receive ETH. Every other side is a buy.
export function isSell(side) {
  return side === "reverse" || side === "sell";
}

// THE XMR ADDRESS THE FILE PROMISED, on a buy only. On a sell the file's recipient is the person's
// payout address on the settlement chain, not a Monero address, so there is nothing to compare with.
export function promisedXmrAddress(payload) {
  if (!payload || isSell(payload.side)) return null;
  const address = payload.receive && typeof payload.receive.address === "string" ? payload.receive.address.trim() : "";
  return address || null;
}

// THE AMOUNT THE FILE NAMES, a positive number of XMR, or null when it names none.
export function fileAmount(payload) {
  const amount = Number(payload && payload.receive && payload.receive.amount);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

// THE STATE OF THE MONEY:
//   ready     - the key is complete: an old file carries it whole, a halves file once the half is revealed;
//   waitBuy   - a buy whose maker has not taken the ETH yet, so the key is not complete;
//   waitSell  - a sell still open; `deadline` (ms) is when the XMR can be taken back if it fails;
//   empty     - synced, and nothing is at the address;
//   locked    - synced, the XMR is there but not spendable yet (fresh outputs unlock after 10 blocks).
// `balance` is { total, unlocked } in atomic units (BigInt) after a sync, or null before one.
export function moneyState({ payload, plan, balance = null }) {
  if (balance) {
    if (balance.total <= 0n) return { state: "empty", params: {} };
    if (balance.unlocked <= 0n) return { state: "locked", params: {} };
  }
  const wallet = (payload && payload.moneroWallet) || {};
  const keyComplete = !wallet.spendHalf || Boolean(plan && plan.revealedHalf === true);
  if (keyComplete) return { state: "ready", params: { amount: fileAmount(payload) } };
  if (isSell(payload && payload.side)) {
    const t1 = Number(payload.escrow && payload.escrow.t1);
    return { state: "waitSell", params: { deadline: Number.isFinite(t1) && t1 > 0 ? t1 * 1000 : null } };
  }
  return { state: "waitBuy", params: {} };
}
