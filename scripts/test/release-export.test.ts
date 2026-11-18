// Spec v2.6 §7.7 / §13 "Export": allow-list snapshot of a dev tag + deny net + email / secret / private-trace / link scans.
// Every red literal is built at run time so this file itself passes the scans it tests (it ships in scripts/).
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ALLOW, exportSnapshot, scanText } from '../release/export';

const REPO = join(import.meta.dir, '../..');
const AT = '@';
const GIT_ENV = {
  ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
};
function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', ...args], { cwd, env: GIT_ENV, stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
const BASE: Record<string, string> = {
  'package.json': '{ "version": "9.9.9" }\n',
  'LICENSE': 'AGPL\n',
  'README.md': '# x\n![logo](docs/readme/logo.png)\n[site](https://example.com/a) [top](#x) <img src="docs/readme/logo.png">\n',
  'docs/readme/logo.png': 'png',
  '.github/workflows/release.yml': 'name: release\n',
  'engine/src/ok.ts': 'export const ok = 1;\n',
};
function repo(extra: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'ccs-export-'));
  git(root, 'init', '-q', '-b', 'main');
  for (const [f, body] of Object.entries({ ...BASE, ...extra })) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), body);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'x');
  git(root, 'tag', 'v9.9.9');
  return root;
}
const outDir = () => join(mkdtempSync(join(tmpdir(), 'ccs-export-out-')), 'snap');
const run = (root: string, allow?: readonly string[]) => exportSnapshot({ repo: root, ver: '9.9.9', out: outDir(), allow });

test('§7.7-2/5 a clean tag exports only the allow-list and reports files + bytes', () => {
  const root = repo({
    'docs/specs/a.md': 'spec', 'docs/HANDOFF.md': 'h', 'reference/r.mjs': 'r', 'CLAUDE.md': 'c', 'docs/ref/x.md': 'x',
    '.git-blame-ignore-revs': 'x',
  });
  const out = outDir();
  const r = exportSnapshot({ repo: root, ver: '9.9.9', out });
  expect(r.errors).toEqual([]);
  expect(r.files).toBe(Object.keys(BASE).length);
  expect(r.bytes).toBe(Object.values(BASE).reduce((n, b) => n + Buffer.byteLength(b), 0));
  for (const f of Object.keys(BASE)) expect(existsSync(join(out, f))).toBe(true);
  for (const f of ['docs/specs/a.md', 'docs/HANDOFF.md', 'reference/r.mjs', 'CLAUDE.md', '.git-blame-ignore-revs']) {
    expect(existsSync(join(out, f))).toBe(false);
  }
});

test('§7.7-2 the deny net goes red when someone widens the allow-list (mutation: add docs/ and reference/)', () => {
  const root = repo({ 'docs/specs/a.md': 'spec', 'docs/HANDOFF.md': 'h', 'reference/r.mjs': 'r' });
  const r = run(root, [...ALLOW, 'docs/', 'reference/']);
  expect(r.errors.join('\n')).toContain('docs/specs/a.md');
  expect(r.errors.join('\n')).toContain('docs/HANDOFF.md');
  expect(r.errors.join('\n')).toContain('reference/r.mjs');
});

test('§7.7-1 preconditions: an uncommitted file, HEAD off the tag, a version mismatch, a non-empty out-dir', () => {
  const dirty = repo();
  writeFileSync(join(dirty, 'engine/src/new.ts'), 'x');
  expect(run(dirty).errors[0]).toContain('clean');
  const moved = repo();
  writeFileSync(join(moved, 'engine/src/ok.ts'), 'export const ok = 2;\n');
  git(moved, 'commit', '-qam', 'y');
  expect(run(moved).errors[0]).toContain('v9.9.9');
  const wrongVer = repo({ 'package.json': '{ "version": "9.9.8" }\n' });
  expect(run(wrongVer).errors[0]).toContain('package.json');
  const full = outDir();
  mkdirSync(full);
  writeFileSync(join(full, 'x'), 'x');
  expect(exportSnapshot({ repo: repo(), ver: '9.9.9', out: full }).errors[0]).toContain('empty');
});

test('§7.7-3 a planted real address is red with path:line; removing it is green (CLI exit code)', () => {
  const planted = repo({ 'engine/src/x.ts': `// a\nconst who = 'someone${AT}realcorp.com';\n` });
  const out = outDir();
  const cli = (root: string) => Bun.spawnSync(['bun', join(REPO, 'scripts/release/export.ts'), '9.9.9', out],
    { cwd: root, env: GIT_ENV, stdout: 'pipe', stderr: 'pipe' });
  const red = cli(planted);
  expect(red.exitCode).toBe(1);
  expect(red.stderr.toString()).toContain('engine/src/x.ts:2');
  expect(existsSync(out)).toBe(false); // IMPORTANT-3: nothing left for publish.sh to push
  writeFileSync(join(planted, 'engine/src/x.ts'), '// a\n');
  git(planted, 'commit', '-qam', 'fix');
  git(planted, 'tag', '-f', 'v9.9.9');
  const green = cli(planted);
  expect(green.exitCode).toBe(0);
  expect(green.stdout.toString()).toMatch(/\d+ files, \d+ bytes/);
});

test('IMPORTANT-3 --check <dir> rescans an existing snapshot: a file planted after the export is red', () => {
  const out = outDir();
  expect(exportSnapshot({ repo: repo(), ver: '9.9.9', out }).errors).toEqual([]);
  const check = () => Bun.spawnSync(['bun', join(REPO, 'scripts/release/export.ts'), '--check', out], { stdout: 'pipe', stderr: 'pipe' });
  expect(check().exitCode).toBe(0);
  writeFileSync(join(out, 'engine/src/x.ts'), `const who = 'someone${AT}realcorp.com';\n`);
  const red = check();
  expect(red.exitCode).toBe(1);
  expect(red.stderr.toString()).toContain('engine/src/x.ts:1 email');
  expect(existsSync(join(out, 'engine/src/x.ts'))).toBe(true); // --check only reports, never deletes
});

test('§7.7-3 email rule: reserved domains, @2x images and a .log / .jsonl suffix', () => {
  for (const ok of ['a@x.test', 'b@example.com', 'C@Sub.Example.ORG', 'd@x.example', 'e@y.invalid', 'f@h.localhost',
    'icon@2x.png', 'logo@3X.webp', 'stdin-pm@x.test.log', 'q@y.test.jsonl', 'n@example.net']) {
    expect(scanText('a.ts', `x ${ok} y`)).toEqual([]);
  }
  for (const bad of [`pm${AT}x.dev`, `a${AT}x.vn`, `stdin-a${AT}realcorp.com.log`, `z${AT}example.co`, `w${AT}notexample.com`,
    `t${AT}x.testing`, `i${AT}2x.pngs`]) {
    expect(scanText('a.ts', `x\n ${bad} y`)).toEqual([expect.stringContaining('a.ts:2') as string]);
  }
});

test('§7.7-4 secrets and the PO private traces are red; the public handle is green', () => {
  const tek = 'hyper' + 'tek.';
  const reds = [
    `-----BEGIN ${'PRIVATE'} KEY-----`, `untrusted comment: rsign encrypted secret ${'key'}`,
    `TAURI_SIGNING_PRIVATE_${'KEY'}=abc`, `${'sk-'}ant-api03-x`,
    `host: 'slaves.${tek}vn'`, `format!("{a}@${tek}vn")`, `'/Users/${'binhp'}s/x'`, `${tek}cc`,
    `t = '${'ghp'}_${'a1'.repeat(18)}'`, `gho_${'Z'.repeat(36)}`, `${'github'}_pat_11AB`, `key=${'AIza'}${'Sy-_9'.repeat(7)}`,
    `https://chat.${'googleapis'}.com/v1/spaces/AAA/messages`,
    `${'dungn'}v2609`, `ghUser: '${'binhp'}s'`, `${'nguyenvan'}binh`,
  ];
  for (const bad of reds) {
    const found = scanText('src/a.rs', `ok\n${bad}\n`);
    expect(found.length).toBeGreaterThan(0);
    for (const f of found) expect(f).toContain('src/a.rs:2');
  }
  for (const ok of [`gh${'p'}_short`, `${'AIza'}short`, `chat.${'googleapis'}.com/v1/other`, `${'binhp'}s${AT}gmail`, `${'binhp'}shypertek`]) {
    expect(scanText('a.ts', ok).filter((f) => !f.includes(' email '))).toEqual([]);
  }
  expect(scanText('README.md', '© 2026 billphamhypertek.')).toEqual([]);
  expect(scanText('a.ts', 'TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.X }}')).toEqual([]);
});

test('§7.7-4 include_str! / include_bytes! must resolve inside the out-dir; README links must too', () => {
  const inside = repo({ 'menubar/src/icon.rs': 'const A: &str = include_str!("../assets/g.svg");\n', 'menubar/assets/g.svg': '<svg/>' });
  expect(run(inside).errors).toEqual([]);
  const outside = repo({ 'menubar/src/icon.rs': 'const A: &str = include_str!("../../docs/specs/a.svg");\n', 'docs/specs/a.svg': 's' });
  expect(run(outside).errors).toEqual([expect.stringContaining('menubar/src/icon.rs:1') as string]);
  const bytes = repo({ 'src-tauri/src/a.rs': 'static B: &[u8] = include_bytes!( "../../../x.bin" );\n' });
  expect(run(bytes).errors).toEqual([expect.stringContaining('src-tauri/src/a.rs:1') as string]);
  const img = repo({ 'README.md': '# x\n<img src="docs/specs/x.png">\n', 'docs/specs/x.png': 'p' });
  expect(run(img).errors).toEqual([expect.stringContaining('README.md:2') as string]);
  const md = repo({ 'README.en.md': 'see [handoff](docs/HANDOFF.md#top)\n', 'docs/HANDOFF.md': 'h' });
  expect(run(md).errors).toEqual([expect.stringContaining('README.en.md:1') as string]);
  const key = repo({ 'scripts/k.pem': `-----BEGIN ${'PRIVATE'} KEY-----\n` });
  expect(run(key).errors).toEqual([expect.stringContaining('scripts/k.pem:1') as string]);
});

test('IMPORTANT-4 binary files (a NUL byte) are scanned with the same rules', () => {
  const root = repo({ 'web/public/a.bin': `\u0000\u00ffsomeone${AT}realcorp.com /Users/${'binhp'}s/Works` });
  const errors = run(root).errors.join('\n');
  expect(errors).toContain('web/public/a.bin:1 email');
  expect(errors).toContain('web/public/a.bin:1 Mac user path');
  expect(run(repo({ 'web/public/ok.bin': '\u0000\u0001png' })).errors).toEqual([]);
});

test('IMPORTANT-4 a symlink whose target is absolute or leaves the out-dir is red; one inside is green', () => {
  const root = repo({ 'engine/src/real.ts': 'export {};\n' });
  symlinkSync('/tmp/anywhere', join(root, 'engine/src/abs'));
  symlinkSync('../../../outside', join(root, 'engine/src/up'));
  symlinkSync('real.ts', join(root, 'engine/src/in'));
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'links');
  git(root, 'tag', '-f', 'v9.9.9');
  expect(run(root).errors.sort()).toEqual([
    expect.stringContaining('engine/src/abs:1 symlink') as string, expect.stringContaining('engine/src/up:1 symlink') as string,
  ]);
});

test('IMPORTANT-4 every exported path name is scanned (an address or a handle in a file name)', () => {
  const root = repo({ [`engine/src/stdin-someone${AT}realcorp.com.log.ts`]: 'x\n', [`web/${'dungn'}v/a.ts`]: 'x\n' });
  const errors = run(root).errors.join('\n');
  expect(errors).toContain(`engine/src/stdin-someone${AT}realcorp.com.log.ts:1 email`);
  expect(errors).toContain(`web/${'dungn'}v/a.ts:1 PO handle`);
});

test('§7.7 the release files of this repo pass the scans they implement', () => {
  const files = ['scripts/release/bump.ts', 'scripts/release/latest-json.ts', 'scripts/release/export.ts', 'scripts/release/minisign.ts',
    'scripts/test/_release-key.ts',
    'scripts/release/publish.sh', '.github/workflows/release.yml', 'scripts/app-build.sh',
    'scripts/test/release-bump.test.ts', 'scripts/test/release-latest-json.test.ts', 'scripts/test/release-export.test.ts',
    'scripts/test/release-publish.test.ts', 'scripts/test/release-workflow.test.ts'];
  for (const f of files) expect(scanText(f, readFileSync(join(REPO, f), 'utf8'))).toEqual([]);
});
