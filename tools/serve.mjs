// A LOCAL SERVER FOR THE BUILT PAGE, WITH THE HEADERS THE PAGE NEEDS.
//
// This is not a production server: it exists so a change can be looked at in a browser without
// installing nginx. It serves `dist/` and sets the two headers that make the document cross-origin
// isolated, which is what the wallet needs for SharedArrayBuffer.
//
//   node tools/serve.mjs                # headers on, as nginx would send them
//   node tools/serve.mjs --no-headers   # headers off, to exercise the service-worker fallback
//   node tools/serve.mjs --mock-node    # also answer /json_rpc with a fixed get_info
//
// THE MOCK NODE IS A SMOKE AID, NOT A NODE: it answers `get_info` so the page's preflight reaches its
// last step, and refuses every other path. The wallet's sync cannot run against it, and the page will
// say so - which is the honest outcome of a mock.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../dist", import.meta.url)));
const args = process.argv.slice(2);
const headerArgs = args.includes("--no-headers");
const mockNode = args.includes("--mock-node");
const port = Number((args.find((a) => a.startsWith("--port=")) || "").split("=")[1] || 5195);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".bin": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
};

const ISOLATION = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' http: https:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function headersFor(file) {
  const headers = { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" };
  if (!headerArgs) Object.assign(headers, ISOLATION, { "Content-Security-Policy": CSP });
  return headers;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);

  if (mockNode && url.pathname === "/json_rpc") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let method = null;
    try {
      method = JSON.parse(body || "{}").method || null;
    } catch {
      method = null;
    }
    const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin", "Cache-Control": "no-store" };
    if (req.method === "OPTIONS") {
      res.writeHead(204, { ...headers, "Access-Control-Allow-Headers": "content-type" });
      res.end();
      return;
    }
    if (method !== "get_info") {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ jsonrpc: "2.0", id: "mock", error: { code: -32601, message: "the mock node knows get_info only" } }));
      return;
    }
    res.writeHead(200, headers);
    res.end(JSON.stringify({ jsonrpc: "2.0", id: "mock", result: { height: 1, nettype: "stagenet", synchronized: true, version: "mock" } }));
    return;
  }

  if (mockNode && url.pathname.startsWith("/get")) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("the mock node does not serve wallet blocks");
    return;
  }

  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
  let file = join(ROOT, rel);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end("outside the root");
    return;
  }
  try {
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, "index.html");
    const bytes = await readFile(file);
    res.writeHead(200, headersFor(file));
    res.end(bytes);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found: " + rel);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`serving ${ROOT}`);
  console.log(`http://127.0.0.1:${port}/  headers=${headerArgs ? "off (service-worker fallback)" : "on"} mockNode=${mockNode ? "on" : "off"}`);
});
