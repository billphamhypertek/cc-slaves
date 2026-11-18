// spec v2.3 §6.1 / §4.2 / §4.3 / V18 the Git column's pure rules (web/src/git/model.ts).
import { describe, expect, test } from 'bun:test';
import { makeT } from '../../../shared/i18n/index.ts';
import type { GitBranchesResult, LaneBranch, LaneState, LaneView } from '../../../shared/protocol.ts';
import { asksFor, conflictsFirst, defaultPick, firstFile, foldsOf, laneRows, logRefs, measureOf, orderRows, reasonText, withFolds, type LaneRow } from '../../src/git/model.ts';

const tr = makeT('vi');
const br = (o: Partial<LaneBranch> = {}): LaneBranch =>
  ({ name: 'lane/d2', base: 'main', state: 'unmerged', ahead: 2, files: 4, add: 64, del: 12, measuredAt: 1, conflicts: [], behind: 0, ...o });
const row = (lane: string, state: LaneState | null, b: LaneBranch | null = br({ name: `lane/${lane.toLowerCase()}` })): LaneRow =>
  ({ lane, branch: `lane/${lane.toLowerCase()}`, state, b });
const lv = (name: string, state: LaneState, branch: LaneBranch | null = null) => ({ name, state, branch }) as LaneView;
const ctx = (r: LaneRow | null, dirty = 0) => ({ base: 'main', row: r, dirty, conflictFiles: [], dir: '/w/hagenta-d15' });

describe('§6.1 measureOf', () => {
  test('§6.1 clean / n conflicts / merged / gone / unknown / never measured / no commits ahead', () => {
    expect(measureOf(br())).toEqual({ k: 'clean' });
    expect(measureOf(br({ conflicts: ['a.ts', 'b.ts'] }))).toEqual({ k: 'conflicts', n: 2 });
    expect(measureOf(br({ state: 'merged' }))).toEqual({ k: 'merged' });
    expect(measureOf(br({ state: 'gone' }))).toEqual({ k: 'gone' });
    expect(measureOf(br({ state: 'unknown', reason: 'timeout' }))).toEqual({ k: 'unknown', reason: 'timeout' });
    expect(measureOf(null)).toEqual({ k: 'pending' });
    expect(measureOf(br({ conflicts: undefined }))).toEqual({ k: 'pending' });
    expect(measureOf(br({ ahead: 0 }))).toEqual({ k: 'noChange' });
  });
});

describe('§10.2 / E1 reasonText', () => {
  test('§10.2 "repo configures a program (k)" and baseError.program → "repo cấu hình chạy chương trình (k)"', () => {
    expect(reasonText(tr, 'repo configures a program (filter.lfs.process)')).toBe('repo cấu hình chạy chương trình (filter.lfs.process)');
    expect(reasonText(tr, 'whatever', 'diff.external')).toBe('repo cấu hình chạy chương trình (diff.external)');
    expect(reasonText(tr, 'timeout')).toBe('quá 5 s');
    expect(reasonText(tr, 'fatal: bad object')).toBe('fatal: bad object');
  });
});

describe('§4.2 defaultPick', () => {
  const res: GitBranchesResult = { base: { name: 'main', unpushed: 0 }, lanes: [{ lane: 'D15', name: 'lane/d15', branch: null }] };
  test('§4.2 Điều phối / account / done list → base; a lane listed → its branch; a sub → its parent lane', () => {
    expect(defaultPick({ k: 'orch' }, [], res)).toEqual({ k: 'base' });
    expect(defaultPick({ k: 'account', email: 'a@b' }, [], res)).toEqual({ k: 'base' });
    expect(defaultPick({ k: 'lane', name: 'D15' }, [], res)).toEqual({ k: 'lane', lane: 'D15' });
    expect(defaultPick({ k: 'sub', lane: 'D15', taskId: 't' } as never, [], res)).toEqual({ k: 'lane', lane: 'D15' });
  });
  test('§4.2 no worktree: branch still there → the lane branch; deleted / runs in the repo → base', () => {
    expect(defaultPick({ k: 'doneLane', name: 'D7' }, [lv('D7', 'done', br({ name: 'lane/d7' }))], res)).toEqual({ k: 'lane', lane: 'D7' });
    expect(defaultPick({ k: 'doneLane', name: 'D7' }, [lv('D7', 'done', br({ name: 'lane/d7', state: 'gone' }))], res)).toEqual({ k: 'base' });
    expect(defaultPick({ k: 'lane', name: 'D9' }, [lv('D9', 'running', br({ name: null, state: 'none' }))], res)).toEqual({ k: 'base' });
  });
  test('§4.2 G10 the viewed lane always has a row, even when only the snapshot knows its branch', () => {
    const rows = laneRows(res, [lv('D7', 'done', br({ name: 'lane/d7' }))], { k: 'lane', lane: 'D7' });
    expect(rows.map(r => r.branch)).toEqual(['lane/d15', 'lane/d7']);
  });
});

describe('§6.1 orderRows', () => {
  test('§6.1 live lanes in deck order, then done not merged, then deleted; merged fold apart', () => {
    const rows = [row('D7', 'done'), row('D2', 'running'), row('X', 'done', br({ state: 'gone' })), row('M', 'done', br({ state: 'merged' })), row('D15', 'waiting_po'), row('Old', null)];
    const o = orderRows(rows, ['D15', 'D2']);
    expect(o.top.map(r => r.lane)).toEqual(['D15', 'D2', 'D7', 'Old', 'X']);
    expect(o.merged.map(r => r.lane)).toEqual(['M']);
  });
});

describe('§6.2 first file', () => {
  test('§6.2 first conflict, else first file, empty → none; conflicts listed first', () => {
    const f = [{ path: 'a', status: 'M' as const }, { path: 'b', status: 'M' as const, conflict: true }];
    expect(firstFile(f)).toBe('b');
    expect(firstFile([f[0]!])).toBe('a');
    expect(firstFile([])).toBeNull();
    expect(conflictsFirst(f).map(x => x.path)).toEqual(['b', 'a']);
  });
});

describe('§6.1 V18 asks', () => {
  test('§11 người nhận "Nhờ … commit" theo trạng thái lane: live → the lane, done / stopped / broken → Điều phối, base → Điều phối', () => {
    for (const s of ['running', 'waiting_po', 'waiting_quota', 'idle', 'switching', 'draining', 'starting'] as const) {
      const a = asksFor(tr, ctx(row('D15', s, br({ ahead: 0 })), 1));
      expect(a).toEqual([{ label: 'Nhờ D15 commit…', who: { k: 'lane', name: 'D15' }, text: 'Commit các file chưa commit trong worktree của D15.' }]);
    }
    for (const s of ['done', 'stopped', 'broken', null] as const) {
      const a = asksFor(tr, ctx(row('D7', s, br({ ahead: 0 })), 2));
      expect(a).toEqual([{ label: 'Nhờ Điều phối commit…', who: { k: 'orch' }, text: 'Commit thay đổi chưa commit ở worktree của D7: /w/hagenta-d15.' }]);
    }
    expect(asksFor(tr, { ...ctx(null, 1), dir: '/w/hagenta' })).toEqual([{ label: 'Nhờ Điều phối commit…', who: { k: 'orch' }, text: 'Commit thay đổi chưa commit ở thư mục project: /w/hagenta.' }]);
    expect(asksFor(tr, ctx(null, 0))).toEqual([]);
  });
  test('§6.1 G13 merge: clean + live lane → Điều phối, warn line + "vẫn đang chạy"; done → no warn', () => {
    const [m] = asksFor(tr, ctx(row('D2', 'running', br())));
    expect(m).toEqual({ label: 'Nhờ Điều phối merge…', who: { k: 'orch' }, warn: 'D2 đang chạy · merge chỉ lấy 2 commit hiện có',
      text: 'Merge lane/d2 (2 commit, 4 file) vào main sau khi chạy lại gate. D2 vẫn đang chạy; chỉ merge các commit hiện có.' });
    expect(asksFor(tr, ctx(row('D2', 'done', br())))[0]).toEqual({ label: 'Nhờ Điều phối merge…', who: { k: 'orch' }, text: 'Merge lane/d2 (2 commit, 4 file) vào main sau khi chạy lại gate.' });
  });
  test('§6.1 G9 conflicts: live → "Nhờ D15 rebase…" to the lane; done → "Nhờ Điều phối xử lý xung đột…"', () => {
    const b = br({ name: 'lane/d15', conflicts: ['engine/src/lanes.ts'] });
    expect(asksFor(tr, ctx(row('D15', 'waiting_po', b), 1))).toEqual([
      { label: 'Nhờ D15 rebase…', who: { k: 'lane', name: 'D15' }, text: 'Rebase lane/d15 lên main rồi giải xung đột ở engine/src/lanes.ts; chạy lại test liên quan.' },
      { label: 'Nhờ D15 commit…', who: { k: 'lane', name: 'D15' }, text: 'Commit các file chưa commit trong worktree của D15.' },
    ]);
    expect(asksFor(tr, ctx(row('D15', 'done', b)))[0]!.label).toBe('Nhờ Điều phối xử lý xung đột…');
  });
  test('§6.1 G6 no merge / rebase while "Không đo được", "đang đo…" the first time, merged or no change', () => {
    for (const b of [br({ state: 'unknown', reason: 'timeout' }), br({ conflicts: undefined, measuring: true }), null, br({ state: 'merged' }), br({ ahead: 0 })]) {
      expect(asksFor(tr, ctx(row('D15', 'running', b)))).toEqual([]);
    }
    expect(asksFor(tr, ctx(row('D15', 'running', br({ state: 'unknown' })), 1)).map(a => a.label)).toEqual(['Nhờ D15 commit…']);
  });
});

describe('§6.1 graph refs + folds', () => {
  test('§6.1 filter: selected = base + branch, all lanes = [], base only', () => {
    expect(logRefs('sel', 'main', 'lane/d15')).toEqual(['main', 'lane/d15']);
    expect(logRefs('sel', 'main', null)).toEqual(['main']);
    expect(logRefs('lanes', 'main', 'lane/d15')).toEqual([]);
    expect(logRefs('base', 'main', 'lane/d15')).toEqual(['main']);
  });
  test('§6.1 folds remembered per project; bad JSON → open', () => {
    const raw = withFolds(null, 'p1', { b: true, c: false, g: true });
    expect(foldsOf(raw, 'p1')).toEqual({ b: true, c: false, g: true });
    expect(foldsOf(raw, 'p2')).toEqual({ b: false, c: false, g: false });
    expect(foldsOf('{bad', 'p1')).toEqual({ b: false, c: false, g: false });
  });
});
