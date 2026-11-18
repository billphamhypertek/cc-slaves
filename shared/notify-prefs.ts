// Cài đặt › Thông báo (spec §8.3): the event × channel matrix in `config.notify`, read by the engine (routes) and the web
// (new-card toast, chime). One source so both sides agree on the defaults.

export const NOTIFY_EVENT_IDS = ['ask', 'broken', 'orchestrator_down', 'logged_out', 'all_full', 'lane_done', 'switch'] as const;
export const NOTIFY_CHANNEL_IDS = ['app', 'macos', 'gchat'] as const;
export type NotifyEvent = (typeof NOTIFY_EVENT_IDS)[number];
export type NotifyChannel = (typeof NOTIFY_CHANNEL_IDS)[number];
export type NotifyMatrix = Record<NotifyEvent, Record<NotifyChannel, boolean>>;

const DEFAULT_OFF: Partial<Record<NotifyEvent, NotifyChannel[]>> = { lane_done: ['gchat'], switch: ['macos', 'gchat'] };

/** Config `notify` merged over the defaults (all on, except Lane Xong → Google Chat and Chuyển account → macOS/Chat). */
export function notifyMatrix(cfg: unknown): NotifyMatrix {
  const c = (cfg && typeof cfg === 'object' ? cfg : {}) as Record<string, Record<string, unknown> | undefined>;
  const cell = (e: NotifyEvent, ch: NotifyChannel) => { const v = c[e]?.[ch]; return typeof v === 'boolean' ? v : !DEFAULT_OFF[e]?.includes(ch); };
  return Object.fromEntries(NOTIFY_EVENT_IDS.map((e) => [e, Object.fromEntries(NOTIFY_CHANNEL_IDS.map((ch) => [ch, cell(e, ch)]))])) as NotifyMatrix;
}

/** The matrix row a notification kind follows; null = not in the matrix (fixed route). */
export function notifyEventOf(kind: string): NotifyEvent | null {
  if (kind === 'ask' || kind === 'permission') return 'ask';
  if (kind === 'account_switch') return 'switch';
  return (NOTIFY_EVENT_IDS as readonly string[]).includes(kind) ? (kind as NotifyEvent) : null;
}

/** One channel of a kind: its matrix cell, or `fallback` when the kind is not in the matrix. */
export const notifyOn = (m: NotifyMatrix, kind: string, ch: NotifyChannel, fallback: boolean): boolean => {
  const e = notifyEventOf(kind);
  return e ? m[e][ch] : fallback;
};

/** Chime gain from `config.volume` (0–100, default 25 → the old fixed 0.06); 0 = silent. */
export const chimeGain = (volume: unknown): number =>
  (typeof volume === 'number' && Number.isFinite(volume) ? Math.min(100, Math.max(0, volume)) : 25) * 0.0024;
