// CONFIRM GIVES THE NODE THE TRANSFER THAT WAS ON THE SCREEN WHEN IT WAS PRESSED, OR NOTHING; and what a person does while
// the page waits is never undone by what it was waiting for. The built page runs whole with its own SDK (page-run.mjs)
// against a wallet, a node and a settlement chain that are the test's (page-world.mjs). Each wait of an opening, of
// Withdraw and of Confirm is held open, a person does something newer there, and the wait then ends late, or never.
//
// The expected figures are worked out by hand from the world's: a swap's XMR, less the fee of its first or second
// signature. Two transfers of one swap differ in the fee and so in what arrives, and the one that reached the node is
// named by its figures.
import assert from "node:assert/strict";
import { DEFAULT_NODE, NODES, STAGENET_NODE } from "../lib/node.js";
import { inMemory, runPage } from "./page-run.mjs";
import { KEY_ONE, KEY_TWO, xmrWorld } from "./page-world.mjs";

// Three made-up stagenet addresses of nobody.
const A = "59BTJe1ashoBYykHzijdq1BHfwnefFwN3P9mZ56skccqN1qwPZm6Jtd9rAR1Lz61ZhFSsETqBC4qA6imq4bM9yVb6mhNQiJ";
const B = "56x6pYJVqkLEVDRdZriJVaE2TBZAa9pdyiAAP4qHxTsDZAmPUG49bpbc1KTTmEJHQHiDnBTtiBzuohN6bZxSzBz2KKZkD3J";
const C = "5797khTNNY81scvAKtCq5jdiiZZZfwS7XCWYSyrTMEuK7Pfa93qPF9R8q8bTXyYV9ggiPd4GpgpUtGgKMbJQDLZD1N4tZ7d";

// WHAT THE CONFIRMATION SHOWS for each swap's first and second signature: amount, fee, what arrives; and the same fee and
// arrival in atomic units, as the node must be given them.
const SHOWS = {
  first: [
    ["2.5 XMR, the whole balance", "0.00003 XMR", "2.49997 XMR", 30_000_000n, 2_499_970_000_000n],
    ["2.5 XMR, the whole balance", "0.000041 XMR", "2.499959 XMR", 41_000_000n, 2_499_959_000_000n],
  ],
  second: [["3.25 XMR, the whole balance", "0.000033 XMR", "3.249967 XMR", 33_000_000n, 3_249_967_000_000n]],
  other: [["4 XMR, the whole balance", "0.000036 XMR", "3.999964 XMR", 36_000_000n, 3_999_964_000_000n]],
};
const ETH = { first: "0.5 ETH", second: "0.75 ETH", other: "1.25 ETH" };

const SAYS = {
  changed:
    "The address was changed while the transfer was being built, so there is no transfer to confirm. Press Withdraw XMR again",
  key: "Another Ninsei key was entered, so this transfer was put away. Press Withdraw XMR to build it again",
  unsent: "The transfer was not sent. The technical log below says why",
  unknown: "The node did not confirm the transfer, so it may have been sent. Check your wallet before trying again",
};
// THE RESULT OF A PRESS: its head and its line.
const RESULT = {
  changed: ["Not sent", "The address was changed before anything was given to the node."],
  again: ["Not sent", "Another withdrawal was started before anything was given to the node."],
  left: ["Not sent", "Another swap or key was opened before anything was given to the node."],
  key: ["Not sent", "Another Ninsei key was entered before anything was given to the node."],
  check: ["Not sent", "The check before sending did not pass, so nothing was given to the node."],
  earlier: ["Not sent", "An earlier transfer of this swap turned out to be sent, so nothing was given to the node."],
  given: [
    "Submitting",
    "The transfer is being submitted and the node has not answered. Do not close or reload this page yet.",
  ],
  sent: [
    "Sent",
    "The XMR usually shows up in your wallet within minutes and can usually be spent after about 20 minutes. You can close this tab.",
  ],
  unknown: [
    "May have been sent",
    "The node did not confirm this transfer, and the page does not send it again by itself. Look for it in your wallet or the explorer before you withdraw again.",
  ],
};
const results = (page) =>
  page.el("resultList").children.map((card) => {
    const [head, hint] = card.querySelectorAll("p").map((p) => p.textContent);
    const [to] = card.querySelectorAll("dd").map((dd) => dd.textContent);
    return [head, hint, to];
  });
const ends = (...list) => list.map(([name, to]) => [...RESULT[name], to]);

async function search(page, words) {
  assert.ok(page.type("keyWords", words), "the words cannot be typed");
  await page.press("findSwaps").ended;
  assert.match(page.text("keyCount"), /^\d+ swaps?$/, "the key's swaps");
}
async function open(page, name) {
  const act = page.open(ETH[name]);
  assert.ok(act, `the ${name} swap cannot be opened`);
  await act.ended;
  assert.ok(page.can("withdraw") && page.shown("dest"), `the ${name} swap is not ready to withdraw`);
}
const confirmation = (page) =>
  page
    .el("txInfo")
    .querySelectorAll("dd")
    .map((dd) => dd.textContent);
// Press Withdraw and wait for its end: the confirmation, which must be for this address and this signature.
async function withdraw(page, name, to, signature = 0) {
  assert.ok(page.type("dest", to), "the address cannot be typed");
  await page.press("withdraw").ended;
  shows(page, name, to, signature);
}
function shows(page, name, to, signature) {
  const [amount, fee, arrives] = SHOWS[name][signature];
  assert.ok(page.shown("confirm"), `the confirmation of the ${name} swap is gone\n${page.log()}`);
  assert.deepEqual(confirmation(page), [amount, fee, arrives, to], `the confirmation of the ${name} swap`);
}
// What the node was given is exactly the transfer of the confirmation: from this swap, to whom, how much arrives, at what fee.
function given(world, name, to, signature, what) {
  const [, , , fee, amount] = SHOWS[name][signature];
  assert.deepEqual(
    world.given.map((tx) => ({ from: tx.from, to: tx.to, amount: tx.amount, fee: tx.fee })),
    [{ from: name, to, amount, fee }],
    `${what}: the node was given something else than the one confirmed transfer`,
  );
}
async function confirms(page, world, name, to, signature, what) {
  shows(page, name, to, signature);
  const act = page.press("send");
  assert.ok(act, `${what}: Confirm cannot be pressed`);
  await act.ended;
  assert.deepEqual(results(page)[0], [...RESULT.sent, to], `${what}: the transfer sent`);
  given(world, name, to, signature, what);
}
const walletsOf = (world, name) => world.wallets.filter((wallet) => wallet.name === name);
function keepsWallet(world, name, what) {
  const own = walletsOf(world, name);
  assert.equal(own.length, 1, `${what}: the newer swap opened ${own.length} wallets`);
  assert.equal(own[0].closed, false, `${what}: the newer swap's wallet was closed`);
}
// A swap that was left keeps no wallet, and so no keys: not the one it had, nor one that opened after it was left.
async function leavesWallet(page, world, what) {
  await page.until(
    () => walletsOf(world, "first").every((wallet) => wallet.closed),
    `${what}: the left swap's wallet, with its keys, closed`,
  );
}

// SOMETHING NEWER, done while the page waits. An act answers the swap whose confirmation it made, if it made one, and the
// Withdraw it started, if it could. `why` is what it does to a transfer: "left" also closes the swap and its wallet.
const ACTS = [
  { name: "the address is changed", act: async (page) => void typed(page, B), to: B, why: "changed" },
  {
    name: "the address is changed and changed back",
    act: async (page) => {
      typed(page, B);
      typed(page, A);
    },
    to: A,
    why: "changed",
  },
  {
    name: "another withdrawal to another address",
    act: async (page) => {
      typed(page, C);
      return { again: page.press("withdraw") };
    },
    to: C,
    why: "changed",
    again: true,
  },
  {
    name: "another withdrawal to the same address",
    act: async (page) => ({ again: page.press("withdraw") }),
    to: A,
    why: "again",
    again: true,
  },
  {
    name: "another swap is opened and confirmed",
    act: async (page) => {
      await open(page, "second");
      await withdraw(page, "second", B);
      return { newer: "second" };
    },
    why: "left",
  },
  {
    name: "the same swap is opened again",
    act: (page) => open(page, "first"),
    why: "left",
  },
  {
    name: "another key is searched and its swap confirmed",
    act: async (page) => {
      await search(page, KEY_TWO);
      await open(page, "other");
      await withdraw(page, "other", B);
      return { newer: "other" };
    },
    why: "key",
    leaves: true,
  },
  { name: "the same key is searched again", act: (page) => page.press("findSwaps").ended, why: "left" },
  {
    name: "words that are no key are searched",
    act: async (page) => {
      assert.ok(page.type("keyWords", "these are not the words"));
      await page.press("findSwaps").ended;
      assert.match(page.text("keyError"), /^These are not the 12 words/);
    },
    why: "key",
    leaves: true,
  },
  { name: "words are typed", act: async (page) => void page.type("keyWords", "letter"), to: A, why: "key" },
  {
    name: "a file that is no key is chosen",
    act: (page) => page.choose("keyFile", { size: 10, text: async () => "not a key file" }).ended,
    to: A,
    why: "key",
  },
  {
    name: "a file that is still being read is chosen",
    act: async (page) => void page.choose("keyFile", { size: 10, text: () => new Promise(() => {}) }),
    to: A,
    why: "key",
  },
  {
    name: "a file that cannot be read is chosen",
    act: (page) => page.choose("keyFile", { size: 10, text: () => Promise.reject(new Error("example: gone")) }).ended,
    to: A,
    why: "key",
  },
];
for (const act of ACTS) act.leaves ||= act.why === "left";
// A wait that never ends, once for each outcome of its own: the transfer is dropped in a swap that stays, the swap is
// left, and a newer swap or key has a confirmation of its own. Everything else is asserted before the wait is let go.
const NEVER = [
  "the address is changed",
  "the same swap is opened again",
  "another swap is opened and confirmed",
  "another key is searched and its swap confirmed",
];
for (const name of NEVER)
  assert.ok(
    ACTS.some((act) => act.name === name),
    name,
  );
function typed(page, to) {
  assert.ok(page.type("dest", to), "the address cannot be changed");
}

async function started(use, options) {
  const world = await xmrWorld(options);
  return runPage(world, async (page) => {
    await search(page, KEY_ONE);
    await open(page, "first");
    return use(page, world);
  });
}

// --- while a swap is being opened ---------------------------------------------------------------------

// THE OPENING READS THE MAKER'S HALF. What is opened meanwhile is as if the first had never been: whatever the read of
// the first comes to, its address, its height and its refusal stay out of the other's step.
export async function checkOpenWaits() {
  let cases = 0;
  for (const [leave, act, name] of [
    ["another swap", (page) => open(page, "second"), "second"],
    [
      "another key",
      async (page) => {
        await search(page, KEY_TWO);
        await open(page, "other");
      },
      "other",
    ],
    ["the same swap", (page) => open(page, "first"), "first"],
  ]) {
    for (const ending of ["success", "failure", "never"]) {
      const world = await xmrWorld();
      await runPage(world, async (page) => {
        const what = `${leave} opened while the first one is read, which ends in ${ending}`;
        await search(page, KEY_ONE);
        const held = world.hold("rpc");
        const first = page.open(ETH.first);
        assert.ok(first);
        await page.until(held.reached, what);
        assert.equal(page.shown("dest"), false, `${what}: the first swap is ready before it was read`);
        await act(page);
        const before = page.text("stepSwap");
        if (ending !== "never") {
          held.release(ending === "failure" ? new TypeError("Failed to fetch") : null);
          await first.ended;
        }
        assert.equal(page.text("stepSwap"), before, `${what}: the open swap changed`);
        const { escrow } = world.swaps.find((swap) => swap.name === name).order;
        assert.ok(before.includes(escrow), `${what}: the open swap does not show itself`);
        await withdraw(page, name, A);
        await confirms(page, world, name, A, 0, what);
        cases += 1;
      });
    }
  }
  return `${cases} openings left for another swap, another key or the same swap`;
}

// --- while a transfer is being built ------------------------------------------------------------------

export async function checkWithdrawWaits() {
  let cases = 0;
  for (const wait of ["rpc", "connect", "scan", "node", "sign"]) {
    for (const { name, act, to, why, again, leaves } of ACTS) {
      for (const never of NEVER.includes(name) ? [false, true] : [false]) {
        const what = `${name} at Withdraw's "${wait}"${never ? ", which never ends" : ""}`;
        await started(async (page, world) => {
          const held = world.hold(wait);
          page.type("dest", A);
          const first = page.press("withdraw");
          assert.ok(first, `${what}: Withdraw cannot be pressed`);
          await page.until(held.reached, what);
          const did = (await act(page)) || {};
          if (again) assert.equal(did.again, false, `${what}: a second Withdraw while one is running`);
          // WHAT THE PAGE SHOWS WHILE THE WAIT STANDS, which a wait that never ends would show for good.
          if (!did.newer) {
            assert.equal(page.shown("confirm"), false, `${what}: the old transfer can be confirmed`);
            if (leaves) assert.equal(page.shown("progress"), false, `${what}: the older scan is still shown`);
          }
          if (!never) {
            held.release();
            await first.ended;
          }

          if (did.newer) {
            shows(page, did.newer, B, 0);
            keepsWallet(world, did.newer, what);
            assert.equal(page.shown("progress"), false, `${what}: the older scan is shown under the newer swap`);
            await confirms(page, world, did.newer, B, 0, what);
          } else if (why === "again" && !never) {
            // THE SECOND PRESS COULD NOT BE MADE, so the first one's transfer is the one that is confirmed.
            await confirms(page, world, "first", A, 0, what);
          } else {
            assert.equal(page.shown("confirm"), false, `${what}: the old transfer can be confirmed`);
            if (leaves) assert.equal(page.shown("progress"), false, `${what}: the older scan is still shown`);
            else if (why !== "again") assert.equal(page.text("withdrawError"), SAYS[why], what);
            // A signature that comes back for a transfer that was dropped is dropped with it.
            if (why !== "again") assert.ok(!page.log().includes("the transfer is signed"), `${what}: signed and kept`);
            if (!leaves && !never) {
              const second = page.press("withdraw");
              assert.ok(second, `${what}: Withdraw cannot be pressed again`);
              await second.ended;
              // A signature that was running when the transfer was dropped is the first one: the new one is the second.
              await confirms(page, world, "first", to, wait === "sign" ? 1 : 0, what);
              assert.equal(world.wallets.length, 1, `${what}: the scan was run again`);
            } else assert.deepEqual(world.given, [], `${what}: the node was given a transfer`);
          }
          if (leaves && !(never && wait === "connect")) await leavesWallet(page, world, what);
          cases += 1;
        });
      }
    }
  }
  return `${cases} cases: no confirmation for a transfer that was dropped, and the newer swap or key keeps its own`;
}

// --- from Confirm to the node's answer ----------------------------------------------------------------

export async function checkConfirmWaits() {
  let cases = 0;
  for (const wait of ["rpc", "node"]) {
    for (const { name, act, to, why, again, leaves } of ACTS) {
      for (const never of NEVER.includes(name) ? [false, true] : [false]) {
        const what = `${name} at Confirm's "${wait}"${never ? ", which never ends" : ""}`;
        await started(async (page, world) => {
          await withdraw(page, "first", A);
          const held = world.hold(wait);
          const sent = page.press("send");
          assert.ok(sent, `${what}: Confirm cannot be pressed`);
          await page.until(held.reached, what);
          assert.equal(page.press("send"), false, `${what}: Confirm can be pressed twice`);
          assert.equal(page.text("progressHead"), "Checking the transfer with the node", `${what}: what the page says`);
          const did = (await act(page)) || {};
          // SAID AT ONCE, not when the wait ends: nothing was given to the node, and nothing will be.
          const unsent = ends([why, A]);
          assert.deepEqual(results(page), unsent, `${what}: the press is not said as not sent`);
          if (!never) {
            held.release();
            await sent.ended;
          }
          assert.deepEqual(world.given, [], `${what}: the node was given a transfer`);
          assert.deepEqual(results(page), unsent, `${what}: the old press ended twice`);
          assert.ok(!page.text("withdrawError").includes("may have been sent"), `${what}: said as unknown`);

          if (did.newer) {
            keepsWallet(world, did.newer, what);
            assert.equal(page.shown("progress"), false, `${what}: the old press is shown under the newer swap`);
            assert.equal(page.text("keyCount"), did.newer === "other" ? "1 swap" : "2 swaps", `${what}: the list`);
            await confirms(page, world, did.newer, B, 0, what);
          } else if (leaves) {
            assert.equal(page.shown("confirm"), false, `${what}: the old transfer can be confirmed`);
          } else {
            if (again) await did.again.ended;
            else {
              assert.equal(page.shown("confirm"), false, `${what}: the old confirmation stayed`);
              if (why === "key") assert.equal(page.text("withdrawError"), SAYS.key, what);
              await page.press("withdraw").ended;
            }
            await confirms(page, world, "first", to, 1, what);
          }
          if (leaves) await leavesWallet(page, world, what);
          cases += 1;
        });
      }
    }
  }
  // A CONFIRMATION THAT STANDS, not pressed: anything newer puts it away too, and no press was made, so no result.
  for (const { name, act, to, why, again, leaves } of ACTS) {
    const what = `${name} at a confirmation`;
    await started(async (page, world) => {
      await withdraw(page, "first", A);
      const did = (await act(page)) || {};
      assert.deepEqual(results(page), [], `${what}: a result without a press`);
      if (did.newer) return confirms(page, world, did.newer, B, 0, what);
      if (again) await did.again.ended;
      else assert.equal(page.shown("confirm"), false, `${what}: the old confirmation stayed`);
      if (leaves) return leavesWallet(page, world, what);
      if (!again) {
        assert.equal(page.text("withdrawError"), why === "key" ? SAYS.key : "", what);
        await page.press("withdraw").ended;
      }
      await confirms(page, world, "first", to, 1, what);
    });
    cases += 1;
  }
  // AT ONCE: Find ends the open swap before the key it searches has been read, which for a key file takes a while; with
  // the key that is open, and with another one that was typed.
  for (const words of [null, KEY_TWO]) {
    await started(async (page, world) => {
      const what = `Find ${words ? "of another key" : "of the same key"} at Confirm`;
      await withdraw(page, "first", A);
      const held = world.hold("node");
      const sent = page.press("send");
      await page.until(held.reached, what);
      if (words) page.type("keyWords", words);
      page.press("findSwaps");
      assert.deepEqual(
        results(page),
        ends([words ? "key" : "left", A]),
        `${what}: the press goes on while its key is read`,
      );
      assert.equal(page.shown("stepSwap"), false, `${what}: the old swap stays open while its key is read`);
      held.release();
      await sent.ended;
      assert.deepEqual(world.given, [], `${what}: the press gave the transfer`);
      cases += 1;
    });
  }
  // A FIELD THAT CHANGED WITHOUT AN EVENT (an extension, an autofill) is read, not remembered: before Confirm and
  // while it waits, the transfer on the screen is then not the one for the address in the field.
  for (const before of [true, false]) {
    await started(async (page, world) => {
      const what = `the field holds another address ${before ? "before" : "while"} Confirm`;
      await withdraw(page, "first", A);
      if (before) page.el("dest").value = B;
      const held = world.hold("node");
      const sent = page.press("send");
      assert.ok(sent);
      if (!before) {
        await page.until(held.reached, what);
        page.el("dest").value = B;
      }
      held.release();
      await sent.ended;
      assert.deepEqual(world.given, [], what);
      assert.equal(page.shown("confirm"), false, what);
      assert.equal(page.text("withdrawError"), SAYS.changed, what);
      assert.deepEqual(results(page), ends(["changed", A]), what);
      cases += 1;
    });
  }
  // ONE PRESS, ONE TRANSFER, even when the browser delivers the press twice.
  await started(async (page, world) => {
    await withdraw(page, "first", A);
    const sent = page.press("send");
    await page.el("send").fire("click");
    await sent.ended;
    given(world, "first", A, 0, "one press, delivered twice");
    assert.deepEqual(results(page), ends(["sent", A]));
    cases += 1;
  });
  return `${cases} cases: anything newer ends the transfer, nothing is given, and a press is said as not sent with why`;
}

// --- the node has it, and its answer ------------------------------------------------------------------

export async function checkNodeAnswer() {
  const id = "000000000000000000000000000000000000000000000000000000005e4d0001";
  const LIMIT = 240_000;
  for (const [relay, end, said] of [
    ["ok", "sent", ""],
    ["lost", "unknown", SAYS.unknown],
    ["no-id", "unknown", SAYS.unknown],
  ]) {
    await started(async (page, world) => {
      const what = `a relay that answers "${relay}"`;
      world.relay = relay;
      const fingerprint = page.text("keyPrint");
      // Words of another key, typed before this withdrawal and not searched, are not this transfer's to wipe.
      assert.ok(page.type("keyWords", KEY_TWO), what);
      await withdraw(page, "first", A);
      const held = world.hold("relay");
      const sent = page.press("send");
      await page.until(held.reached, what);
      // SHOWN FROM THE HAND-OFF ON, with what is not known yet.
      assert.deepEqual(results(page), ends(["given", A]), `${what}: the attempt is not shown`);
      assert.equal(page.el("resultList").querySelectorAll("a").length, 0, `${what}: a transaction nobody named`);
      assert.equal(page.text("progressHead"), "Submitting the transfer", `${what}: the sending is not shown`);
      given(world, "first", A, 0, what);
      // NOTHING NEWER CAN BE STARTED while the node holds the transfer, whatever a person tries.
      assert.equal(page.type("dest", B), false, `${what}: the address can be changed`);
      assert.equal(page.press("withdraw"), false, `${what}: Withdraw can be pressed`);
      assert.equal(page.press("send"), false, `${what}: Confirm can be pressed`);
      assert.equal(page.open(ETH.second), false, `${what}: another swap can be opened`);
      assert.equal(page.type("keyWords", KEY_TWO), false, `${what}: another key can be typed`);
      assert.equal(page.press("findSwaps"), false, `${what}: a search can be started`);
      assert.equal(page.choose("keyFile", { size: 10, text: async () => "x" }), false, `${what}: a key file`);
      held.release();
      await sent.ended;
      assert.deepEqual(results(page), ends([end, A]), what);
      given(world, "first", A, 0, what);
      assert.equal(page.text("withdrawError"), said, what);
      assert.equal(page.shown("confirm"), false, `${what}: the confirmation stayed`);
      const head =
        relay === "ok"
          ? "The XMR of this swap was sent from this page"
          : "The XMR of this swap may have been sent. Look for it in your wallet before you withdraw again";
      assert.equal(page.text("moneyHead"), head, `${what}: what the page says of the money`);
      // THE TRANSACTION'S ID, by its link and in the log, whether the answer came or was lost.
      const links = page
        .el("resultList")
        .querySelectorAll("a")
        .map((a) => a.href);
      assert.deepEqual(links, ["https://stagenet.xmrchain.net/tx/" + id], `${what}: the transaction's link`);
      assert.ok(page.log().includes(id), `${what}: the log does not name the transaction`);

      assert.equal(page.el("keyWords").value, KEY_TWO, `${what}: the end of a send wiped the words of another key`);
      // THE RESULT STAYS when another swap or key is opened, named by its own key, and the rest opens again.
      if (relay === "ok") assert.equal(page.text("keyPrint"), "", `${what}: the key stayed in the tab`);
      else {
        await open(page, "second");
        assert.deepEqual(results(page), ends([end, A]), `${what}: another swap took the result away`);
      }
      await search(page, KEY_TWO);
      assert.deepEqual(results(page), ends([end, A]), `${what}: another key took the result away`);
      const whose = page
        .el("resultList")
        .querySelectorAll("dd")
        .map((dd) => dd.textContent);
      assert.ok(fingerprint && whose.includes(fingerprint), `${what}: the result does not say whose it is`);
      assert.notEqual(page.text("keyPrint"), fingerprint, `${what}: the other key is the same`);
      assert.ok(page.text("results").includes("A reload clears it"), `${what}: the page promises more than it keeps`);
    });
  }

  // NO ANSWER IN TIME IS UNKNOWN, one millisecond before it is still waiting; what can be started opens again, nothing is
  // sent by itself, and an answer that still comes ends its own result and touches nothing newer.
  const UNSURE = "The XMR of this swap may have been sent. Look for it in your wallet before you withdraw again";
  for (const [late, newer, words] of [
    ["ok", "second"],
    ["ok", "other", KEY_TWO],
    ["lost", "second"],
    ["never", "second"],
  ]) {
    await started(async (page, world) => {
      const what = `no answer in time, then "${late}", with ${newer} open`;
      world.relay = late;
      await withdraw(page, "first", A);
      const held = world.hold("relay");
      const sent = page.press("send");
      await page.until(held.reached, what);
      await page.advance(LIMIT - 1);
      assert.deepEqual(results(page), ends(["given", A]), `${what}: before the limit`);
      assert.equal(page.can("findSwaps"), false, `${what}: before the limit`);
      await page.advance(1);
      assert.deepEqual(results(page), ends(["unknown", A]), `${what}: at the limit`);
      await sent.ended;
      assert.equal(page.text("withdrawError"), SAYS.unknown, what);
      assert.equal(page.text("moneyHead"), UNSURE, `${what}: what the page says of the money`);
      assert.match(page.log(), /has not answered for 4 minutes/, what);
      if (words) await search(page, words);
      await open(page, newer);
      await withdraw(page, newer, B);
      if (late !== "never") {
        held.release();
        await world.quiet();
      }
      assert.deepEqual(results(page), ends([late === "ok" ? "sent" : "unknown", A]), `${what}: the late answer`);
      const links = page
        .el("resultList")
        .querySelectorAll("a")
        .map((a) => a.href);
      assert.deepEqual(links, late === "never" ? [] : ["https://stagenet.xmrchain.net/tx/" + id], what);
      shows(page, newer, B, 0);
      keepsWallet(world, newer, what);
      assert.equal(page.text("keyCount"), words ? "1 swap" : "2 swaps", `${what}: the key and its list`);
      given(world, "first", A, 0, what);
    });
  }
  // A LATE SUCCESS OF THE SWAP THAT IS STILL OPEN ends what it contradicts: the warning, a confirmation and a running
  // Withdraw or Confirm of the same swap, and its key. Words typed for another key stay, and so does a newer transfer the
  // node already has: its own answer ends it. Nothing more is given to the node.
  for (const meanwhile of [
    "nothing",
    "words are typed",
    "another confirmation",
    "a Confirm is running",
    "a Withdraw is running",
  ]) {
    await started(async (page, world) => {
      const what = `a late success, when meanwhile ${meanwhile}`;
      const fingerprint = page.text("keyPrint");
      assert.ok(fingerprint, what);
      await withdraw(page, "first", A);
      const held = world.hold("relay");
      const sent = page.press("send");
      await page.until(held.reached, what);
      await page.advance(LIMIT);
      await sent.ended;
      assert.ok(page.can("withdraw"), `${what}: a transfer that may have been sent closes the swap`);
      let waiting = null;
      if (meanwhile === "words are typed") assert.ok(page.type("keyWords", "letter"));
      if (meanwhile === "another confirmation" || meanwhile === "a Confirm is running") {
        await withdraw(page, "first", B, 1);
        // The balance was read again, so what the wallet holds is known again.
        assert.equal(page.text("moneyHead"), "The XMR of this swap can be withdrawn", `${what}: the head`);
      }
      if (meanwhile === "a Confirm is running") {
        const node = world.hold("node");
        const second = page.press("send");
        await page.until(node.reached, what);
        waiting = { release: () => node.release(), ended: second.ended };
      }
      if (meanwhile === "a Withdraw is running") {
        page.type("dest", B);
        const sign = world.hold("sign");
        const second = page.press("withdraw");
        await page.until(sign.reached, what);
        waiting = { release: () => sign.release(), ended: second.ended };
      }
      held.release();
      await world.quiet();
      const unsent = meanwhile === "a Confirm is running" ? [["earlier", B]] : [];
      assert.deepEqual(results(page), ends(...unsent, ["sent", A]), `${what}: the late answer`);
      assert.equal(page.shown("stepSwap"), false, `${what}: the swap is still open`);
      assert.equal(page.shown("confirm"), false, `${what}: a second Confirm stands`);
      assert.equal(page.can("send"), false, `${what}: a second Confirm can be pressed`);
      for (const id of ["withdrawError", "moneyHead", "resultList", "keyError"])
        assert.ok(!page.text(id).includes("may have been sent"), `${what}: the warning stands in ${id}`);
      assert.equal(page.text("keyPrint"), "", `${what}: the key stayed`);
      assert.equal(page.el("keyWords").value, meanwhile === "words are typed" ? "letter" : "", `${what}: the words`);
      assert.ok(
        walletsOf(world, "first").every((wallet) => wallet.closed),
        `${what}: the wallet stayed open`,
      );
      if (waiting) {
        waiting.release();
        await waiting.ended;
        await world.quiet();
        assert.equal(page.shown("confirm"), false, `${what}: a transfer was built for it later`);
        assert.equal(page.text("withdrawError"), "", `${what}: said under a swap that is closed`);
      }
      given(world, "first", A, 0, what);
      // The rest of the page is open: another key can be entered and its swap withdrawn.
      page.type("keyWords", "");
      await search(page, KEY_TWO);
      await open(page, "other");
      await withdraw(page, "other", C);
    });
  }
  // A NEWER TRANSFER THE NODE HAS, of the same swap: the first one's late success leaves it to its own answer.
  await started(async (page, world) => {
    const what = "a late success while a newer transfer is with the node";
    await withdraw(page, "first", A);
    const held = world.hold("relay");
    const sent = page.press("send");
    await page.until(held.reached, what);
    await page.advance(LIMIT);
    await sent.ended;
    await withdraw(page, "first", B, 1);
    const second = world.hold("relay");
    const again = page.press("send");
    await page.until(second.reached, what);
    held.release();
    await world.quiet();
    assert.deepEqual(results(page), ends(["given", B], ["sent", A]), what);
    assert.equal(page.can("findSwaps"), false, `${what}: the newer transfer was let go`);
    second.release();
    await again.ended;
    assert.deepEqual(results(page), ends(["sent", B], ["sent", A]), what);
    assert.equal(page.text("keyPrint"), "", `${what}: the key stayed`);
  });

  // A NODE THAT DOES NOT ANSWER CONFIRM'S READ, answers short, or shows the XMR spent: nothing is given, the press is a
  // result of its own, and the same confirmation can be pressed again. Once the node answers, that gives one transfer.
  for (const mode of ["lost", "short", "spent"]) {
    await started(async (page, world) => {
      const what = `a node that is "${mode}" at Confirm`;
      await withdraw(page, "first", A);
      world.node.mode = mode;
      await page.press("send").ended;
      assert.equal(page.text("withdrawError"), SAYS.unsent, what);
      assert.deepEqual(world.given, [], what);
      assert.deepEqual(results(page), ends(["check", A]), `${what}: the press has no result`);
      assert.ok(!/may have been sent/.test(page.log()), `${what}: the log says it may have been sent`);
      world.node.mode = "ok";
      await confirms(page, world, "first", A, 0, what);
      assert.deepEqual(results(page), ends(["sent", A], ["check", A]), `${what}: one result for each press`);
    });
  }
  // The same at Withdraw's own read: nothing is signed.
  for (const mode of ["lost", "short", "spent"]) {
    await started(async (page, world) => {
      world.node.mode = mode;
      page.type("dest", A);
      await page.press("withdraw").ended;
      assert.equal(page.text("withdrawError"), "The transfer could not be built. The technical log below says why");
      assert.equal(world.swaps[0].signed, 0, `a node that is "${mode}" at Withdraw: something was signed`);
      assert.equal(page.shown("confirm"), false);
    });
  }
  return "given, sent, lost, unnamed and silent answers, each with what is known, and one result for each press";
}

// --- the key's own steps ------------------------------------------------------------------------------

// A SEARCH BELONGS TO ITS KEY. While one is read, its node is changed (which checks the page again): the search cannot
// be started twice, and a search replaced by another writes no row into it.
export async function checkSearchWaits() {
  const world = await xmrWorld();
  await runPage(world, async (page) => {
    const held = world.hold("head");
    page.type("keyWords", KEY_ONE);
    const found = page.press("findSwaps");
    await page.until(held.reached, "the search reading the chain");
    page.node(NODES[1]);
    await world.quiet();
    assert.equal(page.can("findSwaps"), false, "a change of node let a second search start beside the first");
    assert.equal(page.type("keyWords", KEY_TWO), false, "words can be typed under a search that is running");
    held.release();
    await found.ended;
    assert.equal(page.text("keyCount"), "2 swaps", "the first key's swaps");
    assert.ok(page.can("findSwaps"), "the search did not open again");
  });

  // "Search again" for one key, left for another key: its late answer adds nothing to the other's list.
  const two = await xmrWorld();
  await runPage(two, async (page) => {
    two.failLogs = true;
    page.type("keyWords", KEY_ONE);
    await page.press("findSwaps").ended;
    assert.ok(page.shown("keyMore"), "a search that can be repeated");
    two.failLogs = false;
    const held = two.hold("head");
    const more = page.press("keyMore");
    await page.until(held.reached, "the repeated search");
    await search(page, KEY_TWO);
    held.release();
    await more.ended;
    assert.equal(page.text("keyCount"), "1 swap", "the left search changed the other key's list");
    assert.deepEqual(
      page.el("swapList").children.map((li) => li.textContent.includes(ETH.other)),
      [true],
      "the left search put its rows under the other key",
    );
  });

  // WHAT IS ENTERED LAST IS THE KEY. A chosen file empties the words at once, also while it is read and when it cannot be
  // read, and Find is closed until it is; words typed meanwhile are the key again, and the late file says nothing.
  for (const reads of ["late", "never", "not at all"]) {
    const three = await xmrWorld();
    await runPage(three, async (page) => {
      const what = `a key file that is read ${reads}`;
      let give;
      const text =
        reads === "not at all" ? () => Promise.reject(new Error("example")) : () => new Promise((r) => (give = r));
      page.type("keyWords", KEY_ONE);
      const chosen = page.choose("keyFile", { size: 10, text });
      assert.equal(page.el("keyWords").value, "", `${what}: the words it replaces stayed`);
      if (reads === "not at all") {
        await chosen.ended;
        assert.equal(page.text("keyError"), "The file could not be read. Choose it again", what);
        assert.equal(page.el("keyWords").value, "", `${what}: the words came back`);
        assert.equal(page.press("findSwaps"), false, `${what}: a key is searched in its place`);
        assert.equal(page.text("keyError"), "The file could not be read. Choose it again", `${what}: its refusal went`);
      } else assert.equal(page.press("findSwaps"), false, `${what}: Find searches a key that was replaced`);
      assert.ok(page.type("keyWords", KEY_TWO), what);
      if (reads === "late") {
        give("not a key file");
        await chosen.ended;
      }
      assert.equal(page.el("keyWords").value, KEY_TWO, `${what}: the words typed after it are gone`);
      assert.equal(page.shown("keyError"), false, `${what}: it was refused under the words typed after it`);
      await page.press("findSwaps").ended;
      assert.equal(page.text("keyCount"), "1 swap", `${what}: another key was searched`);
    });
  }
  // A FILE THAT FAILS UNDER THE ANSWER OF AN EARLIER SEARCH keeps its refusal, and Find does not search that earlier key
  // again: not in this press, not in one the browser delivers late. Choosing nothing, or typing, is the person's way on.
  for (const [how, file, refusal] of [
    ["is no key file", { size: 10, text: async () => "not a key file" }, "This is not a Ninsei key file"],
    [
      "cannot be read",
      { size: 10, text: () => Promise.reject(new Error("example")) },
      "The file could not be read. Choose it again",
    ],
    ["is too large", { size: 10_000_000, text: async () => "" }, "This file is too large to be a Ninsei key file"],
  ]) {
    await started(async (page) => {
      const what = `a file that ${how} after a search`;
      assert.equal(page.text("keyCount"), "2 swaps", what);
      const open = page.choose("keyFile", file);
      await open.ended;
      for (const press of ["none", "pressed", "delivered late"]) {
        if (press === "pressed") assert.equal(page.press("findSwaps"), false, `${what}: Find can be pressed`);
        if (press === "delivered late") await page.el("findSwaps").fire("click");
        assert.equal(page.text("keyError"), refusal, `${what}: its refusal, ${press}`);
        assert.equal(page.text("keyCount"), "2 swaps", `${what}: the earlier key was searched again, ${press}`);
      }
      assert.ok(page.choose("keyFile", null), what);
      assert.equal(page.text("keyError"), "", `${what}: cleared by choosing nothing`);
      await page.press("findSwaps").ended;
      assert.equal(page.text("keyCount"), "2 swaps", `${what}: an intentional search of the same key`);
      await page.choose("keyFile", file).ended;
      assert.ok(page.type("keyWords", KEY_TWO), what);
      await page.press("findSwaps").ended;
      assert.equal(page.text("keyCount"), "1 swap", `${what}: words typed after it`);
    });
  }
  return "a search is one at a time, a left one adds no row, and the key is what was entered last";
}

// THE WALLET READS THE NODE AND THE HEIGHT THE PAGE SHOWS, from the press of Withdraw on.
export async function checkNodeAndHeight() {
  await started(async (page, world) => {
    assert.deepEqual(
      page.nodeShown(),
      { radio: STAGENET_NODE, line: "xmr-stagenet.ninsei.finance" },
      "the node the page chose for a testnet swap is not the one the list shows",
    );
    const held = world.hold("rpc");
    page.type("dest", A);
    const first = page.press("withdraw");
    await page.until(held.reached, "Withdraw waiting before its wallet is built");
    assert.equal(page.node(DEFAULT_NODE), false, "the node can be changed under a withdrawal");
    held.release();
    await first.ended;
    shows(page, "first", A, 0);
    assert.deepEqual(
      world.wallets.map((wallet) => wallet.node),
      [STAGENET_NODE],
    );
    assert.deepEqual(page.nodeShown(), { radio: STAGENET_NODE, line: "xmr-stagenet.ninsei.finance" });
  });
  // A Withdraw that stopped before its wallet opened gives the choice back.
  await started(async (page, world) => {
    page.type("dest", "not an address");
    await page.press("withdraw").ended;
    assert.deepEqual(world.wallets, []);
    assert.ok(page.node(NODES[1]), "a withdrawal that stopped keeps the node closed");
  });
  // A node that is chosen and has not answered is not the one that answered before it.
  await started(async (page, world) => {
    const held = world.hold("probe " + DEFAULT_NODE);
    page.node(DEFAULT_NODE);
    await page.until(held.reached, "the chosen node being asked");
    page.type("dest", A);
    await page.press("withdraw").ended;
    assert.equal(
      page.text("withdrawError"),
      "No node is answering. Press Change next to Monero node and pick another one",
      "another node's answer was taken for the chosen one's",
    );
    assert.deepEqual(world.wallets, [], "a wallet was opened on a node that has not answered");
  });
  // A NODE LEFT AND CHOSEN AGAIN: the answer to the first question does not stand over the answer to the second.
  await started(async (page, world) => {
    page.node(DEFAULT_NODE);
    await world.quiet();
    const first = world.hold("probe " + STAGENET_NODE);
    page.node(STAGENET_NODE);
    await page.until(first.reached, "the first question");
    page.node(DEFAULT_NODE);
    await world.quiet();
    page.node(STAGENET_NODE);
    await world.quiet();
    const line = () => page.el("checkNode").dataset.state;
    assert.equal(line(), "ok", "the node that was asked again");
    first.release(new TypeError("Failed to fetch"));
    await world.quiet();
    assert.equal(line(), "ok", "an older answer of the same node was painted over the newer one");
    await withdraw(page, "first", A);
  });
  // A SWAP WHOSE START BLOCK THE CHAIN DID NOT GIVE asks for one; the wallet is restored from it, and a changed one is
  // another scan.
  const world = await xmrWorld();
  await runPage(world, async (page) => {
    world.node.mode = "no-headers";
    await search(page, KEY_ONE);
    world.node.mode = "ok";
    await open(page, "first");
    assert.ok(page.shown("heightBox"), "a swap without a start block does not ask for one");
    page.type("dest", A);
    await page.press("withdraw").ended;
    assert.match(page.text("withdrawError"), /^Enter the swap's start block/);
    assert.deepEqual(world.wallets, [], "a wallet was opened without a start block");
    assert.ok(page.type("restoreHeight", "1999905"));
    const held = world.hold("rpc");
    const first = page.press("withdraw");
    await page.until(held.reached, "Withdraw waiting before its wallet is built");
    assert.equal(page.type("restoreHeight", "1"), false, "the height can be changed under a withdrawal");
    held.release();
    await first.ended;
    shows(page, "first", A, 0);
    assert.ok(page.type("restoreHeight", "1999900"));
    await page.press("withdraw").ended;
    shows(page, "first", A, 1);
    assert.deepEqual(
      world.wallets.map(({ height, closed }) => [height, closed]),
      [
        [1_999_905, true],
        [1_999_900, false],
      ],
      "the changed start block was not scanned",
    );
  });
  // A WALLET THE LIBRARY MADE AND THEN COULD NOT SET UP is closed, by the swap that is still open and by one that was left.
  for (const left of [false, true]) {
    await started(async (page, world) => {
      const what = `a wallet that opens in part${left ? ", of a swap that was left" : ""}`;
      world.partlyOpens = true;
      const held = world.hold("connect");
      page.type("dest", A);
      const first = page.press("withdraw");
      await page.until(held.reached, what);
      if (left) await open(page, "second");
      held.release();
      await first.ended;
      assert.equal(world.wallets.length, 1, what);
      assert.equal(world.wallets[0].closed, true, `${what}: it stayed open, with its keys`);
      if (!left) assert.match(page.text("withdrawError"), /^The wallet could not connect/);
      world.partlyOpens = false;
      const name = left ? "second" : "first";
      await withdraw(page, name, A);
      await confirms(page, world, name, A, 0, what);
    });
  }
  return "the list shows the node the wallet reads, an older answer does not stand, and the start block is the person's";
}

// --- what the page keeps and says -----------------------------------------------------------------------

// A SWAP THAT WAS LEFT KEEPS NO KEY, looked for in the memory of the whole process: the swap's spend key is there while
// its wallet is open, and nowhere once the swap is left, whatever was signed, dropped or still being built. Each case has
// keys of its own, so it sees no other run's.
export async function checkLeftKeepsNothing() {
  let cases = 0;
  for (const [name, upTo, leave] of [
    ["a confirmation", (page) => withdraw(page, "first", A), (page) => open(page, "second")],
    [
      "a signed transfer that was dropped",
      async (page) => {
        await withdraw(page, "first", A);
        typed(page, B);
      },
      (page) => search(page, KEY_TWO),
    ],
    [
      "a signature that returns after the swap was left",
      async (page, world) => {
        const held = world.hold("sign");
        page.type("dest", A);
        const act = page.press("withdraw");
        await page.until(held.reached, "the signature");
        return { held, act };
      },
      (page) => open(page, "second"),
    ],
    [
      "a transfer whose answer was lost",
      async (page, world) => {
        world.relay = "lost";
        await withdraw(page, "first", A);
        await page.press("send").ended;
      },
      (page) => search(page, KEY_TWO),
    ],
    [
      "a transfer that was sent",
      async (page) => withdraw(page, "first", A),
      async (page) => {
        await page.press("send").ended;
      },
    ],
    [
      "a transfer whose success came late",
      async (page, world) => {
        await withdraw(page, "first", A);
        const held = world.hold("relay");
        const sent = page.press("send");
        await page.until(held.reached, "the relay");
        await page.advance(240_000);
        await sent.ended;
        return { held, act: { ended: Promise.resolve() } };
      },
      async () => {},
    ],
  ]) {
    await started(
      async (page, world) => {
        const { keyDigest } = world.swaps[0];
        const running = await upTo(page, world);
        assert.equal(inMemory(keyDigest), true, `${name}: the check does not see a key that is held`);
        await leave(page, world);
        if (running) {
          running.held.release();
          await running.act.ended;
        }
        await world.quiet();
        assert.equal(inMemory(keyDigest), false, `${name}: the left swap's spend key is still in memory`);
      },
      { from: 100 * (cases += 1) },
    );
  }
  return `${cases} ways to leave a swap: its spend key is nowhere in memory after each`;
}

// NO TEXT OF A WALLET, A NODE OR AN RPC IS SHOWN, LOGGED OR KEPT. Whatever one says, in any language or spelling, with the
// words, a half, a transaction or an ordinary sentence in it, reaches neither the log, the page nor the window: the page
// says that the step failed, by its own words and a code's name.
export async function checkCauses() {
  const half = "c3".repeat(32);
  const spoken = KEY_ONE.split(" ");
  const quotes = [
    `zebra refuses ${KEY_ONE}`,
    `zebra dit: ${spoken.map((word, i) => `le mot ${i} est ${word}`).join(", puis ")}`,
    `zebra ${spoken.join("-")} ${spoken.slice(2, 7).reverse().join(" / ")}`,
    `zebra 0x${half.toUpperCase()} ${Buffer.from(half, "hex").toString("base64")} ${BigInt("0x" + half)}`,
  ];
  let cases = 0;
  for (const [wait, act] of [
    ["head", "find"],
    ["rpc", "open"],
    ["connect", "withdraw"],
    ["scan", "withdraw"],
    ["sign", "withdraw"],
    ["node", "withdraw"],
    ["wallet", "send"],
    ["relay", "send"],
  ]) {
    for (const quote of quotes) {
      const world = await xmrWorld();
      await runPage(world, async (page) => {
        const what = `${act}'s "${wait}" fails: ${quote.slice(0, 24)}`;
        let step;
        let held;
        if (act === "find") {
          held = world.hold(wait);
          page.type("keyWords", KEY_ONE);
          step = page.press("findSwaps");
        } else {
          await search(page, KEY_ONE);
          if (act === "open") held = world.hold(wait);
          else await open(page, "first");
          if (act === "open") step = page.open(ETH.first);
          else {
            if (act === "send") await withdraw(page, "first", A);
            else page.type("dest", A);
            held = world.hold(wait);
            step = page.press(act);
          }
        }
        await page.until(held.reached, what);
        const error = Object.assign(new Error(quote), { name: quote, data: { text: quote } });
        held.release(error);
        await step.ended;
        await world.quiet();
        for (const [where, text] of [
          ["log", page.log()],
          ["page", page.root.querySelector("main").textContent],
        ]) {
          assert.ok(!text.includes("zebra"), `${what}: the ${where} holds the text\n${text}`);
          for (const word of new Set(spoken))
            assert.ok(!text.split(/\W+/).includes(word), `${what}: the ${where} holds "${word}"`);
          assert.ok(!text.toLowerCase().includes(half), `${what}: the ${where} holds a half`);
        }
        assert.deepEqual(Object.keys(page.window).sort(), ["document", "ethereum", "location"], `${what}: the window`);
        cases += 1;
      });
    }
  }
  // WHAT IS SAID INSTEAD, by the page's own words: the step, the SDK's code and the names it gave.
  await started(async (page, world) => {
    const held = world.hold("connect");
    page.type("dest", A);
    const step = page.press("withdraw");
    await page.until(held.reached, "the wallet being opened");
    held.release(new Error("zebra"));
    await step.ended;
    assert.match(page.log(), /the wallet did not connect: /);
    assert.match(page.log(), /surface|no code was given/);
  });
  return `${cases} failures that quote what they were given: none of it reaches the log, the page or the window`;
}

if (import.meta.main) {
  // The memory of a process is looked for first: a small heap is read in a moment, and a check before it leaves more.
  for (const check of [
    checkLeftKeepsNothing,
    checkOpenWaits,
    checkWithdrawWaits,
    checkConfirmWaits,
    checkNodeAnswer,
    checkSearchWaits,
    checkNodeAndHeight,
    checkCauses,
  ])
    console.log("ok    " + (await check()));
}
