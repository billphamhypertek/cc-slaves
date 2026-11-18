// spec v2.3 §5.3 when "Sửa" is on (③ no live session in / under / over the source dir, ④ the project dir also needs the
// orchestrator idle / stopped) and the C7 two-column view (changed lines on both sides, the differing part underlined).
import { describe, expect, test } from 'bun:test';
import type { LaneState } from '../../../shared/protocol.ts';
import { conflictView, editLock } from '../../src/code/edit.ts';

const lane = (name: string, state: LaneState, cwd: string) => ({ name, state, cwd });

describe('§5.3 edit lock', () => {
  const root = '/w/hagenta';
  test('§5.3 ③ a live lane whose cwd equals, is inside, or contains the source root locks it, naming the lane + state', () => {
    expect(editLock(root, false, [lane('D15', 'waiting_po', '/w/hagenta')], [])).toEqual({ k: 'lane', lane: 'D15', state: 'waiting_po' });
    expect(editLock(root, false, [lane('D9', 'running', '/w/hagenta/sub/dir')], [])).toEqual({ k: 'lane', lane: 'D9', state: 'running' });
    expect(editLock('/w/hagenta/sub', false, [lane('D9', 'idle', '/w/hagenta/')], [])).toEqual({ k: 'lane', lane: 'D9', state: 'idle' });
  });
  test('§5.3 ③ done / stopped / broken lanes and sibling dirs (same prefix) do not lock', () => {
    const dead = (['done', 'stopped', 'broken'] as const).map(s => lane(s, s, root));
    expect(editLock(root, false, [...dead, lane('D2', 'running', '/w/hagenta-d2')], [])).toBeNull();
  });
  test('§5.3 ④ the project dir also needs the orchestrator idle / stopped; a lane worktree ignores the orchestrator', () => {
    expect(editLock(root, true, [], [{ state: 'running' }])).toEqual({ k: 'orch' });
    expect(editLock(root, true, [], [{ state: 'idle' }, { state: 'stopped' }])).toBeNull();
    expect(editLock(root, false, [], [{ state: 'running' }])).toBeNull();
  });
});

describe('§5.3 C7 conflict view', () => {
  const head = ['import a', 'import b', '', ''];
  const disk = [...head, '/** Token trả flase. */', 'export function verify(tok) {', '  return tok ? jwt.check(tok) : false', '}', '', 'tail 1', 'tail 2'].join('\n');
  const mine = [...head, '/** Token trả false. */', 'export function verify(tok) {', '  return jwt.check(tok)', '}', '', 'tail 1', 'tail 2'].join('\n');
  test('§5.3 changed lines on both sides, one line of context, numbered as in each file; the list of lines that differ', () => {
    const v = conflictView(disk, mine);
    expect(v.changed).toEqual([5, 7]);
    const rows = (rs: typeof v.mine) => rs.map(r => ('gap' in r ? '…' : `${r.no}${r.chg ? '!' : ''}`)).join(' ');
    expect(rows(v.disk)).toBe('… 4 5! 6 7! 8 …');
    expect(rows(v.mine)).toBe('… 4 5! 6 7! 8 …');
  });
  test('§5.3 the differing part inside a changed line is marked (common head / tail kept plain)', () => {
    const v = conflictView(disk, mine);
    const r5 = v.mine.find(r => !('gap' in r) && r.no === 5);
    const d5 = v.disk.find(r => !('gap' in r) && r.no === 5);
    expect(r5 && !('gap' in r5) ? r5.u : null).toEqual([14, 19]);
    expect(d5 && !('gap' in d5) ? d5.text.slice(...d5.u!) : null).toBe('flase');
  });
  test('§5.3 added / removed lines: only one side has them marked', () => {
    const v = conflictView('a\nb\nc', 'a\nb\nx\nc');
    expect(v.changed).toEqual([3]);
    expect(v.disk.filter(r => !('gap' in r) && r.chg)).toEqual([]);
    const gone = conflictView('a\nb\nc', 'a\nc');
    expect(gone.disk.filter(r => !('gap' in r) && r.chg).map(r => !('gap' in r) && r.no)).toEqual([2]);
    expect(gone.changed).toEqual([2]);
  });
  test('§5.3 equal texts → nothing marked', () => {
    expect(conflictView('a\nb', 'a\nb').changed).toEqual([]);
  });
});
