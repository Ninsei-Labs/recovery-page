// THE SETTLEMENT CHAINS A RECOVERY KEY IS SEARCHED ON, AND HOW THE PAGE READS THEM.
//
// The page never moves ETH. It reads the settlement chain for the swaps a key made (the factory's OrderCreated
// logs), for each swap's state and the time of its order, and for the key half the escrow published when the deal
// settled (a claim or a refund), without which a halves wallet cannot spend.
//
// THE READS ARE PLAIN JSON-RPC over public RPCs, tried in order. Each one was checked from this page's own origin:
// it answers CORS for the JSON content type and names the chain id below. Many public RPCs do not (no CORS, or an
// API key), and fail in a browser while answering curl. Every answer is public chain data; a request carries a
// factory or an escrow address, a topic, a block number or a call, never a key.
//
// PER NETWORK, BESIDE ITS RPCS:
//   monero    - the Monero network its swaps settle against. A key names no network, and the SDK's registry does
//               not pair a settlement chain with a Monero one, so the pairing lives here: testnet with stagenet.
//   factories - for each factory the key search reads, a block at or before its deployment. Public RPCs refuse a
//               log query from block 0, and a search that starts after the factory's first order would miss it and
//               say "no swaps". The SDK's registry names no deployment block; a factory it names without a block
//               here fails the repository's checks instead of being searched from a guess.

export const SETTLEMENT = Object.freeze({
  arbitrum: Object.freeze({
    chainId: 42161,
    monero: "mainnet",
    factories: Object.freeze({}),
    rpcs: Object.freeze([
      "https://arb1.arbitrum.io/rpc",
      "https://arbitrum-one-rpc.publicnode.com",
      "https://arbitrum.drpc.org",
    ]),
  }),
  "arbitrum-sepolia": Object.freeze({
    chainId: 421614,
    monero: "stagenet",
    factories: Object.freeze({
      // Release contracts-testnet-2026.10.21 (SDK 0.46.2). The block is the first of 2026-10-14 UTC, a week before
      // the release: public RPCs keep no state that old, so the deployment block itself cannot be read back.
      "0x3ee25f12758ec28e5b3045d16132d89cd0bf341f": 318_911_595,
    }),
    rpcs: Object.freeze([
      "https://sepolia-rollup.arbitrum.io/rpc",
      "https://arbitrum-sepolia-rpc.publicnode.com",
      "https://arbitrum-sepolia.drpc.org",
    ]),
  }),
});

// AN RPC THAT TAKES LONGER than this is skipped for the next one.
export const RPC_TIMEOUT_MS = 8000;

export function settlementOf(network) {
  return Object.prototype.hasOwnProperty.call(SETTLEMENT, network) ? SETTLEMENT[network] : null;
}

// THE NETWORKS A KEY IS SEARCHED ON: every chain the SDK's registry (CHAINS) gives a live factory, except a hidden
// one (a local test chain). `search` holds what the search needs; a live chain the page cannot read (no RPCs here,
// another chain id, or no deployment block for its factory) goes to `unreadable`, so the page says it was not
// searched instead of finding nothing there.
export function keyNetworks(chains) {
  const search = [];
  const unreadable = [];
  for (const chain of Array.isArray(chains) ? chains : []) {
    const escrow = chain && chain.escrow;
    if (!escrow || escrow.mode !== "live" || typeof escrow.address !== "string" || chain.hidden) continue;
    const own = settlementOf(chain.id);
    const since = own ? own.factories[escrow.address.toLowerCase()] : undefined;
    if (!own || own.chainId !== chain.chainId || !Number.isSafeInteger(since)) {
      unreadable.push(chain.id);
      continue;
    }
    search.push({
      id: chain.id, name: chain.name || chain.id, chainId: chain.chainId, factory: escrow.address, since,
      monero: own.monero, native: chain.native || null,
    });
  }
  return { search, unreadable };
}

const HEX = /^0x[0-9a-fA-F]*$/;

// THE SDK'S CHAIN-READ SEAM: ({ to, data }) -> hex. A transport failure moves on to the next RPC; a
// revert is the chain's answer and is the same on every RPC, so it is thrown at once. When no RPC
// answers, the read throws: a missing answer is unknown, never "0x" (which would read as an empty
// result and look like a state of the deal).
export async function evmCall(network, request, fetchImpl = globalThis.fetch) {
  const chain = settlementOf(network);
  if (!chain) throw new Error(`unknown settlement network: ${network}`);
  const to = request && request.to;
  const data = request && request.data;
  if (typeof to !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error("eth_call: bad address");
  if (typeof data !== "string" || !HEX.test(data)) throw new Error("eth_call: bad data");
  const failures = [];
  for (const url of chain.rpcs) {
    let body;
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
      if (!response.ok) {
        failures.push(`${url}: HTTP ${response.status}`);
        continue;
      }
      body = await response.json();
    } catch (error) {
      failures.push(`${url}: ${(error && error.name) || "error"}`);
      continue;
    }
    if (body && body.error) {
      const revert = /revert/i.test(String(body.error.message || "")) || body.error.code === 3;
      if (revert) throw new Error(`eth_call reverted: ${body.error.message || body.error.code}`);
      failures.push(`${url}: RPC ${body.error.code ?? "error"}`);
      continue;
    }
    if (!body || typeof body.result !== "string" || !HEX.test(body.result)) {
      failures.push(`${url}: no result`);
      continue;
    }
    return body.result;
  }
  throw new Error(`no ${network} RPC answered (${failures.join("; ")})`);
}


// THE SDK'S LOG-READ SEAM: ({ address, topics, fromBlock, toBlock }) -> logs. The recovery key search sends the
// factory and the OrderCreated topic; it never sends the key, a half or a commitment. The same public RPCs and the
// same timeout as the call above. A transport failure or an RPC error (a range one RPC refuses, a rate limit) moves
// on to the next RPC; when none answers, the read throws: a missing answer is unknown, never an empty list.
//
// A RANGE IS READ IN WINDOWS of at most LOG_WINDOW blocks: the RPC that serves wide ranges refuses more than ten
// million blocks in one query, and a testnet factory a month old already spans more. The windows cover the range
// exactly, in order, and a window no RPC answers fails the whole read: a list with a hole in it would say "no swap"
// for a swap that is there.
export const LOG_WINDOW = 9_000_000;

export async function evmLogs(network, request, fetchImpl = globalThis.fetch) {
  const chain = settlementOf(network);
  if (!chain) throw new Error(`unknown settlement network: ${network}`);
  const address = request && request.address;
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("eth_getLogs: bad address");
  const topics = request && request.topics;
  if (!Array.isArray(topics)) throw new Error("eth_getLogs: bad topics");
  for (const topic of topics) {
    if (topic !== null && typeof topic !== "string") throw new Error("eth_getLogs: bad topic");
  }
  // JSON-RPC TAKES HEX BLOCK TAGS, NOT JAVASCRIPT NUMBERS: a numeric 0 is refused as "hex string without 0x
  // prefix" (measured in the browser). Normalise here, once, so a caller can pass 0 or a height naturally.
  const blockTag = (value, fallback) => {
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return "0x" + value.toString(16);
    if (typeof value === "string") return value;
    throw new Error("eth_getLogs: bad block tag");
  };
  const from = request && request.fromBlock;
  const to = request && request.toBlock;
  const windows = [];
  if (Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 0 && to >= from) {
    for (let start = from; start <= to; start += LOG_WINDOW) windows.push([blockTag(start), blockTag(Math.min(to, start + LOG_WINDOW - 1))]);
  } else {
    windows.push([blockTag(from, "earliest"), blockTag(to, "latest")]);
  }
  const logs = [];
  for (const [fromBlock, toBlock] of windows) {
    logs.push(...(await logWindow(network, chain, { address, topics, fromBlock, toBlock }, fetchImpl)));
  }
  return logs;
}

async function logWindow(network, chain, filter, fetchImpl) {
  const failures = [];
  for (const url of chain.rpcs) {
    let body;
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [filter] }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
      if (!response.ok) {
        failures.push(`${url}: HTTP ${response.status}`);
        continue;
      }
      body = await response.json();
    } catch (error) {
      failures.push(`${url}: ${(error && error.name) || "error"}`);
      continue;
    }
    if (body && body.error) {
      failures.push(`${url}: RPC ${body.error.code ?? "error"}`);
      continue;
    }
    if (!body || !Array.isArray(body.result)) {
      failures.push(`${url}: no result`);
      continue;
    }
    return body.result;
  }
  throw new Error(`no ${network} RPC answered eth_getLogs ${filter.fromBlock}..${filter.toBlock} (${failures.join("; ")})`);
}


// THE TIME OF ONE BLOCK, in seconds: the block that holds a found order's OrderCreated, from which the swap's
// Monero start height is derived (lib/start-height.js). The request names a block number, never a key. A transport
// failure or an answer without a time moves on to the next RPC; when none answers, the read throws: a missing time
// is unknown, never 0.
export async function evmBlockTime(network, blockNumber, fetchImpl = globalThis.fetch) {
  const chain = settlementOf(network);
  if (!chain) throw new Error(`unknown settlement network: ${network}`);
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) throw new Error("eth_getBlockByNumber: bad block number");
  const failures = [];
  for (const url of chain.rpcs) {
    let body;
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["0x" + blockNumber.toString(16), false] }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
      if (!response.ok) {
        failures.push(`${url}: HTTP ${response.status}`);
        continue;
      }
      body = await response.json();
    } catch (error) {
      failures.push(`${url}: ${(error && error.name) || "error"}`);
      continue;
    }
    const stamp = body && body.result && body.result.timestamp;
    if (typeof stamp !== "string" || !/^0x[0-9a-fA-F]+$/.test(stamp) || BigInt(stamp) === 0n) {
      failures.push(`${url}: ${body && body.error ? `RPC ${body.error.code ?? "error"}` : "no block time"}`);
      continue;
    }
    return Number(BigInt(stamp));
  }
  throw new Error(`no ${network} RPC answered the time of block ${blockNumber} (${failures.join("; ")})`);
}

export async function evmBlockNumber(network, fetchImpl = globalThis.fetch) {
  const chain = settlementOf(network);
  if (!chain) throw new Error(`unknown settlement network: ${network}`);
  for (const url of chain.rpcs) {
    try {
      const response = await fetchImpl(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
      if (!response.ok) continue;
      const body = await response.json();
      if (body && typeof body.result === "string" && /^0x[0-9a-fA-F]+$/.test(body.result)) return Number(BigInt(body.result));
    } catch { /* try the next RPC */ }
  }
  throw new Error(`no ${network} RPC answered eth_blockNumber`);
}
