// SHIMS THE BUNDLE GETS INJECTED (esbuild `inject`): monero-ts is written for Node and reaches for
// `global`, `Buffer` and `process` directly. The browser has none of them under those names.
import { Buffer as NodeBuffer } from "buffer";
import NodeProcess from "process/browser.js";

export const Buffer = NodeBuffer;
export const process = NodeProcess;
export const global = globalThis;

if (typeof globalThis.process === "undefined") globalThis.process = NodeProcess;
if (typeof globalThis.Buffer === "undefined") globalThis.Buffer = NodeBuffer;
