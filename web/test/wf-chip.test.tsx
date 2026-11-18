// v2.9 §4.1 / §4.6 / §4.7 (WF6a, WF6a2, WF6b, WF7) in a DOM: the chip names the project's workflow; its menu lists the library
// (✓ applied, one-line descriptions) + Sửa (library pack) / Xem (built-in) + Quản lý; another workflow opens the Áp dụng
// box (mini chain, impact naming the docs in progress) and Áp dụng sends project_set_workflow; Giao thẳng = only "Việc",
// no "+ Spec mới".
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { ReactElement } from 'react';
import type { Command } from '../../shared/protocol.ts';
import type { WorkflowRow } from '../../shared/workflows.ts';
import { issueCmds, readTasksUi } from '../src/lib/issues.ts';
import { makeT } from '../../shared/i18n/core.ts';
import { railSlots, type WfDoc } from '../src/lib/wf-tasks.ts';
import type { TasksCtx } from '../src/tasks/tasks-ctx.ts';
import { MOCK_DETAILS, MOCK_PO_REV } from '../dev/wf-mock.ts';
import { issueInfo, PO_DOC, projIssues, specInfo } from './fixtures.ts';

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


const DIRECT: WfDoc = { ...MOCK_DETAILS[2]!, steps: MOCK_DETAILS[2]!.steps! };
const SP: WfDoc = { ...MOCK_DETAILS[1]!, steps: MOCK_DETAILS[1]!.steps! };
const row = (id: string, d: WfDoc, builtin = true): WorkflowRow => ({ id, builtin, name: d.name, description: `mô tả ${d.name}`, rev: d.rev, diskRev: d.rev, validAt: null,
  errors: [], warnings: [], basedOn: null, baseOutdated: false, usedBy: [], dir: builtin ? null : `/h/workflows/${id}` });
const ROWS = [row('builtin:po', PO_DOC), row('builtin:spec-plan', SP), row('builtin:direct', DIRECT), row('po-cua-toi', { ...PO_DOC, name: 'PO của tôi' }, false)];
const DOCS = new Map([[MOCK_PO_REV, PO_DOC], [SP.rev, SP], [DIRECT.rev, DIRECT]]);

function ctx(sent: Command[], o: { id?: string; cur?: WfDoc; pi?: TasksCtx['pi']; open?: (id: string | null) => void } = {}): TasksCtx {
  const cur = o.cur ?? PO_DOC;
  const send = (c: Command) => {
    sent.push(c);
    return Promise.resolve(c.cmd === 'workflow_get' ? { ...[...DOCS.values()].find(d => 'rev' in c && d.rev === c.rev), files: {}, errors: [], warnings: [] } : undefined);
  };
  return {
    project: { id: 'p1', name: 'cc-slaves', path: '/w/cc' }, pi: o.pi ?? projIssues([specInfo(1, { title: 'v2.8 Giao diện sáng', state: 'active' }),
      specInfo(2, { title: 'v2.5 Toolkit graph', state: 'approved' }), specInfo(3, { title: 'v2.4 Model', state: 'done' })], []),
    ui: readTasksUi(null, 'p1'), setUi: () => {}, cmds: issueCmds(send, 'p1'), locked: false, capFull: false, sessions: [], narrow: false,
    toDeck: () => {}, toCode: () => {}, start: () => {}, ask: null, setPop: () => {}, send, now: Date.now(),
    live: { lanes: [], accounts: [], cards: [], importNotice: null, wf: { id: o.id ?? 'builtin:po', rows: ROWS, fallback: null }, quotaAt: () => null },
    wf: { id: o.id ?? 'builtin:po', rows: ROWS, cur, docs: DOCS, slots: railSlots(makeT('vi'), cur, DOCS), openWorkflows: o.open ?? (() => {}), fallback: null },
  };
}
const txt = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('v2.9 §4.1 WF6a the chip + menu', () => {
  test('WF6a2 a built-in applied: ✓ on it, each row its description, "Xem quy trình này" + "Quản lý quy trình…" open the Quy trình screen', async () => {
    const { SpecRail } = await import('../src/tasks/SpecRail.tsx');
    const opened: (string | null)[] = [];
    const m = await mount(() => <SpecRail c={ctx([], { open: id => opened.push(id) })} sel={null} pick={() => {}} />);
    const chip = m.q('.wfc')!;
    expect([txt(chip), chip.getAttribute('title')]).toEqual(['Quy trình PO', 'Quy trình của project']);
    await m.click(chip);
    expect(txt(m.q('.wfmenu h4'))).toBe('Quy trình cho cc-slaves');
    // the rail clips its overflow (aside.trail): the 400 px menu is placed in the viewport under the chip, not inside the rail
    expect([m.q<HTMLElement>('.wfmenu')!.style.left, m.q<HTMLElement>('.wfmenu')!.style.top]).toEqual(['0px', '4px']);
    const items = [...document.querySelectorAll('.wfmenu > button')];
    expect(items.map(txt)).toEqual(['Quy trình POmô tả Quy trình PO', 'Spec + Planmô tả Spec + Plan', 'Giao thẳngmô tả Giao thẳng', 'PO của tôimô tả PO của tôi',
      'Xem quy trình này', 'Quản lý quy trình…']);
    expect(items.map(b => b.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false', null, null]);
    await m.click(items[4]!);
    await m.click(m.q('.wfc'));
    await m.click([...document.querySelectorAll('.wfmenu > button')][5]!);
    expect(opened).toEqual(['builtin:po', null]);
  });
  test('WF6a a library pack applied: "Sửa quy trình này"; offline every library row is disabled', async () => {
    const { WfChip } = await import('../src/tasks/WfChip.tsx');
    const c = ctx([], { id: 'po-cua-toi' });
    const m = await mount(() => <WfChip c={{ ...c, locked: true }} />);
    expect(txt(m.q('.wfc'))).toBe('PO của tôi');
    await m.click(m.q('.wfc'));
    const items = [...document.querySelectorAll<HTMLButtonElement>('.wfmenu > button')];
    expect(txt(items[4]!)).toBe('Sửa quy trình này');
    expect(items.slice(0, 4).map(b => b.disabled)).toEqual([true, true, true, true]);
  });
  test('hf-sp Giao thẳng by fallback: the menu says why under its head (one line); no reason → no line', async () => {
    const { WfChip } = await import('../src/tasks/WfChip.tsx');
    const c = ctx([], { id: 'builtin:direct' });
    const m = await mount(() => <WfChip c={{ ...c, wf: { ...c.wf, fallback: 'superpowers' } }} />);
    await m.click(m.q('.wfc'));
    expect(m.q('.wfmenu h4')?.nextElementSibling?.className).toBe('why');
    expect(txt(m.q('.wfmenu .why'))).toBe('Chưa cài superpowers nên dùng Giao thẳng. Cài superpowers (hoặc bật lại ở Skills & MCP) để dùng Quy trình PO.');
  });
  test('hf-sp no reason → no line in the menu', async () => {
    const { WfChip } = await import('../src/tasks/WfChip.tsx');
    const m = await mount(() => <WfChip c={ctx([], { id: 'builtin:direct' })} />);
    await m.click(m.q('.wfc'));
    expect(m.q('.wfmenu h4')).not.toBeNull();
    expect(m.q('.wfmenu .why')).toBeNull();
  });
});

describe('v2.9 §4.6 WF6b the Áp dụng box', () => {
  test('WF6b another workflow → its mini chain + the impact; Áp dụng sends project_set_workflow; Huỷ sends nothing', async () => {
    const { WfChip } = await import('../src/tasks/WfChip.tsx');
    const sent: Command[] = [];
    const m = await mount(() => <WfChip c={ctx(sent)} />);
    await m.click(m.q('.wfc'));
    await m.click([...document.querySelectorAll('.wfmenu > button')][1]!);
    await m.wait(20);
    const box = m.q('.wfapply')!;
    expect(txt(box.querySelector('h2'))).toBe('Áp quy trình "Spec + Plan" cho project cc-slaves?');
    expect(txt(box.querySelector('.wfmini'))).toBe('Thiết kếbấm Bắt đầuPlanbấm Bắt đầuBuildhết mụcXong+ Chung · Lane (7 pha)');
    expect(txt(box.querySelector('p:not(.wfload)'))).toBe('Tài liệu mới và phiên Chung theo quy trình mới. 2 tài liệu đang làm giữ quy trình cũ tới khi xong: v2.8 (Đang build), v2.5 (Chờ build).');
    await m.click([...box.querySelectorAll('.mf button')][0]!);
    expect(m.q('.wfapply')).toBeNull();
    expect(sent.filter(c => c.cmd === 'project_set_workflow')).toEqual([]);
    await m.click(m.q('.wfc'));
    await m.click([...document.querySelectorAll('.wfmenu > button')][1]!);
    await m.click([...m.q('.wfapply')!.querySelectorAll('.mf button')][1]!);
    expect(sent.filter(c => c.cmd === 'project_set_workflow')).toEqual([{ cmd: 'project_set_workflow', projectId: 'p1', id: 'builtin:spec-plan' }]);
    expect(m.q('.wfapply')).toBeNull();
  });
  test('WF6b no doc in progress → only the first sentence; Giao thẳng has no chain, only Chung · Lane (4 pha)', async () => {
    const { WfChip } = await import('../src/tasks/WfChip.tsx');
    const m = await mount(() => <WfChip c={ctx([], { pi: projIssues([], []) })} />);
    await m.click(m.q('.wfc'));
    await m.click([...document.querySelectorAll('.wfmenu > button')][2]!);
    await m.wait(20);
    expect(txt(m.q('.wfapply .wfmini'))).toBe('+ Chung · Lane (4 pha)');
    expect(txt(m.q('.wfapply p:not(.wfload)'))).toBe('Tài liệu mới và phiên Chung theo quy trình mới.');
  });
});

describe('v2.9 §4.7 WF7 Giao thẳng', () => {
  test('WF7 the rail is only "Việc" › "Tất cả việc" (open count), no "+ Spec mới"; the chip says Giao thẳng', async () => {
    const { SpecRail } = await import('../src/tasks/SpecRail.tsx');
    const pi = projIssues([], [issueInfo(12, { specId: null, state: 'doing' }), issueInfo(15, { specId: null }), issueInfo(11, { specId: null, state: 'done' })]);
    const m = await mount(() => <SpecRail c={ctx([], { id: 'builtin:direct', cur: DIRECT, pi })} sel="outside" pick={() => {}} />);
    expect(m.q('.snew')).toBeNull();
    expect(txt(m.q('.wfc'))).toBe('Giao thẳng');
    expect([...document.querySelectorAll('.sgrp h4')].map(txt)).toEqual(['Việc']);
    expect(txt(m.q('.sgrp .srow'))).toBe('Tất cả việc2');
  });
});
