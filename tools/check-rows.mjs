// Execute the page's row rules from lib/rows.js and render a row through the page's DOM. Only locale startup and
// the DOM are substitutes; deadline conversion, swapState and the recipient rules are the production modules.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { msFromOrderSeconds } from "@ninsei-labs/sdk/core";
import { deadlineOf, ethRecipient, newOrders, orderId, readyByOf, sideOf, swapStateOf } from "../lib/rows.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// The row renderer needs a small DOM surface, not a second model of row decisions.
function element(tag = "div") {
  return {
    tag,
    children: [],
    attributes: {},
    style: {},
    dataset: {},
    value: "",
    textContent: "",
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    append(...children) {
      this.children.push(...children);
    },
    insertBefore(child) {
      this.children.push(child);
    },
    after() {},
    addEventListener() {},
    querySelector() {
      return element();
    },
  };
}

export async function checkRows() {
  const source = await readFile(new URL("../recovery.js", import.meta.url), "utf8");
  const built = await build({
    stdin: {
      // Appended exports expose existing bindings only in this in-memory test bundle.
      contents: source + "\nmod = globalThis.rowSdk;\nexport { swapRow, formatCoin };\n",
      resolveDir: ROOT,
      sourcefile: "recovery.js",
    },
    bundle: true,
    write: false,
    format: "iife",
    globalName: "rowPage",
    plugins: [
      {
        name: "row-locale",
        setup(b) {
          b.onResolve({ filter: /locales\/index\.js$/ }, () => ({ path: "locale", namespace: "row-test" }));
          b.onLoad({ filter: /.*/, namespace: "row-test" }, () => ({
            // Startup waits for language loading; leave that promise pending so it cannot fetch wallets or nodes.
            contents:
              "export const t = (key, params) => key + (params && params.amount !== undefined ? ':' + params.amount : ''), n = String, d = String, init = () => new Promise(() => {});",
          }));
        },
      },
    ],
  });
  assert.equal(built.outputFiles.length, 1, "one executable page bundle");
  let now = 1_700_000_099_000;
  const context = {
    rowSdk: { msFromOrderSeconds },
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    window: {},
    navigator: {},
    document: { getElementById: () => element(), createElement: element, addEventListener() {} },
  };
  runInNewContext(built.outputFiles[0].text, context);
  const page = context.rowPage;
  const open = { isFunded: true, isClaimed: false, isRefunded: false, isReady: false };
  // Synthetic SDK found-order examples. Seconds -> milliseconds is worked here by hand.
  const swap = { readyBy: 1_700_000_100, t1: 1_700_000_400, amount: "1000000000000000000" };
  const deadline = 1_700_000_400_000;
  const net = { name: "Example test network", native: { decimals: 18, symbol: "ETH" } };
  const boundaries = [
    [1_700_000_099_000, "later", "later", "claim"], // readyBy - 1 second
    [1_700_000_100_000, "later", "claim", "claim"], // readyBy
    [1_700_000_101_000, "later", "claim", "claim"], // readyBy + 1 second
    [1_700_000_399_000, "later", "claim", "claim"], // t1 - 1 second
    [1_700_000_400_000, "refund", "none", "none"], // t1
    [1_700_000_401_000, "refund", "none", "none"], // t1 + 1 second
  ];
  let rows = 0;
  const descendants = (node) => [node, ...node.children.flatMap(descendants)];
  function checkRow(row, expectedState, expectedAction) {
    const result = swapStateOf(row, { now, msFromOrderSeconds });
    assert.equal(result.state, expectedState);
    assert.equal(result.action, expectedAction);
    const rendered = page.swapRow(row);
    assert.equal(rendered.attributes["data-action"], expectedAction, "rendered action follows row state");
    const buttons = descendants(rendered).filter((node) => node.tag === "button");
    const actionable = ["withdraw", "refund", "claim"].includes(expectedAction);
    assert.equal(buttons.length, actionable ? 1 : 0, "only actionable rows offer a button");
    if (actionable) assert.equal(buttons[0].textContent, "swap.action." + expectedAction);
    rows++;
    return result;
  }
  for (const [foundSide, side] of [
    ["locker", "buy"],
    ["claimer", "sell"],
  ]) {
    assert.equal(sideOf({ side: foundSide }), side, "the found side selects the person's money path");
    const row = { swap: { ...swap, side: foundSide }, side: sideOf({ side: foundSide }), status: open, net };
    assert.equal(deadlineOf(row.swap, msFromOrderSeconds), deadline, "t1 is the settlement deadline, in milliseconds");
    assert.equal(readyByOf(row.swap, msFromOrderSeconds), 1_700_000_100_000, "readyBy has its own boundary");
    for (const [time, buyAction, sellAction, readySellAction] of boundaries) {
      now = time;
      for (const ready of [false, true]) {
        row.status = { ...open, isReady: ready };
        const action = side === "buy" ? buyAction : ready ? readySellAction : sellAction;
        const result = checkRow(row, side + (time >= deadline ? ".late" : ".open"), action);
        if (time < deadline || side === "buy") assert.equal(result.params.deadline, deadline);
      }
    }
    for (const [status, state, buyAction, sellAction] of [
      [{ isClaimed: true }, ".claimed", "withdraw", "none"],
      [{ isRefunded: true }, ".refunded", "none", "withdraw"],
      [{ isRefunded: true, isDeclined: true }, side === "buy" ? ".refunded" : ".declined", "none", "none"],
    ]) {
      row.status = { ...open, ...status };
      checkRow(row, side + state, side === "buy" ? buyAction : sellAction);
    }
    row.status = null;
    checkRow(row, "unknown", "unknown");
  }
  for (const found of [null, {}, { side: "provider" }]) assert.equal(sideOf(found), null);
  const hugeAmount = page.formatCoin({ native: { decimals: 18, symbol: "ETH" } }, "123456789012345678901234567890");
  assert.ok(hugeAmount.includes("123456789012.345678"), "a large amount must not be rounded through Number");
  for (const value of [undefined, null, "", -1, NaN, Infinity, 1_700_000_400_000]) {
    assert.equal(deadlineOf({ ...swap, t1: value }, msFromOrderSeconds), null, "missing or invalid t1 stays unknown");
    const row = { swap: { ...swap, t1: value }, side: "buy", status: open, net };
    checkRow(row, "unknown", "unknown");
  }
  const locker = "0x" + "11".repeat(20),
    claimer = "0x" + "22".repeat(20),
    fallback = "0x" + "33".repeat(20);
  for (const [material, recipient] of [
    [{ kind: "refund", expect: { locker, claimer }, claimer: fallback }, locker],
    [{ kind: "claim", expect: { locker, claimer }, claimer: fallback }, fallback],
    [{ kind: "claim", expect: { locker, claimer } }, claimer],
    [{ kind: "refund", expect: {} }, ""],
    [{ kind: "claim", expect: {} }, ""],
  ])
    assert.equal(ethRecipient({}, material), recipient, "settlement names the signed recipient");
  // ONE ORDER IS ITS NETWORK AND ITS ESCROW: two networks with an order at the same address give two rows, one network
  // gives it once, in whatever case its address is written, and a repeated search adds nothing.
  const [one, two] = [{ id: "chain-one" }, { id: "chain-two" }];
  const at = (address) => ({ escrow: address });
  const listed = [{ net: one, swap: at("0x" + "AB".repeat(20)) }];
  const same = at("0x" + "ab".repeat(20));
  assert.notEqual(orderId(one, same.escrow), orderId(two, same.escrow));
  for (const [rows, net, swaps, expected] of [
    [listed, one, [same], []],
    [listed, two, [same], [same]],
    [listed, two, [same, at("0x" + "AB".repeat(20))], [same]],
    [[], one, [same, at("0x" + "cd".repeat(20))], [same, at("0x" + "cd".repeat(20))]],
  ])
    assert.deepEqual(newOrders(rows, net, swaps), expected);
  assert.equal(rows, 39, "all boundary, terminal and unknown rows ran");
  return `${rows} row states and rendered actions, named recipients, real SDK deadline conversion`;
}

if (import.meta.main) console.log("ok    " + (await checkRows()));
