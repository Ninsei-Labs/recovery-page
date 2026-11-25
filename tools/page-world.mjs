// WHAT THE PAGE MEETS OUTSIDE ITSELF, for tools/page-run.mjs: the settlement chain with the orders of two made-up keys, a
// Monero node whose blocks hold the XMR of those swaps, and a Monero wallet library. They answer as the services do (the
// JSON-RPC methods, monerod's answers, monero-ts's methods); the figures are examples. The outputs are real RingCT
// outputs to the swaps' addresses, built here from Monero's own rules, so the SDK's checks of the amounts and the key
// images run on them unchanged.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { createNinsei } from "@ninsei-labs/sdk";
import { ORDER_CREATED_TOPIC } from "@ninsei-labs/sdk/evm";
import { takerHalvesV2 } from "@ninsei-labs/sdk/recovery";
import { createHalves, decodeAddressKeys, scalarFromMoneroHex, spendKeysFromRevealedHalf } from "@ninsei-labs/sdk/xmr";
import { STAGENET_NODE } from "../lib/node.js";
import { SETTLEMENT } from "../lib/settlement.js";
import { gates } from "./page-run.mjs";

// Two valid keys that are nobody's: test vectors of the BIP39 specification.
export const KEY_ONE = "legal winner thank year wave sausage worth useful legal winner thank yellow";
export const KEY_TWO = "letter advice cage absurd amount doctor acoustic avoid letter advice cage above";
const MAKER = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";

// Noon of an example day, and the settlement block that is the latest then.
export const NOW = Date.UTC(2026, 10, 20, 12);
const NOW_SEC = NOW / 1000;
const LATEST_BLOCK = 326_100_000;
const ORDER_BLOCK = 326_050_000;
// The factory and the chain the example XMR swaps are on; an ETH world is given its own network.
const SEPOLIA = { id: "arbitrum-sepolia", chainId: 421614, factory: "0x245d3a4ac4b98d713f6c5130b56cd5d550f8cefe" };
const TIP = 2_000_000; // the top Monero block
const FUNDED_AT = TIP - 25;
const ORDER_SEC = NOW_SEC - 3600;

const word = (v) => String(v).replace(/^0x/, "").padStart(64, "0");
const topic = (signature) => "0x" + Buffer.from(keccak_256(new TextEncoder().encode(signature))).toString("hex");
export const hex = (bytes) => Buffer.from(bytes).toString("hex");
const L = ed25519.Point.Fn.ORDER;
const le = (bytes) => BigInt("0x" + hex(Uint8Array.from(bytes).reverse()));
const scalarLe = (n) => Uint8Array.from(Buffer.from(n.toString(16).padStart(64, "0"), "hex")).reverse();
const hashToScalar = (...parts) => le(keccak_256(Buffer.concat(parts.map((p) => Buffer.from(p))))) % L;
const bytes = (text) => Uint8Array.from(Buffer.from(text));
// Monero's second generator for amounts (rctTypes.h).
const H = ed25519.Point.fromHex("8b655970153799af2aeadc9ff1add0ea6c7251d54154cfa92c173a0dd39c1f94");

export const digest = (text) => createHash("sha256").update(text).digest("hex");
const halves = createHalves({
  ed25519,
  secp256k1,
  keccak256: (data) => keccak_256(typeof data === "string" ? new TextEncoder().encode(data) : data),
  randomBytes: (n) => new Uint8Array(randomBytes(n)),
});

// ONE FOUND ORDER, as the factory emits it. `side` is the person's: "locker" bought XMR, "claimer" sold it.
export function makeOrder({
  net = SEPOLIA,
  words,
  index,
  side,
  amountWei,
  t1,
  readyBy,
  person,
  maker = "0x" + "33".repeat(20),
}) {
  const { chainId, factory } = net;
  const salt = "0x" + word((index + 1).toString(16));
  const me = takerHalvesV2({ mnemonic: words, chainId, factory, salt });
  const makerHalf = takerHalvesV2({
    mnemonic: MAKER,
    chainId,
    factory,
    salt: "0x" + word((index + 500).toString(16)),
  });
  const makerPoint = halves.publicHalves(BigInt(makerHalf.spendHalf)).ed;
  const buy = side === "locker";
  const order = {
    escrow: "0x" + word((0xe000 + index).toString(16)).slice(24),
    salt,
    side,
    locker: buy ? person : maker,
    claimer: buy ? maker : person,
    commitHalfLocker: "0x" + word(buy ? me.spendCommitment : makerHalf.spendCommitment),
    commitHalfClaimer: "0x" + word(buy ? makerHalf.spendCommitment : me.spendCommitment),
    edPointLocker: "0x" + word(buy ? me.spendPoint : makerPoint),
    edPointClaimer: "0x" + word(buy ? makerPoint : me.spendPoint),
    edViewPointLocker: "0x" + word(buy ? me.viewPoint : me.makerViewPoint),
    amountWei: BigInt(amountWei),
    t1,
    readyBy,
    // The person's half is worked out when it is asked for and kept nowhere: a check that looks for it in memory must
    // not find the world's own.
    half: () => word(takerHalvesV2({ mnemonic: words, chainId, factory, salt }).spendHalf),
    makerHalf: "0x" + word(makerHalf.spendHalf),
    block: ORDER_BLOCK + index,
    events: [],
  };
  order.log = {
    address: factory,
    topics: [ORDER_CREATED_TOPIC, ...[order.escrow, order.locker, order.claimer].map((a) => "0x" + word(a))],
    data:
      "0x" +
      [
        order.commitHalfLocker,
        order.commitHalfClaimer,
        order.edPointLocker,
        order.edPointClaimer,
        order.edViewPointLocker,
        order.amountWei.toString(16),
        "0",
        readyBy.toString(16),
        t1.toString(16),
        salt,
        "0",
        "0",
        "0",
      ]
        .map(word)
        .join(""),
    blockNumber: "0x" + order.block.toString(16),
    transactionHash: "0x" + word((0xab00 + index).toString(16)),
    logIndex: "0x0",
  };
  return order;
}

export const eventLog = (order, name, values) => ({
  address: order.escrow,
  topics:
    name === "Ready"
      ? [topic("Ready(address)"), "0x" + word(values.by)]
      : name === "HalfRevealed"
        ? [topic("HalfRevealed(bytes32,bool)")]
        : [topic("Declined(address)"), "0x" + word(order.claimer)],
  data: name === "HalfRevealed" ? "0x" + word(values.half) + word(values.byClaimer ? "1" : "0") : "0x",
  blockNumber: "0x" + (order.block + 10).toString(16),
  transactionHash: "0x" + word("cc"),
  logIndex: "0x1",
});

const json = (value) => ({ ok: true, status: 200, json: async () => value, clone: () => json(value) });

/**
 * The settlement chain's public RPCs: the orders and their events, read as the page reads them. Each answer goes through
 * `call` by its name ("rpc" for an escrow's revealed half, "head" for the latest block); `failing()` refuses the logs.
 */
export function settlementChain(orders, call, failing = () => false, net = SEPOLIA) {
  const hosts = new Set(Object.values(SETTLEMENT).flatMap((net) => net.rpcs));
  const NAMES = { eth_blockNumber: "head", eth_call: "rpc" };
  return {
    answers: (url) => hosts.has(url),
    fetch(_url, init) {
      const { method, params } = JSON.parse(init.body);
      return call(NAMES[method] || method, async () => {
        if (method === "eth_blockNumber") return json({ result: "0x" + LATEST_BLOCK.toString(16) });
        if (method === "eth_getBlockByNumber") return json({ result: { timestamp: "0x" + ORDER_SEC.toString(16) } });
        if (method === "eth_getLogs") {
          const [filter] = params;
          if (failing()) return { ok: false, status: 503 };
          const from = Number(filter.fromBlock);
          const to = Number(filter.toBlock);
          const logs = filter.address
            ? orders.filter(() => filter.address.toLowerCase() === net.factory).map((order) => order.log)
            : orders.flatMap((order) => order.events);
          return json({
            result: logs.filter((log) => Number(log.blockNumber) >= from && Number(log.blockNumber) <= to),
          });
        }
        if (method === "eth_call") {
          const order = orders.find((o) => o.escrow === params[0].to.toLowerCase());
          assert.ok(order, "a call to an address that is no order's escrow");
          // revealedHalf(): the half the maker published when it took the ETH.
          assert.equal(
            params[0].data,
            "0x3f267bb6",
            "the page asked an escrow for something else than its revealed half",
          );
          return json({ result: "0x" + word(order.makerHalf) });
        }
        throw new Error("the page asked the settlement RPC for " + method);
      });
    },
  };
}

// --- the XMR side ----------------------------------------------------------------------------------

// A transaction paying `amount` to `address`: one tagged output, Bulletproof+ amounts, as monerod decodes it.
function funding(address, amount, id) {
  const { spendPub, viewPub } = decodeAddressKeys(address);
  const point = (value) => ed25519.Point.fromHex(String(value).replace(/^0x/, ""));
  const secret = hashToScalar(bytes("example transaction key " + id));
  const derivation = point(viewPub).multiply(secret).multiplyUnsafe(8n).toBytes();
  const shared = hashToScalar(derivation, [0]);
  const key = ed25519.Point.BASE.multiply(shared).add(point(spendPub)).toHex();
  const pad = keccak_256(Buffer.concat([bytes("amount"), scalarLe(shared)]));
  const plain = Uint8Array.from(Buffer.from(amount.toString(16).padStart(16, "0"), "hex")).reverse();
  const mask = hashToScalar(bytes("commitment_mask"), scalarLe(shared));
  return {
    tx: {
      version: 2,
      unlock_time: 0,
      vin: [],
      vout: [{ amount: 0, target: { tagged_key: { key, view_tag: "00" } } }],
      extra: [1, ...ed25519.Point.BASE.multiply(secret).toBytes()],
      rct_signatures: {
        type: 6,
        ecdhInfo: [{ amount: hex(plain.map((b, i) => b ^ pad[i])) }],
        outPk: [ed25519.Point.BASE.multiply(mask).add(H.multiply(amount)).toHex()],
      },
    },
    output: { index: 0, key, amountAtomic: String(amount), amountVerified: true, derivation: hex(derivation) },
  };
}

const blockHash = (height) => word((0xb10c0000000000n + BigInt(height)).toString(16));

/**
 * Swaps whose XMR can be withdrawn: buys the maker completed. Each has its own address, amount and fees, in atomic
 * units; `fees` are those of the first, second... signature, so two transfers of one swap differ on the screen. `from` is
 * the first order's number: worlds with other numbers have other keys.
 */
export async function xmrWorld({ from = 0 } = {}) {
  const gate = gates();
  const given = []; // what the node was given: { to, from, fee, id }
  const wallets = []; // every wallet the library opened: { address, closed, node, height }
  const requests = [];
  const person = "0x" + "11".repeat(20);
  const common = { side: "locker", t1: NOW_SEC - 1200, readyBy: NOW_SEC - 2400, person };
  const swaps = [
    {
      name: "first",
      words: KEY_ONE,
      eth: "0.5",
      xmr: 2_500_000_000_000n,
      fees: [30_000_000n, 41_000_000n, 52_000_000n],
    },
    { name: "second", words: KEY_ONE, eth: "0.75", xmr: 3_250_000_000_000n, fees: [33_000_000n, 44_000_000n] },
    { name: "other", words: KEY_TWO, eth: "1.25", xmr: 4_000_000_000_000n, fees: [36_000_000n, 47_000_000n] },
  ];
  const core = createNinsei({
    settlement: { chain: "arbitrum-sepolia" },
    xmrNetwork: "stagenet",
    mode: "live",
    fetch: async () => assert.fail("the example world reads no network"),
  });
  const blocks = new Map();
  for (const [at, swap] of swaps.entries()) {
    const index = from + at;
    const order = makeOrder({
      ...common,
      words: swap.words,
      index,
      amountWei: Math.round(swap.eth * 1e6) + "0".repeat(12),
    });
    order.events = [eventLog(order, "HalfRevealed", { half: order.makerHalf, byClaimer: true })];
    const built = await core.sweep.fromOrder({
      mnemonic: swap.words,
      chainId: SEPOLIA.chainId,
      network: SEPOLIA.id,
      moneroNetwork: "stagenet",
      order: { ...order, factory: SEPOLIA.factory, amount: order.amountWei.toString() },
    });
    const w = built.payload.moneroWallet;
    const keys = spendKeysFromRevealedHalf({
      halves,
      ownSpendHalf: w.spendHalf,
      ownViewHalf: w.viewHalf,
      otherSpendPoint: w.otherSpendPoint,
      otherViewHalf: w.otherViewHalf,
      revealedHalf: order.makerHalf,
    });
    assert.ok(scalarFromMoneroHex(keys.privateSpendKey) > 0n, "the example swap has no spend key");
    const id = word((0xf00d + index).toString(16));
    const { tx, output } = funding(built.address, swap.xmr, id);
    const [image] = await core.sweep.keyImages({ keys, arrival: { outputs: [output] } });
    // The spend key itself is kept nowhere here: a check that looks for it in memory must not find the world's own.
    const keyDigest = digest(keys.privateSpendKey);
    Object.assign(swap, { order, address: built.address, image: image.keyImage, signed: 0, keyDigest });
    const block = blocks.get(FUNDED_AT) || [];
    block.push({ id, tx });
    blocks.set(FUNDED_AT, block);
  }

  // THE NODE. `mode` is "ok"; "lost" when the connection drops; "short" when a block names fewer transactions than it
  // holds and the pool is not served; "spent" when the pool holds a spend of the swaps' XMR; "no-headers" when it serves
  // no block header, so no swap gets a start height. A held gate is a late answer.
  const node = { mode: "ok" };
  const SPENDING = word("5be4d");
  const header = (height) => ({
    height,
    hash: blockHash(height),
    prev_hash: blockHash(height - 1),
    timestamp: NOW_SEC - 60 - (TIP - height) * 120,
    num_txes: (blocks.get(height) || []).length,
  });
  const moneroNode = (url, init) => {
    const path = url.slice(STAGENET_NODE.length);
    const request = JSON.parse(init.body);
    // The withdrawal's own read of the node (readRecovery) names itself "info"; a probe does not.
    const read = request.method === "get_info" && request.id === "info";
    const name = read ? "node" : request.method === "get_info" ? "probe " + STAGENET_NODE : "monero";
    return gate.call(name, async () => {
      if (path === "/json_rpc") {
        if (request.method === "get_info") {
          if (read && node.mode === "lost") throw new TypeError("Failed to fetch");
          return json({ result: { status: "OK", height: TIP + 1, nettype: "stagenet", synchronized: true } });
        }
        if (request.method === "get_block_header_by_height") {
          if (node.mode === "no-headers") return { ok: false, status: 503 };
          return json({ result: { status: "OK", block_header: header(request.params.height) } });
        }
        if (request.method === "get_block") {
          const txs = (blocks.get(request.params.height) || []).map((entry) => entry.id);
          return json({
            result: {
              status: "OK",
              block_header: header(request.params.height),
              tx_hashes: node.mode === "short" ? [] : txs,
            },
          });
        }
      }
      if (path === "/get_transactions") {
        const spends = swaps.map((swap) => ({ key: { k_image: swap.image, key_offsets: [] } }));
        const spending = { id: SPENDING, tx: { version: 2, vin: spends, vout: [], extra: [] } };
        const all = [...blocks.values()].flat().concat(spending);
        const found = request.txs_hashes.map((id) => all.find((entry) => entry.id === id));
        return json({
          status: "OK",
          txs: found.map((entry) => ({ tx_hash: entry.id, block_height: FUNDED_AT })),
          txs_as_json: found.map((entry) => JSON.stringify(entry.tx)),
        });
      }
      if (path === "/get_transaction_pool_hashes") {
        if (node.mode === "short") return { ok: false, status: 503 };
        return json({ status: "OK", tx_hashes: node.mode === "spent" ? [SPENDING] : [] });
      }
      throw new Error("the page asked the Monero node for " + path + " " + (request.method || ""));
    });
  };

  const chain = settlementChain(
    swaps.map((swap) => swap.order),
    gate.call,
    () => world.failLogs,
  );
  const world = {
    now: NOW,
    swaps,
    given,
    wallets,
    node,
    requests,
    hold: gate.hold,
    quiet: gate.quiet,
    failLogs: false, // the settlement RPCs do not serve the orders
    partlyOpens: false, // the library makes a wallet and then cannot set its start height
    relay: "ok", // "ok", "lost" (accepted, the answer lost) or "no-id" (answered without a transaction id)
    async fetch(url, init) {
      requests.push({ url, body: init && init.body });
      if (url.startsWith("./monero.worker.js"))
        return { status: 200, arrayBuffer: async () => new ArrayBuffer(1_500_000) };
      if (chain.answers(url)) return chain.fetch(url, init);
      if (url.startsWith(STAGENET_NODE)) return moneroNode(url, init);
      // Another listed node: a mainnet one, which is never a swap's node here.
      if (url.endsWith("/json_rpc"))
        return gate.call("probe " + url.slice(0, -"/json_rpc".length), async () =>
          json({ result: { status: "OK", height: 3_500_000, nettype: "mainnet", synchronized: true } }),
        );
      throw new Error("the page asked " + url);
    },
    // monero-ts: one wallet from keys. `sweepUnlocked` signs the whole balance, less its fee, to one address, and
    // `relayTxs` gives it to the node.
    createWallet(config) {
      return gate.call("connect", async () => {
        const swap = swaps.find((entry) => entry.address === config.primaryAddress);
        assert.ok(swap, "a wallet for an address that is no swap's");
        assert.equal(digest(config.privateSpendKey), swap.keyDigest, "a wallet with another swap's key");
        const { uri } = config.server;
        const record = {
          address: swap.address,
          name: swap.name,
          node: uri,
          height: config.restoreHeight,
          closed: false,
        };
        wallets.push(record);
        const open = () => {
          if (record.closed) throw new Error("Wallet is closed");
        };
        const step =
          (name, run = async () => {}) =>
          (...args) =>
            gate.call(name, async () => {
              open();
              return run(...args);
            });
        return {
          getAddress: step("wallet", async () => swap.address),
          setRestoreHeight: step("wallet", async () => {
            if (world.partlyOpens) throw new Error("example: the start height was not set");
          }),
          getRestoreHeight: step("wallet", async () => record.height),
          rescanBlockchain: step("scan"),
          rescanSpent: step("wallet"),
          sync: step("sync"),
          getHeight: step("wallet", async () => TIP + 1),
          getDaemonHeight: step("wallet", async () => TIP + 1),
          getBalance: step("wallet", async () => swap.xmr),
          getUnlockedBalance: step("wallet", async () => swap.xmr),
          getTxs: step("wallet", async () => [{}]),
          getOutputs: step("wallet", async () => [
            { getIsLocked: () => false, getIsFrozen: () => false, getKeyImage: () => ({ getHex: () => swap.image }) },
          ]),
          addListener: step("wallet"),
          removeListener: step("wallet"),
          sweepUnlocked: step("sign", async ({ address, relay }) => {
            assert.equal(relay, false, "a signature that sends");
            const fee = swap.fees[(swap.signed += 1) - 1];
            const id = word((0x5e4d0000 + swaps.indexOf(swap) * 256 + swap.signed).toString(16));
            const inputs = [{ getKeyImage: () => ({ getHex: () => swap.image }) }];
            const tx = { to: address, amount: swap.xmr - fee, fee, id };
            return [{ ...tx, getHash: () => id, getFee: () => fee, getInputs: () => inputs }];
          }),
          // The node has the transfer from the call on; its answer is the held one.
          relayTxs: (signed) => {
            open();
            for (const { to, amount, fee, id } of signed) given.push({ from: swap.name, to, amount, fee, id });
            return gate.call("relay", async () => {
              if (world.relay === "lost") throw new Error("the connection was reset");
              return world.relay === "no-id" ? [] : signed.map((tx) => tx.id);
            });
          },
          async close() {
            record.closed = true;
          },
        };
      });
    },
  };
  return world;
}

// --- the ETH side ----------------------------------------------------------------------------------

// The escrow's own rule for a half (NinseiEscrow.halfMatchesCommit): the low 160 bits of keccak256(x || y) of half * G.
function halfCommitment(half) {
  const { x, y } = secp256k1.Point.BASE.multiply(BigInt(half)).toAffine();
  const point = Buffer.from([x, y].map((v) => v.toString(16).padStart(64, "0")).join(""), "hex");
  return hex(keccak_256(point)).slice(-40);
}

/**
 * Swaps whose ETH can be taken on `net`, and a person's EVM wallet (EIP-1193). Two buys past their deadline, and a sell
 * its maker marked ready, in its claim window, of one key; a buy past its deadline of another. `from` is the first order's
 * number: worlds with other numbers have other halves.
 */
export function ethWorld(net, { from = 20 } = {}) {
  const gate = gates();
  const requests = []; // every request that left the page, to a host or to the wallet, with what it carried
  const sent = []; // the transactions the wallet was handed, each with the hash it answered with
  const person = "0x" + "11".repeat(20);
  const depositor = "0x" + "44".repeat(20);
  const past = { t1: NOW_SEC - 600, readyBy: NOW_SEC - 1800 };
  const open = { t1: NOW_SEC + 3600, readyBy: NOW_SEC + 1800 };
  const orders = {
    refund: { words: KEY_ONE, eth: "0.6", side: "locker", ...past },
    claim: { words: KEY_ONE, eth: "0.8", side: "claimer", maker: depositor, ...open },
    again: { words: KEY_ONE, eth: "0.9", side: "locker", ...past },
    other: { words: KEY_TWO, eth: "1.1", side: "locker", ...past },
  };
  Object.values(orders).forEach((entry, at) => {
    const order = makeOrder({ ...entry, net, index: from + at, person, amountWei: entry.eth * 10 + "0".repeat(17) });
    const own = entry.side === "locker" ? order.commitHalfLocker : order.commitHalfClaimer;
    assert.equal(own.slice(-40), halfCommitment("0x" + order.half()), "the example order commits to another half");
    order.events = entry.side === "claimer" ? [eventLog(order, "Ready", { by: depositor })] : [];
    Object.assign(entry, { order, escrow: order.escrow });
  });
  const all = Object.values(orders).map((entry) => entry.order);

  const selector = (name) => topic(name + "()").slice(0, 10);
  const slots = (order) => ({
    status: word("1") + word("0") + word("0") + word(order.amountWei.toString(16)),
    ready: word(order.side === "claimer" ? depositor : "0"),
    t1: word(order.t1.toString(16)),
    readyBy: word(order.readyBy.toString(16)),
    termsHash: word("7e"),
    edPointLocker: word(order.edPointLocker),
    edPointClaimer: word(order.edPointClaimer),
    edViewPointLocker: word(order.edViewPointLocker),
    commitHalfLocker: word(order.commitHalfLocker),
    commitHalfClaimer: word(order.commitHalfClaimer),
  });

  const fail = (code, message) => Object.assign(new Error(message), { code });
  // A transaction's hash is the wallet's, one for each; its receipt is the chain's, by that hash and no other.
  const hashOf = (count) => "0x" + word((0x5a5a00 + count).toString(16));
  const wallet = {
    account: person,
    chainId: 1, // where the wallet is when the page meets it
    known: [1], // the networks it knows; another is answered 4902, as EIP-3326 has it
    selects: true, // it selects a network it added
    stays: false, // it says it switched and did not
    fails: {}, // method -> error it answers with
    noHash: false, // it answers a transaction without its hash
    receipts: {}, // hash -> what the chain says of it; every transaction has `receipt` unless it is here
    receipt: { status: "0x1" },
    asked: [], // the hashes it was asked the receipt of
    offered: [], // what it was offered by wallet_addEthereumChain
    prompts: [], // what it asked the person: the networks it was asked to select or add, and the transactions
    request({ method, params = [] }) {
      requests.push({ to: "wallet", method, body: JSON.stringify(params) });
      return gate.call(method, async () => {
        if (wallet.fails[method]) throw wallet.fails[method];
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [wallet.account];
        if (method === "eth_chainId") return "0x" + wallet.chainId.toString(16);
        if (method === "wallet_switchEthereumChain") {
          const id = Number(params[0].chainId);
          if (!wallet.known.includes(id)) throw fail(4902, "Unrecognized chain ID. Try adding the chain first.");
          wallet.prompts.push("select");
          if (!wallet.stays) wallet.chainId = id;
          return null;
        }
        if (method === "wallet_addEthereumChain") {
          wallet.prompts.push("add");
          wallet.offered.push(params[0]);
          wallet.known.push(Number(params[0].chainId));
          if (wallet.selects && !wallet.stays) wallet.chainId = Number(params[0].chainId);
          return null;
        }
        if (method === "eth_getBlockByNumber") return { timestamp: "0x" + NOW_SEC.toString(16) };
        if (method === "eth_call") {
          const order = all.find((entry) => entry.escrow === params[0].to.toLowerCase());
          assert.ok(order, "the wallet was asked to read an address that is no order's escrow");
          const read = Object.entries(slots(order)).find(([name]) => selector(name) === params[0].data);
          assert.ok(read, "the wallet was asked to read " + params[0].data);
          return "0x" + read[1];
        }
        if (method === "eth_sendTransaction") {
          const hash = hashOf(sent.length + 1);
          sent.push({ ...params[0], hash, on: wallet.chainId });
          return wallet.noHash ? undefined : hash;
        }
        if (method === "eth_getTransactionReceipt") {
          const [hash] = params;
          wallet.asked.push(hash);
          // A RECEIPT IS ONE NETWORK'S: the wallet answers for the one it is on.
          if (!sent.some((tx) => tx.hash === hash && tx.on === wallet.chainId)) return null;
          const receipt = hash in wallet.receipts ? wallet.receipts[hash] : wallet.receipt;
          return receipt && { transactionHash: hash, ...receipt };
        }
        throw fail(4200, "the wallet does not support " + method);
      });
    },
  };

  const chain = settlementChain(all, gate.call, () => false, net);
  return {
    now: NOW,
    net,
    orders,
    person,
    wallet,
    ethereum: wallet,
    requests,
    sent,
    hold: gate.hold,
    quiet: gate.quiet,
    hashOf,
    fail,
    async fetch(url, init) {
      requests.push({ to: url, method: "POST", body: (init && init.body) || "" });
      if (url.startsWith("./monero.worker.js"))
        return { status: 200, arrayBuffer: async () => new ArrayBuffer(1_500_000) };
      if (chain.answers(url)) return chain.fetch(url, init);
      if (url.endsWith("/json_rpc")) {
        const { method, params } = JSON.parse(init.body);
        const stagenet = url.startsWith(STAGENET_NODE);
        const info = { status: "OK", height: TIP + 1, nettype: stagenet ? "stagenet" : "mainnet", synchronized: true };
        if (method === "get_info") return json({ result: info });
        const timestamp = NOW_SEC - 60 - (TIP - params.height) * 120;
        return json({ result: { status: "OK", block_header: { height: params.height, timestamp } } });
      }
      throw new Error("the page asked " + url);
    },
    async createWallet() {
      assert.fail("a Monero wallet was opened for an ETH action");
    },
  };
}
