// The one home for links that leave the app (spec v2.2 §14.5 C30) and for the clipboard. A link never navigates the app
// window: only http / https / mailto become links, and they always open in the system browser — app-origin links too
// (src-tauri/src/guard.rs lets an app-origin navigation through; the renderer never gives it one).

import { hasKey, type Key, type Tr } from '../../../shared/i18n/core.ts';
import { hasTauri, invoke } from './tauri.ts';
import { appToast } from './toast-bus.ts';

const LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/** §14.5 C30 the absolute http / https / mailto URL, else null (javascript:, data:, file:, vbscript:, relative …). */
export function safeHref(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  return LINK_SCHEMES.has(u.protocol) ? u.href : null;
}

/** What a link shows on hover: the domain (the address for mailto). */
export const linkDomain = (href: string): string => {
  const u = new URL(href);
  return u.protocol === 'mailto:' ? u.pathname : u.host;
};

/** Open in the system browser, never in the app window. In the Mac app WKWebView drops `window.open`: the Rust
 *  `open_url` command (http / https / mailto only) hands the link to macOS; in a plain browser a new tab. Rejects with
 *  the Rust refusal code (`openWhy` puts it in words). */
export async function openLink(url: string): Promise<void> {
  if (hasTauri()) await invoke('open_url', { url });
  else window.open(url, '_blank', 'noopener,noreferrer');
}

/** hf1117-fb why an open failed, in words: a Rust `open_doc` / `open_url` code (or `mac_only`) → its text; any other code
 *  (snake_case, empty, not text) → "lỗi không rõ"; Rust's own translated text (`open` exit) as sent. Never a raw code. */
export function openWhy(tr: Tr, why: unknown): string {
  const raw = why instanceof Error ? why.message : String(why);
  const key = `common.openWhy.${raw}`;
  if (hasKey(tr.lang, key)) return tr(key as Key);
  return /^[a-z_]*$/.test(raw) ? tr('common.openWhy.other') : raw;
}

/** `openLink` for a link in text (conversation, Markdown): fire and forget; a failure says why in a toast (ruling 10:50). */
export function openExternal(url: string): void {
  void openLink(url).catch((e: unknown) => appToast('error', tr => tr('common.openFail', { why: openWhy(tr, e) })));
}

export const copyText = (t: string) => { void navigator.clipboard?.writeText(t).catch(() => {}); };
