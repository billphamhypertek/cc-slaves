// v2.5 §5.5 the one "directory is gone" test (A10), on temp dirs only: gone ⇔ lstat says ENOENT / ENOTDIR, the nearest
// existing ancestor lists, and neither the path nor that ancestor sits on cloud storage or an unmounted volume.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gone } from '../../src/graph/gone.ts';

let tmp: string;
let home: string;
let vols: string;
const opts = () => ({ home, volumes: vols });

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-gone-')));
  home = join(tmp, 'home');
  vols = join(tmp, 'Volumes');
  mkdirSync(join(home, 'Library', 'CloudStorage', 'GoogleDrive-x'), { recursive: true });
  mkdirSync(join(vols, 'Ext'), { recursive: true });
  mkdirSync(join(tmp, 'here'));
  writeFileSync(join(tmp, 'file'), 'x');
  mkdirSync(join(tmp, 'locked', 'inner'), { recursive: true });
  chmodSync(join(tmp, 'locked'), 0o000);
  mkdirSync(join(tmp, 'nolist'));
  chmodSync(join(tmp, 'nolist'), 0o300); // traversable, not listable
  mkdirSync(join(tmp, 'rnox'));
  chmodSync(join(tmp, 'rnox'), 0o444); // listable, not traversable: lstat of a child says EACCES
});
afterAll(() => {
  chmodSync(join(tmp, 'locked'), 0o755);
  chmodSync(join(tmp, 'nolist'), 0o755);
  chmodSync(join(tmp, 'rnox'), 0o755);
  rmSync(tmp, { recursive: true, force: true });
});

describe('§5.5 gone()', () => {
  test('a directory that exists (or a dangling symlink: lstat succeeds) is present', () => {
    expect(gone(join(tmp, 'here'), opts())).toBe('present');
    symlinkSync(join(tmp, 'nowhere'), join(tmp, 'dangling'));
    expect(gone(join(tmp, 'dangling'), opts())).toBe('present');
  });
  test('ENOENT under a listable ancestor → gone, also several levels deep', () => {
    expect(gone(join(tmp, 'deleted'), opts())).toBe('gone');
    expect(gone(join(tmp, 'a', 'b', 'c'), opts())).toBe('gone');
  });
  test('ENOTDIR (a file where a dir was) → gone', () => {
    expect(gone(join(tmp, 'file', 'wt'), opts())).toBe('gone');
  });
  test('EACCES (parent not readable) → unknown, never gone', () => {
    expect(gone(join(tmp, 'locked', 'inner'), opts())).toBe('unknown');
    expect(gone(join(tmp, 'locked', 'gone-for-real'), opts())).toBe('unknown');
    expect(gone(join(tmp, 'rnox', 'x'), opts())).toBe('unknown'); // the parent lists fine: only the lstat code tells
  });
  test('the nearest existing ancestor cannot be listed → unknown', () => {
    expect(gone(join(tmp, 'nolist', 'x'), opts())).toBe('unknown');
  });
  test('under ~/Library/CloudStorage/ → always unknown (by the literal path and by the ancestor real path)', () => {
    expect(gone(join(home, 'Library', 'CloudStorage', 'GoogleDrive-x', 'proj'), opts())).toBe('unknown');
    symlinkSync(join(home, 'Library', 'CloudStorage', 'GoogleDrive-x'), join(tmp, 'drive'));
    expect(gone(join(tmp, 'drive', 'proj'), opts())).toBe('unknown');
  });
  test('under /Volumes/<name>: not a mount point (same st_dev as /Volumes) or missing → unknown', () => {
    expect(gone(join(vols, 'Ext', 'proj'), opts())).toBe('unknown');
    expect(gone(join(vols, 'Unplugged', 'proj'), opts())).toBe('unknown');
  });
  test('a mounted volume (st_dev differs) is checked like any directory', () => {
    const o = { ...opts(), devOf: (p: string) => (p === join(vols, 'Ext') ? 2 : 1) };
    expect(gone(join(vols, 'Ext', 'proj'), o)).toBe('gone');
  });
});
