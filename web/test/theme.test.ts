// v2.8 §5 the theme: the stored mode (`ccs.theme`, bad / missing → light, PO 17/11 21:55), the computed look from mode + the system scheme,
// `data-theme` always explicit, live macOS changes (matchMedia `change` and Tauri `onThemeChanged`), Tauri `setTheme` with
// `null` first for "Theo macOS" (§4.7), and the three-item menu (§4.1).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createTheme, lookOf, readMode, themeItems, useTheme, type ThemeEnv, type ThemeWindow } from '../src/lib/theme.ts';
import { makeT } from '../../shared/i18n/index.ts';

function fakeEnv(stored: string | null, systemDark: boolean, withWin = true) {
  // the Mac app opens the window already forced to the stored mode (src-tauri theme::opening), so a forced matchMedia
  // is what the page sees first; a plain browser always reports the system
  let forced: 'light' | 'dark' | null = withWin && (stored === 'light' || stored === 'dark') ? stored : null, osDark = systemDark;
  const media = { matches: (forced ?? (systemDark ? 'dark' : 'light')) === 'dark', fire: () => {}, addEventListener(_t: 'change', f: () => void) { media.fire = f; } };
  const calls: (string | null)[] = [];
  const tauri = { fire: (_l: 'light' | 'dark') => {} };
  const win: ThemeWindow = {
    // WebKit reads the view's appearance: forcing a theme forces matchMedia too (§4.7, NC §5)
    setTheme: t => { calls.push(t); forced = t; media.matches = (forced ?? (osDark ? 'dark' : 'light')) === 'dark'; return Promise.resolve(); },
    onThemeChanged: f => { tauri.fire = l => f({ payload: l }); return Promise.resolve(() => {}); },
  };
  const store = { v: stored };
  const root = { dataset: {} as Record<string, string | undefined> };
  const env: ThemeEnv = { read: () => store.v, write: v => { store.v = v; }, media, root, win: withWin ? win : null };
  const os = (dark: boolean) => { osDark = dark; if (!forced) media.matches = dark; };
  return { env, media, calls, tauri, store, root, os };
}

describe('v2.8 §5.1 / §5.2 mode and look', () => {
  test('readMode: the three words pass, anything else (missing, junk, case) → light (PO 17/11 21:55)', () => {
    expect(readMode('light')).toBe('light');
    expect(readMode('dark')).toBe('dark');
    expect(readMode('system')).toBe('system');
    for (const v of [null, '', 'Light', 'auto', 'dark ', 'System']) expect(readMode(v)).toBe('light');
  });
  test('useTheme before installTheme reads the default too: Sáng, not Theo macOS', () => {
    const Probe = () => { const { state } = useTheme(); return createElement('i', null, `${state.mode}/${state.look}`); };
    expect(renderToString(createElement(Probe))).toBe('<i>light/light</i>');
  });
  test('lookOf: 3 modes × 2 system schemes', () => {
    expect([lookOf('light', false), lookOf('light', true)]).toEqual(['light', 'light']);
    expect([lookOf('dark', false), lookOf('dark', true)]).toEqual(['dark', 'dark']);
    expect([lookOf('system', false), lookOf('system', true)]).toEqual(['light', 'dark']);
  });
});

describe('v2.8 §5 createTheme', () => {
  test('boot: empty store on a dark macOS → light (the default), the window forced light (setTheme("light"))', () => {
    const f = fakeEnv(null, true);
    const th = createTheme(f.env);
    expect(f.root.dataset.theme).toBe('light');
    expect(th.get()).toEqual({ mode: 'light', look: 'light' });
    expect(f.calls).toEqual(['light']);
  });
  test('boot: stored dark wins over a light system; stored system follows macOS; junk → light', () => {
    const d = fakeEnv('dark', false);
    expect(createTheme(d.env).get()).toEqual({ mode: 'dark', look: 'dark' });
    expect(d.root.dataset.theme).toBe('dark');
    expect(d.calls).toEqual(['dark']);
    const s = fakeEnv('system', true);
    expect(createTheme(s.env).get()).toEqual({ mode: 'system', look: 'dark' });
    expect(s.calls).toEqual([null]);
    expect(createTheme(fakeEnv('nope', true).env).get()).toEqual({ mode: 'light', look: 'light' });
  });
  test('set(dark): data-theme at once (before the native call settles), stored, setTheme("dark"), subscribers told', async () => {
    const f = fakeEnv(null, false);
    const th = createTheme(f.env);
    let told = 0;
    th.subscribe(() => { told++; });
    const p = th.set('dark');
    expect(f.root.dataset.theme).toBe('dark');
    await p;
    expect(f.store.v).toBe('dark');
    expect(f.calls).toEqual(['light', 'dark']);
    expect(th.get()).toEqual({ mode: 'dark', look: 'dark' });
    expect(told).toBeGreaterThan(0);
  });
  test('§4.7 set(system) from forced light on a dark macOS: setTheme(null) first, then the real scheme is read', async () => {
    const f = fakeEnv('light', true);
    const th = createTheme(f.env);
    expect(f.root.dataset.theme).toBe('light');
    expect(f.media.matches).toBe(false); // forced light hides the dark macOS
    await th.set('system');
    expect(f.calls).toEqual(['light', null]);
    expect(th.get()).toEqual({ mode: 'system', look: 'dark' });
    expect(f.root.dataset.theme).toBe('dark');
  });
  test('§5.2 system mode follows a macOS change (matchMedia change); a forced mode ignores it', async () => {
    const f = fakeEnv('system', false);
    const th = createTheme(f.env);
    f.os(true); f.media.fire();
    expect(f.root.dataset.theme).toBe('dark');
    await th.set('light');
    f.os(false); f.media.fire(); f.os(true); f.media.fire();
    expect(f.root.dataset.theme).toBe('light');
  });
  test('§14 WKWebView may not fire matchMedia: Tauri onThemeChanged drives system mode alone, and the next set keeps it', async () => {
    const f = fakeEnv('system', false);
    const th = createTheme(f.env);
    f.tauri.fire('dark'); // matchMedia unchanged and silent
    expect(f.root.dataset.theme).toBe('dark');
    expect(th.get().look).toBe('dark');
    await th.set('light');
    f.tauri.fire('dark'); // forced: ignored
    expect(f.root.dataset.theme).toBe('light');
  });
  test('a plain browser (no Tauri window) works the same through matchMedia', async () => {
    expect(createTheme(fakeEnv(null, true, false).env).get()).toEqual({ mode: 'light', look: 'light' });
    const f = fakeEnv('system', true, false);
    const th = createTheme(f.env);
    expect(f.root.dataset.theme).toBe('dark');
    await th.set('light');
    expect(f.root.dataset.theme).toBe('light');
    expect(f.store.v).toBe('light');
  });
  test('a failing setTheme still switches the page', async () => {
    const f = fakeEnv(null, false);
    f.env.win = { setTheme: () => Promise.reject(new Error('denied')), onThemeChanged: () => Promise.resolve(() => {}) };
    const th = createTheme(f.env);
    await th.set('dark');
    expect(f.root.dataset.theme).toBe('dark');
  });
  test('v28-gate: a window without the theme calls (an older bridge, a test stub) still boots and switches', async () => {
    const f = fakeEnv(null, false);
    f.env.win = {} as ThemeWindow; // getCurrentWindow() without setTheme / onThemeChanged: the calls throw synchronously
    const th = createTheme(f.env);
    expect(f.root.dataset.theme).toBe('light');
    await th.set('dark');
    expect(f.root.dataset.theme).toBe('dark');
  });
});

describe('v2.8 §4.1 the Giao diện menu', () => {
  const tr = makeT('vi');
  test('three radio items Sáng · Tối · Theo macOS, ✓ on the mode, "đang Sáng / Tối" under Theo macOS when it is the mode', () => {
    const sys = themeItems(tr, { mode: 'system', look: 'light' });
    expect(sys.map(i => [i.label, i.icon, i.checked])).toEqual([['Sáng', 'sun', false], ['Tối', 'moon', false], ['Theo macOS', 'monitor', true]]);
    expect(sys[2]!.note).toBe('đang Sáng');
    expect(themeItems(tr, { mode: 'system', look: 'dark' })[2]!.note).toBe('đang Tối');
    const dark = themeItems(tr, { mode: 'dark', look: 'dark' });
    expect(dark.map(i => i.checked)).toEqual([false, true, false]);
    expect(dark[2]!.note).toBeUndefined();
    expect(dark.map(i => i.act)).toEqual([{ t: 'theme', mode: 'light' }, { t: 'theme', mode: 'dark' }, { t: 'theme', mode: 'system' }]);
  });
});

describe('v2.8 §5.3 no flash: the boot script and the window colour agree with the app', () => {
  const boot = readFileSync('web/public/theme-boot.js', 'utf8');
  /** runs /theme-boot.js against a fake page; `null` store = localStorage throws */
  const runBoot = (stored: string | null | Error, systemDark: boolean) => {
    const attrs: Record<string, string> = {};
    const ls = { getItem: () => { if (stored instanceof Error) throw stored; return stored; } };
    const win = { matchMedia: () => ({ matches: systemDark }) };
    const doc = { documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v; } } };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function('localStorage', 'window', 'document', boot)(ls, win, doc);
    return attrs['data-theme'];
  };
  test('theme-boot.js = lookOf(readMode(stored), system) for every stored value × system scheme (incl. a throwing store)', () => {
    for (const stored of ['light', 'dark', 'system', null, 'junk', new Error('denied')])
      for (const dark of [false, true])
        expect(runBoot(stored, dark)).toBe(lookOf(readMode(stored instanceof Error ? null : stored), dark));
  });
  test('the window opens on the --bg of each block (src-tauri/src/theme.rs ↔ styles.css)', () => {
    const css = readFileSync('web/src/styles.css', 'utf8'), rs = readFileSync('src-tauri/src/theme.rs', 'utf8');
    const bg = (block: RegExp) => css.match(block)![1]!.match(/--bg:#([0-9a-f]{6})/)![1]!;
    const rgb = (hex: string) => [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ');
    const rust = (name: string) => rs.match(new RegExp(`const ${name}: Color = Color\\((\\d+), (\\d+), (\\d+), 255\\)`))!.slice(1, 4).join(', ');
    expect(rust('DARK_BG')).toBe(rgb(bg(/^:root\{([^}]*)\}/m)));
    expect(rust('LIGHT_BG')).toBe(rgb(bg(/^:root\[data-theme=light\]\{([^}]*)\}/m)));
  });
});

describe('v28-fx §7.1 no leftovers of the dark lock', () => {
  test('no "always dark" comment left in web/src (MINOR-3)', () => {
    const hits = [...new Bun.Glob('web/src/**/*.{ts,tsx,css}').scanSync()].filter(f => /always dark/i.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
  test('the scrollbar colours are declared on :root alone, no dark-lock roots beside it (MINOR-2)', () => {
    const css = readFileSync('web/src/styles.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const sels = [...css.matchAll(/([^{}]+)\{[^}]*--sb-on:/g)].map(m => m[1]!.trim());
    expect(sels).toEqual([':root']);
  });
});
