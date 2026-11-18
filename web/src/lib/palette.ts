// F22 ⌘K palette (spec §8.5): every action, lane, project, account; diacritics-insensitive fuzzy match. v2.1 §4.12: the
// lane / Điều phối actions are the "⋯" menu items (lib/actions.ts, N2-k).
import type { Tr } from '../../../shared/i18n/core.ts';
import type { Snapshot } from '../../../shared/protocol.ts';
import { shortEmail } from './format.ts';
import { laneState, phaseName } from './labels.ts';
import { sessionLabel, sessionsOf } from './sessions.ts';
import { canRun } from './remote.ts';
import type { Mode } from './keys.ts';
import { laneActions, orchActions, type IconName, type MenuAct, type MenuCtx, type MenuItem } from './actions.ts';

export type PalAct =
  | { t: 'lane'; projectId: string; name: string } | { t: 'project'; id: string } | { t: 'account'; email: string }
  /** v2.1 §4.12 an item of a "⋯" menu (same source as the node / Inspector / F9 menus, N2-k). */
  | { t: 'menu'; act: MenuAct }
  | { t: 'settings' | 'list' | 'inbox' | 'sound' | 'console' | 'addProject' | 'setup' | 'skillsMcp' | 'mcpAdd' | 'mcpLogin' | 'toolkit' | 'graph' | 'quickOpen' }
  /** v2.3 §4.1 the Deck · Code · Git switch. */
  | { t: 'mode'; m: Mode };
/** Heading id; the palette shows `labels.pal.group.<id>` in the UI language. */
type PalGroup = 'lane' | 'action' | 'project' | 'account';
export interface PalItem { id: string; group: PalGroup; label: string; kbd?: string; icon: IconName; act: PalAct;
  /** v2.1 §4.12 dimmed menu item: the reason, not runnable. */
  disabled?: string;
  /** v2.1 §4.15 §2 a lane row's state, right-aligned (N6-d). */
  hint?: string;
  /** N-c the text a query is matched against when it is not the whole label (a lane: its name and task, not the project). */
  match?: string }

export const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

/** null = no match. Substring beats subsequence; prefix and word starts score higher. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = fold(query).trim(), t = fold(text);
  if (!q) return 0;
  const at = t.indexOf(q);
  if (at >= 0) return 1000 + (at === 0 ? 500 : /[\s·(@/.-]/.test(t[at - 1]!) ? 200 : 0) - t.length * 0.1;
  let score = 0, ti = 0, prev = -2;
  for (const ch of q) {
    if (ch === ' ') continue;
    const i = t.indexOf(ch, ti);
    if (i < 0) return null;
    score += 1 + (i === prev + 1 ? 5 : 0) + (i === 0 || /[\s·(@/.-]/.test(t[i - 1]!) ? 10 : 0) - Math.min(i - ti, 10) * 0.2;
    prev = i; ti = i + 1;
  }
  return score;
}

const rank = (items: PalItem[], q: string): PalItem[] =>
  items.map((it, i) => ({ it, i, s: fuzzyScore(q, it.match ?? it.label) }))
    .filter((x): x is { it: PalItem; i: number; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s || a.i - b.i).map(x => x.it);

/** §4.11 N2-k at most this many HÀNH ĐỘNG rows under a query. */
const MAX_ACTIONS = 6;

/**
 * §4.11 / §4.15 §2 (N2-k, N6-d) groups always LANE → HÀNH ĐỘNG → PROJECT → ACCOUNT. LANE: lanes whose name starts with the
 * query (exact, then shorter names), else fuzzy over its name and task. HÀNH ĐỘNG: with a name-prefix match, only the first matched
 * lane's rows (`scoped`); otherwise fuzzy over every action. Empty query = everything, in build order.
 */
export function rankItems(items: PalItem[], q: string, scoped?: (projectId: string, name: string) => PalItem[]): PalItem[] {
  const k = fold(q).trim();
  if (!k) return items;
  const of = (g: PalGroup) => items.filter(i => i.group === g);
  const prefix = of('lane').map((it, i) => ({ it, i, n: it.act.t === 'lane' ? fold(it.act.name) : '' }))
    .filter(x => x.n.startsWith(k)).sort((a, b) => a.n.length - b.n.length || a.i - b.i).map(x => x.it);
  const top = prefix[0]?.act;
  const acts = top?.t === 'lane' && scoped ? scoped(top.projectId, top.name) : rank(of('action'), q);
  return [...(prefix.length ? prefix : rank(of('lane'), q)), ...acts.slice(0, MAX_ACTIONS), ...rank(of('project'), q), ...rank(of('account'), q)];
}

export interface PalCtx {
  projectId: string | null; selectedLane: string | null;
  /** v2.1 §4.11 keys 1–9: the layout key order (visible lanes, tree order); the hints follow it. */
  keys: readonly string[];
  offline: boolean; tauri: boolean;
  /** the viewed orchestrator session (its "⋯" menu is listed). */
  sessionId?: string | null;
  /** v2.1 §4.15 §2 lanes folded into a collapsed tree ("ẩn"; Enter opens that tree). */
  hidden?: readonly string[];
}

/** v2.1 §4.12 one menu → palette rows: `m:<scope>:<item id>`, submenu items flattened under "parent › child". */
function menuRows(tr: Tr, scope: string, who: string, items: MenuItem[], parent = ''): PalItem[] {
  return items.flatMap(i => {
    const label = parent ? `${parent} › ${i.label}` : i.label;
    if (i.submenu) return menuRows(tr, scope, who, i.submenu.items, label);
    if (!i.act) return [];
    return [{ id: `m:${scope}:${i.id}`, group: 'action' as const, label: tr('menu.palLabel', { who, label }), icon: i.icon ?? 'send', kbd: i.kbd,
      act: { t: 'menu' as const, act: i.act }, ...(i.disabled ? { disabled: i.disabled } : {}) }];
  });
}

const menuCtx = (tr: Tr, snap: Snapshot, ctx: PalCtx): MenuCtx => ({ tr, snap, offline: ctx.offline, tauri: ctx.tauri, now: Date.now() });

/**
 * §4.11 / §4.15 §2 the HÀNH ĐỘNG rows of a lane matched by name: a lane hidden in a collapsed tree → "Mở cây #n · tên"
 * (= Enter on it, N6-d); else its own "⋯" items without submenus (N2-k).
 */
export function laneRows(tr: Tr, snap: Snapshot, ctx: PalCtx, projectId: string, name: string): PalItem[] {
  const l = snap.lanes.find(x => x.projectId === projectId && x.name === name);
  if (!l) return [];
  if (projectId === ctx.projectId && ctx.hidden?.includes(name)) {
    const title = sessionsOf(snap, projectId).find(o => o.sessionId === l.ownerSession)?.title;
    return [{ id: `tree:${projectId}:${name}`, group: 'action', label: tr('labels.pal.openTree', { tree: sessionLabel(tr, l.ownerSeq ?? null, title) }), icon: 'folder',
      act: { t: 'lane', projectId, name } }];
  }
  const current = ctx.selectedLane && ctx.projectId ? { kind: 'lane' as const, projectId: ctx.projectId, name: ctx.selectedLane } : null;
  return menuRows(tr, `lane:${projectId}:${name}`, name, laneActions(l, { ...menuCtx(tr, snap, ctx), current }).filter(i => !i.submenu));
}

export function buildItems(tr: Tr, snap: Snapshot, ctx: PalCtx): PalItem[] {
  const mac = (c: Parameters<typeof canRun>[1]) => canRun(snap.channel, c);
  const mctx = menuCtx(tr, snap, ctx);
  const pname = (id: string) => snap.projects.find(p => p.id === id)?.name ?? id;
  const items: PalItem[] = [];
  const here = snap.lanes.filter(l => l.projectId === ctx.projectId);
  // §4.15 §2 N6-d every lane of every session, hidden and done ones too: "H4 · #4 hotfix · … · ẩn", state on the right
  const multi = new Set(snap.projects.filter(p => sessionsOf(snap, p.id).length > 1).map(p => p.id));
  for (const l of snap.lanes) {
    const here = l.projectId === ctx.projectId, n = here ? ctx.keys.indexOf(l.name) : -1;
    const what = [l.phase ? phaseName(tr, l.phase) : null, l.task, l.note].filter(Boolean).join(' ');
    const sess = multi.has(l.projectId) && l.ownerSeq ? sessionLabel(tr, l.ownerSeq, sessionsOf(snap, l.projectId).find(o => o.sessionId === l.ownerSession)?.title) : null;
    const label = [l.name, sess, pname(l.projectId), what || null, here && ctx.hidden?.includes(l.name) ? tr('done.hidden') : null].filter(Boolean).join(' · ');
    items.push({ id: `lane:${l.projectId}:${l.name}`, group: 'lane', label, match: [l.name, what].filter(Boolean).join(' · '), kbd: n >= 0 && n < 9 ? String(n + 1) : undefined, icon: 'user', hint: laneState(tr, l.state), act: { t: 'lane', projectId: l.projectId, name: l.name } });
  }
  const sel = ctx.selectedLane ? here.filter(l => l.name === ctx.selectedLane) : here;
  const current = ctx.selectedLane && ctx.projectId ? { kind: 'lane' as const, projectId: ctx.projectId, name: ctx.selectedLane } : null;
  for (const l of sel) items.push(...menuRows(tr, `lane:${l.projectId}:${l.name}`, l.name, laneActions(l, { ...mctx, current })));
  const sessions = snap.orchestrators.filter(o => o.projectId === ctx.projectId);
  const o = sessions.find(x => x.sessionId === ctx.sessionId) ?? sessions[0];
  if (o) items.push(...menuRows(tr, `orch:${o.projectId}:${o.sessionId ?? 'main'}`, tr('common.role.orchestrator'), orchActions(o, mctx)));
  const g = (id: 'settings' | 'list' | 'inbox' | 'sound' | 'console' | 'addProject' | 'setup' | 'skillsMcp' | 'mcpAdd' | 'mcpLogin' | 'toolkit' | 'graph' | 'quickOpen', icon: IconName, kbd?: string) =>
    items.push({ id, group: 'action', label: tr(`labels.pal.${id}`), icon, kbd, act: { t: id } });
  g('console', 'send', 'Enter');
  // v2.3 §4.1 Deck · Code · Git (+ v2.7 §4.1 Tasks on the Mac channel) and "Mở file…" (⌘P: Code's file search, from any mode)
  const modes = [['tasks', 'listChecks', 'T'], ['deck', 'workflow', 'D'], ['code', 'fileCode', 'C'], ['git', 'branch', 'G']] as const;
  for (const [m, icon, kbd] of modes) if (m !== 'tasks' || mac('spec_scan'))
    items.push({ id: `mode:${m}`, group: 'action', label: tr(`deck.mode.${m}`), icon, kbd, act: { t: 'mode', m } });
  g('quickOpen', 'fileCode', '⌘P');
  g('inbox', 'inbox', 'Q');
  g('list', 'list', 'L');
  g('sound', 'vol', 'M');
  g('settings', 'gear', '⌘,');
  if (mac('project_add')) g('addProject', 'plus');
  if (mac('setup_check')) g('setup', 'refresh');
  // v2.2 §6 the Skills & MCP sheet (Mac only, D32); v2.5 §6 its Bộ công cụ and Graph code tabs
  if (mac('mcp_add')) { g('skillsMcp', 'plug'); g('mcpAdd', 'plus'); g('mcpLogin', 'lock'); g('toolkit', 'wrench'); g('graph', 'db'); }
  snap.projects.forEach((p, i) => items.push({ id: `project:${p.id}`, group: 'project', label: p.name, kbd: i < 9 ? `⌘${i + 1}` : undefined, icon: 'folder', act: { t: 'project', id: p.id } }));
  for (const a of snap.accounts) items.push({ id: `account:${a.email}`, group: 'account', label: tr('labels.pal.account', { email: shortEmail(a.email) }), icon: 'bar', act: { t: 'account', email: a.email } });
  return items;
}
