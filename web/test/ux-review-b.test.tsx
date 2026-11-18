// v21-ux-review part B (spec v2.1 §6 "So với mockup"): menu key hints + ⌘. in an open menu (M8), node tips carry the
// clipped texts (M8 / M12), the fit keeps a toast row free (M9), an expired session's actions (I7), the Chờ PO count
// during the 5 s undo (M7). Layout itself is measured in e2e/specs/v21-leftcol.spec.ts (UX-*).
import { describe, expect, test } from 'bun:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { makeT } from '../../shared/i18n/index.ts';
import type { SessionRowView, SubagentView } from '../../shared/protocol.ts';
import type { MenuItem } from '../src/lib/actions.ts';
import { ClickGuard, UndoQueue } from '../src/lib/cards.ts';
import { LangProvider } from '../src/lib/i18n.tsx';
import { INTERRUPT_KEY, menuKey, withHints } from '../src/lib/menu.ts';
import { buildFlow, type LaneData, type OrchData } from '../src/deck/flow/model.ts';
import { fitViewport, toScreen, TOAST_BAND } from '../src/deck/flow/viewport.ts';
import { Inbox } from '../src/ui/Inbox.tsx';
import { SessionView } from '../src/ui/SessionView.tsx';
import { card, lane, snapshot } from './fixtures.ts';

const VI = makeT('vi');
const html = (el: ReactElement) => renderToStaticMarkup(<LangProvider lang="vi">{el}</LangProvider>);
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const it = (id: string, over: Partial<MenuItem> = {}): MenuItem => ({ id, label: id, g: 0, act: { t: 'lane', a: 'msg', projectId: 'p1', name: 'D2' }, ...over });

describe('UX-M8 N2-c / N2-f / N2-g menu key hints', () => {
  test('UX-M8 the first item shows Enter, Ngắt lượt shows ⌘.; items with a key or a submenu keep theirs', () => {
    const items = withHints([it('msg'), it('interrupt'), it('switch', { submenu: { head: 'x', items: [] } }), it('history', { kbd: 'H' })]);
    expect(items.map(i => i.kbd)).toEqual(['Enter', '⌘.', undefined, 'H']);
  });
  test('hf1116 W1 a dimmed first item ("Đóng project" while a lane runs) shows no Enter: Enter would do nothing', () => {
    expect(withHints([it('close', { disabled: 'Đang chạy 1 lane' })])[0]!.kbd).toBeUndefined();
  });
  test('UX-M8 ⌘. in an open menu runs that menu\'s Ngắt lượt (not the composer target); none → the key passes through', () => {
    const items = withHints([it('msg'), it('interrupt', { act: { t: 'lane', a: 'interrupt', projectId: 'p1', name: 'D2' } })]);
    expect(menuKey(items, { i: 0, sub: null, si: 0 }, INTERRUPT_KEY)?.run?.id).toBe('interrupt');
    expect(menuKey(withHints([it('msg')]), { i: 0, sub: null, si: 0 }, INTERRUPT_KEY)).toBeNull();
    expect(menuKey(withHints([it('msg'), it('interrupt', { disabled: 'offline' })]), { i: 0, sub: null, si: 0 }, INTERRUPT_KEY)).toBeNull();
  });
});

describe('UX-M8 / M12 node tooltips carry what the node clips', () => {
  const sub = (taskId: string): SubagentView => ({ taskId, toolUseId: `tu-${taskId}`, description: taskId, subagentType: taskId, background: false,
    status: 'running', totalTokens: 1, toolUses: 1, lastTool: 'Read', endedAt: null });
  test('UX-M8 N2-i the lane tip task line ends in "· n subagent"', () => {
    const m = buildFlow({ snap: snapshot({ lanes: [lane('B2', { task: 'chạy gate e2e' })] }), projectId: 'p1', subagents: { B2: [sub('a'), sub('b')] },
      selected: null, now: 0, tr: VI, live: true });
    expect((m.nodes.find(n => n.id === 'lane:B2')!.data as LaneData).tip).toContain('chạy gate e2e · 2 subagent');
  });
  test('UX-M12 the Điều phối tip lists every lane of "làm với …" (the node clips it)', () => {
    const lanes = ['D2', 'B2', 'B7', 'D3'].map(n => lane(n, { state: 'running' }));
    const m = buildFlow({ snap: snapshot({ lanes }), projectId: 'p1', subagents: {}, selected: null, now: 0, tr: VI, live: true });
    expect((m.nodes.find(n => n.type === 'orchestrator')!.data as OrchData).tip).toContain('làm với D2, B2, B7, D3');
  });
});

describe('UX-M9 N5-p the fit leaves the toast row free', () => {
  test('UX-M9 a fitted tree starts below the header bar (D53 --h-head 28) + the toast band (short and tall trees)', () => {
    const s = { w: 1016, h: 844 };
    for (const c of [{ x: 0, y: 0, w: 600, h: 300 }, { x: 0, y: 0, w: 600, h: 3000 }]) {
      const vp = fitViewport(c, s);
      expect(toScreen(c, vp).y).toBeGreaterThanOrEqual(28 + TOAST_BAND - 0.5);
    }
    // a frame too small for any clear box: top-aligned at the floor, still under the band
    expect(toScreen({ x: 0, y: 0, w: 600, h: 300 }, fitViewport({ x: 0, y: 0, w: 600, h: 300 }, { w: 60, h: 100 })).y).toBeGreaterThanOrEqual(28 + TOAST_BAND - 0.5);
  });
});

describe('UX-I7 N5-i an expired session in Đang xem', () => {
  const row: SessionRowView = { sessionId: 's1', projectId: 'p1', seq: 1, title: null, state: 'ended', startedAt: 1, endedAt: 2, accountFirst: 'pm@x',
    accountLast: 'pm@x', lanes: 0, tokens: { input: 1, output: 0, cacheWrite: 0, cacheRead: 0 }, costUsd: 1, endReason: 'ended_by_po', handoffPath: null,
    ctxLast: 61_000, resumable: false, reason: { key: 'errors.noTranscript', params: { days: 30 } } };
  const view = (r: SessionRowView) => html(<SessionView row={r} channel="mac" offline={false} stream={undefined} onResume={() => {}} onOpenHandoff={() => {}}
    loadPreview={() => Promise.resolve(null)} onOlder={() => {}} onJumpEnd={() => {}} hideTools={false} />);
  test('UX-I7 main button = "Phiên mới từ 50 dòng cuối", "Chạy tiếp…" dimmed, the engine reason in a box after the buttons', () => {
    const h = view(row);
    expect(h).toMatch(/class="btn sm pri"[^>]*>.*Phiên mới từ 50 dòng cuối/);
    expect(h).toMatch(/<button type="button" class="btn sm" disabled="">.*?Chạy tiếp…/);
    expect(h.indexOf('Chạy tiếp…')).toBeLessThan(h.indexOf('preview bad'));
    expect(text(h)).toContain('Không chạy tiếp được: Claude Code đã xoá bản ghi sau 30 ngày (cleanupPeriodDays)');
  });
  test('UX-I7 with a handoff the main button is "Phiên mới từ handoff #1"; resumable → "Chạy tiếp…" is the main one, no box', () => {
    expect(view({ ...row, handoffPath: '/h.md' })).toMatch(/class="btn sm pri"[^>]*>.*Phiên mới từ handoff #1/);
    const ok = view({ ...row, resumable: true, reason: null });
    expect(ok).toMatch(/class="btn sm pri"[^>]*>.*?Chạy tiếp…/);
    expect(ok).not.toContain('preview bad');
  });
});

describe('UX-M7 N1-k a card in its 5 s undo is answered', () => {
  test('UX-M7 the Chờ PO count leaves out the card being undone', () => {
    const undo = new UndoQueue(() => {}, { now: () => 0, setTimeout: () => 1, clearTimeout: () => {} });
    undo.choose(1, 'Tách', { kind: 'option', option: 1 } as never);
    const h = html(<Inbox cards={[card(1), card(2)]} focusId={null} channel="mac" offline={false} undo={undo} guard={new ClickGuard()} newIds={new Set()}
      onOpen={() => {}} onAction={() => {}} folded={false} resolvedOpen={false} onToggle={() => {}} onResolved={() => {}} />);
    expect(h).toMatch(/<span class="cnt ">1<\/span>/);
  });
});
