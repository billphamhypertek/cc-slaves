// UI store (spec §7.9): `snapshot` once, then `event` diffs. The shell reads `store.shell` (no stream
// slices), the conversation its own target's slice (`useStream`, `ConvList`); both through useSyncExternalStore(store.subscribe, …).
import { PROTOCOL_VERSION, type EngineEvent, type ServerMsg, type Snapshot, type StreamLine, type SubagentView, type Target } from '../../../shared/protocol.ts';
import { appendLive, emptyBuffer, prependHistory, resyncTail, unhold, type StreamBuffer } from './console.ts';
import { newBlock, takeLines, type Blocks, type PartialBlock } from './partials.ts';
import { createRevealLoop, type RevealClock, type RevealLoop } from './stream-reveal.ts';
import { langOf, type Lang } from '../../../shared/i18n/core.ts';
import { readCollapsed, trackChanges, writeCollapsed } from './collapse.ts';
import { applyIssueEvent, withProjectEntry } from './issues.ts';

export type ConnStatus = 'connecting' | 'open' | 'reconnecting';
export interface Conn { status: ConnStatus; attempt: number; since: number | null }
/** `icon`: an icon toast in the mockup's look (v2.4 DK11 offline: error + wifi-off; a starting composer: clock). */
export type ToastIcon = 'wifi' | 'clock';
export interface Toast { id: number; level: 'info' | 'warn' | 'error'; text: string; icon?: ToastIcon }

/** The shell's slice (App, Deck): everything but the stream slices below. Its identity holds while only those change, so a
 *  reveal frame of the streaming text re-renders the conversation alone (perf audit hf1117 C3); read with `store.shell`. */
export interface UiState {
  snap: Snapshot | null;
  /** U11: when the data on screen was last fresh from the engine */
  dataAt: number | null;
  conn: Conn;
  /** v2.2 §14.5 S11 "Ẩn công cụ", remembered on this machine */
  hideTools: boolean;
  /** the window is hidden (`visibilitychange`): v2.2 §14.5 pacing stops, v2.3 §10.2 the Git view stops reading */
  tabHidden: boolean;
  /** v2.2 §14.4 the engine speaks another protocol (the app updated under an open page): reload band, no `partial` */
  protocolMismatch: boolean;
  subagents: Record<string, SubagentView[]>;
  toasts: Toast[];
  /** F1b: live install log per job (`setup_install`) */
  installs: Record<string, InstallLog>;
  /** v2.1 §4.5 / §4.1 deck UI kept for the session: sub branches the PO closed (`<projectId>:<lane>`), Xong shelf merged rows shown per project;
   *  §4.15 §2 collapsed roots per project (localStorage) and the "vừa đổi" clock (`<projectId>:<lane>` → ms). */
  deckUi: DeckUi;
  /** v2.3 §10.2 the last `code_changed` (Mac only), numbered so the Code view sees each one */
  codeEv: { e: Extract<EngineEvent, { type: 'code_changed' }>; n: number } | null;
}
/** The stream slices: read per target by the conversation (`useStream`, `ConvList`), never by the shell. */
interface StreamSlices {
  streams: Record<string, StreamBuffer>;
  /** v2.2 §14.5 the streaming text blocks per target (`targetKey`), by block key */
  partials: Record<string, Blocks>;
  /** v2.2 §14.5 S7 "Đang nghĩ… n s": surfaces (parent tool use id, '' = the target's own) with a thinking block open → since (ms) */
  thinking: Record<string, Readonly<Record<string, number>>>;
}
export type StoreState = UiState & StreamSlices;
const SLICE_KEYS: ReadonlySet<string> = new Set<keyof StreamSlices>(['streams', 'partials', 'thinking']);
const shellOf = ({ streams: _s, partials: _p, thinking: _t, ...shell }: StoreState): UiState => shell;
/** `lastKey`: §6A catalog key of the final line ("Xong" / "Thất bại"), rendered in `ui.lang`. */
export interface InstallLog { lines: string[]; done: boolean; ok: boolean; lastKey?: string }

interface DeckUi {
  closedSubs: ReadonlySet<string>; doneOpen: Readonly<Record<string, boolean>>;
  collapsed: Readonly<Record<string, readonly string[]>>; changedAt: Readonly<Record<string, number>>;
  /** §4.15 §3 every done lane per project (`done_lanes_list` total; the snapshot only carries 7 days). */
  doneTotal: Readonly<Record<string, number>>;
}
type KeyStore = Pick<Storage, 'getItem' | 'setItem'>;
export type CodeChanged = Extract<EngineEvent, { type: 'code_changed' }>;
const HIDE_TOOLS_KEY = 'ccs.hideTools';

/** v2.2 §14.5 the pacing loop's clock: the browser's frames; none (tests, no rAF) = text shows as it arrives. */
const browserClock = (): RevealClock | null => (typeof requestAnimationFrame === 'function'
  ? { now: () => performance.now(), raf: cb => requestAnimationFrame(cb), caf: id => cancelAnimationFrame(id) } : null);
export interface StoreOpts { clock?: RevealClock | null }
/** the reveal loop's key of one block */
const gk = (tk: string, key: string) => `${tk}\n${key}`;

/** v2.1 §4.14 each orchestrator session has its own stream: `o:<project>:<session>` when the target names one. */
export const targetKey = (t: Target) => (t.kind === 'orchestrator' ? `o:${t.projectId}${t.sessionId ? `:${t.sessionId}` : ''}` : `l:${t.projectId}:${t.name}`);

const upsert = <T>(list: T[], item: T, same: (a: T) => boolean): T[] => {
  const i = list.findIndex(same);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
};

function applyEvent(s: Snapshot, e: EngineEvent): Snapshot {
  switch (e.type) {
    case 'lane': return { ...s, lanes: upsert(s.lanes, e.lane, l => l.projectId === e.lane.projectId && l.name === e.lane.name) };
    case 'lane_removed': return { ...s, lanes: s.lanes.filter(l => !(l.projectId === e.projectId && l.name === e.name)) };
    // v2.1 §4.14 one view per running session (pre-v2.1 views have no sessionId: one per project)
    case 'orchestrator': return { ...s, orchestrators: upsert(s.orchestrators, e.orchestrator, o => o.projectId === e.orchestrator.projectId && o.sessionId === e.orchestrator.sessionId) };
    case 'session_ended': return { ...s, orchestrators: s.orchestrators.filter(o => o.sessionId !== e.sessionId) };
    case 'account': return { ...s, accounts: upsert(s.accounts, e.account, a => a.email === e.account.email) };
    case 'account_removed': return { ...s, accounts: s.accounts.filter(a => a.email !== e.email) };
    case 'account_login': return { ...s, login: e.login };
    case 'quota': return { ...s, quota: e.quota }; // v2.7.1 §7.3 429 cooldown + manual queue end (AC2 / AC3)
    case 'card': return { ...s, cards: upsert(s.cards, e.card, c => c.id === e.card.id) };
    case 'project': return { ...s, projects: upsert(s.projects, e.project, p => p.id === e.project.id), ...(s.issues ? { issues: withProjectEntry(s.issues, e.project.id) } : {}) };
    case 'project_removed': { // A-M4 a closed project's lanes, sessions and cards go with it (v2.7: its specs / issues too)
      const other = <T extends { projectId: string | null }>(xs: T[]) => xs.filter(x => x.projectId !== e.id);
      return { ...s, projects: s.projects.filter(p => p.id !== e.id), lanes: other(s.lanes), orchestrators: other(s.orchestrators), cards: other(s.cards),
        ...(s.issues ? { issues: other(s.issues) } : {}) };
    }
    case 'spec_changed': case 'issue_changed': return { ...s, issues: applyIssueEvent(s.issues, e) }; // v2.7 §10.1 (Mac only)
    case 'engine': return { ...s, engine: e.engine };
    case 'setup': return { ...s, setup: e.setup };
    case 'config': return { ...s, config: e.config };
    case 'skills_mcp': return { ...s, skillsMcp: e.view }; // v2.2 §6 (Mac only)
    case 'toolkit': return { ...s, toolkit: e.view }; // v2.5 §5.8 (Mac only)
    case 'graph': return { ...s, graph: e.view }; // v2.5 §5.8 (Mac only)
    case 'workflows_changed': return { ...s, workflows: e.rows }; // v2.9 §10.1 (Mac only)
    case 'workflow_draft': { // v2.9 §4.10 (Mac only): a draft by id, replaced in place
      const ds = s.drafts ?? [];
      return { ...s, drafts: ds.some(d => d.id === e.draft.id) ? ds.map(d => (d.id === e.draft.id ? e.draft : d)) : [...ds, e.draft] };
    }
    case 'workflow_draft_gone': return { ...s, drafts: (s.drafts ?? []).filter(d => d.id !== e.draftId) };
    default: return s;
  }
}

export class Store {
  private state: StoreState;
  /** the shell's slice of `state`, rebuilt only when a non-stream field changes */
  private shellState: UiState;
  private listeners = new Set<() => void>();
  private toastId = 0;
  private loop: RevealLoop | null;
  /** macOS reduced motion, fed by the shell from its single source (`useReducedOS`, coding-standard §4) */
  private reducedOS = false;
  /** surfaces on screen (`targetKey\nparent`), counted by the views showing them */
  private shown = new Map<string, number>();
  /** blocks the reveal loop paces */
  private paced = new Set<string>();
  /** v2.3 §10.2 `code_changed` listeners (the Git view; not state: nothing renders from the event itself) */
  private codeFns = new Set<(e: CodeChanged) => void>();

  constructor(private now: () => number = Date.now, private keys: KeyStore | null = globalThis.localStorage ?? null, o: StoreOpts = {}) {
    this.state = {
      snap: null, dataAt: null, conn: { status: 'connecting', attempt: 0, since: null },
      streams: {}, partials: {}, thinking: {}, hideTools: keys?.getItem(HIDE_TOOLS_KEY) === '1', tabHidden: false, protocolMismatch: false,
      subagents: {}, toasts: [], installs: {}, codeEv: null,
      deckUi: { closedSubs: new Set(), doneOpen: {}, collapsed: readCollapsed(keys), changedAt: {}, doneTotal: {} },
    };
    this.shellState = shellOf(this.state);
    const clock = o.clock === undefined ? browserClock() : o.clock;
    this.loop = clock ? createRevealLoop({ clock, reduced: () => this.state.snap?.config.reducedMotion === true || this.reducedOS, onFrame: ks => this.frame(ks) }) : null;
  }

  get = (): StoreState => this.state;
  /** the shell's slice: same object until something other than a stream slice changes (useSyncExternalStore bails out) */
  shell = (): UiState => this.shellState;
  /** §6A UI language: `config.ui.lang` of the last snapshot / `config` event; `vi` before the first snapshot. */
  lang = (): Lang => langOf(this.state.snap?.config);
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  /** v2.3 §10.2 a source changed on disk / in git (Mac channel): the views showing it read again. */
  onCodeChanged = (fn: (e: CodeChanged) => void): (() => void) => {
    this.codeFns.add(fn);
    return () => { this.codeFns.delete(fn); };
  };

  private set(patch: Partial<StoreState>) {
    this.state = { ...this.state, ...patch };
    if (Object.keys(patch).some(k => !SLICE_KEYS.has(k))) this.shellState = shellOf(this.state);
    for (const fn of this.listeners) fn();
  }

  /** §4.5 "n sub ▾": close / open a lane's sub branch (default open, remembered in the session). */
  toggleSubs(projectId: string, lane: string): void {
    const k = `${projectId}:${lane}`, next = new Set(this.state.deckUi.closedSubs);
    if (next.has(k)) next.delete(k); else next.add(k);
    this.set({ deckUi: { ...this.state.deckUi, closedSubs: next } });
  }
  /** §4.15 §3 the Xong shelf: show / hide the merged rows of a project; `open` forces it (§4.15 §4 "lane xong" notification). */
  toggleDone(projectId: string, open?: boolean): void {
    const d = this.state.deckUi.doneOpen;
    this.set({ deckUi: { ...this.state.deckUi, doneOpen: { ...d, [projectId]: open ?? !d[projectId] } } });
  }
  /** §4.15 §2 the collapsed roots of a project, remembered in this browser across app restarts. */
  setCollapsed(projectId: string, roots: readonly string[]): void {
    const collapsed = { ...this.state.deckUi.collapsed, [projectId]: [...roots] };
    writeCollapsed(this.keys, collapsed);
    this.set({ deckUi: { ...this.state.deckUi, collapsed } });
  }
  setDoneTotal(projectId: string, n: number): void {
    if (this.state.deckUi.doneTotal[projectId] === n) return;
    this.set({ deckUi: { ...this.state.deckUi, doneTotal: { ...this.state.deckUi.doneTotal, [projectId]: n } } });
  }
  private changes(prev: Snapshot | null, next: Snapshot): DeckUi {
    const changedAt = trackChanges(this.state.deckUi.changedAt, prev?.lanes ?? null, next.lanes, this.now());
    return { ...this.state.deckUi, changedAt };
  }

  apply(msg: ServerMsg): void {
    if (msg.type === 'snapshot') {
      return this.set({ snap: msg.snapshot, dataAt: this.now(), deckUi: this.changes(this.state.snap, msg.snapshot), protocolMismatch: msg.snapshot.engine.protocol !== PROTOCOL_VERSION });
    }
    if (msg.type !== 'event') return;
    const e = msg.event;
    if (e.type === 'code_changed') {
      for (const fn of this.codeFns) fn(e);
      return this.set({ codeEv: { e, n: (this.state.codeEv?.n ?? 0) + 1 } });
    }
    if (e.type === 'toast') return this.set({ toasts: [...this.state.toasts, { id: ++this.toastId, level: e.level, text: e.text }] });
    if (e.type === 'stream') return this.streamLines(targetKey(e.target), e.lines);
    if (e.type === 'po_written') return this.written(targetKey(e.target), new Set(e.seqs));
    if (e.type === 'partial' || e.type === 'partial_end' || e.type === 'thinking') return this.streamPart(e);
    if (e.type === 'subagents') return this.set({ subagents: { ...this.state.subagents, [targetKey(e.target)]: e.subagents } });
    if (e.type === 'install_log') {
      const prev = this.state.installs[e.job];
      const base = !prev || prev.done ? { lines: [] as string[], done: false, ok: false } : prev;
      const next: InstallLog = { lines: [...base.lines, e.line].slice(-500), done: !!e.done, ok: !!e.ok, ...(e.lineKey ? { lastKey: e.lineKey } : {}) };
      return this.set({ installs: { ...this.state.installs, [e.job]: next } });
    }
    if (!this.state.snap) return;
    const snap = applyEvent(this.state.snap, e);
    this.set({ snap, dataAt: this.now(), ...(e.type === 'lane' ? { deckUi: this.changes(this.state.snap, snap) } : {}) });
  }

  /** v2.2 §14.5 a view shows the surface `parent` of target `tk` (paced while shown); returns the "no longer shown". */
  show(tk: string, parent: string | null): () => void {
    const sk = `${tk}\n${parent ?? ''}`;
    this.shown.set(sk, (this.shown.get(sk) ?? 0) + 1);
    return () => { const n = (this.shown.get(sk) ?? 1) - 1; if (n > 0) this.shown.set(sk, n); else this.shown.delete(sk); };
  }
  /** v2.2 §14.5 the OS asks for reduced motion: text shows as it arrives (the shell feeds it from `useReducedOS`). */
  setReducedOS(on: boolean): void { this.reducedOS = on; }
  /** v2.2 §14.5 tab hidden → the loop stops; visible again → every backlog shows in the first frame (v2.3 §10.2: Git too). */
  setTabHidden(hidden: boolean): void { this.loop?.setHidden(hidden); if (this.state.tabHidden !== hidden) this.set({ tabHidden: hidden }); }
  /** v2.2 §14.5 S11 "Ẩn công cụ" on / off, remembered on this machine. */
  setHideTools(on: boolean): void {
    this.keys?.setItem(HIDE_TOOLS_KEY, on ? '1' : '0');
    this.set({ hideTools: on });
  }
  /** v2.2 §14.4 a `watch` is about to be (re)sent: open blocks the engine does not re-send as `full` closed meanwhile. */
  watching(t: Target): void {
    const tk = targetKey(t), b = this.state.partials[tk];
    if (!b) return;
    this.state = { ...this.state, partials: { ...this.state.partials, [tk]: Object.fromEntries(Object.entries(b).map(([k, x]) => [k, { ...x, stale: true }])) } };
  }

  private isPaced(tk: string, parent: string | null): boolean { return !!this.loop && this.shown.has(`${tk}\n${parent ?? ''}`); }
  private revealed(tk: string, b: PartialBlock): boolean { return !this.isPaced(tk, b.parent) || b.shown >= b.text.length; }
  private forget(tk: string, keys: readonly string[]) {
    for (const k of keys) { this.paced.delete(gk(tk, k)); this.loop?.drop(gk(tk, k)); }
  }

  /** §14.5 `partial` / `partial_end` / `thinking` of a watched target. */
  private streamPart(e: Extract<EngineEvent, { type: 'partial' | 'partial_end' | 'thinking' }>): void {
    if (this.state.protocolMismatch) return;
    const tk = targetKey(e.target);
    if (e.type === 'thinking') {
      const cur = { ...this.state.thinking[tk] }, sk = e.parent ?? '';
      if (e.on) cur[sk] ??= this.now(); else delete cur[sk];
      return this.set({ thinking: { ...this.state.thinking, [tk]: cur } });
    }
    const blocks = this.state.partials[tk] ?? {}, prev = blocks[e.key];
    if (e.type === 'partial_end') {
      if (!prev) return;
      if (this.paced.has(gk(tk, e.key))) this.loop!.end(gk(tk, e.key));
      return this.set({ partials: { ...this.state.partials, [tk]: { ...blocks, [e.key]: { ...prev, ended: true } } } });
    }
    const base = prev ?? newBlock(e.parent, this.state.streams[tk]?.lines.at(-1)?.seq ?? 0);
    const text = e.full ?? base.text + e.delta;
    if (!this.isPaced(tk, base.parent)) {
      this.forget(tk, [e.key]); // no surface paces it now (e.g. Tasks): a later `show` reseeds from the full text
      return this.set({ partials: { ...this.state.partials, [tk]: { ...blocks, [e.key]: { ...base, text, shown: text.length, stale: false } } } });
    }
    const g = gk(tk, e.key);
    if (!this.paced.has(g)) { this.paced.add(g); this.loop!.seed(g, base.text, base.shown); }
    // the frame pushes it to React (one push per frame); until then the new text is held quietly
    this.state = { ...this.state, partials: { ...this.state.partials, [tk]: { ...blocks, [e.key]: { ...base, text, stale: false } } } };
    this.loop!.push(g, e.full !== undefined ? { full: text } : { delta: e.delta });
  }

  /** §14.5 one frame of the reveal loop: the shown counts move, finished blocks swap to their full line — one `set`. */
  private frame(keys: string[]): void {
    const partials = { ...this.state.partials }, touched = new Set<string>();
    for (const g of keys) {
      const i = g.indexOf('\n'), tk = g.slice(0, i), key = g.slice(i + 1), b = partials[tk]?.[key];
      if (!b) continue;
      partials[tk] = { ...partials[tk], [key]: { ...b, shown: this.loop!.text(g).length } };
      touched.add(tk);
    }
    const streams = { ...this.state.streams };
    for (const tk of touched) {
      const blocks: Record<string, PartialBlock> = { ...partials[tk] }, show: StreamLine[] = [], gone: string[] = [];
      for (const [k, b] of Object.entries(blocks)) {
        if (!b.line || b.shown < b.text.length) continue;
        delete blocks[k]; gone.push(k); show.push(b.line, ...b.after);
      }
      if (!gone.length) continue;
      this.forget(tk, gone);
      partials[tk] = blocks;
      streams[tk] = appendLive(streams[tk] ?? emptyBuffer(), show);
    }
    this.set({ partials, streams });
  }

  private streamLines(tk: string, lines: StreamLine[]): void {
    const blocks: Record<string, PartialBlock> = { ...this.state.partials[tk] };
    const { show, gone, held } = takeLines(blocks, lines, k => this.revealed(tk, blocks[k]!));
    this.forget(tk, gone);
    for (const k of held) if (this.paced.has(gk(tk, k))) this.loop!.end(gk(tk, k));
    this.set({ streams: { ...this.state.streams, [tk]: appendLive(this.state.streams[tk] ?? emptyBuffer(), show) }, partials: { ...this.state.partials, [tk]: blocks } });
  }

  /** v2.6 §10.3 the held PO lines `seqs` were written: on screen and behind a revealing block alike. */
  private written(tk: string, seqs: ReadonlySet<number>): void {
    const b = this.state.streams[tk], blocks = this.state.partials[tk] ?? {};
    const partials = Object.fromEntries(Object.entries(blocks).map(([k, x]) => [k, { ...x, after: unhold(x.after, seqs) }]));
    this.set({ ...(b ? { streams: { ...this.state.streams, [tk]: { ...b, lines: unhold(b.lines, seqs) } } } : {}), partials: { ...this.state.partials, [tk]: partials } });
  }

  /** History page (`history` ack). `limit` tells whether more pages may exist. */
  history(t: Target, older: StreamLine[], limit: number): void {
    const k = targetKey(t);
    this.set({ streams: { ...this.state.streams, [k]: prependHistory(this.state.streams[k] ?? emptyBuffer(), older, older.length >= limit) } });
  }

  /** I6: newest page after a watch (re)send — fills what was missed while looking elsewhere or offline. */
  resync(t: Target, page: StreamLine[], limit: number): void {
    const k = targetKey(t), inPage = new Set(page.map(l => l.key).filter(x => x !== undefined));
    // v2.2 §14.4 blocks closed while not watched (no `full` came back) or already in the page are done
    const blocks = Object.entries(this.state.partials[k] ?? {}), gone = blocks.filter(([key, b]) => b.stale || inPage.has(key));
    const late = gone.flatMap(([, b]) => (b.line ? [b.line, ...b.after] : []));
    this.forget(k, gone.map(([key]) => key));
    const partials = gone.length ? { ...this.state.partials, [k]: Object.fromEntries(blocks.filter(x => !gone.includes(x))) } : this.state.partials;
    this.set({ partials, streams: { ...this.state.streams, [k]: resyncTail(appendLive(this.state.streams[k] ?? emptyBuffer(), late), page, limit) } });
  }

  /** Jump back to the live tail: drop the detached buffer so the next history call reloads the newest page. */
  resetStream(t: Target): void {
    const streams = { ...this.state.streams };
    delete streams[targetKey(t)];
    this.set({ streams });
  }

  /** Local-only console line (e.g. /lanes output). Seq = last seq + 0.001 so it sorts right after what is on screen. */
  localLine(t: Target, line: Omit<StreamLine, 'seq' | 'ts'>): void {
    const k = targetKey(t);
    const b = this.state.streams[k] ?? emptyBuffer();
    const seq = Math.max(0, ...b.lines.map(l => l.seq)) + 0.001;
    this.set({ streams: { ...this.state.streams, [k]: appendLive({ ...b, atTail: true }, [{ ...line, seq, ts: this.now() }]) } });
  }

  setConn(conn: Conn): void { this.set({ conn }); }
  toast(level: Toast['level'], text: string, icon?: ToastIcon): void { this.set({ toasts: [...this.state.toasts, { id: ++this.toastId, level, text, ...(icon ? { icon } : {}) }] }); }
  dismissToast(id: number): void { this.set({ toasts: this.state.toasts.filter(t => t.id !== id) }); }
}
