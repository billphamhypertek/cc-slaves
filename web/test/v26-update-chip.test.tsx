// v2.6 §4.1–§4.6 (UP1–UP6) in a DOM: the update chip on the top bar follows the Tauri event `update_state` (A1 machine,
// `src-tauri/src/update.rs`), opens its anchored frame, and each button calls its Tauri command (§10.1). R17: losing the
// engine never dims or locks the chip (UP6d). Mac app only: no `__TAURI__` or the remote channel → no chip.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import type { ReactElement } from 'react';
import type { Snapshot } from '../../shared/protocol.ts';
import type { UpdateBusy } from '../../shared/update.ts';
import type { UpdateState } from '../src/ui/UpdateChip.tsx';
import { snapshot } from './fixtures.ts';

// ---------- in a DOM ----------
const G = globalThis as Record<string, unknown>;
const win = new Window({ url: 'http://localhost/', width: 1440, height: 900 });
const WIN = win as unknown as Record<string, unknown>;
const KEYS = [...new Set(['window', 'document', 'navigator', 'location', 'localStorage', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent',
  ...Object.getOwnPropertyNames(win).filter(k => !(k in globalThis) && !k.startsWith('_'))])];
const saved = new Map<string, unknown>();
beforeAll(() => {
  for (const k of [...KEYS, 'IS_REACT_ACT_ENVIRONMENT']) saved.set(k, G[k]);
  for (const k of KEYS) G[k] = k === 'window' ? win : WIN[k];
  G.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(async () => {
  for (const [k, v] of saved) { if (v === undefined) delete G[k]; else G[k] = v; }
  await win.happyDOM.close();
});
let live: (() => Promise<void>) | null = null;
afterEach(async () => { if (live) await live(); live = null; document.body.innerHTML = ''; localStorage.clear(); delete (window as { __TAURI__?: unknown }).__TAURI__; });

/** The Mac app: `invoke` records each command and answers `update_state` with `first`; `listen('update_state')` keeps the callback. */
function stubTauri(first: UpdateState) {
  const calls: string[] = [];
  const urls: string[] = [];
  let push: ((s: UpdateState) => void) | null = null;
  (window as { __TAURI__?: unknown }).__TAURI__ = {
    core: { invoke: (cmd: string, a?: { url?: string }) => { calls.push(cmd); if (cmd === 'open_url') urls.push(a!.url!); return Promise.resolve(cmd === 'update_state' ? first : null); } },
    event: { listen: (name: string, cb: (e: { payload: UpdateState }) => void) => { if (name === 'update_state') push = s => cb({ payload: s }); return Promise.resolve(() => {}); } },
  };
  return { calls, urls, emit: (s: UpdateState) => push!(s) };
}

async function mount(el: () => ReactElement, lang: 'vi' | 'en' = 'vi') {
  const { act, createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { LangProvider } = await import('../src/lib/i18n.tsx');
  if (lang === 'en') await import('../../shared/i18n/en.ts');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = () => root.render(createElement(LangProvider, { lang, children: null }, el()));
  await act(async () => { render(); await new Promise(r => setTimeout(r, 10)); });
  live = () => act(async () => { root.unmount(); host.remove(); });
  const q = <T extends Element = HTMLElement>(s: string) => document.querySelector<T>(s);
  return {
    q, act, rerender: () => act(async () => { render(); await new Promise(r => setTimeout(r, 10)); }),
    click: async (el: Element | null) => { await act(async () => { (el as HTMLElement).click(); await new Promise(r => setTimeout(r, 10)); }); },
    key: async (el: Element | null, key: string) => { await act(async () => { el!.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true }) as unknown as Event); }); },
    push: async (f: () => void) => { await act(async () => { f(); await new Promise(r => setTimeout(r, 10)); }); },
  };
}

const NOW = Date.now();
const busy = (name: string, kind: UpdateBusy['kind'] = 'lane', mins = 12, projectId = 'p1'): UpdateBusy => ({ projectId, kind, name, turnStartedAt: NOW - mins * 60_000 });
/** `b` = the engine's held view (`engine.update`, only while the app holds); nothing mid-turn otherwise. */
const snapWith = (b: UpdateBusy[] = [], held = 0, over: Partial<Snapshot> = {}) => {
  const s = snapshot({ orchestrators: [], ...over });
  return { ...s, engine: { ...s.engine, version: '0.3.0', update: { hold: b.length > 0, since: null, busy: b, held } } };
};
const AVAIL: UpdateState = { state: 'available', version: '0.3.1', notes: '- Một\n- Hai\n\n## Ba\n* Bốn\n5\n6\n7\n8\n9 thừa', current: '0.3.0', dismissed: false };
const chip = () => document.querySelector<HTMLButtonElement>('#top-update, .upc');
const pop = () => document.querySelector<HTMLElement>('.upop');
const btn = (label: string) => [...(pop()?.querySelectorAll('button') ?? [])].find(b => b.textContent?.trim() === label) ?? null;

async function chipFor(s: UpdateState, snap = snapWith(), offline = false, lang: 'vi' | 'en' = 'vi') {
  const t = stubTauri(s);
  const { UpdateChip } = await import('../src/ui/UpdateChip.tsx');
  let cur = { snap, offline };
  const m = await mount(() => <UpdateChip snap={cur.snap} offline={cur.offline} />, lang);
  return { ...t, ...m, set: async (o: Partial<typeof cur>) => { cur = { ...cur, ...o }; await m.rerender(); } };
}

describe('v2.6 §4.1 UP1 the chip: only while there is something to do', () => {
  test('§4.1 idle / checking / dismissed / an automatic check error → no chip at all', async () => {
    for (const s of [{ state: 'idle', checkedAt: null }, { state: 'checking' }, { ...AVAIL, dismissed: true },
      { state: 'error', stage: 'check', reason: 'offline', version: null, badSignature: false }] as UpdateState[]) {
      await chipFor(s);
      expect(chip()).toBeNull();
      await live!(); live = null;
    }
  });
  test('§4.1 every other state: its line, its class, its full title (UP1n shows only the short part)', async () => {
    const rows: [UpdateState, string, string, string][] = [
      [AVAIL, 'Bản mới 0.3.1', 'acc', '0.3.1'],
      [{ state: 'downloading', version: '0.3.1', done: 42, total: 100 }, 'Đang tải 42%', '', '42%'],
      [{ state: 'downloading', version: '0.3.1', done: 0, total: null }, 'Đang tải…', '', ''],
      [{ state: 'waiting', version: '0.3.1', busy: [busy('B3'), busy('D2')], held: 0, since: NOW, installed: false }, 'Chờ 2 lượt xong', 'wait', '2'],
      [{ state: 'waiting', version: '0.3.1', busy: [], held: 0, since: NOW, installed: false }, 'Sắp cài…', 'wait', ''],
      [{ state: 'installing', version: '0.3.1' }, 'Đang cài…', 'ins', ''],
      [{ state: 'relaunching', version: '0.3.1' }, 'Đang cài…', 'ins', ''],
      [{ state: 'installed', version: '0.3.1' }, 'Đã cài 0.3.1 · Khởi động lại', 'acc', '0.3.1'],
      [{ state: 'error', stage: 'download', reason: 'x', version: '0.3.1', badSignature: false }, 'Cập nhật lỗi', 'bad', ''],
    ];
    for (const [s, line, cls, short] of rows) {
      await chipFor(s);
      const c = chip()!;
      expect(c.title).toBe(line);
      expect(c.getAttribute('aria-label')).toBe(line);
      expect(c.querySelector('.upc-t')!.textContent).toBe(line);
      expect(c.querySelector('.upc-n')?.textContent ?? '').toBe(short);
      if (cls) expect(c.classList.contains(cls)).toBe(true);
      await live!(); live = null;
    }
  });
  test('§4.1 installing / relaunching: the chip is not clickable', async () => {
    const t = await chipFor({ state: 'installing', version: '0.3.1' });
    expect(chip()!.disabled).toBe(true);
    await t.click(chip());
    expect(pop()).toBeNull();
  });
  test('§4.1 downloading: a thin bar shows the share done', async () => {
    await chipFor({ state: 'downloading', version: '0.3.1', done: 38, total: 91 });
    expect(chip()!.querySelector<HTMLElement>('.bar')!.style.width).toBe('42%');
  });
  test('§5.1 the chip follows `update_state`: the first value from the command, then every event', async () => {
    const t = await chipFor({ state: 'idle', checkedAt: null });
    expect(t.calls).toContain('update_state');
    expect(chip()).toBeNull();
    await t.push(() => t.emit(AVAIL));
    expect(chip()!.title).toBe('Bản mới 0.3.1');
    await t.push(() => t.emit({ state: 'downloading', version: '0.3.1', done: 10, total: 100 }));
    expect(chip()!.title).toBe('Đang tải 10%');
  });
  test('§6 UP1n: a failed update shows an arrow with a red dot in the narrow form, never the Skills & MCP `bang`', async () => {
    await chipFor({ state: 'error', stage: 'install', reason: 'x', version: '0.3.1', badSignature: false });
    expect(chip()!.querySelector('.rdot')).not.toBeNull();
  });
});

describe('v2.6 §4.2 UP2 the new-version frame', () => {
  test('§4.2 title, "đang dùng", ≤ 8 note lines (markdown marks dropped), GitHub link, the busy impact line, Để sau note', async () => {
    const t = await chipFor(AVAIL, snapWith([busy('D2'), busy('s1', 'orchestrator')]));
    await t.click(chip());
    const p = pop()!;
    expect(p.getAttribute('role')).toBe('dialog');
    expect(p.querySelector('.uh b')!.textContent).toBe('cc-slaves 0.3.1');
    expect(p.querySelector('.uh .cur')!.textContent).toBe('đang dùng 0.3.0');
    expect([...p.querySelectorAll('li')].map(l => l.textContent)).toEqual(['Một', 'Hai', 'Ba', 'Bốn', '5', '6', '7', '8']);
    expect(p.querySelector('.gh')!.textContent).toBe('Xem đầy đủ trên GitHub');
    expect(p.querySelector('.imp')!.textContent).toBe('App sẽ đợi 2 lượt đang chạy xong rồi khởi động lại; tin gửi trong lúc đợi được giữ lại và gửi sau.');
    expect(p.querySelector('.ftc')!.textContent).toBe('Không nhắc lại bản 0.3.1 — vẫn cập nhật được trong Cài\u00a0đặt\u00a0→\u00a0Engine'); // v26-fw M2 one unit, never an orphan "→ Engine"
    expect(chip()!.getAttribute('aria-expanded')).toBe('true');
    expect(chip()!.classList.contains('on')).toBe(true);
  });
  test('§4.2 not held yet (engine.update.busy is empty): the turns running now are counted from the lanes + Điều phối', async () => {
    const s = snapshot();
    const snap = { ...s, lanes: [{ ...s.lanes[0]!, turnStartedAt: NOW }, s.lanes[1]!], engine: { ...s.engine, update: { hold: false, since: null, busy: [], held: 0 } } };
    const t = await chipFor(AVAIL, snap); // the fixture's orchestrator is running
    await t.click(chip());
    expect(pop()!.querySelector('.imp')!.textContent).toBe('App sẽ đợi 2 lượt đang chạy xong rồi khởi động lại; tin gửi trong lúc đợi được giữ lại và gửi sau.');
  });
  test('§4.2 UP2b no turn running: "khởi động lại ngay sau khi tải xong"', async () => {
    const t = await chipFor(AVAIL);
    await t.click(chip());
    expect(pop()!.querySelector('.imp')!.textContent).toBe('App sẽ khởi động lại ngay sau khi tải xong.');
  });
  test('§4.2 Cập nhật → update_start; Để sau → update_dismiss and the frame closes', async () => {
    const t = await chipFor(AVAIL);
    await t.click(chip());
    await t.click(btn('Cập nhật'));
    expect(t.calls).toContain('update_start');
    await t.click(btn('Để sau'));
    expect(t.calls).toContain('update_dismiss');
    expect(pop()).toBeNull();
  });
  test('§4.2 the GitHub link opens the release page in the browser (open_url)', async () => {
    const t = await chipFor(AVAIL);
    await t.click(chip());
    await t.click(pop()!.querySelector('.gh'));
    expect(t.urls).toEqual(['https://github.com/billphamhypertek/cc-slaves/releases/tag/v0.3.1']);
  });
  test('§7.4 the real 0.3.0 notes: the Vietnamese half for ui.lang vi, the English half for en (split on `---`), no `**`', async () => {
    const notes = readFileSync(new URL('../../docs/releases/0.3.0.md', import.meta.url), 'utf8');
    for (const [lang, first, bullet] of [['vi', 'Bản phát hành công khai đầu tiên của cc-slaves.', 'Bản mới'], ['en', 'The first public release of cc-slaves.', 'New 0.3.x']] as const) {
      const t = await chipFor({ ...AVAIL, notes }, snapWith(), false, lang);
      await t.click(chip());
      const li = [...pop()!.querySelectorAll('li')].map(l => l.textContent ?? '');
      expect(li).toHaveLength(6);
      expect(li[0]).toBe(first);
      expect(li[1]).toContain(bullet);
      expect(li.join('\n')).not.toMatch(/\*\*|^-+$|^--/m);
      expect(li.join(' ')).not.toContain(lang === 'vi' ? 'release' : 'phát hành');
      await live!(); live = null;
    }
  });
  test('§4.2 opening moves the focus into the frame; Esc closes it and gives the chip its focus back; a click outside closes it too', async () => {
    const t = await chipFor(AVAIL);
    await t.click(chip());
    expect(document.activeElement).toBe(pop()); // the keyboard lands in the frame
    await t.key(chip(), 'Escape'); // Esc works wherever the focus is

    expect(pop()).toBeNull();
    expect(document.activeElement).toBe(chip());
    await t.click(chip());
    await t.act(async () => { document.body.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }) as unknown as Event); });
    expect(pop()).toBeNull();
  });
  test('§4.1 the frame follows the state; a state with no chip closes it', async () => {
    const t = await chipFor(AVAIL);
    await t.click(chip());
    await t.push(() => t.emit({ ...AVAIL, dismissed: true }));
    expect(pop()).toBeNull();
    await t.push(() => t.emit({ ...AVAIL, version: '0.3.2' })); // a newer release brings the chip back, closed
    expect(chip()!.title).toBe('Bản mới 0.3.2');
    expect(pop()).toBeNull();
  });
});

describe('v2.6 §4.3 UP3 downloading', () => {
  test('§4.3 bar + "Đang tải 42% · 38 / 91 MB" + Huỷ → update_cancel', async () => {
    const MB = 1024 * 1024;
    const t = await chipFor({ state: 'downloading', version: '0.3.1', done: 38 * MB, total: 91 * MB });
    await t.click(chip());
    expect(pop()!.querySelector('.pl span')!.textContent).toBe('Đang tải 42% · 38 / 91 MB');
    expect(pop()!.querySelector<HTMLElement>('.pb i')!.style.width).toBe('42%');
    await t.click(btn('Huỷ'));
    expect(t.calls).toContain('update_cancel');
  });
});

describe('v2.6 §4.4 UP4 waiting', () => {
  const W = (b: UpdateBusy[], held: number, installed = false): UpdateState => ({ state: 'waiting', version: '0.3.1', busy: b, held, since: NOW - 3 * 60_000, installed });
  test('§4.4 title with minutes, one row per busy session (project · Điều phối / lane · minutes), Huỷ chờ, no "update now"', async () => {
    const snap = snapWith([], 0, { projects: [{ id: 'p1', name: 'hagent-os', path: '/w/h', orchestratorAccount: null, gchatWebhookSet: false, gchatSendCommandText: false }] });
    const t = await chipFor(W([busy('B3'), busy('s1', 'orchestrator', 2), busy('wf-1', 'workflow', 4, '_workflow')], 0), snap);
    await t.click(chip());
    const p = pop()!;
    expect(p.querySelector('.uh b')!.textContent).toBe('Đang chờ để cập nhật · 3 phút');
    expect([...p.querySelectorAll('.wr')].map(r => [...r.querySelectorAll('span')].map(s => s.textContent))).toEqual([
      ['hagent-os', 'B3', 'đang chạy 12 phút'], ['hagent-os', 'Điều phối', 'đang chạy 2 phút'], ['Soạn workflow', 'wf-1', 'đang chạy 4 phút']]);
    expect(p.querySelector('.held')).toBeNull();
    expect(p.querySelector('.ftl')).toBeNull();
    expect([...p.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Huỷ chờ']);
    await t.click(btn('Huỷ chờ'));
    expect(t.calls).toContain('update_cancel');
  });
  test('§4.4 UP4b held messages: the count line and the Huỷ chờ note', async () => {
    const t = await chipFor(W([busy('D2')], 3));
    await t.click(chip());
    expect(pop()!.querySelector('.held')!.textContent).toBe('Đang giữ 3 tin — gửi sau khi cập nhật');
    expect(pop()!.querySelector('.ftl')!.textContent).toBe('Huỷ chờ: gửi ngay 3 tin đang giữ, chưa cập\u00a0nhật.'); // v26-fw M1 "cập nhật" never split
  });
  test('§5.4-9 UP4c installed, a self-started turn: "Đã cài 0.3.1, chờ lượt xong để khởi động lại"', async () => {
    const t = await chipFor(W([busy('D2')], 0, true));
    await t.click(chip());
    expect(pop()!.querySelector('.uh b')!.textContent).toBe('Đã cài 0.3.1, chờ lượt xong để khởi động lại');
  });
});

describe('v2.6 §4.4b UP4d installed, not restarted', () => {
  test('§4.4b title + impact + Khởi động lại → update_start; Để sau closes, the chip stays, nothing is called', async () => {
    const t = await chipFor({ state: 'installed', version: '0.3.1' }, snapWith([busy('D2'), busy('D3')]));
    await t.click(chip());
    expect(pop()!.querySelector('.uh b')!.textContent).toBe('Đã cài 0.3.1. Khởi động lại để dùng bản mới.');
    expect(pop()!.querySelector('.imp')!.textContent).toBe('App sẽ đợi 2 lượt đang chạy xong rồi khởi động lại; tin gửi trong lúc đợi được giữ lại và gửi sau.');
    const before = t.calls.length;
    await t.click(btn('Để sau'));
    expect(pop()).toBeNull();
    expect(chip()).not.toBeNull();
    expect(t.calls.length).toBe(before);
    await t.click(chip());
    await t.click(btn('Khởi động lại'));
    expect(t.calls).toContain('update_start');
  });
  test('§4.4b no turn running: "App sẽ khởi động lại ngay."', async () => {
    const t = await chipFor({ state: 'installed', version: '0.3.1' });
    await t.click(chip());
    expect(pop()!.querySelector('.imp')!.textContent).toBe('App sẽ khởi động lại ngay.');
  });
});

describe('v2.6 §4.5 UP5 installing', () => {
  test('§4.5 a full-window veil, no button; gone once the state moves on', async () => {
    const t = await chipFor({ state: 'installing', version: '0.3.1' });
    const v = document.querySelector('.upinst')!;
    expect(v.textContent).toBe('Đang cài cc-slaves 0.3.1… app sẽ tự mở lại');
    expect(v.querySelectorAll('button').length).toBe(0);
    await t.push(() => t.emit({ state: 'relaunching', version: '0.3.1' }));
    expect(document.querySelector('.upinst')).not.toBeNull();
    await t.push(() => t.emit({ state: 'installed', version: '0.3.1' }));
    expect(document.querySelector('.upinst')).toBeNull();
  });
});

describe('v2.6 §4.6 UP6 errors', () => {
  const E = (stage: 'download' | 'install' | 'wait' | 'relaunch', badSignature = false): UpdateState => ({ state: 'error', stage, reason: 'mất mạng', version: '0.3.1', badSignature });
  const order = () => [...pop()!.querySelectorAll('.ft button')].map(b => [b.textContent, b.classList.contains('pri')]);
  test('§6 UP6a download: its sentence; Đóng · Thử lại (primary); Thử lại → update_start; Đóng → update_cancel', async () => {
    const t = await chipFor(E('download'));
    await t.click(chip());
    expect(pop()!.querySelector('.er span')!.textContent).toBe('Tải bản 0.3.1 lỗi: mất mạng. Chưa\u00a0cài\u00a0gì.');
    expect(order()).toEqual([['Đóng', false], ['Thử lại', true]]);
    await t.click(btn('Thử lại'));
    expect(t.calls).toContain('update_start');
    await t.click(btn('Đóng'));
    expect(t.calls).toContain('update_cancel');
  });
  test('§6 UP6b bad signature: no reason shown, a GitHub report link (R19), Đóng is the primary', async () => {
    const t = await chipFor(E('download', true));
    await t.click(chip());
    expect(pop()!.querySelector('.er span')!.textContent).toBe('Gói 0.3.1 không khớp chữ ký nên không cài. Báo lỗi trên GitHub.');
    expect(order()).toEqual([['Thử lại', false], ['Đóng', true]]);
    await t.click(pop()!.querySelector('.er .lnk'));
    expect(t.urls).toEqual(['https://github.com/billphamhypertek/cc-slaves/issues/new']); // R19
  });
  test('§6 UP6c install: names the running version (app = engine number)', async () => {
    const t = await chipFor(E('install'));
    await t.click(chip());
    expect(pop()!.querySelector('.er span')!.textContent).toBe('Cài 0.3.1 lỗi: mất mạng. App 0.3.0 vẫn nguyên.');
  });
  test('§6 UP6d lost engine: Thử lại is locked while offline (with the reason), open again once connected', async () => {
    const t = await chipFor(E('wait'), snapWith(), true);
    await t.click(chip());
    expect(pop()!.querySelector('.er span')!.textContent).toBe('Mất kết nối engine nên đã dừng chờ. Tin đang giữ đã được gửi; chưa cài gì.');
    const retry = btn('Thử lại')!;
    expect(retry.disabled).toBe(true);
    expect(retry.title).toBe('Chờ engine kết nối lại rồi thử lại');
    await t.set({ offline: false });
    expect(btn('Thử lại')!.disabled).toBe(false);
  });
  test('§5.1 relaunch stage: its own sentence', async () => {
    const t = await chipFor(E('relaunch'));
    await t.click(chip());
    expect(pop()!.querySelector('.er span')!.textContent).toBe('Mở lại bản 0.3.1 lỗi: mất mạng.');
  });
});

describe('v2.6 TopBar: where the chip sits, and where it does not', () => {
  async function bar(snap: Snapshot, tauri = true) {
    if (tauri) stubTauri(AVAIL);
    const { TopBar } = await import('../src/ui/TopBar.tsx');
    const f = () => {};
    return mount(() => <TopBar snap={snap} offline={false} projectId="p1" pendingByProject={{}} unread={new Set()} muted={false} listOn={false} onProject={f} onAddProject={f}
      onList={f} onRemote={f} onMute={f} onSettings={f} onSkillsMcp={f} onTabMenu={f} />);
  }
  test('R21 the chip is the element just before "Giao diện"', async () => {
    const m = await bar(snapWith());
    await m.rerender();
    const c = chip()!;
    expect(c.nextElementSibling?.getAttribute('aria-label')).toBe('Giao diện');
    expect(c.parentElement?.id).toBe('top');
  });
  test('§8 the remote channel and a plain browser: no chip', async () => {
    await bar({ ...snapWith(), channel: 'remote' });
    expect(chip()).toBeNull();
    await live!(); live = null;
    delete (window as { __TAURI__?: unknown }).__TAURI__;
    await bar(snapWith(), false);
    expect(chip()).toBeNull();
  });
});

describe('v2.6 §8 UP9 the remote channel: one line of text while the Mac holds, no chip, no button', () => {
  async function bar(snap: Snapshot) {
    const { TopBar } = await import('../src/ui/TopBar.tsx');
    const f = () => {};
    return mount(() => <TopBar snap={snap} offline={false} projectId="p1" pendingByProject={{}} unread={new Set()} muted={false} listOn={false} onProject={f} onAddProject={f}
      onList={f} onRemote={f} onMute={f} onSettings={f} onSkillsMcp={f} onTabMenu={f} />);
  }
  const hold = () => document.querySelector<HTMLElement>('#top .uphold');
  test('UP9 remote + hold → "Mac đang chờ để cập nhật — tin gửi sẽ được giữ", a status, no button, before the list button', async () => {
    await bar({ ...snapWith([busy('D2')], 2), channel: 'remote' });
    const h = hold()!;
    expect(h.textContent).toBe('Mac đang chờ để cập nhật — tin gửi sẽ được giữ');
    expect(h.getAttribute('role')).toBe('status');
    expect(h.tagName).toBe('SPAN');
    expect(h.querySelector('button')).toBeNull();
    expect(h.nextElementSibling?.getAttribute('aria-label')).toBe('Chế độ danh sách');
    expect(chip()).toBeNull();
  });
  test('UP9 no line when the Mac does not hold, nor on the Mac itself (it has the chip)', async () => {
    await bar({ ...snapWith(), channel: 'remote' });
    expect(hold()).toBeNull();
    await live!(); live = null;
    await bar(snapWith([busy('D2')], 2));
    expect(hold()).toBeNull();
  });
});

describe('v2.6 §4.7 UP7 / UP7r the "Cập nhật" row of Settings → Engine', () => {
  const T = new Date(2026, 10, 18, 14, 5).getTime();
  async function rowFor(s: UpdateState, snap = snapWith(), lang: 'vi' | 'en' = 'vi') {
    const t = stubTauri(s);
    const { UpdateRow } = await import('../src/ui/UpdateChip.tsx');
    const m = await mount(() => <UpdateRow snap={snap} />, lang);
    return { ...t, ...m };
  }
  const row = () => document.querySelector<HTMLElement>('.uprow')!;
  const text = () => row().querySelector('.upr-t')!.textContent;
  const rbtn = () => row().querySelector<HTMLButtonElement>('button');
  test('UP7a idle → "Đã là bản mới nhất · kiểm tra lúc HH:MM" + Kiểm tra cập nhật → update_check', async () => {
    const r = await rowFor({ state: 'idle', checkedAt: T });
    expect(text()).toBe('Đã là bản mới nhất · kiểm tra lúc 14:05');
    expect(rbtn()!.textContent).toBe('Kiểm tra cập nhật');
    await r.click(rbtn());
    expect(r.calls).toContain('update_check');
  });
  test('UP7 never checked yet (the first check runs 10 s after start) → "Chưa kiểm tra" + the button', async () => {
    await rowFor({ state: 'idle', checkedAt: null });
    expect(text()).toBe('Chưa kiểm tra');
    expect(rbtn()!.disabled).toBe(false);
  });
  test('UP7b checking → "Đang kiểm tra…", the button locked', async () => {
    await rowFor({ state: 'checking' });
    expect(text()).toBe('Đang kiểm tra…');
    expect(rbtn()!.disabled).toBe(true);
  });
  test('UP7c a check error (by hand or automatic) shows only here: "Không kiểm tra được: <lý do>", red, the button again', async () => {
    await rowFor({ state: 'error', stage: 'check', reason: 'không có mạng', version: null, badSignature: false });
    expect(text()).toBe('Không kiểm tra được: không có mạng');
    expect(row().querySelector('.upr-t')!.className).toContain('bad');
    expect(rbtn()!.textContent).toBe('Kiểm tra cập nhật');
  });
  test('UP7r available, even after "Để sau" → "Có bản 0.3.1" + Cập nhật → update_start', async () => {
    const r = await rowFor({ ...AVAIL, dismissed: true });
    expect(text()).toBe('Có bản 0.3.1');
    expect(rbtn()!.textContent).toBe('Cập nhật');
    await r.click(rbtn());
    expect(r.calls).toContain('update_start');
  });
  test('UP7r downloading / waiting / installing → the chip line, no button', async () => {
    for (const [s, want] of [[{ state: 'downloading', version: '0.3.1', done: 42, total: 100 }, 'Đang tải 42%'],
      [{ state: 'waiting', version: '0.3.1', busy: [busy('D2'), busy('s1', 'orchestrator')], held: 0, since: NOW, installed: false }, 'Chờ 2 lượt xong'],
      [{ state: 'installing', version: '0.3.1' }, 'Đang cài…']] as [UpdateState, string][]) {
      await rowFor(s);
      expect(text()).toBe(want);
      expect(rbtn()).toBeNull();
      await live!(); live = null;
    }
  });
  test('UP7r installed → "Đã cài 0.3.1" + Khởi động lại → update_start', async () => {
    const r = await rowFor({ state: 'installed', version: '0.3.1' });
    expect(text()).toBe('Đã cài 0.3.1');
    expect(rbtn()!.textContent).toBe('Khởi động lại');
    await r.click(rbtn());
    expect(r.calls).toContain('update_start');
  });
  test('UP7r a download / install error → the frame sentence (UP6), red, no button', async () => {
    await rowFor({ state: 'error', stage: 'download', reason: 'mất kết nối giữa chừng', version: '0.3.1', badSignature: false });
    expect(text()).toBe('Tải bản 0.3.1 lỗi: mất kết nối giữa chừng. Chưa\u00a0cài\u00a0gì.');
    expect(row().querySelector('.upr-t')!.className).toContain('bad');
    expect(rbtn()).toBeNull();
  });
  test('§5.6 the first run of a new version → "Đã cập nhật lên 0.3.1 lúc HH:MM" (its start), green, + Kiểm tra cập nhật', async () => {
    localStorage.setItem('ccs.update.seen', JSON.stringify({ v: '0.3.0', at: 1, from: null }));
    const s = snapWith(), at = new Date(2026, 10, 18, 14, 12).getTime();
    const snap = { ...s, engine: { ...s.engine, version: '0.3.1', startedAt: at } };
    await rowFor({ state: 'idle', checkedAt: T }, snap);
    expect(text()).toBe('Đã cập nhật lên 0.3.1 lúc 14:12');
    expect(row().querySelector('.upr-t')!.className).toContain('ok');
    expect(rbtn()!.textContent).toBe('Kiểm tra cập nhật');
    await live!(); live = null;
    // the next start of the same version: the plain line again
    await rowFor({ state: 'idle', checkedAt: T }, { ...snap, engine: { ...snap.engine, startedAt: at + 3_600_000 } });
    expect(text()).toBe('Đã là bản mới nhất · kiểm tra lúc 14:05');
  });
  test('§5.6 the very first run (nothing seen before) is not an update', async () => {
    await rowFor({ state: 'idle', checkedAt: T });
    expect(text()).toBe('Đã là bản mới nhất · kiểm tra lúc 14:05');
  });
  test('§5.6 the chip notes the version at start, so the line holds even when Settings opens later', async () => {
    localStorage.setItem('ccs.update.seen', JSON.stringify({ v: '0.3.0', at: 1, from: null }));
    const s = snapWith();
    await chipFor({ state: 'idle', checkedAt: T }, { ...s, engine: { ...s.engine, version: '0.3.1', startedAt: 77 } });
    expect(JSON.parse(localStorage.getItem('ccs.update.seen')!)).toEqual({ v: '0.3.1', at: 77, from: '0.3.0' });
  });
  test('UP7 Settings → Engine: "Cập nhật" right under "Phiên bản" in the Mac app, absent elsewhere', async () => {
    const { Settings } = await import('../src/ui/Settings.tsx');
    const f = () => {};
    const props = { snap: snapWith(), pid: null, tab: 'engine', connected: true, now: NOW, onTab: f, onClose: f, send: async () => ({ cleanupPeriodDays: 30 }), onCfg: f,
      onAddProject: f, onSetup: f, onAccDlg: f, onAccMenu: f, toast: f } as unknown as Parameters<typeof Settings>[0];
    stubTauri({ state: 'idle', checkedAt: T });
    const m = await mount(() => <Settings {...props} />);
    await m.rerender();
    const labels = [...document.querySelectorAll('.set .form > .foot')].map(e => e.textContent);
    expect(labels.slice(0, 3)).toEqual(['Trạng thái', 'Phiên bản', 'Cập nhật']);
    expect(document.querySelector('.set .form .uprow .upr-t')!.textContent).toBe('Đã là bản mới nhất · kiểm tra lúc 14:05');
    await live!(); live = null;
    delete (window as { __TAURI__?: unknown }).__TAURI__;
    await mount(() => <Settings {...props} />);
    expect([...document.querySelectorAll('.set .form > .foot')].map(e => e.textContent)).not.toContain('Cập nhật');
  });
  test('en: the row strings', async () => {
    await rowFor({ state: 'idle', checkedAt: T }, snapWith(), 'en');
    expect(text()).toBe('Up to date · checked at 14:05');
    expect(rbtn()!.textContent).toBe('Check for updates');
  });
});

describe('v2.6 R17 losing the engine never dims or locks the update chip', () => {
  const css = readFileSync('web/src/styles.css', 'utf8');
  test('R17 no `.offline #top{…}` rule (a parent opacity cannot be undone by the chip): the siblings carry it', () => {
    expect(css).not.toMatch(/\.offline #top\{/);
    expect(css).toMatch(/\.offline #top>:not\(\.upc\)\{opacity:\.55;filter:saturate\(\.4\)\}/);
  });
  test('R17 the click lock skips the chip', () => {
    expect(css).not.toMatch(/\.offline #top button\{pointer-events:none\}/);
    expect(css).toMatch(/\.offline #top button:not\(\.upc\)\{pointer-events:none\}/);
  });
  test('§6 UP1n ≤ 1100 px: only the short part of the chip', () => {
    const u = readFileSync('web/src/ui/update.css', 'utf8');
    expect(u).toMatch(/@media \(max-width:1100px\)\{[^}]*\.upc \.upc-t\{display:none\}/);
  });
});

describe('v2.6 English', () => {
  test('en: chip plural, frame strings', async () => {
    const t = await chipFor({ state: 'waiting', version: '0.3.1', busy: [busy('D2')], held: 2, since: NOW, installed: false }, snapWith(), false, 'en');
    expect(chip()!.title).toBe('1 turn to finish');
    await t.click(chip());
    expect(pop()!.querySelector('.held')!.textContent).toBe('Holding 2 messages — sent after the update');
    expect(btn('Stop waiting')).not.toBeNull();
  });
});
