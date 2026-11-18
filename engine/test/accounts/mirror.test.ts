import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureMirrored, mirrorSettings, watchSettings, type MirrorDeps, type WatchDeps } from '../../src/accounts/mirror.ts';
import { writeFileSecure } from '../../src/paths.ts';

let tmp: string, claude: string, a1: string, a2: string;
let writes: string[];
let deps: MirrorDeps;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-mirror-'));
  claude = join(tmp, 'claude');
  a1 = join(tmp, 'accts', 'aaaaaaaaaaaa');
  a2 = join(tmp, 'accts', 'bbbbbbbbbbbb');
  for (const d of [claude, a1, a2]) mkdirSync(d, { recursive: true, mode: 0o700 });
  writes = [];
  deps = { write: (p, d) => { writes.push(p); writeFileSecure(p, d); } };
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const mode = (p: string) => statSync(p).mode & 0o777;
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const SRC = { model: 'opus', env: { CLAUDE_CONFIG_DIR: '/Users/x/.claude', FOO: 'bar' }, enabledPlugins: { p: true } };

describe('settings mirror (v2 §5.3)', () => {
  test('§5.3 §5.1 settings.json copied to every account, mode 0600, env.CLAUDE_CONFIG_DIR dropped, other keys kept', () => {
    writeFileSync(join(claude, 'settings.json'), JSON.stringify(SRC), { mode: 0o644 });
    const r = mirrorSettings(claude, [a1, a2], deps);
    for (const a of [a1, a2]) {
      const p = join(a, 'settings.json');
      expect(mode(p)).toBe(0o600);
      expect(json(p)).toEqual({ model: 'opus', env: { FOO: 'bar' }, enabledPlugins: { p: true } });
    }
    expect(r.written.sort()).toEqual([join(a1, 'settings.json'), join(a2, 'settings.json')].sort());
  });

  test('§5.3 settings.local.json is optional: copied when present (0600), absent → no file, no throw, reported missing', () => {
    writeFileSync(join(claude, 'settings.json'), '{}');
    let r = mirrorSettings(claude, [a1], deps);
    expect(existsSync(join(a1, 'settings.local.json'))).toBe(false);
    expect(r.missing).toContain(join(claude, 'settings.local.json'));
    writeFileSync(join(claude, 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));
    r = mirrorSettings(claude, [a1], deps);
    expect(mode(join(a1, 'settings.local.json'))).toBe(0o600);
    expect(json(join(a1, 'settings.local.json'))).toEqual({ permissions: { allow: ['Bash(ls)'] } });
  });

  test('§5.3 source missing → the account copy is NOT removed, reported', () => {
    writeFileSync(join(a1, 'settings.json'), '{"old":1}');
    const r = mirrorSettings(claude, [a1], deps);
    expect(json(join(a1, 'settings.json'))).toEqual({ old: 1 });
    expect(r.missing).toContain(join(claude, 'settings.json'));
    expect(writes).toEqual([]);
  });

  test('§5.3 unchanged source → no second write (mtime + hash memo)', () => {
    writeFileSync(join(claude, 'settings.json'), JSON.stringify(SRC));
    mirrorSettings(claude, [a1], deps);
    expect(writes).toHaveLength(1);
    mirrorSettings(claude, [a1], deps);
    // touch the source without changing content: hash equal → still no write
    const t = new Date(Date.now() + 5000);
    utimesSync(join(claude, 'settings.json'), t, t);
    mirrorSettings(claude, [a1], deps);
    expect(writes).toHaveLength(1);
  });

  test('§5.3 a changed source or a directly edited account copy is (re)written', () => {
    writeFileSync(join(claude, 'settings.json'), JSON.stringify(SRC));
    mirrorSettings(claude, [a1], deps);
    writeFileSync(join(claude, 'settings.json'), JSON.stringify({ model: 'sonnet' }));
    mirrorSettings(claude, [a1], deps);
    expect(json(join(a1, 'settings.json'))).toEqual({ model: 'sonnet' });
    writeFileSync(join(a1, 'settings.json'), '{"edited":true}'); // e.g. /permissions "always allow" in a lane
    mirrorSettings(claude, [a1], deps);
    expect(json(join(a1, 'settings.json'))).toEqual({ model: 'sonnet' });
    expect(writes).toHaveLength(3);
  });

  test('§5.3 ~/.claude is never written (write spy), even when it is listed as an account dir', () => {
    writeFileSync(join(claude, 'settings.json'), JSON.stringify(SRC));
    writeFileSync(join(claude, 'settings.local.json'), '{}');
    const before = readFileSync(join(claude, 'settings.json'), 'utf8');
    mirrorSettings(claude, [a1, claude, `${claude}/`], deps);
    ensureMirrored(claude, { ...deps, claudeHome: claude });
    expect(writes.filter((p) => p.startsWith(claude))).toEqual([]);
    expect(readFileSync(join(claude, 'settings.json'), 'utf8')).toBe(before);
  });

  test('§5.3 a missing account dir is skipped, never created', () => {
    writeFileSync(join(claude, 'settings.json'), '{}');
    const gone = join(tmp, 'accts', 'cccccccccccc');
    mirrorSettings(claude, [gone], deps);
    expect(existsSync(gone)).toBe(false);
  });

  test('§5.3 ensureMirrored (pre-spawn): copies only when different', () => {
    writeFileSync(join(claude, 'settings.json'), JSON.stringify(SRC));
    ensureMirrored(a1, { ...deps, claudeHome: claude });
    expect(json(join(a1, 'settings.json')).env).toEqual({ FOO: 'bar' });
    ensureMirrored(a1, { ...deps, claudeHome: claude });
    expect(writes).toHaveLength(1);
  });

  test('§5.3 broken source JSON → not copied (cannot drop the env key safely), reported, no throw', () => {
    writeFileSync(join(claude, 'settings.json'), '{oops');
    const r = mirrorSettings(claude, [a1], deps);
    expect(existsSync(join(a1, 'settings.json'))).toBe(false);
    expect(r.errors.length).toBe(1);
  });

  test('§5.3 watchSettings: source events debounced 1 s → one mirror of all accounts; stop closes the watcher', () => {
    writeFileSync(join(claude, 'settings.json'), JSON.stringify(SRC));
    let fire: ((name: string | null) => void) | null = null;
    let closed = false;
    const timers: { fn: () => void; ms: number; live: boolean }[] = [];
    const stop = watchSettings(claude, () => [a1, a2], {
      ...deps,
      watch: (dir, cb) => { expect(dir).toBe(claude); fire = cb; return { close: () => { closed = true; } }; },
      setTimeout: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
      clearTimeout: (h) => { (h as { live: boolean }).live = false; },
    });
    fire!('settings.json');
    fire!('settings.local.json');
    fire!('history.jsonl'); // unrelated file: ignored
    expect(timers.filter((t) => t.live)).toHaveLength(1);
    expect(timers.at(-1)!.ms).toBe(1000);
    expect(writes).toEqual([]);
    timers.filter((t) => t.live).forEach((t) => t.fn());
    expect(writes.sort()).toEqual([join(a1, 'settings.json'), join(a2, 'settings.json')].sort());
    stop();
    expect(closed).toBe(true);
  });
  test('§5.3 watchSettings poll fallback (fs.watch drops events, measured 13/20 on macOS): a source change seen by the 1 s stat poll → debounced mirror; no change → no timer', () => {
    writeFileSync(join(claude, 'settings.json'), JSON.stringify(SRC));
    let tick: (() => void) | null = null;
    let cleared = false;
    const timers: { fn: () => void; live: boolean }[] = [];
    const w: WatchDeps = {
      ...deps,
      watch: () => ({ close: () => {} }), // silent watcher: only the poll can see the change
      setInterval: (fn, ms) => { expect(ms).toBe(1000); tick = fn; return 1; },
      clearInterval: () => { cleared = true; },
      setTimeout: (fn) => { const t = { fn, live: true }; timers.push(t); return t; },
      clearTimeout: (h) => { (h as { live: boolean }).live = false; },
    };
    const stop = watchSettings(claude, () => [a1], w);
    tick!();
    expect(timers).toHaveLength(0);
    writeFileSync(join(claude, 'settings.json'), JSON.stringify({ model: 'haiku-longer-name' }));
    tick!();
    expect(timers.filter((t) => t.live)).toHaveLength(1);
    timers.filter((t) => t.live).forEach((t) => t.fn());
    expect(json(join(a1, 'settings.json'))).toEqual({ model: 'haiku-longer-name' });
    stop();
    expect(cleared).toBe(true);
  });
});
