// v2 §7.1-4 / §13 G6 T12: the engine never reads ~/.cc-switch. Code (comments stripped) under engine/src may not name
// it, its env var or a path field for it; the only allowed token is the legacy v1 card action `open_ccswitch`, which
// cards/store.ts rewrites to `account_relogin` at read time. v2.2 §5.5 adds one more: the app-dir prefix constant of
// `skills/catalog.ts`, which only detects a skill linked into another app's folder (K11 "phụ thuộc CC Switch").
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { paths } from '../src/paths.ts';

const SRC = resolve(import.meta.dir, '../src');
const files = (d: string): string[] => readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : e.name.endsWith('.ts') ? [join(d, e.name)] : []));
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n');

describe('§7.1-4 T12 no CC Switch in the engine', () => {
  test('§7.1-4 no engine source names ~/.cc-switch, CC_SWITCH_HOME or ccSwitch (legacy `open_ccswitch` action only)', () => {
    const hits = files(SRC).flatMap((f) => code(readFileSync(f, 'utf8')).split('\n')
      .filter((l) => /cc[-_.]?switch/i.test(l.replaceAll('open_ccswitch', '')))
      .map((l) => `${f.slice(SRC.length + 1)}: ${l.trim()}`))
      .filter((h) => !h.startsWith('skills/catalog.ts: const APP_DIR_PREFIXES: '));
    expect(hits).toEqual([]);
  });
  test('§7.1-4 paths() has no CC Switch root', () => {
    expect(Object.keys(paths()).filter((k) => /switch/i.test(k))).toEqual([]);
  });
});
