// THE SETTLEMENT CHAIN A RECOVERY FILE NAMES, AND HOW THE PAGE READS IT.
//
// The page never moves ETH. It reads the settlement chain for one thing: the key half the escrow
// published when the deal settled (a claim or a refund), without which a halves wallet cannot spend.
// The network comes from the file (`payload.network`); a file naming a network this list does not
// know is refused, never read against a default chain.
//
// THE READ IS A PLAIN `eth_call` over public RPCs, tried in order. Each one was checked from this
// page's own origin with isolation on: it answers CORS for the JSON content type and names the chain
// id below. Many public RPCs do not (no CORS, or an API key), and fail in a browser while answering
// curl. Every answer is public chain data; the request carries an escrow address and a call, never a
// key.

export const SETTLEMENT = Object.freeze({
  arbitrum: Object.freeze({
    chainId: 42161,
    rpcs: Object.freeze([
      "https://arb1.arbitrum.io/rpc",
      "https://arbitrum-one-rpc.publicnode.com",
      "https://arbitrum.drpc.org",
    ]),
  }),
  "arbitrum-sepolia": Object.freeze({
    chainId: 421614,
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
// factory, the OrderCreated topic and (when the person names one) their address; it never sends the key, a half or
// a commitment. The same public RPCs and the same timeout as the call above; a transport failure moves on, an RPC
// error is the chain's answer and is thrown at once.
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
  const fromBlock = blockTag(request && request.fromBlock, "earliest");
  const toBlock = blockTag(request && request.toBlock, "latest");
  const failures = [];
  for (const url of chain.rpcs) {
    let body;
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ address, topics, fromBlock, toBlock }] }),
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
  throw new Error(`no ${network} RPC answered eth_getLogs (${failures.join("; ")})`);
}


// THE CURRENT HEIGHT, for bounding a log search: public RPCs refuse a query that spans tens of millions of blocks.
// THE SETTLEMENT BLOCK'S TIMESTAMP, for `findSwaps`'s Monero start height. One public RPC, one answer; a block
// without a timestamp is unknown, never zero.
export async function evmBlockTime(network, blockNumber, fetchImpl = globalThis.fetch) {
  const chain = settlementOf(network);
  if (!chain) throw new Error(`unknown settlement network: ${network}`);
  const number = Number(blockNumber);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("eth_getBlockByNumber: bad block");
  const tag = "0x" + number.toString(16);
  const failures = [];
  for (const url of chain.rpcs) {
    let body;
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: [tag, false] }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
      if (!response.ok) { failures.push(`${url}: HTTP ${response.status}`); continue; }
      body = await response.json();
    } catch (error) {
      failures.push(`${url}: ${(error && error.name) || "error"}`);
      continue;
    }
    if (body && body.error) { failures.push(`${url}: RPC ${body.error.code ?? "error"}`); continue; }
    const timestamp = Number.parseInt(body && body.result && body.result.timestamp, 16);
    if (Number.isFinite(timestamp) && timestamp > 0) return timestamp;
    failures.push(`${url}: no timestamp`);
  }
  throw new Error(`no ${network} RPC answered (${failures.join("; ")})`);
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
