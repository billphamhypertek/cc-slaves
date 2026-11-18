// hotfix 2026-11-16 (b) G3 `gh_login`: `gh auth login --web` with no tty. Measured 2026-11-16 (gh 2.92.0): without a tty
// gh asks nothing, prints "! First copy your one-time code: XXXX-XXXX" and "Open this URL … https://github.com/login/device",
// then polls GitHub until the PO approves (exit 0). So no pty (unlike `claude auth login`): the row shows the code + the page,
// the PO opens it. The process leads its own group (detached), so cancel / timeout kill everything it started.
import type { GhLoginView } from '../../../shared/protocol.ts';
import { stripEnv, type Env } from '../session/env.ts';

export const GH_LOGIN_ARGV = ['auth', 'login', '--web', '--git-protocol', 'https', '--hostname', 'github.com'] as const;
/** GitHub's device codes live 15 min. */
const TIMEOUT_MS = 15 * 60_000;
const GRACE_MS = 2_000;

export interface GhProc { pid: number; onOutput(cb: (chunk: string) => void): void; exited: Promise<number> }
type GhSpawn = (argv: string[], env: Env) => GhProc;
type Kill = (pid: number, sig: 'SIGTERM' | 'SIGKILL') => void;

const realSpawn: GhSpawn = (argv, env) => {
  const p = Bun.spawn(argv, { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: true });
  const cbs: ((s: string) => void)[] = [];
  const pump = async (r: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    try { for await (const c of r) { const s = dec.decode(c, { stream: true }); for (const cb of cbs) cb(s); } } catch { /* closed */ }
  };
  void pump(p.stdout);
  void pump(p.stderr);
  return { pid: p.pid, onOutput: (cb) => { cbs.push(cb); }, exited: p.exited };
};
const realKill: Kill = (pid, sig) => { try { process.kill(pid, sig); } catch { /* ESRCH: gone */ } };

export interface GhLoginDeps {
  ghPath: string;
  /** The login-shell env (stripped here like every engine-run tool). */
  env: Env;
  /** `view` null = finished (ok: true = logged in, false = cancelled); a failure stays as a `failed` view. */
  onChange: (view: GhLoginView | null, ok?: boolean) => void;
  spawn?: GhSpawn;
  kill?: Kill;
  timeoutMs?: number;
  graceMs?: number;
}

export interface GhLoginHandle { view(): GhLoginView; cancel(): Promise<void> }

// eslint-disable-next-line no-control-regex -- ANSI / C0 control bytes are exactly what this strips
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|[\x00-\x08\x0b-\x1f\x7f]/g;
const CODE_RE = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/;
const URL_RE = /https:\/\/github\.com\/login\/device\b/;

export function startGhLogin(d: GhLoginDeps): GhLoginHandle {
  let view: GhLoginView = { state: 'starting', code: null, url: null, detail: null };
  let text = '';
  let cancelled = false;
  const p = (d.spawn ?? realSpawn)([d.ghPath, ...GH_LOGIN_ARGV], { ...stripEnv(d.env), NO_COLOR: '1' });
  const kill = d.kill ?? realKill;
  const killGroup = async () => {
    kill(-p.pid, 'SIGTERM');
    let t: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([p.exited, new Promise((r) => { t = setTimeout(r, d.graceMs ?? GRACE_MS); })]);
    clearTimeout(t);
    kill(-p.pid, 'SIGKILL'); // always: the leader dying on TERM says nothing of a TERM-ignoring child (same as accounts/login.ts)
  };
  const set = (v: GhLoginView) => { view = v; d.onChange(v); };
  p.onOutput((chunk) => {
    text += chunk.replace(ANSI, '');
    const code = CODE_RE.exec(text)?.[1] ?? null;
    const url = URL_RE.exec(text)?.[0] ?? null;
    if (code !== view.code || url !== view.url) set({ state: code ? 'waiting' : 'starting', code, url, detail: null });
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void killGroup(); }, d.timeoutMs ?? TIMEOUT_MS);
  void p.exited.then((code) => {
    clearTimeout(timer);
    if (cancelled) { d.onChange(null, false); return; }
    if (code === 0 && !timedOut) { d.onChange(null, true); return; }
    const last = text.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? null;
    set({ state: 'failed', code: null, url: null, detail: timedOut ? null : last });
  });
  return {
    view: () => view,
    cancel: async () => { cancelled = true; clearTimeout(timer); await killGroup(); },
  };
}
