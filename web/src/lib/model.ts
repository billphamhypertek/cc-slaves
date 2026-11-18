// v2.4 §4 model / effort: the pure half of the chip (§4.1), the picker (§4.2) and the D51 composer frame (§6.2).
// First paint only; the picker's rules are lib/model-menu.ts (lazy, with ui/ModelMenu.tsx).
import type { Tr } from '../../../shared/i18n/core.ts';
import type { LaneState, LaneView, OrchestratorState, OrchestratorView } from '../../../shared/protocol.ts';
import { COMPOSER_MAX_H, composerHeight } from './done.ts';

/** §4.1 / §4.5 what a chip and its picker read (Điều phối or a lane): the running model · effort, the PO's tier-1 picks, a
 *  change waiting for the turn, MD9. */
export type ModelSubject = Pick<OrchestratorView, 'state' | 'model' | 'modelName' | 'effort' | 'modelPick' | 'effortPick' | 'pending' | 'modelMismatch' | 'contextPct'>;

/** §4.5 lane states as the picker's impact line reads them: a turn in flight or an account switch waits (LM2); no process
 *  (stopped, broken, waiting for quota, held = paused) applies when the lane runs again. */
const LANE_AS: Record<Exclude<LaneState, 'done'>, OrchestratorState> = {
  starting: 'starting', running: 'running', switching: 'running', draining: 'running', idle: 'idle', waiting_po: 'idle',
  stopped: 'stopped', broken: 'stopped', waiting_quota: 'stopped', paused: 'paused',
};

/** §4.5 D55 a lane's chip / picker subject (§5.6: `run` = what runs, `model` / `effort` = tier 1); null = no chip (Xong).
 *  Before Claude Code reported what runs, the chip reads the pick (or "Theo mặc định"). */
export function laneSubject(tr: Tr, l: LaneView): ModelSubject | null {
  if (l.state === 'done') return null;
  const r = l.run;
  return {
    state: LANE_AS[l.state], contextPct: l.contextPct, modelPick: l.model, effortPick: l.effort,
    ...(l.pending ? { pending: l.pending } : {}), ...(l.modelMismatch ? { modelMismatch: true } : {}),
    ...(r ? { model: r.model, ...(r.modelName ? { modelName: r.modelName } : {}), effort: r.effort } : { modelName: l.model ?? tr('model.byDefault'), effort: l.effort }),
  };
}

/** §4.5 a lane Xong has no chip: its last model · effort, as plain text leading its facts line (MD12, Y33); null = not known. */
export function lastRunText(l: LaneView): string | null {
  return l.state === 'done' && l.run ? [l.run.modelName ?? l.run.model, l.run.effort].filter(Boolean).join(' · ') : null;
}

/** §4.1 / §4.2 chip: "Fable 5.2 · high"; pending "→ … · chờ hết lượt" (model, effort only, both). */
export function chipText(tr: Tr, o: Pick<OrchestratorView, 'model' | 'modelName' | 'effort' | 'pending'>): string {
  const name = o.modelName ?? o.model ?? '—', p = o.pending;
  const now = o.effort ? `${name} · ${o.effort}` : name;
  if (!p || (p.model === undefined && !p.effort)) return now;
  const wait = tr('model.waitTurn');
  if (p.model === undefined) return `${now} → ${p.effort} · ${wait}`;
  const to = p.modelName ?? p.model ?? tr('model.byDefault');
  return p.effort ? `${now} → ${to} · ${p.effort} · ${wait}` : `${name} → ${to} · ${wait}`;
}

type Box = Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>;
/** window px of the picker box (it is fixed, outside the Inspector's clip): its top under the chip, or its bottom when it
 *  opens above; its height follows the content up to `maxH`. */
export interface MenuPlace { left: number; width: number; top?: number; bottom?: number; maxH: number }
/** the picker's fixed parts (title, Effort row, a one-line impact line, padding: 145 px measured) + one 26 px model row. */
export const MENU_MIN_H = 172;

/** §4.2 the picker hangs under the chip down to the composer, as wide as the left column less its margins; a short room only
 *  scrolls the model list. Below `MENU_MIN_H` not even one model row would show: only then it opens above the chip. */
export function menuPlace(winH: number, sec: Box, chip: Box, frame: Box): MenuPlace {
  const x = { left: sec.left + 8, width: sec.right - sec.left - 16 }, below = frame.top - chip.bottom - 8;
  if (below >= MENU_MIN_H) return { ...x, top: chip.bottom + 4, maxH: below };
  return { ...x, bottom: winH - chip.top + 4, maxH: Math.max(below, chip.top - 8) };
}

/** §6.2 D51: the bar under the text is 28 px and fixed. */
export const COMPOSER_BAR_H = 28;
/** frame padding (D53): `--s3` 7 px above the text (hot fix 2026-11-16), `--s2` 4 px between text and bar, `--s2` 4 px under the bar (styles.css `.inrow`). */
const PAD_TOP = 7, GAP = 4, PAD_BOTTOM = 4;

/** §6.2 D51 frame geometry for a text of `scrollHeight`: the frame sits on the column bottom, so the bar's distance to it
 *  (`barBottom`) never changes; the text grows upward to `COMPOSER_MAX_H`. @internal (layout model the unit test pins) */
export function composerFrame(scrollHeight: number, border: number): { textH: number; barH: number; barBottom: number; height: number } {
  const textH = composerHeight(scrollHeight, border);
  return { textH, barH: COMPOSER_BAR_H, barBottom: PAD_BOTTOM, height: PAD_TOP + Math.min(textH, COMPOSER_MAX_H) + GAP + COMPOSER_BAR_H + PAD_BOTTOM };
}

/** §6.2 "the conversation is never pushed past 2 chip rows + 3 lines": the Đang xem conversation keeps two lines (I1). This is its
 *  CONTENT box: styles.css `@container (height < 48px)` hides the rows under 48 px, fractional heights included (N1; R32 30 % gives them). */
export const HIST_FLOOR = 48;
/** §6.2 I1 + §6.7 R32 the Đang xem room at a short window: Chờ PO above it takes at most 30 % of the column (CSS), so `room`
 *  (Đang xem's inner height) is the rest. The head (`info`), the conversation floor + its padding (`histPad`; the floor is a
 *  content box) and the composer (`composer`, with its strip at the full 2 rows `tray`) come first; when they do not fit, the
 *  strip caps at one row (`one`, measured) and scrolls. A lane passes `floor` 0 (v2.1 m-2 N2-a: its facts get the room before
 *  its conversation) and `info` = the facts + Subagent head. */
export function columnFit(m: { room: number; info: number; composer: number; tray: number; one: number; histPad: number; floor?: number }): { trayOne: boolean } {
  const need = m.info + (m.floor ?? HIST_FLOOR) + m.histPad + m.composer;
  return { trayOne: need > m.room && m.tray > m.one };
}
