// Spec v2.6 §7.1 / §13 "Script": `release:bump <ver>` edits every version home and checks they match.
import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { throwawayKey } from './_release-key';

const REPO = join(import.meta.dir, '../..');
const BUMP = join(REPO, 'scripts/release/bump.ts');
const KEY = throwawayKey().pubkey;
const HOMES = [
  'package.json', 'src-tauri/tauri.conf.json',
  'src-tauri/Cargo.toml', 'src-tauri/core/Cargo.toml', 'menubar/Cargo.toml',
  'src-tauri/Cargo.lock', 'src-tauri/core/Cargo.lock', 'menubar/Cargo.lock',
];

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), 'ccs-bump-'));
  for (const f of HOMES) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    cpSync(join(REPO, f), join(root, f));
  }
  setPubkey(root, KEY);
  return root;
}
function setPubkey(root: string, pubkey: string): void {
  const f = join(root, 'src-tauri/tauri.conf.json');
  const conf = JSON.parse(readFileSync(f, 'utf8')) as { plugins: { updater: { pubkey: string } } };
  conf.plugins.updater.pubkey = pubkey;
  writeFileSync(f, JSON.stringify(conf, null, 2));
}
function run(root: string, ...args: string[]) {
  const p = Bun.spawnSync(['bun', BUMP, ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}
const read = (root: string, f: string) => readFileSync(join(root, f), 'utf8');
const lockVersion = (text: string, name: string) => new RegExp(`name = "${name}"\\nversion = "([^"]+)"`).exec(text)?.[1];

test('§7.1 bump writes package.json, the three Cargo.toml [package] and our crates in the three Cargo.lock', () => {
  const root = tree();
  const before = read(root, 'src-tauri/Cargo.toml');
  expect(run(root, '1.4.2').code).toBe(0);
  expect((JSON.parse(read(root, 'package.json')) as { version: string }).version).toBe('1.4.2');
  for (const f of ['src-tauri/Cargo.toml', 'src-tauri/core/Cargo.toml', 'menubar/Cargo.toml']) {
    expect(/^version = "([^"]+)"/m.exec(read(root, f))?.[1]).toBe('1.4.2');
  }
  // only the [package] line changes; dependency versions stay
  const changed = read(root, 'src-tauri/Cargo.toml').split('\n').filter((l, i) => l !== before.split('\n')[i]);
  expect(changed).toEqual(['version = "1.4.2"']);
  expect(lockVersion(read(root, 'src-tauri/Cargo.lock'), 'cc-slaves')).toBe('1.4.2');
  expect(lockVersion(read(root, 'src-tauri/Cargo.lock'), 'ccs-core')).toBe('1.4.2');
  expect(lockVersion(read(root, 'src-tauri/core/Cargo.lock'), 'ccs-core')).toBe('1.4.2');
  expect(lockVersion(read(root, 'menubar/Cargo.lock'), 'cc-slaves-menubar')).toBe('1.4.2');
  expect(lockVersion(read(root, 'menubar/Cargo.lock'), 'ccs-core')).toBe('1.4.2');
  expect(lockVersion(read(root, 'menubar/Cargo.lock'), 'serde')).not.toBe('1.4.2');
  expect(run(root, '--check', '1.4.2').code).toBe(0);
});

test('§7.1 --check: CI stops when the tag differs from package.json or any home drifted', () => {
  const root = tree();
  expect(run(root, '2.0.0-rc.1').code).toBe(0);
  const wrong = run(root, '--check', '2.0.0');
  expect(wrong.code).toBe(1);
  expect(wrong.out).toContain('package.json');
  writeFileSync(join(root, 'menubar/Cargo.lock'), read(root, 'menubar/Cargo.lock').replace(
    'name = "cc-slaves-menubar"\nversion = "2.0.0-rc.1"', 'name = "cc-slaves-menubar"\nversion = "0.0.1"'));
  const drift = run(root, '--check', '2.0.0-rc.1');
  expect(drift.code).toBe(1);
  expect(drift.out).toContain('menubar/Cargo.lock');
  expect(drift.out).not.toContain('src-tauri/Cargo.lock');
});

test('§7.1 tauri.conf.json must keep reading the version from package.json', () => {
  const root = tree();
  writeFileSync(join(root, 'src-tauri/tauri.conf.json'),
    read(root, 'src-tauri/tauri.conf.json').replace('"version": "../package.json"', '"version": "0.3.0"'));
  const r = run(root, '--check', '0.3.0');
  expect(r.code).toBe(1);
  expect(r.out).toContain('src-tauri/tauri.conf.json');
});

test('§7.1 a version that is not semver is refused and nothing is written', () => {
  const root = tree();
  const pkg = read(root, 'package.json');
  for (const bad of ['1.2', 'v1.2.3', '1.2.3.4', '']) expect(run(root, bad).code).toBe(1);
  expect(read(root, 'package.json')).toBe(pkg);
});

test('§7.1 only the [package] version moves, not a version inside a dependency table', () => {
  const root = tree();
  const f = join(root, 'menubar/Cargo.toml');
  writeFileSync(f, `${read(root, 'menubar/Cargo.toml')}\n[dependencies.extra]\nversion = "7.7.7"\n`);
  expect(run(root, '1.4.2').code).toBe(0);
  expect(read(root, 'menubar/Cargo.toml')).toContain('[dependencies.extra]\nversion = "7.7.7"');
  expect(run(root, '--check', '1.4.2').code).toBe(0);
});

test('§7.2 --check (first CI step) refuses the placeholder or a broken updater key, before the build (MINOR-2)', () => {
  const root = tree();
  expect(run(root, '1.4.2').code).toBe(0); // the throwaway key passes --check (first test)
  for (const bad of ['O2-PLACEHOLDER: the orchestrator commits the real minisign public key here', `${KEY}!!`,
    Buffer.from('untrusted comment: x\nnot a key\n').toString('base64')]) {
    setPubkey(root, bad);
    const r = run(root, '--check', '1.4.2');
    expect(r.code).toBe(1);
    expect(r.out).toContain('plugins.updater.pubkey');
  }
});
