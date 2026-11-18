// spec v2.2 §14.5 C30: every link opens outside the app window — the Rust `open_url` command in the Mac app (WKWebView
// drops `window.open`), a new tab in a plain browser.
import { afterEach, describe, expect, test } from 'bun:test';
import { makeT } from '../../shared/i18n/index.ts';
import { openExternal, openWhy } from '../src/lib/links.ts';
import { setToastSink } from '../src/lib/toast-bus.ts';

const g = globalThis as { window?: unknown };
afterEach(() => { delete g.window; });

describe('§14.5 C30 openExternal', () => {
  test('§14.5 C30 in the Mac app the link goes to the `open_url` command, never window.open', async () => {
    const calls: unknown[] = [], opened: unknown[] = [];
    g.window = { __TAURI__: { core: { invoke: (cmd: string, args: unknown) => { calls.push([cmd, args]); return Promise.resolve(); } } }, open: (...a: unknown[]) => opened.push(a) };
    openExternal('http://127.0.0.1:47800/x');
    await Promise.resolve();
    expect(calls).toEqual([['open_url', { url: 'http://127.0.0.1:47800/x' }]]);
    expect(opened).toEqual([]);
  });
  test('§14.5 C30 in a plain browser: a new tab, no opener', () => {
    const opened: unknown[] = [];
    g.window = { open: (...a: unknown[]) => opened.push(a) };
    openExternal('https://github.com/x');
    expect(opened).toEqual([['https://github.com/x', '_blank', 'noopener,noreferrer']]);
  });
});

describe('hf1117-fb an open failure says why in words (vi / en), never a raw code or OS text', () => {
  const vi = makeT('vi'), en = makeT('en');
  const CODES = ['outside_project', 'not_found', 'mac_only', 'bad_path', 'not_html', 'no_token', 'forbidden_origin', 'bad_url', 'engine_unreachable'];
  test('every Rust `open_doc` / `open_url` code (+ `mac_only`) has its own words in both languages', () => {
    for (const tr of [vi, en]) {
      const texts = CODES.map(c => openWhy(tr, new Error(c)));
      for (const [i, t] of texts.entries()) { expect(t).not.toBe(CODES[i]); expect(t).not.toMatch(/^[a-z_]+$/); }
      expect(new Set(texts).size).toBe(CODES.length);
    }
    expect(openWhy(vi, 'not_html')).toBe('file không phải .html');
    expect(openWhy(en, 'engine_unreachable')).toBe('cannot reach the engine');
  });
  test('an unknown code (and a non-text value) → "lỗi không rõ"; Rust text in words passes as sent', () => {
    expect(openWhy(vi, new Error('zap_unknown'))).toBe('lỗi không rõ');
    expect(openWhy(en, 'zap_unknown')).toBe('unknown error');
    expect(openWhy(vi, undefined)).toBe('lỗi không rõ');
    expect(openWhy(vi, new Error(''))).toBe('lỗi không rõ');
    expect(openWhy(vi, new Error('open thoát với mã 1'))).toBe('open thoát với mã 1');
  });
});

describe('hf1117-fb ruling 10:50 a conversation / Markdown link that fails to open → a toast, never silent', () => {
  const toasts: [string, string][] = [];
  const tauri = (fail?: string) => {
    g.window = { __TAURI__: { core: { invoke: () => (fail ? Promise.reject(new Error(fail)) : Promise.resolve()) } }, open: () => null };
  };
  const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  afterEach(() => { toasts.length = 0; setToastSink(() => {}, () => 'vi'); });
  test('a refusal → "Không mở được link: <why>" in the UI language; success → no toast', async () => {
    setToastSink((l, t) => toasts.push([l, t]), () => 'vi');
    tauri('bad_url');
    openExternal('https://x.test/a');
    await tick();
    expect(toasts).toEqual([['error', 'Không mở được link: link không hợp lệ (chỉ http, https, mailto)']]);
    toasts.length = 0;
    tauri();
    openExternal('https://x.test/a');
    await tick();
    expect(toasts).toEqual([]);
    setToastSink((l, t) => toasts.push([l, t]), () => 'en');
    tauri('zap_unknown');
    openExternal('https://x.test/a');
    await tick();
    expect(toasts).toEqual([['error', 'Could not open the link: unknown error']]);
  });
});
