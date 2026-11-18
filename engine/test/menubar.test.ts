// hf-bg2: the engine job supervises the menu bar as its child (one Login Items entry, PO 18/11).
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MENUBAR_BACKOFF_MS, menubarBin, superviseMenubar } from '../src/menubar.ts';

const dirs: string[] = [];
const sups: { stop(): void }[] = [];
/** hf-fx A2: a red test must not leave a fake running (it holds the runner's pipe): stop every supervisor so none restarts,
 *  SIGKILL every `start <pid>` of every fake's log (ESRCH = already gone), then remove the dirs. */
afterEach(() => {
  for (const s of sups.splice(0)) s.stop();
  for (const d of dirs.splice(0)) {
    for (const l of lines(join(d, 'log'))) {
      const [what, pid] = l.split(' ');
      if (what === 'start') try { process.kill(Number(pid), 'SIGKILL'); } catch { /* ESRCH */ }
    }
    rmSync(d, { recursive: true, force: true });
  }
});
const supervise = (o: Parameters<typeof superviseMenubar>[0]) => {
  const s = superviseMenubar(o);
  sups.push(s);
  return s;
};

/** A fake menubar: appends `start <pid>` to `log`, then runs `body` (default: stays up until SIGTERM). */
function fake(body = 'trap "echo term $$ >> \\"$LOG\\"; exit 0" TERM; while :; do sleep 0.05; done'): { bin: string; log: string } {
  const d = mkdtempSync(join(tmpdir(), 'mb-'));
  dirs.push(d);
  const log = join(d, 'log');
  const bin = join(d, 'cc-slaves-menubar');
  writeFileSync(bin, `#!/bin/sh\nLOG="${log}"\necho start $$ >> "$LOG"\n${body}\n`);
  chmodSync(bin, 0o755);
  return { bin, log };
}
const lines = (log: string): string[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
const until = async (ok: () => boolean, ms = 3000): Promise<void> => {
  const t = Date.now();
  while (!ok()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await Bun.sleep(20);
  }
};

test('restart backoff is at least the old ThrottleInterval (5 s)', () => {
  expect(MENUBAR_BACKOFF_MS).toBeGreaterThanOrEqual(5000);
});

test('spawns the menubar once and stops it on shutdown', async () => {
  const f = fake();
  const sup = supervise({ bin: f.bin, log: () => {}, backoffMs: 50 });
  await until(() => lines(f.log).length === 1);
  await Bun.sleep(200);
  expect(lines(f.log).filter((l) => l.startsWith('start'))).toHaveLength(1);
  sup.stop();
  await until(() => lines(f.log).some((l) => l.startsWith('term')));
  await Bun.sleep(200);
  expect(lines(f.log).filter((l) => l.startsWith('start'))).toHaveLength(1);
});

test('an unexpected exit restarts after the backoff, never two at once', async () => {
  const f = fake('exit 1');
  const t0 = Date.now();
  const logged: string[] = [];
  const sup = supervise({ bin: f.bin, log: (l) => logged.push(l), backoffMs: 300 });
  await until(() => lines(f.log).length >= 2);
  const second = Date.now() - t0;
  sup.stop();
  expect(second).toBeGreaterThanOrEqual(300);
  expect(logged[0]).toBe('menubar thoát (1) — chạy lại sau 300 ms');
  await Bun.sleep(400);
  expect(lines(f.log).length).toBe(2);
});

test('stop during the backoff wait cancels the restart', async () => {
  const f = fake('exit 1');
  const sup = supervise({ bin: f.bin, log: () => {}, backoffMs: 200 });
  await until(() => lines(f.log).length === 1);
  sup.stop();
  await Bun.sleep(400);
  expect(lines(f.log)).toHaveLength(1);
});

test('a binary that cannot start is logged and retried after the backoff', async () => {
  const f = fake();
  chmodSync(f.bin, 0o644);
  const logged: string[] = [];
  const sup = supervise({ bin: f.bin, log: (l) => logged.push(l), backoffMs: 100 });
  await until(() => logged.length >= 2);
  sup.stop();
  expect(logged[0]).toStartWith('menubar không chạy được:');
});

test('the binary: CC_SLAVES_MENUBAR_BIN, else the sibling of the engine binary', () => {
  expect(menubarBin({ CC_SLAVES_MENUBAR_BIN: '/x/mb' }, '/A/cc-slaves.app/Contents/Resources/cc-slaves')).toBe('/x/mb');
  expect(menubarBin({}, '/A/cc-slaves.app/Contents/Resources/cc-slaves')).toBe('/A/cc-slaves.app/Contents/Resources/cc-slaves-menubar');
  expect(menubarBin({ CC_SLAVES_MENUBAR_BIN: '' }, '/r/cc-slaves')).toBe('/r/cc-slaves-menubar');
});
