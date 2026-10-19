// THE REFUSAL CODE DICTIONARY THIS PAGE USES: core code -> one short phrase for a person. The page is a
// static artefact, so the table lives here; build/build.mjs copies this file into dist/ as it is.
//
// WHY IT EXISTS. The core names a refusal by CODE, not by text: `message` equals the code on purpose, because
// the interface owns the wording, the translation and the tone, not the engine. Without this dictionary the
// screen showed the person the code itself ("insufficient-funds"), handing an internal name to them. This is
// the ONLY place where a code becomes words.
//
// WHY EVERY LANGUAGE IS HERE. The table keeps the phrase in each language and the caller picks one:
// sdkErrorText(error, "en"). One table, so the languages cannot drift apart.
//
// THE MAIN RULE: AN UNKNOWN CODE IS NOT SWALLOWED. A code absent from the table is returned AS IT IS, not as
// "unknown error": otherwise tomorrow's refusal would look like today's and nobody would find it.
//
// PARAMETERS (`SdkError.params`) COMPLETE THE PHRASE: what was missing, at which step, which status. Values are
// inserted as they are: they are field names and core step codes, and translating them would hide what is
// named.

// One short phrase per code. Keys are exactly the SDK's ERROR_CODES.
export const SDK_ERROR_WORDS = {
  "not-implemented": {
    en: "This step is not available yet",
    ru: "\u042d\u0442\u043e\u0442 \u0448\u0430\u0433 \u043f\u043e\u043a\u0430 \u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u0435\u043d",
  },
  "bad-input": {
    en: "The data for this step is incomplete or not valid",
    ru: "\u0414\u0430\u043d\u043d\u044b\u0435 \u0434\u043b\u044f \u044d\u0442\u043e\u0433\u043e \u0448\u0430\u0433\u0430 \u043d\u0435\u043f\u043e\u043b\u043d\u044b \u0438\u043b\u0438 \u043d\u0435\u0432\u0435\u0440\u043d\u044b",
  },
  "wallet-not-connected": {
    en: "Wallet is not connected",
    ru: "\u041a\u043e\u0448\u0435\u043b\u0451\u043a \u043d\u0435 \u043f\u043e\u0434\u043a\u043b\u044e\u0447\u0451\u043d",
  },
  "wallet-rejected": {
    en: "The wallet declined the request",
    ru: "\u041a\u043e\u0448\u0435\u043b\u0451\u043a \u043e\u0442\u043a\u043b\u043e\u043d\u0438\u043b \u0437\u0430\u043f\u0440\u043e\u0441",
  },
  "wrong-chain": {
    en: "The wallet is on a different network",
    ru: "\u041a\u043e\u0448\u0435\u043b\u0451\u043a \u043d\u0430\u0445\u043e\u0434\u0438\u0442\u0441\u044f \u0432 \u0434\u0440\u0443\u0433\u043e\u0439 \u0441\u0435\u0442\u0438",
  },
  "quote-unavailable": {
    en: "No quote is available right now",
    ru: "\u041a\u043e\u0442\u0438\u0440\u043e\u0432\u043a\u0430 \u0441\u0435\u0439\u0447\u0430\u0441 \u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u043d\u0430",
  },
  "quote-refused": {
    en: "The provider refused the quote",
    ru: "\u041f\u0440\u043e\u0432\u0430\u0439\u0434\u0435\u0440 \u043e\u0442\u043a\u0430\u0437\u0430\u043b \u0432 \u043a\u043e\u0442\u0438\u0440\u043e\u0432\u043a\u0435",
  },
  // ADDRESS DENIED: the address is on the interface's list OR the node refused it by its own list
  // (`denied-address`). THE PHRASE IS DELIBERATELY NEUTRAL: it names neither the address nor whose list it is -
  // the node names them, and the person is shown only what they can do (use another address).
  "address-denied": {
    en: "This address cannot be used for the swap",
    ru: "\u042d\u0442\u043e\u0442 \u0430\u0434\u0440\u0435\u0441 \u043d\u0435\u043b\u044c\u0437\u044f \u0438\u0441\u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u044c \u0434\u043b\u044f \u043e\u0431\u043c\u0435\u043d\u0430",
  },
  "quote-stale": {
    en: "The quote is out of date",
    ru: "\u041a\u043e\u0442\u0438\u0440\u043e\u0432\u043a\u0430 \u0443\u0441\u0442\u0430\u0440\u0435\u043b\u0430",
  },
  // THE QUOTE'S SIGNATURE ON AN ORDER (EIP-712). Four different refusals: each has its own cause and its own
  // advice, and merging them into one would hide from the person what they can do.
  "quote-signature-invalid": {
    en: "The quote signature does not check out",
    ru: "\u041f\u043e\u0434\u043f\u0438\u0441\u044c \u043a\u043e\u0442\u0438\u0440\u043e\u0432\u043a\u0438 \u043d\u0435 \u0441\u0445\u043e\u0434\u0438\u0442\u0441\u044f",
  },
  "quote-key-mismatch": {
    en: "The quote was signed by a different key than the one it names",
    ru: "\u041a\u043e\u0442\u0438\u0440\u043e\u0432\u043a\u0443 \u043f\u043e\u0434\u043f\u0438\u0441\u0430\u043b \u043d\u0435 \u0442\u043e\u0442 \u043a\u043b\u044e\u0447, \u043a\u043e\u0442\u043e\u0440\u044b\u0439 \u0432 \u043d\u0435\u0439 \u043d\u0430\u0437\u0432\u0430\u043d",
  },
  "quote-field-unbound": {
    en: "A field of the quote is not covered by its signature",
    ru: "\u041f\u043e\u043b\u0435 \u043a\u043e\u0442\u0438\u0440\u043e\u0432\u043a\u0438 \u043d\u0435 \u0441\u0432\u044f\u0437\u0430\u043d\u043e \u0435\u0451 \u043f\u043e\u0434\u043f\u0438\u0441\u044c\u044e",
  },
  "quote-expired": {
    en: "The quote has expired",
    ru: "\u0421\u0440\u043e\u043a \u043a\u043e\u0442\u0438\u0440\u043e\u0432\u043a\u0438 \u0438\u0441\u0442\u0451\u043a",
  },
  // WHO OWNS THE KEY (maker registry, providerOf, taken from the quote). The chain is asked, not the flag:
  // a signature alone proves only that SOME key signed.
  "quote-registry-unchecked": {
    en: "The key's owner could not be checked on chain (no registry read)",
    ru: "\u0412\u043b\u0430\u0434\u0435\u043b\u044c\u0446\u0430 \u043a\u043b\u044e\u0447\u0430 \u043d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u043f\u0440\u043e\u0432\u0435\u0440\u0438\u0442\u044c \u0432 \u0446\u0435\u043f\u0438 (\u043d\u0435\u0442 \u0447\u0442\u0435\u043d\u0438\u044f \u0440\u0435\u0435\u0441\u0442\u0440\u0430)",
  },
  "quote-key-unknown": {
    en: "The registry does not know this quote key: nobody owns it",
    ru: "\u0420\u0435\u0435\u0441\u0442\u0440 \u043d\u0435 \u0437\u043d\u0430\u0435\u0442 \u044d\u0442\u043e\u0442 \u043a\u043b\u044e\u0447 \u043a\u043e\u0442\u0438\u0440\u043e\u0432\u043a\u0438: \u0438\u043c \u043d\u0438\u043a\u0442\u043e \u043d\u0435 \u0432\u043b\u0430\u0434\u0435\u0435\u0442",
  },
  "quote-provider-mismatch": {
    en: "The registry maps this key to a different provider than the quote names",
    ru: "\u0420\u0435\u0435\u0441\u0442\u0440 \u043e\u0442\u043d\u043e\u0441\u0438\u0442 \u044d\u0442\u043e\u0442 \u043a\u043b\u044e\u0447 \u043a \u0434\u0440\u0443\u0433\u043e\u043c\u0443 \u043f\u0440\u043e\u0432\u0430\u0439\u0434\u0435\u0440\u0443, \u0430 \u043d\u0435 \u043a \u043d\u0430\u0437\u0432\u0430\u043d\u043d\u043e\u043c\u0443 \u0432 \u043a\u043e\u0442\u0438\u0440\u043e\u0432\u043a\u0435",
  },
  "quote-provider-not-allowed": {
    en: "This interface does not admit this provider",
    ru: "\u042d\u0442\u043e\u0442 \u0438\u043d\u0442\u0435\u0440\u0444\u0435\u0439\u0441 \u043d\u0435 \u0434\u043e\u043f\u0443\u0441\u043a\u0430\u0435\u0442 \u044d\u0442\u043e\u0433\u043e \u043f\u0440\u043e\u0432\u0430\u0439\u0434\u0435\u0440\u0430",
  },
  // THE FACTORY AND ITS CODE. The factory comes from the provider's registry record, and its code is
  // matched against the interface's known builds - four different refusals, each with its own advice.
  "quote-factory-unchecked": {
    en: "The factory could not be checked (no registry read or no code read)",
    ru: "\u0424\u0430\u0431\u0440\u0438\u043a\u0443 \u043d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u043f\u0440\u043e\u0432\u0435\u0440\u0438\u0442\u044c (\u043d\u0435\u0442 \u0447\u0442\u0435\u043d\u0438\u044f \u0440\u0435\u0435\u0441\u0442\u0440\u0430 \u0438\u043b\u0438 \u043a\u043e\u0434\u0430)",
  },
  "quote-factory-unknown": {
    en: "The provider's registry record names no factory",
    ru: "\u0417\u0430\u043f\u0438\u0441\u044c \u043f\u0440\u043e\u0432\u0430\u0439\u0434\u0435\u0440\u0430 \u0432 \u0440\u0435\u0435\u0441\u0442\u0440\u0435 \u043d\u0435 \u043d\u0430\u0437\u044b\u0432\u0430\u0435\u0442 \u0444\u0430\u0431\u0440\u0438\u043a\u0443",
  },
  "quote-factory-mismatch": {
    en: "The quote names a different factory than the provider's record",
    ru: "\u041a\u043e\u0442\u0438\u0440\u043e\u0432\u043a\u0430 \u043d\u0430\u0437\u044b\u0432\u0430\u0435\u0442 \u043d\u0435 \u0442\u0443 \u0444\u0430\u0431\u0440\u0438\u043a\u0443, \u0447\u0442\u043e \u0437\u0430\u043f\u0438\u0441\u044c \u043f\u0440\u043e\u0432\u0430\u0439\u0434\u0435\u0440\u0430",
  },
  "quote-factory-code-unknown": {
    en: "The factory's code is not a build this interface knows",
    ru: "\u041a\u043e\u0434 \u0444\u0430\u0431\u0440\u0438\u043a\u0438 \u043d\u0435 \u0438\u0437 \u0438\u0437\u0432\u0435\u0441\u0442\u043d\u044b\u0445 \u044d\u0442\u043e\u043c\u0443 \u0438\u043d\u0442\u0435\u0440\u0444\u0435\u0439\u0441\u0443 \u0441\u0431\u043e\u0440\u043e\u043a",
  },
  "recovery-declined": {
    en: "The recovery file was not confirmed",
    ru: "\u0424\u0430\u0439\u043b \u0432\u043e\u0441\u0441\u0442\u0430\u043d\u043e\u0432\u043b\u0435\u043d\u0438\u044f \u043d\u0435 \u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0451\u043d",
  },
  "recovery-failed": {
    en: "The recovery file could not be read",
    ru: "\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u043f\u0440\u043e\u0447\u0438\u0442\u0430\u0442\u044c \u0444\u0430\u0439\u043b \u0432\u043e\u0441\u0441\u0442\u0430\u043d\u043e\u0432\u043b\u0435\u043d\u0438\u044f",
  },
  "storage-unavailable": {
    en: "Local storage is unavailable",
    ru: "\u041b\u043e\u043a\u0430\u043b\u044c\u043d\u043e\u0435 \u0445\u0440\u0430\u043d\u0438\u043b\u0438\u0449\u0435 \u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u043d\u043e",
  },
  "server-unavailable": {
    en: "The service did not answer",
    ru: "\u0421\u0435\u0440\u0432\u0438\u0441 \u043d\u0435 \u043e\u0442\u0432\u0435\u0442\u0438\u043b",
  },
  "server-refused": {
    en: "The service refused the request",
    ru: "\u0421\u0435\u0440\u0432\u0438\u0441 \u043e\u0442\u043a\u043b\u043e\u043d\u0438\u043b \u0437\u0430\u043f\u0440\u043e\u0441",
  },
  "xmr-timeout": {
    en: "XMR did not arrive in time",
    ru: "XMR \u043d\u0435 \u043f\u0440\u0438\u0448\u043b\u0438 \u0432\u043e\u0432\u0440\u0435\u043c\u044f",
  },
  // MONEY LOCKED BY unlock_time: the money is on the address but cannot be spent before the boundary. The
  // phrase says WHAT happened; the boundary (a height or a date) arrives as the `until` detail.
  "xmr-locked": {
    en: "XMR is on the address but locked on-chain until the sender's unlock time",
    ru: "XMR \u043d\u0430 \u0430\u0434\u0440\u0435\u0441\u0435, \u043d\u043e \u0437\u0430\u043f\u0435\u0440\u0442\u044b \u0432 \u0446\u0435\u043f\u0438 \u0434\u043e \u0432\u0440\u0435\u043c\u0435\u043d\u0438 \u0440\u0430\u0437\u0431\u043b\u043e\u043a\u0438\u0440\u043e\u0432\u043a\u0438, \u043d\u0430\u0437\u043d\u0430\u0447\u0435\u043d\u043d\u043e\u0433\u043e \u043e\u0442\u043f\u0440\u0430\u0432\u0438\u0442\u0435\u043b\u0435\u043c",
  },
  // A PAYMENT CHECKED BY TWO NODES. The client decides, and one node is one truth that can lie. Each code
  // names its own reason why the button stays closed.
  "xmr-nodes-disagree": {
    en: "The XMR nodes do not agree about this payment",
    ru: "\u041d\u043e\u0434\u044b XMR \u043d\u0435 \u0441\u0445\u043e\u0434\u044f\u0442\u0441\u044f \u0432 \u044d\u0442\u043e\u043c \u043f\u0435\u0440\u0435\u0432\u043e\u0434\u0435",
  },
  "xmr-no-nodes": {
    en: "No Monero node could be reached to confirm the payment",
    ru: "\u041d\u0438 \u043e\u0434\u043d\u0430 \u043d\u043e\u0434\u0430 Monero \u043d\u0435 \u043e\u0442\u0432\u0435\u0442\u0438\u043b\u0430 \u0434\u043b\u044f \u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0438 \u043f\u0435\u0440\u0435\u0432\u043e\u0434\u0430",
  },
  "xmr-underpaid": {
    en: "Less XMR arrived than the swap expected",
    ru: "XMR \u043f\u0440\u0438\u0448\u043b\u043e \u043c\u0435\u043d\u044c\u0448\u0435, \u0447\u0435\u043c \u043e\u0436\u0438\u0434\u0430\u043b\u043e\u0441\u044c \u043f\u043e \u0441\u0434\u0435\u043b\u043a\u0435",
  },
  "xmr-too-late": {
    en: "Too little time is left before the deadline for the confirmations",
    ru: "\u0414\u043e \u0441\u0440\u043e\u043a\u0430 \u043e\u0441\u0442\u0430\u043b\u043e\u0441\u044c \u043c\u0435\u043d\u044c\u0448\u0435 \u0432\u0440\u0435\u043c\u0435\u043d\u0438, \u0447\u0435\u043c \u043d\u0443\u0436\u043d\u043e \u043d\u0430 \u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043d\u0438\u044f",
  },
  "contract-reverted": {
    en: "The contract rejected the transaction",
    ru: "\u041a\u043e\u043d\u0442\u0440\u0430\u043a\u0442 \u043e\u0442\u043a\u043b\u043e\u043d\u0438\u043b \u0442\u0440\u0430\u043d\u0437\u0430\u043a\u0446\u0438\u044e",
  },
  "insufficient-funds": {
    en: "Not enough funds to withdraw",
    ru: "\u041d\u0435\u0434\u043e\u0441\u0442\u0430\u0442\u043e\u0447\u043d\u043e \u0441\u0440\u0435\u0434\u0441\u0442\u0432 \u0434\u043b\u044f \u0432\u044b\u0432\u043e\u0434\u0430",
  },
  // CLAIM GAS: the person sells XMR and receives ETH, but has no ETH of their own for the claim call. Three
  // states that must not be merged: the maker refuses the gas (visible BEFORE the deal), the gas has not
  // arrived, and the gas is too little.
  "gas-refused-by-maker": {
    en: "The maker will not pay the claim gas",
    ru: "\u041c\u0435\u0439\u043a\u0435\u0440 \u043d\u0435 \u043e\u043f\u043b\u0430\u0442\u0438\u0442 \u0433\u0430\u0437 \u0437\u0430\u0431\u043e\u0440\u0430",
  },
  "gas-not-arrived": {
    en: "The claim gas has not arrived",
    ru: "\u0413\u0430\u0437 \u043d\u0430 \u0437\u0430\u0431\u043e\u0440 \u043d\u0435 \u043f\u0440\u0438\u0448\u0451\u043b",
  },
  "gas-too-little": {
    en: "The claim gas arrived, but it is not enough",
    ru: "\u0413\u0430\u0437 \u043f\u0440\u0438\u0448\u0451\u043b, \u043d\u043e \u0435\u0433\u043e \u043c\u0435\u043d\u044c\u0448\u0435 \u043d\u0443\u0436\u043d\u043e\u0433\u043e",
  },
  unknown: {
    en: "The refusal did not name its reason",
    ru: "\u041e\u0442\u043a\u0430\u0437 \u043d\u0435 \u043d\u0430\u0437\u0432\u0430\u043b \u0441\u0432\u043e\u044e \u043f\u0440\u0438\u0447\u0438\u043d\u0443",
  },
};

// DEAL STATES IN WORDS, BY CODE - the same approach as core refusals. The package returns CODES: the
// terminal `declined` (the maker's refusal) and the `xmr_reclaimed` phase (the maker took the XMR back).
//
// WHY A SEPARATE TABLE AND NOT SDK_ERROR_WORDS. The first table's keys are core error codes, and a maker's
// refusal or a reclaim phase is a deal state, not a core refusal. Same technique (code -> words), honestly
// different tables.
//
// THE MAKER'S REFUSAL HAS NO CAUSE, NO CATEGORY AND NO PROVIDER - and that is a RULE, not an omission: the
// node returns exactly one field, `compliance`, and nothing else. So the phrase is neutral and names nobody.
// There is nothing to return on a refusal: the ETH and the fee are already back.
export const SDK_STATE_WORDS = {
  declined: {
    en: "The maker declined this swap. Nothing was taken - your funds, the fee included, are already back in your wallet.",
    ru: "\u041c\u0435\u0439\u043a\u0435\u0440 \u043e\u0442\u043a\u0430\u0437\u0430\u043b\u0441\u044f \u043e\u0442 \u0441\u0434\u0435\u043b\u043a\u0438. \u041d\u0438\u0447\u0435\u0433\u043e \u043d\u0435 \u0443\u0434\u0435\u0440\u0436\u0430\u043d\u043e - \u0432\u0430\u0448\u0438 \u0441\u0440\u0435\u0434\u0441\u0442\u0432\u0430, \u0432\u043a\u043b\u044e\u0447\u0430\u044f \u043a\u043e\u043c\u0438\u0441\u0441\u0438\u044e, \u0443\u0436\u0435 \u0432\u0435\u0440\u043d\u0443\u043b\u0438\u0441\u044c \u0432 \u0432\u0430\u0448 \u043a\u043e\u0448\u0435\u043b\u0451\u043a.",
  },
  xmr_reclaimed: {
    en: "The maker took the XMR back after the ready() deadline. Your ETH is still in the escrow and you can take it back.",
    ru: "\u041c\u0435\u0439\u043a\u0435\u0440 \u0437\u0430\u0431\u0440\u0430\u043b XMR \u043e\u0431\u0440\u0430\u0442\u043d\u043e \u043f\u043e\u0441\u043b\u0435 \u0441\u0440\u043e\u043a\u0430 \u0433\u043e\u0442\u043e\u0432\u043d\u043e\u0441\u0442\u0438. \u0412\u0430\u0448\u0438 ETH \u043f\u043e-\u043f\u0440\u0435\u0436\u043d\u0435\u043c\u0443 \u0432 \u044d\u0441\u043a\u0440\u043e\u0443, \u0438 \u0438\u0445 \u043c\u043e\u0436\u043d\u043e \u0437\u0430\u0431\u0440\u0430\u0442\u044c \u043e\u0431\u0440\u0430\u0442\u043d\u043e.",
  },
};

// A SHORT FORM for a deal list badge: a sentence does not fit there, but the state still has to be named.
// Same languages and the same code; the keys are a SUBSET of SDK_STATE_WORDS.
export const SDK_STATE_SHORT = {
  declined: { en: "declined", ru: "\u043e\u0442\u043a\u0430\u0437" },
};

/** The state phrase for a code. AN UNKNOWN CODE is returned AS IT IS - the same rule as the refusal dictionary. */
export function sdkStateText(code, lang = "en") {
  const words = code ? SDK_STATE_WORDS[code] : null;
  if (!words) return code ? String(code) : "";
  return words[lang] || words.en;
}

/** A short state label for a code - by the same rule. */
export function sdkStateShort(code, lang = "en") {
  const words = code ? SDK_STATE_SHORT[code] : null;
  if (!words) return code ? String(code) : "";
  return words[lang] || words.en;
}

// HUMAN LABELS FOR THE `params` FIELDS: without them a detail would look like an object dump. Values stay as
// they are - they are field names and core codes.
const PARAM_LABELS = {
  field: { en: "field", ru: "\u043f\u043e\u043b\u0435" },
  step: { en: "step", ru: "\u0448\u0430\u0433" },
  stage: { en: "stage", ru: "\u044d\u0442\u0430\u043f" },
  status: { en: "status", ru: "\u0441\u0442\u0430\u0442\u0443\u0441" },
  why: { en: "reason", ru: "\u043f\u0440\u0438\u0447\u0438\u043d\u0430" },
  missing: { en: "missing", ru: "\u043d\u0435 \u0445\u0432\u0430\u0442\u0430\u0435\u0442" },
  surface: { en: "surface", ru: "\u043f\u043e\u0432\u0435\u0440\u0445\u043d\u043e\u0441\u0442\u044c" },
  vm: { en: "network", ru: "\u0441\u0435\u0442\u044c" },
  known: { en: "known", ru: "\u0438\u0437\u0432\u0435\u0441\u0442\u043d\u044b\u0435" },
  unknown: { en: "unknown", ru: "\u043d\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043d\u043e\u0435" },
  got: { en: "got", ru: "\u043f\u043e\u043b\u0443\u0447\u0435\u043d\u043e" },
  want: { en: "want", ru: "\u043d\u0443\u0436\u043d\u043e" },
  min: { en: "min", ru: "\u043c\u0438\u043d\u0438\u043c\u0443\u043c" },
  unlocked: { en: "unlocked", ru: "\u0440\u0430\u0437\u0431\u043b\u043e\u043a\u0438\u0440\u043e\u0432\u0430\u043d\u043e" },
  lockedXmr: { en: "locked XMR", ru: "\u0437\u0430\u043f\u0435\u0440\u0442\u043e XMR" },
  // THE unlock_time BOUNDARY ARRIVES AS A NUMBER AND IS RESOLVED HERE: a height as it is, a time as a date. The
  // interface makes the words, not the core; the core carries only the number and whether it is a height or a
  // time.
  untilHeight: { en: "unlocks at block", ru: "\u043e\u0442\u043a\u0440\u043e\u0435\u0442\u0441\u044f \u043d\u0430 \u0431\u043b\u043e\u043a\u0435" },
  untilTime: { en: "unlocks at (UTC)", ru: "\u043e\u0442\u043a\u0440\u043e\u0435\u0442\u0441\u044f (UTC)" },
  expectedXmr: { en: "expected XMR", ru: "\u043e\u0436\u0438\u0434\u0430\u043b\u043e\u0441\u044c XMR" },
  id: { en: "id", ru: "\u0438\u0434\u0435\u043d\u0442\u0438\u0444\u0438\u043a\u0430\u0442\u043e\u0440" },
  swapId: { en: "swap", ru: "\u0441\u0434\u0435\u043b\u043a\u0430" },
  rpc: { en: "rpc", ru: "rpc" },
  // THE GAS RECIPIENT AND THE AMOUNT. These are the same got/want agreed for money, but the address is named
  // out loud: unlabelled it would look like one more technical field.
  to: { en: "to", ru: "\u043f\u043e\u043b\u0443\u0447\u0430\u0442\u0435\u043b\u044c" },
  // A PAYMENT CHECKED BY TWO NODES: the transaction, the block and the disagreement use the same words.
  txid: { en: "transaction", ru: "\u043f\u0435\u0440\u0435\u0432\u043e\u0434" },
  height: { en: "block height", ru: "\u0432\u044b\u0441\u043e\u0442\u0430 \u0431\u043b\u043e\u043a\u0430" },
  blockHash: { en: "block hash", ru: "\u0445\u0435\u0448 \u0431\u043b\u043e\u043a\u0430" },
  confirmations: { en: "confirmations", ru: "\u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043d\u0438\u0439" },
  needConfirmations: { en: "needed confirmations", ru: "\u043d\u0443\u0436\u043d\u043e \u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043d\u0438\u0439" },
  minConfirmations: { en: "minimum confirmations", ru: "\u043c\u0438\u043d\u0438\u043c\u0443\u043c \u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043d\u0438\u0439" },
  needSec: { en: "needed time (s)", ru: "\u043d\u0443\u0436\u043d\u043e \u0432\u0440\u0435\u043c\u0435\u043d\u0438 (\u0441)" },
  leftSec: { en: "time left (s)", ru: "\u043e\u0441\u0442\u0430\u043b\u043e\u0441\u044c \u0432\u0440\u0435\u043c\u0435\u043d\u0438 (\u0441)" },
  readyBy: { en: "ready deadline (UTC)", ru: "\u0441\u0440\u043e\u043a \u0433\u043e\u0442\u043e\u0432\u043d\u043e\u0441\u0442\u0438 (UTC)" },
  operators: { en: "operators", ru: "\u043e\u043f\u0435\u0440\u0430\u0442\u043e\u0440\u044b" },
  tip: { en: "node height", ru: "\u0432\u044b\u0441\u043e\u0442\u0430 \u043d\u043e\u0434\u044b" },
};

// WHAT OF THE PARAMETERS TO SHOW AND IN WHAT ORDER. The person needs "what was missing" and "which step".
const PARAM_KEYS = ["step", "stage", "status", "field", "missing", "why", "got", "want", "unlocked", "lockedXmr", "untilHeight", "untilTime", "expectedXmr", "id", "swapId", "vm", "rpc", "min", "surface", "to", "txid", "height", "blockHash", "confirmations", "needConfirmations", "minConfirmations", "needSec", "leftSec", "readyBy", "operators", "tip"];

const asText = (key, value) => {
  // THE UNLOCK TIME AS A DATE. Seconds (>= 500 000 000) would otherwise look like an opaque number; this is
  // the only place where a code becomes words, so the unit conversion belongs here too.
  if (key === "untilTime" && Number.isFinite(Number(value))) return new Date(Number(value) * 1000).toISOString();
  if (Array.isArray(value)) return value.map((v) => asText(null, v)).join(", ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value);
};

function detailOf(params, lang) {
  if (!params || typeof params !== "object") return "";
  const parts = [];
  for (const key of PARAM_KEYS) {
    if (!(key in params)) continue;
    const value = params[key];
    if (value === undefined || value === null || value === "") continue;
    const label = PARAM_LABELS[key] ? (PARAM_LABELS[key][lang] || PARAM_LABELS[key].en) : key;
    parts.push(label + ": " + asText(key, value));
  }
  return parts.join("; ");
}

/**
 * A core code in words. Takes an SdkError, a refusal value (`{ code, params }`) or a code string.
 * AN UNKNOWN CODE is returned AS IT IS - that is the protection against swallowing future refusals.
 */
export function sdkErrorText(error, lang = "en") {
  const code = typeof error === "string" ? error : (error && error.code);
  const params = (error && typeof error === "object" && error.params) || {};
  const words = code ? SDK_ERROR_WORDS[code] : null;
  if (!words) return code ? String(code) : String((error && error.message) || error || "unknown");
  const base = words[lang] || words.en;
  const detail = detailOf(params, lang);
  return detail ? base + " (" + detail + ")" : base;
}

export default sdkErrorText;
