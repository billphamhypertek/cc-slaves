// v2.7 §4.1 the Tasks mode (D76, D88, D91): key T, tab order Tasks · Deck · Code · Git, the orange dot, every project opens in
// Tasks (memory only, no `ccs.mode`), Tasks mounts at once and hides the left column; §6 states IS8 / IS8b / IS8c of the
// Tasks root; §10.2 colours only through var(--…).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Glob } from 'bun';
import type { ReactElement } from 'react';
import type { Snapshot } from '../../shared/protocol.ts';
import { renderToStaticMarkup } from 'react-dom/server';
import { LangProvider } from '../src/lib/i18n.tsx';
import { keyAction, type KeyLike } from '../src/lib/keys.ts';
import { HeadBar } from '../src/ui/HeadBar.tsx';
import { modeOf } from '../src/ui/shell.ts';
import { TasksRoot, tasksLive, type TasksRootProps } from '../src/tasks/TasksRoot.tsx';
import type { TasksCtx } from '../src/tasks/tasks-ctx.ts';
import { issueInfo, projIssues, specInfo } from './fixtures.ts';

const k = (key: string): KeyLike => ({ key, code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false });
const html = (el: ReactElement) => renderToStaticMarkup(<LangProvider lang="vi">{el}</LangProvider>);
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const src = (f: string) => readFileSync(`web/src/${f}`, 'utf8');

describe('§4.1 key T and the mode memory', () => {
  test('§4.1 T opens Tasks when the caret is not in a text field; dead while typing', () => {
    expect(keyAction(k('t'), false)).toEqual({ t: 'mode', m: 'tasks' });
    expect(keyAction(k('T'), false)).toEqual({ t: 'mode', m: 'tasks' });
    expect(keyAction(k('t'), true)).toBeNull();
  });
  test('§4.1 D91 every project opens in Tasks; a project keeps its last mode in this run; no project / remote → Deck', () => {
    expect(modeOf({}, 'p1', true)).toBe('tasks');
    const m = { p1: 'code', p2: 'deck' } as const;
    expect(modeOf(m, 'p1', true)).toBe('code');
    expect(modeOf(m, 'p2', true)).toBe('deck');
    expect(modeOf(m, 'p3', true)).toBe('tasks');
    expect(modeOf({}, null, true)).toBe('deck');
    expect(modeOf({}, 'p1', false)).toBe('deck');
    expect(modeOf({ p1: 'tasks' }, 'p1', false)).toBe('deck');
  });
  test('§4.1 the ccs.mode localStorage code is gone (memory only)', () => {
    for (const f of new Glob('web/src/**/*.{ts,tsx}').scanSync()) expect(readFileSync(f, 'utf8')).not.toContain('ccs.mode');
  });
});

describe('§4.1 head bar: tab order + orange dot', () => {
  const head = { parts: [{ k: 'name' as const, text: 'hagenta' }], tip: [] };
  const tabs = (h: string) => [...h.matchAll(/role="tab"[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]+)/g)].map(m => m[1]);
  test('§4.1 Tasks · Deck · Code · Git, T key hint, Tasks selected', () => {
    const h = html(<HeadBar head={head} mode="tasks" onMode={() => {}} tasks unseen={false} />);
    expect(tabs(h)).toEqual(['Tasks', 'Deck', 'Code', 'Git']);
    expect(h).toContain('<span class="kb">T</span>');
    expect(h).toMatch(/aria-selected="true"[^>]*>(?:<svg[\s\S]*?<\/svg>)?Tasks/);
    expect(h).not.toContain('class="od"');
  });
  test('§4.1 / §5.6 an orange dot (no number) on Tasks only while the project has unseen issues', () => {
    const h = html(<HeadBar head={head} mode="deck" onMode={() => {}} tasks unseen />);
    expect((h.match(/class="od"/g) ?? []).length).toBe(1);
    expect(h.indexOf('class="od"')).toBeLessThan(h.indexOf('>Deck'));
    expect(h).toContain('aria-label="Có việc phát sinh chưa xem"');
  });
  test('§8 no Tasks tab on the remote channel', () => {
    expect(tabs(html(<HeadBar head={head} mode="deck" onMode={() => {}} tasks={false} unseen />))).toEqual(['Deck', 'Code', 'Git']);
  });
  test('§4.1 ModeRoots mounts Tasks at once (static import); App hides the left column in Tasks and mounts the Deck lazily', () => {
    const mr = src('ui/ModeRoots.tsx'), app = src('ui/App.tsx');
    expect(mr).toContain("import { TasksRoot, type TasksRootProps } from '../tasks/TasksRoot.tsx';");
    expect(mr).toMatch(/\{p\.tasks \? <TasksRoot /);
    expect(app).toMatch(/<div id="left" hidden=\{mode === 'tasks' \|\| undefined\}/);
    expect(app).toMatch(/\{deckSeen \? <Suspense/);
    expect(app).toMatch(/mode !== 'tasks' \? <button id="inboxBtn"/);
  });
});

describe('§6 Tasks root states', () => {
  const base: TasksRootProps = { shown: true, project: { id: 'p1', name: 'hagenta', path: '/w/hagenta' }, sessions: [], pi: null, offline: false, dataAt: null, send: () => Promise.resolve(),
    toDeck: () => {}, start: () => {}, toCode: () => {}, openWorkflows: () => {}, live: tasksLive(null, 'p1') };
  test('IS8b loading: no data and the first scan not answered → the three-region skeleton', () => {
    const h = html(<TasksRoot {...base} />);
    expect(h).toContain('aria-busy="true"');
    expect(h).toContain('aria-label="Đang tải việc…"');
    expect((h.match(/class="sk"/g) ?? []).length).toBeGreaterThan(20);
    expect(h).toMatch(/class="trail"[\s\S]*class="tlist"[\s\S]*class="tdet skd"/);
  });
  test('IS8 nothing yet (concept B): title, one sub line, Spec mới split (▾ its own square), hairline, Quy trình [chip] / Báo bug … D', () => {
    const h = html(<TasksRoot {...base} pi={projIssues([], [])} />), t = text(h);
    expect(h).toMatch(/class="tstart"><div class="col"><svg[\s\S]*<h2>Chưa có việc\.<\/h2><p class="lede">Mở phiên Thiết kế để viết spec đầu tiên\.<\/p><span class="split">/);
    expect(h).toMatch(/<button type="button" class="tbtn"[^>]*>[\s\S]*Spec mới<\/button><button type="button" class="sdd"/);
    expect(h).toMatch(/<hr\/><dl><dt>Quy trình<\/dt><dd><div class="wfchip"><button type="button" class="wfc"[\s\S]*<dt>Báo bug<\/dt><dd>nói với Điều phối ở Deck<kbd>D<\/kbd><\/dd><\/dl>/);
    expect(t).not.toContain('(D)');
    expect(h).not.toContain('class="temp"');
  });
  test('IS8 Giao thẳng: its own line, no start button, "Mở Deck D" in place of the bug row (orchestrator ruling)', async () => {
    const { EmptyStart } = await import('../src/tasks/EmptyStart.tsx');
    const c = { project: base.project, locked: false, setPop: () => {}, wf: { id: 'builtin:direct', rows: [], cur: null, docs: new Map(), openWorkflows: () => {}, slots: { docless: true } } } as unknown as TasksCtx;
    const h = html(<EmptyStart c={c} wait={false} off={null} onStart={() => {}} onPick={() => {}} />);
    expect(text(h)).toContain('Nhắn phiên Chung ở Deck một yêu cầu — mỗi yêu cầu thành một mục, giao cho lane.');
    expect(h).not.toContain('<button type="button" class="tbtn"');
    expect(h).not.toContain('class="split"');
    expect(h).toMatch(/<dt>Mở Deck<\/dt><dd><kbd>D<\/kbd><\/dd>/);
    expect(h).not.toContain('Báo bug');
  });
  test('hf-sp Giao thẳng by fallback: one neutral line under the chip row naming the plugin; none without the reason', async () => {
    const { EmptyStart } = await import('../src/tasks/EmptyStart.tsx');
    const c = (fallback: string | null) => ({ project: base.project, locked: false, setPop: () => {}, wf: { id: 'builtin:direct', rows: [], cur: null, docs: new Map(), openWorkflows: () => {}, slots: { docless: true }, fallback } }) as unknown as TasksCtx;
    const line = 'Chưa cài superpowers nên dùng Giao thẳng. Cài superpowers (hoặc bật lại ở Skills & MCP) để dùng Quy trình PO.';
    const h = html(<EmptyStart c={c('superpowers')} wait={false} off={null} onStart={() => {}} onPick={() => {}} />);
    expect(h).toContain(`</dl><p class="wfwhy">${line.replace('&', '&amp;')}</p>`);
    expect(text(html(<EmptyStart c={c(null)} wait={false} off={null} onStart={() => {}} onPick={() => {}} />))).not.toContain('Chưa cài');
  });
  test('hf-sp TasksRoot hands the reason to the empty state', () => {
    const h = html(<TasksRoot {...base} pi={projIssues([], [])} live={{ ...base.live, wf: { id: 'builtin:po', rows: [], fallback: 'superpowers' } }} />);
    expect(h).toContain('<p class="wfwhy">Chưa cài superpowers nên dùng Giao thẳng.');
  });
  test('hf-sp tasksLive: the reason only while the plugin is still not installed and on for lanes (unknown plugin list: shown)', () => {
    const snap = (fb: string | null, plugins: string[] | null, forLanes = true) => ({
      lanes: [], accounts: [], cards: [], projects: [{ id: 'p1', workflow: 'builtin:direct', workflowFallback: fb }],
      skillsMcp: plugins ? { skills: { plugins: plugins.map(key => ({ key, forLanes })) } } : undefined,
    }) as unknown as Snapshot;
    expect(tasksLive(snap('superpowers', null), 'p1').wf.fallback).toBe('superpowers');
    expect(tasksLive(snap('superpowers', ['other@m']), 'p1').wf.fallback).toBe('superpowers');
    expect(tasksLive(snap('superpowers', ['superpowers@m']), 'p1').wf.fallback).toBeNull();
    // hf-rv B1: installed but off for lanes = missing for the engine (session/skills.ts firstOff), so the reason stays
    expect(tasksLive(snap('superpowers', ['superpowers@m'], false), 'p1').wf.fallback).toBe('superpowers');
    expect(tasksLive(snap(null, null), 'p1').wf.fallback).toBeNull();
  });
  test('IS8 with the pack rev still being read (hf1117-perf: a new project): no skeleton page, a 30 px skeleton in the start\'s place, the line kept (no jump)', () => {
    const row = { id: 'builtin:po', rev: 'rev-unread-v29gate' } as unknown as NonNullable<Snapshot['workflows']>[number];
    const h = html(<TasksRoot {...base} pi={projIssues([], [])} live={{ ...base.live, wf: { id: 'builtin:po', rows: [row], fallback: null } }} />);
    expect(h).not.toContain('aria-busy="true"');
    // same blocks, same order as the loaded page: title · one-line lede · a block of the button's height · hairline · rows
    expect(h).toMatch(/<h2>Chưa có việc\.<\/h2><p class="lede">\u00a0<\/p><span class="sk skbtn"><\/span><hr\/><dl><dt>Quy trình<\/dt>/);
    expect(text(h)).not.toContain('Spec mới'); // a Giao thẳng pack has none: wait for the rev before offering it
    expect(src('tasks/tasks.css')).toContain('.tsk .tstart .skbtn{width:150px;height:var(--h-ctl);');
  });
  test('IS8c disconnected: band with the data time, dimmed, + Spec mới and ▾ locked with the LockTip reason', () => {
    const h = html(<TasksRoot {...base} pi={projIssues([], [])} offline dataAt={new Date(2026, 10, 17, 14, 32).getTime()} />);
    expect(h).toContain('class="tsk dim"');
    expect(text(h)).toContain('Mất kết nối · số liệu lúc 14:32 · đang nối lại');
    expect(h).toMatch(/<button[^>]*class="tbtn"[^>]*disabled/);
    expect(h).toMatch(/<button[^>]*class="sdd"[^>]*disabled/);
    expect(h).toContain('Mất kết nối engine — chờ nối lại');
  });
  test('IS8 split: beside a tbtn the ▾ is a separate 30 px neutral square 4 px apart; the rail snew keeps the joined ▾', () => {
    const css = src('tasks/split.css');
    expect(css).toContain('.split>.tbtn+.sdd{width:var(--h-ctl);margin-left:var(--s2);padding:0;border-left:1px solid var(--line-2);border-radius:6px;background:var(--panel-2)}');
    expect(css).toContain('.srail .split>.sdd{border-radius:0 4px 4px 0;min-width:22px}');
  });
  test('§4.3 with data: rail · list, no issue detail until an issue is open (D99: a building spec shows its overview, a spec card / outside no right column); hidden when not shown', () => {
    const h = html(<TasksRoot {...base} shown={false} pi={projIssues([specInfo(1)], [issueInfo(1)])} />);
    expect(h).toContain('class="tgrid"');
    expect(h).toContain('aria-label="Spec theo vòng đời"');
    expect(h).toContain('class="scard sov"');
    expect(html(<TasksRoot {...base} pi={projIssues([specInfo(1, { state: 'approved' })], [])} />)).toMatch(/class="tgrid nod".*class="tmid"/s); // spec card
    expect(h).not.toContain('idet');
    expect(html(<TasksRoot {...base} pi={projIssues([], [issueInfo(1, { specId: null })])} />)).toContain('class="tgrid nod"'); // Ngoài spec: no overview
    // IS3b the Phát sinh filter from the Deck card: no issue picked → the list takes the detail's room (no overview)
    const ls = globalThis as { localStorage?: Pick<Storage, 'getItem' | 'setItem'> };
    const saved = ls.localStorage;
    ls.localStorage = { getItem: () => JSON.stringify({ p1: { sel: { spec: 1 }, issue: null, arising: true } }), setItem: () => {} };
    try {
      const ar = html(<TasksRoot {...base} pi={projIssues([specInfo(1)], [issueInfo(1, { poSeen: false, source: 'lane' })])} />);
      expect(ar).toContain('class="lchip"');
      expect(ar).not.toContain('class="scard sov"');
    } finally { ls.localStorage = saved; }
    expect(h).toContain('visibility:hidden');
    expect(h).not.toContain('Chưa có việc.');
  });
});
