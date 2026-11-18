// v2.4 §4.2 / §4.4 the picker's pure rules (rows, marks, effort row, impact line, errors). Only the lazy ui/ModelMenu.tsx
// chunk imports this file (§10.3 first paint: lib/model.ts carries just the chip and the composer frame).
import type { Tr } from '../../../shared/i18n/core.ts';
import type { ModelInfo, SessionModels } from '../../../shared/protocol.ts';
import type { ModelSubject as O } from './model.ts';

/** §4.5 whose picker: Điều phối or a lane (the default row's source, the impact line's wording). */
export type Who = 'orch' | 'lane';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

type MPick = { model: string | null; effort: string | null };
/** §4.4 MD10 a model picked in a session dialog: model + effort in one value; the effort resets only when the model the
 *  pick runs ("Theo mặc định" = `defaultModel`) lacks it (no list = nothing to check against). */
export function pickModel(m: SessionModels | null, cur: MPick, v: string | null): MPick {
  const mi = m?.models.find(x => x.value === (v ?? m.defaultModel ?? 'default'));
  return { model: v, effort: cur.effort && mi && !mi.effortLevels.includes(cur.effort) ? null : cur.effort };
}

export interface ModelRow { value: string | null; label: string; code: string; name?: string; resolved: string | null }

/** §4.5 / §5.6 where "Theo mặc định" comes from: "agent <tên>" · "Cài đặt › Lane" / "Cài đặt › Điều phối" ·
 *  `~/.claude/settings.json` · "mặc định của gói" (an engine without `defaultSource`: the file when it sets a model). */
export function defaultSource(tr: Tr, m: SessionModels, who: Who): string {
  const src = m.defaultSource ?? (m.defaultModel !== null ? 'claude' : 'plan');
  if (src === 'agent') return tr('modelMenu.srcAgent', { name: m.defaultAgent ?? '?' });
  if (src === 'settings') return tr(who === 'lane' ? 'modelMenu.srcSettingsLane' : 'modelMenu.srcSettingsOrch');
  return tr(src === 'claude' ? 'modelMenu.srcFile' : 'modelMenu.srcPlan');
}

/** §4.2 rows: "Theo mặc định" (+ the model it points to + where it comes from), the aliases in Claude Code's order, then
 *  the full ids ("Model cũ hơn"). Claude Code's own `default` row never shows (A3). */
export function modelRows(tr: Tr, m: SessionModels, who: Who = 'orch'): { top: ModelRow[]; older: ModelRow[] } {
  const def = m.models.find(x => x.value === m.defaultModel) ?? null;
  const first: ModelRow = { value: null, label: tr('model.byDefault'), code: defaultSource(tr, m, who),
    name: m.defaultModelName ?? def?.displayName ?? '', resolved: def?.resolvedModel ?? null };
  const row = (x: ModelInfo): ModelRow => ({ value: x.value, label: x.displayName, code: x.resolvedModel, resolved: x.resolvedModel });
  const shown = m.models.filter(x => x.value !== 'default');
  return { top: [first, ...shown.filter(x => !x.value.includes('-')).map(row)], older: shown.filter(x => x.value.includes('-')).map(row) };
}

/** §4.2 one rule for the mark: clock = the pending pick; ✓ = the PO's pick; amber = the running model when it differs. */
export function rowMark(o: O, r: ModelRow): 'pending' | 'pick' | 'running' | null {
  if (o.pending && o.pending.model !== undefined && o.pending.model === r.value) return 'pending';
  if ((o.modelPick ?? null) === r.value) return 'pick';
  if (o.modelMismatch && r.value !== null && r.resolved === o.model) return 'running';
  return null;
}

/** the model whose levels count: the pending one, else the one running. */
function levelModel(o: O, m: SessionModels): ModelInfo | undefined {
  const pv = o.pending?.model;
  if (pv !== undefined) return m.models.find(x => x.value === (pv ?? m.defaultModel ?? 'default'));
  const run = o.model ? m.models.find(x => x.resolvedModel === o.model && x.value !== 'default') ?? m.models.find(x => x.resolvedModel === o.model) : undefined;
  // §4.5 a lane Claude Code has not reported yet: the levels of what it will run (its pick, else the default)
  return run ?? (o.model ? undefined : m.models.find(x => x.value === (o.modelPick ?? m.defaultModel ?? 'default')));
}

/** §4.2 effort row: the running level lit (even unpicked); levels the model lacks dimmed and named; the fallback note. */
export function effortRow(tr: Tr, o: O, m: SessionModels | null): { lit: string | null; pending: string | null; levels: { level: string; on: boolean }[]; note: string | null } {
  const lit = o.effort ?? null, pending = o.pending?.effort ?? null;
  const mi = m && !m.unavailable ? levelModel(o, m) : undefined;
  if (!mi) return { lit, pending, levels: EFFORTS.map(level => ({ level, on: false })), note: null }; // MD8: unknown which model has which level
  const name = mi.displayName, has = new Set(mi.effortLevels);
  const levels = EFFORTS.map(level => ({ level, on: has.has(level) }));
  if (!has.size) return { lit, pending, levels, note: tr('modelMenu.noEffort', { model: name }) };
  if (o.effortPick && lit && o.effortPick !== lit && !has.has(o.effortPick)) return { lit, pending, levels, note: tr('modelMenu.fallback', { pick: o.effortPick, model: name, run: lit }) };
  const missing = EFFORTS.filter(l => !has.has(l));
  return { lit, pending, levels, note: missing.length ? tr('modelMenu.noLevel', { model: name, levels: missing.join(', ') }) : null };
}

/** §4.2 / §4.5 impact line (none in MD9, where the mismatch line takes its place). `afterModel` = the last click changed the
 *  model. A lane's wait names it twice (LM2: messages to it wait, `lane_message` included); no process → "khi lane chạy lại". */
export function impactLine(tr: Tr, o: O, name: string, afterModel: boolean, who: Who = 'orch'): { text: string; cancel: boolean } | null {
  if (o.modelMismatch) return null;
  const busy = tr(who === 'lane' ? 'modelMenu.impactBusyLane' : 'modelMenu.impactBusy', { name });
  if (o.pending) return { text: busy, cancel: true };
  if (o.state === 'stopped' || o.state === 'paused') return { text: tr(who === 'lane' ? 'modelMenu.impactStoppedLane' : 'modelMenu.impactStopped'), cancel: false };
  if (o.state === 'running') return { text: busy, cancel: false };
  if (o.contextPct == null) return { text: tr('modelMenu.impactFirst'), cancel: false };
  return { text: afterModel ? `${tr('modelMenu.impactNext')} ${tr('modelMenu.impactCache')}` : tr('modelMenu.impactNext'), cancel: false };
}

/** §4.2 m4 "a model change since the last turn" (the impact line's cache sentence): a model click sets it, an effort click
 *  keeps it, the next turn clears it. */
export const cacheDirty = (prev: boolean, ev: 'model' | 'effort' | 'turn'): boolean => (ev === 'model' ? true : ev === 'turn' ? false : prev);

/** §4.2 MD9 / §5.6 what the mismatch line says was picked: the tier-1 pick by name, else the default it resolved to + its
 *  source ("Opus 5.5 (Cài đặt › Lane)"), since tiers 2 / 3 also count as a pick there. */
export function mismatchPick(tr: Tr, o: O, m: SessionModels | null, who: Who): string {
  if (o.modelPick) return m?.models.find(x => x.value === o.modelPick)?.displayName ?? o.modelPick;
  if (!m || m.unavailable) return tr('model.byDefault');
  return `${m.defaultModelName ?? m.defaultModel ?? tr('model.byDefault')} (${defaultSource(tr, m, who)})`;
}

/** §4.2 MD6 red line text. */
export function setModelError(tr: Tr, code: string, model: string): string {
  return code === 'model_not_found' ? tr('modelMenu.errNotFound', { model }) : code === 'unsupported' ? tr('modelMenu.errUnsupported') : tr('modelMenu.errTimeout');
}
