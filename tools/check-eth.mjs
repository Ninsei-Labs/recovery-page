// THE ETH SIDE OF THE PAGE, FROM A FOUND ROW TO ONE TRANSACTION. The built page runs whole with the SDK it ships
// (page-run.mjs): no function of either is put in by the check. The key, the settlement chain, the Monero node, the
// clock and the EVM wallet are the test's (page-world.mjs), and the wallet starts on another network, which is what a
// person's wallet does.
//
// What a transaction must be is written here by hand, from the escrow's interface: `refund(bytes32)` and
// `claim(bytes32)` with the order's own half, to the order's escrow, on the order's network.
import assert from "node:assert/strict";
import { CHAINS } from "@ninsei-labs/sdk/networks";
import { SETTLEMENT, keyNetworks } from "../lib/settlement.js";
import { inMemory, runPage } from "./page-run.mjs";
import { KEY_ONE, KEY_TWO, digest, ethWorld, eventLog } from "./page-world.mjs";

const REFUND = "0x7249fbb6";
const CLAIM = "0xbd66528a";

// EVERY NETWORK THE PAGE LISTS SWAPS FROM, with what a wallet must be offered for it and asked on it. A network the page
// lists and this table does not name fails here until its line is written.
const EXPECTED = {
  "arbitrum-sepolia": {
    hex: "0x66eee",
    explorer: "https://sepolia.arbiscan.io/tx/",
    rpcs: [
      "https://sepolia-rollup.arbitrum.io/rpc",
      "https://arbitrum-sepolia-rpc.publicnode.com",
      "https://arbitrum-sepolia.drpc.org",
    ],
  },
};
function networks() {
  const listed = keyNetworks(CHAINS).search;
  assert.ok(listed.length > 0, "the page lists swaps from no network");
  return listed.map(({ id, chainId, factories }) => {
    assert.ok(EXPECTED[id], `the page lists swaps from ${id}, which this check does not cover`);
    assert.equal(SETTLEMENT[id].chainId, chainId);
    return { id, chainId, factory: factories.at(-1).address, ...EXPECTED[id] };
  });
}

const ETH = { refund: "0.6 ETH", claim: "0.8 ETH", again: "0.9 ETH", other: "1.1 ETH" };
const SAYS = {
  checking: ["Checking the order", "Nothing has been given to your wallet yet"],
  asking: ["Waiting for your wallet", "Confirm or decline it in your wallet"],
  waiting: ["ETH transaction sent", "Sent. Waiting for the network to confirm it"],
  unknown: ["ETH transaction sent", "Not known: no confirmation was read in time"],
  elsewhere: [
    "ETH transaction sent",
    "Sent. Your wallet is on another network, so its confirmation cannot be read. Switch it to Arbitrum Sepolia to check",
  ],
  lost: [
    "ETH transaction may have been sent",
    "Not known: the wallet gave no clear answer. This page does not send it again",
  ],
  refund: ["ETH transaction confirmed", "Refunded: the ETH went back to the order's locker"],
  claim: ["ETH transaction confirmed", "Claimed: the ETH was sent to the order's claimer"],
};
const LOST = "The wallet gave no clear answer, so the transaction may have been sent";

async function search(page, words) {
  assert.ok(page.type("keyWords", words));
  await page.press("findSwaps").ended;
  assert.match(page.text("keyCount"), /^\d+ swaps?$/, "the key's swaps");
}
async function open(page, name) {
  const act = page.open(ETH[name]);
  assert.ok(act, `the ${name} row cannot be opened`);
  await act.ended;
  assert.equal(page.text("ethError"), "", `the ${name} action was not prepared\n${page.log()}`);
  assert.ok(page.shown("ethFacts"), `the ${name} action was not prepared\n${page.log()}`);
}
async function connect(page) {
  const act = page.press("ethConnect");
  assert.ok(act, "Connect cannot be pressed");
  await act.ended;
}
async function connected(page, name) {
  await open(page, name);
  await connect(page);
  assert.ok(page.can("ethSend"), `${name}: the wallet did not connect: ${page.text("ethError")}`);
}
async function started(net, use) {
  const world = ethWorld(net);
  return runPage(world, async (page) => {
    await search(page, KEY_ONE);
    return use(page, world);
  });
}
// What stands in the block: the state of the order's submission, or null when there is none.
function state(page) {
  if (!page.shown("ethDone")) return null;
  const rows = page
    .el("ethDoneInfo")
    .querySelectorAll("dd")
    .map((dd) => dd.textContent);
  return [page.text("ethDoneHead"), rows.at(-1)];
}
const offers = (page) => page.can("ethConnect") || page.can("ethSend");
const link = (page) => {
  const a = page.el("ethDoneInfo").querySelector("a");
  return a && a.href;
};
// No request up to here, to a host or to the wallet, carries a half of an order: whole, or as it stands in calldata.
function carriesNoHalf(world, what) {
  assert.ok(world.requests.length > 5, `${what}: nothing was recorded`);
  for (const { order } of Object.values(world.orders)) {
    const half = order.half();
    for (const request of world.requests)
      assert.ok(
        !request.body.toLowerCase().includes(half),
        `${what}: ${request.method} to ${request.to} carried a half`,
      );
  }
}
// The log holds no half and no words, however a cause was worded.
function logsNoSecret(page, world, what) {
  const log = page.log().toLowerCase();
  for (const { order, words } of Object.values(world.orders)) {
    assert.ok(!log.includes(order.half()), `${what}: the log holds a half`);
    const [, ...rest] = words.split(" ");
    for (let i = 0; i + 2 < rest.length; i += 1)
      assert.ok(!log.includes(rest.slice(i, i + 3).join(" ")), `${what}: the log holds the words`);
  }
}
// The transaction is this order's: to its escrow, its own half, from this account, on its network, with no ETH in it.
function isOwn(tx, world, name, net, what) {
  const { order, escrow } = world.orders[name];
  assert.equal(tx.to.toLowerCase(), escrow, `${what}: the transaction's target`);
  assert.equal(
    tx.data.toLowerCase(),
    (name === "claim" ? CLAIM : REFUND) + order.half(),
    `${what}: the transaction's call`,
  );
  assert.equal(tx.chainId, net.hex, `${what}: the transaction's network`);
  assert.equal(BigInt(tx.value), 0n, `${what}: the transaction carries ETH`);
}

// --- the whole way ----------------------------------------------------------------------------------------

export async function checkEthWhole() {
  let cases = 0;
  for (const net of networks()) {
    for (const name of ["refund", "claim"]) {
      for (const selects of [true, false]) {
        await started(net, async (page, world) => {
          const what = `${name} on ${net.id}, a wallet that ${selects ? "selects" : "only adds"} a network`;
          const order = world.orders[name];
          world.wallet.selects = selects;
          await open(page, name);
          assert.ok(!world.requests.some((request) => request.to === "wallet"), `${what}: the wallet was asked early`);
          assert.ok(page.text("ethFacts").includes(order.escrow), `${what}: the facts do not name the escrow`);
          assert.equal(page.shown("moneyState"), false, `${what}: the XMR step is shown`);
          assert.equal(page.shown("stepTransfer"), false, `${what}: the XMR withdrawal is shown`);
          await connect(page);
          assert.equal(page.text("ethError"), "", what);
          assert.ok(page.can("ethSend"), `${what}: the wallet did not connect`);
          // THE WALLET KNEW ANOTHER NETWORK ONLY: it was offered this one, by its public address, and is on it. It was
          // asked to select it once, and only if adding it did not.
          assert.deepEqual(
            world.wallet.prompts,
            selects ? ["add"] : ["add", "select"],
            `${what}: the wallet's prompts`,
          );
          assert.equal(world.wallet.offered[0].chainId, net.hex, `${what}: another network was offered`);
          assert.deepEqual(world.wallet.offered[0].rpcUrls, net.rpcs, `${what}: the network's address`);
          assert.equal(world.wallet.chainId, net.chainId, `${what}: the wallet's network`);
          assert.deepEqual(world.sent, [], `${what}: a transaction before Confirm`);
          assert.ok(page.text("ethInfo").includes("A fixed limit is sent"), `${what}: what the page says of the gas`);

          world.wallet.receipt = null;
          const held = world.hold("eth_sendTransaction");
          const reading = world.hold("eth_call");
          assert.ok(page.press("ethSend"), `${what}: Confirm cannot be pressed`);
          assert.equal(page.press("ethSend"), false, `${what}: Confirm can be pressed twice`);
          await page.until(reading.reached, `${what}: the order being checked`);
          assert.deepEqual(state(page), SAYS.checking, `${what}: before the wallet is asked`);
          assert.equal(offers(page), false, `${what}: Confirm can be pressed while the order is checked`);
          assert.ok(!page.log().includes("sent:"), `${what}: said as sent`);
          reading.release();
          await page.until(held.reached, `${what}: the transaction handed to the wallet`);
          const handed = world.requests.pop();
          assert.equal(handed.method, "eth_sendTransaction");
          carriesNoHalf(world, what);
          assert.deepEqual(state(page), SAYS.asking, `${what}: while the wallet is asked`);
          assert.equal(link(page), null, `${what}: a transaction nobody named`);
          held.release();
          await page.until(() => link(page), `${what}: the transaction shown`);

          assert.equal(world.sent.length, 1, `${what}: the wallet was handed ${world.sent.length} transactions`);
          const [tx] = world.sent;
          isOwn(tx, world, name, net, what);
          assert.equal(tx.from, world.person, `${what}: the transaction's sender`);

          // SENT AND WAITING, until the receipt of this transaction; only then is it done, in the panel and in the row.
          const done = SAYS[name][1];
          assert.deepEqual(state(page), SAYS.waiting, what);
          assert.equal(link(page), net.explorer + tx.hash, what);
          assert.ok(
            !page.root.querySelector("main").textContent.includes(done),
            `${what}: said as done before the receipt`,
          );
          assert.equal(offers(page), false, `${what}: it can be sent twice`);
          assert.equal(page.row(ETH[name]).dataset.action, name, `${what}: the row moved before the receipt`);
          await page.advance(30_000);
          assert.deepEqual(state(page), SAYS.waiting, `${what}: after a while without a receipt`);
          world.wallet.receipt = { status: "0x1" };
          await page.advance(4_000);
          assert.deepEqual(state(page), SAYS[name], what);
          assert.deepEqual(
            [...new Set(world.wallet.asked)],
            [tx.hash],
            `${what}: another transaction's receipt was asked`,
          );
          assert.equal(page.row(ETH[name]).dataset.action, "none", `${what}: the row did not move`);
          assert.equal(world.sent.length, 1, what);
          logsNoSecret(page, world, what);
          // The chain's events do not show it yet: the settled order stays settled in a new search.
          await search(page, KEY_ONE);
          assert.equal(page.row(ETH[name]).dataset.action, "none", `${what}: a new search offers it again`);
          cases += 1;
        });
      }
    }
  }
  return `${cases} actions, from the row to one transaction and its receipt, on a wallet that did not know the network`;
}

// --- no transaction -----------------------------------------------------------------------------------------

export async function checkEthRefusals() {
  const [net] = networks();
  // ANOTHER ACCOUNT THAN THE CLAIMER'S is refused when it connects, and one the wallet moved to later at the send.
  await started(net, async (page, world) => {
    await open(page, "claim");
    world.wallet.account = "0x" + "77".repeat(20);
    await connect(page);
    assert.match(page.text("ethError"), /^This account is not the order's claimer/);
    assert.match(page.log(), /the EVM wallet was not connected: This account is not the order's claimer/);
    assert.equal(page.shown("ethConfirm"), false, "another account can confirm a claim");
    world.wallet.account = world.person;
    await connect(page);
    world.wallet.account = "0x" + "77".repeat(20);
    await page.press("ethSend").ended;
    assert.match(page.text("ethError"), /^The wallet account changed/);
    assert.deepEqual(world.sent, [], "another account was asked to claim");
  });
  // A REFUND PAYS THE LOCKER whoever sends it: another account may.
  await started(net, async (page, world) => {
    await open(page, "refund");
    world.wallet.account = "0x" + "77".repeat(20);
    await connect(page);
    await page.press("ethSend").ended;
    assert.equal(world.sent.length, 1, "the refund");
    assert.equal(world.sent[0].from, world.wallet.account);
    assert.ok(page.text("ethRecipient").endsWith(world.person), "the refund names another recipient");
  });
  // A WALLET THAT STAYS ELSEWHERE: it refuses to add the network, to select it, or to select one it added; it says it
  // switched and did not; or it goes elsewhere after it connected.
  for (const how of [
    "refuses to switch",
    "refuses to add",
    "adds and refuses to select",
    "says it switched",
    "leaves later",
  ]) {
    await started(net, async (page, world) => {
      const what = `a wallet that ${how}`;
      await open(page, "refund");
      const { wallet } = world;
      const no = world.fail(4001, "User rejected the request.");
      if (how === "refuses to switch") wallet.fails.wallet_switchEthereumChain = no;
      if (how === "refuses to add") wallet.fails.wallet_addEthereumChain = no;
      if (how === "says it switched") wallet.stays = true;
      if (how === "adds and refuses to select") {
        wallet.selects = false;
        const held = world.hold("wallet_addEthereumChain");
        const act = page.press("ethConnect");
        await page.until(held.reached, what);
        wallet.fails.wallet_switchEthereumChain = no;
        held.release();
        await act.ended;
      } else await connect(page);
      if (how === "leaves later") {
        wallet.chainId = 1;
        await page.press("ethSend").ended;
      } else assert.equal(page.shown("ethConfirm"), false, `${what} can confirm`);
      assert.match(page.text("ethError"), /network|declined/, what);
      assert.deepEqual(world.sent, [], `${what} was handed a transaction`);
      // The prepared action is kept: once the wallet goes along, the same press works.
      wallet.fails = {};
      wallet.stays = false;
      wallet.chainId = net.chainId;
      if (how !== "leaves later") await connect(page);
      await page.press("ethSend").ended;
      assert.equal(world.sent.length, 1, `${what}: the action is gone`);
    });
  }
  // NO WALLET in this browser.
  const none = ethWorld(net);
  none.ethereum = undefined;
  await runPage(none, async (page) => {
    await search(page, KEY_ONE);
    await open(page, "refund");
    await connect(page);
    assert.match(page.text("ethError"), /^No EVM wallet is available/);
    assert.match(page.log(), /the EVM wallet was not connected: No EVM wallet is available/);
  });
  // THE ORDER DOES NOT PASS THE CHECK BEFORE SENDING: nothing was sent, and the contract was not asked.
  await started(net, async (page, world) => {
    await connected(page, "refund");
    world.orders.refund.order.commitHalfLocker = "0x" + "9".repeat(64);
    await page.press("ethSend").ended;
    assert.match(page.text("ethError"), /^The order did not pass the check before sending, so nothing was sent/);
    assert.deepEqual(world.sent, []);
    assert.ok(page.can("ethSend"), "a refusal keeps the order closed");
  });
  return "another account, a wallet elsewhere, no wallet and a failed check: no transaction, and the action is kept";
}

// --- what comes back, or does not ---------------------------------------------------------------------------

export async function checkEthAnswers() {
  const [net] = networks();
  const LIMIT = 120_000;
  // NO RECEIPT IN TIME IS UNKNOWN: an empty answer, a failing one, one that never comes, one that says nothing, and one of
  // another transaction. One millisecond before the limit it is still waiting. The hash stays, no second one is offered,
  // and opening the row again asks for the same receipt first.
  for (const how of ["empty", "failing", "never", "malformed", "another's"]) {
    await started(net, async (page, world) => {
      const what = `a receipt read that is ${how}`;
      const hash = world.hashOf(1);
      await connected(page, "refund");
      world.wallet.receipt = how === "malformed" ? { status: "maybe" } : null;
      if (how === "another's") world.wallet.receipt = { status: "0x1", transactionHash: world.hashOf(9) };
      if (how === "failing")
        world.wallet.fails.eth_getTransactionReceipt = world.fail(-32603, "Internal JSON-RPC error.");
      if (how === "never") world.hold("eth_getTransactionReceipt");
      const act = page.press("ethSend");
      await page.until(() => link(page), what);
      await page.advance(LIMIT - 1);
      assert.deepEqual(state(page), SAYS.waiting, `${what}, before the limit`);
      await page.advance(1);
      assert.deepEqual(state(page), SAYS.unknown, `${what}, at the limit`);
      await act.ended;
      assert.match(page.text("ethError"), /^The transaction was sent, but its receipt was not read in time/);
      assert.equal(page.row(ETH.refund).dataset.action, "refund", `${what}: the row moved`);
      assert.equal(offers(page), false, `${what}: a second transaction is offered`);
      assert.ok(page.log().includes(hash), `${what}: the log does not name the transaction`);

      world.wallet.fails = {};
      world.wallet.receipt = null;
      for (const again of ["the row", "a new search"]) {
        if (again === "a new search") await search(page, KEY_ONE);
        assert.equal(
          page.row(ETH.refund).dataset.action,
          "refund",
          `${what}, in ${again}: the row moved without a receipt`,
        );
        const asked = world.wallet.asked.length;
        await open(page, "refund");
        assert.deepEqual(state(page), SAYS.waiting, `${what}, opened again from ${again}`);
        assert.equal(link(page), net.explorer + hash, `${what}, opened again from ${again}: its hash is gone`);
        assert.equal(offers(page), false, `${what}, opened again from ${again}: a second transaction is offered`);
        await page.advance(LIMIT);
        assert.ok(world.wallet.asked.length > asked, `${what}, opened again from ${again}: it was not asked for`);
        assert.deepEqual(state(page), SAYS.unknown, `${what}, opened again from ${again}`);
      }
      await open(page, "refund");
      world.wallet.receipt = { status: "0x1" };
      await page.advance(4_000);
      assert.deepEqual(state(page), SAYS.refund, `${what}: its receipt came`);
      assert.equal(world.sent.length, 1, what);
    });
  }
  // A WALLET THAT MOVED TO ANOTHER NETWORK HAS NOT LOST THE TRANSACTION. The receipt is asked of the order's network only, the
  // page says where the wallet must be, and nothing is unknown for it. Back on it, in time or when the row is opened again,
  // the same receipt ends it. The network of a wallet that cannot say is not another one.
  for (const how of ["comes back in time", "comes back late", "stays", "cannot say"]) {
    await started(net, async (page, world) => {
      const what = `a wallet that ${how}`;
      const hash = world.hashOf(1);
      await connected(page, "refund");
      const { wallet } = world;
      wallet.receipt = { status: "0x1" };
      const held = world.hold("eth_getTransactionReceipt");
      const act = page.press("ethSend");
      await page.until(held.reached, what);
      assert.deepEqual(state(page), SAYS.waiting, what);
      if (how === "cannot say") wallet.fails.eth_chainId = world.fail(-32603, "Internal JSON-RPC error.");
      else wallet.chainId = 1;
      held.release(new Error("example: the read was cut"));
      await world.quiet();
      await page.advance(10_000);
      if (how === "cannot say") assert.deepEqual(state(page), SAYS.refund, `${what}: its receipt`);
      else {
        assert.deepEqual(state(page), SAYS.elsewhere, `${what}: said as anything else`);
        assert.deepEqual(link(page), net.explorer + hash, `${what}: its hash`);
        assert.equal(offers(page), false, `${what}: a second transaction is offered`);
        const asked = wallet.asked.length;
        await page.advance(30_000);
        assert.equal(wallet.asked.length, asked, `${what}: a receipt was asked of another network`);
        if (how === "comes back in time") {
          wallet.chainId = net.chainId;
          await page.advance(4_000);
          assert.deepEqual(state(page), SAYS.refund, `${what}: its receipt`);
          await act.ended;
          assert.equal(world.sent.length, 1, what);
          return;
        }
        await page.advance(120_000);
        await act.ended;
        assert.deepEqual(state(page), SAYS.elsewhere, `${what}, at the limit`);
        assert.match(page.text("ethError"), /^The transaction was sent, but your wallet is on another network/, what);
        for (const again of ["the row", "a new search"]) {
          if (again === "a new search") await search(page, KEY_ONE);
          await open(page, "refund");
          await page.advance(8_000);
          assert.deepEqual(state(page), SAYS.elsewhere, `${what}, opened again from ${again}`);
          assert.equal(offers(page), false, `${what}, opened again from ${again}: a second transaction is offered`);
          await page.advance(120_000);
        }
        if (how === "comes back late") {
          wallet.chainId = net.chainId;
          await open(page, "refund");
          await page.advance(4_000);
          assert.deepEqual(state(page), SAYS.refund, `${what}: its receipt`);
        }
      }
      assert.equal(world.sent.length, 1, what);
      assert.equal(page.row(ETH.refund).dataset.action, how === "stays" ? "refund" : "none", `${what}: the row`);
    });
  }
  // WHAT THE CHAIN'S EVENTS SHOW IS NEWER THAN THE RECEIPT. The refund was confirmed here, and the next search reads an end
  // of the order that it contradicts: the row shows that, says so and offers a new check, and the check reads the
  // events again. An end that agrees, and no end, contradict nothing.
  for (const [name, action, event, conflict] of [
    [
      "claimed",
      "withdraw",
      (order) => eventLog(order, "HalfRevealed", { half: order.makerHalf, byClaimer: true }),
      true,
    ],
    ["declined", "none", (order) => eventLog(order, "Declined"), true],
    [
      "refunded",
      "none",
      (order) => eventLog(order, "HalfRevealed", { half: order.makerHalf, byClaimer: false }),
      false,
    ],
    ["nothing", "none", () => null, false],
  ]) {
    await started(net, async (page, world) => {
      const what = `the chain shows the refunded order as ${name}`;
      const row = () => page.row(ETH.refund);
      const { order } = world.orders.refund;
      await connected(page, "refund");
      await page.press("ethSend").ended;
      assert.deepEqual(state(page), SAYS.refund, what);
      assert.equal(row().dataset.action, "none", what);
      const log = event(order);
      order.events = log ? [log] : [];
      await search(page, KEY_ONE);
      assert.equal(row().dataset.action, action, `${what}: what the row offers`);
      const says = () => row().querySelectorAll("[data-conflict]").length;
      const check = () => row().querySelectorAll("[data-check]")[0];
      assert.equal(says(), conflict ? 1 : 0, `${what}: the row says so`);
      assert.equal(Boolean(check()), conflict, `${what}: a new check is offered`);
      if (!conflict) return;
      // Pressed, the chain is read again: the same, and the row says so still; the events gone, the receipt stands.
      await page.press(check()).ended;
      assert.equal(says(), 1, `${what}: after a new check that shows the same`);
      order.events = [];
      await page.press(check()).ended;
      assert.equal(says(), 0, `${what}: after a new check`);
      assert.equal(row().dataset.action, "none", `${what}: the receipt stands when the chain shows no end`);
      assert.equal(world.sent.length, 1, what);
    });
  }
  // ONE THAT FAILED ON THE CHAIN opens the action again, and the row stays.
  await started(net, async (page, world) => {
    await connected(page, "refund");
    world.wallet.receipt = { status: "0x0" };
    await page.press("ethSend").ended;
    assert.equal(page.text("ethError"), "The transaction failed on the chain. You can try again");
    assert.equal(state(page), null, "a failed transaction is still shown as sent");
    assert.ok(page.can("ethSend"), "a failed transaction cannot be tried again");
    assert.equal(page.row(ETH.refund).dataset.action, "refund", "a failed transaction moved the row");
    world.wallet.receipt = { status: "0x1" };
    await page.press("ethSend").ended;
    assert.deepEqual(state(page), SAYS.refund);
    assert.deepEqual(
      world.wallet.asked.slice(-1),
      [world.hashOf(2)],
      "the second transaction was settled by the first one's receipt",
    );
  });
  // THE WALLET'S OWN ANSWER to the transaction: a named refusal frees the order; any other failure may have sent it, and
  // then no Send is offered, in this view, in the row opened again, or after a new search.
  for (const [error, said] of [
    [{ code: 4001, message: "User rejected the request." }, "The wallet declined the transaction"],
    [{ code: -32000, message: "insufficient funds for gas" }, "The ETH transaction was not sent"],
    [{ code: 4100, message: "The account is not authorized" }, "The EVM wallet could not be connected"],
    [{ code: 3, message: "execution reverted" }, "The wallet or the network refused this transaction"],
    // The method is not supported: nothing was sent, whatever code the SDK makes of it.
    [{ code: 4200, message: "Unsupported method" }, "The wallet or the network refused this transaction"],
    [{ code: -32601, message: "Method not found" }, "The wallet or the network refused this transaction"],
    [{ code: -32603, message: "Internal JSON-RPC error." }, LOST],
    [{ message: "the request expired" }, LOST],
    [null, LOST],
  ]) {
    await started(net, async (page, world) => {
      const what = error ? error.message : "an answer without a hash";
      await connected(page, "refund");
      if (error) world.wallet.fails.eth_sendTransaction = Object.assign(new Error(error.message), error);
      else world.wallet.noHash = true;
      await page.press("ethSend").ended;
      assert.ok(page.text("ethError").startsWith(said), `${what}: ${page.text("ethError")}`);
      assert.equal(page.row(ETH.refund).dataset.action, "refund", `${what}: the row moved`);
      if (!error) assert.ok(page.log().includes("the wallet answered without a transaction hash"), page.log());
      if (said !== LOST) {
        assert.equal(state(page), null, what);
        assert.ok(page.can("ethSend"), `${what}: it cannot be tried again`);
        return;
      }
      for (const again of ["this view", "the row", "a new search"]) {
        if (again === "a new search") await search(page, KEY_ONE);
        if (again !== "this view") await open(page, "refund");
        assert.deepEqual(state(page), SAYS.lost, `${what}, in ${again}`);
        assert.equal(offers(page), false, `${what}, in ${again}: a second transaction is offered`);
      }
      // Another order is not held by it.
      world.wallet.fails = {};
      world.wallet.noHash = false;
      await connected(page, "again");
    });
  }
  return "no receipt in time is unknown and asked for again, a moved wallet is not, a contradicted row says so, and a lost answer offers none";
}

// --- what ends belongs to the swap it began with ------------------------------------------------------------

const LEAVES = [
  ["another swap", (page) => open(page, "again"), "again"],
  [
    "another key",
    async (page) => {
      await search(page, KEY_TWO);
      await open(page, "other");
    },
    "other",
  ],
  ["the same swap, opened again", (page) => open(page, "refund"), "refund"],
];
// Where the page waits for the wallet or the chain, and the press that waits.
const WAITS = [
  ["eth_requestAccounts", "connect"],
  ["wallet_switchEthereumChain", "connect"],
  ["wallet_addEthereumChain", "connect"],
  ["eth_accounts", "connect"],
  ["eth_call", "send"],
  ["eth_getBlockByNumber", "send"],
  ["eth_sendTransaction", "send"],
  ["eth_getTransactionReceipt", "receipt"],
];

export async function checkEthLeaves() {
  const [net] = networks();
  let cases = 0;
  for (const [wait, stage] of WAITS) {
    for (const [leave, act, name] of LEAVES) {
      // A wait that never ends, for one way of leaving: what stands then is what stands before a late answer.
      for (const ending of leave === "another swap" ? ["success", "failure", "never"] : ["success", "failure"]) {
        // The same order's own submission is shown in the row opened again: its own check, below.
        if (name === "refund" && stage !== "connect") continue;
        await started(net, async (page, world) => {
          const what = `${leave} at ${wait}, which ends in ${ending}`;
          const first = world.orders.refund;
          await open(page, "refund");
          if (stage !== "connect") await connect(page);
          const held = world.hold(wait);
          const step = page.press(stage === "connect" ? "ethConnect" : "ethSend");
          assert.ok(step);
          await page.until(held.reached, what);
          await act(page);
          const before = page.text("stepSwap");
          if (ending === "success") held.release();
          if (ending === "failure") held.release(world.fail(-32603, "the wallet failed for " + first.escrow));
          await world.quiet();
          await page.advance(130_000);
          if (ending !== "never") await step.ended;

          // NOTHING OF THE FIRST stands in the swap that is open now: it is as it was, whatever the first one came to.
          const shown = page.text("stepSwap");
          assert.equal(shown, before, `${what}: the open swap changed`);
          assert.ok(shown.includes(world.orders[name].escrow), `${what}: the open swap does not show itself`);
          if (name !== "refund") assert.ok(!shown.includes(first.escrow), `${what}: the first swap's escrow is shown`);
          for (const id of ["ethError", "ethWallet", "ethConfirm", "ethDone"])
            assert.equal(page.shown(id), false, `${what}: ${id} of the first swap`);
          assert.ok(page.can("ethConnect"), `${what}: the open swap cannot be connected`);

          // LEFT BEFORE THE WALLET WAS GIVEN THE TRANSACTION: it is not given it.
          const handed = stage === "receipt" || (wait === "eth_sendTransaction" && ending === "success");
          assert.equal(
            world.sent.length,
            handed ? 1 : 0,
            `${what}: the wallet was handed ${world.sent.length} transactions`,
          );
          // ITS OWN ROW, in its own list, moves by its own receipt; one failed read of it is only asked again.
          const moved = handed && ending !== "never" ? "none" : "refund";
          if (name !== "other")
            assert.equal(page.row(ETH.refund).dataset.action, moved, `${what}: the first swap's row`);
          logsNoSecret(page, world, what);

          // The open swap goes its own way, with a transaction and a receipt of its own.
          if (name !== "refund") {
            await connect(page);
            await page.press("ethSend").ended;
            const own = world.sent.at(-1);
            isOwn(own, world, name, net, what);
            assert.equal(own.hash, world.hashOf(handed ? 2 : 1), what);
            assert.equal(link(page), net.explorer + own.hash, `${what}: another transaction's link`);
            assert.equal(world.wallet.asked.at(-1), own.hash, `${what}: another transaction's receipt`);
          }
          cases += 1;
        });
      }
    }
  }
  // ANOTHER ROW IN THE SAME BREATH, while the first is prepared: the second stands alone, also when the first is refused.
  for (const broken of [false, true]) {
    const world = ethWorld(net);
    if (broken) breakOrder(world.orders.refund);
    await runPage(world, async (page) => {
      const what = `a row opened right after ${broken ? "a refused" : "another"} one`;
      await search(page, KEY_ONE);
      const acts = [page.open(ETH.refund), page.open(ETH.again)];
      for (const act of acts) await act.ended;
      assert.ok(page.can("ethConnect"), what);
      assert.equal(page.text("ethError"), "", `${what}: the first one's refusal`);
      assert.ok(page.text("ethFacts").includes(world.orders.again.escrow), `${what}: its own facts`);
      assert.ok(!page.text("stepSwap").includes(world.orders.refund.escrow), `${what}: the first one's facts`);
      cases += 1;
    });
  }
  return `${cases} cases: the open swap shows nothing of the one before it, and a left one is not sent`;
}

// ANOTHER KEY BEFORE THE WALLET IS ASKED ends the step, as it drops a transfer: it is not handed over, and says so. The
// person's press is free again, for a new attempt of the same swap. After the wallet has it, it is the wallet's.
export async function checkEthKey() {
  const [net] = networks();
  const ENTERS = [
    ["words are typed", async (page) => void page.type("keyWords", KEY_TWO)],
    ["a file that is no key is chosen", (page) => page.choose("keyFile", { size: 10, text: async () => "x" }).ended],
    [
      "a file that is still being read is chosen",
      async (page) => void page.choose("keyFile", { size: 10, text: () => new Promise(() => {}) }),
    ],
  ];
  const CHECKS = ["eth_accounts", "eth_chainId", "eth_call", "eth_getBlockByNumber"];
  let cases = 0;
  for (const [enter, act] of ENTERS) {
    for (const wait of CHECKS) {
      for (const ending of ["success", "failure", "never"]) {
        await started(net, async (page, world) => {
          const what = `${enter} at ${wait}, which ends in ${ending}`;
          await connected(page, "refund");
          const held = world.hold(wait);
          const step = page.press("ethSend");
          await page.until(held.reached, what);
          await act(page);
          assert.equal(state(page), null, `${what}: the step is shown as running`);
          assert.match(page.text("ethError"), /^Another Ninsei key was entered/, what);
          if (ending !== "never") {
            held.release(ending === "failure" ? world.fail(-32603, "example") : null);
            await step.ended;
            await world.quiet();
          }
          assert.deepEqual(world.sent, [], `${what}: the wallet was handed the transaction`);
          assert.match(page.text("ethError"), /^Another Ninsei key was entered/, `${what}: said as anything else`);
          assert.equal(page.row(ETH.refund).dataset.action, "refund", `${what}: the row`);
          // The order is free: a new press of the same action goes its own way, and only it does.
          if (ending !== "never") {
            assert.ok(page.can("ethSend"), `${what}: the action cannot be pressed again`);
            await page.press("ethSend").ended;
            assert.deepEqual(state(page), SAYS.refund, `${what}: the new attempt`);
            assert.equal(world.sent.length, 1, what);
            isOwn(world.sent[0], world, "refund", net, what);
          }
          cases += 1;
        });
      }
    }
  }
  // Handed to the wallet: its outcome is its own, whatever is entered after.
  for (const [enter, act] of ENTERS) {
    await started(net, async (page, world) => {
      const what = `${enter} while the wallet is asked`;
      await connected(page, "refund");
      const held = world.hold("eth_sendTransaction");
      const step = page.press("ethSend");
      await page.until(held.reached, what);
      await act(page);
      assert.deepEqual(state(page), SAYS.asking, `${what}: what is shown`);
      held.release();
      await step.ended;
      assert.deepEqual(state(page), SAYS.refund, what);
      assert.equal(world.sent.length, 1, what);
      cases += 1;
    });
  }
  return `${cases} key inputs: a step that has not reached the wallet ends, and one that has keeps its own outcome`;
}

// ONE SUBMISSION FOR ONE ORDER AT A TIME, in whatever view of it: the row opened again, after a new search, or after
// another key and back. While the wallet is asked, or a hash waits, no second one is offered; what the wallet says then
// ends it in the view that is open.
export async function checkEthOnce() {
  const [net] = networks();
  const VIEWS = [
    ["the row opened again", async () => {}],
    ["a new search of the key", (page) => search(page, KEY_ONE)],
    [
      "another key and back",
      async (page) => {
        await search(page, KEY_TWO);
        await search(page, KEY_ONE);
      },
    ],
  ];
  let cases = 0;
  for (const [wait, during] of [
    ["eth_call", null],
    ["eth_sendTransaction", "asking"],
    ["eth_getTransactionReceipt", "waiting"],
  ]) {
    for (const [view, go] of VIEWS) {
      for (const ending of ["success", "refusal", "never"]) {
        await started(net, async (page, world) => {
          const what = `${view} at ${wait}, which ends in ${ending}`;
          await connected(page, "refund");
          const held = world.hold(wait);
          const step = page.press("ethSend");
          await page.until(held.reached, what);
          await go(page);
          await open(page, "refund");
          if (!during) {
            // THE FIRST VIEW'S CHECK HOLDS NOTHING: the order is free here, though a read of it is outstanding.
            assert.equal(state(page), null, `${what}: an order that no wallet was asked is held`);
            assert.ok(page.can("ethConnect"), `${what}: the order cannot be tried`);
            await connect(page);
            await page.press("ethSend").ended;
            assert.deepEqual(state(page), SAYS.refund, `${what}: the attempt of this view`);
            held.release(ending === "refusal" ? world.fail(4001, "User rejected the request.") : null);
            await world.quiet();
            if (ending !== "never") await step.ended;
            assert.equal(world.sent.length, 1, `${what}: ${world.sent.length} transactions`);
            isOwn(world.sent[0], world, "refund", net, what);
            cases += 1;
            return;
          }
          assert.deepEqual(state(page), SAYS[during], `${what}: what the row shows`);
          assert.equal(offers(page), false, `${what}: a second submission is offered`);
          // A wallet that connects to this view meanwhile (a press the browser delivers late) makes no second one either.
          await page.el("ethConnect").fire("click");
          await page.el("ethSend").fire("click");
          assert.equal(offers(page), false, `${what}: a second submission is offered to a connected wallet`);
          assert.equal(world.sent.length, during === "waiting" ? 1 : 0, `${what}: a second submission`);
          if (ending !== "never") {
            held.release(ending === "refusal" ? world.fail(4001, "User rejected the request.") : null);
            await world.quiet();
            await page.advance(4_000);
            await step.ended;
          }
          if (ending === "never") {
            assert.deepEqual(state(page), SAYS[during], what);
          } else if (wait === "eth_sendTransaction" && ending === "refusal") {
            // Refused: the order is free, in the view that is open.
            assert.equal(state(page), null, what);
            assert.equal(world.sent.length, 0, `${what}: a left view handed its transaction over`);
            assert.ok(page.can("ethSend"), `${what}: the order is not free again`);
            await page.press("ethSend").ended;
            assert.deepEqual(state(page), SAYS.refund, `${what}: the fresh attempt`);
          } else assert.deepEqual(state(page), SAYS.refund, `${what}: the order's own end`);
          if (ending !== "never") {
            assert.equal(world.sent.length, 1, `${what}: ${world.sent.length} transactions`);
            isOwn(world.sent[0], world, "refund", net, what);
          }
          cases += 1;
        });
      }
    }
  }
  return `${cases} cases: one submission of one order at a time, in every view of it`;
}

// --- causes --------------------------------------------------------------------------------------------------

// An order whose points are not the key's: the SDK refuses to prepare its action.
function breakOrder({ order: { log } }) {
  const words = log.data.slice(2).match(/.{64}/g);
  words[2] = "9".repeat(64); // edPointLocker, the person's own point on a buy
  log.data = "0x" + words.join("");
}

export async function checkEthCauses() {
  const [net] = networks();
  // A PREPARATION that fails in the SDK, by its code and what it refused: an order of another key's point.
  const broken = ethWorld(net);
  breakOrder(broken.orders.refund);
  await runPage(broken, async (page) => {
    await search(page, KEY_ONE);
    await page.open(ETH.refund).ended;
    assert.match(page.text("ethError"), /^The ETH action for this swap could not be prepared/);
    assert.ok(
      page.log().includes("The data for this step is incomplete or not valid (field: order; reason: spend-point)"),
      page.log(),
    );
    assert.equal(page.text("ethFacts"), "", "facts of an action that was not prepared");
    assert.equal(page.shown("ethConnect"), false, "a wallet can be connected to an action that was not prepared");
    logsNoSecret(page, broken, "a refused preparation");
  });

  // WHAT THE WALLET SAYS IS NOT SHOWN, whatever it quotes: the call it was given, half and all, the words, an ordinary
  // sentence, in any spelling. What is said is the page's words, the SDK's code and the wallet's number, for a step that
  // is open and for one that was left.
  let cases = 0;
  for (const [method, stage] of [
    ["eth_requestAccounts", "connect"],
    ["wallet_switchEthereumChain", "connect"],
    ["eth_call", "send"],
    ["eth_sendTransaction", "send"],
  ]) {
    for (const under of ["the same key", "another key", "no key"]) {
      await started(net, async (page, world) => {
        const what = `a wallet that fails ${method}, under ${under}`;
        const half = world.orders.refund.order.half();
        await open(page, "refund");
        if (stage === "send") await connect(page);
        const held = world.hold(method);
        const step = page.press(stage === "connect" ? "ethConnect" : "ethSend");
        await page.until(held.reached, what);
        if (under === "another key") await search(page, KEY_TWO);
        if (under === "no key") {
          page.type("keyWords", "no key");
          await page.press("findSwaps").ended;
        }
        const spoken = KEY_ONE.split(" ")
          .map((word, i) => `mot ${i} ${word}`)
          .join(", puis ");
        const fail = world.fail(
          -32002,
          `zebra: data=${REFUND}${half} 0x${half.toUpperCase()} ${spoken} ${Buffer.from(half, "hex").toString("base64")}`,
        );
        held.release(Object.assign(fail, { data: { message: "zebra" }, name: `zebra ${half}` }));
        await step.ended;
        logsNoSecret(page, world, what);
        for (const text of [page.log(), page.root.querySelector("main").textContent])
          assert.ok(!text.includes("zebra"), `${what}: the wallet's text is shown\n${text}`);
        assert.deepEqual(world.sent, [], what);
        // The same step, by its code: what the wallet's number and the SDK's name say, when the step was open.
        if (under === "the same key")
          assert.match(page.log(), /; wallet code -32002/, `${what}: no reason\n${page.log()}`);
        cases += 1;
      });
    }
  }
  // A CODE THE PAGE DOES NOT KNOW SAYS SO, by its name, and nothing of the text beside it.
  await started(net, async (page, world) => {
    await open(page, "refund");
    world.wallet.fails.eth_requestAccounts = Object.assign(new Error("zebra"), { code: "SOME_NEW_CODE" });
    await connect(page);
    assert.match(page.log(), /the EVM wallet was not connected: /);
    assert.ok(!page.log().includes("zebra"), page.log());
  });
  return `${cases} wallet failures that quote the call and the words: none of it is shown, and the step and its code are named`;
}

// A SWAP THAT WAS LEFT KEEPS NO HALF, looked for in the memory of the whole process: the order's half is there while its
// action is open, and nowhere once it is left, prepared, connected, or with its transaction waiting.
export async function checkEthLeftKeepsNothing() {
  const [net] = networks();
  let cases = 0;
  for (const [upTo, leave] of [
    [(page) => open(page, "refund"), (page) => open(page, "again")],
    [(page) => connected(page, "refund"), (page) => search(page, KEY_TWO)],
    [
      async (page, world) => {
        await connected(page, "refund");
        world.wallet.receipt = null;
        page.press("ethSend");
        await page.until(() => link(page), "the transaction sent");
      },
      (page) => open(page, "again"),
    ],
  ]) {
    const world = ethWorld(net, { from: 100 * (cases += 1) });
    await runPage(world, async (page) => {
      const half = digest(world.orders.refund.order.half());
      await search(page, KEY_ONE);
      await upTo(page, world);
      assert.equal(inMemory(half), true, "the check does not see a half that is held");
      await leave(page, world);
      await world.quiet();
      assert.equal(inMemory(half), false, `case ${cases}: the left swap's half is still in memory`);
    });
  }
  return `${cases} ways to leave an ETH action: its half is nowhere in memory after each`;
}

if (import.meta.main) {
  // The memory of a process is looked for first: a small heap is read in a moment, and a check before it leaves more.
  for (const check of [
    checkEthLeftKeepsNothing,
    checkEthWhole,
    checkEthRefusals,
    checkEthAnswers,
    checkEthLeaves,
    checkEthOnce,
    checkEthKey,
    checkEthCauses,
  ])
    console.log("ok    " + (await check()));
}
