// THE CRYPTO THE SDK'S RECOVERY PATH LOADS IN A BROWSER.
//
// The SDK's `restore` module builds half keys with `createHalves` and receives the primitives from a
// small browser bundle (`assets/vendors/atomic/atomic-browser.js`, relative to the SDK bundle). The
// package does not ship that file - it is a page artifact - so this repository builds it from the
// same pinned primitives the SDK uses:
//
//   ed25519 / secp256k1  - @noble/curves
//   keccak256            - the `keccak256` package, which takes a Buffer only
//   randomBytes          - the browser's own crypto.getRandomValues
//
// NOTHING IS RE-IMPLEMENTED HERE. The entry only names the primitives; the arithmetic (halves, DLEQ,
// address) stays in the SDK, which imports this bundle and passes these functions in.
import keccakPkg from "keccak256";
import { Buffer } from "buffer/";

export { Buffer };

export { ed25519 } from "@noble/curves/ed25519.js";
export { secp256k1 } from "@noble/curves/secp256k1.js";

// The package accepts a Buffer, while the SDK passes Uint8Array. Wrapping once here keeps that
// mismatch out of every caller.
const rawKeccak = keccakPkg.keccak256 || keccakPkg;
export const keccak256 = (input) => rawKeccak(Buffer.isBuffer(input) ? input : Buffer.from(input));

export const randomBytes = (n) => {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
};
