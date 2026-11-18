// v2 Settings › Account (spec v2 §6 A1–A9, F16; §4.3 step budget; §4.4 principles). Pure state → view mapping.
// UI strings: namespace `accounts` of shared/i18n (§6A); every string-producing helper takes `tr` first.
import type { Tr } from '../../../shared/i18n/core.ts';
import type { AccountLoginView, AccountView, OrchestratorView, ProjectView, Role, Snapshot } from '../../../shared/protocol.ts';
import { fmtHm, shortEmail } from './format.ts';


const LIVE = new Set<AccountLoginView['state']>(['starting', 'waiting_browser', 'verifying', 'email_mismatch']);
/** engine `OCCUPY` (lane/manager.ts): the states that hold a lane slot on an account. */
const OCCUPY = new Set(['starting', 'running', 'idle', 'waiting_po', 'switching', 'draining']);

/** v2.7.1 D101 manual floor: one ask per account per 60 s (the panel row ⟳ and the ⋯ "Làm mới số liệu"); the dimmed reason, else null. */
const REFRESH_FLOOR_MS = 60_000;
export function refreshRecent(tr: Tr, a: AccountView, now: number): string | null {
  return a.fetchedAt !== null && now - a.fetchedAt < REFRESH_FLOOR_MS ? tr('deck.acc.rowRecent', { hm: fmtHm(a.fetchedAt), at: fmtHm(a.fetchedAt + REFRESH_FLOOR_MS) }) : null;
}

export interface Chip { cls: 'ok' | 'warn' | 'bad'; text: string; relogin: boolean; title: string }
/** §6 A2 login chip; ⚠ / ✗ open A6 directly (§4.3 T2 from the Account screen ≤ 2). */
export function loginChip(tr: Tr, a: AccountView): Chip {
  if (a.loggedOut || a.login === 'out') return { cls: 'bad', text: tr('accounts.chipOut'), relogin: true, title: tr('accounts.relogin') };
  if (a.login === 'expiring') return { cls: 'warn', text: tr('accounts.chipExp'), relogin: !a.terminal, title: tr('accounts.relogin') }; // B-I2
  if (a.login === 'unknown') return { cls: 'warn', text: tr('accounts.chipUnknown'), relogin: false, title: tr('accounts.chipUnknownTitle') };
  return { cls: 'ok', text: tr('accounts.chipOk'), relogin: false, title: tr('accounts.chipOkTitle') };
}

/** §6 A2 / A9 the account's shared-config problems (links). */
export function cfgIssues(tr: Tr, a: AccountView): string[] {
  return a.sharedCfg.issues.map(i => tr('accounts.issueLink', { name: i.name || i.path }));
}

/** `fresh` = open §5.2 new-entry cards (G4 UX 5(b): they live only behind this button). */
export function cfgHeader(tr: Tr, accounts: AccountView[], fresh = 0): { n: number; text: string } {
  const n = accounts.reduce((s, a) => s + cfgIssues(tr, a).length, 0) + fresh;
  return { n, text: n ? tr('accounts.cfgBad', { n }) : tr('accounts.cfgOk') };
}


/** §6 A9C one clash from the dry run (engine `ClashCopy`). */
export interface ClashCopyView { file: string; account: { dir: string; path: string; mtime: number | null }; shared: { dir: string; path: string; mtime: number | null } }
const pad2 = (n: number) => String(n).padStart(2, '0');
const dmHm = (t: number | null) => {
  if (t === null) return '?';
  const d = new Date(t);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
/** G4 UX I2 (mockup A9C): "ba@ 14/11 17:40 · chung 12/11 09:02". */
export const clashLine = (tr: Tr, c: ClashCopyView, email: string) =>
  tr('accounts.clashLine', { who: shortEmail(email), acc: dmHm(c.account.mtime), shared: dmHm(c.shared.mtime) });
export const tildePath = (p: string) => p.replace(/^\/Users\/[^/]+(?=\/|$)/, '~');

/** A9 card key `<email>/<name>` (engine `shared_cfg` card). */
export function parseA9Key(key: string | null | undefined): { email: string; name: string } | null {
  if (!key) return null;
  const i = key.indexOf('/');
  if (i <= 0 || i === key.length - 1) return null;
  return { email: key.slice(0, i), name: key.slice(i + 1) };
}

export const capsText = (tr: Tr, a: AccountView) => `${a.week} ${tr(a.hard ? 'accounts.hard' : 'accounts.soft')}${a.five !== null ? ` · 5h ${a.five}` : ''}`;

export function lanesText(tr: Tr, a: AccountView, laneCaps: Record<string, number>, orchestrators: OrchestratorView[]): string {
  if (a.role === 'orchestrator') {
    const n = orchestrators.filter(o => o.account === a.email).length;
    const max = laneCaps[a.email] ?? 0; // D26: unset = takes no lanes
    return max > 0 ? tr('accounts.orchLanesMax', { n, lanes: a.lanes, max }) : tr('accounts.orchLanes', { n });
  }
  return `${a.lanes}/${laneCaps[a.email] ?? 3}`;
}

type Ctx = Pick<Snapshot, 'lanes' | 'projects' | 'orchestrators' | 'accounts'> & { login?: AccountLoginView | null };
const busyLanes = (email: string, s: Pick<Snapshot, 'lanes'>) => s.lanes.filter(l => l.account === email && OCCUPY.has(l.state)).map(l => l.name);
const isOrch = (a: AccountView, projects: ProjectView[], orchs: OrchestratorView[]) =>
  a.role === 'orchestrator' || projects.some(p => p.orchestratorAccount === a.email) || orchs.some(o => o.account === a.email);

/** §6 A8 / §4.4: why ⋯ › Xoá is locked (same rule as the engine's refusal, accounts/remove.ts); null = allowed. */
export function deleteBlock(tr: Tr, a: AccountView, s: Omit<Ctx, 'accounts'>): string | null {
  const lock = loginLock(tr, a, s.login ?? null);
  if (lock) return lock;
  const busy = busyLanes(a.email, s);
  if (busy.length) return tr('accounts.busy', { names: busy.join(', ') });
  if (isOrch(a, s.projects, s.orchestrators)) return tr('accounts.isOrch');
  return null;
}

/** G4 UX M4: true when the logout moves something (lanes or the orchestrator) → the ⚠ box; false → a plain line. */
export const logoutMoves = (a: AccountView, s: Omit<Ctx, 'accounts'>) => busyLanes(a.email, s).length > 0 || isOrch(a, s.projects, s.orchestrators);

/** §6 A8L: what the logout moves (lanes, not broken ones; the orchestrator per v1 §7.5). */
export function logoutImpact(tr: Tr, a: AccountView, s: Ctx): string[] {
  const out: string[] = [];
  const busy = busyLanes(a.email, s);
  if (busy.length) out.push(tr('accounts.moves', { names: busy.join(', ') }));
  if (isOrch(a, s.projects, s.orchestrators)) {
    const usable = s.accounts.filter(x => x.email !== a.email && !x.loggedOut && !x.full && x.role !== 'orchestrator');
    const to = usable.find(x => x.role === 'primary') ?? usable[0];
    out.push(to ? tr('accounts.orchTo', { to: shortEmail(to.email) }) : tr('accounts.orchToAny'));
  }
  return out.length ? out : [tr('accounts.noMoves')];
}

/** §6 A3: one login at a time on the whole app. */
const loggingIn = (tr: Tr, email: string | null) => (email ? tr('accounts.loggingIn', { email }) : tr('accounts.loggingInOther'));
export const a3Block = (tr: Tr, l: AccountLoginView | null): string | null => (l && LIVE.has(l.state) ? loggingIn(tr, l.email) : null);
const loginLive = (l: AccountLoginView | null) => !!l && LIVE.has(l.state);
/** §6 A8 / A8L: the engine refuses delete and logout while a login runs on the account's dir (accounts/remove.ts). */
export const loginLock = (tr: Tr, a: AccountView, l: AccountLoginView | null): string | null =>
  (l && l.mode === 'relogin' && l.email === a.email && loginLive(l) ? loggingIn(tr, a.email) : null);

const CANCELLABLE = new Set<AccountLoginView['state']>(['starting', 'waiting_browser', 'verifying']);
/**
 * §6 A4 / A6 Huỷ sends `account_login_cancel` for the adopted login, or (F16, not adopted yet) for a live login of the
 * account the dialog was opened for (G4 IMPORTANT-1: never leave it holding the single-flight slot for 10 min).
 */
/**
 * Smoke 2026-11-15: a login keeps running in the engine when the page reloads or the dialog is lost, and A3 then only
 * showed a disabled "Đăng nhập". A dialog opened while a login is live follows it instead (A4 with its link + Huỷ):
 * an add dialog follows a live add login, a relogin dialog one of the same account. Returns the login id to follow, or null.
 */
export function liveLoginToAdopt(req: { k: 'add' } | { k: 'relogin'; email: string }, cur: AccountLoginView | null): string | null {
  if (!cur || !LIVE.has(cur.state)) return null;
  // review M-2: an add dialog follows only an add login (Huỷ there never cancels another account's relogin)
  return (req.k === 'add' ? cur.mode === 'add' : cur.email === req.email) ? cur.id : null;
}

export function cancelsLogin(adopted: AccountLoginView | null, req: { k: 'add' } | { k: 'relogin'; email: string }, cur: AccountLoginView | null): boolean {
  const mine = adopted ?? (req.k === 'relogin' && cur?.email === req.email ? cur : null);
  return !!mine && CANCELLABLE.has(mine.state);
}

/**
 * §6 F16: the login the relogin dialog follows. A relogin's id is the row id (the same for every relogin of that account),
 * so the one the card started is told apart from the last finished one by its data (deadline / state), not by its id.
 * `start` = `snap.login` when the dialog opened. Returns the id to adopt, or null.
 */
export function f16Adopt(start: AccountLoginView | null, cur: AccountLoginView | null, email: string): string | null {
  if (!cur || cur.email !== email) return null;
  if (loginLive(cur)) return cur.id;
  const same = !!start && start.id === cur.id && start.deadline === cur.deadline && start.state === cur.state;
  return same ? null : cur.id;
}

export interface A4Button { id: 'private' | 'browser' | 'copy'; label: string; pri: boolean }
/** §6 A4 / §3.2 SA6: the 1-click "nút mở" of §4.3 is primary. */
export function a4Buttons(tr: Tr, privateWindow: boolean): A4Button[] {
  const priv = tr('accounts.private'), browser = tr('accounts.browser'), copy = tr('accounts.copyLink');
  if (privateWindow) return [{ id: 'private', label: priv, pri: true }, { id: 'browser', label: browser, pri: false }, { id: 'copy', label: copy, pri: false }];
  return [{ id: 'copy', label: copy, pri: true }, { id: 'browser', label: browser, pri: false }];
}

export function countdown(deadline: number, now: number): string {
  const s = Math.min(600, Math.max(0, Math.ceil((deadline - now) / 1000))); // A4 10:00 clock; clock skew never shows 10:01
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export type DlgAction = { id: 'retry' | 'close' | 'keep' | 'drop'; label: string } | { id: 'relogin'; label: string; email: string };
export interface LoginDialogView {
  frame: 'A4' | 'A6' | 'A5' | 'A7' | 'close';
  title: string; lead?: string; text?: string; detail?: string | null; tone?: 'warn' | 'bad';
  primary: DlgAction | null; secondary: DlgAction | null;
}

/** §6 A3–A7: the engine's login state → the dialog frame. */
/** `noA5`: F1 step 2 (v2 §6) — a finished add returns to the list; roles and caps are set once at step 3. */
/** `terminal`: the re-login was of the terminal account (hf1116 B-I2: a wrong email has replaced the terminal's login). */
export function loginDialog(tr: Tr, l: AccountLoginView, o: { noA5?: boolean; terminal?: boolean } = {}): LoginDialogView {
  const CLOSE: DlgAction = { id: 'close', label: tr('common.close') };
  const want = l.email ?? '';
  const got = l.realEmail ?? l.error?.detail ?? '';
  const a7 = (title: string, text: string, tone: 'warn' | 'bad', primary: DlgAction | null, extra: Partial<LoginDialogView> = {}): LoginDialogView =>
    ({ frame: 'A7', title, text, tone, primary, secondary: primary ? CLOSE : null, ...extra });
  const retry: DlgAction = { id: 'retry', label: tr('common.retry') };
  switch (l.state) {
    case 'starting': case 'waiting_browser': case 'verifying':
      return l.mode === 'relogin'
        ? { frame: 'A6', title: tr('accounts.reTitle', { email: want }), lead: tr('accounts.reLead', { email: want }), primary: null, secondary: null }
        : { frame: 'A4', title: tr('accounts.waitTitle'), lead: l.email ? tr('accounts.waitLead', { email: l.email }) : tr('accounts.waitLeadAny'), primary: null, secondary: null };
    case 'email_mismatch':
      return { frame: 'A7', title: tr('accounts.mismatchTitle'), text: tr('accounts.mismatchText', { got: shortEmail(got), typed: shortEmail(want) }), tone: 'warn',
        primary: { id: 'keep', label: tr('accounts.keep', { email: shortEmail(got) }) }, secondary: { id: 'drop', label: tr('accounts.drop', { email: shortEmail(got) }) } };
    case 'done':
      return l.mode === 'add' && !o.noA5 ? { frame: 'A5', title: tr('accounts.a5.title'), primary: null, secondary: null } : { frame: 'close', title: '', primary: null, secondary: null };
    case 'cancelled':
      return { frame: 'close', title: '', primary: null, secondary: null };
    case 'timed_out':
      return a7(tr('accounts.timeout'), tr('accounts.timeoutText') + (l.mode === 'relogin' && want ? tr('accounts.stillOut', { email: shortEmail(want) }) : ''), 'warn', retry);
    case 'failed': {
      const r = l.error?.reason ?? 'exit';
      if (r === 'wrong_email' && o.terminal) return a7(tr('accounts.wrongTitle'), tr('accounts.wrongTerminal', { got: shortEmail(got), want: shortEmail(want) }), 'bad', null, { secondary: CLOSE });
      if (r === 'wrong_email') return a7(tr('accounts.wrongTitle'), tr('accounts.wrongText', { got: shortEmail(got), want: shortEmail(want) }), 'bad', retry);
      if (r === 'duplicate') return a7(tr('accounts.dupTitle'), tr('accounts.dupText', { email: shortEmail(got) }), 'warn', { id: 'relogin', label: tr('accounts.reloginOf', { email: shortEmail(got) }), email: got });
      if (r === 'no_account') return a7(tr('accounts.failTitle'), tr('accounts.noAccount', { email: shortEmail(want) }), 'bad', null, { secondary: CLOSE });
      const text = tr(r === 'no_identity' ? 'accounts.noIdentity' : r === 'layout' ? 'accounts.layout' : r === 'spawn' ? 'accounts.spawn' : 'accounts.failText');
      return a7(tr('accounts.failTitle'), text, 'bad', retry, { detail: l.error?.detail ?? null });
    }
  }
}

export interface A5Values { role: Role; week: number; five: string; hard: boolean; maxLanes: number }
type CapEntry = { role?: Role; week?: number; five?: number; hard?: boolean };
const capsOf = (config: Record<string, unknown>) => (config.caps ?? {}) as Record<string, CapEntry>;
const laneCapsOf = (config: Record<string, unknown>) => (config.laneCaps ?? {}) as Record<string, number>;

/** §4.4 defaults: Chính · 99 % mềm · 3 lane; an email that already has a caps row gets it back ("· thiết lập cũ"). */
export function a5Defaults(email: string, config: Record<string, unknown>, _accounts: AccountView[]): A5Values & { restored: boolean } {
  const c = capsOf(config)[email];
  const lanes = laneCapsOf(config)[email];
  if (!c) return { role: 'primary', week: 99, five: '', hard: false, maxLanes: lanes ?? 3, restored: false };
  return {
    role: c.role ?? 'primary', week: c.week ?? 99, five: c.five === undefined || c.five === null ? '' : String(c.five), hard: c.hard ?? false,
    maxLanes: lanes ?? (c.role === 'orchestrator' ? 0 : 3), restored: true,
  };
}

/** §6 A5 Lưu: `caps_update` replaces every row, so the other rows are sent back as they are; one orchestrator only. */
export function a5Payload(email: string, v: A5Values, config: Record<string, unknown>): { caps: Record<string, CapEntry>; laneCaps: Record<string, number> } {
  const caps: Record<string, CapEntry> = {};
  const laneCaps = { ...laneCapsOf(config) };
  for (const [k, e] of Object.entries(capsOf(config))) {
    if (k === 'default' || k === email) continue;
    const demoted = v.role === 'orchestrator' && e.role === 'orchestrator';
    caps[k] = demoted ? { ...e, role: 'primary' } : e;
    if (demoted && !laneCaps[k]) laneCaps[k] = 3; // D26: an orchestrator's 0 is not a Chính's lane cap
  }
  caps[email] = { role: v.role, week: v.week, ...(v.five.trim() ? { five: Number(v.five) } : {}), hard: v.hard };
  return { caps, laneCaps: { ...laneCaps, [email]: v.maxLanes } }; // D26: the orchestrator's value is kept (0 = no lanes)
}
