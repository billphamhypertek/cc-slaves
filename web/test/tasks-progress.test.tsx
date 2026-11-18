// v2.7 §4.2-2 THE progress rule (UX r1 I5): the Deck head strip and the Tasks tab draw one bar — length 1; green part =
// done / total; striped part = extra scope (source ≠ spec) not done / total; total = every issue except cancelled.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { progressOf } from '../../shared/issues.ts';
import { LangProvider } from '../src/lib/i18n.tsx';
import { barParts, ProgressBar } from '../src/tasks/ProgressBar.tsx';
import { issueInfo as issue } from './fixtures.ts';

const html = (el: ReactElement) => renderToStaticMarkup(<LangProvider lang="vi">{el}</LangProvider>);
// v2.5 in the mockup: 13 issues, 8 done, 2 extra scope open (1 done), 1 cancelled
const V25 = [
  ...Array.from({ length: 7 }, (_, i) => issue(i + 1, { state: 'done' })),
  issue(8, { state: 'done', source: 'lane' }), issue(9, { source: 'lane' }), issue(10, { source: 'po', state: 'doing' }),
  issue(11), issue(12, { state: 'doing' }), issue(13), issue(14, { state: 'cancelled', source: 'lane' }),
];

describe('§4.2-2 one progress rule', () => {
  test('§4.2-2 done / total and scope / total; cancelled is out of the total', () => {
    const p = progressOf(V25);
    expect(p).toMatchObject({ done: 8, total: 13, scope: 2, cancelled: 1 });
    expect(barParts(p)).toEqual({ done: 8 / 13, scope: 2 / 13 });
  });
  test('§4.2-2 nothing to count → an empty bar (no NaN); all done → full green', () => {
    expect(barParts(progressOf([]))).toEqual({ done: 0, scope: 0 });
    expect(barParts(progressOf([issue(1, { state: 'cancelled' })]))).toEqual({ done: 0, scope: 0 });
    expect(barParts(progressOf([issue(1, { state: 'done', source: 'lane' })]))).toEqual({ done: 1, scope: 0 });
  });
  test('§4.2-2 the bar draws those two widths, striped part right after the green part', () => {
    const h = html(<ProgressBar p={progressOf(V25)} />);
    expect(h).toContain('width:61.538');
    expect(h).toContain('left:61.538');
    expect(h).toContain('width:15.385%');
    expect(h).toContain('aria-label="8 xong / 13 mục · 2 phát sinh thêm phạm vi"');
  });
  test('§4.2-1 compact variant for the Deck head strip; R-B19 I3 only a done spec (lifecycle Xong) draws the grey `dn` bar', () => {
    expect(html(<ProgressBar p={progressOf(V25)} compact />)).toContain('class="tpg cp"');
    const all = progressOf([issue(1, { state: 'done' })]);
    expect(html(<ProgressBar p={all} />)).toContain('class="tpg"'); // every issue done, spec still Đang build → no grey
    expect(html(<ProgressBar p={all} finished />)).toContain('class="tpg dn"');
    expect(html(<ProgressBar p={progressOf([])} />)).not.toContain('class="s"');
  });
  test('R-B19 I3 the done bar is a neutral grey token, not green (dark + light)', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    const vals = [...css.matchAll(/--pg-dn:([^;]+);/g)].map(m => m[1]);
    expect(vals.length).toBe(2);
    for (const v of vals) expect(v).toMatch(/^var\(--fg-[23]\)$/);
  });
  test('UX I4 the list head bar is 140 px wide (90 px narrow); UX N3 only the head\'s own bar — the narrow menu\'s rail keeps 36', () => {
    const css = readFileSync(new URL('../src/tasks/IssueList.css', import.meta.url), 'utf8');
    expect(css).toContain('.tsk .lhead > .tpg{width:140px;height:4px}');
    expect(css).toContain('.tsk .tlist.nw .lhead > .tpg{width:90px}');
    expect(css).not.toMatch(/\.lhead \.tpg/); // a descendant rule reaches the SpecRail inside the narrow spec menu
  });
});
