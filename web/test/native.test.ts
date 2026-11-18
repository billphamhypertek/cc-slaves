import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ServerMsg } from '../../shared/protocol.ts';
import { HUD_SELECTORS } from '../src/deck/DeckView.tsx';
import { installBridge, installPresence, notifyArgs } from '../src/lib/native.ts';
import type { TauriGlobal } from '../src/lib/tauri.ts';
import { Store } from '../src/lib/store.ts';
import { snapshot } from './fixtures.ts';

const notify = (mac: boolean): ServerMsg => ({ type: 'event', event: { type: 'notify', kind: 'ask', title: 'D2 hỏi', body: 'Tách?', sound: true, mac, cardId: 7 } });

function fakeTauri() {
  const listeners: Record<string, (e: { payload: unknown }) => void> = {};
  const tauri: TauriGlobal = { event: { listen: async (n, cb) => { listeners[n] = cb as (e: { payload: unknown }) => void; return () => {}; } } };
  const calls: [string, unknown][] = [];
  const tokens = ['tok-2'];
  const invoke = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T | undefined> => {
    calls.push([cmd, args]);
    return (cmd === 'engine_token' ? tokens.shift() ?? null : undefined) as T;
  };
  const events: Event[] = [];
  const win: { dispatchEvent(e: Event): boolean; __CC_RESTART_ENGINE__?: () => void } = { dispatchEvent: e => { events.push(e); return true; } };
  const set: (string | null)[] = [];
  let retries = 0;
  const b = installBridge({ tauri, invoke, win, setToken: t => set.push(t), retryNow: () => { retries++; } });
  return { b, listeners, calls, events, win, set, retries: () => retries };
}
const flush = () => new Promise(r => setTimeout(r, 0));

describe('g3 Tauri bridge (§8.3 notifications, S5 focus fallback, §8.4 window hidden, §7.1 F10 restart)', () => {
  test('§8.3 notify with mac=true → invoke notify {title, body, cardId}; mac=false → nothing', async () => {
    expect(notifyArgs(notify(false))).toBeNull();
    const t = fakeTauri();
    t.b.onMessage(notify(false));
    t.b.onMessage(notify(true));
    await flush();
    expect(t.calls).toEqual([['notify', { title: 'D2 hỏi', body: 'Tách?', cardId: 7 }]]);
  });
  test('§4.15 §4 notify carries its target: projectId + lane (+ cardId) go to the Tauri command', () => {
    const m = notify(true);
    if (m.type === 'event' && m.event.type === 'notify') Object.assign(m.event, { cardId: undefined, projectId: 'p1', lane: 'D11' });
    expect(notifyArgs(m)).toEqual({ title: 'D2 hỏi', body: 'Tách?', cardId: null, projectId: 'p1', lane: 'D11' });
  });

  test('§8.4 window_state visible=false → DOM window-hidden; visible → window-shown', () => {
    const t = fakeTauri();
    t.listeners.window_state!({ payload: { visible: false, focused: false } });
    t.listeners.window_state!({ payload: { visible: true, focused: true } });
    expect(t.events.map(e => e.type)).toEqual(['window-hidden', 'window-shown']);
  });

  test('S5 / §4.15 §4 open_latest_card → ccs:open-card with the whole target { cardId, projectId, lane }', () => {
    const t = fakeTauri();
    t.listeners.open_latest_card!({ payload: { cardId: 12 } });
    t.listeners.open_latest_card!({ payload: { cardId: null, projectId: 'p1', lane: 'D11' } });
    expect(t.events[0]!.type).toBe('ccs:open-card');
    expect((t.events[0] as CustomEvent).detail).toEqual({ cardId: 12, projectId: null, lane: null });
    expect((t.events[1] as CustomEvent).detail).toEqual({ cardId: null, projectId: 'p1', lane: 'D11' });
  });

  test('§7.1 F10 __CC_RESTART_ENGINE__ → engine_restart, then the fresh token, then reconnect now', async () => {
    const t = fakeTauri();
    t.win.__CC_RESTART_ENGINE__!();
    await flush(); await flush(); await flush();
    expect(t.calls.map(c => c[0])).toEqual(['engine_restart', 'engine_token']);
    expect(t.set).toEqual(['tok-2']);
    expect(t.retries()).toBe(1);
  });

  test('§7.1 reconnecting re-reads the token but never forces an immediate retry (backoff kept)', async () => {
    const t = fakeTauri();
    t.b.onReconnecting();
    t.b.onReconnecting(); // in flight → ignored
    await flush(); await flush();
    expect(t.calls.filter(c => c[0] === 'engine_token').length).toBe(1);
    expect(t.set).toEqual(['tok-2']);
    expect(t.retries()).toBe(0);
  });

  test('plain browser (no __TAURI__): bridge is inert', () => {
    const win: { dispatchEvent(e: Event): boolean; __CC_RESTART_ENGINE__?: () => void } = { dispatchEvent: () => true };
    const b = installBridge({ tauri: null, invoke: async () => undefined, win, setToken: () => {}, retryNow: () => {} });
    b.onMessage(notify(true));
    expect(win.__CC_RESTART_ENGINE__).toBeUndefined();
  });
});

describe('g3 seams in the web', () => {
  test('config event replaces snap.config (no snapshot round trip)', () => {
    const s = new Store();
    s.apply({ type: 'snapshot', snapshot: snapshot() });
    s.apply({ type: 'event', event: { type: 'config', config: { noNewLanes: { 'pm@x': true }, laneCaps: { 'pm@x': 2 } } } });
    expect(s.get().snap!.config).toEqual({ noNewLanes: { 'pm@x': true }, laneCaps: { 'pm@x': 2 } });
  });

  test('v1.1 §4 the deck avoids exactly the HUD boxes the UI renders (top bar, v2.1 left column, list, open account panel)', () => {
    const src = (f: string) => readFileSync(resolve(import.meta.dir, '../src', f), 'utf8');
    const ui = ['ui/TopBar.tsx', 'ui/App.tsx', 'ui/ListView.tsx'].map(src).join('\n'), panel = src('deck/AccountPanel.tsx');
    for (const sel of HUD_SELECTORS) {
      if (sel.startsWith('#')) expect(ui).toContain(`id="${sel.slice(1)}"`);
      else expect(panel).toContain(`className="${sel.slice(1).replace('.', ' ')}"`);
    }
  });

  test('§8.4 the deck chunk is lazy: App never imports the deck statically; v2.7 review C IMPORTANT-2 nor the left column', () => {
    const app = readFileSync(resolve(import.meta.dir, '../src/ui/App.tsx'), 'utf8');
    // only the pure click / key map (v1.1 §4.7) may be static; the renderer, model and motion stay in the lazy chunk
    expect(app).not.toMatch(/^import (?!type ).*['"]\.\.\/deck\/(?!actions\.ts)/m);
    expect(app).not.toMatch(/^import (?!type ).*['"]\.\/LeftColumn\.tsx/m);
    expect(app).toContain("const loadDeck = () => Promise.all([import('../deck/DeckView.tsx'), import('./LeftColumn.tsx')]);");
    expect(app).toContain('lazy(() => loadDeck().then(([m]) => ({ default: m.DeckView })))');
    expect(app).toContain('lazy(() => loadDeck().then(([, m]) => ({ default: m.LeftColumn })))');
  });

  test('web uses the engine config keys and the Tauri command names that exist', () => {
    const read = (p: string) => readFileSync(resolve(import.meta.dir, '..', p), 'utf8');
    const ui = ['src/ui/Settings.tsx', 'src/ui/Wizard.tsx', 'src/ui/App.tsx', 'src/ui/appMenus.ts', 'src/lib/tauri.ts', 'src/lib/native.ts'].map(read).join('\n');
    expect(ui).not.toMatch(/patch: \{ (maxLanes|readKeychain):/);
    const rust = read('../src-tauri/build.rs');
    for (const m of ui.matchAll(/invoke(?:<[^>]+>)?\('([a-z_]+)'/g)) expect(rust).toContain(`"${m[1]}"`);
  });
});

describe('§8.3 R10 / §8.1 I5 presence: a hidden window is not "looking"', () => {
  function world(state: 'visible' | 'hidden' = 'visible') {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: state });
    const sent: boolean[] = [];
    const p = installPresence({ win, doc, send: v => sent.push(v) });
    return { win, doc, sent, p };
  }
  test('on (re)open the current state is sent', () => {
    const w = world();
    w.p.onOpen();
    w.p.onOpen();
    expect(w.sent).toEqual([true, true]);
    const h = world('hidden');
    h.p.onOpen();
    expect(h.sent).toEqual([false]);
  });
  test('Tauri window hidden / shown → presence false / true (changes only)', () => {
    const w = world();
    w.win.dispatchEvent(new Event('window-hidden'));
    w.win.dispatchEvent(new Event('window-hidden'));
    w.win.dispatchEvent(new Event('window-shown'));
    expect(w.sent).toEqual([false, true]);
  });
  test('browser tab hidden counts too; shown again only when both say visible', () => {
    const w = world();
    w.doc.visibilityState = 'hidden'; w.doc.dispatchEvent(new Event('visibilitychange'));
    w.win.dispatchEvent(new Event('window-hidden'));
    w.doc.visibilityState = 'visible'; w.doc.dispatchEvent(new Event('visibilitychange'));
    expect(w.sent).toEqual([false]);
    w.win.dispatchEvent(new Event('window-shown'));
    expect(w.sent).toEqual([false, true]);
  });
});
