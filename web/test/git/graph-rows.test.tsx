// spec v2.3 §6.1 Đồ thị rows (web/src/git/GraphRows.tsx): 26 px rows, labels only at branch heads, hover text, virtualising.
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { GraphRows, type GraphEntry } from '../../src/git/GraphRows.tsx';
import { LangProvider } from '../../src/lib/i18n.tsx';

const NOW = new Date(2026, 10, 16, 14, 0).getTime(), M = 60_000;
const e = (hash: string, parents: string[], subject: string, ago: number, branches: string[] = []): GraphEntry =>
  ({ hash, parents, subject, author: 'PO', time: NOW - ago, branches });
const color = (ref: string | null) => (ref === 'main' ? 'var(--accent)' : 'var(--ok)');
const html = (commits: GraphEntry[], over: { narrow?: boolean; selected?: string } = {}) => renderToStaticMarkup(
  <LangProvider lang="vi"><GraphRows commits={commits} base="main" color={color} now={NOW} {...over} /></LangProvider>);
const G5 = [
  e('d300000a', ['d200000a'], 'D15: verify rỗng trả false', 5 * M, ['lane/d15']),
  e('d200000a', ['m200000a'], 'D15: tách loadKeys', 20 * M),
  e('m200000a', [], 'B2: sửa cookie thiết bị', 120 * M, ['main']),
];

describe('§6.1 GraphRows', () => {
  test('§6.1 one row per commit: rail + subject + label at the branch head only + relative time', () => {
    const h = html(G5);
    expect(h.match(/class="grow/g)?.length).toBe(3);
    expect(h.match(/class="gref"/g)?.length).toBe(2);
    expect(h).toContain('>lane/d15</span>');
    expect(h).toContain('>5 ph</span>');
    expect(h).toContain('>2 giờ</span>');
    expect(h).toContain('title="16/11/2026 13:55 · d300000 · PO"');
    expect(h).toContain('viewBox="0 0 28 26"'); // two columns, mockup rail
  });
  test('§6.1 base line --accent, lane line its colour', () => {
    const h = html(G5);
    expect(h).toContain('stroke:var(--accent)');
    expect(h).toContain('stroke:var(--ok)');
  });
  test('§6.1 < 1280 px: long labels hidden, short kept', () => {
    const h = html([{ ...G5[0]!, branches: ['lane/v23-graph-rows'] }, ...G5.slice(1)], { narrow: true });
    expect(h).not.toContain('lane/v23-graph-rows</span>');
    expect(h).toContain('>main</span>');
  });
  test('§6.1 the selected commit is marked', () => {
    expect(html(G5, { selected: 'd200000a' })).toContain('class="grow sel" aria-pressed="true"');
  });
  test('§10.1 > 200 rows → virtualised; 200 → all rendered', () => {
    const chain = (n: number) => Array.from({ length: n }, (_, i) => e(`c${i}`, i < n - 1 ? [`c${i + 1}`] : [], `s${i}`, i * M, i ? [] : ['main']));
    expect(html(chain(200)).match(/class="grow/g)?.length).toBe(200);
    const big = html(chain(201));
    expect(big.match(/class="grow/g)!.length).toBeLessThan(60);
    expect(big).toMatch(/style="height:\d+px" aria-hidden/);
  });
});
