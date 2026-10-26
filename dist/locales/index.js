// THE WITHDRAWAL PAGE'S LOCALISATION LAYER: NO DEPENDENCIES, ONE FUNCTION t(key, params),
// THE WORDS LIVE AS DATA IN THE FOLDERS locales/<tag>/.
//
// WHY THIS SHAPE. The page is a REFERENCE for third parties, so the layer has to stay small and obvious:
// words as data in their own folder, the machinery here, nothing else. English is the default language.
//
// ADDING A LANGUAGE. A folder locales/<tag>/index.js with the same shape (tag, name, strings, sdk, params)
// is enough: the language list is read from the FOLDERS by build/build.mjs (locales/available.js), so
// neither this layer nor the markup changes by a line.
//
// NUMBERS AND FORMS COME FROM THE PLATFORM, not from tables of our own: Intl.NumberFormat (n),
// Intl.DateTimeFormat (d) and Intl.PluralRules. A plural form is declared by the language itself:
//   "key": { one: "...", few: "...", many: "..." }   - the form is picked by params.count
//
// CORE REFUSALS ARE BY CODE. The core names a refusal by code (SdkError(code, params), message === code) and
// holds no human text, so the phrase for each code lives in the language (`sdk`) and the caller says
// t("sdk." + code, params). AN UNKNOWN CODE IS RETURNED AS IT IS: otherwise tomorrow's refusal would be
// indistinguishable from today's - the same rule as the page dictionary (lib/codes.js).
import { AVAILABLE } from "./available.js?v=0.2.0";

// THE DEFAULT LANGUAGE IS ENGLISH; the choice is kept in the page's own storage.
export const DEFAULT_LOCALE = "en";
export const STORAGE_KEY = "recovery.lang";
export const SDK_PREFIX = "sdk.";

// THE ORDER AND SHAPE OF DETAILS (`params`) match the page dictionary (lib/codes.js): the same error has to
// read the same way in both places.
const PARAM_ORDER = ["step", "stage", "status", "field", "missing", "why", "got", "want", "unlocked", "lockedXmr",
  "untilHeight", "untilTime", "expectedXmr", "id", "swapId", "vm", "rpc", "min", "surface", "to", "txid", "height",
  "blockHash", "confirmations", "needConfirmations", "minConfirmations", "needSec", "leftSec", "readyBy", "operators", "tip"];

let current = null;      // the loaded language (from locales/<tag>/index.js)
let pluralRules = null;  // Intl.PluralRules of the current language
let numberFormat = null; // Intl.NumberFormat
let dateFormat = null;   // Intl.DateTimeFormat

export const locales = () => AVAILABLE.slice();
export const localeTag = () => (current ? current.tag : DEFAULT_LOCALE);

// VALUES THE PAGE KNOWS (worker path, node address): the markup holds {name} and the value comes from ONE
// place in code. A second copy of the path inside a text would drift from the real address.
let values = {};
export const bindValues = (map) => { values = { ...values, ...(map || {}) }; applyTranslations(); };

// SUBSTITUTION: {name} is taken from params. A missing name stays as written: a silent empty string would
// hide a typo in the language file.
const fill = (text, params) => (params
  ? String(text).replace(/\{(\w+)\}/g, (whole, name) => (
      Object.prototype.hasOwnProperty.call(params, name) && params[name] !== null && params[name] !== undefined
        ? String(params[name]) : whole))
  : String(text));

// NUMBER FORM: a string as written, an object by Intl.PluralRules and params.count.
const formOf = (words, params) => {
  if (typeof words === "string") return words;
  const count = Number(params && params.count);
  const form = pluralRules.select(Number.isFinite(count) ? count : 0);
  return words[form] !== undefined ? words[form] : words.other;
};

// A CORE CODE'S DETAIL: "field: wallet; step: mark". The values are field names and core codes - never
// translated.
const valueText = (key, value) => {
  if (key === "untilTime" && Number.isFinite(Number(value))) {
    const date = toDate(Number(value) * 1000);
    return date ? date.toISOString() : t(DATE_UNKNOWN_KEY);
  }
  if (Array.isArray(value)) return value.map((v) => valueText(null, v)).join(", ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value);
};
const detailOf = (params, dict) => {
  if (!params || typeof params !== "object") return "";
  const parts = [];
  for (const key of PARAM_ORDER) {
    if (!(key in params)) continue;
    const value = params[key];
    if (value === undefined || value === null || value === "") continue;
    parts.push((dict.params[key] || key) + ": " + valueText(key, value));
  }
  return parts.join("; ");
};

/**
 * WORDS BY KEY. A key names a string in the language; for a core refusal it is "sdk." + code, and the
 * detail from params is then appended. A missing key returns THE KEY ITSELF (a forgotten line is visible);
 * an unknown core code returns THE CODE (tomorrow's refusal does not hide under today's).
 */
export function t(key, params) {
  const dict = current;
  if (!dict) return String(key);
  const words = dict.strings[key];
  if (words !== undefined) return fill(formOf(words, params), params);
  if (key.startsWith(SDK_PREFIX)) {
    const code = key.slice(SDK_PREFIX.length);
    const phrase = dict.sdk[code];
    if (!phrase) return code;
    const detail = detailOf(params, dict);
    return detail ? fill(phrase, params) + " (" + detail + ")" : fill(phrase, params);
  }
  return String(key);
}

// NUMBER AND DATE COME FROM THE CURRENT LANGUAGE'S PLATFORM (separators, order, form).
export const n = (value, options = null) => (options ? new Intl.NumberFormat(localeTag(), options) : numberFormat).format(value);

// A DATE FORMAT MUST NOT TAKE THE PAGE DOWN. Intl.DateTimeFormat.format() throws RangeError on a bad date
// (an empty field, a broken timestamp), and that used to kill the WHOLE page: the core never opened the
// file and the person saw a refusal instead of a date. So the format has a NAMED FALLBACK KEY: a bad or
// missing value shows WORDS (resolved by the current language, a forgotten key visible as itself), not an
// empty string and not an exception. Date parsing is ONE place and everyone who prints a date goes through
// it (see valueText below - the second date path, through a core refusal's params).
const DATE_UNKNOWN_KEY = "value.dateUnknown";
const toDate = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};
export const d = (value, options = null) => {
  const date = toDate(value);
  if (!date) return t(DATE_UNKNOWN_KEY);
  return (options ? new Intl.DateTimeFormat(localeTag(), options) : dateFormat).format(date);
};

// LOADING A LANGUAGE: a tag not in the list falls back to the default, and the console SAYS so.
export async function load(tag) {
  const wanted = AVAILABLE.includes(tag) ? tag : DEFAULT_LOCALE;
  if (current && current.tag === wanted) return current;
  if (tag && !AVAILABLE.includes(tag)) console.warn("[i18n] no such locale: " + tag + ", using " + DEFAULT_LOCALE);
  const mod = await import("./" + wanted + "/index.js");
  current = mod.default;
  pluralRules = new Intl.PluralRules(wanted);
  numberFormat = new Intl.NumberFormat(wanted);
  dateFormat = new Intl.DateTimeFormat(wanted, { dateStyle: "medium", timeStyle: "short" });
  return current;
}

// THE PAGE'S OWN STORAGE: the choice survives a reload. Closed storage is not a page failure: the choice is
// simply not remembered.
export function stored() {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}
function remember(tag) {
  try { localStorage.setItem(STORAGE_KEY, tag); } catch { /* storage is closed - no reason to break the page */ }
}

// THE BROWSER'S LANGUAGE, ONLY AMONG THE ONES THE PAGE CARRIES: "ru-RU" reads as "ru".
function wantedFromBrowser() {
  const list = [].concat(navigator.languages || [], navigator.language || []);
  for (const raw of list) {
    const tag = String(raw || "").toLowerCase().split("-")[0];
    if (AVAILABLE.includes(tag)) return tag;
  }
  return null;
}

// MARKUP: data-i18n is the node text, data-i18n-placeholder a field hint, data-i18n-title the tab title.
// In a language text **bold** becomes <b> and `code` becomes <code>: otherwise a phrase would have to be
// glued from pieces and the translation would be stuck with English word order. The backtick is written as
// \x60: a literal one confuses a reader of the source, where an unbalanced quote can swallow code as text.
const MARKUP = /\*\*([^*]+)\*\*|\x60([^\x60]+)\x60/g;
function setText(node, text) {
  const pieces = String(text).split(MARKUP);
  node.textContent = "";
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (!piece) continue;
    if (i % 3 === 0) { node.appendChild(document.createTextNode(piece)); continue; }
    const el = document.createElement(i % 3 === 1 ? "b" : "code");
    el.textContent = piece;
    node.appendChild(el);
  }
}

export function applyTranslations(root = document) {
  document.documentElement.lang = localeTag();
  const head = document.querySelector("[data-i18n-title]") || document.documentElement;
  document.title = t(head.getAttribute("data-i18n-title") || "page.title");
  for (const el of root.querySelectorAll("[data-i18n]")) setText(el, t(el.getAttribute("data-i18n"), values));
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder"), values));
}

// THE LANGUAGE PICKER: the list comes from the folders (AVAILABLE), the labels from the languages themselves.
function fillPicker(select) {
  select.textContent = "";
  for (const tag of AVAILABLE) {
    const option = document.createElement("option");
    option.value = tag;
    option.textContent = localeName(tag);
    option.selected = tag === (current && current.tag);
    select.appendChild(option);
  }
}

export const localeName = (tag) => (current && current.names && current.names[tag]) || tag;

export async function setLocale(tag) {
  await load(tag);
  remember(current.tag);
  applyTranslations();
  return current.tag;
}

/**
 * THE PAGE ENTRY POINT: the language (stored, else English), the markup labels and the picker. Returns the
 * chosen tag.
 */
export async function init(pickerId = "lang") {
  // ENGLISH IS THE DEFAULT FOR EVERYONE, not "whatever the browser claims": the page's texts are
  // written in English, and a visitor who wants another language picks it - the choice is then kept.
  await load(stored() || DEFAULT_LOCALE);
  const picker = document.getElementById(pickerId);
  if (picker) {
    // ONE LANGUAGE IS NOT A CHOICE: a select with a single option is a control that cannot do anything.
    if (AVAILABLE.length < 2) {
      const field = picker.closest(".field") || picker;
      field.hidden = true;
    }
    fillPicker(picker);
    picker.addEventListener("change", () => { setLocale(picker.value).catch(() => { /* the language did not change - the old one stays */ }); });
  }
  applyTranslations();
  remember(current.tag);
  return current.tag;
}
