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
