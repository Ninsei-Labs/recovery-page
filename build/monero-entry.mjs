// THE BROWSER ENTRY OF monero-ts: exactly what the page needs, and nothing else named by hand.
//
// The page takes the wallet, its network enum and the keys-only constructors from this bundle. The
// `export *` keeps the rest of the library reachable (the wallet uses it internally); it is one
// module either way, so naming a subset would only hide what the page may call.
export { default, MoneroNetworkType, createWalletKeys, createWalletFull, getVersion, MoneroWalletKeys } from "monero-ts";
export * from "monero-ts";
