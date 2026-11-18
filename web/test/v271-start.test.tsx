// v2.7.1 G2a §4.1 the session start dialog (SA1, SA2, SA5, SA9, SA9b, Enter / Esc) and the step list (SA3 / SA4): the pure
// rows / steps of lib/start.ts, then the dialog in a real DOM (happy-dom) with a scripted `send`.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { makeT } from '../../shared/i18n/index.ts';
import type { AccountView, Command, OrchestratorView, SessionModels } from '../../shared/protocol.ts';
import { accRows, autoText, fillRun, startSteps, trackRun, whyNot, type StartReq, type StartRun } from '../src/lib/start.ts';
import { account } from './fixtures.ts';

const tr = makeT('vi');
const at = (h: number, m: number, d: number) => new Date(2026, 10, d, h, m).getTime();
const W = (o: Partial<NonNullable<AccountView['fullWhy']>>): AccountView['fullWhy'] =>
  ({ window: 'week', by: 'cap', usedPct: 73, cap: 70, leaveAt: 69, hard: true, resetsAt: at(5, 59, 18), ...o });
const ACCS: AccountView[] = [
  account('bo@example.org', { headroomPct: 51 }),
  account('pm@example.net', { headroomPct: 31 }),
  account('low@example.com', { headroomPct: 6 }),
  account('kt@example.net', { headroomPct: 1, admitBlock: { usedPct: 68, admitMax: 67, cap: 70, leaveAt: 69 } }),
  account('ba@example.net', { full: true, headroomPct: 0, fullWhy: W({}) }),
  account('acc31@example.net', { full: true, headroomPct: 0, fullWhy: W({ window: 'five', usedPct: 96, cap: 95, hard: false, leaveAt: 95, resetsAt: at(13, 20, 17) }) }),
  account('ultra@example.net', { full: true, headroomPct: 0, fiveWindow: false, fivePct: null, fullWhy: W({ by: 'anthropic', usedPct: null }) }),
  account('acc19@example.net', { loggedOut: true, login: 'out', headroomPct: null }),
];
const orch = (sessionId: string, over: Partial<OrchestratorView> = {}): OrchestratorView => ({
  projectId: 'p1', state: 'running', account: 'bo@example.org', homeAccount: null, lastError: null, costUsd: 0, contextPct: null,
  talkingTo: null, sessionId, seq: 1, title: null, ...over,
});
const OS = [orch('s1')];
const label = (o: Pick<OrchestratorView, 'seq'>) => `#${o.seq}`; // sessionLabel without a title

describe('§4.1 SA2 the account rows (§4.5 copy, L3, L13, D103)', () => {
  const rows = accRows(tr, ACCS, OS, a => (a.headroomPct ?? 100) < 10, label);
  const row = (e: string) => rows.find(r => r.email === e)!;
  test('a usable account: "email — còn N %", busy → "đang chạy Điều phối #1", low → "sắp hết"', () => {
    expect(row('pm@example.net')).toEqual({ email: 'pm@example.net', main: 'pm@example.net — còn 31 %', side: null, why: null, ok: true });
    expect(row('bo@example.org').side).toBe('đang chạy Điều phối #1');
    expect(row('low@example.com').side).toBe('sắp hết');
  });
  test('L13 the admit band is listed, not pickable, with its reason', () => {
    expect(row('kt@example.net')).toMatchObject({ main: 'kt@example.net — còn 1 %', ok: false, why: 'không nhận việc mới: tuần 68 % > 67 % (ngưỡng cứng 70 %)' });
  });
  test('full (hard week, 5-hour on Max), signed out: "— Đầy" / "— đăng xuất" + the reason and the reopen time', () => {
    expect(row('ba@example.net')).toMatchObject({ main: 'ba@example.net — Đầy', ok: false, why: 'tuần đã dùng 73 % (ngưỡng cứng 70 %, dừng ở 69 %) · mở lại 05:59 18/11' });
    expect(row('acc31@example.net').why).toBe('5 giờ đã dùng 96 % (ngưỡng 95 %) · mở lại 13:20 17/11');
    expect(row('acc19@example.net')).toMatchObject({ main: 'acc19@example.net — đăng xuất', ok: false, why: 'đăng nhập lại ở bảng Account' });
  });
  test('the pickable rows come first, the greyed ones under them, each group in engine order', () => {
    const mixed = accRows(tr, [ACCS[4]!, ACCS[1]!, ACCS[7]!, ACCS[0]!], [], () => false, label);
    expect(mixed.map(r => r.email)).toEqual(['pm@example.net', 'bo@example.org', 'ba@example.net', 'acc19@example.net']);
  });
  test('D103 an Ultra account never says "5 giờ"', () => {
    expect(row('ultra@example.net').why).toBe('Anthropic báo hết lượt tuần · mở lại 05:59 18/11');
    expect(JSON.stringify(row('ultra@example.net'))).not.toContain('5 giờ');
  });
  test('a passed reset (no new numbers yet) and needs a test run are not pickable', () => {
    expect(whyNot(tr, account('x@y', { pastReset: { window: 'week', at: at(8, 0, 17), recheckAt: at(8, 4, 17) } }))).toBe('tuần đã reset 08:00 17/11 · đang hỏi lại ≈ 08:04');
    expect(whyNot(tr, account('x@y', { status: 'needs_probe' }))).toBe('cần chạy thử ở bảng Account trước khi nhận việc');
    expect(whyNot(tr, account('x@y'))).toBeNull();
  });
  test('SA1 / SA5 / SA9 the "Tự chọn" text', () => {
    expect(autoText(tr, { st: 'ok', email: 'pm@example.net', pct: 31.4 })).toBe('Tự chọn · sẽ dùng pm@example.net — còn 31 %');
    expect(autoText(tr, { st: 'loading' })).toBe('Tự chọn · đang xem account nào…');
    expect(autoText(tr, { st: 'none', earliest: null })).toBe('Tự chọn · không account nào còn dùng được');
    expect(autoText(tr, { st: 'error' })).toBe('Tự chọn');
  });
});

describe('§4.1 SA3 / SA4 the steps', () => {
  const R: StartRun = { t0: 1000, sid: null, seenAt: null, bootAt: null, ackAt: null, deckAt: null, err: null, bootErr: null,
    account: 'pm@example.net', auto: true, pct: 31, model: 'Opus 5.5 · medium' };
  const sts = (r: StartRun, now = 5000) => startSteps(tr, r, now).map(s => s.st);
  test('the session shows → ✓ 1; it leaves starting → ✓ 2; the ack → ✓ 3; the Deck → ✓ 4', () => {
    expect(sts(R)).toEqual(['run', 'wait', 'wait', 'wait']);
    const seen = trackRun(R, [orch('s1'), orch('s9', { state: 'starting', account: 'pm@example.net' })], new Set(['s1']), 1100, () => null, () => null);
    expect(seen.seenAt).toBe(1100);
    expect(sts(seen)).toEqual(['ok', 'run', 'wait', 'wait']);
    const s = startSteps(tr, seen, 5100);
    expect(s[0]).toMatchObject({ label: 'Chọn account: pm@example.net', note: 'tự chọn — còn 31 %', ms: 100 });
    expect(s[1]).toMatchObject({ label: 'Khởi động Claude · Opus 5.5 · medium', note: 'thường mất 3–8 giây', ms: 4000 });
    expect(startSteps(tr, seen, 1100 + 31_000)[1]!.note).toBe('Claude chưa trả lời sau 30 giây — vẫn đang chờ');
    const booted = trackRun({ ...seen, sid: 's9', ackAt: 1200 }, [orch('s9', { state: 'running' })], new Set(['s1']), 4100, () => null, () => null);
    expect(sts(booted)).toEqual(['ok', 'ok', 'ok', 'run']);
    expect(sts({ ...booted, deckAt: 4200 })).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(startSteps(tr, R, 1100)[0]!.ms).toBe(100);
    expect(startSteps(tr, R, 1100).map(s => s.label)).toEqual(['Chọn account: pm@example.net', 'Khởi động Claude · Opus 5.5 · medium', 'Gửi tin đầu cho phiên', 'Chuyển sang Deck, chọn phiên']);
  });
  test('a refusal before any session → ✗ on step 1 with the engine reason; a stop while booting → ✗ on step 2', () => {
    const bad = startSteps(tr, { ...R, account: 'ba@example.net', auto: false, err: { text: 'ba@ đầy', fix: 'account' } }, 2000);
    expect(bad.map(s => s.st)).toEqual(['bad', 'wait', 'wait', 'wait']);
    expect(bad[0]!.note).toBe('ba@ đầy');
    const stop = trackRun({ ...R, seenAt: 1100 }, [orch('s9', { state: 'stopped', account: 'pm@example.net' })], new Set(), 3000, () => 'claude thoát', () => null);
    expect(stop.bootErr).toBe('claude thoát');
    expect(startSteps(tr, stop, 3000).map(s => [s.st, s.note])).toEqual([['ok', 'tự chọn — còn 31 %'], ['bad', 'claude thoát'], ['wait', null], ['wait', null]]);
  });
  test('the session view fills step 2\'s model when the dialog did not know it (the main part)', () => {
    const r = trackRun({ ...R, model: null }, [orch('s9', { state: 'starting', modelName: 'Opus 5.5', effort: 'high' })], new Set(), 1100, () => null, () => null);
    expect(r.model).toBe('Opus 5.5 · high');
  });
  test('UX MINOR-1 the main part: step 1 takes "còn N %" from the account the session runs on (Tự chọn only)', () => {
    const pct = (e: string) => (e === 'pm@example.net' ? 31 : e === 'bo@example.org' ? 51 : null);
    const r0: StartRun = { ...R, account: null, pct: null, model: null };
    const seen = trackRun(r0, [orch('s9', { state: 'starting', account: 'pm@example.net' })], new Set(), 1100, () => null, pct);
    expect(startSteps(tr, seen, 1200)[0]).toMatchObject({ label: 'Chọn account: pm@example.net', note: 'tự chọn — còn 31 %' });
    // the engine ran it elsewhere than session_pick said: the % follows the account
    const moved = trackRun({ ...seen, seenAt: 1100 }, [orch('s9', { state: 'starting', account: 'bo@example.org' })], new Set(), 1300, () => null, pct);
    expect([moved.account, moved.pct]).toEqual(['bo@example.org', 51]);
    // a hand pick never shows a %
    const mine = trackRun({ ...r0, auto: false, account: 'pm@example.net' }, [orch('s9', { state: 'starting', account: 'pm@example.net' })], new Set(), 1100, () => null, pct);
    expect(mine.pct).toBeNull();
  });
  test('UX MINOR-1 fillRun: what the dialog learns after the click (session_pick, the model list) fills only the gaps', () => {
    const r0: StartRun = { ...R, account: null, pct: null, model: null };
    const f = fillRun(r0, { account: 'pm@example.net', auto: true, pct: 31, model: 'Opus 5.5 · medium' });
    expect([f.account, f.pct, f.model]).toEqual(['pm@example.net', 31, 'Opus 5.5 · medium']);
    expect(fillRun(R, { account: 'x@y', auto: true, pct: 9, model: 'Sonnet 5.5' })).toBe(R); // known values stay
    expect(fillRun({ ...r0, account: 'bo@example.org' }, { account: 'pm@example.net', auto: true, pct: 31, model: null }).pct).toBeNull(); // another account's %
  });
});

// ---------- the dialog in a DOM ----------
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

const MODELS: SessionModels = { models: [{ value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', effortLevels: ['low', 'medium', 'high'] }],
  defaultModel: 'opus', defaultModelName: 'Opus 5.5', defaultEffort: 'medium' };
let live: (() => Promise<void>) | null = null;
afterEach(async () => { if (live) await live(); live = null; document.body.innerHTML = ''; });
interface Defer { resolve: (v: unknown) => void; reject: (e: unknown) => void }
async function mount(o: { req?: Partial<StartReq>; pick?: 'hold' | Record<string, unknown>; offline?: boolean } = {}) {
  const { act, createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { LangProvider } = await import('../src/lib/i18n.tsx');
  const { SessionDialogs } = await import('../src/ui/SessionDialogs.tsx');
  const sent: Command[] = [], loud: Command[] = [], waits: Defer[] = [];
  const sendQuiet = (c: Command) => {
    sent.push(c);
    if (c.cmd === 'session_pick') return o.pick === 'hold' ? new Promise(() => {}) : Promise.resolve(o.pick ?? { account: 'pm@example.net', headroomPct: 31, earliest: null });
    return new Promise((resolve, reject) => { waits.push({ resolve, reject }); });
  };
  const send = (c: Command) => { loud.push(c); return sendQuiet(c); }; // the App's send: a refusal also raises a toast
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const calls = { closed: 0, accounts: 0, opened: [] as string[] };
  const req: StartReq = { projectId: 'p1', kind: 'build', path: 'docs/specs/v2.6.md', spec: 'v2.6 Updater', opened: sid => calls.opened.push(sid), ...o.req };
  let os = OS, offline = !!o.offline, accounts = ACCS;
  const render = () => root.render(createElement(LangProvider, { lang: 'vi', children: null }, createElement(SessionDialogs, {
    dlg: { k: 'start', req }, os, list: null, projectName: 'hagenta', accounts, lanes: [], cards: [], offline, now: 0, prevSid: null,
    send, sendQuiet, loadPreview: async () => null, loadModels: async () => MODELS, onStarted: () => {}, onClose: () => { calls.closed++; }, onAccounts: () => { calls.accounts++; },
  })));
  await act(async () => { render(); await new Promise(r => setTimeout(r, 10)); });
  const q = <T extends Element = HTMLElement>(s: string) => document.querySelector<T>(s);
  const text = (s: string) => q(s)?.textContent ?? '';
  const flush = (ms = 10) => act(async () => { await new Promise(r => setTimeout(r, ms)); });
  const unmount = () => act(async () => { root.unmount(); host.remove(); });
  live = unmount;
  return {
    host, sent, loud, waits, calls, q, text, flush,
    set: async (p: { os?: OrchestratorView[]; offline?: boolean; accounts?: AccountView[] }) => {
      if (p.os) os = p.os; if (p.offline !== undefined) offline = p.offline; if (p.accounts) accounts = p.accounts; await act(async () => { render(); });
    },
    click: async (el: Element | null) => { await act(async () => { (el as HTMLElement).click(); await new Promise(r => setTimeout(r, 10)); }); },
    key: async (el: Element | null, key: string) => { await act(async () => { el!.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true }) as unknown as Event); await new Promise(r => setTimeout(r, 10)); }); },
    unmount: async () => { await unmount(); live = null; },
  };
}
const main = () => document.querySelector<HTMLButtonElement>('.sdlg .mf .btn.pri')!;
/** the foot's parts: the left text, then each button */
const foot = () => [...document.querySelectorAll('.sdlg .mf > *')].map(e => e.textContent);

describe('§4.1 the start dialog (DOM)', () => {
  test('SA1 title, lead with the path as code, "Tự chọn · sẽ dùng <email> — còn N %", Model · Effort defaults, note, foot; focus on the main button', async () => {
    const m = await mount();
    expect(m.text('.sdlg h2')).toBe('Bắt đầu build · v2.6 Updater');
    expect(m.q('.sdlg .lead code')?.textContent).toBe('docs/specs/v2.6.md');
    expect(m.text('.sdlg .lead')).toBe('Mở phiên Build cho docs/specs/v2.6.md, rồi chuyển sang Deck.');
    expect(m.text('.apick')).toBe('Tự chọn · sẽ dùng pm@example.net — còn 31 %');
    expect(m.q('.apick b')?.textContent).toBe('pm@example.net');
    expect(m.text('.sfield.acc .hint')).toBe('Tự chọn = theo luật Điều phối');
    expect(m.text('.mpick')).toBe('Theo mặc định (Opus 5.5)');
    expect(m.q('.mpick svg')).not.toBeNull(); // G2c the app's chevron ("Tài liệu ⌄"), not a small ▾
    expect(m.q<HTMLSelectElement>('.mpicks select')!.options[0]!.textContent).toBe('Theo mặc định (medium)');
    expect(foot()).toEqual(['Enter bắt đầu · Esc huỷ', 'Huỷ', 'Bắt đầu build']);
    expect(m.text('.sdlg .note')).toContain('Chỉ áp cho phiên này.');
    expect(document.activeElement).toBe(main());
    expect(m.sent.find(c => c.cmd === 'session_pick')).toEqual({ cmd: 'session_pick', projectId: 'p1', kind: 'build' });
    expect(m.text('.sdlg')).not.toContain('5 giờ');
    await m.unmount();
  });
  test('SA5 while session_pick runs: "◌ Tự chọn · đang xem account nào…", the main button stays on', async () => {
    const m = await mount({ pick: 'hold' });
    expect(m.text('.apick')).toBe('Tự chọn · đang xem account nào…');
    expect(m.q('.apick .spin')).not.toBeNull();
    expect(main().disabled).toBe(false);
    await m.unmount();
  });
  test('SA2 the list: Tự chọn ✓ first, every account; the band / full / signed-out rows are greyed with the reason and do nothing', async () => {
    const m = await mount();
    await m.click(m.q('.apick'));
    const opts = [...document.querySelectorAll<HTMLButtonElement>('.apop .arow')];
    expect(opts.length).toBe(1 + ACCS.length);
    expect(opts[0]!.getAttribute('aria-selected')).toBe('true');
    const kt = opts.find(o => o.textContent.startsWith('kt@'))!;
    expect(kt.getAttribute('aria-disabled')).toBe('true');
    expect(kt.querySelector('small')?.textContent).toBe('không nhận việc mới: tuần 68 % > 67 % (ngưỡng cứng 70 %)');
    await m.click(kt);
    expect(m.q('.apop')).not.toBeNull(); // still open, nothing picked
    expect(m.text('.apick')).toContain('Tự chọn');
    await m.click(opts.find(o => o.textContent.startsWith('pm@'))!);
    expect(m.q('.apop')).toBeNull();
    expect(m.text('.apick')).toBe('pm@example.net — còn 31 %');
    await m.unmount();
  });
  test('Esc with the list open closes only the list (the window Esc never sees it)', async () => {
    const m = await mount();
    let seen = 0;
    const f = () => { seen++; };
    document.addEventListener('keydown', f);
    await m.click(m.q('.apick'));
    await m.key(m.q('.apop .arow'), 'Escape');
    expect(m.q('.apop')).toBeNull();
    expect(seen).toBe(0);
    expect(m.calls.closed).toBe(0);
    document.removeEventListener('keydown', f);
    await m.unmount();
  });
  test('Enter starts with the choices: spec_build carries account + model + effort; the dialog turns into the step list at once', async () => {
    const m = await mount();
    await m.click(m.q('.apick'));
    await m.click([...document.querySelectorAll('.apop .arow')].find(o => o.textContent.startsWith('pm@'))!);
    await m.click(m.q('.mpick'));
    await m.click([...document.querySelectorAll('.mlist .mrow')].find(o => o.textContent.startsWith('Opus 5.5'))!);
    const sel = m.q<HTMLSelectElement>('.mpicks select')!;
    const { act } = await import('react');
    await act(async () => { sel.value = 'high'; sel.dispatchEvent(new win.Event('change', { bubbles: true }) as unknown as Event); });
    await m.key(m.q('.sdlg .lead'), 'Enter');
    expect(m.sent.at(-1)).toEqual({ cmd: 'spec_build', projectId: 'p1', path: 'docs/specs/v2.6.md', account: 'pm@example.net', model: 'opus', effort: 'high' });
    expect(m.text('.sdlg h2')).toBe('Đang mở phiên Build · v2.6 Updater');
    expect([...document.querySelectorAll('.sst')].map(e => e.className)).toEqual(['sst st-run', 'sst st-wait', 'sst st-wait', 'sst st-wait']);
    expect(m.text('.sst b')).toBe('Chọn account: pm@example.net');
    expect(m.text('.sst small')).toBe('anh chọn');
    // steps tick from the snapshot, then the ack; step 4 hands the session to the Deck
    await m.set({ os: [...OS, orch('s9', { state: 'starting', account: 'pm@example.net', seq: 2 })] });
    expect([...document.querySelectorAll('.sst')].map(e => e.className)).toEqual(['sst st-ok', 'sst st-run', 'sst st-wait', 'sst st-wait']);
    expect(m.text('.sst:nth-child(2) b')).toBe('Khởi động Claude · Opus 5.5 · high');
    await m.set({ os: [...OS, orch('s9', { state: 'running', account: 'pm@example.net', seq: 2 })] });
    m.waits.at(-1)!.resolve({ sessionId: 's9' });
    await m.flush();
    expect([...document.querySelectorAll('.sst')].map(e => e.className.replace('sst ', ''))).toEqual(['st-ok', 'st-ok', 'st-ok', 'st-ok']);
    await m.flush(500);
    expect(m.calls.opened).toEqual(['s9']);
    await m.unmount();
  });
  test('SA9 no usable account: the field says so, the warning names the earliest, the main button is off with the reason', async () => {
    const m = await mount({ pick: { account: null, headroomPct: null, earliest: { email: 'bo@example.org', at: at(13, 20, 17) } } });
    expect(m.text('.apick')).toBe('Tự chọn · không account nào còn dùng được');
    expect(m.text('.note.alert')).toBe('Mọi account đã đăng nhập đều đầy, không nhận việc mới hoặc đăng xuất. Sớm nhất: bo@example.org mở lại 13:20 17/11. Mở danh sách để xem lý do từng account.');
    expect(m.q('.note.alert b')?.textContent).toBe('bo@example.org');
    expect(main().disabled).toBe(true);
    expect(m.text('.mf .fl')).toBe('Chưa bắt đầu được: không account nào còn');
    await m.key(m.q('.sdlg .lead'), 'Enter');
    expect(m.sent.some(c => c.cmd === 'spec_build')).toBe(false);
    await m.unmount();
  });
  test('SA9b engine offline: choices kept, the main button off, the warning and the foot say so; back online → on, session_pick asked again', async () => {
    const m = await mount();
    await m.click(m.q('.apick'));
    await m.click([...document.querySelectorAll('.apop .arow')].find(o => o.textContent.startsWith('pm@'))!);
    await m.set({ offline: true });
    expect(m.text('.apick')).toBe('pm@example.net — còn 31 %');
    expect(main().disabled).toBe(true);
    expect(m.text('.note.alert')).toBe('Mất kết nối với engine — đang nối lại. Lựa chọn của anh vẫn giữ; nối lại xong là bắt đầu được.');
    expect(m.text('.mf .fl')).toBe('Mất kết nối với engine');
    const asked = m.sent.filter(c => c.cmd === 'session_pick').length;
    await m.set({ offline: false });
    await m.flush();
    expect(main().disabled).toBe(false);
    expect(m.sent.filter(c => c.cmd === 'session_pick').length).toBe(asked + 1);
    await m.unmount();
  });
  test('SA4 an account refusal: ✗ on step 1 with the reason, "Chọn account khác" → the choice again with the list open', async () => {
    const { CommandError } = await import('../src/lib/ws.ts');
    const m = await mount();
    await m.click(main());
    m.waits.at(-1)!.reject(new CommandError('account_unusable', 'x', 'errors.startFullWeekHard', { email: 'ba@example.net', used: 73, cap: 70, leave: 69, at: '05:59 18/11' }));
    await m.flush();
    expect(m.text('.sdlg h2')).toBe('Chưa mở được phiên Build · v2.6 Updater');
    expect(m.text('.sdlg .lead')).toBe('Không có phiên nào được tạo. Chọn account khác rồi thử lại.');
    expect(m.q('.sst')?.className).toBe('sst st-bad');
    expect(m.text('.sst small')).toBe('ba@example.net đầy: tuần đã dùng 73 % (ngưỡng cứng 70 %, dừng ở 69 %) · mở lại 05:59 18/11');
    expect(foot()).toEqual(['Đóng', 'Chọn account khác']);
    await m.click(main());
    expect(m.text('.sdlg h2')).toBe('Bắt đầu build · v2.6 Updater');
    expect(m.q('.apop')).not.toBeNull();
    await m.unmount();
  });
  test('UX MINOR-1 the main part says the defaults: "tự chọn — còn N %" and "Khởi động Claude · <model> · <effort>" once known', async () => {
    const m = await mount({ req: { direct: true } });
    await m.flush();
    const steps = [...document.querySelectorAll('.sst')];
    expect(steps[0]!.querySelector('b')?.textContent).toBe('Chọn account: pm@example.net');
    expect(steps[0]!.querySelector('small')?.textContent).toBe('tự chọn — còn 31 %');
    expect(steps[1]!.querySelector('b')?.textContent).toBe('Khởi động Claude · Opus 5.5 · medium');
    // the engine ran it on another account than session_pick named: step 1 follows it, with that account's %
    await m.set({ os: [...OS, orch('s9', { state: 'starting', account: 'bo@example.org', seq: 2 })] });
    expect(m.text('.sst b')).toBe('Chọn account: bo@example.org');
    expect(m.text('.sst small')).toBe('tự chọn — còn 51 %');
    await m.unmount();
  });
  test('UX MINOR-2 a start refusal shows on the step list only: the start command never goes through the toasting send', async () => {
    const m = await mount();
    await m.click(main());
    expect(m.sent.some(c => c.cmd === 'spec_build')).toBe(true);
    expect(m.loud.some(c => c.cmd === 'spec_build')).toBe(false);
    await m.unmount();
  });
  test('UX MINOR-6 the picked account turns unusable while the dialog is open: its reason under the field, the main button off, Enter sends nothing', async () => {
    const m = await mount();
    await m.click(m.q('.apick'));
    await m.click([...document.querySelectorAll('.apop .arow')].find(o => o.textContent.startsWith('pm@'))!);
    expect(main().disabled).toBe(false);
    const full = account('pm@example.net', { full: true, headroomPct: 0, fullWhy: W({}) });
    await m.set({ accounts: ACCS.map(a => (a.email === full.email ? full : a)) });
    expect(m.text('.apick')).toBe('pm@example.net — Đầy');
    expect(m.text('.note.alert')).toBe(whyNot(tr, full)!);
    expect(main().disabled).toBe(true);
    expect(m.text('.mf .fl')).toBe('Chưa bắt đầu được: chọn account khác');
    await m.key(m.q('.sdlg .lead'), 'Enter');
    expect(m.sent.some(c => c.cmd === 'spec_build')).toBe(false);
    await m.unmount();
  });
  test('SA4 another refusal: "Thử lại" sends the same start again; "Đóng" closes', async () => {
    const m = await mount({ req: { direct: true, kind: 'new' } });
    expect(m.sent.filter(c => c.cmd === 'spec_new')).toEqual([{ cmd: 'spec_new', projectId: 'p1' }]); // the main part: the steps at once, no picks
    expect(m.text('.sdlg h2')).toBe('Đang mở phiên Thiết kế');
    m.waits.at(-1)!.reject(new Error('Không chạy được claude: ENOENT'));
    await m.flush();
    expect(m.text('.sst small')).toBe('Không chạy được claude: ENOENT');
    expect(foot()).toEqual(['Đóng', 'Thử lại']);
    await m.click(main());
    expect(m.sent.filter(c => c.cmd === 'spec_new').length).toBe(2);
    await m.click(document.querySelector('.sdlg .mf .btn:not(.pri)'));
    expect(m.calls.closed).toBe(1);
    await m.unmount();
  });
});
