// CORE ENTRY FOR THE WITHDRAWAL PAGE: WHAT THE PAGE TAKES FROM @ninsei-labs/sdk.
//
// WHY A SEPARATE FILE. The browser cannot resolve a bare package specifier, so the page gets ONE BUILT module
// (assets/vendors/sdk/sdk-browser.js) from tools/build-sweep-sdk.mjs: the INSTALLED PACKAGE is the source of truth.
//
// NAMES ARE PACKAGE ENTRY SPECIFIERS (its exports map), never paths inside it: not promised, and they break on
// any file move (tools/check-sweep-sdk-only.mjs guards this). NOT HERE: nothing copied into sweep/lib, and the
// "code -> words" dictionary stays with the page ON PURPOSE: the package holds no human texts.
export { createNinsei, ERROR_META } from "@ninsei-labs/sdk";
// XMR AMOUNTS: twelve decimals and BigInt. No arithmetic of its own, only formatXmr/parseXmr.
export { formatXmr, parseXmr } from "@ninsei-labs/sdk/core";
// NODE AND ARRIVAL FACTS: preflight, address policy, address parsing, unlock_time. No own get_info and no
// letter-by-letter network guess: the package answers and names the reason when it refuses.
export {
  probeMoneroNode,
  moneroFeeEstimate,
  feeForBytes,
  networkFromNode,
  judgeDaemonAddress,
  decodeAddressKeys,
  unlockStateOf,
} from "@ninsei-labs/sdk/xmr";
// RECOVERY FILE AS IT IS ON THE PATH: envelope and payload shape, for display and for OLD mnemonic files.
export { decryptFile, validatePayload } from "@ninsei-labs/sdk/recovery";
// CORE WALLET AND WITHDRAWAL WALLET, with in-memory storage. moneroWalletAdapter plays the core wallet
// (vm/connect/address/chainId/unlockedBalance/driver), moneroWallet the withdrawal one
// (open/sync/sweepUnlocked/relay/close). No WASM: createWallet comes from the page, so no monero-ts byte here.
export { moneroWallet, moneroWalletAdapter, memoryAdapter } from "@ninsei-labs/sdk/adapters";
