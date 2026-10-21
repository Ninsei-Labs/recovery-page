// A SWAP FOUND BY THE RECOVERY KEY, IN THE FORM THE SDK'S WITHDRAWAL READS.
//
// sweep.plan, sweep.keys, sweep.destination and sweep.sign take a per-swap recovery file; @ninsei-labs/sdk (0.49.0)
// has no form that takes the key and a found order. Until it has one, the page writes the found order and the key's
// halves into the SDK's own payload (buildPayload), in memory and without a password, so every withdrawal rule
// stays the SDK's: the revealed half read from the escrow, the (s_a + s_b)*G check, the wallet, the restore with
// its margin, the signature and the relay. Nothing here is written to disk, and this file goes when the SDK takes
// the key and the order.
//
// WHAT THIS FILE DECIDES is which points of the order are the other side's, and it checks that against the chain
// before any scan. The person is the LOCKER on a buy (they paid the ETH) and the CLAIMER on a sell (they are paid
// it); the maker is the other one. Both view halves come from the one key: the person's own, and the maker's, which
// the taker hands to the maker with the order (sdk#76, option A).

// A point or a half in one spelling: lowercase hex without 0x. The chain gives 0x-words, the SDK bare hex.
const bare = (value) => String(value == null ? "" : value).replace(/^0x/i, "").toLowerCase();

// "buy" when the person locked the ETH, "sell" when they are the one paid; anything else is not an order side.
export function sideOf(found) {
  if (found && found.side === "locker") return "buy";
  if (found && found.side === "claimer") return "sell";
  return null;
}

// THE OTHER SIDE'S PARTS, OR WHY THE ORDER DOES NOT FIT THE KEY.
//   spend-point      - the person's spend point in the order is not the one this key gives for the number;
//   own-view-point   - on a buy, the view point in the order (the locker's) is not this key's;
//   maker-view-point - on a sell, the view point in the order (the maker's, as locker) is not the one this key
//                      gives the maker: the maker chose its own view half, and the key cannot see the address.
// The chain holds one view point, the locker's. On a buy that is the person's own, so the maker's view half is on
// no chain and only a scan can show it was the key's (`viewChecked: false`).
export function partsOf(found, halves) {
  const side = sideOf(found);
  if (!side) return { ok: false, why: "side" };
  const buy = side === "buy";
  if (bare(buy ? found.edPointLocker : found.edPointClaimer) !== bare(halves.spendPoint)) return { ok: false, why: "spend-point" };
  if (bare(found.edViewPointLocker) !== bare(buy ? halves.viewPoint : halves.makerViewPoint)) {
    return { ok: false, why: buy ? "own-view-point" : "maker-view-point" };
  }
  return {
    ok: true,
    side,
    otherSpendPoint: "0x" + bare(buy ? found.edPointClaimer : found.edPointLocker),
    otherViewPoint: "0x" + bare(halves.makerViewPoint),
    otherViewHalf: halves.makerViewHalf,
    viewChecked: !buy,
  };
}

// THE PAYLOAD the SDK's withdrawal reads, from the order, the halves, the parts above and the joint address the
// SDK built from them. `startHeight` is null when the chain did not give one: the payload then has no height, and
// the page asks the person. Fields the chain does not hold (the XMR amount, the promised address, the quote) are
// null, never guessed.
export function payloadOf({ buildPayload, found, settlement, network, halves, parts, address, startHeight = null, createdAt = null }) {
  const escrow = { address: found.escrow, readyBy: found.readyBy, t1: found.t1 };
  return buildPayload({
    swap: {
      id: found.escrow, side: parts.side, network: settlement, moneroNetwork: network, createdAt,
      payToken: null, payAmount: null, xmrAmount: null, rate: null, maker: null, quoteSignature: null,
      escrow, timeline: null,
    },
    swapWallet: {
      source: "halves", network, address,
      spendHalf: halves.spendHalf, viewHalf: halves.viewHalf,
      otherSpendPoint: parts.otherSpendPoint, otherViewPoint: parts.otherViewPoint, otherViewHalf: parts.otherViewHalf,
      escrowAddress: found.escrow,
    },
    escrow,
    receiveAddress: null,
    restoreHeight: startHeight,
  });
}
