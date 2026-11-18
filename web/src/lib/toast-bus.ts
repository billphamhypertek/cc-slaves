// hf1117-docs a toast from a part of the UI that holds no store (Tasks "Tài liệu" open failures, a link that fails to open):
// `main.tsx` points the sink at the store once, with the UI language a `(tr) => text` toast is rendered in; before that
// (tests) a toast goes nowhere.
import { makeT, type Lang, type Tr } from '../../../shared/i18n/core.ts';
import type { Toast } from './store.ts';

type Sink = (level: Toast['level'], text: string) => void;
let sink: Sink | null = null;
let lang: () => Lang = () => 'vi';

export function setToastSink(fn: Sink, uiLang: () => Lang): void { sink = fn; lang = uiLang; }
/** `text`: ready words, or built in the UI language (a caller with no `useT`, e.g. `openExternal`). */
export function appToast(level: Toast['level'], text: string | ((tr: Tr) => string)): void {
  sink?.(level, typeof text === 'string' ? text : text(makeT(lang())));
}
