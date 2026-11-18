// v2.3 UX review fixes on the Git view: I4 scroll fade, I5 narrow state words, M1 diff head room, M2 English plurals,
// M4 Nhánh block sized to content, M5 the mock answers a commit's diff, M6 graph rail width (the G5 spinner gap is in views.test.tsx).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '../../../shared/i18n/en.ts';
import { loadLazyNs } from '../../../shared/i18n/lazy.ts';
import type { GitBranchesResult, LaneBranch, Snapshot } from '../../../shared/protocol.ts';
import { gitReply } from '../../dev/mock-git.ts';
import { Branches, type BranchesProps } from '../../src/git/Branches.tsx';
import { headRoom } from '../../src/git/DiffPane.tsx';
import { syncFade } from '../../src/lib/fade.ts';
import { railWidth } from '../../src/git/graph.ts';
import type { LaneRow } from '../../src/git/model.ts';
import { LangProvider, type Lang } from '../../src/lib/i18n.tsx';

loadLazyNs();
const css = readFileSync(join(import.meta.dirname, '../../src/git/git.css'), 'utf8');
const first = readFileSync(join(import.meta.dirname, '../../src/styles.css'), 'utf8'); // .gfade is first paint since v2.4 m7 / m8
const rule = (sel: string) => [...css.split('\n'), ...first.split('\n')].find(l => l.startsWith(`${sel}{`)) ?? '';

/** a fake scroller: classList records the toggles */
function el(scrollHeight: number, clientHeight: number, scrollTop: number) {
  const cls = new Set<string>();
  return { scrollHeight, clientHeight, scrollTop, cls, classList: { toggle: (c: string, on: boolean) => { if (on) cls.add(c); else cls.delete(c); return on; } } };
}

describe('I4 scroll fade (G8 / G15 / G16)', () => {
  test('I4 more below → gfade + gscroll; scrolled to the end → gscroll only; fits → neither', () => {
    const e = el(1000, 200, 0);
    syncFade(e);
    expect([...e.cls].sort()).toEqual(['gfade', 'gscroll']);
    e.scrollTop = 800; syncFade(e);
    expect([...e.cls]).toEqual(['gscroll']);
    e.scrollTop = 799; syncFade(e); // one pixel left still counts as "the end" (sub-pixel rounding)
    expect([...e.cls]).toEqual(['gscroll']);
    const f = el(150, 200, 0); syncFade(f);
    expect([...f.cls]).toEqual([]);
  });
  test('m7 / m8 `up` also fades the top while content hides above (chip strip scrolled to the newest, dialog body); lists without it never', () => {
    const e = el(134, 86, 48); syncFade(e, true);
    expect([...e.cls].sort()).toEqual(['gfade-up', 'gscroll']);
    e.scrollTop = 20; syncFade(e, true);
    expect([...e.cls].sort()).toEqual(['gfade', 'gfade-up', 'gscroll']);
    e.scrollTop = 0; syncFade(e, true);
    expect([...e.cls].sort()).toEqual(['gfade', 'gscroll']);
    const g = el(1000, 200, 500); syncFade(g);
    expect(g.cls.has('gfade-up')).toBe(false);
    expect(rule('.gfade-up')).toContain('mask-image:linear-gradient(transparent,black 20px)');
  });
  test('I4 the fade masks the last 20 px; M4 the Nhánh list keeps 84 px only while it scrolls', () => {
    expect(rule('.gfade')).toContain('mask-image:linear-gradient(black calc(100% - 20px),transparent)');
    expect(css).toContain('.gblk.b1 .glst.gscroll{min-height:84px}');
    expect(css).not.toContain('.gblk.b1 .glst{min-height');
  });
});

describe('I5 narrow column: state words whole (G15)', () => {
  test('I5 .gst never shrinks or ellipsizes; the right column shrinks and cuts its text', () => {
    expect(rule('.gst')).toBe('.gst{flex:none}');
    expect(rule('.gbrow .grr')).toContain('min-width:0');
    expect(rule('.gbrow .grr>span')).toContain('flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis');
    expect(rule('.gbrow .grr>.mono,.gbrow .grr>.gspin')).toContain('flex:none'); // ↑n ↓n and the spinner never cut
    expect(rule('.gm>span')).toContain('text-overflow:ellipsis');
  });
});

const html = (el: ReactElement, lang: Lang = 'vi') => renderToStaticMarkup(<LangProvider lang={lang}>{el}</LangProvider>);
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const br = (o: Partial<LaneBranch> = {}): LaneBranch =>
  ({ name: 'lane/d15', base: 'main', state: 'unmerged', ahead: 3, files: 4, add: 18, del: 6, measuredAt: 0, behind: 1, conflicts: [], ...o });
const row = (o: Partial<LaneBranch> = {}, lane = 'D15'): LaneRow => ({ lane, branch: `lane/${lane.toLowerCase()}`, state: 'waiting_po', b: br(o) });
const res = (dirty: number): GitBranchesResult => ({ base: { name: 'main', unpushed: 1, dirty }, lanes: [] });
const bp = (o: Partial<BranchesProps> = {}): BranchesProps => ({ res: res(1), rows: { top: [row({ conflicts: ['a.ts'] })], merged: [] }, pick: { k: 'base' },
  onPick() {}, empty: false, offline: false, onRetry() {}, folded: false, onFold() {}, direct: null, ...o });

describe('M2 English plurals (G12)', () => {
  test('M2 one → singular, two → plural, never "(s)"', () => {
    const one = text(html(<Branches {...bp({ rows: { top: [row({ conflicts: ['a.ts'] })], merged: [row({ state: 'merged' }, 'B2')] } })} />, 'en'));
    expect(one).toContain('1 uncommitted file ·');
    expect(one).toContain('1 conflict ');
    expect(one).toContain('1 merged branch');
    expect(one).not.toContain('(');
    const two = text(html(<Branches {...bp({ res: res(2), rows: { top: [row({ conflicts: ['a.ts', 'b.ts'] })], merged: [row({ state: 'merged' }, 'B2'), row({ state: 'merged' }, 'B3')] } })} />, 'en'));
    expect(two).toContain('2 uncommitted files');
    expect(two).toContain('2 conflicts');
    expect(two).toContain('2 merged branches');
  });
  test('M2 no "(s)" / "(es)" left in the en git catalog', () => {
    expect(readFileSync(join(import.meta.dirname, '../../../shared/i18n/en/git.json'), 'utf8')).not.toMatch(/\((s|es)\)/);
  });
});

describe('M6 nits', () => {
  test('M6 the rail always reserves two columns: subjects never shift when no lane line is drawn', () => {
    expect(railWidth(1)).toBe(railWidth(2));
    expect(railWidth(3)).toBe(railWidth(2) + 12);
  });
});

describe('M1 diff head: the path gets the real free width', () => {
  test('M1 room = header width − padding − the other children − gaps', () => {
    // 900 px header, 28 px padding, mark 12 + pill 130 + two buttons 100 / 90, the spacer 0: 5 gaps of 10 between 6 children
    expect(headRoom(900, [12, 130, 0, 100, 90], 10, 28)).toBe(900 - 28 - 332 - 50);
    expect(headRoom(300, [12, 130, 0, 100, 90], 10, 28)).toBe(40); // never below 40
  });
});

describe('M5 the dev mock answers a commit with that commit\'s diff', () => {
  const s = { lanes: [], projects: [] } as unknown as Snapshot;
  test('M5 of.commit → no conflict block; of.branch lane/d15 → conflict', () => {
    const c = gitReply('G1', s, { cmd: 'git_diff', projectId: 'hagenta', path: 'engine/src/lanes.ts', of: { commit: 'a41c09e'.padEnd(40, '0') } }) as { ok: { conflict?: unknown; new: { text: string } } };
    expect(c.ok.conflict).toBeUndefined();
    expect(c.ok.new.text).toContain('byQuota');
    const b = gitReply('G1', s, { cmd: 'git_diff', projectId: 'hagenta', path: 'engine/src/lanes.ts', of: { branch: 'lane/d15' } }) as { ok: { conflict?: unknown } };
    expect(b.ok.conflict).toBeDefined();
  });
});
