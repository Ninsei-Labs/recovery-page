// CROSS-ORIGIN ISOLATION ON HOSTS THAT CANNOT SET HEADERS.
//
// The wallet needs SharedArrayBuffer, and a browser only exposes it when the document is cross-origin
// isolated: `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`
// on the response. A server of your own sets those two headers (see deploy/nginx.conf and
// deploy/_headers). GitHub Pages and most IPFS gateways do not.
//
// For those hosts a service worker can add the headers to the responses it serves. It cannot help the
// FIRST load - the document is already parsed by the time the worker registers - so this file reloads
// the page once. The second load comes through the worker and is isolated.
//
// WHAT THIS IS NOT: a replacement for real headers. When the host can set them, this file does
// nothing (the page is already isolated). It is a fallback that keeps the page usable where the host
// gives no control over headers, and the page says nothing about it - the preflight only reports
// whether isolation is there, which is the fact that matters.
(async () => {
  if (typeof self === "undefined" || typeof navigator === "undefined") return;
  if (self.crossOriginIsolated) return;
  if (!("serviceWorker" in navigator)) return;
  if (!self.isSecureContext) return; // a worker needs https or localhost

  const FLAG = "ninsei.coi.reloaded";
  try {
    await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    await navigator.serviceWorker.ready;
    if (self.crossOriginIsolated) return;
    // A second load that is still not isolated means the worker is not controlling this page (an
    // aggressive cache, a gateway that strips workers). Reloading again would loop, so stop and leave
    // the reason in the console; the page's own preflight reports the missing isolation in words.
    let already = false;
    try {
      already = sessionStorage.getItem(FLAG) === "1";
    } catch {
      already = false;
    }
    if (already) {
      console.error("coi: the service worker is registered but this page is still not cross-origin isolated");
      return;
    }
    try {
      sessionStorage.setItem(FLAG, "1");
    } catch {
      // Without storage the reload still happens once per page load; a loop is prevented by the
      // worker's own controller check above in practice.
    }
    location.reload();
  } catch (e) {
    console.error("coi: " + String((e && e.message) || e));
  }
})();
