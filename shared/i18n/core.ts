// v2 §6A (D19) UI language core: `t()`, keyed reasons and the Intl formatters over the catalogs that are loaded. The
// catalogs themselves live in vi.ts / en.ts (one JSON per namespace and language); index.ts loads both (engine, tests),
// the web loads `vi` with the first paint and `en` only when the UI switches to it (spec v2.1 §5.6).
// How to add a key / namespace: docs/ref/i18n.md.
import type { KeyedReason } from '../protocol.ts';
import type { LAZY_NS } from './lazy.ts';
import type { VI_NS } from './vi.ts';

export type Lang = 'vi' | 'en';
export const LANGS: readonly Lang[] = ['vi', 'en'];
const LOCALE: Readonly<Record<Lang, string>> = { vi: 'vi-VN', en: 'en-US' };
/** The switch shows each language in its own words (§6A "Tiếng Việt ▾ / English"); never translated. */
export const LANG_NAME: Readonly<Record<Lang, string>> = { vi: 'Tiếng Việt', en: 'English' };

type Ns = typeof VI_NS & typeof LAZY_NS.vi;
export type Key = { [N in Extract<keyof Ns, string>]: `${N}.${Extract<keyof Ns[N], string>}` }[Extract<keyof Ns, string>];
export type Params = Record<string, string | number>;
/** `t` bound to one language; `lang` lets a helper check a key (`hasKey`) or format numbers without a second argument. */
export type Tr = ((key: Key, params?: Params) => string) & { readonly lang: Lang };

const CATALOGS: Partial<Record<Lang, Record<string, string>>> = {};
/** Flattens `{ ns: { path: text } }` into `<ns>.<path>` keys and makes `lang` available (vi.ts / en.ts call it once). */
type NsStrings = Readonly<Record<string, Readonly<Record<string, string>>>>;
function flat(ns: NsStrings): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [n, strings] of Object.entries(ns)) for (const [k, v] of Object.entries(strings)) out[`${n}.${k}`] = v;
  return out;
}
const LAZY: Partial<Record<Lang, Record<string, string>>> = {};
export function addCatalog(lang: Lang, ns: NsStrings): Record<string, string> {
  return (CATALOGS[lang] = { ...flat(ns), ...LAZY[lang] });
}
/** v2.2 §6 a namespace that ships with its lazy chunk (`lazy.ts`, bundle cap): joins `lang` now, or when it loads. */
export function extendCatalog(lang: Lang, ns: NsStrings): void {
  const f = flat(ns);
  LAZY[lang] = { ...LAZY[lang], ...f };
  const c = CATALOGS[lang];
  if (c) Object.assign(c, f);
}
/** spec v2.1 §5.6: the web loads the inactive language lazily — a language is usable once its catalog is in. */
export const hasCatalog = (lang: Lang): boolean => CATALOGS[lang] !== undefined;

let strictOverride: boolean | null = null;
/** @internal Tests only: force prod (false) / strict (true) behaviour; null = by NODE_ENV. */
export function setI18nStrict(v: boolean | null): void { strictOverride = v; }
// `globalThis.process` (not `process`) so the web build never sees a replaced NODE_ENV: the browser is always prod.
const strict = () => strictOverride ?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.NODE_ENV === 'test';

export const hasKey = (lang: Lang, key: string): boolean => CATALOGS[lang]?.[key] !== undefined;

/** v2.9 §4.7 the workflow names a catalog string may take (`{doc}`, `{buildLow}`…): absent → `common.wf.<name>`. */
const WF_NAMES: ReadonlySet<string> = new Set(['doc', 'docLow', 'design', 'designLow', 'build', 'buildLow']);

/**
 * The text of `key` in `lang` with `{name}` replaced from `params`; `{n:one|many}` is `one` when `n` is 1, else `many` (English
 * plurals, docs/ref/i18n.md). A missing key throws in tests and returns the key in
 * prod — never the Vietnamese text (§6A). A missing param throws in tests and stays as `{name}` in prod.
 */
export function t(lang: Lang, key: Key, params?: Params): string {
  const s = CATALOGS[lang]?.[key];
  if (s === undefined) {
    if (strict()) throw new Error(`i18n: missing key "${key}" in ${lang}`);
    return key;
  }
  return s.replace(/\{(\w+)(?::([^|}]*)\|([^}]*))?\}/g, (m, p: string, one?: string, many?: string) => {
    if (params && p in params) return one === undefined ? String(params[p]) : Number(params[p]) === 1 ? one : many!;
    const wf = WF_NAMES.has(p) ? CATALOGS[lang]?.[`common.wf.${p}`] : undefined; // v2.9 §4.7 default = Quy trình PO's word
    if (wf !== undefined) return wf;
    if (strict()) throw new Error(`i18n: "${key}" needs param {${p}}`);
    return m;
  });
}

export const makeT = (lang: Lang): Tr => Object.assign((key: Key, params?: Params) => t(lang, key, params), { lang });

/**
 * §6A an engine-composed reason (`KeyedReason`) in `tr.lang`: `inner` is rendered first and fills `{detail}`. Null when
 * there is none or a key is unknown to this catalog (an older / newer engine) — the caller shows the stored text.
 */
export function keyedText(tr: Tr, k: KeyedReason | null | undefined): string | null {
  if (!k || !hasKey(tr.lang, k.key)) return null;
  let params = k.params;
  if (k.inner) {
    const d = keyedText(tr, k.inner);
    if (d === null) return null;
    params = { ...params, detail: d };
  }
  return tr(k.key as Key, params);
}
/** `{ key, params, inner }` → the reason plus its vi text (what the engine stores as `lastError` / card body). */
export function reason(key: Key, params?: Params, inner?: KeyedReason): KeyedReason & { text: string } {
  const k: KeyedReason = { key, ...(params ? { params } : {}), ...(inner ? { inner } : {}) };
  return { ...k, text: keyedText(makeT('vi'), k) ?? key };
}

/** @internal The `{param}` names of a catalog string, sorted (parity test). */
export const paramsOf = (s: string): string[] => [...new Set([...s.matchAll(/\{(\w+)(?::[^}]*)?\}/g)].map(m => m[1]!))].sort();

/** `config.ui.lang` (config.json, §6A): default `vi`, no macOS guess. */
export function langOf(config: Record<string, unknown> | null | undefined): Lang {
  const ui = config?.ui;
  const l = ui && typeof ui === 'object' ? (ui as { lang?: unknown }).lang : undefined;
  return l === 'en' ? 'en' : 'vi';
}

export const fmtNum = (lang: Lang, n: number, o?: Intl.NumberFormatOptions): string => new Intl.NumberFormat(LOCALE[lang], o).format(n);
/** `pct` is 0–100 (what the engine reports), rounded to a whole percent. */
export const fmtPct = (lang: Lang, pct: number): string => new Intl.NumberFormat(LOCALE[lang], { style: 'percent', maximumFractionDigits: 0 }).format(pct / 100);
export const fmtDate = (lang: Lang, ms: number, o?: Intl.DateTimeFormatOptions): string => new Intl.DateTimeFormat(LOCALE[lang], o).format(ms);
