// spec v2.3 §10.2 "Runner git" / §11 Engine unit "runner", "repo chạy chương trình", "option injection".
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitAt, invalidateGitConfig, type GitCall } from '../../src/git/run.ts';
import { rejects } from '../_fixtures/rejects.ts';
import { worktrees } from '../../src/git/worktrees.ts';
import { execIn, type Exec } from '../../src/setup/setup.ts';
import { commit, fixture, git, hits, trap, type Fixture } from './_repo.ts';

setDefaultTimeout(30_000);
let f: Fixture;
beforeEach(() => { f = fixture(); invalidateGitConfig(); });
afterEach(() => f.done());

const GLOBAL = ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never'];
function spy(): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, exec: async (argv, o) => { calls.push(argv); return execIn(process.env)(argv, o); } };
}
const ok = (r: Awaited<ReturnType<ReturnType<typeof gitAt>['run']>>) => {
  if (r.kind !== 'ok') throw new Error(`expected ok, got ${r.kind}: ${r.reason}`);
  return r;
};

describe('§10.2 runner: allowlist + flags', () => {
  test('§10.2 a subcommand outside the allowlist throws (programming error), git never runs', async () => {
    const s = spy();
    const g = gitAt(f.repo, { exec: s.exec });
    for (const sub of ['commit', 'push', 'worktree add', 'config', 'checkout', 'merge']) {
      await rejects(g.run({ sub } as unknown as GitCall)).toThrow(/not allowlisted/);
    }
    expect(s.calls).toEqual([]);
  });

  test('§2 §10.2 the allowlist is exactly the read set: every other git command (and worktree / config form) throws', async () => {
    const READ = ['cat-file', 'diff', 'for-each-ref', 'log', 'ls-files', 'ls-tree', 'merge-base', 'merge-tree', 'rev-list', 'rev-parse', 'show', 'status', 'symbolic-ref', 'worktree list'];
    const listed = Bun.spawnSync(['git', '--list-cmds=main,others,nohelpers']).stdout.toString().split('\n').filter((c) => c !== '');
    expect(listed.length).toBeGreaterThan(50);
    const forms = ['worktree add', 'worktree remove', 'worktree move', 'worktree prune', 'worktree lock', 'worktree repair', 'config --show-scope --list'];
    const s = spy();
    const g = gitAt(f.repo, { exec: s.exec, scan: false });
    const allowed: string[] = [];
    for (const sub of new Set([...listed, ...forms, ...READ])) {
      try { await g.run({ sub } as unknown as GitCall); allowed.push(sub); } catch (err) { if (!/not allowlisted/.test(String(err))) allowed.push(sub); }
    }
    expect(allowed.sort()).toEqual(READ);
  });

  test('§10.2 rev-parse, symbolic-ref, for-each-ref, worktree list run', async () => {
    const g = gitAt(f.repo, { exec: execIn(process.env), branches: ['main'] });
    expect(ok(await g.run({ sub: 'rev-parse', flags: ['--verify', '--quiet'], revs: [{ branch: 'main', peel: 'commit' }] })).stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
    expect(ok(await g.run({ sub: 'symbolic-ref', flags: ['--quiet', '--short'], revs: [{ fixed: 'HEAD' }] })).stdout.trim()).toBe('main');
    expect(ok(await g.run({ sub: 'for-each-ref', flags: ['--format=%(refname)'], revs: [{ fixed: 'refs/heads/' }] })).stdout.trim()).toBe('refs/heads/main');
    expect(ok(await g.run({ sub: 'worktree list', flags: ['--porcelain'] })).stdout).toContain(`worktree ${f.repo}`);
  });

  test('§10.2 every call carries the global flags, -C <dir>, and never --attr-source (V24)', async () => {
    const s = spy();
    const g = gitAt(f.repo, { exec: s.exec, branches: ['main'] });
    await g.run({ sub: 'log', flags: ['--format=%H'], revs: [{ branch: 'main' }] });
    await g.run({ sub: 'status' });
    expect(s.calls.length).toBe(4); // common dir + config scan once + two commands
    for (const a of s.calls) {
      expect(a.slice(0, 1 + GLOBAL.length)).toEqual(['git', ...GLOBAL]);
      expect(a.slice(1 + GLOBAL.length, 3 + GLOBAL.length)).toEqual(['-C', f.repo]);
      expect(a.some((x) => x.startsWith('--attr-source'))).toBe(false);
    }
  });

  test('§10.2 per-subcommand flags: diff/show/log no ext-diff/textconv, log/show no signature, status porcelain + --ignore-submodules=all', async () => {
    const s = spy();
    const g = gitAt(f.repo, { exec: s.exec, branches: ['main'] });
    await g.run({ sub: 'diff', flags: ['--numstat'], revs: [{ branch: 'main' }, { branch: 'main' }] });
    await g.run({ sub: 'show', flags: ['--no-patch'], revs: [{ branch: 'main' }] });
    await g.run({ sub: 'log', revs: [{ branch: 'main' }] });
    await g.run({ sub: 'status' });
    const of = (sub: string) => s.calls.find((a) => a[3 + GLOBAL.length] === sub)!;
    expect(of('diff')).toEqual(expect.arrayContaining(['--no-ext-diff', '--no-textconv']));
    expect(of('show')).toEqual(expect.arrayContaining(['--no-ext-diff', '--no-textconv', '--no-show-signature']));
    expect(of('log')).toEqual(expect.arrayContaining(['--no-ext-diff', '--no-textconv', '--no-show-signature']));
    expect(of('status')).toEqual(expect.arrayContaining(['--porcelain', '--ignore-submodules=all']));
  });

  test('§10.2 diff only as --name-status / --numstat (anything else throws)', async () => {
    const g = gitAt(f.repo, { exec: execIn(process.env), branches: ['main'] });
    await rejects(g.run({ sub: 'diff', revs: [{ branch: 'main' }] })).toThrow(/name-status|numstat/);
    await rejects(g.run({ sub: 'diff', flags: ['--shortstat'], revs: [{ branch: 'main' }] })).toThrow(/name-status|numstat/);
  });

  test('§10.2 rev-parse with a ref needs --verify (plain rev-parse echoes --end-of-options on stdout)', async () => {
    const g = gitAt(f.repo, { exec: execIn(process.env), branches: ['main'] });
    await rejects(g.run({ sub: 'rev-parse', revs: [{ branch: 'main', peel: 'tree' }] })).toThrow(/--verify/);
    expect(ok(await g.run({ sub: 'rev-parse', flags: ['--verify'], revs: [{ branch: 'main', peel: 'tree' }] })).stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  test('§10.2 --end-of-options before every ref, -- before every path, refs written in full refs/heads/<name>', async () => {
    const s = spy();
    const g = gitAt(f.repo, { exec: s.exec, branches: ['main'] });
    await g.run({ sub: 'diff', flags: ['--numstat'], revs: [{ range: [{ branch: 'main' }, { branch: 'main' }], dots: '...' }], paths: ['README'] });
    const a = s.calls.at(-1)!;
    expect(a.slice(-4)).toEqual(['--end-of-options', 'refs/heads/main...refs/heads/main', '--', 'README']);
  });

  test('§10.2 tag `main` that differs from branch `main` → the branch (refs/heads/ written out)', async () => {
    const first = git(f.repo, 'rev-parse', 'HEAD');
    commit(f.repo, 'b.txt', 'b\n');
    git(f.repo, 'tag', 'main', first);
    const g = gitAt(f.repo, { exec: execIn(process.env), branches: ['main'] });
    const r = ok(await g.run({ sub: 'rev-parse', flags: ['--verify', '--quiet'], revs: [{ branch: 'main', peel: 'commit' }] }));
    expect(r.stdout.trim()).toBe(git(f.repo, 'rev-parse', 'refs/heads/main'));
    expect(r.stdout.trim()).not.toBe(first);
  });

  test('§10.2 a timeout → unknown "timeout", never a throw', async () => {
    const g = gitAt(f.repo, { exec: () => new Promise(() => {}), timeoutMs: 40 });
    const t0 = Date.now();
    expect(await g.run({ sub: 'status' })).toMatchObject({ kind: 'unknown', reason: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test('§10.2 exec itself failing (spawn error) → unknown, never a throw', async () => {
    const g = gitAt(f.repo, { exec: () => Promise.reject(new Error('ENOENT git')) });
    expect(await g.run({ sub: 'status' })).toMatchObject({ kind: 'unknown', reason: expect.stringContaining('ENOENT') });
  });

  test('§10.2 worktrees(): realpaths of every worktree + its branch (main worktree first)', async () => {
    const wt = join(f.root, 'wt');
    git(f.repo, 'worktree', 'add', '-q', '-b', 'lane/a', wt, 'main');
    const r = await worktrees(gitAt(f.repo, { exec: execIn(process.env) }));
    expect(r).toEqual([{ root: f.repo, branch: 'main' }, { root: wt, branch: 'lane/a' }]);
  });
});

describe('§10.2 option injection', () => {
  const evil = ['--output=PWNED', '-oPWNED', '--upload-pack=x'];
  test('§10.2 ref / commit `--output=<file>` → forbidden, git never runs, no file appears', async () => {
    const s = spy();
    const g = gitAt(f.repo, { exec: s.exec, branches: ['main', ...evil] });
    for (const e of evil) {
      for (const revs of [[{ branch: e }], [{ commit: e }], [{ remote: e }], [{ range: [{ branch: 'main' }, { branch: e }], dots: '..' }]] as GitCall['revs'][]) {
        for (const sub of ['log', 'diff', 'show'] as const) {
          const r = await g.run({ sub, ...(sub === 'diff' ? { flags: ['--numstat'] } : {}), revs: revs! });
          expect(r.kind).toBe('forbidden');
        }
      }
    }
    expect(s.calls).toEqual([]);
    expect(existsSync(join(f.repo, 'PWNED'))).toBe(false);
  });

  test('§10.2 a branch name the engine does not know → forbidden', async () => {
    git(f.repo, 'branch', 'secret');
    const g = gitAt(f.repo, { exec: execIn(process.env), branches: ['main'] });
    expect(await g.run({ sub: 'log', revs: [{ branch: 'secret' }] })).toMatchObject({ kind: 'forbidden' });
    g.know('secret');
    expect((await g.run({ sub: 'log', revs: [{ branch: 'secret' }] })).kind).toBe('ok');
  });

  test('§10.2 commit not matching /^[0-9a-f]{7,40}$/ → forbidden', async () => {
    const g = gitAt(f.repo, { exec: execIn(process.env) });
    for (const c of ['HEAD', 'abc12', 'ABCDEF1', 'main~1', `${'a'.repeat(41)}`, 'abcdef1 ']) {
      expect(await g.run({ sub: 'show', revs: [{ commit: c }] })).toMatchObject({ kind: 'forbidden' });
    }
    const sha = git(f.repo, 'rev-parse', 'HEAD');
    expect((await g.run({ sub: 'show', flags: ['--no-patch'], revs: [{ commit: sha.slice(0, 7) }] })).kind).toBe('ok');
  });

  test('§10.2 absolute path / NUL in a path → forbidden', async () => {
    const g = gitAt(f.repo, { exec: execIn(process.env) });
    expect(await g.run({ sub: 'status', paths: ['/etc/passwd'] })).toMatchObject({ kind: 'forbidden' });
    expect(await g.run({ sub: 'status', paths: ['a\0b'] })).toMatchObject({ kind: 'forbidden' });
    const sha = git(f.repo, 'rev-parse', 'HEAD');
    expect(await g.run({ sub: 'cat-file', flags: ['blob'], revs: [{ commit: sha, path: '/etc/passwd' }] })).toMatchObject({ kind: 'forbidden' });
  });
});

describe('§10.2 config scan: repo configured to run a program', () => {
  const STATUS: GitCall = { sub: 'status' };
  for (const key of ['filter.x.clean', 'filter.x.smudge', 'filter.x.process', 'merge.x.driver', 'diff.x.command', 'diff.x.textconv', 'diff.external', 'gpg.program', 'gpg.ssh.program']) {
    test(`§10.2 local ${key} → unknown naming the key, the command does not run`, async () => {
      git(f.repo, 'config', '--local', key, trap(f, key));
      const s = spy();
      const r = await gitAt(f.repo, { exec: s.exec }).run(STATUS);
      expect(r).toMatchObject({ kind: 'unknown', program: key });
      expect(r.kind === 'unknown' && r.reason).toContain(key);
      expect(s.calls.map((a) => a[3 + GLOBAL.length])).toEqual(['rev-parse', 'config']);
    });
  }

  test('§10.2 mixed-case subsection key (Filter.Ab.Clean) is caught', async () => {
    git(f.repo, 'config', '--local', 'Filter.Ab.Clean', 'x');
    expect(await gitAt(f.repo, { exec: execIn(process.env) }).run(STATUS)).toMatchObject({ kind: 'unknown', program: 'filter.Ab.clean' });
  });

  test('§10.2 include.path counts as local', async () => {
    writeFileSync(join(f.repo, '.git', 'inc.cfg'), '[diff]\n\texternal = x\n');
    git(f.repo, 'config', '--local', 'include.path', 'inc.cfg');
    expect(await gitAt(f.repo, { exec: execIn(process.env) }).run(STATUS)).toMatchObject({ kind: 'unknown', program: 'diff.external' });
  });

  test('§10.2 harmless local keys (filter.x.required, diff.x.binary) do not block', async () => {
    git(f.repo, 'config', '--local', 'filter.x.required', 'true');
    git(f.repo, 'config', '--local', 'diff.x.binary', 'true');
    expect((await gitAt(f.repo, { exec: execIn(process.env) }).run(STATUS)).kind).toBe('ok');
  });

  test('§10.2 MINOR-3 one scan per repo (keyed by --git-common-dir), shared by its worktrees, cached until invalidated', async () => {
    const wt = join(f.root, 'wt');
    git(f.repo, 'worktree', 'add', '-q', '-b', 'lane/a', wt, 'main');
    const s = spy();
    await gitAt(f.repo, { exec: s.exec }).run(STATUS);
    await gitAt(f.repo, { exec: s.exec }).run(STATUS);
    await gitAt(wt, { exec: s.exec }).run(STATUS);
    const scans = s.calls.filter((a) => a.includes('--show-scope'));
    expect(scans.map((a) => a[a.indexOf('-C') + 1])).toEqual([f.repo]);
    git(f.repo, 'config', '--local', 'diff.external', 'x');
    expect((await gitAt(f.repo, { exec: s.exec }).run(STATUS)).kind).toBe('ok'); // cached
    invalidateGitConfig(f.repo);
    expect(await gitAt(f.repo, { exec: s.exec }).run(STATUS)).toMatchObject({ kind: 'unknown', program: 'diff.external' });
  });
  test('§10.2 MINOR-3 R1 a lane sets a local filter from its worktree; invalidateGitConfig(<lane dir>) also clears the project dir scan', async () => {
    const wt = join(f.root, 'wt');
    git(f.repo, 'worktree', 'add', '-q', '-b', 'lane/a', wt, 'main');
    expect((await gitAt(f.repo, { exec: execIn(process.env) }).run(STATUS)).kind).toBe('ok');
    git(wt, 'config', 'filter.x.clean', trap(f, 'x'));
    writeFileSync(join(f.repo, '.gitattributes'), '* filter=x\n');
    invalidateGitConfig(wt);
    expect(await gitAt(f.repo, { exec: execIn(process.env) }).run(STATUS)).toMatchObject({ kind: 'unknown', program: 'filter.x.clean' });
    expect(hits(f)).toEqual([]);
  });
  test('§10.2 MINOR-3 worktree-scope config (extensions.worktreeConfig) is scanned per dir', async () => {
    const wt = join(f.root, 'wt');
    git(f.repo, 'worktree', 'add', '-q', '-b', 'lane/a', wt, 'main');
    git(f.repo, 'config', 'extensions.worktreeConfig', 'true');
    git(wt, 'config', '--worktree', 'diff.external', 'x');
    expect((await gitAt(f.repo, { exec: execIn(process.env) }).run(STATUS)).kind).toBe('ok');
    expect(await gitAt(wt, { exec: execIn(process.env) }).run(STATUS)).toMatchObject({ kind: 'unknown', program: 'diff.external' });
    expect((await gitAt(f.repo, { exec: execIn(process.env) }).run(STATUS)).kind).toBe('ok');
  });

  test('§10.2 the scan cache expires after 60 s', async () => {
    let t = 1_000;
    const g = () => gitAt(f.repo, { exec: execIn(process.env), now: () => t });
    expect((await g().run(STATUS)).kind).toBe('ok');
    git(f.repo, 'config', '--local', 'diff.external', 'x');
    t += 59_000;
    expect((await g().run(STATUS)).kind).toBe('ok');
    t += 2_000;
    expect((await g().run(STATUS)).kind).toBe('unknown');
  });

  test('§10.2 a failing common-dir lookup (not a repo) → unknown, the command does not run', async () => {
    const s = spy();
    expect(await gitAt(f.traps, { exec: s.exec }).run(STATUS)).toMatchObject({ kind: 'unknown' });
    expect(s.calls.map((a) => a[3 + GLOBAL.length])).toEqual(['rev-parse']);
  });
  test('§10.2 a failing scan → unknown with git\'s line, the command does not run, nothing cached', async () => {
    const s = spy();
    let fail = true;
    const exec: Exec = async (argv, o) => (fail && argv.includes('--show-scope') ? { code: 128, stdout: '', stderr: 'fatal: bad config line 3\n' } : s.exec(argv, o));
    expect(await gitAt(f.repo, { exec }).run(STATUS)).toMatchObject({ kind: 'unknown', reason: 'fatal: bad config line 3' });
    expect(s.calls.filter((a) => a.includes('status'))).toEqual([]);
    fail = false;
    expect((await gitAt(f.repo, { exec }).run(STATUS)).kind).toBe('ok');
    expect(s.calls.filter((a) => a.includes('--show-scope')).length).toBe(1);
  });
});

describe('§11 traps: no program runs (each writes hit-<name>)', () => {
  function laneWithFile(): string {
    const wt = join(f.root, 'wt');
    git(f.repo, 'worktree', 'add', '-q', '-b', 'lane/a', wt, 'main');
    return wt;
  }
  async function everything(dirs: string[]): Promise<void> {
    for (const d of dirs) {
      const g = gitAt(d, { exec: execIn(process.env), branches: ['main', 'lane/a'] });
      await g.run({ sub: 'status' });
      await g.run({ sub: 'log', flags: ['-p', '--format=%H %G?'], revs: [{ branch: 'main' }] });
      await g.run({ sub: 'show', flags: ['--format=%H %G?'], revs: [{ branch: 'main' }] });
      await g.run({ sub: 'diff', flags: ['--numstat'], revs: [{ range: [{ branch: 'main' }, { branch: 'lane/a' }], dots: '...' }] });
      await g.run({ sub: 'diff', flags: ['--name-status'], revs: [{ branch: 'main' }] });
    }
  }

  test('§11 core.fsmonitor in local config: overridden by -c core.fsmonitor=, command runs, no hit', async () => {
    commit(f.repo, 'f.txt', 'x\n'); // the fixture's own git must not see the trap
    git(f.repo, 'config', '--local', 'core.fsmonitor', trap(f, 'fsmonitor', 'exit 0'));
    writeFileSync(join(f.repo, 'f.txt'), 'y\n');
    const r = await gitAt(f.repo, { exec: execIn(process.env) }).run({ sub: 'status' });
    expect(r.kind).toBe('ok');
    expect(hits(f)).toEqual([]);
  });

  test('§11 local filter via .gitattributes and via info/attributes, diff.external, textconv, merge driver, gpg + log.showSignature → no hit', async () => {
    const wt = laneWithFile();
    commit(wt, 'f.txt', 'lane\n');
    writeFileSync(join(f.repo, '.gitattributes'), '* filter=x diff=x merge=x\n');
    writeFileSync(join(f.repo, '.git', 'info', 'attributes'), '* filter=x diff=x merge=x\n');
    for (const [k, name] of [['filter.x.clean', 'clean'], ['filter.x.smudge', 'smudge'], ['filter.x.process', 'process'], ['diff.external', 'external'], ['diff.x.textconv', 'textconv'], ['diff.x.command', 'command'], ['merge.x.driver', 'driver'], ['gpg.program', 'gpg']] as const) {
      git(f.repo, 'config', '--local', k, trap(f, name));
    }
    git(f.repo, 'config', '--local', 'log.showSignature', 'true');
    writeFileSync(join(f.repo, 'README'), 'dirty\n');
    await everything([f.repo, wt]);
    expect(hits(f)).toEqual([]);
  });

  test('§11 extensions.worktreeConfig + filter.x.clean in the lane\'s config.worktree → status in the lane = unknown, no hit', async () => {
    const wt = laneWithFile();
    commit(wt, 'f.txt', 'lane\n');
    git(f.repo, 'config', '--local', 'extensions.worktreeConfig', 'true');
    git(wt, 'config', '--worktree', 'filter.x.clean', trap(f, 'wtfilter'));
    writeFileSync(join(wt, '.gitattributes'), '* filter=x\n');
    writeFileSync(join(wt, 'f.txt'), 'dirty\n');
    const r = await gitAt(wt, { exec: execIn(process.env) }).run({ sub: 'status' });
    expect(r).toMatchObject({ kind: 'unknown', program: 'filter.x.clean' });
    expect((await gitAt(f.repo, { exec: execIn(process.env) }).run({ sub: 'status' })).kind).toBe('ok'); // project scan: 0 keys
    expect(hits(f)).toEqual([]);
  });

  test('§11 submodule with filter.y.clean in its own local config → parent status runs, no hit', async () => {
    const sub = join(f.root, 'subsrc');
    Bun.spawnSync(['git', 'init', '-q', '-b', 'main', sub]);
    commit(sub, 's.txt', 's\n');
    git(f.repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sm');
    git(f.repo, 'commit', '-q', '-m', 'sm');
    const smDir = join(f.repo, 'sm');
    writeFileSync(join(smDir, '.gitattributes'), '* filter=y\n');
    git(smDir, 'add', '.gitattributes'); // before the trap: the fixture's own git must not hit it
    git(smDir, 'config', '--local', 'filter.y.clean', trap(f, 'subfilter'));
    writeFileSync(join(smDir, 's.txt'), 'S\n'); // same size: status must hash it (runs clean) unless it skips the submodule
    const r = await gitAt(f.repo, { exec: execIn(process.env) }).run({ sub: 'status' });
    expect(r.kind).toBe('ok');
    expect(hits(f)).toEqual([]);
  });

  test('§11 status of an eol=crlf file just touched → no M line', async () => {
    writeFileSync(join(f.repo, '.gitattributes'), '*.txt text eol=crlf\n');
    commit(f.repo, '.gitattributes', readFileSync(join(f.repo, '.gitattributes'), 'utf8'));
    commit(f.repo, 'f.txt', 'a\nb\n');
    git(f.repo, 'rm', '-q', '--cached', 'f.txt');
    git(f.repo, 'checkout', '-q', '--', '.');
    git(f.repo, 'reset', '-q', '--hard');
    const now = new Date(Date.now() + 5_000);
    Bun.spawnSync(['touch', '-d', now.toISOString().slice(0, 19), join(f.repo, 'f.txt')]);
    const r = ok(await gitAt(f.repo, { exec: execIn(process.env) }).run({ sub: 'status' }));
    expect(r.stdout).not.toMatch(/^ ?M /m);
  });
});
