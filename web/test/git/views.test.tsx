// spec v2.3 §6.1 / §6.2 / §7 the Git column and diff pane, rendered statically (G1 conflict row, G6 not measured, G11 offline,
// G4 base dirty, G14 no commit, G10 nothing to show).
import { describe, expect, test } from 'bun:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadLazyNs } from '../../../shared/i18n/lazy.ts';
import type { GitBranchesResult, LaneBranch } from '../../../shared/protocol.ts';
import { Branches, type BranchesProps } from '../../src/git/Branches.tsx';
import { Changes, type ChangesProps } from '../../src/git/Changes.tsx';
import { Conflict, DiffPane, Merged, mergedShown, type DiffPaneProps } from '../../src/git/DiffPane.tsx';
import { GraphMore, NoGit } from '../../src/git/GitView.tsx';
import type { LaneRow } from '../../src/git/model.ts';
import { LangProvider } from '../../src/lib/i18n.tsx';

loadLazyNs();
const html = (el: ReactElement) => renderToStaticMarkup(<LangProvider lang="vi">{el}</LangProvider>);
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const br = (o: Partial<LaneBranch> = {}): LaneBranch =>
  ({ name: 'lane/d15', base: 'main', state: 'unmerged', ahead: 3, files: 4, add: 18, del: 6, measuredAt: 0, behind: 1, conflicts: [], ...o });
const row = (o: Partial<LaneBranch> = {}, lane = 'D15'): LaneRow => ({ lane, branch: `lane/${lane.toLowerCase()}`, state: 'waiting_po', b: br(o) });
const res: GitBranchesResult = { base: { name: 'main', unpushed: 1, dirty: 1 }, lanes: [] };
const bp = (o: Partial<BranchesProps> = {}): BranchesProps => ({ res, rows: { top: [row({ conflicts: ['engine/src/lanes.ts'] })], merged: [] }, pick: { k: 'lane', lane: 'D15' },
  onPick() {}, empty: false, offline: false, onRetry() {}, folded: false, onFold() {}, direct: null, ...o });

describe('§6.1 Nhánh', () => {
  test('§6.1 G1 base row says dirty + unpushed; a conflicting lane shows ↑3 ↓1 and "1 xung đột"', () => {
    const t = text(html(<Branches {...bp()} />));
    expect(t).toContain('1 file chưa commit');
    expect(t).toContain('↑1 chưa push');
    expect(t).toContain('↑3 ↓1');
    expect(t).toContain('1 xung đột');
  });
  test('§6.1 G6 not measured: old ↑↓ kept, "Không đo được · Thử lại", the English reason never shown as text', () => {
    const h = html(<Branches {...bp({ rows: { top: [row({ state: 'unknown', conflicts: undefined, reason: 'timeout' })], merged: [] } })} />);
    expect(text(h)).toContain('↑3 ↓1');
    expect(text(h)).toContain('Không đo được · Thử lại');
    expect(h).not.toContain('timeout');
  });
  test('§7 G11 offline: "Thử lại" is disabled', () => {
    const h = html(<Branches {...bp({ offline: true, rows: { top: [row({ state: 'unknown', reason: 'x' })], merged: [] } })} />);
    expect(h).toMatch(/<button[^>]*disabled[^>]*>Thử lại/);
  });
  test('§6.1 G14 no commit on base: "chưa có commit"; > 12 branches gets "Lọc nhánh"', () => {
    expect(text(html(<Branches {...bp({ empty: true, rows: { top: [], merged: [] } })} />))).toContain('chưa có commit');
    const many = Array.from({ length: 12 }, (_, i) => row({}, `D${i}`));
    expect(html(<Branches {...bp({ rows: { top: many, merged: [] } })} />)).toContain('Lọc nhánh');
    expect(html(<Branches {...bp({ rows: { top: many.slice(1), merged: [] } })} />)).not.toContain('Lọc nhánh');
  });
  test('§7 G5 a lane being re-measured → "đang đo lại…" in the Nhánh head; none → no note', () => {
    expect(html(<Branches {...bp({ rows: { top: [row({ measuring: true })], merged: [] } })} />)).toMatch(/<span class="gm mut"><svg[^]*?<span>đang đo lại…<\/span><\/span>/); // UX M6: .gm keeps a gap after the spinner
    expect(html(<Branches {...bp()} />)).not.toContain('đang đo lại…');
  });
});

describe('§6.1 Đồ thị / §7 G7', () => {
  test('§6.1 the graph\'s "Tải thêm" shows while the engine has more, greyed while a page loads', () => {
    expect(html(<GraphMore log={{ more: true, loading: false, loadMore() {} }} />)).toMatch(/<button type="button" class="glink gmore">Tải thêm<\/button>/);
    expect(html(<GraphMore log={{ more: true, loading: true, loadMore() {} }} />)).toMatch(/<button[^>]*disabled=""[^>]*>Tải thêm/);
    expect(html(<GraphMore log={{ more: false, loading: false, loadMore() {} }} />)).toBe('');
  });
  test('§7 G7 not a git repo: "Sang Code" button with the reason', () => {
    const h = html(<NoGit toCode={() => {}} />);
    expect(h).toContain('class="gnogit"');
    expect(h).toMatch(/<button type="button" class="gbt"><svg[^]*?Sang Code<\/button>/);
  });
});

const cp = (o: Partial<ChangesProps> = {}): ChangesProps => ({ title: 'Thay đổi', files: [{ path: 'engine/src/auth.ts', status: 'M', add: 9, del: 4 },
  { path: 'engine/src/lanes.ts', status: 'M', add: 4, del: 1, conflict: true }], err: null, total: { add: 18, del: 6 }, commit: null, onCloseCommit() {}, dirty: null,
  empty: 'Lane chưa đổi file nào so với main.', pick: null, onPick() {}, asks: [{ label: 'Nhờ D15 rebase…', who: { k: 'lane', name: 'D15' }, text: 'x' }],
  onAsk() {}, offline: false, width: 360, folded: false, onFold() {}, ...o });

describe('§6.1 Thay đổi', () => {
  test('§6.1 conflicted files first, +18 −6, the ask buttons; offline (G11) disables them', () => {
    const h = html(<Changes {...cp()} />);
    expect(h.indexOf('lanes.ts')).toBeLessThan(h.indexOf('auth.ts'));
    expect(text(h)).toContain('+18 −6');
    expect(h).not.toMatch(/<button[^>]*disabled[^>]*>.*Nhờ D15 rebase/);
    expect(html(<Changes {...cp({ offline: true })} />)).toMatch(/<button[^>]*disabled[^>]*>(<svg.*?<\/svg>)?Nhờ D15 rebase/);
  });
  test('§6.7 D53 a file row cuts name + folder by their measured width (row font), row pad = git.css .gfr tokens (52.2)', () => {
    const path = 'web/src/very/deep/folder/structure/components/a-really-long-component-file-name.tsx';
    const h = html(<Changes {...cp({ files: [{ path, status: 'M', add: 1, del: 1 }], width: 260 })} />);
    const nm = /class="gfn">([^<]+)</.exec(h)![1]!, dir = /class="gdir">([^<]+)</.exec(h)![1]!;
    // no DOM: a mono glyph is 0.6 em — name --sm 13 → 7.8 px, folder --xs 12 → 7.2 px. Row pad as measured in the app (C3/G4,
    // 1440 + 1180): border 1 + pad --s5 14 / --s4 10 + icon 12 + gaps 2 × --s2 + the status letter (--xs, 7.2) = 52.2
    const room = 260 - 52.2, NM = 7.8, DIR = 7.2;
    expect(nm.length * NM).toBeLessThanOrEqual(room - 90); // the folder + its gap keep ≤ 90
    expect(nm.length * NM).toBeGreaterThan(room - 90 - 2 * NM);
    expect(dir.length * DIR).toBeLessThanOrEqual(room - nm.length * NM - 4);
    expect(dir.length * DIR).toBeGreaterThan(room - nm.length * NM - 4 - 2 * DIR);
  });
  test('§6.1 G10 an empty list says why; null files = loading skeleton', () => {
    expect(text(html(<Changes {...cp({ files: [], asks: [] })} />))).toContain('Lane chưa đổi file nào so với main.');
    expect(text(html(<Changes {...cp({ files: [], asks: [], total: { add: 0, del: 0 } })} />))).not.toContain('+0');
    expect(html(<Changes {...cp({ files: null })} />)).toContain('gskel');
  });
});

const dp = (o: Partial<DiffPaneProps> = {}): DiffPaneProps => ({ path: 'engine/src/lanes.ts', mark: 'M', none: false,
  diff: { old: { kind: 'text', text: 'a\nb\n' }, new: { kind: 'text', text: 'a\nB\n' } }, err: null, pill: null, base: 'main', branch: 'lane/d15',
  onOpenCode() {}, onVscode() {}, log: [], now: 0, narrow: false, width: 900, ...o });

describe('§6.2 diff pane', () => {
  test('§6.2 two gutters: the deleted line keeps its old number, the added one its new number', () => {
    const h = html(<DiffPane {...dp()} />);
    expect(h).toMatch(/gcl d"><span class="no">2<\/span><span class="no"><\/span>/);
    expect(h).toMatch(/gcl a"><span class="no"><\/span><span class="no">2<\/span>/);
  });
  test('§6.2 binary file → a message, no rows; file not on disk → buttons disabled', () => {
    const h = html(<DiffPane {...dp({ diff: { old: { kind: 'binary' }, new: { kind: 'binary' } }, onOpenCode: null, onVscode: null })} />);
    expect(h).not.toContain('gcl ');
    expect(h).toMatch(/<button[^>]*disabled/);
  });
  test('§6.2 conflict block → "Xem cả file đã gộp thử"; that file\'s trial merge replaces the body with "Về diff"', () => {
    const conflict = { merged: { kind: 'text' as const, text: 'a\n<<<<<<< main\nb\n=======\nB\n>>>>>>> lane/d15\n' }, hunks: [{ start: 2, end: 6 }], lastBaseCommit: null };
    const d = { ...dp().diff!, conflict } as NonNullable<DiffPaneProps['diff']>;
    expect(html(<Conflict d={conflict as never} base="main" branch="lane/d15" log={[]} now={0} onMerged={() => {}} />)).toMatch(/<button type="button" class="glink">Xem cả file đã gộp thử<\/button>/);
    expect(mergedShown('engine/src/lanes.ts', 'engine/src/lanes.ts', d)).toBe(conflict.merged.text);
    expect(mergedShown(null, 'engine/src/lanes.ts', d)).toBeNull(); // "Về diff" sets it back to null
    expect(mergedShown('other.ts', 'engine/src/lanes.ts', d)).toBeNull(); // another file picked → its diff
    expect(mergedShown('engine/src/lanes.ts', 'engine/src/lanes.ts', { ...d, conflict: { ...conflict, merged: { kind: 'binary' } } } as never)).toBeNull();
    const m = html(<Merged textOf={conflict.merged.text} onBack={() => {}} />);
    expect(m).toMatch(/Bản gộp thử · chỉ đọc<\/span><button type="button" class="glink">Về diff<\/button>/);
    expect(m).toContain('class="gcl mk"');
  });
});
