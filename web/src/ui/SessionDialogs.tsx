// v2.1 §4.14 the session dialogs (own lazy chunk): N5-b "Mở phiên song song", N5-k "Kết thúc phiên", rename, N5-f/g/r
// "Chạy tiếp phiên #n?" and "Phiên mới từ #n" (handoff / last 50 lines), §4.15 N5-o "Chạy tiếp lane…". Offline: main buttons locked (§4.14 offline).
// v2.7.1 §4.1 the start dialog (`k: 'start'`, SA1–SA5b, SA9, SA9b) and the step list after every start (SA3 / SA4, L11 / L14).
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { SessionPick, StartPicks } from '../../../shared/issues.ts';
import type { AccountView, CardView, Command, LaneContinuePreview, LaneView, OrchestratorView, ResumePreview, SessionModels, SessionsList } from '../../../shared/protocol.ts';
import { accKind } from '../deck/accounts.ts';
import { cardTitle, errText, reasonText, useT } from '../lib/i18n.tsx';
import { fmtDayHm, fmtLeft, fmtResetTime, fmtTok } from '../lib/format.ts';
import { issueCmds } from '../lib/issues.ts';
import { defaultReceiver, endAsks, endHow, estimateText, freshCmd, nextSeq, openCmd, parallelFirst, resumeCmd, resumeDefaults, sessionLabel, sinceText, type SessionDlg } from '../lib/sessions.ts';
import { accRows, autoText, pickKind, type AccRow, type AutoPick, type Prior, type StartReq } from '../lib/start.ts';
import { useFade } from '../lib/fade.ts';
import { Icon } from './icons.tsx';
import { ModelPick, useBootWait, useModelList } from './ModelMenu.tsx';
import { StartProgress, useStartRun } from './StartSteps.tsx';
import './sessions.css';
// the history popover rides in this chunk too (one lazy chunk for every §4.14 session screen)
export { SessionList } from './SessionList.tsx';

export interface SessionDialogsProps {
  dlg: SessionDlg; os: OrchestratorView[]; list: SessionsList | null; projectName: string; accounts: AccountView[];
  lanes: LaneView[]; cards: CardView[]; offline: boolean; now: number;
  /** the session Đang xem showed before history (resume "Thay [#n ▾]" default). */
  prevSid: string | null;
  send: (c: Command) => Promise<unknown>;
  /** the start commands: a refusal shows on the step list only, never also as a toast (SA4, UX MINOR-2) */
  sendQuiet: (c: Command) => Promise<unknown>;
  loadPreview: (sessionId: string) => Promise<ResumePreview | null>;
  /** v2.4 §4.4 `session_models` for the account chosen in the dialog (null = the orchestrator rule). */
  loadModels: (projectId: string, accountId: string | null) => Promise<unknown>;
  onStarted: (v: OrchestratorView) => void; onClose: () => void;
  /** §4.1 SA4 "Mở bảng Account" (no account left, ruling 16:10): Deck with the Account panel open */
  onAccounts: () => void;
}

const label = (tr: ReturnType<typeof useT>, o: Pick<OrchestratorView, 'seq' | 'title'>) => sessionLabel(tr, o.seq ?? null, o.title);

function Shell({ title, aria, onClose, children, foot, cls, onKeyDown }: { title: string; aria?: string; onClose: () => void; children: ReactNode; foot: ReactNode;
  cls?: string; onKeyDown?: (e: React.KeyboardEvent) => void }): ReactElement {
  const tr = useT();
  const fade = useFade<HTMLDivElement>(true); // m8 the body scrolls under a fixed foot; the hidden edge fades
  return (
    <div className={`modal glass sdlg${cls ? ` ${cls}` : ''}`} role="dialog" aria-label={aria ?? title} onKeyDown={onKeyDown}>
      <div className="mh"><h2>{title}</h2><button className="x" onClick={onClose} aria-label={tr('common.close')}><Icon n="x" /></button></div>
      <div className="sdb" ref={fade.ref} onScroll={fade.onScroll}>{children}</div>
      <div className="mf">{foot}</div>
    </div>
  );
}

/** a send that keeps the dialog open with the engine's reason on refusal. */
function useSend(send: SessionDialogsProps['send']) {
  const tr = useT();
  const [err, setErr] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const run = (c: Command, ok: (r: unknown) => void) => {
    setBusy(true); setErr(null);
    send(c).then(r => { setBusy(false); ok(r); }, e => { setBusy(false); setErr(errText(tr, e)); });
  };
  return { err, busy, run };
}
/** v2.4 §4.4 MD10–MD11 the Model · Effort row under Account; the list is the dialog account's (re-read when it changes). */
type Picks = { model: string | null; effort: string | null };
/** the list of the dialog's account (re-read when it changes); `projectId` null = not known yet (Chạy tiếp before its preview). */
const useDlgModels = (load: SessionDialogsProps['loadModels'], projectId: string | null, account: string | null) =>
  useModelList(`a:${projectId ?? ''}:${account ?? ''}`, () => (projectId ? load(projectId, account) : new Promise(() => {})));
function ModelRow({ l, v, onPick, asBefore }: { l: ReturnType<typeof useModelList>; v: Picks; onPick: (v: Picks) => void; asBefore?: Prior | undefined }): ReactElement {
  return <ModelPick models={l.models} loading={l.loading} model={v.model} effort={v.effort} onChange={onPick} onRetry={l.retry} {...(asBefore ? { asBefore } : {})} />;
}
const NO_PICK: Picks = { model: null, effort: null };
/** step 2's "<model> · <effort>": the pick, else the account's default (null = not known yet; the session view fills it). */
function modelText(m: SessionModels | null, v: Picks): string | null {
  const ok = m && !m.unavailable ? m : null;
  const name = v.model ? ok?.models.find(x => x.value === v.model)?.displayName ?? v.model : ok?.defaultModelName ?? null;
  const effort = v.effort ?? ok?.defaultEffort ?? ok?.claudeEffort ?? null;
  return name ? (effort ? `${name} · ${effort}` : name) : null;
}
const Err = ({ text }: { text: string | null }) => (text ? <div className="preview bad" role="alert"><Icon n="alert" s={14} /><span>{text}</span></div> : null);

/** `text` with `b` drawn bold (an email inside a sentence, SA1 / SA9). */
const bold = (text: string, b: string | null): ReactNode => {
  const k = b ? text.indexOf(b) : -1;
  return k < 0 || !b ? text : <>{text.slice(0, k)}<b>{b}</b>{text.slice(k + b.length)}</>;
};
/** `text` with `c` set as code (the spec path of a lead, SA1). */
const code = (text: string, c: string): ReactNode => {
  const k = text.indexOf(c);
  return k < 0 ? text : <>{text.slice(0, k)}<code>{c}</code>{text.slice(k + c.length)}</>;
};

/** §4.1 "Tự chọn" from `session_pick` (SA5 while asked, SA9 none left); asked again on reconnect (SA9b). */
function useAutoPick(send: SessionDialogsProps['send'], projectId: string, kind: 'design' | 'build', offline: boolean): AutoPick {
  const [a, setA] = useState<AutoPick>({ st: 'loading' });
  useEffect(() => {
    if (offline) return;
    let live = true;
    setA({ st: 'loading' });
    send({ cmd: 'session_pick', projectId, kind }).then(r => {
      if (!live) return;
      const p = r as SessionPick;
      setA(p.account === null ? { st: 'none', earliest: p.earliest } : { st: 'ok', email: p.account, pct: p.headroomPct });
    }, () => { if (live) setA({ st: 'error' }); });
    return () => { live = false; };
  }, [projectId, kind, offline]); // eslint-disable-line react-hooks/exhaustive-deps
  return a;
}

/** §4.1 / §4.14 the Account field: "Tự chọn" (with the account it will use, when asked) or one logged-in account. Every
 *  account is listed; one that cannot take a session is greyed with its reason (L3, L13) and cannot be picked (SA2). */
function AccountField({ value, onPick, rows, auto, startOpen = false }: { value: string | null; onPick: (a: string | null) => void; rows: AccRow[];
  auto: AutoPick; startOpen?: boolean }): ReactElement {
  const tr = useT();
  const btn = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ left: number; top: number; width: number } | null>(null);
  const place = () => { const b = btn.current?.getBoundingClientRect(); if (b) setAt({ left: b.left, top: b.top, width: b.width }); };
  useEffect(() => { if (startOpen) place(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!at) return;
    const down = (e: MouseEvent) => { if (!(e.target as Element | null)?.closest('.apop, .apick')) setAt(null); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); setAt(null); btn.current?.focus(); } };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key, true); };
  }, [at]);
  const pick = (a: string | null) => { onPick(a); setAt(null); btn.current?.focus(); };
  const cur = value ? rows.find(r => r.email === value) : null;
  const autoEmail = auto.st === 'ok' ? auto.email : null;
  const shown = cur ? bold(cur.main, cur.email) : <>{auto.st === 'loading' ? <span className="spin sm" aria-hidden="true" /> : null}{bold(autoText(tr, auto), autoEmail)}</>;
  return (
    <div className="sfield acc">
      <span className="lrow"><span>{tr('session.account')}</span><span className="hint">{tr('session.stAccHint')}</span></span>
      <button ref={btn} type="button" className="field apick" aria-haspopup="listbox" aria-expanded={!!at} aria-label={tr('session.account')}
        onClick={() => (at ? setAt(null) : place())} onKeyDown={e => { if (e.key === 'ArrowDown' && !at) { e.preventDefault(); place(); } }}>
        <span className="v">{shown}</span><Icon n="chev" s={14} /></button>
      {at ? createPortal(<div className="apop mpop glass" role="listbox" aria-label={tr('session.account')} style={at}>
        <button type="button" role="option" aria-selected={value === null} className="arow" onClick={() => pick(null)}>
          <span className="mk">{value === null ? <Icon n="check" s={12} /> : null}</span><b>{bold(autoText(tr, auto), autoEmail)}</b><em>{tr('session.stAutoRule')}</em></button>
        {rows.map(r => (
          <button type="button" key={r.email} role="option" aria-selected={value === r.email} aria-disabled={!r.ok || undefined} className={`arow${r.ok ? '' : ' off'}`}
            onClick={() => { if (r.ok) pick(r.email); }}>
            <span className="mk">{value === r.email ? <Icon n="check" s={12} /> : null}</span><b>{r.main}</b>{r.side ? <em>{r.side}</em> : null}
            {r.why ? <small>{r.why}</small> : null}</button>))}
      </div>, document.body) : null}
    </div>
  );
}
const useRows = (p: Pick<SessionDialogsProps, 'accounts' | 'os'>) => {
  const tr = useT();
  return accRows(tr, p.accounts, p.os, a => accKind(a) === 'low', o => label(tr, o));
};
/** SA9 / SA9b the warning line under the fields (neutral text, amber icon, no tinted fill). */
function StartWarn({ auto, offline }: { auto: AutoPick | null; offline: boolean }): ReactElement | null {
  const tr = useT();
  if (offline) return <p className="note alert" role="status"><Icon n="alert" s={14} /><span>{tr('session.stOffline')}</span></p>;
  if (auto?.st !== 'none') return null;
  const e = auto.earliest;
  return <p className="note alert" role="status"><Icon n="alert" s={14} /><span>{e ? bold(tr('session.stNone', { email: e.email, at: fmtResetTime(e.at) }), e.email) : tr('session.stNoneNoAt')}</span></p>;
}
/** the account step 1 names before the session exists: the pick, else what "Tự chọn" said. */
const runInfo = (acc: string | null, auto: AutoPick, model: string | null) => (acc
  ? { account: acc, auto: false, pct: null, model }
  : { account: auto.st === 'ok' ? auto.email : null, auto: true, pct: auto.st === 'ok' ? auto.pct : null, model });
/** step 4 of a Deck dialog: Đang xem moves to the new session (N5-h). */
function started(p: SessionDialogsProps, sid: string): void {
  const o = p.os.find(x => x.sessionId === sid);
  if (o) p.onStarted(o); else p.onClose();
}
/** a start command's ack → the new session's id (`session_open` / `session_resume` answer its view, `spec_*` `{sessionId}`). */
const sidOf = (r: unknown): string => (r as { sessionId?: string }).sessionId ?? '';
/** "Tự chọn" only warns while no account is picked (SA9). */
const noneLeft = (acc: string | null, auto: AutoPick) => !acc && auto.st === 'none';
/** the hand-picked account's §4.5 reason once it can no longer take a session (it filled up while the dialog was open, UX MINOR-6). */
const pickWhy = (acc: string | null, rows: AccRow[]) => (acc ? rows.find(r => r.email === acc)?.why ?? null : null);
const PickWarn = ({ why }: { why: string | null }) => (why ? <p className="note alert" role="status"><Icon n="alert" s={14} /><span>{why}</span></p> : null);
const NO_AUTO: AutoPick = { st: 'error' };

/** N5-b: name (≤ 24), first message (placeholder = the engine default), account; then the step list (L11 / L14). */
function ParallelDialog(p: SessionDialogsProps & { projectId: string }): ReactElement {
  const tr = useT();
  const n = nextSeq(p.list, p.os), others = p.os.map(o => label(tr, o)).join(', ');
  const [title, setTitle] = useState(''), [first, setFirst] = useState(''), [acc, setAcc] = useState<string | null>(null), [reopen, setReopen] = useState(0);
  const [mp, setMp] = useState<Picks>(NO_PICK);
  const auto = useAutoPick(p.send, p.projectId, 'design', p.offline), rows = useRows(p), l = useDlgModels(p.loadModels, p.projectId, acc);
  const s = useStartRun(p.os, p.accounts, sid => started(p, sid));
  if (s.run) return <StartProgress what={s.what} run={s.run} now={s.now} onClose={p.onClose} onRetry={s.retry} onOtherAccount={() => { s.reset(); setReopen(k => k + 1); }} onAccounts={p.onAccounts} />;
  const why = pickWhy(acc, rows);
  const go = () => s.begin(() => p.sendQuiet(openCmd(p.projectId, { title, first, account: acc, model: mp.model, effort: mp.effort })).then(sidOf), runInfo(acc, auto, modelText(l.models, mp)), tr('session.stWhatN', { n }));
  return (
    <Shell title={tr('session.parTitle')} onClose={p.onClose} foot={<>
      <button className="btn" onClick={p.onClose}>{tr('common.cancel')}</button>
      <button className="btn pri" disabled={p.offline || noneLeft(acc, auto) || !!why} onClick={go}>{tr('session.parGo', { n })}</button></>}>
      <p className="lead">{tr('session.parLead', { project: p.projectName, others })}</p>
      <label className="sfield"><span>{tr('session.parName')}</span><input className="field" maxLength={24} value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label className="sfield"><span>{tr('session.parFirst', { n })}</span>
        <textarea className="field" rows={3} value={first} placeholder={parallelFirst(tr, n, p.projectName)} onChange={e => setFirst(e.target.value)} /></label>
      <AccountField key={reopen} startOpen={reopen > 0} value={acc} onPick={setAcc} rows={rows} auto={auto} />
      {!p.offline ? <StartWarn auto={acc ? null : auto} offline={false} /> : null}
      <PickWarn why={why} />
      <ModelRow l={l} v={mp} onPick={setMp} />
      {p.offline ? <StartWarn auto={null} offline /> : null}
      <p className="note">{tr('session.parNote', { others, max: p.list?.max ?? 3 })}</p>
    </Shell>
  );
}

/** v2.7.1 §4.1 the start dialog of a Tasks button's ▾ (SA1–SA5b, SA9, SA9b): Account on its own row, Model · Effort under it,
 *  Enter = start, Esc = cancel; then the step list (SA3 / SA4). `req.direct` (the split button's main part) skips the choice. */
function StartDialog(p: SessionDialogsProps & { req: StartReq }): ReactElement {
  const tr = useT();
  const r = p.req, spec = r.spec ?? r.path ?? '', path = r.path ?? '';
  const [acc, setAcc] = useState<string | null>(null), [mp, setMp] = useState<Picks>(NO_PICK), [reopen, setReopen] = useState(0);
  const auto = useAutoPick(p.send, r.projectId, pickKind(r.kind), p.offline), rows = useRows(p), l = useDlgModels(p.loadModels, r.projectId, acc);
  const s = useStartRun(p.os, p.accounts, sid => { if (r.opened) { r.opened(sid); p.onClose(); } else started(p, sid); });
  const build = r.kind === 'build' || r.kind === 'resume';
  const what = r.kind === 'new' ? tr('session.stWhatNew') : build ? tr('session.stWhatBuild', { spec }) : tr('session.stWhatDesign', { spec });
  const go = () => {
    const c = issueCmds(p.sendQuiet, r.projectId);
    const picks: StartPicks = { ...(acc ? { account: acc } : {}), ...(mp.model !== null ? { model: mp.model } : {}), ...(mp.effort !== null ? { effort: mp.effort } : {}) };
    s.begin(() => (r.kind === 'new' ? c.specNew(picks) : r.kind === 'build' || r.kind === 'resume' ? c.specBuild(path, r.resume?.id, picks) : c.specEdit(path, picks)).then(sidOf),
      runInfo(acc, auto, modelText(l.models, mp)), what);
  };
  useLayoutEffect(() => { if (r.direct) go(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // the main part sent before session_pick / the model list answered: step 1–2 name them once known (UX MINOR-1)
  useEffect(() => { s.fill(runInfo(acc, auto, modelText(l.models, mp))); }, [auto, l.models]); // eslint-disable-line react-hooks/exhaustive-deps
  if (s.run) return <StartProgress what={s.what} run={s.run} now={s.now} onClose={p.onClose} onRetry={s.retry} onOtherAccount={() => { s.reset(); setReopen(k => k + 1); }} onAccounts={p.onAccounts} />;
  const title = tr(START_TITLE[r.kind], { spec });
  const lead = r.kind === 'new' ? tr('session.stLeadNew', { project: p.projectName }) : r.kind === 'resume' ? tr('session.stLeadResume', { what: r.resume?.label ?? '' })
    : code(tr(build ? 'session.stLeadBuild' : 'session.stLeadDesign', { path }), path);
  const none = noneLeft(acc, auto), why = pickWhy(acc, rows), lock = p.offline || none || !!why;
  const keys = (e: React.KeyboardEvent) => {
    const t = e.target as Element;
    if (e.key === 'Enter' && !lock && !t.closest('button, select, textarea')) { e.preventDefault(); go(); }
  };
  return (
    <Shell title={title} cls="sstart" onClose={p.onClose} onKeyDown={keys} foot={<>
      <span className="fl">{p.offline ? tr('session.stOfflineFoot') : none ? tr('session.stNoneFoot') : why ? tr('session.stPickBadFoot')
        : <><kbd>Enter</kbd> {tr('session.stKeyGo')} · <kbd>Esc</kbd> {tr('session.stKeyEsc')}</>}</span>
      <button className="btn" onClick={p.onClose}>{tr('common.cancel')}</button>
      <button className="btn pri" autoFocus disabled={lock} onClick={go}>{tr(START_GO[r.kind])}</button></>}>
      <p className="lead">{lead}</p>
      <AccountField key={reopen} startOpen={reopen > 0} value={acc} onPick={setAcc} rows={rows} auto={auto} />
      {!p.offline ? <StartWarn auto={acc ? null : auto} offline={false} /> : null}
      <PickWarn why={why} />
      <ModelRow l={l} v={mp} onPick={setMp} asBefore={r.kind === 'resume' ? r.resume?.prior ?? { model: null, effort: null } : undefined} />
      <p className="note"><Icon n="info" s={12} /><span>{tr(r.kind === 'resume' ? 'session.stNoteResume' : 'session.stNote')}</span></p>
      {p.offline ? <StartWarn auto={null} offline /> : null}
    </Shell>
  );
}
const START_TITLE = { new: 'session.stTitleNew', build: 'session.stTitleBuild', edit: 'session.stTitleEdit', amend: 'session.stTitleAmend', open: 'session.stTitleOpen', resume: 'session.stTitleResume' } as const;
const START_GO = { new: 'session.stGoNew', build: 'session.stGoBuild', edit: 'session.stGoDesign', amend: 'session.stGoDesign', open: 'session.stGoDesign', resume: 'session.stGoResume' } as const;

/** N5-k: lanes go to the receiver (default = earliest running); a stopped session ends without a handoff; its asks expire. */
function EndDialog(p: SessionDialogsProps & { sessionId: string }): ReactElement {
  const tr = useT();
  const o = p.os.find(x => x.sessionId === p.sessionId);
  const [to, setTo] = useState<string | null>(() => defaultReceiver(p.os, p.sessionId));
  const s = useSend(p.send);
  const wait = useBootWait(s.busy && o?.state === 'starting'); // §5 G2c the end waits the boot (ack ≈ 3–8 s)
  if (!o) return <Shell title={tr('session.endTitle', { who: '' })} onClose={p.onClose} foot={<button className="btn" onClick={p.onClose}>{tr('common.close')}</button>}><span /></Shell>;
  const n = o.seq ?? '?', who = label(tr, o);
  const owned = p.lanes.filter(l => l.projectId === o.projectId && l.ownerSession === p.sessionId && l.state !== 'done');
  const asks = endAsks(p.cards, p.sessionId), rest = p.os.filter(x => x.sessionId !== p.sessionId);
  return (
    <Shell title={tr('session.endTitle', { who })} onClose={p.onClose} foot={<>
      <button className="btn" onClick={p.onClose}>{tr('common.cancel')}</button>
      <button className="btn pri bad" disabled={p.offline || s.busy} onClick={() => s.run({ cmd: 'session_end', sessionId: p.sessionId, ...(to ? { lanesTo: to } : {}) }, p.onClose)}>
        {s.busy ? <span className="spin sm" aria-hidden="true" /> : null}{tr('session.endGo', { n })}</button></>}>
      <p className="lead">{o.state === 'stopped' ? tr('session.endStopped', { n }) : tr('session.endLead', { n, days: p.list?.cleanupPeriodDays ?? 30 })}</p>
      {owned.length && rest.length ? <label className="sfield"><span>{tr('session.endLanesTo', { count: owned.length, n })}</span>
        <select className="field" value={to ?? ''} onChange={e => setTo(e.target.value || null)}>
          {rest.map(x => <option key={x.sessionId ?? ''} value={x.sessionId ?? ''}>{label(tr, x)}</option>)}
        </select></label> : null}
      {owned.length ? <p className="note">{tr('session.endNote', { n })}</p> : null}
      {asks.length ? <p className="note warn" role="status"><Icon n="alert" s={14} /> {tr('session.endAsks', { n, list: asks.map(c => cardTitle(tr, c)).join(' · ') })}</p> : null}
      {wait ? <p className="note wait" role="status"><span className="spin sm" aria-hidden="true" />{wait}</p> : null}
      <Err text={s.err} />
    </Shell>
  );
}

function RenameDialog(p: SessionDialogsProps & { sessionId: string }): ReactElement {
  const tr = useT();
  const o = p.os.find(x => x.sessionId === p.sessionId) ?? p.list?.ended.find(x => x.sessionId === p.sessionId);
  const [title, setTitle] = useState(o?.title ?? '');
  const s = useSend(p.send);
  const go = () => s.run({ cmd: 'session_rename', sessionId: p.sessionId, title: title.trim() }, p.onClose);
  return (
    <Shell title={tr('session.renTitle', { n: o?.seq ?? '?' })} onClose={p.onClose} foot={<>
      <button className="btn" onClick={p.onClose}>{tr('common.cancel')}</button>
      <button className="btn pri" disabled={p.offline || s.busy} onClick={go}>{tr('common.save')}</button></>}>
      <label className="sfield"><span>{tr('session.renLabel')}</span>
        <input className="field" autoFocus maxLength={24} value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') go(); }} /></label>
      <Err text={s.err} />
    </Shell>
  );
}

/** N5-f/g/r + "Phiên mới từ #n": preview numbers, account + reason, parallel / replace [#n ▾] (cap → replace), ≥ 80 % swap. */
function ResumeDialog(p: SessionDialogsProps & { sessionId: string; from?: 'handoff' | 'tail' }): ReactElement {
  const tr = useT();
  const [pv, setPv] = useState<ResumePreview | null>(null);
  const [mode, setMode] = useState<'parallel' | 'replace'>('parallel'), [rep, setRep] = useState<string | null>(null), [acc, setAcc] = useState<string | null>(null);
  const [mp, setMp] = useState<Picks>(NO_PICK), [reopen, setReopen] = useState(0);
  const rows = useRows(p);
  const s = useStartRun(p.os, p.accounts, sid => started(p, sid));
  const l = useDlgModels(p.loadModels, pv?.projectId ?? null, acc);
  useEffect(() => {
    let live = true;
    void p.loadPreview(p.sessionId).then(x => {
      if (!live || !x) return;
      const d = resumeDefaults(x, p.prevSid, p.os);
      setPv(x); setMode(d.mode); setRep(d.replaceId); setAcc(x.account);
      setMp({ model: x.modelPick ?? null, effort: x.effortPick ?? null }); // §4.4 MD11 the old picks
    });
    return () => { live = false; };
  }, [p.sessionId]); // eslint-disable-line react-hooks/exhaustive-deps
  const row = p.list?.ended.find(r => r.sessionId === p.sessionId);
  const n = pv?.seq ?? row?.seq ?? '?';
  const close = <button className="btn" onClick={p.onClose}>{tr('common.cancel')}</button>;
  if (!pv) return <Shell title={tr('session.resTitle', { n })} onClose={p.onClose} foot={close}><p className="lead">{tr('session.loading')}</p></Shell>;
  const d = resumeDefaults(pv, p.prevSid, p.os), from = p.from ?? null;
  const info = runInfo(acc, NO_AUTO, modelText(l.models, mp)), what = tr('session.stWhatN', { n: from ? nextSeq(p.list, p.os) : n });
  const resume = () => s.begin(() => p.sendQuiet(resumeCmd(p.sessionId, { mode, replaceId: rep, account: acc, pvAccount: pv.account, ...mp })).then(sidOf), info, what);
  const fresh = (kind: 'handoff' | 'tail') => s.begin(() => p.sendQuiet(freshCmd(pv.projectId, p.sessionId, kind, { mode, replaceId: rep, account: acc, ...mp })).then(sidOf), info, what);
  if (s.run) return <StartProgress what={s.what} run={s.run} now={s.now} onClose={p.onClose} onRetry={s.retry}
    onOtherAccount={() => { s.reset(); setReopen(k => k + 1); }} onAccounts={p.onAccounts} />;
  const lock = p.offline;
  const ctxVal = pv.ctxLast != null ? tr('session.ctxVal', { tok: fmtTok(pv.ctxLast, tr), win: fmtTok(pv.ctxWindow, tr), pct: Math.round(pv.ctxPct ?? 0) }) : '—';
  const since = sinceText(tr, pv.sinceStop);
  const cant = !from && !pv.resumable ? reasonText(tr, tr('session.expired'), pv.reason) : null;
  const ended = row?.endedAt ?? null;
  const foot = from ? <>{close}<button className="btn pri" disabled={lock} onClick={() => fresh(from)}>{from === 'handoff' ? tr('session.fromHandoff', { n }) : tr('session.fromTail')}</button></>
    : d.main === 'handoff' ? <>{close}<button className="btn" disabled={lock || !pv.resumable} onClick={resume}>{tr('session.resAnyway')}</button>
      <button className="btn pri" disabled={lock} onClick={() => fresh('handoff')}>{tr('session.fromHandoff', { n })}</button></>
    : <>{close}<button className="btn pri" disabled={lock || !pv.resumable} onClick={resume}>{tr('session.resGo', { n })}</button></>;
  return (
    <Shell title={from ? tr('session.fromTitle', { n }) : tr('session.resTitle', { n })} onClose={p.onClose} foot={foot}>
      {from ? <p className="lead">{from === 'handoff' ? tr('session.fromLeadHandoff', { n }) : tr('session.fromLeadTail', { n })}</p>
        : ended ? <p className="lead mono">{tr('session.resLead', { when: fmtDayHm(ended, tr), ago: fmtLeft(p.now - ended, tr), how: row ? endHow(tr, row) : '—' })}</p> : null}
      {cant ? <Err text={cant} /> : null}
      {!from ? <dl className="kv">
        <dt>{tr('session.ctx')}</dt><dd className={pv.ctxHigh ? 'warn' : ''}>{pv.ctxHigh ? tr('session.ctxHigh', { val: ctxVal }) : ctxVal}</dd>
        <dt>{tr('session.first')}</dt><dd>{estimateText(tr, pv)}</dd>
        <dt>{tr('session.since')}</dt><dd>{since}</dd>
      </dl> : null}
      <AccountField key={reopen} startOpen={reopen > 0} value={acc} onPick={setAcc} rows={rows} auto={NO_AUTO} />
      {pv.accountReason ? <p className="note">{reasonText(tr, null, pv.accountReason)}</p> : null}
      <ModelRow l={l} v={mp} onPick={setMp} />
      <div className="schoice" role="radiogroup">
        <button type="button" role="radio" aria-checked={mode === 'parallel'} className={`choice${mode === 'parallel' ? ' def' : ''}`} disabled={d.parallelBlocked} onClick={() => setMode('parallel')}>
          <b>{tr('session.optPar')}</b><span>{d.parallelBlocked ? tr('errors.sessionCap') : tr('session.optParNote', { n, k: pv.running + 1, max: pv.max })}</span></button>
        {p.os.length ? <div role="radio" aria-checked={mode === 'replace'} tabIndex={0} className={`choice${mode === 'replace' ? ' def' : ''}`} onClick={() => setMode('replace')}>
          <b>{tr('session.optRep')} <span className="rsel"><select className="field" value={rep ?? ''} onClick={e => e.stopPropagation()} onChange={e => { setRep(e.target.value); setMode('replace'); }}>
            {p.os.map(o => <option key={o.sessionId ?? ''} value={o.sessionId ?? ''}>{label(tr, o)}</option>)}</select></span></b>
          <span>{from ? tr('session.optRepNoteNew') : tr('session.optRepNote', { n })}</span></div> : null}
      </div>
      {!from ? <p className="note">{tr('session.resNote', { n, ago: ended ? fmtLeft(p.now - ended, tr) : '—' })}</p> : null}
      {p.offline ? <StartWarn auto={null} offline /> : null}
    </Shell>
  );
}

/** v2.1 §4.15 §3 N5-o "Chạy tiếp lane…": context, first-turn estimate, account, worktree kept / rebuilt, receiving session. */
function LaneContinueDialog(p: SessionDialogsProps & { projectId: string; name: string }): ReactElement {
  const tr = useT();
  const [pv, setPv] = useState<LaneContinuePreview | null>(null), [acc, setAcc] = useState<string | null>(null);
  const lane = p.lanes.find(l => l.projectId === p.projectId && l.name === p.name), rows = useRows(p);
  const running = p.os.filter(o => o.sessionId);
  const [to, setTo] = useState<string>(running.find(o => o.sessionId === lane?.ownerSession)?.sessionId ?? running[0]?.sessionId ?? '');
  const s = useSend(p.send);
  useEffect(() => {
    let live = true;
    p.send({ cmd: 'lane_continue_preview', projectId: p.projectId, name: p.name }).then(r => { if (live) { setPv(r as LaneContinuePreview); setAcc((r as LaneContinuePreview).account); } }, () => {});
    return () => { live = false; };
  }, [p.projectId, p.name]); // eslint-disable-line react-hooks/exhaustive-deps
  const title = tr('done.cTitle', { name: p.name });
  const close = <button className="btn" onClick={p.onClose}>{tr('common.cancel')}</button>;
  if (!pv) return <Shell title={title} onClose={p.onClose} foot={close}><p className="lead">{tr('session.loading')}</p></Shell>;
  const toO = running.find(o => o.sessionId === to), toName = toO ? label(tr, toO) : '—';
  const path = lane?.cwd ?? p.name;
  const go = () => s.run({ cmd: 'lane_continue', projectId: p.projectId, name: p.name, toSession: to, ...(acc && acc !== pv.account ? { account: acc } : {}) }, () => p.onClose());
  const foot = <>{close}<button className="btn pri" disabled={p.offline || s.busy || !pv.resumable || !to} onClick={go}>{tr('done.cGo', { name: p.name })}</button></>;
  return (
    <Shell title={title} onClose={p.onClose} foot={foot}>
      {!pv.resumable ? <Err text={reasonText(tr, tr('session.expired'), pv.reason)} /> : null}
      <dl className="kv">
        <dt>{tr('session.ctx')}</dt><dd>{pv.ctxLast != null ? fmtTok(pv.ctxLast, tr) : '—'}</dd>
        <dt>{tr('session.first')}</dt><dd>{estimateText(tr, pv)}</dd>
        <dt>{tr('done.cWorktree')}</dt><dd className={pv.worktreeExists ? '' : 'warn'}>{pv.worktreeExists ? tr('done.cWtKeep', { path }) : tr('done.cWtRebuild', { path, branch: pv.branch ?? '—' })}</dd>
      </dl>
      <AccountField value={acc} onPick={setAcc} rows={rows} auto={NO_AUTO} />
      <label className="sfield"><span>{tr('done.cTo')}</span>
        {running.length > 1 ? <select className="field" value={to} onChange={e => setTo(e.target.value)}>
          {running.map(o => <option key={o.sessionId ?? ''} value={o.sessionId ?? ''}>{label(tr, o)}</option>)}</select>
          : <b>{tr('done.cOnly', { s: toName })}</b>}
      </label>
      <p className="note">{tr('done.cNote', { name: p.name, s: toName })}</p>
      <Err text={s.err} />
    </Shell>
  );
}

export function SessionDialogs(p: SessionDialogsProps): ReactElement {
  const d = p.dlg;
  return d.k === 'start' ? <StartDialog {...p} req={d.req} />
    : d.k === 'parallel' ? <ParallelDialog {...p} projectId={d.projectId} />
    : d.k === 'end' ? <EndDialog {...p} sessionId={d.sessionId} />
    : d.k === 'rename' ? <RenameDialog {...p} sessionId={d.sessionId} />
    : d.k === 'laneContinue' ? <LaneContinueDialog {...p} projectId={d.projectId} name={d.name} />
    : <ResumeDialog {...p} sessionId={d.sessionId} {...(d.from ? { from: d.from } : {})} />;
}
