// v2 §7 `login.ts`: runs `claude auth login|status|logout` for an account dir. Always inside a pty
// (`script -q /dev/null …`, detached = own process group, §3.2 SA1). One login app-wide at a time (A3). Every side effect
// is injectable (spawn, kill, pgrep, timers, layout fs) so unit tests never start a process.
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db.ts';
import { ensureAccountsRoot, ensureDir, paths, writeFileSecure } from '../paths.ts';
import { shq, stripEnv, type Env } from '../session/env.ts';
import { accountKeychainService, deleteKeychainItem, type SecurityRun } from './keychain.ts';
import { applyLayout, nodeLayoutFs, planLayout, safeDeleteAccountDir, type LayoutFs } from './layout.ts';
import { getAccount, listAccounts, newAccountId, normEmail, undismissTerminal, upsertAccount } from './registry.ts';

/** §6 A4: 10:00 on the clock. */
export const LOGIN_TIMEOUT_MS = 10 * 60_000;
/** §3.2 SA1: SIGTERM both groups, then SIGKILL after 3 s. */
const KILL_GRACE_MS = 3_000;
/** `auth status` / `auth logout` cap. */
const AUTH_CMD_TIMEOUT_MS = 30_000;

/** `no_account`: a re-login finished but its row is gone or now points at another dir (IMPORTANT-3: no phantom row). */
type FailReason = 'exit' | 'wrong_email' | 'duplicate' | 'no_identity' | 'layout' | 'spawn' | 'no_account';
export type LoginState =
  | { kind: 'starting' }
  /** `url`: the link to open (the BROWSER helper's localhost one when given); `codeUrl`: the pty's manual link that shows a code to paste. */
  | { kind: 'waiting_browser'; url: string; codeUrl?: string }
  | { kind: 'verifying' }
  /** §6 A7f (add only): the email typed at A3 ≠ the one logged in. The dir is held until `resolveMismatch`. */
  | { kind: 'email_mismatch'; email: string; asked: string }
  | { kind: 'done'; email: string; accountUuid: string | null; orgUuid: string | null }
  /** `detail`: last output line (A7c), or the real email (A7d/e). */
  | { kind: 'failed'; reason: FailReason; detail: string | null }
  | { kind: 'cancelled' }
  | { kind: 'timed_out' };
type Terminal = Extract<LoginState, { kind: 'done' | 'failed' | 'cancelled' | 'timed_out' }>;

/** The pty child as login.ts sees it: `pid` = the `script` process = its process group id (detached). */
export interface PtyProc {
  pid: number;
  write(s: string): void;
  onOutput(cb: (chunk: string) => void): void;
  /** Exit code (a signal death → 128 + n). */
  exited: Promise<number>;
}
export type PtySpawn = (argv: string[], env: Env) => PtyProc;
/** `pid < 0` = a process group, as kill(2). */
export type Kill = (pid: number, sig: 'SIGTERM' | 'SIGKILL') => void;
export type Pgrep = (ppid: number) => Promise<number[]>;
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

/**
 * BSD `script` refuses a socket or named-FIFO stdin (`tcgetattr/ioctl: Operation not supported on socket`, measured
 * 2026-11-15) and Bun's pipes are sockets. So zsh hands it an anonymous pipe fed by `cat` and `exec`s it: the leader
 * pid stays `script` (pgid = its pid, detached), `cat` shares that group, and `script` exits with the child's code.
 */
const PTY_WRAPPER = ['/bin/zsh', '-f', '-c', 'exec script -q /dev/null "$@" < <(exec cat)', 'zsh'] as const;

const nodePtySpawn: PtySpawn = (argv, env) => {
  const p = Bun.spawn([...PTY_WRAPPER, ...argv], { env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', detached: true });
  const cbs: ((s: string) => void)[] = [];
  const pump = async (r: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    try { for await (const c of r) { const s = dec.decode(c, { stream: true }); for (const cb of cbs) cb(s); } } catch { /* closed */ }
  };
  void pump(p.stdout);
  void pump(p.stderr);
  const exited = p.exited.then((code) => {
    try { void p.stdin.end(); } catch { /* already closed */ } // lets `cat` see EOF and leave
    return code;
  });
  return {
    pid: p.pid,
    write: (s) => { try { void p.stdin.write(s); void p.stdin.flush(); } catch { /* gone */ } },
    onOutput: (cb) => { cbs.push(cb); },
    exited,
  };
};

const nodeKill: Kill = (pid, sig) => {
  try { process.kill(pid, sig); } catch { /* ESRCH: already gone */ }
};

const nodePgrep: Pgrep = async (ppid) => {
  const p = Bun.spawn(['pgrep', '-P', String(ppid)], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.split('\n').map((l) => Number.parseInt(l, 10)).filter((n) => Number.isInteger(n) && n > 0);
};

export interface LoginDeps {
  db: Db;
  /** The login-shell env (`LoginEnv.env`); stripped here with the shared §7 list. */
  env: Env;
  /** Absolute `claude` (LoginEnv.claudePath). */
  claudePath: string;
  spawn?: PtySpawn;
  kill?: Kill;
  pgrep?: Pgrep;
  timers?: Timers;
  layoutFs?: LayoutFs;
  newId?: () => string;
  timeoutMs?: number;
  killGraceMs?: number;
  /** How often the captured-link file and the child pids are polled. */
  pollMs?: number;
}

const realTimers: Timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
const sleep = (t: Timers, ms: number) => new Promise<void>((r) => { t.setTimeout(r, ms); });

/**
 * §3.2 SA1: BSD `script` puts its child in its own session (pgid = child pid), so the `script` group alone misses it.
 * SIGTERM every group, wait `graceMs`, SIGKILL every group. `known` = child pids seen earlier (script may be gone now).
 */
export async function killGroups(
  scriptPid: number, known: readonly number[], d: { kill: Kill; pgrep: Pgrep; timers: Timers; graceMs: number },
): Promise<number[]> {
  const kids = new Set(known);
  for (const k of await d.pgrep(scriptPid).catch(() => [])) kids.add(k);
  const groups = [scriptPid, ...kids];
  for (const g of groups) d.kill(-g, 'SIGTERM');
  await sleep(d.timers, d.graceMs);
  for (const g of groups) d.kill(-g, 'SIGKILL');
  return groups;
}

/**
 * §7 env of every `claude auth …`: stripped login env + the account dir (+ the link-capture script for login).
 * `dir` null = the terminal account (hf1116 T2): CLAUDE_CONFIG_DIR stays unset, so the default Keychain item is used.
 */
export function authEnv(login: Env, dir: string | null, browser?: string): Env {
  return { ...stripEnv(login), ...(dir !== null ? { CLAUDE_CONFIG_DIR: dir } : {}), ...(browser ? { BROWSER: browser } : {}) };
}

/** hf1116 T2: the dir `claude auth …` runs in — null for the terminal account (CLAUDE_CONFIG_DIR unset). */
export const authDir = (a: { configDir: string; terminal: boolean }): string | null => (a.terminal ? null : a.configDir);

// eslint-disable-next-line no-control-regex -- ANSI / C0 control bytes are exactly what this strips
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|[\x00-\x08\x0b-\x1f\x7f]/g;
/** Smoke 2026-11-15: a URL counts only once something follows it — a pty chunk can end mid-URL (`…&co`, no `state`). */
const URL_RE = /https:\/\/\S*oauth\S*(?=\s)/;

export interface Identity {
  email: string;
  accountUuid: string | null;
  orgUuid: string | null;
  tier: string | null;
  plan: string | null;
}

/** §3.1-4 identity = `oauthAccount` in `<dir>/.claude.json`; never `auth status` output. */
export const readIdentity = (dir: string): Identity | null => readIdentityFile(join(dir, '.claude.json'));

/** `oauthAccount` of one `.claude.json` (hf1116: the terminal login keeps it in the home-level `~/.claude.json`). */
export function readIdentityFile(file: string): Identity | null {
  let j: unknown;
  try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  const o = (j as { oauthAccount?: Record<string, unknown> } | null)?.oauthAccount;
  const s = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const email = s(o?.emailAddress);
  if (!o || !email) return null;
  return { email, accountUuid: s(o.accountUuid), orgUuid: s(o.organizationUuid), tier: s(o.organizationRateLimitTier), plan: s(o.planDisplayName) };
}

type LoginMode = 'add' | 'relogin';

export interface LoginHandle {
  readonly id: string;
  readonly dir: string;
  readonly email: string | null;
  /** `add` = new dir (removed on any failure); `relogin` = an existing row's dir (A6, never removed here). */
  readonly mode: LoginMode;
  state(): LoginState;
  onState(cb: (s: LoginState) => void): void;
  /** A4 "Dán mã": `code#state` typed into the pty. false = not waiting or bad format. */
  submitCode(code: string): boolean;
  /** §6 A7f "Giữ x@" / "Bỏ x@". false = not in `email_mismatch`. */
  resolveMismatch(choice: 'keep' | 'drop'): boolean;
  cancel(): Promise<Terminal>;
  /** Resolves after cleanup (processes gone, dir removed on failure) and the single-flight slot is free again. */
  readonly done: Promise<Terminal>;
}
export type StartResult =
  | { ok: true; login: LoginHandle }
  | { ok: false; reason: 'busy'; email: string | null }
  /** A6 for an email with no row / a row without `dir` (a v1-imported row logs in through "Thêm account"). */
  | { ok: false; reason: 'no_account'; email: string };

let active: LoginHandle | null = null;
/** A3: the running login, if any (the UI locks "Đăng nhập" with "Đang đăng nhập <email>"). */
export const activeLogin = (): LoginHandle | null => active;

export interface StartOptions {
  /** A3 "Email (tuỳ chọn)": prefills the page (`--email`), checked after (`failed(wrong_email)` on mismatch). */
  email?: string;
  sso?: boolean;
  /** §6 A6 re-login: the registry row's own `dir` (no new dir); `--email` = the row email; result ≠ it → A7d. */
  accountEmail?: string;
}

/**
 * §7 add-account login: new `<accountsRoot>/<12 hex>` dir, `claude auth login` in a pty, identity → registry.
 * §6 A6 re-login (`accountEmail`): the same flow in the row's existing dir, which no outcome ever deletes.
 */
export function startLogin(deps: LoginDeps, opts: StartOptions = {}): StartResult {
  if (active) return { ok: false, reason: 'busy', email: active.email };
  const relogin = opts.accountEmail !== undefined ? getAccount(deps.db, opts.accountEmail) : null;
  if (opts.accountEmail !== undefined && !relogin?.dir) return { ok: false, reason: 'no_account', email: normEmail(opts.accountEmail) };
  const mode: LoginMode = relogin ? 'relogin' : 'add';
  // hf1116 T3: re-login of the terminal account = the same flow with CLAUDE_CONFIG_DIR unset (identity in ~/.claude.json)
  const terminal = relogin?.terminal === true;
  const d = {
    spawn: deps.spawn ?? nodePtySpawn, kill: deps.kill ?? nodeKill, pgrep: deps.pgrep ?? nodePgrep,
    timers: deps.timers ?? realTimers, fs: deps.layoutFs ?? nodeLayoutFs,
    timeoutMs: deps.timeoutMs ?? LOGIN_TIMEOUT_MS, graceMs: deps.killGraceMs ?? KILL_GRACE_MS, pollMs: deps.pollMs ?? 200,
  };
  const p = paths();
  const root = ensureAccountsRoot();
  // §3.2 SA4: a re-login uses the row's `dir` verbatim (the Keychain item name hashes that exact string).
  const dir = relogin ? relogin.dir! : join(root, (deps.newId ?? newAccountId)());
  const id = relogin ? (relogin.id ?? dir.split('/').pop()!) : dir.split('/').pop()!;
  const loginDir = join(p.home, 'login', id);
  const urlFile = join(loginDir, 'url');
  const pidFile = join(loginDir, 'pid');
  const asked = relogin ? relogin.email : opts.email?.trim() ? opts.email.trim() : null;

  let state: LoginState = { kind: 'starting' };
  const listeners: ((s: LoginState) => void)[] = [];
  const set = (s: LoginState) => { state = s; for (const l of listeners) { try { l(s); } catch { /* listener bug */ } } };
  let proc: PtyProc | null = null;
  const childPids = new Set<number>();
  let lastLine: string | null = null;
  let outBuf = '';
  let rawBuf = '';
  let urlFromBrowser = false; // ANSI is stripped over the whole buffer: an escape can be split across chunks too
  let finishing: Promise<Terminal> | null = null;
  let resolveDone!: (t: Terminal) => void;
  const done = new Promise<Terminal>((r) => { resolveDone = r; });
  let timeoutH: unknown = null;
  let pollH: unknown = null;

  const removeDir = () => {
    if (mode === 'relogin') return; // A6 / A7(a)(b)(d): the account stays (✗), its dir is never touched
    try { safeDeleteAccountDir(dir, root, d.fs); } catch { /* refused: leave it, the boot sweep logs it */ }
  };
  const finish = (t: Terminal, opt: { kill: boolean; removeDir: boolean; logoutFirst?: boolean }): Promise<Terminal> => {
    if (finishing) return finishing;
    // T7 ⑥: the terminal state goes out only after the old groups are dead and the single-flight slot is free, so an
    // immediate A7 "Thử lại" never meets `login_busy` and never races a process of this login.
    finishing = (async () => {
      if (timeoutH !== null) d.timers.clearTimeout(timeoutH);
      if (pollH !== null) d.timers.clearTimeout(pollH);
      if (proc && opt.kill) await killGroups(proc.pid, [...childPids], { kill: d.kill, pgrep: d.pgrep, timers: d.timers, graceMs: d.graceMs });
      // A7d/e/f: the login did succeed in this dir: sign it out so no token of the wrong account is left (then, when
      // adding, remove the dir).
      // hf1116 T3: never sign the terminal's own login out (the terminal / VS Code use it too)
      if (opt.logoutFirst && !terminal) await logout(dir, deps).catch(() => null);
      if (opt.removeDir) removeDir();
      rmSync(loginDir, { recursive: true, force: true });
      if (active === handle) active = null;
      set(t);
      resolveDone(t);
      return t;
    })();
    return finishing;
  };

  const register = (who: Identity) => {
    // IMPORTANT-3: the row was deleted (or re-pointed) while the browser was open → never write a dir-less phantom row.
    if (mode === 'relogin' && getAccount(deps.db, who.email)?.dir !== dir) { void fail('no_account', who.email, { kill: false, logoutFirst: true }); return; }
    // A5: a dir-less v1 row keeps its role / caps — only identity fields are written. A6: status (logged_out) cleared.
    upsertAccount(deps.db, {
      email: who.email, accountUuid: who.accountUuid, orgUuid: who.orgUuid, status: null,
      ...(mode === 'add' ? { id, dir } : {}),
      ...(who.tier ? { tier: who.tier } : {}), ...(who.plan ? { plan: who.plan } : {}),
    });
    if (mode === 'add') undismissTerminal(deps.db, who.email); // hf1116 T3: a cc-slaves login of a removed terminal email
    void finish({ kind: 'done', email: normEmail(who.email), accountUuid: who.accountUuid, orgUuid: who.orgUuid }, { kill: false, removeDir: false });
  };
  let mismatch: Identity | null = null;
  const dropMismatch = () => finish({ kind: 'cancelled' }, { kill: false, removeDir: true, logoutFirst: true });

  const handle: LoginHandle = {
    id, dir, email: asked, mode,
    state: () => state,
    onState: (cb) => { listeners.push(cb); },
    submitCode(code) {
      const c = code.trim();
      if (state.kind !== 'waiting_browser' || !proc || !/^[^\s#]+#[^\s#]+$/.test(c)) return false;
      proc.write(`${c}\r`);
      return true;
    },
    resolveMismatch(choice) {
      if (state.kind !== 'email_mismatch' || !mismatch || finishing) return false;
      const who = mismatch;
      if (choice === 'drop') { void dropMismatch(); return true; }
      if (getAccount(deps.db, who.email)?.dir) { void fail('duplicate', who.email, { kill: false, logoutFirst: true }); return true; }
      register(who);
      return true;
    },
    // A7f: cancelling while the mismatch waits = "Bỏ" (the dir holds a login of the other account).
    cancel: () => (state.kind === 'email_mismatch' ? dropMismatch() : finish({ kind: 'cancelled' }, { kill: true, removeDir: true })),
    done,
  };
  active = handle;

  const fail = (reason: FailReason, detail: string | null, extra: { kill?: boolean; logoutFirst?: boolean } = {}) =>
    finish({ kind: 'failed', reason, detail }, { kill: extra.kill ?? true, removeDir: true, ...(extra.logoutFirst ? { logoutFirst: true } : {}) });

  try {
    if (mode === 'add') { // A6: an existing dir keeps its layout (§5.5 heals it before each spawn)
      const { conflicts } = applyLayout(planLayout(p.claudeHome, dir), d.fs);
      if (conflicts.length) { void fail('layout', conflicts.map((c) => `${c.kind} ${c.path}`).join('; '), { kill: false }); return { ok: true, login: handle }; }
      writeFileSecure(join(dir, 'CLAUDE.md'), `@${join(p.claudeHome, 'CLAUDE.md')}\n`);
    }
    ensureDir(loginDir);
    const script = join(loginDir, 'open-url');
    writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$1" > ${shq(`${urlFile}.tmp`)} && mv ${shq(`${urlFile}.tmp`)} ${shq(urlFile)}\nexit 0\n`, { mode: 0o700 });
    const argv = [deps.claudePath, 'auth', 'login', opts.sso ? '--sso' : '--claudeai', ...(asked ? ['--email', asked] : [])];
    proc = d.spawn(argv, authEnv(deps.env, terminal ? null : dir, script));
    recordPids(pidFile, proc.pid, []);
  } catch (e) {
    void fail('spawn', (e as Error).message, { kill: false });
    return { ok: true, login: handle };
  }

  const pr = proc;
  // Smoke 2026-11-15: claude gives two links. The BROWSER helper's one redirects to localhost (any browser profile on
  // this Mac finishes the login by itself, no code); the pty's one is the manual flow that shows a code to paste.
  let ptyUrl: string | null = null, browserUrl: string | null = null;
  const sawUrl = (url: string, fromBrowser = false) => {
    if (fromBrowser) browserUrl = url; else ptyUrl = url;
    const open = browserUrl ?? ptyUrl!;
    const codeUrl = ptyUrl && ptyUrl !== open ? ptyUrl : undefined;
    const next = { kind: 'waiting_browser' as const, url: open, ...(codeUrl ? { codeUrl } : {}) };
    if (state.kind === 'starting') set(next);
    else if (state.kind === 'waiting_browser' && (state.url !== next.url || state.codeUrl !== next.codeUrl)) set(next);
  };
  pr.onOutput((chunk) => {
    const all = rawBuf + chunk; // matched whole below; only what is kept is cut
    rawBuf = all.slice(-16384);
    // review M-1: a cursor move (CSI A–H/J/K/S/T/f/G) separates words → a space, so the next word never glues onto the URL;
    // the URL is matched before the 8 KiB cut, so a long burst after it cannot push it out
    // eslint-disable-next-line no-control-regex -- a CSI cursor move starts with ESC
    const stripped = all.replace(ANSI, (m) => (m === '\n' || m === '\r' ? '\n' : /^\x1b\[[0-9;?]*[A-HJKSTfG]$/.test(m) ? ' ' : ''));
    outBuf = stripped.slice(-8192);
    const lines = outBuf.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length) lastLine = lines[lines.length - 1]!;
    const m = URL_RE.exec(stripped);
    if (m && m[0] !== ptyUrl) sawUrl(m[0]);
  });
  const poll = async () => {
    pollH = null;
    if (finishing) return;
    if (childPids.size === 0) {
      for (const k of await d.pgrep(pr.pid).catch(() => [])) childPids.add(k);
      if (childPids.size && !finishing) recordPids(pidFile, pr.pid, [...childPids]);
    }
    if ((state.kind === 'starting' || (state.kind === 'waiting_browser' && !urlFromBrowser)) && existsSync(urlFile)) {
      const url = readFileSync(urlFile, 'utf8').trim();
      if (url) { urlFromBrowser = true; sawUrl(url, true); }
    }
    if (!finishing) pollH = d.timers.setTimeout(() => { void poll(); }, d.pollMs);
  };
  void poll();
  timeoutH = d.timers.setTimeout(() => { void finish({ kind: 'timed_out' }, { kill: true, removeDir: true }); }, d.timeoutMs);

  void pr.exited.then((code) => {
    if (finishing) return;
    if (code !== 0) { void fail('exit', lastLine, { kill: true }); return; }
    set({ kind: 'verifying' });
    const who = terminal ? readIdentityFile(p.claudeJson) : readIdentity(dir);
    if (!who) { void fail('no_identity', lastLine, { kill: true, logoutFirst: true }); return; }
    const differs = asked !== null && normEmail(asked) !== normEmail(who.email);
    // A7d: re-login into another account → never accepted; that dir is signed out (it stays, the row stays ✗).
    if (differs && mode === 'relogin') { void fail('wrong_email', who.email, { kill: true, logoutFirst: true }); return; }
    // A7f: add with a typed email ≠ the real one → the PO picks keep / drop; the 10-min clock restarts for that choice.
    if (differs) {
      mismatch = who;
      if (timeoutH !== null) d.timers.clearTimeout(timeoutH);
      timeoutH = d.timers.setTimeout(() => { void finish({ kind: 'timed_out' }, { kill: false, removeDir: true, logoutFirst: true }); }, d.timeoutMs);
      set({ kind: 'email_mismatch', email: normEmail(who.email), asked: normEmail(asked) });
      return;
    }
    if (mode === 'add' && getAccount(deps.db, who.email)?.dir) { void fail('duplicate', who.email, { kill: true, logoutFirst: true }); return; }
    register(who);
  });
  return { ok: true, login: handle };
}

export interface AuthCmdResult {
  /** null = timed out (both groups killed). */
  code: number | null;
  lastLine: string | null;
}

type AuthDeps = Pick<LoginDeps, 'env' | 'claudePath' | 'spawn' | 'kill' | 'pgrep' | 'timers' | 'killGraceMs'> & { cmdTimeoutMs?: number };

/** One short `claude auth <sub>` in the same pty / env helper as login. */
async function runAuthCmd(dir: string | null, sub: 'status' | 'logout', deps: AuthDeps): Promise<AuthCmdResult> {
  const timers = deps.timers ?? realTimers;
  const pr = (deps.spawn ?? nodePtySpawn)([deps.claudePath, 'auth', sub], authEnv(deps.env, dir));
  let last: string | null = null;
  pr.onOutput((c) => {
    const lines = c.replace(ANSI, (m) => (m === '\n' || m === '\r' ? '\n' : '')).split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length) last = lines[lines.length - 1]!;
  });
  let h: unknown = null;
  const timedOut = new Promise<null>((r) => { h = timers.setTimeout(() => r(null), deps.cmdTimeoutMs ?? AUTH_CMD_TIMEOUT_MS); });
  const code = await Promise.race([pr.exited, timedOut]);
  timers.clearTimeout(h);
  if (code === null) {
    await killGroups(pr.pid, [], { kill: deps.kill ?? nodeKill, pgrep: deps.pgrep ?? nodePgrep, timers, graceMs: deps.killGraceMs ?? KILL_GRACE_MS });
  }
  return { code, lastLine: last };
}

/** §3.1-4: `auth status` is read by exit code only (its JSON shape was never measured). */
export async function authStatus(dir: string | null, deps: AuthDeps): Promise<{ loggedIn: boolean; code: number | null }> {
  const r = await runAuthCmd(dir, 'status', deps);
  return { loggedIn: r.code === 0, code: r.code };
}

export const logout = (dir: string | null, deps: AuthDeps): Promise<AuthCmdResult> => runAuthCmd(dir, 'logout', deps);

/** §6 boot kill: `<script pid>\n<child pid>…` (the child leads its own group, BSD script; it may outlive `script`). */
function recordPids(file: string, script: number, kids: number[]): void {
  try { writeFileSync(file, `${[script, ...kids].join('\n')}\n`, { mode: 0o600 }); } catch { /* login dir gone: finishing */ }
}

/** `ps -o command=` of a live pid, null when it is gone. */
type ProcCommand = (pid: number) => Promise<string | null>;
const nodeProcCommand: ProcCommand = async (pid) => {
  const p = Bun.spawn(['ps', '-o', 'command=', '-p', String(pid)], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
  const out = (await new Response(p.stdout).text()).trim();
  await p.exited;
  return out || null;
};
/** Pid reuse guard: only a `script … auth login` leader or a `… auth login` child is ever killed. */
const isLoginProc = (cmd: string | null): boolean => cmd !== null && /\sauth login(\s|$)/.test(cmd);

/** §5.1 account id shape. */
const ACCOUNT_ID = /^[0-9a-f]{12}$/;

export interface SweepDeps {
  db: Db;
  now?: number;
  maxAgeMs?: number;
  layoutFs?: LayoutFs;
  /** mtime (ms) of a path; default lstat. */
  mtimeMs?: (p: string) => number;
  /** `claude auth logout` for an identity-less orphan; absent (no claude found) → that step is skipped. */
  auth?: AuthDeps;
  /** The §7 Keychain step; absent → skipped (the engine always passes one; unit tests never reach `/usr/bin/security`). */
  securityRun?: SecurityRun;
  kill?: Kill;
  pgrep?: Pgrep;
  timers?: Timers;
  killGraceMs?: number;
  procCommand?: ProcCommand;
  log?: (line: string) => void;
}

export interface SweepResult {
  /** Process groups killed (a login left running by a crashed engine). */
  killed: number[];
  removed: string[];
  /** Dirs that still hold a login (`oauthAccount`) but no row: kept, for the "Account mồ côi" card. */
  orphans: { dir: string; email: string }[];
}

/**
 * §6 "Engine khởi động lại" / §8 at boot (no login of this engine can be running): ① kill every group recorded in
 * `~/.cc-slaves/login/<id>/pid` that is still a login process, ② clear `login/`, ③ every `<accountsRoot>/<12 hex>` dir
 * no row points at (exact dir, id or basename) and older than 10 min: kept when it holds an identity (IMPORTANT-2: a
 * lost state.db must never wipe logged-in accounts), else the §7 safe-delete way (logout → Keychain item → dir).
 */
export async function sweepAbandonedLogins(deps: SweepDeps): Promise<SweepResult> {
  const { accountsRoot, home } = paths();
  const log = deps.log ?? (() => {});
  const killed = await killLeftoverLogins(join(home, 'login'), deps);
  rmSync(join(home, 'login'), { recursive: true, force: true });
  const out: SweepResult = { killed, removed: [], orphans: [] };
  let names: string[];
  try { names = readdirSync(accountsRoot); } catch { return out; }
  const known = new Set<string>();
  for (const a of listAccounts(deps.db)) {
    if (a.id) known.add(a.id);
    if (a.dir) { known.add(a.dir); known.add(a.dir.replace(/\/+$/, '').split('/').pop()!); }
  }
  const now = deps.now ?? Date.now();
  const maxAge = deps.maxAgeMs ?? LOGIN_TIMEOUT_MS;
  const mtime = deps.mtimeMs ?? ((q: string) => lstatSync(q).mtimeMs);
  for (const n of names) {
    const dir = join(accountsRoot, n);
    if (!ACCOUNT_ID.test(n) || known.has(n) || known.has(dir)) continue;
    if (now - mtime(dir) < maxAge) continue;
    const who = readIdentity(dir);
    if (who) {
      log(`account mồ côi đã đăng nhập ${normEmail(who.email)} (${dir}) — giữ lại, chờ PO thêm lại / xoá`);
      out.orphans.push({ dir, email: normEmail(who.email) });
      continue;
    }
    if (deps.auth) await logout(dir, deps.auth).catch(() => null);
    if (deps.securityRun) {
      try {
        const k = deleteKeychainItem(accountKeychainService(dir), deps.securityRun);
        if (k.result !== 'gone') log(`xoá mục keychain của ${dir}: ${k.result}`);
      } catch (e) { log(`xoá mục keychain của ${dir} lỗi: ${(e as Error).message}`); }
    }
    try { safeDeleteAccountDir(dir, accountsRoot, deps.layoutFs ?? nodeLayoutFs); out.removed.push(dir); } catch { /* refused */ }
  }
  return out;
}

async function killLeftoverLogins(loginRoot: string, deps: SweepDeps): Promise<number[]> {
  let ids: string[];
  try { ids = readdirSync(loginRoot); } catch { return []; }
  const cmd = deps.procCommand ?? nodeProcCommand;
  const pgrep = deps.pgrep ?? nodePgrep;
  const groups = new Set<number>();
  for (const id of ids) {
    let pids: number[];
    try { pids = readFileSync(join(loginRoot, id, 'pid'), 'utf8').split('\n').map((l) => Number.parseInt(l, 10)).filter((x) => Number.isInteger(x) && x > 1); } catch { continue; }
    const [script, ...kids] = pids;
    const cand = new Set(kids);
    if (script !== undefined && isLoginProc(await cmd(script))) {
      groups.add(script);
      for (const k of await pgrep(script).catch(() => [])) cand.add(k);
    }
    for (const k of cand) if (isLoginProc(await cmd(k))) groups.add(k);
  }
  if (groups.size === 0) return [];
  const kill = deps.kill ?? nodeKill;
  const g = [...groups];
  for (const x of g) kill(-x, 'SIGTERM');
  await sleep(deps.timers ?? realTimers, deps.killGraceMs ?? KILL_GRACE_MS);
  for (const x of g) kill(-x, 'SIGKILL');
  deps.log?.(`đăng nhập dở dang: đã dừng nhóm tiến trình ${g.join(', ')}`);
  return g;
}
