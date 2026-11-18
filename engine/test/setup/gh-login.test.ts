// hotfix 2026-11-16 (b) G3 `gh_login`: `gh auth login --web` (no tty: gh prints the one-time code + the device page and
// polls; measured 2026-11-16 on gh 2.92.0), the code / URL to the row, cancel kills the process group, a failure keeps
// gh's last line. Fake spawn here; engine/it/git-setup.test.ts runs a fake `gh` script for real.
import { describe, expect, test } from 'bun:test';
import type { GhLoginView } from '../../../shared/protocol.ts';
import { GH_LOGIN_ARGV, startGhLogin, type GhProc } from '../../src/setup/gh-login.ts';

function fakeProc() {
  const cbs: ((s: string) => void)[] = [];
  let exit!: (n: number) => void;
  const p: GhProc = { pid: 4242, onOutput: (cb) => { cbs.push(cb); }, exited: new Promise<number>((r) => { exit = r; }) };
  return { p, out: (s: string) => { for (const c of cbs) c(s); }, exit: (n: number) => exit(n) };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('hf1116 G3 gh login', () => {
  test('argv: --web --git-protocol https --hostname github.com, stripped env + NO_COLOR', () => {
    const f = fakeProc();
    let seen: { argv: string[]; env: Record<string, string> } | null = null;
    startGhLogin({ ghPath: '/opt/gh', env: { PATH: '/bin', ANTHROPIC_API_KEY: 'k' }, spawn: (argv, env) => { seen = { argv, env }; return f.p; }, onChange: () => {} });
    expect(seen!.argv).toEqual(['/opt/gh', ...GH_LOGIN_ARGV]);
    expect(GH_LOGIN_ARGV).toEqual(['auth', 'login', '--web', '--git-protocol', 'https', '--hostname', 'github.com']);
    expect(seen!.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen!.env.NO_COLOR).toBe('1');
  });

  test('code + URL (split across chunks) → waiting; exit 0 → done (view null, ok)', async () => {
    const f = fakeProc();
    const seen: [GhLoginView | null, boolean | undefined][] = [];
    const h = startGhLogin({ ghPath: '/gh', env: {}, spawn: () => f.p, onChange: (v, ok) => seen.push([v, ok]) });
    expect(h.view()).toEqual({ state: 'starting', code: null, url: null, detail: null });
    f.out('\n! First copy your one-time code: 3E86-');
    f.out('1480\nOpen this URL to continue in your web browser: https://github.com/login/device\n');
    expect(h.view()).toEqual({ state: 'waiting', code: '3E86-1480', url: 'https://github.com/login/device', detail: null });
    f.exit(0);
    await tick();
    expect(seen.at(-1)).toEqual([null, true]);
  });

  test('a URL off github.com is never passed to the web', () => {
    const f = fakeProc();
    const h = startGhLogin({ ghPath: '/gh', env: {}, spawn: () => f.p, onChange: () => {} });
    f.out('one-time code: AAAA-BBBB\nOpen this URL: https://evil.example/login/device\n');
    expect(h.view().url).toBeNull();
  });

  test('non-zero exit → failed with gh\'s last line (ANSI stripped)', async () => {
    const f = fakeProc();
    const h = startGhLogin({ ghPath: '/gh', env: {}, spawn: () => f.p, onChange: () => {} });
    f.out('\x1b[31merror: authorization expired\x1b[0m\n');
    f.exit(1);
    await tick();
    expect(h.view()).toEqual({ state: 'failed', code: null, url: null, detail: 'error: authorization expired' });
  });

  test('cancel → SIGTERM then SIGKILL to the group (-pid), view null, not ok', async () => {
    const f = fakeProc();
    const kills: [number, string][] = [];
    const seen: [GhLoginView | null, boolean | undefined][] = [];
    const h = startGhLogin({ ghPath: '/gh', env: {}, spawn: () => f.p, kill: (pid, sig) => { kills.push([pid, sig]); if (sig === 'SIGKILL') f.exit(137); }, graceMs: 1, onChange: (v, ok) => seen.push([v, ok]) });
    await h.cancel();
    expect(kills).toEqual([[-4242, 'SIGTERM'], [-4242, 'SIGKILL']]);
    expect(seen.at(-1)).toEqual([null, false]);
  });

  test('F3 cancel: the leader dies on SIGTERM at once → the group still gets SIGKILL (a TERM-ignoring child never survives)', async () => {
    const f = fakeProc();
    const kills: [number, string][] = [];
    const h = startGhLogin({ ghPath: '/gh', env: {}, spawn: () => f.p, kill: (pid, sig) => { kills.push([pid, sig]); if (sig === 'SIGTERM') f.exit(143); }, graceMs: 5_000, onChange: () => {} });
    const t0 = Date.now();
    await h.cancel();
    expect(Date.now() - t0).toBeLessThan(1_000); // no wait for the grace once the leader is gone
    expect(kills).toEqual([[-4242, 'SIGTERM'], [-4242, 'SIGKILL']]);
  });

  test('timeout → the group is killed, failed', async () => {
    const f = fakeProc();
    const kills: number[] = [];
    const h = startGhLogin({ ghPath: '/gh', env: {}, spawn: () => f.p, kill: (pid) => { kills.push(pid); f.exit(143); }, graceMs: 1, timeoutMs: 5, onChange: () => {} });
    await new Promise((r) => setTimeout(r, 30));
    expect(kills[0]).toBe(-4242);
    expect(h.view().state).toBe('failed');
  });
});
