// v2.1 deck as pure data for React Flow (spec §4.2–§4.6, §4.10, §5.1). Snapshot + UI state → layoutDeck (T4) → node
// data (texts, state objects, tooltips) and wire data (colour, width, travelling dots). No React, no DOM.
import { fmtPct, type Tr } from '../../../../shared/i18n/core.ts';
import {
  displayTokens, ZERO_TOKENS, type LaneState, type LaneView, type OrchestratorState, type OrchestratorView, type Snapshot,
  type SubagentView, type TokenCounts,
} from '../../../../shared/protocol.ts';
import { fmtCost, fmtResetTime, fmtTok, shortEmail } from '../../lib/format.ts';
import { laneState, laneRunning, orchRunning, phaseName } from '../../lib/labels.ts';
import { canRun } from '../../lib/remote.ts';
import { earliestReset, laneLine2, orchCard, type Line2 } from '../cards.ts';
import { layoutDeck, type LayoutNode, type NodeKind, type Wire } from '../layout.ts';
import { deckTreeInput, talkingTo } from '../model.ts';
import { everMulti, orchName, rootOf, sessionsOf } from '../../lib/sessions.ts';
import { projectIssues } from '../../lib/issues.ts';
import { laneIssue, orchKindLabel } from '../../lib/traces.ts';
import { CHANGED_MS, FADE_MS } from '../../lib/collapse.ts';
import { branchText, doneWhen, reportedDone, rowCounts, type BranchText } from '../../lib/done.ts';

/** §4.3 colours: CSS values of the v2.8 theme variables (styles.css, both blocks), used in SVG attributes and inline styles. */
export const C = {
  run: 'var(--dk-run)', wait: 'var(--dk-wait)', err: 'var(--dk-err)', gry: 'var(--dk-gry)', acc: 'var(--dk-acc)', amb: 'var(--dk-amb)',
  dark: 'var(--dk-wire)', white: 'var(--dk-id)',
} as const;
/** §4.5 a completed subagent stays 60 s. */
export const SUB_KEEP_MS = 60_000;

export type Glyph = LaneState | 'root' | 'root_quota' | 'root_down' | 'root_ask' | 'root_start' | 'root_run';
export interface LaneData {
  [k: string]: unknown;
  kind: 'lane'; name: string; state: LaneState; glyph: Glyph;
  phase: string | null; account: string | null;
  subs: { n: number; open: boolean } | null;
  line2: Line2; tok: string; cost: string;
  tail: { kind: 'spark'; pts: number[] } | { kind: 'text'; text: string } | null;
  /** §4.3 running + closed branch → sub dots orbit the disc. */
  orbit: number; selected: boolean; tip: string[]; aria: string;
  /** §4.15 §1 merge state on line 2 of a "báo xong · …" lane. */
  branch: BranchText | null;
  /** §4.15 §2 "vừa đổi" in a collapsed tree: label on (< 60 s), then the 300 ms fade before it folds. */
  fresh: 'on' | 'fading' | null;
  /** v2.7 §4.2-3 the issue chip after the phase (`unseen` = orange); click → Tasks on it. */
  issue: { key: string; unseen: boolean } | null;
}
type OrchLine2 =
  | { kind: 'down'; remote: boolean; cardId: number | null } | { kind: 'ask'; cardId: number | null }
  | { kind: 'quota'; at: string | null } | { kind: 'starting' } | { kind: 'noAccount' }
  | { kind: 'with'; lanes: string[] } /* [] = mid-turn, no lane running */ | { kind: 'idle' } | { kind: 'paused' };
export interface OrchData {
  [k: string]: unknown;
  kind: 'orchestrator'; glyph: Glyph; state: OrchestratorState; account: string | null; line2: OrchLine2;
  /** §4.14 "Điều phối #n" (> 1 session ever) / "Điều phối"; the short session name (small label on line 2). */
  name: string; title: string | null;
  /** v2.7 §5.0 the session kind chip on line 1 ("Build · v2.5", "Thiết kế", "Chung"); null = none. */
  kindLabel: string | null;
  tok: string | null; cost: string | null; selected: boolean; tip: string[]; aria: string;
  /** §4.10 "Project chưa có lane": the hint right of the node. */
  empty: string | null;
}
export interface SubData {
  [k: string]: unknown;
  kind: 'subagent'; lane: string; taskId: string; status: SubagentView['status'] | 'unknown'; type: string; tok: string | null;
  selected: boolean; tip: string[]; aria: string;
}
export interface RowData {
  [k: string]: unknown;
  kind: 'more' | 'collapsedRow'; lane: string | null; count: number; text: string; aria: string;
  /** §4.15 collapsed row: "4 chạy · 1 rảnh". */
  extra: string | null;
}
/** §4.15 §3 one shelf row: lane, task, done time ("15:10" / "13/11"), merge tone (warn = unmerged, bad = not measurable). */
export interface ShelfRow { name: string; task: string; when: string; tone: BranchText['tone']; selected: boolean; tip: string[]; aria: string }
/** §4.15 §3 Rev 18/11 concept B: the Xong shelf under the first root. */
export interface ShelfData {
  [k: string]: unknown;
  kind: 'doneShelf'; title: string; count: number; aria: string;
  /** "Chưa merge · n" (null = no unmerged lane: the section is dropped) and its rows, always listed. */
  umText: string | null; unmerged: ShelfRow[];
  /** the toggle "Đã merge · n", its state, its rows (open only) and "n lane xong cũ hơn…" (null = none). */
  mergedText: string; mergedAria: string; open: boolean; merged: ShelfRow[]; older: string | null;
}
type NodeData = LaneData | OrchData | SubData | RowData | ShelfData;
export interface DeckNode { id: string; type: NodeKind; x: number; y: number; w: number; h: number; data: NodeData }

/** §4.6 travelling dot: `back` = child → parent. `once` = the one-shot "turn ended" burst. */
export interface Dot { color: string; back: boolean; dur: number; delay: number; size: number; once?: boolean }
export interface WireData {
  [k: string]: unknown;
  /** SVG path in flow coordinates (orthogonal, from the layout polyline). */
  d: string; color: string; width: number; glow: boolean; opacity: number; dashed: boolean; dots: Dot[];
  /** v2.8 §4.3 (UX r2 N2) a lit wire's own last leg into the child: only it takes the colour, the shared trunk stays grey. */
  branch: string | null;
}
interface DeckEdge { id: string; source: string; target: string; data: WireData }

type Screen = 'no_project' | 'no_lanes' | 'deck';
export interface FlowModel {
  screen: Screen; nodes: DeckNode[]; edges: DeckEdge[]; keyOrder: string[];
  /** §4.15 §2 lanes folded into a collapsed row (⌘K "ẩn"). */
  hidden: string[];
  /** G4 "để yên": a lane / the orchestrator runs (motion.ts `deckAnimated`). */
  animated: boolean; width: number; height: number;
  /** §4.14 N5-c the faint line between two session trees (layout y, full layout width). */
  separators: { y: number; x0: number; x1: number }[];
}

export interface FlowInput {
  snap: Snapshot | null; projectId: string | null;
  /** subagents per lane name (count = remote, list = local). */
  subagents: Record<string, number | SubagentView[]>;
  selected: string | null; selectedSub?: string | null; now: number; tr: Tr;
  /** §4.14 the root of the session Đang xem shows selected (the grey step); null = none (an ended session is viewed). Absent = the
   *  first root. */
  viewed?: string | null;
  /** false → motion gate closed: no dot, no spinning class anywhere (§5.2). */
  live: boolean;
  closedSubs?: ReadonlySet<string>; doneOpen?: boolean;
  /** §4.2 tokens / minute, last 10 min (spark.ts); null = no data. */
  spark?: (lane: string) => number[] | null;
  /** §4.6 lanes whose turn just ended → 3 green dots run to the orchestrator once. */
  bursts?: ReadonlySet<string>;
  /** §4.15 §2 collapsed roots, the "vừa đổi" clock by lane name; §4.15 §3 every done lane of the project. */
  collapsed?: ReadonlySet<string>; changedAt?: Readonly<Record<string, number>>; doneTotal?: number;
}

/** §4.5 completed → 60 s via `endedAt` (unknown end → gone); failed stays until the engine drops it at turn end. */
export function visibleSubs(v: number | SubagentView[] | undefined, now: number): number | SubagentView[] {
  if (!Array.isArray(v)) return v ?? 0;
  return v.filter(s => s.status !== 'completed' || (s.endedAt != null && now - s.endedAt < SUB_KEEP_MS));
}

/** §4.5 when the next completed sub leaves its 60 s window (null = none pending) — the paused deck's one wake-up (§5.2). */
export function nextSubExpiry(subs: Readonly<Record<string, number | SubagentView[]>>, now: number): number | null {
  let next: number | null = null;
  for (const v of Object.values(subs)) if (Array.isArray(v)) for (const s of v) {
    if (s.status !== 'completed' || s.endedAt == null) continue;
    const at = s.endedAt + SUB_KEEP_MS;
    if (at > now && (next === null || at < next)) next = at;
  }
  return next;
}

/** §4.6 wire colour / width by the child's state; `talk` = the orchestrator's talkingTo lane (thick). */
export function wireStyle(child: LaneState | SubagentView['status'] | null, talk = false): Pick<WireData, 'color' | 'width' | 'glow' | 'opacity'> {
  const color = child === 'running' ? C.acc : child === 'waiting_po' ? C.wait
    : child === 'broken' || child === 'failed' ? C.err : C.dark;
  const lit = color !== C.dark;
  return { color, width: talk ? 2.2 : child === 'running' ? 1.4 : 1, glow: lit, opacity: lit || talk ? 1 : 0.8 };
}

/** §4.3 orchestrator state (+ its card) → state object. */
function orchGlyph(s: OrchestratorState, l2: OrchLine2['kind']): Glyph {
  if (l2 === 'down') return 'root_down';
  if (l2 === 'ask') return 'root_ask';
  if (s === 'starting') return 'root_start';
  if (s === 'waiting_quota') return 'root_quota';
  if (s === 'paused') return 'paused';
  return s === 'running' || s === 'switching' ? 'root_run' : 'root';
}

/** §4.2 line 1: the phase hides entirely when it does not fit beside the code, "n sub ▾", the account and "⋯" (never cut
 *  to 1–2 letters). Widths: mono 12.5 px ≈ 7.6 px / char, sans 12 px ≈ 6.4, tag 11.5 px mono ≈ 7 + 12 padding. */
export function phaseFits(name: string, phase: string, subsTag: string | null, account: string | null, chip: string | null = null): boolean {
  const avail = 268 - 46 - 20 - 20 - 8; // card − state cell − padding − "⋯" − its gap
  const tag = (t: string | null) => (t ? t.length * 7 + 12 + 8 : 0); // v2.7 §4.2-3 the issue chip is a tag like "n sub ▾"
  const used = name.length * 7.6 + 8 + tag(subsTag) + tag(chip) + (account ? account.length * 7 + 8 : 0);
  return used + phase.length * 6.4 <= avail;
}

const tokOf = (t: TokenCounts | undefined) => t ?? ZERO_TOKENS;
function tokTip(t: TokenCounts, cost: number, tr: Tr): string[] {
  return [tr('deck.node.tipTok', { tok: fmtTok(displayTokens(t), tr), in: fmtTok(t.input, tr), out: fmtTok(t.output, tr), cw: fmtTok(t.cacheWrite, tr) }),
    tr('deck.node.tipRead', { cr: fmtTok(t.cacheRead, tr), cost: fmtCost(cost, tr) })];
}
const pathOf = (pts: [number, number][]) => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ');

export function buildFlow(inp: FlowInput): FlowModel {
  const { snap, tr, now } = inp;
  const p = snap && inp.projectId ? snap.projects.find(x => x.id === inp.projectId) ?? null : null;
  const empty: FlowModel = { screen: 'no_project', nodes: [], edges: [], keyOrder: [], hidden: [], animated: false, width: 0, height: 0, separators: [] };
  if (!snap || !p) return empty;
  const lanes = snap.lanes.filter(l => l.projectId === p.id), byName = new Map(lanes.map(l => [l.name, l]));
  const os = sessionsOf(snap, p.id), multi = everMulti(os), pi = projectIssues(snap, p.id);
  const orchOf = (root: string): OrchestratorView | null => os.find(x => rootOf(x) === root) ?? null;
  const subs: Record<string, number | SubagentView[]> = {};
  for (const l of lanes) subs[l.name] = visibleSubs(inp.subagents[l.name], now);
  const lay = layoutDeck(deckTreeInput(snap, p.id, { subagents: subs, selected: inp.selected, now, closedSubs: inp.closedSubs, doneOpen: inp.doneOpen,
    collapsed: inp.collapsed, changedAt: inp.changedAt, ...(inp.doneTotal !== undefined ? { doneTotal: inp.doneTotal } : {}) }));
  const folding = os.length > 1 ? inp.collapsed : undefined;
  const viewed = inp.viewed === undefined ? lay.nodes.find(n => n.kind === 'orchestrator')?.root ?? null : inp.viewed;
  const rootOfLane = new Map(lay.nodes.filter(n => n.kind === 'lane').map(n => [n.lane!, n.root]));
  /** §4.6 the lane its own root's orchestrator talks to (thick wire). */
  const talkOf = (root: string) => { const o = orchOf(root); return o?.state === 'running' ? talkingTo(o) : null; };
  const subList = (lane: string) => { const v = subs[lane]; return Array.isArray(v) ? v : null; };
  const subCount = (lane: string) => { const v = subs[lane]; return Array.isArray(v) ? v.length : v ?? 0; };

  const nodes: DeckNode[] = lay.nodes.map(n => ({ id: n.id, type: n.kind, x: n.x, y: n.y, w: n.w, h: n.h, data: nodeData(n) }));
  function nodeData(n: LayoutNode): NodeData {
    if (n.kind === 'orchestrator') return orchData(n.root);
    if (n.kind === 'lane') return laneData(byName.get(n.lane!)!);
    if (n.kind === 'doneShelf') return shelfData(n);
    if (n.kind === 'subagent') {
      const s = subList(n.lane!)?.find(x => x.taskId === n.sub) ?? null;
      const tip = s ? [s.description, ...(s.lastTool || s.toolUses !== null ? [tr('deck.node.subTip', { tool: s.lastTool ?? '—', n: s.toolUses ?? 0 })] : [])] : [n.lane!];
      return { kind: 'subagent', lane: n.lane!, taskId: n.sub!, status: s?.status ?? 'unknown', type: s?.subagentType ?? 'sub',
        tok: s?.totalTokens != null ? fmtTok(s.totalTokens, tr) : null, selected: !!s && inp.selectedSub === s.taskId, tip,
        aria: [`${n.lane} › ${s?.subagentType ?? 'sub'}`, ...tip].join(' · ') };
    }
    const count = n.count ?? 0;
    const row = { lane: null, count, extra: null };
    if (n.kind === 'more') { const t = tr('deck.node.moreSubs', { n: count }); return { ...row, kind: 'more', lane: n.lane!, text: t, aria: tr('deck.node.moreSubsAria', { n: count, lane: n.lane! }) }; }
    const t = tr('deck.node.rowMore', { n: count }), extra = rowCounts(tr, n.counts ?? {}, 2);
    return { ...row, kind: 'collapsedRow', text: t, extra, aria: `${t} · ${rowCounts(tr, n.counts ?? {})}` };
  }

  /** §4.2 N4-e Chờ quota: the node shows only the time; the tooltip names the account that resets first. */
  function quotaTip(l: LaneView): string[] {
    const r = l.state === 'waiting_quota' ? earliestReset(snap!.accounts) : null;
    return r ? [tr('deck.resetFirst', { email: shortEmail(r.email), at: fmtResetTime(r.at) })] : [];
  }

  /** §4.15 §3 Rev 18/11: "Xong n", "Chưa merge · n" + its rows, the "Đã merge · n" toggle, merged rows, "n lane xong cũ hơn…". */
  function shelfData(n: LayoutNode): ShelfData {
    const s = n.shelf!, count = n.count ?? 0;
    const rowOf = (name: string): ShelfRow => {
      const l = byName.get(name)!, b = branchText(tr, l.branch), task = l.task ?? '', when = doneWhen(tr, l.updatedAt, now);
      const tip = [[l.name, task].filter(Boolean).join(' · '), b.text, when];
      return { name, task, when, tone: b.tone, selected: inp.selected === name, tip, aria: tip.join(' · ') };
    };
    const merged = count - s.umCount, older = s.older ? tr('deck.node.older', { n: s.older }) : null;
    return {
      kind: 'doneShelf', title: tr('deck.shelf.title'), count, aria: tr('deck.shelf.aria', { n: count }),
      umText: s.unmerged.length ? tr('deck.shelf.unmerged', { n: s.umCount }) : null, unmerged: s.unmerged.map(rowOf),
      mergedText: tr('deck.shelf.merged', { n: merged }), mergedAria: tr('deck.shelf.mergedAria', { n: merged }), open: !!inp.doneOpen,
      merged: s.merged.map(rowOf), older,
    };
  }

  function laneData(l: LaneView): LaneData {
    const n = subCount(l.name), open = !(inp.closedSubs?.has(l.name) ?? false);
    const subsTag = n ? `${tr('deck.node.subs', { n })} ▾` : null;
    const account = l.account ? shortEmail(l.account) : null, phase = l.phase ? phaseName(tr, l.phase) : null;
    const iss = laneIssue(pi, l.name);
    const t = tokOf(l.tokens), line2 = laneLine2(l, snap!.cards, snap!.accounts, tr, iss?.title ?? null);
    const running = l.state === 'running';
    const pts = running ? inp.spark?.(l.name) ?? null : null;
    const tail: LaneData['tail'] = pts ? { kind: 'spark', pts }
      : l.state === 'waiting_quota' || l.state === 'stopped' ? { kind: 'text', text: tr('deck.node.stalled') } : null;
    const stateText = l.state === 'switching' ? tr('deck.laneSwitching') : laneState(tr, l.state);
    const reported = reportedDone(l), branch = reported ? branchText(tr, l.branch) : null;
    const tip = [`${l.name} · ${stateText}`, ...(iss ? [`${iss.key} · ${iss.title}`] : []), ...(reported ? [tr('done.reportedTip')] : []), [phase, account, l.run?.modelName ?? l.run?.model, l.run?.effort].filter(Boolean).join(' · ') /* v2.4 §4.5 what runs */,
      // UX-M8 N2-i "chạy gate e2e · 2 subagent"
      [l.task, n ? tr('deck.head.subs', { n }) : null].filter(Boolean).join(' · '), ...(l.note && l.note !== l.task ? [l.note] : []), ...quotaTip(l), ...tokTip(t, l.costUsd, tr)].filter(Boolean);
    const at = inp.changedAt?.[l.name], age = at === undefined ? null : now - at;
    const kept = l.state === 'waiting_po' || l.state === 'broken' || inp.selected === l.name;
    const fresh = !folding?.has(rootOfLane.get(l.name) ?? '') || age === null ? null
      : age < CHANGED_MS ? 'on' : age < CHANGED_MS + FADE_MS && !kept ? 'fading' : null;
    return {
      kind: 'lane', name: l.name, state: l.state, glyph: l.state, account,
      phase: phase && phaseFits(l.name, phase, subsTag, account, iss?.key ?? null) ? phase : null,
      subs: n ? { n, open } : null, line2, tok: tr('deck.node.tok', { n: fmtTok(displayTokens(t), tr) }), cost: fmtCost(l.costUsd, tr), tail,
      orbit: running && n && !open ? Math.min(6, n) : 0, selected: inp.selected === l.name, tip, aria: tip.join(' · '), branch, fresh,
      issue: iss ? { key: iss.key, unseen: !iss.poSeen } : null,
    };
  }

  function orchData(root: string): OrchData {
    const o = orchOf(root), oState: OrchestratorState = o?.state ?? 'idle', talk = talkOf(root);
    const card = orchCard(o, snap!.cards, p!.id);
    const running = lanes.filter(l => l.state === 'running' && rootOfLane.get(l.name) === root).map(l => l.name);
    const withLanes = talk && running.includes(talk) ? [talk, ...running.filter(n => n !== talk)] : running;
    const line2: OrchLine2 = card?.kind === 'down' ? { kind: 'down', remote: !canRun(snap!.channel, 'orchestrator_restart'), cardId: card.cardId }
      : card?.kind === 'ask' ? { kind: 'ask', cardId: card.cardId }
      : oState === 'starting' ? { kind: 'starting' }
      : oState === 'paused' ? { kind: 'paused' }
      : oState === 'waiting_quota' ? (() => { const r = earliestReset(snap!.accounts); return { kind: 'quota' as const, at: fmtResetTime(r?.at ?? null) }; })()
      : !snap!.accounts.length ? { kind: 'noAccount' }
      : withLanes.length || oState === 'running' ? { kind: 'with', lanes: withLanes } : { kind: 'idle' }; // mid-turn alone: "Đang chạy"
    const t = tokOf(o?.tokens), account = o?.account ? shortEmail(o.account) : null;
    // §4.7 UX-I1 a Thiết kế node is named by its session ("Thiết kế · 15:02", then the spec title); beside a kind chip the
    // others read "Điều phối" as the mockup (the chip tells them apart in the 216 px node; #n stays in the aria). A Build
    // session's title repeats its chip ("Build · v2.5"), so only a Chung session keeps the small title on line 2.
    const kindLabel = o ? orchKindLabel(tr, o, os, pi) : null, design = o?.orchKind === 'design' && !!o.title;
    const name = !o ? tr('deck.node.orch') : design ? o.title! : kindLabel ? tr('common.role.orchestrator') : orchName(tr, o, multi);
    const stateLine = oState === 'running' && talk ? tr('deck.talking', { lane: talk }) : tr(`deck.orch.${oState}`);
    // UX-M12 the clipped node texts (session name, "làm với …") are whole in the tip
    const tip = [tr('deck.orchTip', { state: stateLine }), ...(line2.kind === 'down' && line2.remote ? [tr('deck.node.macOnlyTip')] : []),
      [account, o?.model, o?.effort, o?.contextPct != null ? tr('deck.node.tipCtx', { pct: fmtPct(tr.lang, o.contextPct) }) : null].filter(Boolean).join(' · '),
      ...(multi && o?.title ? [o.title] : []), ...(line2.kind === 'with' && withLanes.length > 1 ? [`${tr('deck.node.with')} ${withLanes.join(', ')}`] : []),
      ...tokTip(t, o?.costUsd ?? 0, tr)].filter(Boolean);
    return {
      kind: 'orchestrator', glyph: orchGlyph(oState, line2.kind), state: oState, account, line2,
      name, title: multi && (o?.orchKind ?? 'general') === 'general' ? o?.title ?? null : null, kindLabel,
      tok: oState === 'starting' ? null : tr('deck.node.tok', { n: fmtTok(displayTokens(t), tr) }), cost: oState === 'starting' ? null : fmtCost(o?.costUsd ?? 0, tr),
      selected: root === viewed && inp.selected === null && !inp.selectedSub, tip, aria: [o && multi ? orchName(tr, o, multi) : null, design ? name : null, ...tip].filter(Boolean).join(' · '),
      empty: lanes.length || os.length > 1 ? null : tr('deck.node.noLanes'),
    };
  }

  // ---------- wires §4.6 ----------
  const laneIdx = new Map(lay.keyOrder.map((n, i) => [n, i]));
  const edges: DeckEdge[] = lay.wires.map(w => ({ id: w.id, source: w.from, target: w.to, data: wireData(w) }));
  function wireData(w: Wire): WireData {
    const base = wireBase(w);
    return { ...base, branch: base.color === C.dark ? null : pathOf(w.points.slice(-2)) };
  }
  function wireBase(w: Wire): Pick<WireData, 'd' | 'color' | 'width' | 'glow' | 'opacity' | 'dashed' | 'dots'> {
    const to = lay.nodes.find(n => n.id === w.to)!, d = pathOf(w.points), dashed = !!w.dashed;
    if (to.kind === 'lane') {
      const l = byName.get(to.lane!)!, isTalk = talkOf(to.root) === l.name, i = laneIdx.get(l.name) ?? 0;
      const st = l.state, dots: Dot[] = [];
      if (inp.live && st === 'running') {
        dots.push({ color: C.acc, back: false, dur: isTalk ? 0.9 : 1.8, delay: -i * 0.4, size: 8 }, { color: C.run, back: true, dur: 1.8, delay: -(i * 0.4 + 0.9), size: 8 });
      } else if (inp.live && st === 'waiting_po') dots.push({ color: C.wait, back: true, dur: 2.4, delay: 0, size: 8 });
      if (inp.live && inp.bursts?.has(l.name)) for (const k of [0, 1, 2]) dots.push({ color: C.run, back: true, dur: 1.8, delay: k * 0.25, size: 8, once: true });
      return { d, dashed, dots, ...wireStyle(st, isTalk) };
    }
    if (to.kind === 'subagent') {
      const s = subList(to.lane!)?.find(x => x.taskId === to.sub) ?? null, st = s?.status ?? null, j = (subList(to.lane!) ?? []).indexOf(s!);
      const dots: Dot[] = inp.live && st === 'running'
        ? [{ color: C.white, back: false, dur: 1.4, delay: -j * 0.35, size: 6 }, { color: C.run, back: true, dur: 1.4, delay: -(j * 0.35 + 0.7), size: 6 }] : [];
      const style = st === 'running' ? { color: C.run, width: 1, glow: false, opacity: 0.85 } : st === 'failed' ? { color: C.err, width: 1, glow: false, opacity: 0.85 }
        : { color: C.dark, width: 1, glow: false, opacity: st === 'completed' ? 0.6 : 0.85 };
      return { d, dashed, dots, ...style };
    }
    // §4.15 collapsed row carrying the talkingTo lane is thick cyan; every other row wire is dark
    const talk = to.kind === 'collapsedRow' ? talkOf(to.root) : null;
    if (talk && lay.hidden.includes(talk)) return { d, dashed, dots: [], color: C.acc, width: 2.2, glow: true, opacity: 1 };
    return { d, dashed, dots: [], ...wireStyle(null, false) };
  }

  const animated = lanes.some(l => laneRunning(l.state)) || os.some(o => orchRunning(o.state) || o.state === 'switching');
  return { screen: lanes.length ? 'deck' : 'no_lanes', nodes, edges, keyOrder: lay.keyOrder, hidden: lay.hidden, animated, width: lay.width, height: lay.height, separators: lay.separators };
}
