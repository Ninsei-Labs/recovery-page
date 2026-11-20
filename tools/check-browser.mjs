// THE PAGE'S POLICY IN A REAL BROWSER.
//
// The page holds the twelve words, and its connect-src is what keeps a script injected into it from sending them to
// a host of its own (deploy/http-policy.mjs). A check of the policy's text cannot show that a browser reads it the
// same way, so this one opens the built page in Chrome twice: as serve.bun.mjs serves it, with its headers, and as a
// host that sends no headers serves it (GitHub Pages, an IPFS gateway), where only the meta tag the build writes into
// the page carries the policy. Each time it:
//
//   1. lets the page start: its wallet check passes and the policy refuses nothing the page loads;
//   2. asks a host the page does not list (another https host, a loopback node) from the page: the browser must
//      refuse each with a connect-src violation, before any request leaves;
//   3. asks a listed node and a settlement RPC: each must be let through. Those requests are answered here, through
//      the DevTools protocol, so the check sends nothing to the real hosts.
//
// No dependency: Chrome is driven over its DevTools protocol with Bun's own WebSocket. Chrome comes from CHROME_BIN
// or the first of google-chrome, google-chrome-stable, chromium or chromium-browser on PATH. Its path, version and the
// time it took to answer are printed, so a slow or failing run in CI says which browser it met.
//
// Run: bun run build, then bun run test:browser
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_NODE, STAGENET_NODE } from "../lib/node.js";
import { SETTLEMENT } from "../lib/settlement.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// EVERY WAIT HAS A LIMIT, so a broken page or a stalled browser fails the check instead of hanging it; nothing waits
// for time to pass. A browser's first start on a fresh CI machine is slow: one GitHub runner's Chrome had not reached
// its D-Bus setup 18 s after launch, where a warm machine answers in under a second. Its limit leaves room for that.
const SERVER_LIMIT_MS = 20_000;
const CHROME_LIMIT_MS = 120_000;
const COMMAND_LIMIT_MS = 30_000;
const PAGE_LIMIT_MS = 60_000;

const UNLISTED = ["https://example.test/json_rpc", "http://127.0.0.1:18081/json_rpc"];
const LISTED = [DEFAULT_NODE + "/json_rpc", STAGENET_NODE + "/json_rpc", SETTLEMENT["arbitrum-sepolia"].rpcs[0]];

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const found = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  return null;
}

// A child process's first output line that matches `pattern`, or a failure when the process ends or the limit passes.
// The failure carries the end of what the process said.
function lineOf(child, stream, pattern, what, limitMs) {
  return new Promise((resolve, reject) => {
    let seen = "";
    const timer = setTimeout(
      () => reject(new Error(`${what}: no answer in ${limitMs} ms (${seen.trim().slice(-2000)})`)),
      limitMs,
    );
    child[stream].setEncoding("utf8");
    child[stream].on("data", (chunk) => {
      seen += chunk;
      const match = pattern.exec(seen);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${what} ended with ${code}: ${seen.trim().slice(-2000)}`));
    });
  });
}

// A promise that fails with `what` once `ms` pass without its answer.
function within(promise, ms, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer in ${ms} ms`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// THE DEVTOOLS PROTOCOL: numbered commands with their answers, each within its limit, and events for whoever listens.
function devtools(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const listeners = new Set();
  let next = 0;
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(`${data.error.message} (${data.error.code})`));
      else resolve(data.result);
      return;
    }
    for (const listener of listeners) listener(data);
  };
  return {
    opened: within(
      new Promise((resolve, reject) => {
        socket.onopen = resolve;
        socket.onerror = () => reject(new Error("the DevTools socket did not open"));
      }),
      COMMAND_LIMIT_MS,
      "the DevTools socket",
    ),
    send(method, params = {}, sessionId, limitMs = COMMAND_LIMIT_MS) {
      next += 1;
      const id = next;
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      const answer = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      return within(answer, limitMs, method).finally(() => pending.delete(id));
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      socket.close();
    },
  };
}

// A HOST THAT SENDS NO HEADERS: the files with their types and nothing else, so only the page's meta tag can carry
// its policy.
function serveWithoutHeaders() {
  const dist = join(ROOT, "dist");
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      let path = decodeURIComponent(new URL(request.url).pathname);
      if (path.endsWith("/")) path += "index.html";
      const file = Bun.file(join(dist, path));
      if (path.split("/").includes("..") || !(await file.exists())) return new Response("not found", { status: 404 });
      return new Response(file);
    },
  });
}

// THE THREE STEPS ON ONE HOST, in a tab of its own.
async function checkPolicy(cdp, base, host) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = (method, params, limitMs) => cdp.send(method, params, sessionId, limitMs);

  // EVERY REQUEST THAT REACHES THE NETWORK for a remote host, or for the loopback node, is held here: recorded, and
  // answered as a node would answer a CORS request, so no request leaves this machine. A request the policy refuses
  // never gets this far.
  const reached = [];
  const offPaused = cdp.on((event) => {
    if (event.sessionId !== sessionId || event.method !== "Fetch.requestPaused") return;
    const { requestId, request } = event.params;
    reached.push(request.url);
    page("Fetch.fulfillRequest", {
      requestId,
      responseCode: 200,
      responseHeaders: [
        { name: "Content-Type", value: "application/json" },
        { name: "Access-Control-Allow-Origin", value: "*" },
      ],
      body: btoa("{}"),
    }).catch((e) => reached.push(`not answered: ${request.url} (${e.message})`));
  });
  await page("Fetch.enable", { patterns: [{ urlPattern: "https://*" }, { urlPattern: "http://127.0.0.1:18081/*" }] });
  await page("Page.enable");
  await page("Runtime.enable");
  // The violations are collected from the first line of the page on, as the diagnostics page collects them.
  await page("Page.addScriptToEvaluateOnNewDocument", {
    source:
      "window.__violations = [];" +
      "document.addEventListener('securitypolicyviolation', (e) => window.__violations.push({ uri: e.blockedURI, directive: e.effectiveDirective }));",
  });
  const loaded = new Promise((resolve) => {
    const off = cdp.on((event) => {
      if (event.sessionId === sessionId && event.method === "Page.loadEventFired") {
        off();
        resolve();
      }
    });
  });
  await page("Page.navigate", { url: base + "/index.html" });
  await within(loaded, COMMAND_LIMIT_MS, `${host}: the page's load`);

  // An evaluation outlasts the waits inside it, so a wait that ends says what it waited for.
  const evaluate = async (expression) => {
    const answer = await page(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      PAGE_LIMIT_MS + COMMAND_LIMIT_MS,
    );
    if (answer.exceptionDetails) {
      const detail = answer.exceptionDetails.exception?.description || answer.exceptionDetails.text;
      throw new Error(detail);
    }
    return answer.result.value;
  };

  // 1. THE PAGE STARTS UNDER ITS POLICY: the search button turns on once the wallet's bundle, the SDK and the worker
  // file loaded, and nothing the page loads is refused.
  await evaluate(`new Promise((resolve, reject) => {
    const button = document.getElementById("findSwaps");
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error("the page's wallet check did not pass: " + JSON.stringify(window.__violations)));
    }, ${PAGE_LIMIT_MS});
    const done = () => {
      if (button.disabled) return;
      observer.disconnect();
      clearTimeout(timer);
      resolve(true);
    };
    const observer = new MutationObserver(done);
    observer.observe(button, { attributes: true, attributeFilter: ["disabled"] });
    done();
  })`);
  assert.deepEqual(await evaluate("window.__violations"), [], `${host}: the policy refused something the page loads`);
  assert.deepEqual(reached, [], `${host}: the page asked a remote host while it started`);
  console.log(`ok    ${host}: the page starts under its policy, the wallet check passes and nothing is refused`);

  // 2 AND 3. THE PAGE ASKS EACH HOST, as an injected script would: a plain POST.
  const answers = await evaluate(`(async () => {
    const out = {};
    for (const url of ${JSON.stringify([...UNLISTED, ...LISTED])}) {
      try {
        out[url] = (await fetch(url, { method: "POST", body: "{}" })).status;
      } catch {
        out[url] = "refused";
      }
    }
    return out;
  })()`);
  // A violation is reported in a task of its own: wait for one per refused host, never for a time.
  const violations = await evaluate(`new Promise((resolve) => {
    const want = ${JSON.stringify(UNLISTED.map((url) => new URL(url).origin))};
    const has = () => want.every((origin) => window.__violations.some((v) => v.uri.startsWith(origin)));
    if (has()) return resolve(window.__violations);
    const timer = setTimeout(() => {
      document.removeEventListener("securitypolicyviolation", seen);
      resolve(window.__violations);
    }, ${COMMAND_LIMIT_MS});
    const seen = () => {
      if (!has()) return;
      document.removeEventListener("securitypolicyviolation", seen);
      clearTimeout(timer);
      resolve(window.__violations);
    };
    document.addEventListener("securitypolicyviolation", seen);
  })`);

  for (const url of UNLISTED) {
    const origin = new URL(url).origin;
    assert.equal(answers[url], "refused", `${host}: ${url} was answered (${answers[url]}): the policy let it through`);
    const named = violations.filter((v) => v.uri.startsWith(origin));
    assert.ok(named.length > 0, `${host}: no policy violation names ${origin}`);
    assert.ok(
      named.every((v) => v.directive === "connect-src"),
      `${host}: ${origin} was refused by ${named.map((v) => v.directive)}`,
    );
    assert.ok(!reached.some((asked) => asked.startsWith(origin)), `${host}: a request for ${origin} left the page`);
  }
  console.log(
    `ok    ${host}: the policy refuses ${UNLISTED.length} hosts the page does not list, before any request leaves`,
  );

  for (const url of LISTED) {
    const origin = new URL(url).origin;
    assert.equal(answers[url], 200, `${host}: ${url} was refused`);
    assert.ok(
      !violations.some((v) => v.uri.startsWith(origin)),
      `${host}: the policy names ${origin}, which the page lists`,
    );
    assert.ok(reached.includes(url), `${host}: ${url} did not reach the network`);
  }
  console.log(`ok    ${host}: the policy lets ${LISTED.length} listed hosts through, two nodes and a settlement RPC`);
  offPaused();
  await cdp.send("Target.closeTarget", { targetId });
}

const chrome = findChrome();
assert.ok(chrome && existsSync(chrome), "no Chrome found: set CHROME_BIN or put google-chrome or chromium on PATH");

const server = spawn(process.execPath, ["serve.bun.mjs"], {
  cwd: ROOT,
  env: { ...process.env, PORT: "0", HOST: "127.0.0.1", ROOT: "dist" },
  stdio: ["ignore", "pipe", "pipe"],
});
const bare = serveWithoutHeaders();
const profile = await mkdtemp(join(tmpdir(), "recovery-browser-"));
let browser = null;
let cdp = null;
let failed = false;
try {
  const base = await lineOf(
    server,
    "stdout",
    /serving \S+ on (http:\/\/127\.0\.0\.1:\d+)/,
    "serve.bun.mjs",
    SERVER_LIMIT_MS,
  );
  const bareBase = `http://127.0.0.1:${bare.port}`;
  // The bare host must really send no policy, or its pass would prove nothing about the meta tag.
  const bareHeaders = (await fetch(bareBase + "/index.html")).headers;
  assert.equal(bareHeaders.get("content-security-policy"), null, "the host without headers sends a CSP");
  const version = spawnSync(chrome, ["--version"], { encoding: "utf8", timeout: CHROME_LIMIT_MS });
  console.log(`      browser: ${chrome}, ${(version.stdout || version.stderr || "no version").trim()}`);
  const launched = Date.now();
  browser = spawn(
    chrome,
    [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const endpoint = await lineOf(browser, "stderr", /DevTools listening on (ws:\/\/\S+)/, "Chrome", CHROME_LIMIT_MS);
  console.log(`      browser: answered in ${((Date.now() - launched) / 1000).toFixed(1)} s`);
  cdp = devtools(endpoint);
  await cdp.opened;
  await checkPolicy(cdp, base, "with the headers");
  await checkPolicy(cdp, bareBase, "without headers, the meta tag alone");
} catch (e) {
  failed = true;
  console.log(`FAIL  the page's policy in a browser - ${(e && e.message) || e}`);
} finally {
  try {
    if (cdp) await cdp.send("Browser.close");
  } catch {
    // The browser is stopped below in any case.
  }
  cdp?.close();
  browser?.kill("SIGKILL");
  server.kill();
  bare.stop(true);
  await rm(profile, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
