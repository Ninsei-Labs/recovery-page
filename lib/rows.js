// THE ROW RULES: what a found order means for the person, and which settlement recipient a claim/refund signs.
// The page keeps the DOM and the flow; these decisions live here so a table test can run them without a browser.
import { swapState } from "./withdrawal.js";

// THE PERSON'S SIDE OF A FOUND ORDER, for display. The SDK's sweep.fromOrder reads the same field and refuses
// anything else; this function only names the row before the withdrawal is opened.
export function sideOf(found) {
  if (found && found.side === "locker") return "buy";
  if (found && found.side === "claimer") return "sell";
  return null;
}

// THE DEADLINES OF A FOUND ORDER in ms, by the SDK's one conversion; a value of the wrong scale is unknown.
// The conversion is passed in because the page loads the SDK bundle asynchronously.
export function deadlineOf(swap, msFromOrderSeconds) {
  try {
    return msFromOrderSeconds(swap.t1, "t1");
  } catch {
    return null;
  }
}

export function readyByOf(swap, msFromOrderSeconds) {
  try {
    return msFromOrderSeconds(swap.readyBy, "readyBy");
  } catch {
    return null;
  }
}

export function swapStateOf(row, { now = Date.now(), msFromOrderSeconds } = {}) {
  return swapState({
    side: row.side,
    status: row.status,
    deadline: deadlineOf(row.swap, msFromOrderSeconds),
    readyBy: readyByOf(row.swap, msFromOrderSeconds),
    now,
  });
}

// WHO RECEIVES THE ETH ACTION. A refund returns the deposit to the locker; a claim pays the claimer named by the
// material, falling back to the order's claimer.
export function ethRecipient(row, material) {
  return material.kind === "refund"
    ? String(material.expect.locker || "")
    : String(material.claimer || material.expect.claimer || "");
}
