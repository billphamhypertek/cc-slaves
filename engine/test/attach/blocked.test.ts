import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkPath } from '../../src/attach/blocked.ts';
import { attachEnv, type AttachEnv } from './_env.ts';

let env: AttachEnv;
beforeEach(() => { env = attachEnv(); });
afterEach(() => env.restore());

describe('§10.2 A9 blocked roots (one check for `send` and `/attach/path`)', () => {
  test('a file under paths().home → blocked; the home itself → blocked', async () => {
    writeFileSync(join(env.home, 'config.json'), '{}');
    expect(await checkPath(join(env.home, 'config.json'))).toEqual({ ok: false, reason: 'blocked' });
    expect(await checkPath(env.home)).toEqual({ ok: false, reason: 'blocked' });
  });

  test('a file under the accounts root → blocked', async () => {
    mkdirSync(join(env.accts, 'a1'));
    writeFileSync(join(env.accts, 'a1', '.claude.json'), '{}');
    expect(await checkPath(join(env.accts, 'a1', '.claude.json'))).toEqual({ ok: false, reason: 'blocked' });
  });

  test('a relative path → blocked (never resolved against the engine cwd)', async () => {
    expect(await checkPath('home/config.json')).toEqual({ ok: false, reason: 'blocked' });
    expect(await checkPath('./x')).toEqual({ ok: false, reason: 'blocked' });
  });

  test('a symlink outside that points into a blocked root → blocked (realpath on both sides)', async () => {
    writeFileSync(join(env.home, 'state.db'), 'x');
    const desk = join(env.tmp, 'Desktop');
    mkdirSync(desk);
    symlinkSync(join(env.home, 'state.db'), join(desk, 'innocent.png'));
    symlinkSync(env.home, join(desk, 'dir-link'));
    expect(await checkPath(join(desk, 'innocent.png'))).toEqual({ ok: false, reason: 'blocked' });
    expect(await checkPath(join(desk, 'dir-link', 'state.db'))).toEqual({ ok: false, reason: 'blocked' });
  });

  test('a blocked root reached through a symlinked root path is still blocked', async () => {
    const real = join(env.tmp, 'real-home');
    mkdirSync(real);
    writeFileSync(join(real, 'engine.json'), '{}');
    const link = join(env.tmp, 'home-link');
    symlinkSync(real, link);
    process.env.CC_SLAVES_HOME = link; // the root itself is a symlink: compared by its realpath
    expect(await checkPath(join(real, 'engine.json'))).toEqual({ ok: false, reason: 'blocked' });
  });

  test('a different letter case (APFS is case-insensitive) → blocked', async () => {
    writeFileSync(join(env.home, 'engine.json'), '{}');
    const upper = join(env.tmp, 'HOME', 'ENGINE.JSON');
    expect(await checkPath(upper)).toEqual({ ok: false, reason: 'blocked' });
    // no realpath to canonicalize the case: the folded lexical check alone must say blocked, not not_found
    expect(await checkPath(join(env.tmp, 'HOME', 'missing.json'))).toEqual({ ok: false, reason: 'blocked' });
  });

  test('a sibling whose name only starts like a root (`home2`) is allowed; the real path comes back', async () => {
    mkdirSync(join(env.tmp, 'home2'));
    writeFileSync(join(env.tmp, 'home2', 'a.txt'), 'a');
    expect(await checkPath(join(env.tmp, 'home2', 'a.txt'))).toEqual({ ok: true, real: join(env.tmp, 'home2', 'a.txt') });
  });

  test('a missing absolute path → not_found', async () => {
    expect(await checkPath(join(env.tmp, 'nope.txt'))).toEqual({ ok: false, reason: 'not_found' });
  });
});
