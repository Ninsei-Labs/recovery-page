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
const ROOT = (process.env.ROOT || "dist").replace(/[\\/]+$/, "");
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";

const SECURITY = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self'",
  "img-src 'self' data:",
  // The node is the visitor's choice: any http(s) host must be reachable, or the field on the page
  // would be a lie.
  "connect-src 'self' http: https:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

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
  const headers = new Headers(SECURITY);
  headers.set("Content-Security-Policy", CSP);
  headers.set("Content-Type", TYPES[ext] || "application/octet-stream");
  // Bundles are stamped with their content hash in `?v=`, so a year is safe. The page, the service
  // worker and build.json must not be cached: a stale page against a new build is a support call.
  if (pathname.startsWith("/assets/") || pathname === "/monero.worker.js") {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    headers.set("Cache-Control", "no-cache");
  }
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
