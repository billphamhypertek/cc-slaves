// The shell context: App builds it once per render and hands it to its split-out parts (appMenus.ts, appIntents.ts,
// LeftColumn.tsx), so each part reads the state and actions it needs from one bag instead of its own props list.
import type { Command, LaneView, Snapshot, Target } from '../../../shared/protocol.ts';
import type { Tr } from '../lib/i18n.tsx';
import type { DrawerEvent } from '../lib/inspector.ts';
import type { CodeKey, Mode } from '../lib/keys.ts';
import type { TasksAsk } from '../lib/traces.ts';
import type { Store, UiState } from '../lib/store.ts';
import type { EngineClient } from '../lib/ws.ts';
import type { AppState } from './useAppState.ts';
import type { useDone } from './useDone.ts';
import type { useSessions } from './useSessions.ts';

export interface ShellCtx {
  ui: AppState; st: UiState; snap: Snapshot | null; pid: string | null; lanes: LaneView[];
  /** the target Đang xem shows (watch / history / interrupt) and the composer's (v2.3 §4.3: a "Nhờ …" override wins). */
  target: Target | null; composer: Target | null; offline: boolean; now: number;
  /** §4.10 window < 1280 px: the left column is the 424 px drawer */
  narrow: boolean;
  tr: Tr; store: Store; client: EngineClient; send: (c: Command) => Promise<unknown>;
  /** v2.1 §4.14 sessions (useSessions) and §4.15 done lanes (useDone) */
  ss: ReturnType<typeof useSessions>; done: ReturnType<typeof useDone>;
  pickProject: (id: string) => void; setTarget: (t: Target) => void; focusInput: () => void; interruptT: (t: Target) => void;
  drawer: (e: DrawerEvent) => void; openAccount: (email: string) => void;
  toggleList: () => void; toggleInbox: () => void; toggleMute: () => void;
  /** v2.3 §4.1 the Deck · Code · Git mode of the current project. */
  mode: Mode; setMode: (m: Mode) => void; codeKey: (k: CodeKey) => void;
  /** a dialog / sheet is open: v2.4 §6.1 no paste / drop lands then. */
  modal: boolean;
  /** v1.1 §4.4 / U6 glow the focused Chờ PO card */
  flash: () => void;
  /** v2.7 §4.2 / §4.5 a Deck trace (strip, chip, card, chat key) → the Tasks tab showing it (Mac channel only). */
  openTasks: (go: TasksAsk) => void;
}
