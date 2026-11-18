import { describe, expect, test } from 'bun:test';
import { issueKey, normTitle, parseIssueKey, progressOf } from '../../../shared/issues.ts';

describe('shared/issues.ts', () => {
  test('§5.1 R-B4 keys: T-<num> task, B-<num> bug; parse refuses anything else', () => {
    expect([issueKey('task', 47), issueKey('bug', 50)]).toEqual(['T-47', 'B-50']);
    expect(parseIssueKey(' T-47 ')).toEqual({ kind: 'task', num: 47 });
    expect(parseIssueKey('B-1')).toEqual({ kind: 'bug', num: 1 });
    for (const bad of ['t-47', 'T-0', 'T-047', 'X-3', 'T-', 'T-4a', 'T47']) expect(parseIssueKey(bad)).toBeNull();
  });

  test('§4.2-2 one progress rule: total excludes cancelled; scope = source ≠ spec not done; amend counted', () => {
    expect(progressOf([
      { state: 'done', source: 'spec' }, { state: 'todo', source: 'spec' }, { state: 'doing', source: 'lane' },
      { state: 'todo', source: 'amend' }, { state: 'done', source: 'amend' }, { state: 'cancelled', source: 'po' },
      { state: 'done', source: 'prior' },
    ])).toEqual({ done: 3, total: 6, scope: 2, cancelled: 1, amend: 2 });
    expect(progressOf([])).toEqual({ done: 0, total: 0, scope: 0, cancelled: 0, amend: 0 });
  });

  test('§5.5-7 normTitle: lower case, punctuation dropped, spaces collapsed, Vietnamese diacritics kept', () => {
    expect(normTitle('  Sửa nút "Huỷ"!!  trên   tab Tasks. ')).toBe('sửa nút huỷ trên tab tasks');
    expect(normTitle('ĐỔI MÀU')).toBe('đổi màu');
    expect(normTitle('Hủy')).not.toBe(normTitle('Huy'));
    expect(normTitle('Sửa'.normalize('NFD'))).toBe('sửa');
  });
});
