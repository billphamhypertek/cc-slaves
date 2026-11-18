// v2 §6A web side of the catalogs (shared/i18n): the language comes from `config.ui.lang` (engine config, pushed by the
// `config` event, so a switch applies at once); components read it with `useT()`. How to add a key: docs/ref/i18n.md.
// spec v2.1 §5.6: `vi` (the default) ships with the first paint; `en` is fetched when the UI switches to it, and the app
// keeps the language it shows until that catalog is in.
import { createContext, useContext, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { isOrchSource, type CardView, type KeyedReason } from '../../../shared/protocol.ts';
import { hasCatalog, hasKey, keyedText, makeT, t, type Key, type Lang, type Params, type Tr } from '../../../shared/i18n/core.ts';
import '../../../shared/i18n/vi.ts';
import { CommandError } from './ws.ts';

export type { Key, Lang, Tr };
const LangCtx = createContext<Lang>('vi');

/** The lazy catalogs (`vi` is already in). */
const LOADERS: Partial<Record<Lang, () => Promise<unknown>>> = { en: () => import('../../../shared/i18n/en.ts') };
/** spec v2.1 §5.6 the language to render: `want` once its catalog is in, else the one shown so far. */
export const shownLang = (want: Lang, shown: Lang, has: (l: Lang) => boolean = hasCatalog): Lang => (has(want) ? want : has(shown) ? shown : 'vi');

export function LangProvider({ lang, children }: { lang: Lang; children: ReactNode }): ReactElement {
  const [shown, setShown] = useState<Lang>(() => shownLang(lang, 'vi'));
  const cur = shownLang(lang, shown);
  useEffect(() => {
    if (cur === lang) return;
    let live = true;
    void LOADERS[lang]?.().then(() => { if (live) setShown(lang); });
    return () => { live = false; };
  }, [lang, cur]);
  return <LangCtx.Provider value={cur}>{children}</LangCtx.Provider>;
}
const useLang = (): Lang => useContext(LangCtx);
/** v2.9 §4.7 the workflow names (`{doc}`, `{build}`…) every string under it takes (`wfNames`); none = the catalog's own;
 *  a nested one (a spec pinned to another rev) wins inside it. */
const WfCtx = createContext<Params | null>(null);
export function WfNames({ names, children }: { names: Params | null; children: ReactNode }): ReactElement {
  const outer = useContext(WfCtx); // null names = keep the outer ones (a spec whose rev is not read yet)
  return <WfCtx.Provider value={names ?? outer}>{children}</WfCtx.Provider>;
}
/** `tr(key, params)` in the current UI language (+ the workflow names of the nearest `WfNames`). */
export function useT(): Tr {
  const lang = useLang();
  const wf = useContext(WfCtx);
  return useMemo(() => (wf ? Object.assign((key: Key, p?: Params) => t(lang, key, { ...wf, ...p }), { lang }) : makeT(lang)), [lang, wf]);
}

/** §6A: a card's `titleKey` (+ params) when this UI knows the key, else the engine's `title` (old `card_v2` rows). */
export function cardTitle(tr: Tr, c: Pick<CardView, 'title' | 'titleKey' | 'params'>): string {
  if (!c.titleKey || !hasKey(tr.lang, c.titleKey)) return c.title;
  // G5-fix: `{source}` = the orchestrator (ORCH_SOURCE, or "Điều phối" on old rows) → its role name in this language
  const p = c.params && isOrchSource(c.params.source as string) ? { ...c.params, source: tr('common.role.orchestrator') } : c.params;
  return tr(c.titleKey as Key, p);
}

/** §6A G5-fix an engine-composed reason (`lastError` + `lastErrorKeyed`) in this language; Claude's own text as sent. */
export function reasonText(tr: Tr, text: string | null, keyed: KeyedReason | null | undefined): string | null {
  return keyedText(tr, keyed) ?? text;
}

/** §6A T9c: a system card's body (`context`) by `bodyKey` when known, else the engine text (vi / Claude / error text). */
export function cardBody(tr: Tr, c: Pick<CardView, 'context' | 'bodyKey' | 'bodyParams' | 'bodyInner'>): string | null {
  return (c.bodyKey ? keyedText(tr, { key: c.bodyKey, params: c.bodyParams, inner: c.bodyInner }) : null) ?? c.context ?? null;
}
/** §6A T9c: a system-card button by `labelKey` when known, else its (vi) `label`. */
export function actionLabel(tr: Tr, a: NonNullable<CardView['actions']>[number]): string {
  return a.labelKey && hasKey(tr.lang, a.labelKey) ? tr(a.labelKey as Key, a.labelParams) : a.label;
}

/** §6A: a command error's `key` (+ params) when known, else its (Vietnamese) message. */
export function errText(tr: Tr, e: unknown): string {
  if (e instanceof CommandError && e.key && hasKey(tr.lang, e.key)) return tr(e.key as Key, e.params);
  return e instanceof Error ? e.message : String(e);
}

/** §6A G5-fix the last line of an install log: its catalog key ("Xong" / "Thất bại") when known, else the line as sent. */
export function installLast(tr: Tr, l: { lines: string[]; lastKey?: string }): string | undefined {
  return l.lastKey && hasKey(tr.lang, l.lastKey) ? tr(l.lastKey as Key) : l.lines.at(-1);
}
