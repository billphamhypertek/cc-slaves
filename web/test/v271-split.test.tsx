// v2.7.1 G2b §4.1 / §4.2 the split button "Bắt đầu ▾" of every Tasks start (SA0, SA6, SA8: main = the defaults at once,
// ▾ = the start dialog, keys, locks, the narrow menu form), IS17 "Như phiên cũ" (SA6b), "Mở bảng Account" on no_account
// (ruling 16:10), and G2c §5 the busy text of a command sent to a session still `starting` (+ the 30 s line).
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { ReactElement } from 'react';
import { makeT } from '../../shared/i18n/index.ts';
import type { PriorSession } from '../../shared/issues.ts';
import type { Command, OrchestratorView, Snapshot } from '../../shared/protocol.ts';
import { orchActions } from '../src/lib/actions.ts';
import { issueCmds, type TasksUi } from '../src/lib/issues.ts';
import { bootWaitText, SLOW_BOOT_MS } from '../src/lib/boot-wait.ts';
import type { StartReq } from '../src/lib/start.ts';
import { CommandError } from '../src/lib/ws.ts';
import type { TaskStart, TasksCtx } from '../src/tasks/tasks-ctx.ts';
import { account, poWf, projIssues, snapshot, specInfo } from './fixtures.ts';

const tr = makeT('vi');

describe('§5 G2c the busy text of a command waiting for a `starting` session', () => {
  test('"Đang chờ phiên khởi động…" at once; past 30 s "Claude chưa trả lời sau 30 giây — vẫn đang chờ"', () => {
    expect(bootWaitText(tr, 1000, 1000)).toBe('Đang chờ phiên khởi động…');
    expect(bootWaitText(tr, 1000, 1000 + SLOW_BOOT_MS)).toBe('Đang chờ phiên khởi động…');
    expect(bootWaitText(tr, 1000, 1001 + SLOW_BOOT_MS)).toBe('Claude chưa trả lời sau 30 giây — vẫn đang chờ');
  });
  test('the node menu: "Kết thúc phiên…" and "Model / effort…" of a `starting` session say so; a running one does not', () => {
    const o = (sessionId: string, state: OrchestratorView['state']) => ({ projectId: 'p1', sessionId, seq: sessionId === 's1' ? 1 : 2, state, title: null }) as OrchestratorView;
    const snap: Snapshot = { ...snapshot(), orchestrators: [o('s1', 'starting'), o('s2', 'running')] };
    const items = (x: OrchestratorView) => orchActions(x, { tr, snap, offline: false, tauri: false, now: Date.now() });
    const hint = (x: OrchestratorView, id: string) => items(x).find(i => i.id === id)?.hint;
    expect([hint(snap.orchestrators[0]!, 'end'), hint(snap.orchestrators[0]!, 'model')]).toEqual(['Đang chờ phiên khởi động…', 'Đang chờ phiên khởi động…']);
    expect([hint(snap.orchestrators[1]!, 'end'), hint(snap.orchestrators[1]!, 'model')]).toEqual([undefined, undefined]);
  });
});

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
afterEach(async () => { if (live) await live(); live = null; document.body.innerHTML = ''; });

async function mount(el: () => ReactElement) {
  const { act, createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { LangProvider } = await import('../src/lib/i18n.tsx');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = () => root.render(createElement(LangProvider, { lang: 'vi', children: null }, el()));
  await act(async () => { render(); await new Promise(r => setTimeout(r, 10)); });
  live = () => act(async () => { root.unmount(); host.remove(); });
  const q = <T extends Element = HTMLElement>(s: string) => document.querySelector<T>(s);
  return {
    q, act, render: () => act(async () => { render(); }),
    click: async (el: Element | null) => { await act(async () => { (el as HTMLElement).click(); await new Promise(r => setTimeout(r, 10)); }); },
    key: async (el: Element | null, key: string) => { await act(async () => { el!.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true }) as unknown as Event); }); },
    wait: (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)); }),
  };
}

describe('§4.1 SA0 the split button', () => {
  const setup = async (o: { off?: string | null; menu?: 'item' | 'rail' } = {}) => {
    const { SplitStart } = await import('../src/tasks/SplitStart.tsx');
    const calls: string[] = [];
    const m = await mount(() => <SplitStart cls="tbtn" label="Bắt đầu build" name="Bắt đầu build" off={o.off ?? null} {...(o.menu ? { menu: o.menu } : {})}
      onStart={() => calls.push('start')} onPick={() => calls.push('pick')} />);
    return { ...m, calls };
  };
  test('main part = start with the defaults (tooltip says so); ▾ = the dialog, neutral, aria-haspopup dialog + the named aria-label', async () => {
    const m = await setup();
    const [main, dd] = [...document.querySelectorAll<HTMLButtonElement>('.split > button')];
    expect(main!.className).toBe('tbtn');
    expect(main!.title).toBe('Bắt đầu ngay: account tự chọn theo luật Điều phối, model / effort mặc định của account. Bấm ▾ để chọn khác.');
    expect([dd!.className, dd!.getAttribute('aria-haspopup'), dd!.getAttribute('aria-label'), dd!.title])
      .toEqual(['sdd', 'dialog', 'Bắt đầu build — chọn account, model, effort', 'Chọn account, model, effort…']);
    expect(dd!.querySelector('svg')).not.toBeNull(); // the app's chevron
    await m.click(main!);
    await m.click(dd!);
    expect(m.calls).toEqual(['start', 'pick']);
  });
  test('keyboard: ↓ on ▾ opens the dialog (Enter / Space are the button\'s own click); ↓ elsewhere does nothing', async () => {
    const m = await setup();
    const [main, dd] = [...document.querySelectorAll<HTMLButtonElement>('.split > button')];
    await m.key(main!, 'ArrowDown');
    await m.key(dd!, 'ArrowUp');
    expect(m.calls).toEqual([]);
    await m.key(dd!, 'ArrowDown');
    expect(m.calls).toEqual(['pick']);
  });
  test('a lock dims both parts and shows its reason as the styled LockTip (no native title)', async () => {
    const m = await setup({ off: 'Mất kết nối engine — chờ nối lại' });
    const btns = [...document.querySelectorAll<HTMLButtonElement>('.split > button')];
    expect(btns.map(b => [b.disabled, b.title])).toEqual([[true, ''], [true, '']]);
    expect(m.q('.ltip')!.getAttribute('data-tip')).toBe('Mất kết nối engine — chờ nối lại');
    await m.click(btns[0]!); await m.click(btns[1]!);
    expect(m.calls).toEqual([]);
  });
  test('SA8 the narrow menu: the item is the main part, the indented "… chọn account, model, effort…" under it is the ▾ path, no ▾ drawn', async () => {
    const m = await setup({ menu: 'item' });
    const items = [...document.querySelectorAll<HTMLButtonElement>('[role=menuitem]')];
    expect(items.map(b => b.textContent)).toEqual(['Bắt đầu build', '… chọn account, model, effort…']);
    expect(m.q('.sdd')).toBeNull();
    await m.click(items[1]!); await m.click(items[0]!);
    expect(m.calls).toEqual(['pick', 'start']);
  });
});

const UI0: TasksUi = { sel: null, issue: null, doneOpen: false, specDoneOpen: false, cancelledOpen: false, folded: [], arising: false };
const ctx = (starts: [TaskStart, boolean][], o: Partial<TasksCtx> = {}): TasksCtx => ({
  project: { id: 'p1', name: 'hagenta', path: '/w/hagenta' }, pi: projIssues([], []), ui: UI0, setUi: () => {},
  cmds: issueCmds(() => new Promise(() => {}), 'p1'), locked: false, capFull: false, sessions: [], narrow: false,
  toDeck: () => {}, toCode: () => {}, start: (r, d) => { starts.push([r, d]); }, ask: null, setPop: () => {},
  live: { lanes: [], accounts: [], cards: [], importNotice: null, wf: { id: null, rows: [], fallback: null }, quotaAt: () => null }, wf: poWf(), send: () => new Promise(() => {}), now: Date.now(), ...o,
});

describe('§4.1 the Tasks buttons hand their start to the dialog layer', () => {
  test('spec card Bắt đầu build / Sửa spec: main = direct (no picks), ▾ = the dialog; kind, path and title carried', async () => {
    const { SpecCard } = await import('../src/tasks/SpecCard.tsx');
    const starts: [TaskStart, boolean][] = [];
    const spec = specInfo(4, { state: 'approved', title: 'v2.6 Updater', path: 'docs/specs/v2.6.md' });
    const m = await mount(() => <SpecCard c={ctx(starts)} spec={spec} />);
    const splits = [...document.querySelectorAll('.sact .split')];
    expect(splits.map(s => s.querySelector('button')!.textContent)).toEqual(['Bắt đầu build', 'Sửa spec']);
    await m.click(splits[0]!.querySelector('.tbtn'));
    await m.click(splits[0]!.querySelector('.sdd'));
    await m.click(splits[1]!.querySelector('.sdd'));
    expect(starts).toEqual([
      [{ kind: 'build', path: 'docs/specs/v2.6.md', spec: 'v2.6 Updater' }, true],
      [{ kind: 'build', path: 'docs/specs/v2.6.md', spec: 'v2.6 Updater' }, false],
      [{ kind: 'edit', path: 'docs/specs/v2.6.md', spec: 'v2.6 Updater' }, false],
    ]);
  });
  test('§4.2 IS17 "Nhận phiên này": main = resume with the defaults, ▾ = SA6b; the choice closes either way; the foot names the defaults', async () => {
    const { PriorSessions } = await import('../src/tasks/PriorSessions.tsx');
    const starts: [TaskStart, boolean][] = [];
    let closed = 0;
    const prior: PriorSession[] = [{ id: 'c1', firstText: 'Port toolkit graph', lastAt: new Date(2026, 10, 17, 7, 12).getTime(), turns: 184, cwd: null, runningElsewhere: false, long: false, model: 'claude-opus-5-5', effort: 'high' }];
    const cmds = { ...issueCmds(() => new Promise(() => {}), 'p1'), priorSessions: () => Promise.resolve(prior) };
    const spec = specInfo(5, { state: 'approved', title: 'v2.5 Toolkit graph', path: 'docs/specs/v2.5.md', outsideBuild: true, origin: 'imported' });
    const m = await mount(() => <PriorSessions c={ctx(starts, { cmds })} spec={spec} anchor={{ current: null }} onClose={() => { closed++; }} />);
    await m.wait(10);
    expect(m.q('.pdef')!.textContent).toBe('Mặc định: account tự chọn · model / effort như cũ');
    const take = m.q('.pold .split')!;
    await m.click(take.querySelector('.tbtn'));
    await m.click(take.querySelector('.sdd'));
    const resume: TaskStart = { kind: 'resume', path: 'docs/specs/v2.5.md', spec: 'v2.5 Toolkit graph', resume: { id: 'c1', label: '“Port toolkit graph” (07:12 17/11 · 184 lượt)', prior: { model: 'claude-opus-5-5', effort: 'high' } } };
    expect(starts).toEqual([[resume, true], [resume, false]]);
    await m.click(m.q('.pnew .sdd'));
    expect(starts[2]).toEqual([{ kind: 'build', path: 'docs/specs/v2.5.md', spec: 'v2.5 Toolkit graph' }, false]);
    expect(closed).toBe(3);
  });
});

describe('§4.1 / §4.2 the start dialog from a split button', () => {
  const dlg = async (req: Partial<StartReq>, send: (c: Command) => Promise<unknown>, os: OrchestratorView[] = []) => {
    const { SessionDialogs } = await import('../src/ui/SessionDialogs.tsx');
    const calls = { accounts: 0, closed: 0 };
    const r: StartReq = { projectId: 'p1', kind: 'build', path: 'docs/specs/v2.5.md', spec: 'v2.5', ...req };
    const m = await mount(() => <SessionDialogs dlg={{ k: 'start', req: r }} os={os} list={null} projectName="hagenta" accounts={[account('pm@x', { headroomPct: 31 })]}
      lanes={[]} cards={[]} offline={false} now={0} prevSid={null} send={send} sendQuiet={send} loadPreview={async () => null} loadModels={async () => ({ models: [], defaultModel: null, defaultModelName: null })}
      onStarted={() => {}} onClose={() => { calls.closed++; }} onAccounts={() => { calls.accounts++; }} />);
    return { ...m, calls };
  };
  test('ruling 16:10: the main part refused with no_account → ✗ step 1 with the reason, "Mở bảng Account" opens the Account panel', async () => {
    const send = (c: Command) => (c.cmd === 'session_pick' ? Promise.resolve({ account: null, headroomPct: null, earliest: null })
      : Promise.reject(new CommandError('no_account', 'Không account nào còn dùng được')));
    const m = await dlg({ direct: true }, send);
    await m.wait(10);
    expect(m.q('.sst.st-bad small')!.textContent).toBe('Không account nào còn dùng được');
    const btns = [...document.querySelectorAll<HTMLButtonElement>('.sdlg .mf .btn')].map(b => b.textContent);
    expect(btns).toEqual(['Đóng', 'Mở bảng Account']);
    await m.click(m.q('.sdlg .mf .btn.pri'));
    expect(m.calls.accounts).toBe(1);
  });
  test('SA6b the ▾ of "Nhận phiên này": title, lead naming the session, Model / Effort "Như phiên cũ", the resume note; Enter sends spec_build resume, no picks', async () => {
    const sent: Command[] = [];
    const send = (c: Command) => { sent.push(c); return c.cmd === 'session_pick' ? Promise.resolve({ account: 'pm@x', headroomPct: 31, earliest: null }) : new Promise(() => {}); };
    const m = await dlg({ kind: 'resume', spec: 'v2.5 Toolkit graph', resume: { id: 'c1', label: '“Port” (07:12 17/11 · 184 lượt)', prior: { model: null, effort: null } } }, send);
    expect(m.q('.sdlg h2')!.textContent).toBe('Nhận phiên cũ · v2.5 Toolkit graph');
    expect(m.q('.sdlg .lead')!.textContent).toBe('Nhận phiên “Port” (07:12 17/11 · 184 lượt), rồi chuyển sang Deck.');
    expect(m.q('.mpick')!.textContent).toBe('Như phiên cũ');
    expect(m.q<HTMLSelectElement>('.mpicks select')!.options[0]!.textContent).toBe('Như phiên cũ');
    expect(m.q('.sdlg .note span')!.textContent).toContain('phiên cũ chạy tiếp trên account mới');
    await m.click(m.q('.sdlg .mf .btn.pri'));
    expect(sent.filter(c => c.cmd === 'spec_build')).toEqual([{ cmd: 'spec_build', projectId: 'p1', path: 'docs/specs/v2.5.md', resume: 'c1' }]);
  });
  test('g2bc ⑥ SA6b with the old values: "Như phiên cũ (Opus 5.5)" (the list\'s name for the transcript\'s model id) and "Như phiên cũ (high)"', async () => {
    const { SessionDialogs } = await import('../src/ui/SessionDialogs.tsx');
    const send = (c: Command) => (c.cmd === 'session_pick' ? Promise.resolve({ account: 'pm@x', headroomPct: 31, earliest: null }) : new Promise(() => {}));
    const models = { models: [{ value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', effortLevels: ['low', 'medium', 'high'] }, { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', effortLevels: ['low', 'medium', 'high'] }], defaultModel: null, defaultModelName: null };
    const at = async (prior: { model: string | null; effort: string | null }) => {
      const r: StartReq = { projectId: 'p1', kind: 'resume', path: 'docs/specs/v2.5.md', spec: 'v2.5', resume: { id: 'c1', label: '“Port”', prior } };
      const m = await mount(() => <SessionDialogs dlg={{ k: 'start', req: r }} os={[]} list={null} projectName="hagenta" accounts={[account('pm@x', { headroomPct: 31 })]}
        lanes={[]} cards={[]} offline={false} now={0} prevSid={null} send={send} sendQuiet={send} loadPreview={async () => null} loadModels={async () => models}
        onStarted={() => {}} onClose={() => {}} onAccounts={() => {}} />);
      await m.wait(10);
      const out = [m.q('.mpick')!.textContent, m.q<HTMLSelectElement>('.mpicks select')!.options[0]!.textContent];
      if (live) await live();
      live = null;
      return out;
    };
    expect(await at({ model: 'claude-opus-5-5', effort: 'high' })).toEqual(['Như phiên cũ (Opus 5.5)', 'Như phiên cũ (high)']);
    expect(await at({ model: 'claude-x-9', effort: null })).toEqual(['Như phiên cũ (claude-x-9)', 'Như phiên cũ']); // not in the list: the raw id
  });
  test('G2c "Kết thúc phiên" on a `starting` session: the click shows the busy line at once; > 30 s the "vẫn đang chờ" line; a refusal stays in place', async () => {
    const { SessionDialogs } = await import('../src/ui/SessionDialogs.tsx');
    let fail!: (e: unknown) => void;
    const send = () => new Promise((_, ko) => { fail = ko; });
    const os = [{ projectId: 'p1', sessionId: 's2', seq: 2, state: 'starting', title: null }, { projectId: 'p1', sessionId: 's1', seq: 1, state: 'running', title: null }] as OrchestratorView[];
    const real = Date.now;
    let clock = real();
    Date.now = () => clock;
    try {
      const m = await mount(() => <SessionDialogs dlg={{ k: 'end', sessionId: 's2' }} os={os} list={null} projectName="hagenta" accounts={[]} lanes={[]} cards={[]}
        offline={false} now={0} prevSid={null} send={send} sendQuiet={send} loadPreview={async () => null} loadModels={async () => ({})} onStarted={() => {}} onClose={() => {}} onAccounts={() => {}} />);
      expect(m.q('.note.wait')).toBeNull();
      await m.act(async () => { m.q<HTMLButtonElement>('.sdlg .mf .btn.pri')!.click(); });
      expect(m.q('.note.wait')!.textContent).toBe('Đang chờ phiên khởi động…');
      expect(m.q('.sdlg .mf .btn.pri .spin')).not.toBeNull();
      clock += SLOW_BOOT_MS + 1000;
      await m.wait(1100);
      expect(m.q('.note.wait')!.textContent).toBe('Claude chưa trả lời sau 30 giây — vẫn đang chờ');
      await m.act(async () => { fail(new CommandError('session_gone', 'Phiên đã dừng')); await new Promise(r => setTimeout(r, 5)); });
      expect(m.q('.note.wait')).toBeNull();
      expect(m.q('.preview.bad')!.textContent).not.toBe('');
    } finally { Date.now = real; }
  });
});
