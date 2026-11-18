// Spec v2.6 §7.8-3 / §13 "Publish": publish.sh against a temp bare repo standing in for the public one. No network.
import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const PUBLISH = join(import.meta.dir, '../../scripts/release/publish.sh');
const NOREPLY = '4242+billphamhypertek' + '@' + 'users.noreply.github.com';

function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'ccs-pub-home-'));
  // a machine identity the script must NOT use (A11)
  writeFileSync(join(h, 'gitconfig'), '[user]\n  name = machine\n  email = machine@example.com\n[init]\n  defaultBranch = trunk\n');
  return h;
}
const H = home();
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: join(H, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', ...args], { cwd, env: ENV, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
function bare(): string {
  const b = join(mkdtempSync(join(tmpdir(), 'ccs-pub-bare-')), 'public.git');
  git(tmpdir(), 'init', '-q', '--bare', b);
  return b;
}
function snapshot(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'ccs-pub-snap-'));
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(d, f)), { recursive: true });
    writeFileSync(join(d, f), body);
  }
  return d;
}
function publish(remote: string, ver: string, dir: string, id: string | null = '4242', extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...ENV, ...extra, CC_SLAVES_PUBLIC_REMOTE: remote };
  if (id !== null) env.CC_SLAVES_GH_ID = id;
  const p = Bun.spawnSync(['bash', PUBLISH, ver, dir], { env, stdout: 'pipe', stderr: 'pipe' });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}
const SNAP = {
  '.github/workflows/release.yml': 'name: release\n', '.gitignore': '[Rr]eleases/\n*.log\n',
  'docs/releases/9.9.9.md': 'notes\n', 'engine/src/a.ts': 'a\n', 'README.md': '# x\n',
};

test('§7.8-3 one commit "release: <ver>", noreply author + committer, tag on it, .github and .gitignore inside', () => {
  const remote = bare();
  const r = publish(remote, '9.9.9', snapshot(SNAP));
  expect(r.code).toBe(0);
  const g = (...a: string[]) => git(remote, ...a);
  expect(g('log', '-1', '--format=%an|%ae|%cn|%ce', 'main')).toBe(`billphamhypertek|${NOREPLY}|billphamhypertek|${NOREPLY}`);
  expect(g('log', '-1', '--format=%B', 'main')).toBe('release: 9.9.9');
  expect(g('rev-list', '--count', 'main')).toBe('1');
  expect(g('rev-parse', 'v9.9.9^{commit}')).toBe(g('rev-parse', 'main'));
  const files = g('ls-tree', '-r', '--name-only', 'main').split('\n');
  // ignored by the snapshot's own .gitignore, still published: the snapshot is exactly the tracked dev files
  expect(files.sort()).toEqual(Object.keys(SNAP).sort());
});

test('§7.8-3 the next release replaces the whole tree and carries no dev SHA', () => {
  const remote = bare();
  expect(publish(remote, '9.9.9', snapshot(SNAP)).code).toBe(0);
  const devSha = 'deadbeefcafe';
  const next = { ...SNAP, 'engine/src/b.ts': `// built from ${devSha}?\n` } as Record<string, string>;
  delete next['engine/src/a.ts'];
  expect(publish(remote, '9.9.10', snapshot(next)).code).toBe(0);
  const files = git(remote, 'ls-tree', '-r', '--name-only', 'main').split('\n');
  expect(files).toContain('engine/src/b.ts');
  expect(files).not.toContain('engine/src/a.ts');
  expect(git(remote, 'log', '--format=%B', 'main')).toBe('release: 9.9.10\n\nrelease: 9.9.9');
  expect(git(remote, 'rev-parse', 'v9.9.10^{commit}')).toBe(git(remote, 'rev-parse', 'main'));
});

test('§7.8-3 a snapshot without .github/workflows/release.yml exits 1 and commits nothing', () => {
  const remote = bare();
  const snap = { ...SNAP } as Record<string, string>;
  delete snap['.github/workflows/release.yml'];
  const r = publish(remote, '9.9.9', snapshot(snap));
  expect(r.code).toBe(1);
  expect(r.out).toContain('release.yml');
  expect(git(remote, 'for-each-ref')).toBe('');
});

test('§7.8-3 refuses a bad version, a missing GitHub id, a missing snapshot dir', () => {
  const remote = bare();
  expect(publish(remote, 'v9.9.9', snapshot(SNAP)).code).toBe(1);
  expect(publish(remote, '9.9.9', snapshot(SNAP), null).code).toBe(1);
  expect(publish(remote, '9.9.9', join(tmpdir(), 'ccs-no-such-dir')).code).toBe(1);
  expect(git(remote, 'for-each-ref')).toBe('');
});

test('§7.8-3 publishing a version twice is refused as a whole: main does not move without its tag', () => {
  const remote = bare();
  expect(publish(remote, '9.9.9', snapshot(SNAP)).code).toBe(0);
  const main = git(remote, 'rev-parse', 'main');
  expect(publish(remote, '9.9.9', snapshot({ ...SNAP, 'engine/src/c.ts': 'c\n' })).code).not.toBe(0);
  expect(git(remote, 'rev-parse', 'main')).toBe(main);
});

test('IMPORTANT-3 a snapshot that fails the export scans is refused before anything is staged or pushed', () => {
  const remote = bare();
  const r = publish(remote, '9.9.9', snapshot({ ...SNAP, 'engine/src/x.ts': `const who = 'someone${'@'}realcorp.com';\n` }));
  expect(r.code).toBe(1);
  expect(r.out).toContain('engine/src/x.ts:1 email');
  expect(git(remote, 'for-each-ref')).toBe('');
});

test('IMPORTANT-4 no auto gc / maintenance in the work repo, and a failing cleanup cannot turn a landed push into exit 1', () => {
  // `rm` stand-in: records the work repo's gc / maintenance config, removes the dir, then fails like the measured race
  const bin = mkdtempSync(join(tmpdir(), 'ccs-pub-bin-'));
  const log = join(bin, 'cleanup.log');
  writeFileSync(join(bin, 'rm'), `#!/bin/bash\nw="\${@: -1}"\n{ git -C "$w/repo" config gc.auto; git -C "$w/repo" config maintenance.auto; } > "${log}"\n/bin/rm "$@"\nexit 1\n`);
  chmodSync(join(bin, 'rm'), 0o755);
  const remote = bare();
  const r = publish(remote, '9.9.9', snapshot(SNAP), '4242', { PATH: `${bin}:${process.env.PATH ?? ''}` });
  expect(readFileSync(log, 'utf8')).toBe('0\nfalse\n');
  expect(r.code).toBe(0);
  expect(git(remote, 'rev-parse', 'v9.9.9^{commit}')).toBe(git(remote, 'rev-parse', 'main'));
});
