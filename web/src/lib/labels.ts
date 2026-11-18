// Labels (mockup STATUS / ROLE / PH) shared by HUD parts — §6A catalog `labels.*`, rendered with the caller's `tr`.
import { hasKey, type Key, type Tr } from '../../../shared/i18n/core.ts';
import { isOrchSource, type AccountView, type CardView, type LaneState, type LaneView, type OrchestratorState, type Phase, type Role } from '../../../shared/protocol.ts';

export const LANE_CLASS: Record<LaneState, string> = {
  starting: '', running: 'ok', waiting_po: 'warn', idle: 'acc', waiting_quota: '', switching: 'acc', draining: 'warn', stopped: '', broken: 'bad', done: 'ok',
  paused: '', // hotfix 2026-11-16 held: neutral grey, no pulse
};
export const laneState = (tr: Tr, s: LaneState): string => tr(`labels.lane.${s}`);
export const orchState = (tr: Tr, s: OrchestratorState): string => tr(`labels.orch.${s}`);
/** v2.9 a lane phase: the catalog name of a Quy trình PO phase, else the pack's own phase id as written. */
export function phaseName(tr: Tr, p: Phase): string {
  const k = `labels.phase.${p}`;
  return hasKey(tr.lang, k) ? tr(k as Key) : p;
}
/** §4.12 N2-e the stop dialog's subtitle: "task · note · đang chạy n subagent" (empty parts dropped; nothing → null). */
export function stopSub(tr: Tr, l: Pick<LaneView, 'task' | 'note'>, runningSubs: number): string | null {
  const parts = [l.task, l.note, runningSubs > 0 ? tr('unit.stopSubs', { n: runningSubs }) : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}
/** §6A catalog keys of the account roles. */
export const ROLE_KEY = { orchestrator: 'common.role.orchestrator', primary: 'common.role.primary', backup: 'common.role.backup' } as const satisfies Record<Role, Key>;

/** A turn is in progress → "Ngắt lượt" is offered (U3: one button, for the current target). */
export const laneRunning = (s: LaneState) => s === 'running' || s === 'starting' || s === 'switching';
export const orchRunning = (s: OrchestratorState) => s === 'running' || s === 'starting';

/** v2.8 §7.1 the eight account colours are theme variables (`--pal-1…8` in styles.css): a CSS value, never a computed colour. */
const PALETTE = [1, 2, 3, 4, 5, 6, 7, 8].map(i => `var(--pal-${i})`);
/** Stable per-account colour: orchestrator account first (purple), then registry order. */
export function accountColor(accounts: AccountView[], email: string | null): string {
  if (!email) return 'var(--fg-3)';
  const sorted = [...accounts].sort((a, b) => (a.role === 'orchestrator' ? -1 : 0) - (b.role === 'orchestrator' ? -1 : 0));
  const i = sorted.findIndex(a => a.email === email);
  return i < 0 ? 'var(--fg-3)' : PALETTE[i % PALETTE.length]!;
}

export function cardSource(tr: Tr, c: CardView, projectName?: string): string {
  const orch = tr('common.role.orchestrator');
  if (c.kind === 'orchestrator_down') return projectName ? tr('labels.src.orchProject', { project: projectName }) : orch;
  // §4.11b M1 the engine's broken card carries no source, only `key` = lane:<name>
  const lane = c.source ?? (c.kind === 'broken' && c.key?.startsWith('lane:') ? c.key.slice(5) : null);
  if (c.kind === 'mcp_login') return tr('labels.src.mcp', { name: String(c.params?.name ?? c.key ?? '') }); // v2.2 K13
  const base = isOrchSource(c.source) ? orch : lane ? tr('labels.src.lane', { name: lane })
    : tr(c.kind === 'logged_out' || c.kind === 'cutover' ? 'labels.src.engineAccount' : c.kind === 'cc_updated' ? 'labels.src.engineCc' : 'labels.src.engine');
  return c.kind === 'permission' ? tr('labels.src.permission', { base }) : base;
}
