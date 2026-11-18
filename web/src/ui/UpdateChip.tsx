// v2.6 §4.1–§4.6 (UP1–UP6) the update chip on the top bar and its anchored frame; §4.7 / §5.6 (UP7, UP7r) the "Cập nhật"
// row of Settings → Engine, same states, one line. The state lives in the app's Rust
// machine (`src-tauri/src/update.rs`, §5.1): the first value from the command `update_state`, then every Tauri event
// `update_state`. Buttons call `update_start` / `update_cancel` / `update_dismiss` (§10.1). Mac app only (TopBar).
// No modal: the frame closes on Esc / a click outside; only UP5 (installing, seconds before the app exits) veils the window.
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { Snapshot } from '../../../shared/protocol.ts';
import type { UpdateBusy } from '../../../shared/update.ts';
import { fmtHm } from '../lib/format.ts';
import { useT, type Tr } from '../lib/i18n.tsx';
import { openLink } from '../lib/links.ts';
import { invoke, tauriGlobal } from '../lib/tauri.ts';
import { Icon, type IconName } from './icons.tsx';
import './update.css';

/** §5.1 the serde shape of `update::UpdateState` (tag `state`, camelCase fields). `stage: 'wait'` = UP6d (A1 ⑤). */
export type UpdateState =
  | { state: 'idle'; checkedAt: number | null }
  | { state: 'checking' }
  | { state: 'available'; version: string; notes: string; current: string; dismissed: boolean }
  | { state: 'downloading'; version: string; done: number; total: number | null }
  | { state: 'waiting'; version: string; busy: UpdateBusy[]; held: number; since: number | null; installed: boolean }
  | { state: 'installing' | 'relaunching' | 'installed'; version: string }
  | { state: 'error'; stage: 'check' | 'download' | 'wait' | 'install' | 'relaunch'; reason: string; version: string | null; badSignature: boolean };

const REPO = 'https://github.com/billphamhypertek/cc-slaves';
const NOTE_LINES = 8; // §4.2
const MB = 1024 * 1024;
const SEEN_KEY = 'ccs.update.seen';
const mins = (ms: number) => Math.max(0, Math.floor(ms / 60_000));
const pctOf = (done: number, total: number | null) => (total ? Math.min(100, Math.round((done / total) * 100)) : null);

/** §5.1 the state from the app; `null` until it answers (or outside the Mac app). */
function useUpdateState(): UpdateState | null {
  const [s, setS] = useState<UpdateState | null>(null);
  useEffect(() => {
    let live = true;
    void invoke<UpdateState>('update_state').then(v => { if (live && v) setS(v); }, () => {});
    const off = tauriGlobal()?.event?.listen<UpdateState>('update_state', e => { if (live) setS(e.payload); });
    return () => { live = false; void off?.then(f => f()).catch(() => {}); };
  }, []);
  return s;
}

interface Look { icon: IconName; cls: string; line: string; short: string; pct: number | null }
/** §4.1 the chip of each state; `null` = no chip (idle, checking, dismissed, an automatic check error §4.6). */
function look(tr: Tr, s: UpdateState): Look | null {
  switch (s.state) {
    case 'available': return s.dismissed ? null : { icon: 'arrowUp', cls: 'acc', line: tr('update.chip.available', { v: s.version }), short: s.version, pct: null };
    case 'downloading': {
      const pct = pctOf(s.done, s.total);
      return { icon: 'arrowDown', cls: '', line: pct === null ? tr('update.chip.downloadStart') : tr('update.chip.downloading', { pct }), short: pct === null ? '' : `${pct}%`, pct };
    }
    case 'waiting': return { icon: 'hourglass', cls: 'wait', line: s.busy.length ? tr('update.chip.waiting', { n: s.busy.length }) : tr('update.chip.waitingNone'),
      short: s.busy.length ? String(s.busy.length) : '', pct: null };
    case 'installing': case 'relaunching': return { icon: 'loader', cls: 'ins', line: tr('update.chip.installing'), short: '', pct: null };
    case 'installed': return { icon: 'refresh', cls: 'acc', line: tr('update.chip.installed', { v: s.version }), short: s.version, pct: null };
    case 'error': return s.stage === 'check' ? null : { icon: 'bang', cls: 'bad', line: tr('update.chip.error'), short: '', pct: null };
    default: return null;
  }
}

/** §5.6 the version this Mac last ran: `at` = the engine start that first ran `v`, `from` = the version before (null = the
 *  first run ever). The app and the engine restart together on an update, so that start is the update's time. */
interface Seen { v: string; at: number; from: string | null }
function readSeen(): Seen | null {
  try { const o = JSON.parse(localStorage.getItem(SEEN_KEY) ?? 'null') as Seen | null; return o && typeof o.v === 'string' ? o : null; } catch { return null; }
}
/** §5.6 notes the running version (the chip calls it at start, so Settings opened later still knows). */
function noteVersion(v: string, startedAt: number): Seen {
  const old = readSeen();
  if (old?.v === v) return old;
  const now: Seen = { v, at: startedAt, from: old?.v ?? null };
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(now)); } catch { /* storage blocked: the line just does not show */ }
  return now;
}

/** §4.2 the turns running now: the engine's own list while the app holds (§5.4-4), else (it only reports while held) the
 *  lanes mid-turn + the Điều phối that are running. */
const turnsNow = (snap: Snapshot) => (snap.engine.update?.hold ? snap.engine.update.busy.length
  : snap.lanes.filter(l => l.turnStartedAt !== null).length + snap.orchestrators.filter(o => o.state === 'running').length);

/** §7.4 the notes are Vietnamese, a `---` line, then English: the half of the UI language (no English half → the Vietnamese). */
const notesIn = (notes: string, lang: string) => { const [vi = '', en] = notes.split(/^\s*---\s*$/m); return lang === 'en' && en ? en : vi; };
/** §4.2 the first lines of the release notes, simple markdown marks (`#`, `-`, `*`, `1.`, `**`) dropped, blank lines skipped. */
const noteLines = (notes: string) => notes.split('\n').map(l => l.replace(/^\s*(?:#+|[-*+]|\d+\.)\s*/, '').replaceAll('**', '').trim()).filter(Boolean).slice(0, NOTE_LINES);

export function UpdateChip({ snap, offline }: { snap: Snapshot; offline: boolean }): ReactElement | null {
  const tr = useT();
  const s = useUpdateState();
  const btn = useRef<HTMLButtonElement>(null);
  const { version, startedAt } = snap.engine;
  useEffect(() => { noteVersion(version, startedAt); }, [version, startedAt]);
  const [open, setOpen] = useState(false);
  const l = s ? look(tr, s) : null;
  const openable = !!l && l.cls !== 'ins';
  useEffect(() => { if (!openable) setOpen(false); }, [openable]);
  const close = (refocus: boolean) => { setOpen(false); if (refocus) btn.current?.focus(); };
  const veil = s?.state === 'installing' || s?.state === 'relaunching';
  if (!s || !l) return null;
  const short = s.state === 'error' ? <><Icon n="arrowUp" s={13} /><i className="rdot" /></> : <><Icon n={l.icon} s={13} />{l.short ? <span className="upc-n">{l.short}</span> : null}</>;
  return <>
    <button ref={btn} type="button" className={['upc', l.cls, open ? 'on' : ''].filter(Boolean).join(' ')} disabled={!openable} title={l.line} aria-label={l.line}
      aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(o => !o)}>
      <span className="upc-w"><Icon n={l.icon} s={13} /><span className="upc-t">{l.line}</span></span>
      <span className="upc-s">{short}</span>
      {l.pct !== null ? <i className="bar" style={{ width: `${l.pct}%` }} /> : null}
    </button>
    {open && openable ? createPortal(<Pop anchor={btn} onClose={close}><Body s={s} snap={snap} offline={offline} close={() => close(false)} /></Pop>, document.body) : null}
    {veil ? createPortal(<div className="upinst" role="status"><div className="box"><Icon n="loader" s={18} /><div>{tr('update.installing', { v: s.version })} <span>{tr('update.installingNote')}</span></div></div></div>, document.body) : null}
  </>;
}

/** The frame under the chip: right edge on the chip's right edge; Esc / a click outside closes it (no modal, §4.2). */
function Pop({ anchor, onClose, children }: { anchor: RefObject<HTMLButtonElement | null>; onClose: (refocus: boolean) => void; children: ReactNode }): ReactElement {
  const tr = useT();
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => { const r = anchor.current?.getBoundingClientRect(); if (r) setPos({ top: r.bottom + 6, right: Math.max(8, innerWidth - r.right) }); };
    place();
    addEventListener('resize', place);
    return () => removeEventListener('resize', place);
  }, [anchor]);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    box.current?.focus(); // the keyboard lands in the frame; Esc works from the chip too
    const f = (e: MouseEvent) => { const t = e.target as Node; if (!box.current?.contains(t) && !anchor.current?.contains(t)) close.current(false); };
    const k = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close.current(true); } };
    document.addEventListener('mousedown', f, true);
    document.addEventListener('keydown', k, true);
    return () => { document.removeEventListener('mousedown', f, true); document.removeEventListener('keydown', k, true); };
  }, [anchor]);
  return <div ref={box} className="upop" role="dialog" aria-label={tr('update.update')} style={pos ?? undefined} tabIndex={-1}>{children}</div>;
}

const run = (cmd: 'update_check' | 'update_start' | 'update_cancel' | 'update_dismiss') => { void invoke(cmd).catch(() => {}); };

function Body({ s, snap, offline, close }: { s: UpdateState; snap: Snapshot; offline: boolean; close: () => void }): ReactElement | null {
  const tr = useT();
  const busyNow = turnsNow(snap);
  const impact = (idle: 'update.impact.idle' | 'update.impact.idleNow') =>
    <div className="imp"><Icon n="info" s={13} /><span>{busyNow ? tr('update.impact.busy', { n: busyNow }) : tr(idle)}</span></div>;
  switch (s.state) {
    case 'available': return <>
      <div className="uh"><b>{tr('update.head', { v: s.version })}</b><span className="cur">{tr('update.current', { v: s.current })}</span></div>
      <ul>{noteLines(notesIn(s.notes, tr.lang)).map((n, i) => <li key={i}>{n}</li>)}</ul>
      <button type="button" className="lnk gh" onClick={() => void openLink(`${REPO}/releases/tag/v${s.version}`).catch(() => {})}>{tr('update.github')}<Icon n="extLink" s={13} /></button>
      {impact('update.impact.idle')}
      <div className="ft"><button type="button" className="btn" onClick={() => { run('update_dismiss'); close(); }}>{tr('update.later')}</button>
        <button type="button" className="btn pri" onClick={() => run('update_start')}>{tr('update.update')}</button></div>
      <div className="ftc">{tr('update.laterNote', { v: s.version })}</div>
    </>;
    case 'downloading': {
      const pct = pctOf(s.done, s.total), done = Math.round(s.done / MB);
      return <>
        <div className="uh"><b>{tr('update.head', { v: s.version })}</b></div>
        <div className="pb"><i style={{ width: `${pct ?? 0}%` }} /></div>
        <div className="pl"><span>{s.total ? tr('update.dl.line', { pct: pct ?? 0, done, total: Math.round(s.total / MB) }) : tr('update.dl.lineNoTotal', { done })}</span>
          <button type="button" className="btn sm" onClick={() => run('update_cancel')}>{tr('update.cancel')}</button></div>
      </>;
    }
    case 'waiting': return <Waiting s={s} snap={snap} />;
    case 'installed': return <>
      <div className="uh"><b>{tr('update.inst.title', { v: s.version })}</b></div>
      {impact('update.impact.idleNow')}
      <div className="ft"><button type="button" className="btn" onClick={close}>{tr('update.later')}</button>
        <button type="button" className="btn pri" onClick={() => run('update_start')}><Icon n="refresh" s={13} />{tr('update.inst.restart')}</button></div>
    </>;
    case 'error': return <Failed s={s} snap={snap} offline={offline} />;
    default: return null;
  }
}

function Waiting({ s, snap }: { s: Extract<UpdateState, { state: 'waiting' }>; snap: Snapshot }): ReactElement {
  const tr = useT();
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, []);
  const project = (b: UpdateBusy) => (b.kind === 'workflow' ? tr('update.wait.workflow') : snap.projects.find(p => p.id === b.projectId)?.name ?? b.projectId);
  return <>
    <div className="uh">{s.installed ? <b>{tr('update.wait.installed', { v: s.version })}</b>
      : <><b>{tr('update.wait.title', { m: mins(now - (s.since ?? now)) })}</b><span className="cur">{s.version}</span></>}</div>
    {s.busy.length ? <div className="wl">{s.busy.map(b => <div key={`${b.projectId}/${b.kind}/${b.name}`} className="wr"><i />
      <span className="p">{project(b)}</span>
      <span className={b.kind === 'orchestrator' ? 'n' : 'n m'}>{b.kind === 'orchestrator' ? tr('update.wait.orch') : b.name}</span>
      <span className="t">{tr('update.wait.row', { m: mins(now - b.turnStartedAt) })}</span></div>)}</div> : null}
    {s.held ? <div className="held"><Icon n="clock" s={13} />{tr('update.wait.held', { n: s.held })}</div> : null}
    <div className="ft">{s.held ? <span className="ftl">{tr('update.wait.cancelNote', { n: s.held })}</span> : null}
      <button type="button" className="btn" onClick={() => run('update_cancel')}>{tr('update.wait.cancel')}</button></div>
  </>;
}

/** §4.6 / §6 UP6a–d. UP6b: Đóng is the primary; UP6d: Thử lại waits for the engine (R17 keeps the chip itself usable). */
type Err = Extract<UpdateState, { state: 'error' }>;
/** §6 the sentence of a download / wait / install / relaunch error (UP6a–d), the frame's and the Settings row's. */
function failText(tr: Tr, s: Err, cur: string): ReactNode {
  const v = s.version ?? '';
  return s.badSignature
    ? <>{tr('update.err.signature', { v })} <button type="button" className="lnk" onClick={() => void openLink(`${REPO}/issues/new`).catch(() => {})}>{tr('update.err.report')}</button>.</>
    : s.stage === 'wait' ? tr('update.err.wait')
    : s.stage === 'install' ? tr('update.err.install', { v, reason: s.reason, cur })
    : s.stage === 'relaunch' ? tr('update.err.relaunch', { v, reason: s.reason })
    : tr('update.err.download', { v, reason: s.reason });
}

function Failed({ s, snap, offline }: { s: Err; snap: Snapshot; offline: boolean }): ReactElement {
  const tr = useT();
  const text = failText(tr, s, snap.engine.version);
  const lock = s.stage === 'wait' && offline;
  const retry = <button key="r" type="button" className={s.badSignature ? 'btn' : 'btn pri'} disabled={lock} title={lock ? tr('update.retryOffline') : undefined}
    onClick={() => run('update_start')}><Icon n="refresh" s={13} />{tr('update.retry')}</button>;
  const shut = <button key="c" type="button" className={s.badSignature ? 'btn pri' : 'btn'} onClick={() => run('update_cancel')}>{tr('update.close')}</button>;
  return <>
    <div className="er"><Icon n="bang" /><span>{text}</span></div>
    <div className="ft">{s.badSignature ? [retry, shut] : [shut, retry]}</div>
  </>;
}

interface RowLook { icon?: IconName; cls?: string; text: ReactNode; act?: 'check' | 'checking' | 'start' | 'restart' }
/** §4.7 / §5.6 UP7a–c, UP7r: one line per state; the busy states say what the chip says. */
function rowLook(tr: Tr, s: UpdateState, snap: Snapshot): RowLook {
  const { version, startedAt } = snap.engine, seen = noteVersion(version, startedAt);
  switch (s.state) {
    case 'idle': return seen?.from && seen.v === version && seen.at === startedAt
      ? { cls: 'ok', text: tr('settings.engine.upAfter', { v: version, time: fmtHm(startedAt) }), act: 'check' }
      : { text: s.checkedAt === null ? tr('settings.engine.upNever') : tr('settings.engine.upLatest', { time: fmtHm(s.checkedAt) }), act: 'check' };
    case 'checking': return { icon: 'loader', cls: 'run', text: tr('settings.engine.upChecking'), act: 'checking' };
    case 'available': return { cls: 'acc', text: tr('settings.engine.upAvail', { v: s.version }), act: 'start' };
    case 'installed': return { cls: 'acc', text: tr('settings.engine.upInstalled', { v: s.version }), act: 'restart' };
    case 'error': return s.stage === 'check' ? { icon: 'bang', cls: 'bad', text: tr('settings.engine.upCheckErr', { reason: s.reason }), act: 'check' }
      : { icon: 'bang', cls: 'bad', text: failText(tr, s, version) };
    default: { const l = look(tr, s)!; return { icon: l.icon, cls: l.cls === 'wait' ? 'wait' : '', text: l.line }; }
  }
}

/** §4.7 the "Cập nhật" row of Settings → Engine (Mac app only): Kiểm tra cập nhật / Cập nhật / Khởi động lại by state. */
export function UpdateRow({ snap }: { snap: Snapshot }): ReactElement | null {
  const tr = useT();
  const s = useUpdateState();
  if (!s) return null;
  const r = rowLook(tr, s, snap);
  const act = r.act === 'check' || r.act === 'checking'
    ? <button type="button" className="btn sm" disabled={r.act === 'checking'} onClick={() => run('update_check')}><Icon n="refresh" s={13} />{tr('settings.engine.upCheck')}</button>
    : r.act ? <button type="button" className="btn sm pri" onClick={() => run('update_start')}>{r.act === 'restart' ? <><Icon n="refresh" s={13} />{tr('update.inst.restart')}</> : tr('update.update')}</button>
    : null;
  return <span className="uprow">
    <span className={['upr-t', r.cls].filter(Boolean).join(' ')}>{r.icon ? <Icon n={r.icon} s={13} /> : null}{r.text}</span>{act}
  </span>;
}
