// THE BUILT PAGE, RUN WHOLE: dist/index.html, dist/recovery.js, the words and the SDK bundle it ships, with nothing of
// theirs replaced. What is the test's is what lies outside the page: the browser's document, the Monero wallet library's
// wallet, the Monero node, the settlement chain's RPC, the person's EVM wallet, and the clock.
//
// A person is simulated, not the page's functions: `press` and `type` act on an element only when a person could, that
// is when it is on the page, nothing around it is hidden and it is not disabled, and answer false otherwise.
//
// EVERY WAIT CAN BE HELD. `hold(name)` makes the next answer of that name wait until it is let go, so a check can act
// while the page waits. Nothing here sleeps or counts turns: `until` waits for a condition, and a press has an end of its
// own (`ended`, the end of everything the page did for it).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { copyFile, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIST = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist");

// --- a document, from the page's own markup --------------------------------------------------------

class Element {
  constructor(tag) {
    Object.assign(this, { tag, nodeType: 1, children: [], parent: null, attributes: {}, listeners: {}, dataset: {} });
    Object.assign(this, {
      style: {},
      value: "",
      files: [],
      className: "",
      hidden: false,
      disabled: false,
      checked: false,
    });
    Object.assign(this, { scrollTop: 0, scrollHeight: 0, text: "" });
    const names = () => this.className.split(/\s+/).filter(Boolean);
    this.classList = {
      toggle: (name, on) => {
        this.className = [...names().filter((n) => n !== name), ...(on ? [name] : [])].join(" ");
      },
      contains: (name) => names().includes(name),
    };
  }
  get id() {
    return this.attributes.id || "";
  }
  set id(value) {
    this.attributes.id = value;
  }
  get textContent() {
    return this.children.length ? this.children.map((c) => c.textContent).join("") : this.text;
  }
  set textContent(value) {
    this.replaceChildren();
    this.text = String(value);
  }
  adopt(child) {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    child.parent = this;
    return child;
  }
  appendChild(child) {
    this.children.push(this.adopt(child));
    return child;
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }
  insertBefore(child, before) {
    this.adopt(child);
    this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, child);
    return child;
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.text = "";
    this.append(...nodes);
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "class") this.className = String(value);
    if (name === "hidden") this.hidden = true;
    if (name === "disabled") this.disabled = true;
    if (name === "value") this.value = String(value);
    if (name.startsWith("data-"))
      this.dataset[name.slice(5).replace(/-(.)/g, (_, c) => c.toUpperCase())] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  addEventListener(type, handler) {
    (this.listeners[type] ||= []).push(handler);
  }
  fire(type) {
    return Promise.all((this.listeners[type] || []).map((handler) => handler({ type, target: this })));
  }
  scrollIntoView() {}
  closest(selector) {
    for (let el = this; el; el = el.parent) if (matches(el, selector)) return el;
    return null;
  }
  querySelectorAll(selector) {
    const found = [];
    const walk = (el) => {
      for (const child of el.children) {
        if (child.nodeType !== 1) continue;
        if (matches(child, selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}
// The selectors the page uses: a class, an id, a tag, or an attribute's presence.
function matches(el, selector) {
  if (selector.startsWith(".")) return el.classList.contains(selector.slice(1));
  if (selector.startsWith("#")) return el.id === selector.slice(1);
  if (selector.startsWith("[")) return selector.slice(1, -1) in el.attributes;
  return el.tag === selector;
}
const textNode = (text) => ({ nodeType: 3, textContent: text, parent: null, children: [] });

const VOID = new Set(["meta", "link", "input", "br", "img"]);
const TOKEN =
  /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-z0-9]+)\s*>|<([a-z0-9]+)((?:\s+[^\s=>/]+(?:\s*=\s*"[^"]*")?)*)\s*\/?>|([^<]+)/gi;
function parse(html) {
  const root = new Element("#document");
  let at = root;
  for (const [, close, open, attrs, text] of html.matchAll(TOKEN)) {
    if (open) {
      const el = at.appendChild(new Element(open));
      for (const [, name, value] of attrs.matchAll(/([^\s=]+)(?:\s*=\s*"([^"]*)")?/g))
        el.setAttribute(name, value ?? "");
      if (!VOID.has(open)) at = el;
    } else if (close) {
      assert.equal(at.tag, close, `the page's markup closes ${close} inside ${at.tag}`);
      at = at.parent;
    } else if (text && text.trim()) at.appendChild(textNode(text));
  }
  assert.equal(at, root, "the page's markup leaves an element open");
  return root;
}

// --- one run of the page ----------------------------------------------------------------------------

const GLOBALS = ["document", "window", "self", "navigator", "location", "sessionStorage", "localStorage", "fetch"];
const CLOCK = ["setTimeout", "clearTimeout", "setInterval", "clearInterval"];
const nextTurn = globalThis.setImmediate;

// A RUN IS ITS OWN COPY OF recovery.js, byte for byte, in one folder beside the rest of dist/: a module is loaded once
// for a path, so each copy is a page of its own while the bundles it loads are loaded once.
let folder = null;
let runs = 0;
async function newCopy() {
  if (!folder) {
    folder = await mkdtemp(join(tmpdir(), "page-run-"));
    process.on("exit", () => rmSync(folder, { recursive: true, force: true }));
    for (const name of ["lib", "locales", "assets"]) await symlink(join(DIST, name), join(folder, name));
    await writeFile(join(folder, "load.js"), "export default (url) => import(url);\n");
  }
  const copy = join(folder, `recovery-${(runs += 1)}.js`);
  await copyFile(join(DIST, "recovery.js"), copy);
  return copy;
}

/**
 * Start the page in `world` and give it to `use`; every global is put back afterwards.
 * `world` is { fetch(url, init), moneroTs, ethereum, now }: the outside, as the page meets it.
 */
export async function runPage(world, use) {
  const kept = [...GLOBALS, ...CLOCK].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const put = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const realNow = Date.now;
  const root = parse(await readFile(join(DIST, "index.html"), "utf8"));
  const listeners = {};
  const document = {
    hidden: false,
    title: "",
    documentElement: root.querySelector("html"),
    getElementById: (id) => root.querySelector("#" + id),
    createElement: (tag) => new Element(tag),
    createElementNS: (_ns, tag) => new Element(tag),
    createTextNode: textNode,
    querySelector: (selector) => root.querySelector(selector),
    querySelectorAll: (selector) => root.querySelectorAll(selector),
    addEventListener: (type, handler) => (listeners[type] ||= []).push(handler),
  };
  const store = () => {
    const kept = new Map();
    return {
      getItem: (k) => kept.get(k) ?? null,
      setItem: (k, v) => kept.set(k, v),
      removeItem: (k) => kept.delete(k),
    };
  };
  // THE CLOCK IS THE TEST'S: a timer fires when `advance` reaches it, never by itself.
  let now = world.now;
  let timers = [];
  const later = (run, ms = 0, ...args) => {
    const timer = { at: now + ms, run: () => run(...args) };
    timers.push(timer);
    return timer;
  };
  const drop = (timer) => (timers = timers.filter((other) => other !== timer));
  const location = { search: "", origin: "https://page.example", href: "https://page.example/" };
  const window = { ethereum: world.ethereum, document, location };
  const turn = () => new Promise((resolve) => nextTurn(resolve));

  const page = {
    root,
    window,
    el(id) {
      const el = root.querySelector("#" + id);
      assert.ok(el, `the page has no #${id}`);
      return el;
    },
    // ON THE PAGE AND SHOWN: attached, with nothing hidden around it.
    shown(target) {
      let el = typeof target === "string" ? page.el(target) : target;
      for (; el; el = el.parent) {
        if (el.hidden) return false;
        if (el === root) return true;
      }
      return false;
    },
    text: (target) => {
      const el = typeof target === "string" ? page.el(target) : target;
      return page.shown(el) ? el.textContent : "";
    },
    can(target) {
      const el = typeof target === "string" ? page.el(target) : target;
      return page.shown(el) && !el.disabled;
    },
    // WHAT A PERSON DOES is not awaited: what it starts may wait. Each answers false when no person could have done it,
    // and otherwise the act, whose `ended` is the end of every step the page ran for it.
    act(el, event) {
      const act = { ended: el.fire(event).catch((e) => page.failures.push(e)) };
      return act;
    },
    press(target) {
      const el = typeof target === "string" ? page.el(target) : target;
      return page.can(el) && page.act(el, "click");
    },
    type(target, value) {
      const el = typeof target === "string" ? page.el(target) : target;
      if (!page.can(el)) return false;
      el.value = value;
      return page.act(el, "input");
    },
    choose(target, file) {
      const el = page.el(target);
      if (!page.can(el)) return false;
      el.files = file ? [file] : [];
      return page.act(el, "change");
    },
    // Pick a node of the list, as a person does: one radio of the group is checked and says so.
    node(url) {
      const radios = page.el("nodeList").querySelectorAll("input");
      const radio = radios.find((one) => one.value === url);
      assert.ok(radio, `the list has no ${url}`);
      if (page.el("nodeList").disabled) return false;
      for (const one of radios) one.checked = one === radio;
      return page.act(radio, "change");
    },
    // What the list shows as chosen: the radio and the line above it.
    nodeShown: () => ({
      radio: page
        .el("nodeList")
        .querySelectorAll("input")
        .filter((one) => one.checked)
        .map((one) => one.value)
        .join(),
      line: page.el("nodeCurrent").textContent,
    }),
    row(amount) {
      const found = page.el("swapList").children.filter((li) => li.textContent.includes(amount));
      assert.equal(found.length, 1, `${found.length} rows show ${amount}`);
      return found[0];
    },
    open: (amount) => page.press(page.row(amount).querySelector("button")),
    log: () => page.el("log").textContent,
    failures: [],
    // Wait for a condition. The bound only ends a check that can never pass.
    async until(condition, what) {
      for (let i = 0; i < 20_000; i += 1) {
        if (condition()) return;
        await turn();
      }
      assert.fail(`the page never reached: ${what}\n${page.log()}`);
    },
    // Time passes: each timer due by then fires in its order, and what it asks of the outside is answered before the next.
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        drop(due);
        now = Math.max(now, due.at);
        due.run();
        await world.quiet();
      }
      now = end;
    },
  };

  try {
    put("document", document);
    put("window", window);
    put("self", { isSecureContext: true });
    put("navigator", {});
    put("location", location);
    put("sessionStorage", store());
    put("localStorage", store());
    put("fetch", (url, init) => world.fetch(String(url), init));
    put("setTimeout", later);
    put("clearTimeout", drop);
    put("setInterval", () => 0);
    put("clearInterval", () => {});
    Date.now = () => now;
    const copy = await newCopy();
    // THE WALLET LIBRARY IS THE BUNDLE THE BUILD SHIPS, at the URL the build gives it (its path and the start of its hash);
    // only the wallet it makes is the test's.
    const { files } = JSON.parse(await readFile(join(DIST, "build.json"), "utf8"));
    const { file, sha256 } = files.find((one) => one.file.endsWith("/monero-ts-browser.js"));
    const monero = await (await import(join(folder, "load.js"))).default(`./${file}?v=${sha256.slice(0, 8)}`);
    monero.default.createWalletFull = (config) => world.createWallet(config);
    await import(pathToFileURL(copy).href);
    await page.until(() => page.can("findSwaps"), "a page that can search");
    const result = await use(page);
    assert.deepEqual(page.failures, [], "a handler of the page threw");
    return result;
  } finally {
    // What the page still does ends while its document is there; a held answer stays held.
    await world.quiet();
    Date.now = realNow;
    for (const [name, descriptor] of kept) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

/**
 * THE OUTSIDE'S ANSWERS. Each call goes through `call`, and can be held by its name: `hold` takes the next answer of that
 * name and returns { reached, release }. `quiet` is the moment nothing but held answers is outstanding and the page has
 * asked for nothing more.
 */
export function gates() {
  const held = new Map();
  let running = 0;
  let asked = 0;
  return {
    async call(name, answer) {
      running += 1;
      asked += 1;
      try {
        const gate = held.get(name);
        if (gate) {
          held.delete(name);
          gate.arrived = true;
          running -= 1;
          await gate.wait;
          running += 1;
          if (gate.error) throw gate.error;
        }
        return await answer();
      } finally {
        running -= 1;
      }
    },
    hold(name) {
      let open;
      const gate = { arrived: false, error: null, wait: new Promise((resolve) => (open = resolve)) };
      held.set(name, gate);
      return {
        reached: () => gate.arrived,
        release: (error = null) => {
          gate.error = error;
          open();
        },
      };
    },
    // A turn of the event loop runs every step that can run: one in which the page asked nothing, with nothing
    // outstanding, is its end.
    async quiet() {
      for (;;) {
        const before = asked;
        await new Promise((resolve) => nextTurn(resolve));
        if (running === 0 && asked === before) return;
      }
    },
  };
}

/**
 * WHETHER A SECRET IS STILL HELD by anything in this process: a 32-byte value in hex, named by its digest so that the one
 * who looks does not hold it.
 */
export function inMemory(digest) {
  Bun.gc(true);
  const seen = new Set(Bun.generateHeapSnapshot("v8").match(/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/g));
  return [...seen].some((text) => createHash("sha256").update(text).digest("hex") === digest);
}
