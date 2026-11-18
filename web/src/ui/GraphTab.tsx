// v2.5 §6 the Graph code tab of the Skills & MCP sheet (Mac only): GR1 head (version · newer / latest · checked at + Kiểm tra),
// summary, one row per project (status · one plain button · Lane dùng switch), the last line (indexes on the Mac + Dọn…), and the
// tab's other states — GR0 / GR0-old (one job, one primary button), GR-run, GR-err / GR-err-upd bands, GR-empty. The dialogs
// GR-upd / GR-clean live in GraphDialogs.tsx and stack over the sheet (SkillsMcp.tsx owns them, so Esc closes them first).
import { useEffect, useState, type ReactElement } from 'react';
import { below, GRAPH_NAME, MIN_GRAPH_VERSION, type GraphProjectView, type GraphRunView, type GraphToolView, type GraphView } from '../../../shared/graph.ts';
import type { Command } from '../../../shared/protocol.ts';
import { tildePath } from '../lib/account-ui.ts';
import { fmtHm } from '../lib/format.ts';
import { code, fmtSize, graphMode, lastLine, rowStatus, subLine, summary, type RowAct, type RowStatus } from '../lib/graph.ts';
import { errText, useT } from '../lib/i18n.tsx';
import { Rich, WillRun } from './GraphDialogs.tsx';
import { Icon, type IconName } from './icons.tsx';
import './skillsMcp.css';

type Send = (c: Command) => Promise<unknown>;
const SRC = 'github.com/DeusData/codebase-memory-mcp';
const ST_ICON: Record<RowStatus['cls'], IconName | null> = { ok: 'circleCheck', na: null, old: 'history', bad: 'alert', run: null, q: 'clock', off: 'ban' };
const ACT: Record<RowAct, { i: IconName; k: 'graph.act.index' | 'graph.act.reindex' | 'graph.act.retry' | 'graph.act.stop' }> = {
  index: { i: 'play', k: 'graph.act.index' }, reindex: { i: 'refresh', k: 'graph.act.reindex' }, retry: { i: 'refresh', k: 'graph.act.retry' }, stop: { i: 'stop', k: 'graph.act.stop' },
};

/** A command with its own spinner until the engine answers (≤ 100 ms feedback); errors become a toast. */
function useRun(send: Send, toast: (t: string) => void): [ReadonlySet<string>, (key: string, c: Command) => void] {
  const tr = useT();
  const [pend, setPend] = useState<ReadonlySet<string>>(new Set());
  const run = (key: string, c: Command) => {
    setPend(s => new Set(s).add(key));
    void send(c).catch((e: unknown) => toast(errText(tr, e))).finally(() => setPend(s => { const n = new Set(s); n.delete(key); return n; }));
  };
  return [pend, run];
}

/** Ticks every second while a project is indexing (its "0:12" clock). */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

/** The first `n` in `text` bold (the summary numbers). */
const Num = ({ text, n }: { text: string; n: string }): ReactElement => {
  const i = text.indexOf(n);
  return i < 0 ? <span>{text}</span> : <span>{text.slice(0, i)}<b>{n}</b>{text.slice(i + n.length)}</span>;
};
const Btn = ({ i, label, on, busy = false, pri = false, off = false }: { i: IconName; label: string; on: () => void; busy?: boolean; pri?: boolean; off?: boolean }): ReactElement =>
  <button className={`btn${pri ? ' pri' : ''}`} disabled={busy || off} onClick={on}>{busy ? <span className="spin sm" aria-hidden="true" /> : <Icon n={i} s={14} />} {label}</button>;

/** GR1 / GR1-new head; GR-err: name + version only. */
function Head({ t, checking, check, onUpdate, off }: { t: GraphToolView; checking: boolean; check: () => void; onUpdate: () => void; off: boolean }): ReactElement {
  const tr = useT();
  const plain = t.state === 'error';
  const newer = t.latest !== undefined && t.version !== undefined && below(t.version, t.latest);
  const parts = plain ? [] : [
    t.checkError ? (t.checkError.code === 'offline' ? tr('graph.head.offline') : tr('graph.head.checkErr', { line: t.checkError.line }))
      : newer ? tr('graph.head.newer', { v: t.latest! }) : t.latest ? tr('graph.head.latest') : checking ? tr('graph.head.checking') : '',
    t.checkedAt !== undefined ? tr('graph.head.checkedAt', { t: fmtHm(t.checkedAt) }) : '',
  ].filter(Boolean);
  return (
    <div className="grh">
      <div className="grh1"><code className="nm">{GRAPH_NAME} {t.version}</code>{parts.map((s, i) => <span key={i} className={i === 0 && newer ? 'nw' : ''}>{s}</span>)}</div>
      <div className="grh2">{tr('graph.head.via')}</div>
      {plain ? null : <div className="grha">
        {newer && !t.failed ? <Btn i="refresh" label={tr('graph.act.update')} on={onUpdate} off={off} /> : null}
        <Btn i="refresh" label={tr('graph.act.check')} on={check} busy={checking} off={off} />
      </div>}
    </div>
  );
}

function Row({ p, all, now, noAct, off, busy, act, toggle }: {
  p: GraphProjectView; all: readonly GraphProjectView[]; now: number; noAct: boolean; off: boolean; busy: boolean;
  act: (a: RowAct) => void; toggle: () => void;
}): ReactElement {
  const tr = useT();
  const s = rowStatus(tr, p, all, now);
  const icon = ST_ICON[s.cls];
  const sub = subLine(tr, p);
  const a = noAct || !s.act ? null : ACT[s.act];
  return (
    <div className={`grr st-${s.cls}`} data-project={p.name}>
      <code className="nm">{p.name}</code>
      <div className={`grs st ${s.cls}`} role="status">
        {s.cls === 'run' ? <span className="spin sm" aria-hidden="true" /> : icon ? <Icon n={icon} s={16} /> : <span className="dash" aria-hidden="true" />}
        <span className="tx"><Rich text={s.text} />{s.metrics ? <span className="gm"> · {s.metrics}</span> : null}</span>
      </div>
      <div className="gra">{a ? <Btn i={a.i} label={tr(a.k)} on={() => act(s.act!)} busy={busy} off={off} /> : null}</div>
      <button className={`sw ${p.on ? 'on' : ''}`} role="switch" aria-checked={p.on} aria-label={tr('graph.switchAria', { name: p.name })} disabled={noAct || off} onClick={toggle}><i /></button>
      {s.metrics || s.old || sub.length ? <div className="grsub">
        {s.metrics ? <span className="gm2">{s.metrics}</span> : null}{s.old ? <span className="old">{s.old}</span> : null}{sub.map((x, i) => <span key={i}>{x}</span>)}
      </div> : null}
    </div>
  );
}

/** GR1 summary, column heads and rows; `noAct` = GR-err / GR-run (read-only, muted). */
function ProjectList({ view, noAct, off, now, pend, run, onProjects }: {
  view: GraphView; noAct: boolean; off: boolean; now: number; pend: ReadonlySet<string>; run: (key: string, c: Command) => void; onProjects: () => void;
}): ReactElement {
  const tr = useT();
  const s = summary(view.projects);
  const n = String(s.n), ix = String(s.indexed);
  return (
    <div className={noAct ? 'grdim' : ''}>
      <div className="grsum"><Num text={tr('graph.sum.projects', { n: s.n })} n={n} />{s.n ? <><Num text={tr('graph.sum.indexed', { n: s.indexed })} n={ix} />
        <span>{tr('graph.sum.bytes', { size: fmtSize(tr, s.bytes) })}</span></> : null}</div>
      {s.n ? null : <div className="grempty"><Icon n="folder" s={16} /><b>{tr('graph.empty')} <button className="lnk" onClick={onProjects}>{tr('graph.emptyLink')}</button></b></div>}
      {s.n ? <div className="grcols" aria-hidden="true"><span>{tr('graph.col.project')}</span><span>{tr('graph.col.index')}</span><span /><span>{tr('graph.col.lanes')}</span></div> : null}
      {view.projects.map(p => <Row key={p.projectId} p={p} all={view.projects} now={now} noAct={noAct} off={off} busy={pend.has(p.projectId)}
        act={a => run(p.projectId, a === 'stop' ? { cmd: 'graph_index_stop', projectId: p.projectId } : { cmd: 'graph_index', projectId: p.projectId })}
        toggle={() => run(`sw:${p.projectId}`, { cmd: 'graph_toggle', projectId: p.projectId, on: !p.on })} />)}
    </div>
  );
}

/** §6.1 GR1 last line + GR-clean-run / -done / -fail. */
function LastLine({ t, onClean, run, pend, off }: { t: GraphToolView; onClean: () => void; run: (key: string, c: Command) => void; pend: ReadonlySet<string>; off: boolean }): ReactElement | null {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const l = lastLine(tr, t);
  if (!l) return null;
  const roots = t.clean?.failedRoots ?? [];
  return <>
    <div className={`grlast k-${l.k}`} role="status">
      {l.k === 'run' ? <span className="spin sm" aria-hidden="true" /> : l.k === 'done' ? <Icon n="circleCheck" s={16} /> : l.k === 'fail' || l.k === 'err' ? <Icon n="alert" s={16} /> : null}
      <span className="tx">{l.text}</span>
      {l.k === 'orph' ? <Btn i="trash" label={tr('graph.act.clean')} on={onClean} off={off} /> : null}
      {l.k === 'fail' ? <button className="btn" aria-expanded={open} onClick={() => setOpen(v => !v)}><Icon n="eye" s={14} /> {tr('graph.act.view')}</button> : null}
      {l.k === 'fail' ? <Btn i="refresh" label={tr('graph.act.retry')} on={() => run('clean', { cmd: 'graph_clean', roots })} busy={pend.has('clean')} off={off} /> : null}
      {l.k === 'err' ? <Btn i="refresh" label={tr('graph.act.retry')} on={onClean} off={off} /> : null}
    </div>
    {open && l.k === 'fail' ? <pre className="tklog">{roots.map(tildePath).join('\n')}</pre> : null}
  </>;
}

/** §6.1 GR-run: title, the four steps, the installer's last lines. */
function RunHead({ r }: { r: GraphRunView }): ReactElement {
  const tr = useT();
  const v = r.kind === 'update' ? `${r.from ?? ''} → ${r.to ?? '…'}` : r.to ?? '';
  const steps = ['graph.run.s1', 'graph.run.s2', 'graph.run.s3', 'graph.run.s4'] as const;
  return (
    <div className="grrun">
      <h3><Rich text={tr(r.kind === 'update' ? 'graph.run.update' : 'graph.run.install', { tool: GRAPH_NAME, v: code(v) })} /></h3>
      <ol className="k3steps">{steps.map((k, i) => {
        const st = i + 1 < r.step ? 'ok' : i + 1 === r.step ? 'cur' : 'todo';
        return <li key={k} className={`st-${st}`}>{st === 'ok' ? <Icon n="check" s={14} /> : st === 'cur' ? <span className="spin sm" aria-hidden="true" /> : <span className="todo" aria-hidden="true" />}{tr(k)}</li>;
      })}</ol>
      {r.log.length ? <pre className="tklog">{r.log.slice(-4).join('\n')}</pre> : null}
    </div>
  );
}

/** GR-err (front down) / GR-err-upd (the last run failed): a red band with Thử lại + Xem log. */
function ErrBand({ t, run, pend, off }: { t: GraphToolView; run: (key: string, c: Command) => void; pend: ReadonlySet<string>; off: boolean }): ReactElement | null {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const f = t.failed;
  if (t.run || (!f && !(t.state === 'error' && t.error))) return null;
  const text = f ? (f.kind === 'update' ? tr('graph.err.update', { line: code(f.line), v: t.version ?? '' }) : tr('graph.err.install', { line: code(f.line) }))
    : tr('graph.err.start', { tool: code(GRAPH_NAME), cause: t.error ?? '' });
  const retry: Command = f ? { cmd: f.kind === 'update' ? 'graph_update' : 'graph_install' } : { cmd: 'graph_retry' };
  return <>
    <div className="band bad grband" role="alert"><Icon n="octAlert" s={14} /><span><Rich text={text} /></span>
      <Btn i="refresh" label={tr('graph.act.retry')} on={() => run('retry', retry)} busy={pend.has('retry')} off={off} />
      {t.log?.length ? <button className="btn" aria-expanded={open} onClick={() => setOpen(v => !v)}><Icon n="file" s={14} /> {tr('graph.act.log')}</button> : null}
    </div>
    {open && t.log ? <pre className="tklog grlog">{t.log.join('\n')}</pre> : null}
  </>;
}

/** GR0 (missing) / GR0-old: the one job of the tab, one primary button (none while the failed band offers Thử lại). */
function Setup({ t, old, run, pend, onUpdate, off }: { t: GraphToolView; old: boolean; run: (key: string, c: Command) => void; pend: ReadonlySet<string>; onUpdate: () => void; off: boolean }): ReactElement {
  const tr = useT();
  return (
    <div className="gr0">
      {old ? <>
        <b>{tr('graph.old.title', { v: t.version ?? '', need: MIN_GRAPH_VERSION })}</b>
        <span>{tr('graph.old.body')}</span>
        {t.path ? <code className="pth">{tildePath(t.path)}</code> : null}
        {t.failed ? null : <span className="act"><Btn pri i="refresh" label={tr('graph.act.update')} on={onUpdate} off={off} /></span>}
      </> : <>
        <b><Rich text={tr('graph.g0.title', { tool: code(GRAPH_NAME) })} /></b>
        <span>{tr('toolkit.item.graph.what')}</span>
        <span className="mt"><code>{SRC}</code> · {tr('graph.g0.meta', { v: t.latest ?? MIN_GRAPH_VERSION })}</span>
        {t.command ? <WillRun command={t.command} /> : null}
        {t.failed ? null : <span className="act"><Btn pri i="dl" label={tr('graph.act.install')} on={() => run('install', { cmd: 'graph_install' })} busy={pend.has('install')} off={off} /></span>}
      </>}
    </div>
  );
}

export interface GraphTabProps {
  view: GraphView | undefined; connected: boolean; send: Send; toast: (t: string) => void;
  /** "Cập nhật…" → GR-upd; "Dọn…" → GR-clean (dialogs of the sheet). */
  onUpdate: () => void; onClean: () => void;
  /** GR-empty "Cài đặt › Project". */
  onProjects: () => void;
}

/** §6.1 the tab: opening it runs `graph_check` (a check < 60 s old is reused); "Kiểm tra" forces one. */
export function GraphTab(p: GraphTabProps): ReactElement {
  const tr = useT();
  const [checking, setChecking] = useState(true);
  const check = (force: boolean) => {
    setChecking(true);
    void p.send({ cmd: 'graph_check', ...(force ? { force } : {}) }).catch((e: unknown) => p.toast(errText(tr, e))).finally(() => setChecking(false));
  };
  useEffect(() => { check(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once per open
  const [pend, run] = useRun(p.send, p.toast);
  const now = useNow(p.view?.projects.some(x => x.state === 'running') ?? false);
  const off = !p.connected;
  if (!p.view) return <div className="grtab"><p className="smload" role="status"><span className="spin sm" aria-hidden="true" />{tr('graph.loading')}</p></div>;
  const v = p.view, t = v.tool, mode = graphMode(t);
  return (
    <div className="grtab">
      {off ? <div className="band bad" role="status"><Icon n="wifi" s={14} />{tr('skillsMcp.engineLost')}</div> : null}
      <ErrBand t={t} run={run} pend={pend} off={off} />
      {mode === 'run' && t.run ? <RunHead r={t.run} />
        : mode === 'missing' || mode === 'old' ? <Setup t={t} old={mode === 'old'} run={run} pend={pend} onUpdate={p.onUpdate} off={off} />
        : <Head t={t} checking={checking} check={() => check(true)} onUpdate={p.onUpdate} off={off} />}
      {mode === 'list' || (mode === 'run' && v.projects.length) ? <ProjectList view={v} noAct={mode === 'run' || t.state === 'error'} off={off} now={now} pend={pend} run={run} onProjects={p.onProjects} /> : null}
      {mode === 'list' && t.state !== 'error' ? <LastLine t={t} onClean={p.onClean} run={run} pend={pend} off={off} /> : null}
    </div>
  );
}
