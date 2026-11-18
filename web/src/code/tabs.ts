// spec v2.3 §5.4 / §10.1 the file tabs of one Code source (pure): a preview tab (1a, italic) that the next file opened the
// same way replaces in place, pinned tabs, close with the right neighbour taking over, the parent dir after a name that
// shows twice. Each (project, source) has its own set (2a); the sets (path, preview, selected tab) are remembered in
// localStorage next to the Deck / Code / Git mode (V9). Scroll position and cursor are not remembered.
import { isObj } from '../../../shared/json.ts';

export interface Tab { path: string; preview: boolean }
export interface TabSet { tabs: readonly Tab[]; active: string | null }
export const EMPTY_SET: TabSet = { tabs: [], active: null };

/** Open `path`: a tab it has → select (and pin when `pin`); else a preview replaces the preview tab, or goes right of the
 *  selected tab. */
export function openTab(s: TabSet, path: string, pin = false): TabSet {
  if (s.tabs.some(t => t.path === path)) return { tabs: pin ? s.tabs.map(t => (t.path === path ? { path, preview: false } : t)) : s.tabs, active: path };
  const tab = { path, preview: !pin };
  const pv = pin ? -1 : s.tabs.findIndex(t => t.preview);
  if (pv >= 0) return { tabs: s.tabs.map((t, i) => (i === pv ? tab : t)), active: path };
  const at = s.active === null ? s.tabs.length : s.tabs.findIndex(t => t.path === s.active) + 1;
  return { tabs: [...s.tabs.slice(0, at), tab, ...s.tabs.slice(at)], active: path };
}
export const pinTab = (s: TabSet, path: string): TabSet =>
  (s.tabs.some(t => t.path === path && t.preview) ? { ...s, tabs: s.tabs.map(t => (t.path === path ? { path, preview: false } : t)) } : s);
export const selectTab = (s: TabSet, path: string): TabSet => (s.tabs.some(t => t.path === path) ? { ...s, active: path } : s);

export function closeTab(s: TabSet, path: string): TabSet {
  const i = s.tabs.findIndex(t => t.path === path);
  if (i < 0) return s;
  const tabs = s.tabs.filter(t => t.path !== path);
  if (!tabs.length) return EMPTY_SET;
  return { tabs, active: s.active === path ? (tabs[i] ?? tabs[i - 1])!.path : s.active };
}

const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const parentOf = (p: string) => { const d = p.slice(0, Math.max(0, p.lastIndexOf('/'))); return d ? baseOf(d) : null; };
/** §5.4 the tab text: the file name, plus its parent dir (dim) when another tab has the same name. */
export function tabLabels(tabs: readonly Tab[]): Map<string, { name: string; dir: string | null }> {
  const n = new Map<string, number>();
  for (const t of tabs) n.set(baseOf(t.path), (n.get(baseOf(t.path)) ?? 0) + 1);
  return new Map(tabs.map(t => [t.path, { name: baseOf(t.path), dir: (n.get(baseOf(t.path)) ?? 0) > 1 ? parentOf(t.path) : null }]));
}

type KeyStore = Pick<Storage, 'getItem' | 'setItem'>;
const KEY = 'ccs.code.tabs';
/** stored: `{ [projectId]: { [srcKey]: { tabs: [path, preview][], active } } }` */
type Stored = Record<string, Record<string, { tabs: [string, boolean][]; active: string | null }>>;
const lsOr = (): KeyStore | null => globalThis.localStorage ?? null;
function read(ks: KeyStore | null): Stored {
  try { const v: unknown = JSON.parse(ks?.getItem(KEY) ?? '{}'); return isObj(v) ? v as Stored : {}; } catch { return {}; }
}
function write(ks: KeyStore | null, all: Stored): void {
  try { ks?.setItem(KEY, JSON.stringify(all)); } catch { /* storage full / blocked: the tabs live for this session */ }
}
function parse(v: unknown): TabSet | null {
  if (!isObj(v) || !Array.isArray(v.tabs)) return null;
  const tabs: Tab[] = [];
  for (const t of v.tabs) {
    if (!Array.isArray(t) || typeof t[0] !== 'string') return null;
    tabs.push({ path: t[0], preview: t[1] === true });
  }
  if (!tabs.length) return null;
  const active = typeof v.active === 'string' && tabs.some(t => t.path === v.active) ? v.active : tabs[0]!.path;
  return { tabs, active };
}

export function saveTabs(pid: string, src: string, s: TabSet, ks: KeyStore | null = lsOr()): void {
  const all = read(ks), p = { ...all[pid] };
  if (s.tabs.length) p[src] = { tabs: s.tabs.map(t => [t.path, t.preview]), active: s.active }; else delete p[src];
  all[pid] = p;
  write(ks, all);
}

/** The project's sets at app start; a source not in `live` (lane gone, worktree deleted, §4.2) is dropped for good and
 *  listed in `dropped` (its hot-exit buffers go with it, §5.4). */
export function loadTabs(pid: string, live: ReadonlySet<string>, ks: KeyStore | null = lsOr()): { sets: Map<string, TabSet>; dropped: string[] } {
  const all = read(ks), p = isObj(all[pid]) ? all[pid] : {};
  const sets = new Map<string, TabSet>(), dropped: string[] = [];
  for (const [src, v] of Object.entries(p)) {
    if (!live.has(src)) { dropped.push(src); continue; }
    const s = parse(v);
    if (s) sets.set(src, s);
  }
  if (dropped.length) { const keep = { ...p }; for (const d of dropped) delete keep[d]; all[pid] = keep; write(ks, all); }
  return { sets, dropped };
}
