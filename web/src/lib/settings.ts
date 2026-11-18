// F12 settings tabs (spec §6.12, U9). Remote channel: only the remote tab, view only (N2, N4).
import type { Channel, Command } from '../../../shared/protocol.ts';
import type { Key } from '../../../shared/i18n/core.ts';
import { NOTIFY_CHANNEL_IDS, NOTIFY_EVENT_IDS } from '../../../shared/notify-prefs.ts';
import type { Tr } from './i18n.tsx';

export type SettingsTab = 'proj' | 'acc' | 'noti' | 'model' | 'git' | 'wf' | 'remote' | 'engine';
const ALL: { id: SettingsTab; key: Key }[] = [
  { id: 'proj', key: 'settings.tab.proj' }, { id: 'acc', key: 'settings.tab.acc' }, { id: 'noti', key: 'settings.tab.noti' },
  { id: 'model', key: 'settings.tab.model' }, { id: 'git', key: 'settings.tab.git' },
  { id: 'wf', key: 'settings.tab.wf' }, // v2.9 §4.1 opens the Quy trình screen (AppModals), never a tab body
  { id: 'remote', key: 'settings.tab.remote' }, { id: 'engine', key: 'settings.tab.engine' },
];
/** G4 UX 5(a): remote access is deferred to v3 → no "Truy cập từ xa" tab on the Mac while it is off. */
export const settingsTabs = (channel: Channel | null, remoteOn: boolean) =>
  (channel === 'mac' ? ALL.filter(t => t.id !== 'remote' || remoteOn) : ALL.filter(t => t.id === 'remote'));
/** U9: tabs whose actions apply at once have no Save / Hủy (v2.4 §4.5 Y43: Model too; hf1116 (b): Git). */
export const INSTANT_TABS: ReadonlySet<SettingsTab> = new Set<SettingsTab>(['model', 'git', 'remote', 'engine']);

/** v2.4 §5.6 one row of Cài đặt › Model; `null` = "Theo Claude Code". */
export interface ModelCell { model: string | null; effort: string | null }
export type ModelDefaults = Record<'orchestrator' | 'lane', ModelCell>;
const str = (v: unknown) => (typeof v === 'string' ? v : null);
const cellOf = (v: unknown): ModelCell => { const c = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>; return { model: str(c.model), effort: str(c.effort) }; };
/** v2.4 §5.6 `config.modelDefaults` with every missing cell `null`. */
export function modelDefaultsOf(cfg: unknown): ModelDefaults {
  const c = (cfg && typeof cfg === 'object' ? cfg : {}) as Record<string, unknown>;
  return { orchestrator: cellOf(c.orchestrator), lane: cellOf(c.lane) };
}
/** v2.4 §5.6 / R40 M6 the `config_update` patch: the whole `modelDefaults` (the loader merges one level only). */
export const modelDefaultsPatch = (cur: ModelDefaults, row: keyof ModelDefaults, cell: ModelCell) => ({ modelDefaults: { ...cur, [row]: cell } });

/** Cài đặt › Thông báo row / column labels (the matrix itself: `shared/notify-prefs.ts`). */
export const NOTIFY_EVENTS = NOTIFY_EVENT_IDS.map(e => [e, `settings.noti.ev.${e}` as Key] as const);
export const NOTIFY_CHANNELS = NOTIFY_CHANNEL_IDS.map(ch => [ch, `settings.noti.ch.${ch}` as Key] as const);

/** v2.1 §4.14 Cài đặt › Engine: the `cleanupPeriodDays` in use (shared ~/.claude/settings.json, read by the engine) and
 *  the suggestion to set 90 while it is lower. Read only: cc-slaves never writes that file. null = not read yet. */
export function cleanupLine(tr: Tr, days: number | null): string | null {
  if (days === null) return null;
  const line = tr('settings.engine.cleanupDays', { n: days });
  return days < 90 ? tr('settings.engine.cleanupHint', { line }) : line;
}

/** hf1116 (b): opening Cài đặt › Git on the Mac re-checks, so it shows the state now (a license accepted in Terminal, gh
 *  logged in elsewhere). The remote channel never runs a setup command. */
export function gitRecheck(tab: string, mac: boolean, send: (c: Command) => Promise<unknown>): void {
  if (tab === 'git' && mac) void send({ cmd: 'setup_check' }).catch(() => {});
}
