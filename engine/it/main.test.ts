// §7.1 single instance: a second engine process is refused by engine.lock before it touches anything else
// (no Keychain write, no port bind).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { acquireLock } from '../src/lock.ts';

const MAIN = resolve(import.meta.dir, '../src/main.ts');
let tmp: string;
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'ccs-main-')); });
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test('§7.1 a second instance exits with code 3 while the lock holder lives', async () => {
  const home = join(tmp, 'home');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = acquireLock(join(home, 'engine.lock')); // this test process plays the running engine
  expect(lock.ok).toBe(true);
  const p = Bun.spawn(['bun', MAIN], {
    env: { ...process.env, CC_SLAVES_HOME: home, CC_SLAVES_ATTACH: join(tmp, 'attach'), CC_SLAVES_PORT: '0', CC_SLAVES_ACCOUNTS: join(tmp, 'accts'), CLAUDE_HOME: join(tmp, 'claude'), CLAUDE_JSON: join(tmp, 'cj') },
    stdout: 'pipe', stderr: 'pipe',
  });
  const code = await p.exited;
  const err = await new Response(p.stderr).text();
  expect(code).toBe(3);
  expect(err).toContain(`đang chạy (pid ${process.pid})`);
  if (lock.ok) lock.release();
});

test('§8.4 the engine does not renice itself (spawned claude would inherit it; non-root cannot undo it)', async () => {
  const { existsSync, mkdirSync, readFileSync } = await import('node:fs');
  const { getPriority } = await import('node:os');
  const dir = join(tmp, 'e2e-nice');
  mkdirSync(join(dir, 'scn'), { recursive: true });
  const home = join(dir, 'home');
  const p = Bun.spawn(['bun', resolve(import.meta.dir, '../../e2e/engine-entry.ts')], {
    env: {
      ...process.env, E2E_DIR: dir, CC_SLAVES_HOME: home, CC_SLAVES_ATTACH: join(dir, 'attach'), CC_SLAVES_PORT: '0', CC_SLAVES_WEB_DIR: dir,
      CC_SLAVES_ACCOUNTS: join(dir, 'accts'), CLAUDE_HOME: join(dir, 'claude'), CLAUDE_JSON: join(dir, 'cj'), CC_SLAVES_LAUNCHD_LABEL: '',
    },
    stdout: 'ignore', stderr: 'pipe',
  });
  try {
    const end = Date.now() + 15_000;
    while (!existsSync(join(home, 'engine.json')) && p.exitCode === null && Date.now() < end) await Bun.sleep(50);
    expect(existsSync(join(home, 'engine.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(home, 'engine.json'), 'utf8')).pid).toBe(p.pid);
    expect(getPriority(p.pid)).toBe(getPriority(0));
  } finally {
    p.kill('SIGTERM');
    await p.exited;
  }
}, 20_000);

test('§10.2 A11 an engine with CC_SLAVES_HOME and no CC_SLAVES_ATTACH refuses to start (its sweep would hit the real folder)', async () => {
  const { existsSync, mkdirSync } = await import('node:fs');
  const dir = join(tmp, 'e2e-no-attach');
  mkdirSync(join(dir, 'scn'), { recursive: true });
  const home = join(dir, 'home');
  const env: Record<string, string | undefined> = {
    ...process.env, E2E_DIR: dir, CC_SLAVES_HOME: home, CC_SLAVES_PORT: '0', CC_SLAVES_WEB_DIR: dir,
    CC_SLAVES_ACCOUNTS: join(dir, 'accts'), CLAUDE_HOME: join(dir, 'claude'), CLAUDE_JSON: join(dir, 'cj'), CC_SLAVES_LAUNCHD_LABEL: '',
  };
  delete env.CC_SLAVES_ATTACH;
  const p = Bun.spawn(['bun', resolve(import.meta.dir, '../../e2e/engine-entry.ts')], { env, stdout: 'ignore', stderr: 'pipe' });
  const code = await Promise.race([p.exited, Bun.sleep(15_000).then(() => { p.kill('SIGTERM'); return -1; })]);
  expect(code).toBe(1);
  expect(await new Response(p.stderr).text()).toContain('CC_SLAVES_ATTACH');
  expect(existsSync(join(home, 'engine.json'))).toBe(false);
}, 20_000);
