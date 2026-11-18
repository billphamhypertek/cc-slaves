// F1 first-run wizard model (v1 spec §6.1, v2 §6, v2.5 §6: 5 steps, no CC Switch): step gating, role/caps defaults, the
// caps_update payload.
import type { AccountView, Role, SetupStatus } from '../../../shared/protocol.ts';
import type { Key, Params, Tr } from '../../../shared/i18n/core.ts';
import { shortEmail } from './format.ts';

export type Step = 1 | 2 | 3 | 4 | 5;
export type StepState = 'ok' | 'no' | 'now' | '';
/** §6A step labels (namespace `wizard`); hf1116 (b): step 1 is "Công cụ" (Claude Code + the optional Git block); v2.5 §6 step 3
 *  "Bộ công cụ" sits after Account (the one required gate) and never gates (A3). */
export const STEP_KEYS: readonly Key[] = ['wizard.step.tools', 'wizard.step.account', 'wizard.step.toolkit', 'wizard.step.roles', 'wizard.step.done'];

/** One editable row of the roles/caps table (F1d, F12 Account tab). `five` is the raw text ('' = no 5h cap). */
export interface RoleRow { email: string; role: Role; week: number; five: string; hard: boolean; maxLanes: number }

export const loggedInCount = (s: SetupStatus) => s.accounts.filter(a => a.loggedIn).length;

const EMAIL = /^[^\s@]+@[^\s@]+$/;
const pctOk = (n: number) => Number.isFinite(n) && n >= 1 && n <= 100;

/** `poEmail` is checked only when given (the remote-access email moved to v3; the wizard no longer asks for it). */
function roleIssues(rows: RoleRow[], poEmail?: string): { key: Key; params?: Params }[] {
  const errs: { key: Key; params?: Params }[] = [];
  const n = rows.filter(r => r.role === 'orchestrator').length;
  if (n !== 1) errs.push({ key: 'wizard.err.oneOrch', params: { n } });
  for (const r of rows) {
    if (!pctOk(r.week)) errs.push({ key: 'wizard.err.week', params: { email: shortEmail(r.email) } });
    if (r.five.trim() && !pctOk(Number(r.five))) errs.push({ key: 'wizard.err.five', params: { email: shortEmail(r.email) } });
  }
  if (poEmail !== undefined && !EMAIL.test(poEmail.trim())) errs.push({ key: 'wizard.err.poEmail' });
  return errs;
}
export const roleErrors = (tr: Tr, rows: RoleRow[], poEmail?: string): string[] => roleIssues(rows, poEmail).map(i => tr(i.key, i.params));

export function canAdvance(step: Step, s: SetupStatus, rows: RoleRow[]): boolean {
  switch (step) {
    case 1: return s.claude.ok;
    case 2: return loggedInCount(s) >= 1;
    case 4: return roleIssues(rows).length === 0;
    default: return true;
  }
}

/**
 * v2 §4.3 / mockup F1S1: the wizard always opens on step 1 (✓ Claude Code + "Tiếp" is in the 7-click budget; the §6A
 * language switch lives there), and the account step is always shown.
 */
export const FIRST_STEP: Step = 1;

export function stepStates(s: SetupStatus, current: Step, rows: RoleRow[]): StepState[] {
  return ([1, 2, 3, 4, 5] as Step[]).map(i => {
    if (i === current) return 'now';
    return i < current ? (canAdvance(i, s, rows) ? 'ok' : 'no') : '';
  });
}

type CapEntry = { role?: Role; week?: number; five?: number; hard?: boolean };

/**
 * v2 §6 roles step (v2.5: step 4): an email with a caps row (v1 import) gets it back; the rest get Chính 99 % mềm, 3 lanes. No row is
 * Điều phối yet → the first account is (v1 §6.1).
 */
export function wizardRoles(emails: string[], config: Record<string, unknown>): RoleRow[] {
  const caps = (config.caps ?? {}) as Record<string, CapEntry>;
  const lanes = (config.laneCaps ?? {}) as Record<string, number>;
  const solo = emails.length === 1;
  const rows: RoleRow[] = emails.map(email => {
    const c = caps[email];
    return {
      email, role: c?.role ?? 'primary', week: c?.week ?? 99, five: c?.five === undefined ? '' : String(c.five), hard: c?.hard ?? false,
      maxLanes: c?.role === 'orchestrator' ? orchLaneCap(lanes[email], solo) : (lanes[email] ?? 3),
    };
  });
  if (rows.length && !rows.some(r => r.role === 'orchestrator')) rows[0] = withRole(rows[0]!, 'orchestrator', solo);
  return rows;
}

/** D26: the orchestrator's lane cap. Alone → its real cap (a stored 0 is not one, v2 §6); else the stored value, default 0. */
export const orchLaneCap = (stored: number | undefined, solo: boolean): number => (solo ? stored || 3 : stored ?? 0);

/** D26: a row that becomes Điều phối (not alone) starts at 0 lanes; one that leaves Điều phối with 0 gets the default 3. */
export function withRole<T extends { role: Role; maxLanes: number }>(r: T, role: Role, solo: boolean): T {
  if (role === r.role) return r;
  if (role === 'orchestrator') return { ...r, role, maxLanes: solo ? r.maxLanes : 0 };
  return { ...r, role, maxLanes: r.role === 'orchestrator' && r.maxLanes === 0 ? 3 : r.maxLanes };
}

/** F1d: prefill from the caps the engine already knows; none → first = Điều phối, the rest Chính 99 % mềm. */
export function defaultRoles(emails: string[], known: AccountView[]): RoleRow[] {
  const anyKnown = emails.some(e => known.some(a => a.email === e));
  const solo = emails.length === 1;
  const rows: RoleRow[] = emails.map((email, i) => {
    const k = known.find(a => a.email === email);
    const role: Role = k ? k.role : !anyKnown && i === 0 ? 'orchestrator' : 'primary';
    const maxLanes = role === 'orchestrator' ? orchLaneCap(undefined, solo) : 3;
    if (k) return { email, role, week: k.week, five: k.five === null ? '' : String(k.five), hard: k.hard, maxLanes };
    return { email, role, week: 99, five: '', hard: false, maxLanes };
  });
  if (rows.length && !rows.some(r => r.role === 'orchestrator')) rows[0] = withRole(rows[0]!, 'orchestrator', solo);
  return rows;
}

export function capsPayload(rows: RoleRow[]): Record<string, { role: Role; week: number; five?: number; hard: boolean }> {
  const out: Record<string, { role: Role; week: number; five?: number; hard: boolean }> = {};
  for (const r of rows) out[r.email] = { role: r.role, week: r.week, ...(r.five.trim() ? { five: Number(r.five) } : {}), hard: r.hard };
  return out;
}

/** v2 §6: the only account is both Điều phối and lane-taker (the engine ignores its `laneCaps = 0`, picker.ts). */
export const soloAccount = (rows: RoleRow[]) => rows.length === 1;

/** `laneCaps` for `config_update`: every row's own value (D26: the orchestrator's too; 0 = it takes no lanes). */
export function laneCapsPayload(rows: RoleRow[]): Record<string, number> {
  return Object.fromEntries(rows.map(r => [r.email, r.maxLanes]));
}
