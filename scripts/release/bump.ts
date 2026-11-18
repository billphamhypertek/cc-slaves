/**
 * `bun scripts/release/bump.ts <ver>` — set the app version everywhere it lives, then check (spec v2.6 §7.1).
 * `bun scripts/release/bump.ts --check <ver>` — only check; the release workflow runs it with the tag, first (CI stops on a
 * mismatch). `--check` also refuses an updater key (`plugins.updater.pubkey`, §7.2) that is the placeholder or not a minisign
 * public key, before the ~10 min build (`latest-json.ts` then verifies the `.sig` against it).
 *
 * Homes: `package.json` (engine and Tauri read it; `tauri.conf.json` must keep `"version": "../package.json"`), the
 * `[package]` version of the three Cargo.toml, and our own crates in the three Cargo.lock (so a build after a bump leaves
 * the tree clean for the export precondition, §7.7-1). Run from the repo root.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePubkey } from './minisign';

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const TOMLS = ['src-tauri/Cargo.toml', 'src-tauri/core/Cargo.toml', 'menubar/Cargo.toml'];
const LOCKS = ['src-tauri/Cargo.lock', 'src-tauri/core/Cargo.lock', 'menubar/Cargo.lock'];
const CRATES = new Set(['cc-slaves', 'ccs-core', 'cc-slaves-menubar']);
const TAURI_CONF = 'src-tauri/tauri.conf.json';

/** Visit the `[package]` version line of a Cargo.toml (`edit` returns the new line). */
function tomlVersion(text: string, edit: (line: string, ver: string) => string, seen: string[]): string {
  let section = '';
  return text.split('\n').map((line) => {
    if (/^\[.*\]\s*$/.test(line)) section = line.trim();
    const m = /^version = "([^"]+)"/.exec(line);
    if (section !== '[package]' || !m) return line;
    seen.push(m[1]!);
    return edit(line, m[1]!);
  }).join('\n');
}

/** Visit the version line of each of our crates in a Cargo.lock. */
function lockVersions(text: string, edit: (line: string, ver: string) => string, seen: string[]): string {
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const name = /^name = "([^"]+)"$/.exec(lines[i - 1]!)?.[1];
    const m = /^version = "([^"]+)"$/.exec(lines[i]!);
    if (name === undefined || !m || !CRATES.has(name)) continue;
    seen.push(m[1]!);
    lines[i] = edit(lines[i]!, m[1]!);
  }
  return lines.join('\n');
}

const visitors: [string[], typeof tomlVersion][] = [[TOMLS, tomlVersion], [LOCKS, lockVersions]];

function bump(root: string, ver: string): void {
  const pkgPath = join(root, 'package.json');
  const pkg = readFileSync(pkgPath, 'utf8');
  writeFileSync(pkgPath, pkg.replace(/("version":\s*")[^"]+(")/, `$1${ver}$2`));
  for (const [files, visit] of visitors) {
    for (const f of files) {
      const p = join(root, f);
      writeFileSync(p, visit(readFileSync(p, 'utf8'), () => `version = "${ver}"`, []));
    }
  }
}

/** Every home that does not carry `ver` (empty = all match); `release` adds the updater key. */
function check(root: string, ver: string, release: boolean): string[] {
  const bad: string[] = [];
  const pkg = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string }).version;
  if (pkg !== ver) bad.push(`package.json: ${pkg} ≠ ${ver}`);
  const conf = JSON.parse(readFileSync(join(root, TAURI_CONF), 'utf8')) as { version?: string; plugins?: { updater?: { pubkey?: unknown } } };
  if (conf.version !== '../package.json') bad.push(`${TAURI_CONF}: version must be "../package.json", is ${conf.version}`);
  if (release && parsePubkey(conf.plugins?.updater?.pubkey) === null) bad.push(`${TAURI_CONF}: plugins.updater.pubkey is not a minisign public key`);
  for (const [files, visit] of visitors) {
    for (const f of files) {
      const seen: string[] = [];
      visit(readFileSync(join(root, f), 'utf8'), (l) => l, seen);
      if (seen.length === 0 || seen.some((v) => v !== ver)) bad.push(`${f}: ${seen.join(', ') || 'no version'} ≠ ${ver}`);
    }
  }
  return bad;
}

function main(argv: string[]): number {
  const only = argv[0] === '--check';
  const ver = only ? argv[1] : argv[0];
  if (ver === undefined || !SEMVER.test(ver)) {
    console.error('usage: bun scripts/release/bump.ts [--check] <major.minor.patch[-pre]>');
    return 1;
  }
  const root = process.cwd();
  if (!only) bump(root, ver);
  const bad = check(root, ver, only);
  for (const b of bad) console.error(`release:bump: ${b}`);
  if (bad.length === 0) console.log(`release:bump: every version home is ${ver}`);
  return bad.length === 0 ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
