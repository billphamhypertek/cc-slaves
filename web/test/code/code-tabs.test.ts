// spec v2.3 §5.4 / §10.1 the tab sets of the Code view (pure): preview tab (1a), pin, close, one set per source (2a),
// duplicate names get the parent dir, localStorage restore that drops a gone source.
import { describe, expect, test } from 'bun:test';
import { closeTab, EMPTY_SET, loadTabs, openTab, pinTab, saveTabs, selectTab, tabLabels, type TabSet } from '../../src/code/tabs.ts';

const set = (tabs: [string, boolean?][], active: string | null = tabs[0]?.[0] ?? null): TabSet =>
  ({ tabs: tabs.map(([path, preview]) => ({ path, preview: !!preview })), active });
const show = (s: TabSet) => s.tabs.map(t => `${t.path}${t.preview ? '~' : ''}${t.path === s.active ? '*' : ''}`).join(' ');

describe('§5.4 tab set', () => {
  test('§5.4 one click opens a preview tab; another file opened that way replaces it in place (C25)', () => {
    const a = openTab(EMPTY_SET, 'a.ts');
    expect(show(a)).toBe('a.ts~*');
    const b = openTab(openTab(pinTab(a, 'a.ts'), 'x.md'), 'b.ts');
    expect(show(b)).toBe('a.ts b.ts~*');
    expect(show(openTab(set([['a.ts'], ['p.md', true], ['c.ts']], 'c.ts'), 'q.ts'))).toBe('a.ts q.ts~* c.ts');
  });
  test('§5.4 at most one preview tab per set', () => {
    let s = EMPTY_SET;
    for (const p of ['a', 'b', 'c', 'd']) s = openTab(s, p);
    expect(s.tabs.filter(t => t.preview).length).toBe(1);
    expect(show(s)).toBe('d~*');
  });
  test('§5.4 double click / double click on the tab / "Sửa" pins (plain name); a pinned open keeps the tab', () => {
    expect(show(openTab(EMPTY_SET, 'a.ts', true))).toBe('a.ts*');
    expect(show(pinTab(set([['a.ts', true]]), 'a.ts'))).toBe('a.ts*');
    expect(show(openTab(openTab(EMPTY_SET, 'a.ts', true), 'b.ts'))).toBe('a.ts b.ts~*');
  });
  test('§5.4 a file that already has a tab only selects it (a preview stays a preview, a pin stays pinned)', () => {
    const s = set([['a.ts'], ['b.ts', true]], 'b.ts');
    expect(show(openTab(s, 'a.ts'))).toBe('a.ts* b.ts~');
    expect(show(openTab(s, 'b.ts', true))).toBe('a.ts b.ts*');
  });
  test('§5.4 a new tab goes right of the selected one', () => {
    expect(show(openTab(set([['a'], ['b'], ['c']], 'a'), 'n', true))).toBe('a n* b c');
  });
  test('§5.4 close: the right neighbour takes over, else the left; the last tab closed → no tab (empty pane)', () => {
    expect(show(closeTab(set([['a'], ['b'], ['c']], 'b'), 'b'))).toBe('a c*');
    expect(show(closeTab(set([['a'], ['b']], 'b'), 'b'))).toBe('a*');
    expect(closeTab(set([['a']]), 'a')).toEqual(EMPTY_SET);
    expect(show(closeTab(set([['a'], ['b']], 'a'), 'b'))).toBe('a*');
  });
  test('§5.4 select', () => {
    expect(selectTab(set([['a'], ['b']]), 'b').active).toBe('b');
    expect(selectTab(set([['a']]), 'zz').active).toBe('a');
  });
  test('§5.4 same file name twice → the parent dir after the name (auth.ts src / auth.ts test); unique names alone', () => {
    const l = tabLabels(set([['engine/src/auth.ts'], ['engine/test/auth.ts'], ['README.md'], ['web/src/index.ts'], ['engine/src/lot2/index.ts']]).tabs);
    expect(l.get('engine/src/auth.ts')).toEqual({ name: 'auth.ts', dir: 'src' });
    expect(l.get('engine/test/auth.ts')).toEqual({ name: 'auth.ts', dir: 'test' });
    expect(l.get('README.md')).toEqual({ name: 'README.md', dir: null });
    expect(l.get('engine/src/lot2/index.ts')).toEqual({ name: 'index.ts', dir: 'lot2' });
    expect(tabLabels(set([['a.ts'], ['x/a.ts']]).tabs).get('a.ts')).toEqual({ name: 'a.ts', dir: null });
  });
});

describe('§5.4 remembered across app restarts (localStorage)', () => {
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }; };
  test('§5.4 path + preview + selected tab per (project, source) come back after a reload', () => {
    const ks = mem();
    saveTabs('p1', 'base', set([['a.ts'], ['b.md', true]], 'b.md'), ks);
    saveTabs('p1', 'lane:D15', set([['c.ts']]), ks);
    saveTabs('p2', 'base', set([['z.ts']]), ks);
    const { sets, dropped } = loadTabs('p1', new Set(['base', 'lane:D15']), ks);
    expect(dropped).toEqual([]);
    expect(show(sets.get('base')!)).toBe('a.ts b.md~*');
    expect(show(sets.get('lane:D15')!)).toBe('c.ts*');
    expect(sets.has('base') && !sets.has('p2')).toBe(true);
  });
  test('§5.4 a source no longer there (lane gone / worktree deleted) → its set is dropped and reported; others stay', () => {
    const ks = mem();
    saveTabs('p1', 'base', set([['a.ts']]), ks);
    saveTabs('p1', 'lane:D7', set([['b.ts']]), ks);
    const { sets, dropped } = loadTabs('p1', new Set(['base']), ks);
    expect(dropped).toEqual(['lane:D7']);
    expect([...sets.keys()]).toEqual(['base']);
    expect(loadTabs('p1', new Set(['base', 'lane:D7']), ks).sets.has('lane:D7')).toBe(false); // dropped for good
  });
  test('§5.4 an empty set is not stored; a broken value reads as nothing', () => {
    const ks = mem();
    saveTabs('p1', 'base', set([['a.ts']]), ks);
    saveTabs('p1', 'base', EMPTY_SET, ks);
    expect(loadTabs('p1', new Set(['base']), ks).sets.size).toBe(0);
    ks.setItem('ccs.code.tabs', '{not json');
    expect(loadTabs('p1', new Set(['base']), ks).sets.size).toBe(0);
    ks.setItem('ccs.code.tabs', JSON.stringify({ p1: { base: { tabs: [[1, 'x']], active: 3 } } }));
    expect(loadTabs('p1', new Set(['base']), ks).sets.size).toBe(0);
  });
});
