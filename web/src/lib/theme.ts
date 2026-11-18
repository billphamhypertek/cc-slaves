// v2.8 §5 the one theme source. Mode (Sáng / Tối / Theo macOS) lives in `localStorage` `ccs.theme` on this Mac only (L2; the
// phone never sets it, §4.8). The page always carries an explicit `<html data-theme>`; `/theme-boot.js` sets it before the CSS
// (§5.3) and this module keeps it right afterwards. Inside the Mac app the window theme goes through Tauri `setTheme` (§4.7):
// it also drives WebKit's `prefers-color-scheme`, so "Theo macOS" calls `setTheme(null)` before it reads `matchMedia`. A macOS
// change while the app is open arrives as a `matchMedia` change and, in case WKWebView stays silent, Tauri `onThemeChanged` (§14).
import { useSyncExternalStore } from 'react';
import type { Tr } from '../../../shared/i18n/core.ts';
import type { MenuItem } from './actions.ts';

export type ThemeMode = 'light' | 'dark' | 'system';
export type Look = 'light' | 'dark';
export interface ThemeState { mode: ThemeMode; look: Look }
export const THEME_KEY = 'ccs.theme';

/** §5.1 missing, junk or an unreadable store → light (PO 17/11 21:55: the default is Sáng; Theo macOS is a menu choice). */
export const readMode = (v: string | null): ThemeMode => (v === 'light' || v === 'dark' || v === 'system' ? v : 'light');
export const lookOf = (mode: ThemeMode, systemDark: boolean): Look => (mode === 'system' ? (systemDark ? 'dark' : 'light') : mode);

/** The Tauri window calls the theme needs (`core:window:allow-set-theme`; the theme event rides `core:event:allow-listen`). */
export interface ThemeWindow {
  setTheme(t: Look | null): Promise<void>;
  onThemeChanged(cb: (e: { payload: Look }) => void): Promise<() => void>;
}
export interface ThemeEnv {
  read(): string | null;
  write(v: ThemeMode): void;
  /** `matchMedia('(prefers-color-scheme: dark)')` */
  media: { readonly matches: boolean; addEventListener(type: 'change', f: () => void): void };
  root: { dataset: Record<string, string | undefined> };
  win: ThemeWindow | null;
}
export interface Theme {
  get(): ThemeState;
  subscribe(f: () => void): () => void;
  set(mode: ThemeMode): Promise<void>;
}

export function createTheme(env: ThemeEnv): Theme {
  let mode = readMode(env.read());
  // the system scheme as last seen; while a mode is forced matchMedia reports the forced value, so it is re-read on "system"
  let sysDark = env.media.matches;
  let state: ThemeState = { mode, look: lookOf(mode, sysDark) };
  const subs = new Set<() => void>();
  const apply = () => {
    const look = lookOf(mode, sysDark);
    env.root.dataset.theme = look;
    if (state.mode === mode && state.look === look) return;
    state = { mode, look };
    subs.forEach(f => f());
  };
  const native = async () => { try { await env.win?.setTheme(mode === 'system' ? null : mode); } catch { /* the page switches anyway */ } };
  env.media.addEventListener('change', () => { sysDark = env.media.matches; apply(); });
  const listen = async () => { // no theme event (it may throw before a promise exists): "system" follows matchMedia alone
    try { await env.win?.onThemeChanged(e => { if (mode === 'system') { sysDark = e.payload === 'dark'; apply(); } }); } catch { /* ignored */ }
  };
  void listen();
  apply();
  void native();
  return {
    get: () => state,
    subscribe(f) { subs.add(f); return () => { subs.delete(f); }; },
    async set(m) {
      mode = m;
      env.write(m);
      apply(); // a forced mode shows at once; "system" shows the last known scheme until macOS answers
      await native();
      if (m === 'system' && mode === 'system') { sysDark = env.media.matches; apply(); }
    },
  };
}

let shared: Theme | null = null;
/** main.tsx installs the page's theme once, before the first render. */
export const installTheme = (env: ThemeEnv): Theme => (shared = createTheme(env));
const none: ThemeState = { mode: 'light', look: 'light' };
const subscribe = (f: () => void) => (shared ? shared.subscribe(f) : () => {});
const snapshot = () => shared?.get() ?? none;
export function useTheme(): { state: ThemeState; set: (m: ThemeMode) => void } {
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  return { state, set: m => void shared?.set(m) };
}

/** §4.1 the three radio items: ✓ on the mode; "Theo macOS" says what macOS shows now while it is the mode. */
export function themeItems(tr: Tr, s: ThemeState): (MenuItem & { act: { t: 'theme'; mode: ThemeMode } })[] {
  const row = (mode: ThemeMode, icon: 'sun' | 'moon' | 'monitor', label: string) =>
    ({ id: `theme-${mode}`, label, g: 0, icon, checked: s.mode === mode, act: { t: 'theme' as const, mode } });
  return [
    row('light', 'sun', tr('topbar.themeLight')),
    row('dark', 'moon', tr('topbar.themeDark')),
    { ...row('system', 'monitor', tr('topbar.themeSystem')), ...(s.mode === 'system' ? { note: tr(s.look === 'dark' ? 'topbar.themeNowDark' : 'topbar.themeNowLight') } : {}) },
  ];
}
