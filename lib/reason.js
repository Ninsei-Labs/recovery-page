// WHY SOMETHING FAILED, AS THE PAGE MAY SHOW IT AND A PERSON MAY COPY IT: the page's own words for a code, names and
// numbers, never a text. What a wallet, a node, an RPC or a library says in words may quote what it was given, in any
// language and any spelling, and no filter can tell that apart. So nothing is read from an error but its code, its name,
// and the fields of its `params` that are a number, a yes or no, a name or an EVM address.
//
// A NAME IS ONE TOKEN OF AT MOST 40 CHARACTERS: a 32-byte value (64 in hex, 43 in base64) does not fit into one, and
// neither do a key's twelve words.
const NAME = /^[A-Za-z][A-Za-z0-9._-]{0,39}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const nameOf = (value) => (typeof value === "string" && NAME.test(value) ? value : null);

function isPublic(value) {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "bigint") return String(value).length <= 40;
  if (Array.isArray(value)) return value.every(isPublic);
  return typeof value === "boolean" || nameOf(value) !== null || (typeof value === "string" && ADDRESS.test(value));
}
const publicFields = (params) =>
  Object.fromEntries(Object.entries(params && typeof params === "object" ? params : {}).filter(([, v]) => isPublic(v)));

// A FAILURE OF THE PAGE'S OWN, by a code of its own: its words are in the language file under "reason.page.<code>".
export const pageFailure = (code, params = {}, message = code) =>
  Object.assign(new Error(message), { code: "page." + code, params });

export function reasonOf(error, t) {
  const code = error && error.code;
  if (Number.isSafeInteger(code)) return t("reason.number", { code: String(code) });
  const name = nameOf(code);
  if (!name) return t("reason.none", { name: nameOf(error && error.name) || "?" });
  const params = publicFields(error.params);
  if (name.startsWith("page.")) return t("reason." + name, params);
  const words = t("sdk." + name, params);
  return t("sdk." + name) === name ? t("reason.unknown", { code: words }) : words;
}

// THE IDS OF MONERO TRANSACTIONS, which have a place of their own and are shown only there.
export const txIds = (list) => (Array.isArray(list) ? list : []).filter((id) => /^[0-9a-f]{64}$/.test(String(id)));
