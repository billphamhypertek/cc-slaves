// v2.1 §4.15 §2 tree collapse as pure logic: the collapsed roots per project remembered in this browser's
// `localStorage` (each remote browser keeps its own), and the web-side "vừa đổi" clock (LaneView has no state-change
// time, T4 ⑤): a lane that changed state or appeared after the first snapshot is kept 60 s, then folds with a 300 ms fade.
import type { LaneView } from '../../../shared/protocol.ts';

/** §4.15 §2 "vừa đổi" window and the fade into the row after it. */
export const CHANGED_MS = 60_000, FADE_MS = 300;

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const KEY = 'ccs.collapsed';
/** project id → collapsed root (session) ids. A broken / missing entry = every tree open (the default). */
export function readCollapsed(s: Store | null): Record<string, string[]> {
  try {
    const v: unknown = JSON.parse(s?.getItem(KEY) ?? '{}');
    if (!v || typeof v !== 'object') return {};
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, string[]] => Array.isArray(e[1]) && e[1].every(x => typeof x === 'string')));
  } catch { return {}; }
}
export function writeCollapsed(s: Store | null, all: Readonly<Record<string, readonly string[]>>): void {
  const kept = Object.fromEntries(Object.entries(all).filter(([, ids]) => ids.length));
  try { s?.setItem(KEY, JSON.stringify(kept)); } catch { /* private mode */ }
}

/** §4.15 §2 "Thu gọn cây #n" / "Thu gọn các cây khác" on `root` among the running `roots`. */
export function collapseNext(cur: readonly string[], roots: readonly string[], root: string, kind: 'collapse' | 'collapseOthers'): string[] {
  if (kind === 'collapse') return cur.includes(root) ? [...cur] : [...cur, root];
  return roots.filter(r => r !== root);
}

const key = (l: Pick<LaneView, 'projectId' | 'name'>) => `${l.projectId}:${l.name}`;
/** §4.15 §2 the change clock: `prev` lanes → `next` lanes at `now`. A new lane or a new state starts the 60 s window;
 *  `prev` null (the first snapshot) starts none. Entries past the window are dropped. */
export function trackChanges(changed: Readonly<Record<string, number>>, prev: readonly LaneView[] | null, next: readonly LaneView[], now: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, at] of Object.entries(changed)) if (now - at < CHANGED_MS + FADE_MS) out[k] = at;
  if (!prev) return out;
  const was = new Map(prev.map(l => [key(l), l.state]));
  for (const l of next) if (was.get(key(l)) !== l.state) out[key(l)] = now;
  return out;
}

/** The next instant a "vừa đổi" label ends or a fade ends (the deck's one wake-up for it); null = none pending. */
export function nextChangeTick(changed: Readonly<Record<string, number>>, now: number): number | null {
  let next: number | null = null;
  for (const at of Object.values(changed)) for (const t of [at + CHANGED_MS, at + CHANGED_MS + FADE_MS])
    if (t > now && (next === null || t < next)) next = t;
  return next;
}
