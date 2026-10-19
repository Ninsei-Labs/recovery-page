// THE FALLBACK FOR HOSTS WITHOUT HEADER CONTROL: every GET response this origin serves gets the two
// headers that make a document cross-origin isolated. See coi.js for why this exists and what it
// cannot do (the first load is not covered; the page reloads once).
//
// RULES:
//   * GET only. The wallet reads; nothing is posted through here.
//   * no caching: a stale worker would keep serving an old header policy after an update.
//   * an opaque answer is passed through untouched - its headers cannot be read, and rewriting it
//     would turn a working request into an error.
//   * the body is streamed, not buffered: the wallet's worker file is a few megabytes.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const COOP = "same-origin";
const COEP = "require-corp";
const CORP = "same-origin";

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  event.respondWith(
    (async () => {
      const response = await fetch(request);
      if (response.type === "opaque" || response.type === "opaqueredirect") return response;
      const headers = new Headers(response.headers);
      headers.set("Cross-Origin-Opener-Policy", COOP);
      headers.set("Cross-Origin-Embedder-Policy", COEP);
      headers.set("Cross-Origin-Resource-Policy", CORP);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    })(),
  );
});
