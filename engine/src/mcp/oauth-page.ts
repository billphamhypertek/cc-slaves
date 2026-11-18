// v2.2 §5.3 the OAuth callback page: static HTML, no script; every value from the query (server name, `error`,
// `error_description`) is HTML-escaped; `no-store`, a CSP that allows nothing but inline style, no referrer.
import { t, type Key, type Params } from '../../../shared/i18n/index.ts';

const ESC: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]!);

const CALLBACK_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

/** One page: a title line (catalog key) and an optional detail line (the AS's `error_description`, escaped). */
export function callbackPage(status: number, key: Key, params: Params = {}, detail?: string): Response {
  const esc = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, escapeHtml(String(v))]));
  const title = t('vi', key, esc);
  const body = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>cc-slaves</title>`
    + `<style>body{font:16px -apple-system,system-ui,sans-serif;margin:15vh auto;max-width:36em;color:#222}p.d{color:#666}</style></head>`
    + `<body><p>${title}</p>${detail ? `<p class="d">${escapeHtml(detail)}</p>` : ''}</body></html>`;
  return new Response(body, { status, headers: CALLBACK_HEADERS });
}
