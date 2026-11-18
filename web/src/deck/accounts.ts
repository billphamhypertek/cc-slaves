// Account state (§5.2 kind, "% kho") and the v2.7.1 §4.3–§4.7 account panel model (collapsed card + open 400 / 380 px panel).
import { keyedText, type Tr } from '../../../shared/i18n/core.ts';
import { displayTokens, type AccountLoginView, type AccountView, type Channel, type LaneView, type OrchestratorView, type ProjectView, type QuotaState, type TokenStats } from '../../../shared/protocol.ts';
import { fmtClock, fmtHm, fmtResetLeft, fmtResetTime, fmtTok, resetAt } from '../lib/format.ts';
import { refreshRecent } from '../lib/account-ui.ts';

export type AccKind = 'ok' | 'low' | 'full' | 'out' | 'unknown';
const LOW_PCT = 10;
/** §5.2: logged out > full > unknown (headroom null / needs_probe / unknown) > low (< 10 %) > ok. */
export function accKind(a: AccountView): AccKind {
  if (a.loggedOut) return 'out';
  if (a.full) return 'full';
  if (a.headroomPct === null || a.status === 'needs_probe' || a.status === 'unknown') return 'unknown';
  return a.headroomPct < LOW_PCT ? 'low' : 'ok';
}
const isOrchAccount = (a: AccountView) => a.role === 'orchestrator';
/** Accounts a lane can use: not the orchestrator's, not logged out, not unknown. */
const usable = (accs: AccountView[]) => accs.filter(a => !isOrchAccount(a) && accKind(a) !== 'out' && accKind(a) !== 'unknown');
/** v2.1 §4.7 / v2 §6: when the orchestrator account is the only account (no lane account at all), it takes the lanes and
 *  counts in "% kho" — one account never shows 0 like "mọi account đầy". */
function usableForPool(accs: AccountView[]): AccountView[] {
  if (accs.some(a => !isOrchAccount(a))) return usable(accs);
  return accs.filter(a => accKind(a) !== 'out' && accKind(a) !== 'unknown');
}
/** §4.5 "% kho" = mean headroom of the usable accounts; a full one counts 0. */
export function poolPct(accs: AccountView[]): number {
  const u = usableForPool(accs);
  return u.length ? Math.round(u.reduce((s, a) => s + (accKind(a) === 'full' ? 0 : a.headroomPct!), 0) / u.length) : 0;
}

// ---------------------------------------------------------------- v2.7.1 §4.3 account panel (collapsed card + open panel)

/** What a row is: red = blocks lanes (full, logged out — v1 F16, W15) · amber = warning · grey = unknown. */
type Issue = 'out' | 'full' | 'expiring' | 'admit' | 'low' | 'err' | 'cfg' | 'stale' | 'past' | 'loading' | 'unknown';
const ISSUE_ORDER: Issue[] = ['out', 'full', 'expiring', 'admit', 'low', 'err', 'cfg', 'stale', 'past', 'loading', 'unknown'];
type Tone = 'bad' | 'warn' | 'unk' | 'ok';
const toneOf = (i: Issue): Tone => (i === 'out' || i === 'full' ? 'bad' : i === 'loading' || i === 'unknown' || i === 'past' ? 'unk' : 'warn');
/** Legend / bar / collapsed-card buckets (one per account, same words everywhere). */
export type Bucket = 'ready' | 'inUse' | 'warn' | 'block' | 'unknown';
const BUCKETS: Bucket[] = ['ready', 'inUse', 'warn', 'block', 'unknown'];
type GroupId = 'attention' | 'inUse' | 'ready';

export interface PanelCtx {
  lanes: LaneView[]; orchestrators: OrchestratorView[]; projects: ProjectView[]; projectId: string | null;
  /** config.noNewLanes: "Không giao lane mới" per email. */
  noNewLanes: Record<string, boolean>;
  login: AccountLoginView | null; channel: Channel | null; now: number; stats?: TokenStats;
  /** emails whose first sight was < 5 s ago (v2 "Đang tải" skeleton; later → "?"). */
  loadingFresh?: ReadonlySet<string>;
  /** §4.10 Mất kết nối: rows are read-only (a ✗ / ⚠ row opens F24, its tip says why). */
  offline?: boolean;
  /** §7.3 `Snapshot.quota`: the 429 cooldown and the end of the manual queue. */
  quota?: QuotaState;
  /** §4.3 window < 1280 px: the 380 px panel (short "Đầy" reason). */
  narrow?: boolean;
  /** §4.4 "✓ vừa cập nhật HH:MM" for 4 s: email → when the new numbers came. */
  justUpdated?: ReadonlyMap<string, number>;
  /** §4.4 the "Làm mới" batch this panel asked for (ack order) — "đang làm mới k/n"; null = none. */
  batch?: readonly string[] | null;
  /** §5 ≤ 100 ms: "Làm mới" clicked, the ack not back yet (null = none; [] = every account). */
  pending?: { all: boolean; rows: ReadonlySet<string> };
}
/** One block of line 3: kept whole when the line wraps (§4.3). */
interface L3Part { text: string; tone: 'bad' | 'warn' | null; icon: 'spin' | 'clock' | 'ck' | null }
interface Bar { win: 'five' | 'week'; used: number; tone: 'f' | 'w' | null; tick: number | null }
export interface PanelRow {
  email: string; issues: Issue[]; tone: Tone; bucket: Bucket;
  role: 'orch' | 'backup' | null; sub: string; right: string;
  /** §4.3 line 3 blocks (reason, its time, the refresh state); empty = a 2-line row. */
  l3: L3Part[];
  /** §4.3 bars = used % (Max: 5g + tuần; Ultra: tuần only, D103); empty = no data. `dim` = old numbers past a reset. */
  bars: Bar[]; dim: boolean;
  /** §4.3 row height (2 / 3 / 4 lines). */
  h: number;
  /** §4.4 the row's ⟳: null = none (remote); `off` = dimmed with the reason in `tip`. */
  refresh: { off: boolean; tip: string } | null;
  tip: string[]; tipBad: boolean; aria: string; click: 'relogin' | 'cfg' | 'select'; loggingIn: boolean; loading: boolean;
  /** v2.2 §6 ACC (F-I6): the row's own "⚠ cấu hình chung lỗi ›" chip (click = the row's click → K12); the tip says "Không nhận lane: …" */
  cfgChip: boolean;
  /** hf1116 T4: the terminal's own login → the "Terminal" tag. */
  terminal: boolean;
}
/** §4.3–§4.4 header: "cập nhật HH:MM" + its tooltip, the ⟳ button, the queue / 429 band. */
interface PanelHead {
  label: string | null; labelTone: 'warn' | null; tip: string[];
  /** null = no button (remote). */
  btn: { text: string | null; tip: string; off: boolean; busy: boolean } | null;
  band: { kind: 'queue' | 'blocked'; text: string; muted: string | null } | null;
  busy: boolean; blocked: boolean;
}
export interface PanelModel {
  n: number; pool: number; buckets: Record<Bucket, number>;
  legend: { b: Bucket; n: number; text: string }[]; bar: { b: Bucket; n: number; pct: number }[];
  groups: { id: GroupId; rows: PanelRow[] }[];
  tokens: string | null; week: string | null; collapsedTip: string[]; cols: string; head: PanelHead;
}

/** Lane states that hold an account (a done / stopped lane does not). */
const HOLDS = (s: LaneView['state']) => s !== 'done' && s !== 'stopped';
const LIVE_LOGIN = new Set<AccountLoginView['state']>(['starting', 'waiting_browser', 'verifying', 'email_mismatch']);
const FIVE_MS = 5 * 3_600_000, WEEK_MS = 7 * 24 * 3_600_000;
/** §4.4 "5 giờ vừa reset … · đã tự cập nhật …" shows 10 min after the ask that followed a reset. */
const JUST_RESET_MS = 10 * 60_000;
/** §4.3 row heights: 2 lines ≈ 50 px, each line-3 line +18. Line 3 holds ≈ 62 characters at 400 px, 58 at 380. */
const ROW_H2 = 50, L3_H = 18;

const past = (a: AccountView) => a.pastReset !== null;
function accIssues(a: AccountView, loading = false): Issue[] {
  const out: Issue[] = [];
  if (a.loggedOut || a.login === 'out') out.push('out');
  if (a.full && !past(a)) out.push('full');
  if (a.login === 'expiring') out.push('expiring');
  if (!a.full && a.admitBlock) out.push('admit');
  if (!a.full && !a.admitBlock && a.headroomPct !== null && a.headroomPct < LOW_PCT) out.push('low');
  if (a.quotaError) out.push('err');
  if (!a.sharedCfg.ok || a.sharedCfg.issues.length) out.push('cfg');
  if (!a.quotaError && !a.fresh && a.fetchedAt !== null) out.push('stale');
  if (past(a)) out.push('past');
  if (loading) out.push('loading');
  else if (!a.full && (a.headroomPct === null || a.status === 'needs_probe' || a.status === 'unknown' || a.login === 'unknown')) out.push('unknown');
  return out.sort((p, q) => ISSUE_ORDER.indexOf(p) - ISSUE_ORDER.indexOf(q));
}
const TONE_RANK: Record<Tone, number> = { bad: 0, warn: 1, unk: 2, ok: 3 };

function laneLabel(l: LaneView, ctx: PanelCtx): string {
  if (l.projectId === ctx.projectId) return l.name;
  return `${ctx.projects.find(p => p.id === l.projectId)?.name ?? l.projectId}/${l.name}`;
}
/** "08:12:40" — seconds only when they are not :00 (AC2). */
const hms = (t: number) => { const s = new Date(t).getSeconds(); return s ? `${fmtHm(t)}:${String(s).padStart(2, '0')}` : fmtHm(t); };
const round = (n: number | null) => (n === null ? 0 : Math.round(n));
/** Where a lane leaves the account: hard = cap − 1, soft = cap (§4.5, `config.ts` weekLeaveAt). */
const leaveOf = (a: AccountView) => a.fullWhy?.window === 'week' && a.fullWhy.leaveAt !== null ? a.fullWhy.leaveAt : a.admitBlock?.leaveAt ?? (a.hard ? a.week - 1 : a.week);
const cooling = (ctx: PanelCtx) => (ctx.quota?.cooldownUntil ?? 0) > ctx.now;

/** §4.5 the short reason (line 3) and the long one (tooltip) of a full / admit-blocked row. */
function fullText(a: AccountView, ctx: PanelCtx, tr: Tr): { short: string; long: string | null; at: string | null } | null {
  const w = a.fullWhy;
  const reopen = (r: number | null) => (r !== null && r > ctx.now ? tr('deck.acc.why.reopen', { at: fmtResetTime(r) }) : null);
  if (w) {
    const used = round(w.usedPct), cap = w.cap ?? (w.window === 'week' ? a.week : a.five ?? 0), leave = w.leaveAt ?? cap;
    if (w.by === 'anthropic') {
      const k = w.window === 'five' ? 'anthFive' : 'anthWeek';
      return { short: tr(`deck.acc.why.${k}`), long: tr(`deck.acc.long.${k}`), at: reopen(w.resetsAt) };
    }
    if (w.window === 'five') return { short: tr('deck.acc.why.five', { used, cap }), long: tr('deck.acc.long.five', { used, cap }), at: reopen(w.resetsAt) };
    if (w.hard) return {
      short: tr(ctx.narrow ? 'deck.acc.why.weekHardShort' : 'deck.acc.why.weekHard', { used, cap, leave }),
      long: tr('deck.acc.long.weekHard', { used, cap, leave, max: cap - 3 }), at: reopen(w.resetsAt),
    };
    return { short: tr('deck.acc.why.weekSoft', { used, cap }), long: tr('deck.acc.long.weekSoft', { used, cap }), at: reopen(w.resetsAt) };
  }
  if (a.full && !past(a)) return { short: tr('deck.acc.why.full'), long: null, at: reopen(resetAt(a)) };
  const b = a.admitBlock;
  if (b) {
    const p = { used: round(b.usedPct), max: b.admitMax, cap: b.cap, leave: b.leaveAt };
    return { short: tr('deck.acc.why.admit', p), long: tr('deck.acc.long.admit', p), at: tr('deck.acc.why.admitLeave', { leave: b.leaveAt }) };
  }
  return null;
}

/** §4.4 the refresh state on line 3: "◌ đang hỏi…" / "🕒 chờ lượt · ≈ …" / "thử lại sau 1:40" / "✓ vừa cập nhật …". */
function refreshPart(a: AccountView, ctx: PanelCtx, tr: Tr, loading: boolean): L3Part | null {
  const r = a.refresh;
  if (r.state === 'fetching' || (loading && !a.loggedOut)) return { text: tr(a.fetchedAt === null ? 'deck.acc.st.first' : 'deck.acc.st.fetching'), tone: null, icon: 'spin' };
  if (r.state === 'queued') {
    const text = cooling(ctx) ? tr('deck.acc.st.retry', { clock: fmtClock(ctx.quota!.cooldownUntil! - ctx.now) })
      : r.at !== null ? tr('deck.acc.st.queued', { at: hms(r.at) }) : tr('deck.acc.st.queuedSoon');
    return { text, tone: null, icon: 'clock' };
  }
  if (ctx.pending?.rows.has(a.email) || (ctx.pending?.all && !a.loggedOut)) return { text: tr('deck.acc.st.queuedSoon'), tone: null, icon: 'clock' };
  const done = ctx.justUpdated?.get(a.email);
  if (done !== undefined) return { text: tr('deck.acc.st.done', { hm: fmtHm(done) }), tone: null, icon: 'ck' };
  return null;
}

/** §4.4 "5 giờ vừa reset 08:00 17/11 · đã tự cập nhật 08:01": the ask right after a known reset (window start = reset − length). */
function justReset(a: AccountView, ctx: PanelCtx, tr: Tr): string | null {
  if (a.fetchedAt === null || ctx.now - a.fetchedAt > JUST_RESET_MS) return null;
  for (const [win, at, len] of [['five', a.fiveWindow ? a.fiveResetsAt : null, FIVE_MS], ['week', a.weekResetsAt, WEEK_MS]] as const) {
    if (at === null) continue;
    const start = at - len;
    if (a.fetchedAt >= start && a.fetchedAt - start <= JUST_RESET_MS) return tr(win === 'five' ? 'deck.acc.why.justFive' : 'deck.acc.why.justWeek', { at: fmtResetTime(start), hm: fmtHm(a.fetchedAt) });
  }
  return null;
}

/** §4.3 / §4.5 line 3: the reason (+ its time) and the refresh state. Soft notes (sắp hết, số liệu lúc) give way to the state. */
function line3(a: AccountView, ctx: PanelCtx, tr: Tr, has: (i: Issue) => boolean, loading: boolean): { parts: L3Part[]; long: string | null } {
  if (has('out')) return { parts: [], long: null };
  const st = refreshPart(a, ctx, tr, loading);
  const f = fullText(a, ctx, tr);
  const part = (text: string | null, tone: L3Part['tone'] = null, icon: L3Part['icon'] = null): L3Part[] => (text ? [{ text, tone, icon }] : []);
  if (f) return { parts: [...part(f.short, a.admitBlock && !a.full ? 'warn' : 'bad'), ...part(f.at), ...(st ? [st] : [])], long: f.long };
  if (a.pastReset) {
    const p = a.pastReset, txt = tr(p.window === 'five' ? 'deck.acc.why.pastFive' : 'deck.acc.why.pastWeek', { at: fmtResetTime(p.at) });
    return { parts: st ? [...part(txt), st] : [...part(txt, null, 'clock'), ...part(p.recheckAt !== null ? tr('deck.acc.why.recheck', { hm: fmtHm(p.recheckAt) }) : null)], long: null };
  }
  if (a.quotaError) {
    const e = a.quotaError, reason = tr('deck.acc.why.err', { reason: keyedText(tr, e) ?? e.key });
    const data = a.fetchedAt !== null ? tr('deck.acc.why.errData', { hm: fmtHm(a.fetchedAt) }) : null;
    const next = a.nextCheckAt !== null ? tr('deck.acc.why.errNext', { hm: fmtHm(a.nextCheckAt) }) : null;
    return { parts: [...part(reason, 'warn'), ...part([data, next].filter(Boolean).join(' ') || null), ...(st ? [st] : [])], long: null };
  }
  if (st) return { parts: [st], long: null };
  if (a.status === 'needs_probe') return { parts: part(tr('deck.acc.why.probe')), long: null };
  if (has('low')) return { parts: [...part(tr('deck.acc.why.low'), 'warn'), ...part(a.weekResetsAt !== null ? tr('deck.acc.why.lowReset', { at: fmtResetTime(a.weekResetsAt) }) : null)], long: null };
  const jr = justReset(a, ctx, tr);
  if (jr) return { parts: part(jr), long: null };
  if (has('stale') && a.fetchedAt !== null) return { parts: part(tr('deck.acc.why.stale', { hm: fmtHm(a.fetchedAt) })), long: null };
  return { parts: [], long: null };
}

/** §4.3 lines line 3 needs: its blocks never break inside unless one is longer than a line. */
function l3Lines(parts: L3Part[], narrow: boolean): number {
  if (!parts.length) return 0;
  const cap = narrow ? 58 : 62;
  let lines = 1, used = 0;
  for (const p of parts) {
    const len = p.text.length + (p.icon ? 2 : 0) + (used ? 1 : 0);
    if (used && used + len > cap) { lines++; used = 0; }
    if (len > cap) { lines += Math.ceil(len / cap) - 1; used = len % cap; } else used += len;
  }
  return lines;
}

/** §4.3 bars: used %; red only on the window that made it full, amber on the week when low / not taking work; the "dừng ở" tick. */
function barsOf(a: AccountView, has: (i: Issue) => boolean): Bar[] {
  if (has('out') || a.weekPct === null) return [];
  const fullWin = has('full') ? a.fullWhy?.window ?? (resetAt(a) === a.fiveResetsAt && a.fiveResetsAt !== a.weekResetsAt ? 'five' : 'week') : null;
  const leave = leaveOf(a), out: Bar[] = [];
  if (a.fiveWindow) out.push({ win: 'five', used: round(a.fivePct), tone: fullWin === 'five' ? 'f' : null, tick: null });
  out.push({ win: 'week', used: round(a.weekPct), tone: fullWin === 'week' ? 'f' : has('low') || has('admit') ? 'w' : null, tick: leave < 100 ? leave : null });
  return out;
}

/** §4.4 the row's ⟳ (Mac only): dimmed while asking, < 60 s after the last ask (D101), offline or logged out. */
function rowRefresh(a: AccountView, ctx: PanelCtx, tr: Tr, has: (i: Issue) => boolean): PanelRow['refresh'] {
  if (ctx.channel !== 'mac') return null;
  if (ctx.offline) return { off: true, tip: tr('menu.offline') };
  if (has('out')) return { off: true, tip: tr('deck.acc.rowOut') };
  if (a.refresh.state === 'fetching') return { off: true, tip: tr('deck.acc.rowFetching') };
  if (a.refresh.state === 'queued') return { off: false, tip: a.refresh.at !== null ? tr('deck.acc.rowQueued', { at: hms(a.refresh.at) }) : tr('deck.acc.rowRefresh', { email: a.email }) };
  const recent = refreshRecent(tr, a, ctx.now);
  return recent ? { off: true, tip: recent } : { off: false, tip: tr('deck.acc.rowRefresh', { email: a.email }) };
}

/** §4.5 row tooltip: who · plan · role / reason / 5 giờ (Max only) / tuần / số liệu lúc · tự cập nhật / Đổi ngưỡng. */
function tipOf(a: AccountView, ctx: PanelCtx, tr: Tr, long: string | null, l3: L3Part[], has: (i: Issue) => boolean, right: string): string[] {
  const tip = [[a.email, a.plan ? tr('deck.acc.tipPlan', { plan: a.plan }) : null, tr('deck.acc.tipRole', { role: tr(`deck.acc.r.${a.role}`) })].filter(Boolean).join(' · ')];
  const why = long ?? (l3.length && !l3[0]!.icon ? l3.map(p => p.text).join(' ') : null);
  if (why) tip.push(why);
  if (has('cfg')) tip.push(tr('deck.acc.cfgChip'));
  const reset = (at: number | null) => (at !== null ? fmtResetLeft(at, ctx.now, tr) : null);
  if (a.fiveWindow && (a.fivePct !== null || a.fiveResetsAt !== null)) {
    const r = reset(a.fiveResetsAt), pct = round(a.fivePct);
    tip.push(r ? tr('deck.acc.tipFive', { pct, reset: r }) : tr('deck.acc.tipFiveNoReset', { pct }));
  }
  if (a.weekPct !== null) {
    const r = reset(a.weekResetsAt), pct = round(a.weekPct), leave = leaveOf(a);
    const line = r ? tr('deck.acc.tipWeek', { pct, reset: r }) : tr('deck.acc.tipWeekNoReset', { pct });
    const full = long || leave >= 100 ? line : `${line} · ${tr('deck.acc.tipLeave', { pct: leave })}`;
    tip.push(ctx.narrow && right !== '—' && right !== '?' ? `${right} · ${full}` : full); // AC8 380 px: the hover buttons cover the number column (§4.3)
  }
  if (a.fetchedAt !== null) {
    const after = a.fullWhy?.resetsAt ?? null;
    const next = a.nextCheckAt !== null ? [tr('deck.acc.tipNext', { hm: fmtHm(a.nextCheckAt) }), after !== null && after > ctx.now ? tr('deck.acc.tipAfter', { at: fmtResetTime(after) }) : null].filter(Boolean).join(' ') : null;
    tip.push([tr('deck.acc.tipData', { hm: fmtHm(a.fetchedAt) }), next].filter(Boolean).join(' · '));
  }
  if (ctx.channel === 'mac' && (a.fullWhy?.by === 'cap' || has('admit'))) tip.push(tr('deck.acc.tipCaps'));
  return tip;
}

function rowOf(a: AccountView, ctx: PanelCtx, tr: Tr): { row: PanelRow; used: boolean } {
  const loading = !!ctx.loadingFresh?.has(a.email) && a.fetchedAt === null;
  const issues = accIssues(a, loading);
  const tone = issues.length ? issues.reduce<Tone>((t, i) => (TONE_RANK[toneOf(i)] < TONE_RANK[t] ? toneOf(i) : t), 'ok') : 'ok';
  const held = ctx.lanes.filter(l => l.account === a.email && HOLDS(l.state));
  // this project's lanes first (in creation order), then other projects as "project/lane"
  const here = held.filter(l => l.projectId === ctx.projectId), there = held.filter(l => l.projectId !== ctx.projectId);
  const sessions = ctx.orchestrators.filter(o => o.account === a.email && o.projectId === ctx.projectId);
  const orch = a.role === 'orchestrator' || ctx.orchestrators.some(o => o.account === a.email);
  const mac = ctx.channel === 'mac';
  const loggingIn = !!ctx.login && ctx.login.mode === 'relogin' && ctx.login.email === a.email && LIVE_LOGIN.has(ctx.login.state);
  const has = (i: Issue) => issues.includes(i);
  const sub: string[] = [];
  if (loggingIn) sub.push(tr('deck.acc.loggingIn'));
  else if (has('out')) sub.push(mac ? tr('deck.acc.out') : tr('deck.acc.outRemote'));
  for (const o of sessions) sub.push(o.seq ? tr('deck.acc.orchN', { n: o.seq }) : tr('deck.acc.orch'));
  if (here.length) sub.push(tr('deck.acc.lanes', { names: here.map(l => l.name).join(', ') }));
  if (there.length) sub.push(there.map(l => laneLabel(l, ctx)).join(', '));
  if (has('expiring') && !loggingIn) sub.push(tr('deck.acc.s.expiring'));
  if (ctx.noNewLanes[a.email]) sub.push(tr('deck.acc.paused'));
  // a full row's line 3 already says why it takes nothing; "chưa có lane" there would only repeat it (mockup AC1 / AC2 ba@)
  if (!sub.length && !has('out') && !has('full')) sub.push(a.fetchedAt === null ? tr('deck.acc.noData') : has('unknown') ? tr('deck.acc.unknown') : tr('deck.acc.noLane'));
  const right = has('out') ? '—' : has('full') ? tr('deck.full') : a.headroomPct === null || has('unknown') || has('past') || loading ? '?' : tr('deck.left', { pct: Math.round(a.headroomPct) });
  const { parts, long } = line3(a, ctx, tr, has, loading);
  const tip = tipOf(a, ctx, tr, long, parts, has, right);
  // §4.7 click: login ✗ / ⚠ → A6 (Mac only: the remote channel hides A6), config error → shared-config list, else F24;
  // §4.10 offline: F24 read-only, the tip names the reason
  const fix: PanelRow['click'] = mac && (has('out') || has('expiring')) ? 'relogin' : mac && has('cfg') ? 'cfg' : 'select';
  const click: PanelRow['click'] = ctx.offline ? 'select' : fix;
  if (click !== fix) tip.push(tr('menu.offline'));
  const used = held.length > 0 || orch;
  const bucket: Bucket = tone === 'bad' ? 'block' : tone === 'warn' ? 'warn' : tone === 'unk' ? 'unknown' : used ? 'inUse' : 'ready';
  const reason = long ?? (parts.length ? parts.map(p => p.text).join(' ') : null);
  return {
    used,
    row: {
      email: a.email, issues, tone, bucket, role: orch ? 'orch' : a.role === 'backup' ? 'backup' : null,
      sub: sub.join(' · '), right, l3: parts, bars: loading ? [] : barsOf(a, has), dim: has('past'),
      h: ROW_H2 + L3_H * l3Lines(parts, !!ctx.narrow), refresh: rowRefresh(a, ctx, tr, has),
      tip, tipBad: long !== null && !has('admit'), aria: [tr('deck.acc.rowAria', { email: a.email, right }), reason].filter(Boolean).join(' · '),
      click, loggingIn, loading, cfgChip: has('cfg'), terminal: a.terminal,
    },
  };
}

/** §4.3 L5 "cập nhật HH:MM" = the OLDEST fetch among logged-in accounts with numbers and no error (+ its tooltip). */
function updatedOf(accs: AccountView[], tr: Tr): { at: number | null; tip: string[] } {
  const ok = accs.filter(a => !a.loggedOut && a.quotaError === null && a.fetchedAt !== null).sort((p, q) => p.fetchedAt! - q.fetchedAt!);
  const errs = accs.filter(a => !a.loggedOut && a.quotaError !== null);
  const tip: string[] = [];
  if (ok.length) tip.push(tr('deck.acc.tipOldest', { email: ok[0]!.email, hm: fmtHm(ok[0]!.fetchedAt!), last: fmtHm(ok[ok.length - 1]!.fetchedAt!) }));
  tip.push(errs.length ? tr('deck.acc.tipSkipErr', { list: errs.map(a => a.fetchedAt !== null ? tr('deck.acc.tipSkipItem', { email: a.email, hm: fmtHm(a.fetchedAt) }) : a.email).join(', ') }) : tr('deck.acc.tipSkip'));
  const next = accs.map(a => a.nextCheckAt).filter((t): t is number => t !== null).sort((p, q) => p - q)[0];
  if (next !== undefined) tip.push(tr('deck.acc.tipNextAll', { hm: fmtHm(next) }));
  return { at: ok[0]?.fetchedAt ?? null, tip };
}

/** §4.4 "đang làm mới k/n": k = the account being asked (the batch minus those still queued). */
function progressOf(accs: AccountView[], ctx: PanelCtx): { k: number; n: number } | null {
  const st = new Map(accs.map(a => [a.email, a.refresh.state]));
  if (ctx.batch?.length) {
    const n = ctx.batch.length;
    return { k: Math.max(1, n - ctx.batch.filter(e => st.get(e) === 'queued').length), n };
  }
  const live = accs.filter(a => a.refresh.state !== 'idle');
  return live.some(a => a.refresh.state === 'queued') ? { k: Math.max(1, live.filter(a => a.refresh.state === 'fetching').length), n: live.length } : null;
}

/** §4.3 / §4.4 / §4.6 the header: label, ⟳ button, the queue or 429 band. */
function headOf(accs: AccountView[], ctx: PanelCtx, tr: Tr): PanelHead {
  const upd = updatedOf(accs, tr), hm = upd.at !== null ? fmtHm(upd.at) : null;
  const q = ctx.quota ?? { cooldownUntil: null, queueEndsAt: null };
  const blocked = cooling(ctx), prog = progressOf(accs, ctx);
  const busy = !!ctx.pending?.all || prog !== null || (q.queueEndsAt !== null && q.queueEndsAt > ctx.now);
  if (ctx.channel !== 'mac') return { label: hm ? tr('deck.acc.updatedRemote', { hm }) : null, labelTone: null, tip: [...upd.tip, tr('deck.acc.remoteNoRefresh')], btn: null, band: null, busy, blocked };
  if (ctx.offline) return { label: hm ? tr('deck.offlineAt', { hm }) : tr('deck.offline'), labelTone: 'warn', tip: upd.tip, btn: { text: null, tip: tr('menu.offline'), off: true, busy: false }, band: null, busy: false, blocked: false };
  const data = hm ? tr('deck.acc.band429Data', { hm }) : null;
  if (blocked) {
    const until = fmtHm(q.cooldownUntil!);
    return { label: hm ? tr('deck.acc.updated', { hm }) : null, labelTone: null, tip: upd.tip, busy, blocked,
      btn: { text: tr('deck.acc.retryIn', { clock: fmtClock(q.cooldownUntil! - ctx.now) }), tip: tr('deck.acc.blockedTip', { hm: until }), off: true, busy: false },
      band: { kind: 'blocked', text: tr('deck.acc.band429', { hm: until }), muted: data } };
  }
  if (busy) return {
    label: prog ? tr('deck.acc.refreshing', prog) : tr('deck.acc.refreshingSoon'), labelTone: null, tip: upd.tip, busy, blocked,
    btn: { text: tr('deck.acc.refreshBusy'), tip: tr('deck.acc.refreshAllTip'), off: true, busy: true },
    band: { kind: 'queue', text: tr('deck.acc.queueBand'), muted: q.queueEndsAt !== null ? tr('deck.acc.queueEnd', { hm: fmtHm(q.queueEndsAt) }) : null },
  };
  return { label: hm ? tr('deck.acc.updated', { hm }) : null, labelTone: null, tip: upd.tip, busy, blocked,
    btn: { text: tr('deck.acc.refreshAll'), tip: tr('deck.acc.refreshAllTip'), off: false, busy: false }, band: null };
}

/** §4.7 the whole panel (collapsed card numbers, header, overview, token line, groups) from the snapshot. */
export function accountPanel(accs: AccountView[], ctx: PanelCtx, tr: Tr): PanelModel {
  const built = accs.map(a => rowOf(a, ctx, tr));
  const buckets = Object.fromEntries(BUCKETS.map(b => [b, 0])) as Record<Bucket, number>;
  for (const { row } of built) buckets[row.bucket]++;
  const attention = built.filter(b => b.row.tone !== 'ok').map(b => b.row)
    .map((r, i) => ({ r, i })).sort((p, q) => TONE_RANK[p.r.tone] - TONE_RANK[q.r.tone] || p.i - q.i).map(p => p.r);
  const inUse = built.filter(b => b.row.tone === 'ok' && b.used).map(b => b.row);
  const ready = built.filter(b => b.row.tone === 'ok' && !b.used).map(b => b.row);
  const n = accs.length, pool = poolPct(accs);
  const legend = BUCKETS.filter(b => buckets[b] > 0).map(b => ({ b, n: buckets[b], text: tr(`deck.acc.b.${b}`, { n: buckets[b] }) }));
  const bar = legend.map(l => ({ b: l.b, n: l.n, pct: (l.n / n) * 100 }));
  const tokens = ctx.stats ? tr('deck.acc.tok5h', { tok: fmtTok(displayTokens(ctx.stats.tokens5h), tr) }) : null;
  const weeks = usableForPool(accs).map(a => a.weekPct).filter((w): w is number => w !== null);
  const week = weeks.length ? tr('deck.acc.week', { pct: Math.round(weeks.reduce((s, w) => s + w, 0) / weeks.length) }) : null;
  const head = headOf(accs, ctx, tr);
  // collapsed tooltip: one count per first (worst) issue, in severity order; line 2 = data time / queue / 429 (AC11)
  const kinds = new Map<Issue, number>();
  for (const r of attention) kinds.set(r.issues[0]!, (kinds.get(r.issues[0]!) ?? 0) + 1);
  const parts = ISSUE_ORDER.filter(i => kinds.has(i)).map(i => tr(`deck.acc.i.${i}`, { n: kinds.get(i)! }));
  const q = ctx.quota;
  const dataAt = updatedOf(accs, tr).at;
  const line2 = head.blocked ? [tr('deck.acc.cardBlocked', { hm: fmtHm(q!.cooldownUntil!) }), dataAt !== null ? tr('deck.acc.why.stale', { hm: fmtHm(dataAt) }) : null, tr('deck.acc.tipHint')]
    : head.busy && head.label ? [head.label, q?.queueEndsAt ? tr('deck.acc.cardDone', { hm: fmtHm(q.queueEndsAt) }) : null]
    : [ctx.channel === 'mac' && !ctx.offline ? head.label : null, tr('deck.acc.tipHint')];
  const collapsedTip = [[tr('deck.acc.tipHead', { n, pct: pool }), ...parts].join(' · '), line2.filter(Boolean).join(' · ')];
  const cols = tr(accs.some(a => a.fiveWindow) ? 'deck.acc.cols' : 'deck.acc.colsWeek');
  return { n, pool, buckets, legend, bar, groups: [{ id: 'attention', rows: attention }, { id: 'inUse', rows: inUse }, { id: 'ready', rows: ready }], tokens, week, collapsedTip, cols, head };
}

// ---------- list items + virtualisation (§4.7 "ảo hoá khi > 60 dòng", §6 "số phần tử DOM dòng ≤ 80") ----------
export type PanelItem = { kind: 'head'; id: GroupId; n: number } | { kind: 'row'; row: PanelRow } | { kind: 'more'; n: number; open: boolean };
export const ITEM_H = { head: 30, more: 28 } as const;
/** §4.3 a row is 2, 3 or 4 lines tall (its own `h`). */
export const itemH = (i: PanelItem): number => (i.kind === 'row' ? i.row.h : ITEM_H[i.kind]);
const VIRTUAL_AFTER = 60;
export const PANEL_MAX_DOM = 70;
const OVERSCAN = 8;

/** The flat list the panel draws: group heads, rows, the "▸ Hiện n account" toggle. A filter matches every group (Sẵn sàng open). */
export function panelItems(m: PanelModel, o: { readyOpen: boolean; filter: string }): PanelItem[] {
  const q = o.filter.trim().toLowerCase(), out: PanelItem[] = [];
  for (const g of m.groups) {
    const rows = q ? g.rows.filter(r => r.email.toLowerCase().includes(q)) : g.rows;
    if (!rows.length) continue;
    out.push({ kind: 'head', id: g.id, n: rows.length });
    const open = g.id !== 'ready' || o.readyOpen || !!q;
    if (g.id === 'ready' && !q) out.push({ kind: 'more', n: rows.length, open });
    if (open) for (const row of rows) out.push({ kind: 'row', row });
  }
  return out;
}

/** Items [start, end) to draw at `scrollTop` in a `viewH` px viewport; `top` = offset of `start`, `total` = full height. */
export function virtualWindow(items: PanelItem[], scrollTop: number, viewH: number): { virtual: boolean; start: number; end: number; top: number; total: number } {
  const hs = items.map(itemH), total = hs.reduce((s, h) => s + h, 0);
  if (items.filter(i => i.kind === 'row').length <= VIRTUAL_AFTER) return { virtual: false, start: 0, end: items.length, top: 0, total };
  const st = Math.max(0, Math.min(scrollTop, Math.max(0, total - viewH)));
  let y = 0, i = 0;
  while (i < items.length && y + hs[i]! <= st) { y += hs[i]!; i++; }
  let start = i, top = y;
  for (let k = 0; k < OVERSCAN && start > 0; k++) { start--; top -= hs[start]!; }
  let end = i, yy = y;
  while (end < items.length && yy < st + viewH) { yy += hs[end]!; end++; }
  end = Math.min(items.length, end + OVERSCAN, start + PANEL_MAX_DOM);
  return { virtual: true, start, end, top, total };
}

/** §4.7 N3-k: accounts a lane just moved onto (lane key `project:name` → previous account). */
export function switchedAccounts(prev: ReadonlyMap<string, string | null>, lanes: LaneView[]): string[] {
  const out: string[] = [];
  for (const l of lanes) {
    const k = `${l.projectId}:${l.name}`;
    if (!prev.has(k) || !l.account) continue;
    if (prev.get(k) !== l.account && !out.includes(l.account)) out.push(l.account);
  }
  return out;
}

/** §4.4 "✓ vừa cập nhật": accounts whose ask just ended with new numbers (fetching → idle, `fetchedAt` moved). */
export function freshlyUpdated(prev: ReadonlyMap<string, { state: string; at: number | null }>, accs: readonly AccountView[]): string[] {
  return accs.filter(a => { const p = prev.get(a.email); return !!p && p.state === 'fetching' && a.refresh.state === 'idle' && a.fetchedAt !== null && a.fetchedAt !== p.at; }).map(a => a.email);
}

/** §4.7 row hover → React Flow class of a lane node: its lanes stay as they are, every other lane dims ('acc-dim'); v2.8 §4.3
 *  dropped the glow on the lit lanes (banned look), so they carry no class. */
export const laneHoverClass = (laneAccount: string | null, hovered: string | null): string | undefined =>
  hovered === null || laneAccount === hovered ? undefined : 'acc-dim';

/** v2.1 §4.10 N4-c "Đang khởi động": no account card yet (no figures); every other state shows it. */
export const accCardShown = (orchState: OrchestratorView['state'] | null): boolean => orchState !== 'starting';

/** v2 "Đang tải": rows with no data yet are loading for 5 s after they first appear (`seen` keeps that time), then "?".
 *  The caller passes the wall clock: the deck's own tick stops while it is still (§5.2). */
export const LOADING_MS = 5000;
export function loadingRows(accs: readonly AccountView[], seen: Map<string, number>, now: number): Set<string> {
  const out = new Set<string>();
  for (const a of accs) {
    if (a.fetchedAt !== null) continue;
    const t0 = seen.get(a.email) ?? now;
    seen.set(a.email, t0);
    if (now - t0 < LOADING_MS) out.add(a.email);
  }
  return out;
}

/** v2.8 §4.9 D98 what a press keeps the open panel for: the panel itself (tooltips, bands, scrollbar inside it) and a "⋯" menu
 *  layer — the row menu renders outside the panel's DOM, so it is judged by the menu's root, not by `contains`. */
const PANEL_INSIDE = '.accp, .amenu-layer';
/** A press (pointerdown) collapses the open panel unless it lands inside, or an overlay sits on top (`hold`: start / step
 *  dialogs, A6, F19, palette — opening, using or closing them never closes the panel), or the panel is not on screen
 *  (`shown` false: the Tasks tab keeps it mounted but hidden, so the press on "Deck" keeps it open). The press still does its
 *  own job. */
export function pressOutside(t: { closest?: (sel: string) => unknown } | null, hold: boolean, shown: boolean): boolean {
  if (hold || !shown) return false;
  return typeof t?.closest !== 'function' || !t.closest(PANEL_INSIDE);
}
/** The panel is on screen: its computed `visibility` (the hidden Tasks deck passes `hidden` down). Not `checkVisibility`: the
 *  app floor is macOS 13, whose WebKit (Safari 16) lacks it (v28-rr N-4). */
export const shownNow = (el: Element | null, cs: (e: Element) => { visibility: string } = getComputedStyle): boolean =>
  !!el && cs(el).visibility === 'visible';
