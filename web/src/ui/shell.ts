// App shell decisions kept pure so they can be unit-tested without a DOM (v1.1 fix wave fx2).
import type { Snapshot } from '../../../shared/protocol.ts';
import type { Mode } from '../lib/keys.ts';

/** §4.6 "Đang khởi động": with a snapshot the deck draws the boot (orchestrator / lanes `starting`); the v1 Boot
 *  screen stays only while there is no snapshot yet (engine not reached / still connecting). */
export const bootScreen = (snap: Snapshot | null): snap is null => !snap;

/** §4.12 / spec v2.1 §5.6: the lazy dialog layer (AppModals) is mounted only while one of its parts is open. */
export const modalLayer = (s: { settingsTab: unknown; addOpen: boolean; stopLane: unknown; moveAll: unknown; palette: boolean; menu: unknown; accDlg: unknown;
  sessDlg?: unknown; histAt?: unknown; sm?: unknown; wf?: unknown }): boolean =>
  !!(s.settingsTab || s.addOpen || s.stopLane || s.moveAll || s.palette || s.menu || s.accDlg || s.sessDlg || s.histAt || s.sm || s.wf);

export interface EscState {
  /** v2 §6 A3–A9 dialogs sit on top of Settings. */
  accDlg?: boolean;
  palette: boolean; stopLane: boolean; moveAll: boolean; addOpen: boolean; settings: boolean; wizard: boolean;
  /** v2.2 §6 the Skills & MCP sheet (its own dialogs close first, inside the sheet). */
  skillsMcp?: boolean;
  /** v2.1 §4.14 a session dialog (open / end / rename / resume). */
  sessDlg?: boolean;
  /** v2.4 §6.7 the Chờ PO detail box (a modal; an account dialog it opens closes it first). */
  cardBox?: boolean;
  /** v2.1 §4.11 a "⋯" menu (T9). */
  menu?: boolean;
  /** v2.1 §4.14 the session list ("Lịch sử phiên") closes like a menu. */
  sessList?: boolean;
  /** v2.1 §4.11 the open account panel (§4.7); v2.3 §4.1 false at Code / Git (the panel is Deck's). */
  accPanel?: boolean;
  /** v2.3 §4.1 Code: a dialog (C7 / C22 / C23), the ⌘P list, edit mode (leaving asks when there are changes). */
  codeDlg?: boolean; quickOpen?: boolean; edit?: boolean;
  /** v2.1 §4.11 "Đang xem lên một cấp" is possible (selection is not the orchestrator root); v2.3 false at Code / Git. */
  up: boolean;
  /** v2.1 §4.10 the narrow-window drawer is open. */
  drawer: boolean;
}
export type EscStep = 'accDlg' | 'palette' | 'stopLane' | 'moveAll' | 'addOpen' | 'settings' | 'skillsMcp' | 'wizard' | 'sessDlg' | 'cardBox' | 'menu' | 'sessList' | 'accPanel'
  | 'codeDlg' | 'quickOpen' | 'edit' | 'up' | 'drawer' | null;
/** v2.1 §4.11 Esc closes the top-most thing (layout C): dialogs → "⋯" menu → session list → open account panel →
 *  (v2.3 Code: its dialog → ⌘P → edit mode) → Đang xem up one level (an ended session → the running one viewed before,
 *  §4.14) → narrow drawer. `wizard` swallows Esc. */
export function escapeStep(s: EscState): EscStep {
  const order: Exclude<EscStep, null>[] = ['accDlg', 'palette', 'stopLane', 'moveAll', 'addOpen', 'settings', 'skillsMcp', 'wizard', 'sessDlg', 'cardBox', 'menu', 'sessList', 'accPanel',
    'codeDlg', 'quickOpen', 'edit', 'up', 'drawer'];
  return order.find(k => s[k]) ?? null;
}

export interface BodyState { narrow: boolean; drawer: boolean; offline: boolean; reduced: boolean }
/** Body classes for styles.css: `narrow` (< 1280 px: the left column is a drawer), `drawer` (that drawer is open). Nothing
 *  here depends on the selection, so the deck area never moves (§4). */
export function bodyClasses(s: BodyState): string {
  return [s.narrow && 'narrow', s.narrow && s.drawer && 'drawer', s.offline && 'offline', s.reduced && 'rm'].filter(Boolean).join(' ');
}

/** §4 layout C: the deck starts right of the 400 px column + 2 × 12 px margins (424 px = viewport LEFT_COL); below
 *  1280 px the column is a drawer over the deck, so the deck takes the full width. Depends on the width only. */
export const NARROW_W = 1280, LEFT_W = 424;
export function layoutVars(width: number): { '--deck-left': string } {
  return { '--deck-left': `${width >= NARROW_W ? LEFT_W : 0}px` };
}
/** §4.13 / §6 the toast is centred on the graph left visible: right of the column, and right of the open drawer below 1280 px. */
export function toastVars(width: number, drawerOpen: boolean): { '--tl': string } {
  return { '--tl': `${width >= NARROW_W || drawerOpen ? LEFT_W : 0}px` };
}

/** the root layout vars: deck column, toast centre, and `--bn` = the 36 px of the v1 banner only while it is drawn
 *  (`bannerShown`) — offline on Deck / Code / Git with a project has its own strip, never a dead band over the top bar */
export function shellVars(s: { width: number; narrow: boolean; drawerOpen: boolean; banner: boolean; leftCol: boolean }): Record<string, string> {
  return { ...layoutVars(s.width), ...(s.leftCol ? toastVars(s.width, s.narrow && s.drawerOpen) : { '--tl': '0px' }), '--bn': s.banner ? '36px' : '0px' };
}

/** v2.3 §4.1 at Code / Git the Esc ladder has no account panel step (the panel is Deck's) and no "up" (Đang xem changes
 *  only on an explicit PO choice there). */
export const modeEsc = (mode: Mode, s: { accPanel: boolean; up: boolean }): { accPanel: boolean; up: boolean } =>
  (mode === 'deck' ? s : { accPanel: false, up: false });

/** v2.3 §4.1 Esc inside the viewer (R21): CodeMirror's first (it prevents what it handled, e.g. the ⌘F box) → nothing;
 *  at Code while editing with no dialog / ⌘P on top → the shell's `edit` step (leave edit mode, asking when there are
 *  changes), so one Esc leaves; otherwise leave the viewer (blur). */
export function editorEsc(prevented: boolean, mode: Mode, code: Pick<EscState, 'codeDlg' | 'quickOpen' | 'edit'> | null): 'edit' | 'blur' | null {
  if (prevented) return null;
  return mode === 'code' && code?.edit && !code.codeDlg && !code.quickOpen ? 'edit' : 'blur';
}

/** v2.3 §4.1 L / F9: at Code / Git the Deck list comes on (the mode goes to Deck); at Deck it toggles. */
export const listOnAfter = (mode: Mode, listOn: boolean): boolean => mode !== 'deck' || !listOn;

/** v2.7 §4.1 (D91) every project opens in Tasks; within one app run a project keeps its last mode (memory only, no
 *  storage). No project, or the remote channel (no Tasks tab there, §8): Deck. */
export function modeOf(modes: Readonly<Record<string, Mode>>, projectId: string | null, tasksOn: boolean): Mode {
  const m = projectId ? modes[projectId] : undefined;
  if (m && (m !== 'tasks' || tasksOn)) return m;
  return projectId && tasksOn ? 'tasks' : 'deck';
}
