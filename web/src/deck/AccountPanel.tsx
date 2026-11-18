// v2.7.1 §4.3–§4.7 account panel: collapsed 44 px card (AC11) and the open 400 / 380 px overlay (AC1–AC9). Pure numbers and
// words come from `accountPanel` (accounts.ts); this file owns only what needs the DOM or a clock: scroll / virtual window,
// the bottom fade, the 1.4 s glow of an account a lane just moved onto (N3-k), the 5 s "Đang tải" skeleton, hover both ways,
// the §4.4 refresh feedback (≤ 100 ms "đang làm mới" before the ack, the 4 s "✓ vừa cập nhật", the 429 countdown).
// It overlays the deck (position:absolute inside the deck overlay layer) and never changes the deck's size.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type MutableRefObject, type ReactElement } from 'react';
import type { QuotaRefreshAck } from '../../../shared/accounts.ts';
import type { Snapshot } from '../../../shared/protocol.ts';
import { useT } from '../lib/i18n.tsx';
import { canRun } from '../lib/remote.ts';
import { a3Block } from '../lib/account-ui.ts';
import { accountPanel, freshlyUpdated, itemH, loadingRows, LOADING_MS, panelItems, pressOutside, shownNow, switchedAccounts, virtualWindow, ITEM_H, type Bucket, type PanelItem, type PanelRow } from './accounts.ts';
import './AccountPanel.css';

export interface AccountPanelProps {
  snap: Snapshot; projectId: string | null; now: number;
  /** §4.7 always collapsed when the app opens: the App owns `open` (never persisted). */
  open: boolean; onToggle: () => void;
  /** v2.8 §4.9 D98 an overlay sits on top (start / step dialogs, A6, F19, palette…): no press counts as outside. */
  hold?: boolean;
  /** "+" → v2 A3. */
  onAdd: () => void;
  /** login ✗ / ⚠ → v2 A6; config error → v2 A9 list; else → F24 in Đang xem (T8). */
  onRelogin: (email: string) => void; onCfg: (email: string) => void; onSelectAccount: (email: string) => void;
  /** §4.12 the row's "⋯" menu, opened at that button. */
  onMenu: (email: string, anchor: Element) => void;
  onCancelLogin: () => void;
  /** §4.4 `quota_refresh` (null = every account); resolves with the ack, null when it failed. */
  onRefresh?: (email: string | null) => Promise<QuotaRefreshAck | null>;
  /** the App's ⋯ "Làm mới số liệu" asks through here, so the row shows "đang làm mới" at once (review-b MINOR-2). */
  refreshRef?: MutableRefObject<((email: string) => void) | null>;
  /** lane node hover → that lane's account (row lights); row hover → the App lights the lanes (inverse). */
  hoverEmail: string | null; onHover: (email: string | null) => void;
  /** §4.10 Mất kết nối: "+" / "Huỷ" / ⟳ dimmed with the reason, ✗ / ⚠ rows open F24 read-only. */
  offline?: boolean;
  /** tests / dev frames: open "Sẵn sàng". */
  initialReadyOpen?: boolean;
}

export const GLOW_MS = 1400;
/** §4.4 "✓ vừa cập nhật HH:MM" stays 4 s. */
const DONE_MS = 4000;
const BUCKET_C: Record<Bucket, string> = { ready: 'ready', inUse: 'inuse', warn: 'warn', block: 'block', unknown: 'unk' };
const NARROW_Q = '(max-width: 1279px)';

function Ring({ pct, size, stroke, spin }: { pct: number; size: number; stroke: number; spin?: boolean }): ReactElement {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, p = Math.max(0, Math.min(100, pct)), m = size / 2;
  return (
    <svg className="aring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={m} cy={m} r={r} fill="none" stroke="var(--ap-track)" strokeWidth={stroke} />
      <circle cx={m} cy={m} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={`${(c * p) / 100} ${c}`} transform={`rotate(-90 ${m} ${m})`} />
      {spin ? <g className="arc"><circle cx={m} cy={m} r={m - 1} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeDasharray={`${c * 0.18} ${c * 2}`} /></g> : null}
    </svg>
  );
}
const RefIcon = () => <svg className="aico" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><path d="M13.6 2.6v3.2h-3.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
const SpinIcon = () => <span className="aspin" aria-hidden="true"><svg className="aico" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity=".25" strokeWidth="2" /><path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" /></svg></span>;
const ClockIcon = () => <svg className="aico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M8 4.6V8l2.4 1.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
const CheckIcon = () => <svg className="aico" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.4l3 3 6-6.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>;
const WarnIcon = () => <svg className="aico warn" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8l6.6 12H1.4z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><path d="M8 6.2v3.6M8 11.6v.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>;
const ST_ICON = { spin: SpinIcon, clock: ClockIcon, ck: CheckIcon } as const;
const IssueIcon = ({ r }: { r: PanelRow }) => {
  const i = r.issues[0];
  if (i === 'out') return <svg className="aic bad" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 5H5v14h5M14 8l4 4-4 4M18 12H9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>;
  if (i === 'expiring' || i === 'cfg') return <svg className="aic warn" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l10 18H2zM12 10v5M12 18v.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>;
  return null;
};

/** §4.3 the 380 px panel below 1280 px of window (SSR / tests: wide). */
function useNarrow(): boolean {
  const mq = useMemo(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(NARROW_Q) : null), []);
  const [n, setN] = useState(!!mq?.matches);
  useEffect(() => { if (!mq) return; const f = () => setN(mq.matches); mq.addEventListener('change', f); return () => mq.removeEventListener('change', f); }, [mq]);
  return n;
}

export function AccountPanel(p: AccountPanelProps): ReactElement {
  const tr = useT(), s = p.snap, mac = s.channel === 'mac', narrow = useNarrow();

  // v2 "Đang tải": a row with no data yet shows a skeleton for 5 s after it first appears, then "?"
  const firstSeen = useRef(new Map<string, number>());
  // the panel's own clock: `p.now`, moved on by the timers below (the deck's tick stops while still; the 5 s skeleton timeout and the
  // 1 s countdowns must still run). Render never reads Date.now(), so the same props give the same panel.
  const [clock, setClock] = useState(0);
  const wall = Math.max(p.now, clock);
  const loadingFresh = useMemo(() => loadingRows(s.accounts, firstSeen.current, wall), [s.accounts, wall]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!loadingFresh.size) return; const h = setTimeout(() => setClock(Date.now()), LOADING_MS); return () => clearTimeout(h); }, [loadingFresh]);

  // §4.4 refresh: the click shows "đang làm mới" at once (before the ack); the ack's queue order is the "k/n" batch
  const [pending, setPending] = useState<{ all: boolean; rows: ReadonlySet<string> }>({ all: false, rows: new Set() });
  const [batch, setBatch] = useState<string[] | null>(null);
  const refresh = (email: string | null) => {
    if (!p.onRefresh) return;
    setPending(o => (email ? { all: o.all, rows: new Set([...o.rows, email]) } : { all: true, rows: o.rows }));
    void p.onRefresh(email).then(ack => {
      if (!email && ack?.queued.length) setBatch(ack.queued);
      setPending(o => (email ? { all: o.all, rows: new Set([...o.rows].filter(e => e !== email)) } : { all: false, rows: o.rows }));
    });
  };
  useEffect(() => { // every render: `refresh` closes over this render's props
    const r = p.refreshRef;
    if (!r) return;
    r.current = e => refresh(e);
    return () => { r.current = null; };
  });
  const live = new Map(s.accounts.map(a => [a.email, a.refresh.state]));
  useEffect(() => { if (batch && batch.every(e => live.get(e) !== 'queued' && live.get(e) !== 'fetching')) setBatch(null); }); // eslint-disable-line react-hooks/exhaustive-deps
  // §4.4 "✓ vừa cập nhật HH:MM" 4 s after an ask brought new numbers
  const prevRefresh = useRef(new Map<string, { state: string; at: number | null }>());
  const [done, setDone] = useState<ReadonlyMap<string, number>>(() => new Map());
  useEffect(() => {
    const fresh = freshlyUpdated(prevRefresh.current, s.accounts);
    prevRefresh.current = new Map(s.accounts.map(a => [a.email, { state: a.refresh.state, at: a.fetchedAt }]));
    if (!fresh.length) return;
    setDone(d => { const n = new Map(d); for (const e of fresh) n.set(e, s.accounts.find(a => a.email === e)!.fetchedAt!); return n; });
    const h = setTimeout(() => setDone(d => { const n = new Map(d); for (const e of fresh) n.delete(e); return n; }), DONE_MS);
    return () => clearTimeout(h);
  }, [s.accounts]);
  // a 1 s clock while something counts (429 countdown, queue, "vừa cập nhật"): the deck's own tick may be still
  const counting = (s.quota?.cooldownUntil ?? 0) > wall || s.quota?.queueEndsAt != null || batch !== null || done.size > 0;
  useEffect(() => { if (!counting) return; const h = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(h); }, [counting]);

  const m = useMemo(() => accountPanel(s.accounts, {
    lanes: s.lanes, orchestrators: s.orchestrators, projects: s.projects, projectId: p.projectId, login: s.login ?? null, channel: s.channel, now: wall,
    stats: s.stats, noNewLanes: (s.config.noNewLanes ?? {}) as Record<string, boolean>, loadingFresh, offline: p.offline, quota: s.quota, narrow,
    justUpdated: done, batch, pending,
  }, tr), [s, p.projectId, wall, tr, loadingFresh, p.offline, narrow, done, batch, pending]); // eslint-disable-line react-hooks/exhaustive-deps

  // N3-k: a lane that moved account lights the new account's row 1.4 s
  const prevLanes = useRef<Map<string, string | null> | null>(null);
  const [glow, setGlow] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const prev = prevLanes.current;
    prevLanes.current = new Map(s.lanes.map(l => [`${l.projectId}:${l.name}`, l.account]));
    const moved = prev ? switchedAccounts(prev, s.lanes) : [];
    if (!moved.length) return;
    setGlow(new Set(moved));
    const h = setTimeout(() => setGlow(new Set()), GLOW_MS);
    return () => clearTimeout(h);
  }, [s.lanes]);

  const [readyOpen, setReadyOpen] = useState(!!p.initialReadyOpen);
  const [filter, setFilter] = useState('');
  const filterBox = useRef<HTMLInputElement>(null);
  const [scroll, setScroll] = useState({ top: 0, h: 700, max: 0 });
  const list = useRef<HTMLDivElement>(null), aside = useRef<HTMLElement>(null);
  // UX-M8 N3-c the hovered row's tooltip, left of the panel at the row's height (kept inside the panel's height)
  const [rtip, setRtip] = useState<{ email: string; top: number } | null>(null);
  const tipAt = (email: string, e: MouseEvent<HTMLElement>) => {
    const a = aside.current?.getBoundingClientRect(), r = e.currentTarget.getBoundingClientRect();
    if (a) setRtip({ email, top: Math.max(0, Math.min(r.top - a.top, a.height - 140)) });
  };
  const items = useMemo(() => panelItems(m, { readyOpen, filter }), [m, readyOpen, filter]);
  // v2.8 §4.9 D98 a press outside collapses the open panel; the press still does its own job (never prevented or stopped)
  const press = useRef({ hold: !!p.hold, close: p.onToggle });
  press.current = { hold: !!p.hold, close: p.onToggle };
  useEffect(() => {
    if (!p.open) return;
    let gone = false; // one close per opening, even if a second press lands before the re-render
    const f = (e: PointerEvent) => { if (!gone && pressOutside(e.target as Element | null, press.current.hold, shownNow(aside.current))) { gone = true; press.current.close(); } };
    document.addEventListener('pointerdown', f, true);
    return () => document.removeEventListener('pointerdown', f, true);
  }, [p.open]);
  const win = virtualWindow(items, scroll.top, scroll.h);
  const measure = () => { const el = list.current; if (el) setScroll({ top: el.scrollTop, h: el.clientHeight, max: el.scrollHeight - el.clientHeight }); };
  useEffect(measure, [p.open, items.length]);
  const fade = scroll.max - scroll.top > 1;
  const canRefresh = mac && canRun(s.channel, 'quota_refresh');

  if (!p.open) {
    const cnt = (cls: string, n: number) => (n > 0 ? <span className={`acnt ${cls}`}><i aria-hidden="true" />{n}</span> : null);
    return (
      <button type="button" className="accp mini" data-n={m.n} data-pool={m.pool} onClick={p.onToggle} aria-label={m.collapsedTip.join(' · ')} aria-expanded={false}>
        <span className="pool"><Ring pct={m.pool} size={30} stroke={3} spin={m.head.busy && !m.head.blocked} /><b>{m.pool}</b></span>
        <span className="n">{m.n}</span>
        {m.n === 0 ? <span className="acnt unk"><i aria-hidden="true" />0</span> : null}
        {cnt('bad', m.buckets.block)}{cnt('warn', m.buckets.warn)}{cnt('unk', m.buckets.unknown)}
        {m.head.blocked ? <span className="chev hold" aria-hidden="true">⏸</span> : <span className="chev" aria-hidden="true">‹</span>}
        <span className="ctip" role="tooltip">{m.collapsedTip.map((t, i) => <span key={i}>{t}</span>)}</span>
      </button>
    );
  }

  const addLock = p.offline ? tr('menu.offline') : a3Block(tr, s.login ?? null);
  const hd = m.head;
  const head = (
    <div className="ah">
      <b>{tr('deck.acc.title')}</b><span className="badge">{m.n}</span>
      <span className={`upd${hd.labelTone ? ' off' : ''}`} tabIndex={hd.label ? 0 : -1}>{hd.label}
        {hd.label ? <span className="htip" role="tooltip">{hd.tip.map((t, i) => <span key={i}>{t}</span>)}</span> : null}</span>
      {hd.btn && canRefresh ? <button type="button" className={`acb aref${hd.btn.busy ? ' busy' : ''}`} disabled={hd.btn.off} title={hd.btn.tip} aria-label={hd.btn.text ?? hd.btn.tip}
        onClick={() => refresh(null)}>{hd.btn.busy ? <SpinIcon /> : <RefIcon />}{hd.btn.text}</button> : null}
      {mac && canRun(s.channel, 'account_add')
        ? <button type="button" className="acb aadd" onClick={addLock ? undefined : p.onAdd} disabled={!!addLock} aria-label={addLock ?? tr('deck.acc.add')} title={addLock ?? tr('deck.acc.add')}>+</button>
        : null}
      <button type="button" className="acb" onClick={p.onToggle} aria-label={tr('deck.acc.collapse')} title={tr('deck.acc.collapse')}>›</button>
    </div>
  );
  const band = hd.band ? <div className={`abnr ${hd.band.kind}`} role="status">{hd.band.kind === 'blocked' ? <WarnIcon /> : <ClockIcon />}
    <span>{hd.band.text}{hd.band.muted ? <> <span className="m">{hd.band.muted}</span></> : null}</span></div> : null;
  if (m.n === 0) {
    return (
      <aside className="accp open" aria-label={tr('deck.acc.aria')}>
        {head}
        <div className="aempty"><b>{tr('deck.acc.empty')}</b>
          {mac ? <button type="button" className="nb" onClick={p.onAdd} disabled={!!addLock} title={addLock ?? undefined}>{tr('deck.acc.addFirst')}</button> : null}</div>
      </aside>
    );
  }

  const clickRow = (r: PanelRow) => (r.click === 'relogin' ? p.onRelogin(r.email) : r.click === 'cfg' ? p.onCfg(r.email) : p.onSelectAccount(r.email));
  const firstHead = items.findIndex(i => i.kind === 'head');
  const renderItem = (it: PanelItem, idx: number): ReactElement => {
    if (it.kind === 'head') return (
      <div key={`h:${it.id}`} className={`gh g-${it.id}`} style={{ height: ITEM_H.head }}>
        <span>{tr(`deck.acc.g.${it.id}`)}</span><span className="gn">{it.n}</span>
        {idx === firstHead ? <span className="cols">{m.cols}</span> : null}
      </div>);
    if (it.kind === 'more') return (
      <button key="more" type="button" className="gmore" style={{ height: ITEM_H.more }} aria-expanded={it.open} onClick={() => setReadyOpen(o => !o)}>
        {it.open ? tr('deck.acc.hide') : tr('deck.acc.showN', { n: it.n })}</button>);
    const r = it.row;
    const cls = ['acrow', `t-${r.tone}`, p.hoverEmail === r.email ? 'alit' : '', glow.has(r.email) ? 'glow' : '', r.loading ? 'skel' : '', r.dim ? 'stale' : ''].filter(Boolean).join(' ');
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); clickRow(r); } };
    return (
      <div key={r.email} className={cls} style={{ [win.virtual ? 'height' : 'minHeight']: r.h }} data-email={r.email}
        onMouseEnter={e => { p.onHover(r.email); tipAt(r.email, e); }} onMouseLeave={() => { p.onHover(null); setRtip(null); }}>
        <span className="hit" role="button" tabIndex={0} aria-label={[r.aria, ...r.tip].join(' · ')} onClick={() => clickRow(r)} onKeyDown={onKey} />
        <span className="adot" aria-hidden="true" />
        <span className="main">
          <span className="em">{r.email}</span>
          <span className="l2">
            {r.role === 'orch' ? <span className="atag orch">{tr('deck.acc.roleOrch')}</span> : r.role === 'backup' ? <span className="atag">{tr('deck.acc.roleBackup')}</span> : null}
            {r.terminal ? <span className="atag" title={tr('accounts.terminalTip')}>{tr('accounts.terminalTag')}</span> : null}
            <IssueIcon r={r} />
            {r.sub ? <span className={`asub${r.issues[0] === 'out' ? ' why' : ''}`} title={r.sub}>{r.sub}</span> : null}
            {r.cfgChip && !r.loading ? <span className="achip warn">⚠ {tr('labels.sw.cfgBad')} ›</span> : null}
            {r.loggingIn && mac ? <button type="button" className="alnk" onClick={e => { e.stopPropagation(); p.onCancelLogin(); }}
              disabled={p.offline} title={p.offline ? tr('menu.offline') : undefined}>{tr('common.cancel')}</button> : null}</span>
          {r.loading ? <span className="sk" /> : null}
        </span>
        <span className="rt">
          <b className="apc">{r.right}</b>
          {r.bars.map(b => (
            <span key={b.win} className={`bl ${b.win === 'five' ? 'b5' : 'bw'}`} aria-hidden="true"><span>{tr(b.win === 'five' ? 'deck.acc.bar5' : 'deck.acc.barW')}</span>
              <i><i className={b.tone ?? undefined} style={{ width: `${Math.min(100, b.used)}%` }} />{b.tick !== null ? <s style={{ left: `${b.tick}%` }} /> : null}</i><span>{b.used}</span></span>))}
        </span>
        <span className="acts">
          {r.refresh && canRefresh ? <button type="button" className="ib aref" aria-label={r.refresh.tip} title={r.refresh.tip} disabled={r.refresh.off}
            onClick={e => { e.stopPropagation(); refresh(r.email); }}><RefIcon /></button> : null}
          <button type="button" className="ib amore" aria-haspopup="menu" aria-label={tr('deck.acc.menu', { email: r.email })} onClick={e => { e.stopPropagation(); setRtip(null); p.onMenu(r.email, e.currentTarget); }}>⋯</button>
        </span>
        {r.l3.length ? <span className="l3">{r.l3.map((x, i) => { const I = x.icon ? ST_ICON[x.icon] : null; return (
          <span key={i} className={`nw${x.tone === 'bad' ? ' why' : x.tone === 'warn' ? ' wtxt' : ''}${x.icon ? ' st' : ''}`}>{I ? <I /> : null}{x.text}</span>); })}</span> : null}
      </div>
    );
  };
  const shown = items.slice(win.start, win.end);
  const tipRow = rtip ? m.groups.flatMap(g => g.rows).find(r => r.email === rtip.email) ?? null : null;
  const below = win.total - win.top - shown.reduce((s2, i) => s2 + itemH(i), 0);
  return (
    <aside className="accp open" ref={aside} aria-label={tr('deck.acc.aria')}>
      {head}
      {band}
      {tipRow ? <div className="accp-tip" role="tooltip" style={{ top: rtip!.top }}>{tipRow.tip.map((t, i) => <span key={i} className={i === 1 && tipRow.tipBad ? 'b' : undefined}>{t}</span>)}</div> : null}
      <div className="aov">
        <span className="pool abig"><Ring pct={m.pool} size={60} stroke={5} spin={hd.busy && !hd.blocked} /><b>{m.pool}%</b></span>
        <div className="aovr">
          <span className="lbl">{tr('deck.acc.poolLabel')}</span>
          <span className="sbar" aria-hidden="true">{m.bar.map(b => <i key={b.b} className={`s-${BUCKET_C[b.b]}`} style={{ width: `${b.pct}%` }} data-n={b.n} />)}</span>
          <span className="leg">{m.legend.map(l => <span key={l.b} className={`s-${BUCKET_C[l.b]}`}><i aria-hidden="true" />{l.text}</span>)}</span>
        </div>
      </div>
      {m.tokens || m.week ? <div className="atok"><span>{m.tokens ?? ''}</span><span>{m.week ?? ''}</span></div> : null}
      <div className={`alist${fade ? ' afade' : ''}`}>
        <div className="ascroll" ref={list} onScroll={measure}>
          {win.virtual ? <div style={{ height: win.top }} aria-hidden="true" /> : null}
          {shown.map((it, k) => renderItem(it, win.start + k))}
          {win.virtual ? <div style={{ height: Math.max(0, below) }} aria-hidden="true" /> : null}
          {filter && !items.length ? <div className="anone">{tr('deck.acc.noMatch')} <button type="button" className="lnk"
            onClick={() => { setFilter(''); filterBox.current?.focus(); }}>{tr('deck.acc.clear')}</button></div> : null}
        </div>
      </div>
      {m.n > 8 ? <input ref={filterBox} className="afilter" type="search" placeholder={tr('deck.acc.filter')} aria-label={tr('deck.acc.filter')} value={filter}
        onChange={e => setFilter(e.target.value)} /> : null}
    </aside>
  );
}
