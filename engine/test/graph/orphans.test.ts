// v2.5 §5.5 D66 orphan indexes, on temp dirs only: orphan = a list_projects row whose root_path is gone (gone.ts); never a
// row with no root_path, a project root, a live lane cwd; "unknown" ones are only counted. clean() deletes only roots the
// user saw that are STILL orphans now, by the name of the freshly read row, one by one through the queue; a failure goes on.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clean, orphans, type IndexRow } from '../../src/graph/orphans.ts';

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-orph-')));
const home = join(tmp, 'home');
mkdirSync(join(home, 'Library', 'CloudStorage', 'Drive'), { recursive: true });
mkdirSync(join(tmp, 'live'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const row = (name: string, root?: string, size = 100): IndexRow => ({ name, ...(root ? { root_path: root } : {}), size_bytes: size });
const rows = [
  row('live', join(tmp, 'live')),
  row('old-wt', join(tmp, 'old-wt'), 300),
  row('gone-proj', join(tmp, 'gone-proj'), 50), // a project root that is gone: never counted
  row('lane-cwd', join(tmp, 'lane-cwd')), // the cwd of a lane not done yet
  row('drive', join(home, 'Library', 'CloudStorage', 'Drive', 'x')),
  row('noroot'),
  row('adr', join(tmp, 'adr'), 7), // D68 an index with ADRs goes too
];
const keep = new Set([join(tmp, 'gone-proj'), join(tmp, 'lane-cwd')]);

describe('§5.5 D66 orphans()', () => {
  test('only gone, not kept, with a root_path; unknown ones counted in skipped; bytes summed', () => {
    expect(orphans(rows, { home, keep })).toEqual({
      rows: [{ root_path: join(tmp, 'old-wt'), bytes: 300 }, { root_path: join(tmp, 'adr'), bytes: 7 }], bytes: 307, skipped: { n: 1 },
    });
  });
});

describe('§5.5 D66 clean()', () => {
  test('deletes the seen roots that are still orphans, by the fresh row name, in order; a failure does not stop the next', async () => {
    const removed: string[] = [];
    let listed = 0;
    const fresh = [...rows.filter((r) => r.name !== 'adr'), row('old-wt-renamed', join(tmp, 'old-wt'), 300), row('x2', join(tmp, 'x2'), 9)];
    const r = await clean([join(tmp, 'old-wt'), join(tmp, 'adr'), join(tmp, 'live'), join(tmp, 'lane-cwd'), join(tmp, 'x2'), '/not/seen/before'], {
      home, keep: () => keep,
      list: async () => { listed++; return fresh.filter((x) => x.name !== 'old-wt'); },
      queue: { remove: async (name) => { removed.push(name); return name === 'old-wt-renamed' ? { ok: false, line: 'locked' } : { ok: true }; } },
    });
    expect(listed).toBe(1);
    // adr: no longer listed → nothing to delete; live / lane-cwd: not orphans now; /not/seen: no row
    expect(removed).toEqual(['old-wt-renamed', 'x2']);
    expect(r).toEqual({ deleted: 1, bytes: 9, failed: 1, error: 'locked' });
  });
  test('a root that came back since the dialog is kept', async () => {
    mkdirSync(join(tmp, 'back'));
    const removed: string[] = [];
    const r = await clean([join(tmp, 'back')], {
      home, keep: () => new Set(), list: async () => [row('back', join(tmp, 'back'))],
      queue: { remove: async (n) => { removed.push(n); return { ok: true }; } },
    });
    expect(removed).toEqual([]);
    expect(r).toEqual({ deleted: 0, bytes: 0, failed: 0 });
  });
});
