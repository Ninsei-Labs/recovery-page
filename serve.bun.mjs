// THE CONTAINER'S WEB SERVER: Bun, one file, no dependencies.
//
// It serves the built page with its Content-Security-Policy and caching rules, which is why this file
// exists instead of `bun --serve`: the CSP is what keeps any other host's script out of a page that
// holds spend keys. The wallet needs no cross-origin isolation, so no COEP is sent.
//
// WHAT IT DOES NOT DO: TLS. Terminate TLS in front of it (a reverse proxy, a load balancer, a tunnel)
// and keep the CSP intact there as well - this server sends it, but a proxy that rewrites its own
// headers can still drop it.
//
// Environment:
//   PORT  (default 8080)  - the port to listen on
//   ROOT  (default ./dist) - the directory with dist/'s contents
//   HOST  (default 0.0.0.0) - the interface to bind
import { CSP, SECURITY_HEADERS, cacheControl } from "./deploy/http-policy.mjs";

const ROOT = (process.env.ROOT || "dist").replace(/[\\/]+$/, "");
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";

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
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function headersFor(pathname) {
  const ext = pathname.slice(pathname.lastIndexOf("."));
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("Content-Security-Policy", CSP);
  headers.set("Content-Type", TYPES[ext] || "application/octet-stream");
  headers.set("Cache-Control", cacheControl(pathname));
  return headers;
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(request) {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith("/")) pathname += "index.html";

    // Nothing outside ROOT, no dotfiles: the directory holds a page, not a filesystem.
    if (pathname.includes("\0") || pathname.split("/").some((part) => part === ".." || part.startsWith("."))) {
      return new Response("not found", { status: 404, headers: { "Content-Type": "text/plain" } });
    }

    const file = Bun.file(ROOT + pathname);
    if (!(await file.exists())) {
      return new Response("not found: " + pathname, {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    const headers = headersFor(pathname);
    if (request.method === "HEAD") return new Response(null, { headers });
    return new Response(file, { headers });
  },
});

console.log(`recovery: serving ${ROOT} on http://${HOST}:${server.port}`);
