// hotfix 2026-11-16 (b) review ruling R2: `gh_login` handler with an injected gh spawn. A cancelled login whose gh exits
// only after a NEW login started must not clear the new one (the `e.ghLogin !== h` guard).
import { expect, test } from 'bun:test';
import type { GhLoginView } from '../../../shared/protocol.ts';
import type { Engine } from '../../src/engine.ts';
import { gitSetupHandlers } from '../../src/server/git-setup-commands.ts';
import type { CommandCtx } from '../../src/server/router.ts';
import type { GhProc } from '../../src/setup/gh-login.ts';

function fakeGh(pid: number) {
  const cbs: ((s: string) => void)[] = [];
  let exit!: (n: number) => void;
  const p: GhProc = { pid, onOutput: (cb) => { cbs.push(cb); }, exited: new Promise<number>((r) => { exit = r; }) };
  return { p, out: (s: string) => { for (const c of cbs) c(s); }, exit: (n: number) => exit(n) };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('R2 gh_login: a cancelled login exiting after a new login started never clears the new one', async () => {
  const patches: (GhLoginView | null)[] = [];
  const e = {
    ghPath: '/gh', ghLogin: null, login: { env: {} },
    patchGhLogin: (v: GhLoginView | null) => { patches.push(v); },
    runSetupCheck: async () => ({}),
  } as unknown as Engine;
  const procs = [fakeGh(1), fakeGh(2)];
  let n = 0;
  const h = gitSetupHandlers(e, { spawn: () => procs[n++]!.p, kill: () => {}, graceMs: 1 });
  const ctx = {} as CommandCtx;
  h.gh_login({ cmd: 'gh_login' }, ctx);
  const first = e.ghLogin;
  const cancelling = h.gh_login_cancel({ cmd: 'gh_login_cancel' }, ctx); // gh A has not exited yet
  h.gh_login({ cmd: 'gh_login' }, ctx);
  const second = e.ghLogin;
  expect(second).not.toBeNull();
  expect(second).not.toBe(first);
  procs[1]!.out('! First copy your one-time code: 3E86-1480\nOpen this URL: https://github.com/login/device\n');
  procs[0]!.exit(143); // gh A finally exits
  await cancelling;
  await tick();
  expect(e.ghLogin).toBe(second);
  expect(patches.at(-1)).toEqual({ state: 'waiting', code: '3E86-1480', url: 'https://github.com/login/device', detail: null });
});
