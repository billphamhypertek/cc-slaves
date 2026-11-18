// v2 §5.2 / §5.5 / §6 A9: merge planner + apply, toggle off, per-account check state, new unknown entries. Temp dirs only.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyLayout, planLayout, SHARED_ENTRIES } from '../../src/accounts/layout.ts';
import {
  clashCopies, mergeShared, nodeMergeFs, newUnknownEntries, planMerge, SharedCfgState, unshareEntry, watchClaudeRoot,
} from '../../src/accounts/shared-cfg.ts';

let tmp: string;
let home: string;
let acct: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-sharedcfg-'));
  home = join(tmp, 'claude');
  acct = join(tmp, 'accts', 'aaaaaaaaaaaa');
  applyLayout(planLayout(home, acct));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** Claude Code created a real `<acct>/<name>` (the §5.5 real-entry case). */
function realDir(name: string, files: Record<string, string>): void {
  rmSync(join(acct, name), { force: true }); // the link (never its target)
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(acct, name, rel, '..'), { recursive: true });
    writeFileSync(join(acct, name, rel), body);
  }
}

describe('§5.5 merge planner', () => {
  test('§5.5 no clash → plan lists every file under <acct>/<name>, nothing on disk changes', () => {
    realDir('plans', { 'a.md': 'A', 'sub/b.md': 'B' });
    mkdirSync(join(home, 'plans', 'sub'), { recursive: true });
    writeFileSync(join(home, 'plans', 'keep.md'), 'K');
    const p = planMerge(home, acct, 'plans');
    expect(p).toEqual({ ok: true, name: 'plans', files: ['a.md', 'sub/b.md'], clashes: [] });
    expect(readFileSync(join(acct, 'plans', 'a.md'), 'utf8')).toBe('A');
    expect(lstatSync(join(acct, 'plans')).isDirectory()).toBe(true);
  });

  test('§5.5 clash → refuses with the clash list and changes nothing (dry-run and apply)', () => {
    realDir('plans', { 'a.md': 'mine', 'sub/b.md': 'B', 'c.md': 'C' });
    mkdirSync(join(home, 'plans', 'sub'), { recursive: true });
    writeFileSync(join(home, 'plans', 'a.md'), 'theirs');
    writeFileSync(join(home, 'plans', 'sub', 'b.md'), 'theirs-b');
    expect(planMerge(home, acct, 'plans')).toMatchObject({ ok: false, reason: 'clash', clashes: ['a.md', 'sub/b.md'] });
    const r = mergeShared(home, acct, 'plans', { now: () => 0 });
    expect(r).toMatchObject({ ok: false, reason: 'clash', clashes: ['a.md', 'sub/b.md'] });
    expect(readFileSync(join(home, 'plans', 'a.md'), 'utf8')).toBe('theirs');
    expect(readFileSync(join(acct, 'plans', 'c.md'), 'utf8')).toBe('C');
    expect(existsSync(join(home, 'plans', 'c.md'))).toBe(false);
    expect(readdirSync(acct).some((n) => n.includes('cc-slaves-bak'))).toBe(false);
  });

  test('§5.5 a dir in the account where ~/.claude has a file of that name is a clash', () => {
    realDir('plans', { 'x/y.md': 'Y' });
    writeFileSync(join(home, 'plans', 'x'), 'file');
    expect(planMerge(home, acct, 'plans')).toMatchObject({ ok: false, reason: 'clash', clashes: ['x'] });
  });

  test('§5.5 only a shared entry that is a real dir can be merged', () => {
    expect(planMerge(home, acct, 'plans')).toMatchObject({ ok: false, reason: 'not_real_dir' }); // still a link
    expect(planMerge(home, acct, 'settings.json')).toMatchObject({ ok: false, reason: 'not_shared' });
    expect(planMerge(home, acct, '../x')).toMatchObject({ ok: false, reason: 'not_shared' });
    expect(planMerge(home, acct, 'hooks')).toMatchObject({ ok: false, reason: 'not_shared' }); // unknown, not toggled
    mkdirSync(join(acct, 'hooks'));
    expect(planMerge(home, acct, 'hooks', { extraShared: ['hooks'] })).toMatchObject({ ok: true, files: [] });
  });

  test('§5.5 merge moves the files, renames the old dir to <name>.cc-slaves-bak-<ts> (never deleted), creates the link', () => {
    realDir('projects', { '-p/s1.jsonl': 'S1', 'top.txt': 'T' });
    writeFileSync(join(home, 'projects', 'canary.jsonl'), 'keep');
    const ts = Date.UTC(2026, 10, 15, 3, 4, 5);
    const r = mergeShared(home, acct, 'projects', { now: () => ts });
    expect(r).toMatchObject({ ok: true, moved: ['-p/s1.jsonl', 'top.txt'] });
    const bak = (r as { backup: string }).backup;
    expect(bak).toBe(join(acct, 'projects.cc-slaves-bak-20261115-030405'));
    expect(lstatSync(bak).isDirectory()).toBe(true);
    expect(readdirSync(join(bak, '-p'))).toEqual([]); // emptied, kept
    expect(readFileSync(join(home, 'projects', '-p', 's1.jsonl'), 'utf8')).toBe('S1');
    expect(readFileSync(join(home, 'projects', 'canary.jsonl'), 'utf8')).toBe('keep');
    expect(readlinkSync(join(acct, 'projects'))).toBe(join(home, 'projects'));
  });

  test('§5.5 a second backup in the same second gets its own name', () => {
    mkdirSync(join(acct, 'plans.cc-slaves-bak-19700101-000000'));
    realDir('plans', { 'a.md': 'A' });
    const r = mergeShared(home, acct, 'plans', { now: () => 0 });
    expect((r as { backup: string }).backup).toBe(join(acct, 'plans.cc-slaves-bak-19700101-000000-1'));
  });
});

describe('G4 UX I2 §6 A9C both copies of a clash: folder + mtime', () => {
  test('§6 A9C each clash lists the account copy and the ~/.claude copy with their mtimes', () => {
    realDir('plans', { 'a.md': 'mine', 'ok.md': 'x' });
    mkdirSync(join(home, 'plans'), { recursive: true });
    writeFileSync(join(home, 'plans', 'a.md'), 'theirs');
    const p = planMerge(home, acct, 'plans');
    const mt = (x: string) => (x.startsWith(acct) ? 2000 : 1000);
    expect(clashCopies(home, acct, p, mt)).toEqual([{
      file: 'a.md',
      account: { dir: join(acct, 'plans'), path: join(acct, 'plans', 'a.md'), mtime: 2000 },
      shared: { dir: join(home, 'plans'), path: join(home, 'plans', 'a.md'), mtime: 1000 },
    }]);
    expect(clashCopies(home, acct, planMerge(home, acct, 'settings.json'))).toEqual([]);
  });
  test('§6 A9C the real mtime is read from disk (lstat)', () => {
    realDir('plans', { 'a.md': 'mine' });
    mkdirSync(join(home, 'plans'), { recursive: true });
    writeFileSync(join(home, 'plans', 'a.md'), 'theirs');
    const [c] = clashCopies(home, acct, planMerge(home, acct, 'plans'));
    expect(c!.account.mtime).toBe(Math.round(lstatSync(join(acct, 'plans', 'a.md')).mtimeMs));
  });
});

describe('MINOR-1 §5.5 merge never overwrites a file that appears between plan and move', () => {
  test('MINOR-1 §5.5 a same-name file written into ~/.claude after the plan → clash reported, the newer file kept, nothing linked', () => {
    realDir('projects', { 's/x.jsonl': 'ACCOUNT-COPY', 's/y.jsonl': 'Y' });
    let first = true;
    const race = <A extends unknown[]>(f: (...a: A) => void) => (...a: A) => {
      if (first) { first = false; mkdirSync(join(home, 'projects', 's'), { recursive: true }); writeFileSync(join(home, 'projects', 's', 'x.jsonl'), 'LIVE'); }
      f(...a);
    };
    // whichever primitive moves the first file, the clash lands right before it
    const fs = { ...nodeMergeFs, rename: race((a: string, b: string) => renameSync(a, b)), link: race((a: string, b: string) => linkSync(a, b)) };
    const r = mergeShared(home, acct, 'projects', { fs });
    expect(r).toMatchObject({ ok: false, reason: 'clash', clashes: ['s/x.jsonl'] });
    expect(readFileSync(join(home, 'projects', 's', 'x.jsonl'), 'utf8')).toBe('LIVE');
    expect(readFileSync(join(acct, 'projects', 's', 'x.jsonl'), 'utf8')).toBe('ACCOUNT-COPY'); // the account copy kept too
    expect(lstatSync(join(acct, 'projects')).isDirectory()).toBe(true); // no backup rename, no link
  });

  test('MINOR-1 §5.5 a link inside the real dir moves as a link (never followed into a copy)', () => {
    realDir('plans', { 'a.md': 'A' });
    writeFileSync(join(tmp, 'outside.md'), 'O');
    symlinkSync(join(tmp, 'outside.md'), join(acct, 'plans', 'l.md'));
    const r = mergeShared(home, acct, 'plans');
    expect(r).toMatchObject({ ok: true, moved: ['a.md', 'l.md'] });
    expect(readlinkSync(join(home, 'plans', 'l.md'))).toBe(join(tmp, 'outside.md'));
    expect(readFileSync(join(home, 'plans', 'a.md'), 'utf8')).toBe('A');
  });
});

describe('§5.2 toggle off', () => {
  test('§5.2 toggle off removes only the link; the ~/.claude target and its files survive', () => {
    mkdirSync(join(home, 'hooks'));
    writeFileSync(join(home, 'hooks', 'pre.sh'), 'echo');
    applyLayout(planLayout(home, acct, { extraShared: ['hooks'] }));
    expect(readlinkSync(join(acct, 'hooks'))).toBe(join(home, 'hooks'));
    expect(unshareEntry(home, acct, 'hooks')).toBe(true);
    expect(existsSync(join(acct, 'hooks'))).toBe(false);
    expect(readFileSync(join(home, 'hooks', 'pre.sh'), 'utf8')).toBe('echo');
  });

  test('§5.2 toggle off leaves a real dir and a foreign link alone; refuses non-unknown names', () => {
    mkdirSync(join(acct, 'tools'));
    expect(unshareEntry(home, acct, 'tools')).toBe(false);
    expect(lstatSync(join(acct, 'tools')).isDirectory()).toBe(true);
    symlinkSync(join(tmp, 'elsewhere'), join(acct, 'docs'));
    expect(unshareEntry(home, acct, 'docs')).toBe(false);
    expect(lstatSync(join(acct, 'docs')).isSymbolicLink()).toBe(true);
    expect(() => unshareEntry(home, acct, 'projects')).toThrow();
  });
});

describe('§5.5 per-account check state', () => {
  const A = { email: 'ba@x.test', configDir: '' };
  test('§5.5 heal fixes a missing link; a real dir flags the account (ok=false) until it is merged', () => {
    const st = new SharedCfgState({ claudeHome: () => home, extraShared: () => [] });
    rmSync(join(acct, 'todos'));
    const a = { ...A, configDir: acct };
    expect(st.check(a)).toMatchObject({ ok: true, issues: [] });
    expect(readlinkSync(join(acct, 'todos'))).toBe(join(home, 'todos'));
    realDir('plans', { 'a.md': 'A' });
    expect(st.check(a)).toMatchObject({ ok: false, issues: [{ kind: 'real-entry', name: 'plans' }] });
    expect([...st.flagged()]).toEqual(['ba@x.test']);
    mergeShared(home, acct, 'plans', { now: () => 0 });
    expect(st.check(a).ok).toBe(true);
    expect(st.flagged().size).toBe(0);
  });

  test('§5.5 check before spawn ≤ 20 ms on an 11-link account', () => {
    expect(SHARED_ENTRIES.length).toBe(11);
    const st = new SharedCfgState({ claudeHome: () => home, extraShared: () => [] });
    const a = { ...A, configDir: acct };
    st.check(a); // warm
    const times: number[] = [];
    for (let i = 0; i < 20; i++) times.push(st.check(a).ms);
    times.sort((x, y) => x - y);
    expect(times[10]!).toBeLessThanOrEqual(20);
    expect(times[19]!).toBeLessThanOrEqual(20);
  });
});

describe('§5.2 new unknown entries', () => {
  test('§5.2 only unknown names not seen before are new; shared / never / private names never are', () => {
    expect(newUnknownEntries(['projects', 'hooks', 'tools', 'teams', 'settings.json', 'x.bak'], ['tools'])).toEqual(['hooks']);
  });
});

describe('§5.5 ~/.claude root watch', () => {
  test('§5.5 a new root entry is seen by the poll even when fs.watch never fires (Bun on macOS drops events)', async () => {
    let n = 0;
    const stop = watchClaudeRoot(home, () => { n++; }, { debounceMs: 10, pollMs: 20, watch: () => ({ close() {} }) });
    try {
      await Bun.sleep(60);
      expect(n).toBe(0); // nothing changed → no callback
      mkdirSync(join(home, 'hooks'));
      const end = Date.now() + 2000;
      while (n === 0 && Date.now() < end) await Bun.sleep(10);
      expect(n).toBe(1);
    } finally { stop(); }
  });
});
