// v2.5 §6 TK2 the Bộ công cụ tab of the Skills & MCP sheet and TK1 the wizard step 3 (both in this lazy chunk: the wizard
// loads it when step 3 opens, with the `toolkit` catalog). `ToolkitList` is the one list component of both: in the wizard a
// missing row gets a tick (D70) instead of "Cài". Row buttons are plain buttons (§6 "Nút"); the status column has a fixed width
// so the table does not shift between states.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { Key } from '../../../shared/i18n/core.ts';
import { loadLazyNs } from '../../../shared/i18n/lazy.ts';
import type { Command, ProjectView, SkillsMcpView } from '../../../shared/protocol.ts';
import type { ToolkitKey, ToolkitView } from '../../../shared/toolkit.ts';
import { fmtClock, fmtHm } from '../lib/format.ts';
import { GRAPH_NAME, type GraphToolView } from '../../../shared/graph.ts';
import { chip, code } from '../lib/graph.ts';
import { errText, useT } from '../lib/i18n.tsx';
import { rowSourcePath } from '../lib/skills-mcp-sheet.ts';
import { installCommands, logTail, pickable, pickedKeys, rowAction, shownRows, statusLook, statusText, stepFoot, stepNote, summaryText, type TkMcp, type TkRowShown, type TkShown } from '../lib/toolkit.ts';
import { GraphUpdateDialog, Rich } from './GraphDialogs.tsx';
import { Icon, type IconName } from './icons.tsx';
import { McpLoginDialog } from './SkillsMcpLogin.tsx';
import './skillsMcp.css';

loadLazyNs(); // §6A the `toolkit` (+ sheet) catalogs ship with this chunk; the wizard step 3 reaches it without the sheet

type TkAct = { t: 'install' | 'update'; key: ToolkitKey } | { t: 'login'; id: string } | { t: 'graphUpdate' };

const ST: Record<TkShown | 'graphOld' | 'offLanes', { i: IconName | null; cls: string }> = {
  missing: { i: null, cls: 'na' }, installed: { i: 'circleCheck', cls: 'ok' }, outdated: { i: 'circleArrowUp', cls: 'warn' },
  disabled: { i: 'ban', cls: 'na' }, needs_login: { i: 'key', cls: 'bad' }, running: { i: null, cls: 'run' },
  waiting: { i: 'clock', cls: 'na' }, failed: { i: 'alert', cls: 'bad' }, git: { i: 'alert', cls: 'warn' },
  graphOld: { i: 'alert', cls: 'warn one' }, offLanes: { i: 'ban', cls: 'na' },
};
/** §6 TK1 the size hint, only where it is large ("156 MB"; catalog text, §5.1). */
const SIZE: Partial<Record<ToolkitKey, Key>> = { vercel: 'toolkit.item.vercel.size', graph: 'toolkit.item.graph.size' };
/** The catalog path of an item (catalog keys are `<ns>.<camelCase path>`, no hyphen). */
const ITEM = { superpowers: 'superpowers', 'ui-ux-pro-max': 'uiUxProMax', context7: 'context7', vercel: 'vercel', graph: 'graph' } as const satisfies Record<ToolkitKey, string>;
const LICENSE_CMD = 'sudo xcodebuild -license';

/** The busy row's elapsed time "0:08" (TK1-run), counted from the moment the web first saw it busy. */
function useBusyClock(busy: ToolkitKey | undefined): string | null {
  const since = useRef<{ key: ToolkitKey; at: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  if (busy === undefined) since.current = null;
  else if (since.current?.key !== busy) since.current = { key: busy, at: Date.now() };
  useEffect(() => {
    if (busy === undefined) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [busy]);
  return since.current ? fmtClock(Math.max(0, now - since.current.at)) : null;
}

/** Wizard mode (TK1): a missing row shows a tick in place of "Cài" (D70). */
interface TkPick { ticked: (k: ToolkitKey) => boolean; toggle: (k: ToolkitKey) => void }

/** `onGraph`: TK2 the graph tool row's "Mở Graph code" (the tab only, not the wizard step). */
/** `off`: engine lost (§6 *-lost) → every button dimmed. */
/** `pend`: this row's install / update was sent and has no ack yet → its button is disabled and spins (≤ 100 ms feedback). */
function TkRow({ s, act, clock, checking, pick, onGraph, off, pend }: { s: TkRowShown; act: (a: TkAct) => void; clock: string | null; checking: boolean; pick: TkPick | null; onGraph: (() => void) | undefined; off: boolean; pend: boolean }): ReactElement {
  const tr = useT();
  const [logOpen, setLogOpen] = useState(false); // TK1-fail: the log starts closed
  const { row } = s;
  const name = row.kind === 'graph' ? GRAPH_NAME : (row.id ?? row.key).split('@')[0];
  const size = SIZE[row.key];
  const a = pick && pickable(s) ? null : rowAction(s);
  const st = ST[statusLook(s)];
  const log = logTail(row);
  const showLog = s.shown === 'running' || (s.shown === 'failed' && logOpen);
  const btn = (i: IconName, label: string, on: () => void, busy = false) =>
    <button className="btn" disabled={off || busy} onClick={on}>{busy ? <span className="spin sm" aria-hidden="true" /> : <Icon n={i} s={14} />} {label}</button>;
  return (
    <div className={`tkr st-${s.shown}`} data-key={row.key}>
      {pick ? <div className="tkp">{checking ? null : pickable(s) ? <input type="checkbox" aria-label={name} checked={pick.ticked(row.key)} onChange={() => pick.toggle(row.key)} />
        : s.shown === 'git' ? <input type="checkbox" aria-label={name} checked={false} disabled readOnly /> : null}</div> : null}
      <div className="tkn">
        <code className="nm">{name}</code><code className="src">{tr(`toolkit.item.${ITEM[row.key]}.src`)}</code>{size ? <span className="sz">{tr(size)}</span> : null}
        <span className="what">{tr(`toolkit.item.${ITEM[row.key]}.what`)}</span>
      </div>
      {checking ? <div className="tks"><span className="tkskel" aria-hidden="true" /></div> : (
        <div className={`tks st ${st.cls}`} role="status">
          {s.shown === 'running' ? <span className="spin sm" aria-hidden="true" /> : st.i ? <Icon n={st.i} s={16} /> : <span className="dash" aria-hidden="true" />}
          <span className="tx"><Rich text={statusText(tr, s)} />{s.shown === 'running' && clock ? ` ${clock}` : ''}</span>
        </div>
      )}
      <div className="tka">
        {a === 'install' ? btn('dl', tr('toolkit.act.install'), () => act({ t: 'install', key: row.key }), pend)
          : a === 'update' ? btn('refresh', tr('toolkit.act.update'), () => act({ t: 'update', key: row.key }), pend)
          : a === 'graphUpdate' ? btn('refresh', tr('graph.act.update'), () => act({ t: 'graphUpdate' }))
          : a === 'login' && s.loginIds[0] ? btn('logIn', tr('toolkit.act.login'), () => act({ t: 'login', id: s.loginIds[0]! }))
          : a === 'retryInstall' ? btn('refresh', tr('toolkit.act.retry'), () => act({ t: 'install', key: row.key }), pend)
          : a === 'retryUpdate' ? btn('refresh', tr('toolkit.act.retry'), () => act({ t: 'update', key: row.key }), pend)
          : null}
        {row.kind === 'graph' && onGraph ? btn('db', tr('toolkit.act.openGraph'), onGraph) : null}
        {s.shown === 'failed' && log.length ? <button className="btn" disabled={off} aria-expanded={logOpen} onClick={() => setLogOpen(o => !o)}><Icon n="file" s={14} /> {tr('toolkit.act.log')}</button> : null}
      </div>
      {showLog && log.length ? <pre className="tklog">{log.join('\n')}</pre> : null}
    </div>
  );
}

/** §6 the list: column heads "Mục / Trạng thái", one row per item. `checking` = TK1-chk (a bar in place of each state). */
function ToolkitList({ rows, busy, act, pend, checking, pick = null, onGraph, off = false }: { rows: readonly TkRowShown[]; busy: ToolkitKey | undefined; act: (a: TkAct) => void; pend: ReadonlySet<ToolkitKey>; checking: boolean; pick?: TkPick | null; onGraph?: () => void; off?: boolean }): ReactElement {
  const tr = useT();
  const clock = useBusyClock(busy);
  return (
    <div className={`tklist${pick ? ' tkpick' : ''}`}>
      <div className="tkcols" aria-hidden="true">{pick ? <span /> : null}<span>{tr('toolkit.col.item')}</span><span>{tr('toolkit.col.status')}</span><span /></div>
      {rows.map(s => <TkRow key={s.row.key} s={s} act={act} clock={clock} checking={checking} pick={pick} onGraph={onGraph} off={off} pend={pend.has(s.row.key)} />)}
    </div>
  );
}

/** The bands above the list (tab and wizard step): engine lost, check error (TK1-off / -off-err), git (TK1-git / -git-lic). */
function TkBands({ view, rows, connected, checking, check, send, toast }: {
  view: ToolkitView; rows: readonly TkRowShown[]; connected: boolean; checking: boolean; check: (force: boolean) => void;
  send: (c: Command) => Promise<unknown>; toast: (t: string) => void;
}): ReactElement {
  const tr = useT();
  const git = rows.find(s => s.shown === 'git')?.row.error;
  const ce = view.checkError;
  const recheck = <button className="btn" onClick={() => check(true)} disabled={checking || !connected}><Icon n="refresh" s={14} /> {tr('toolkit.act.recheck')}</button>;
  return <>
    {!connected ? <div className="band bad" role="status"><Icon n="wifi" s={14} />{tr('skillsMcp.engineLost')}</div> : null}
    {ce ? <div className="band warn" role="status"><Icon n="wifi" s={14} /><span>{ce.code === 'offline'
      ? view.checkedAt !== undefined ? tr('toolkit.band.offline', { t: fmtHm(view.checkedAt) }) : tr('toolkit.band.offlineNever')
      : <Rich text={tr('toolkit.band.unknown', { line: code(ce.line) })} />}</span>{recheck}</div> : null}
    {git ? <div className="band warn" role="status"><Icon n="alert" s={14} /><span>{git.code === 'git_missing' ? tr('toolkit.git.missing')
      : git.code === 'git_license' ? <Rich text={tr('toolkit.git.license', { cmd: chip(LICENSE_CMD) })} /> : tr('toolkit.git.error', { detail: git.line })}</span>
      {git.code === 'git_missing' ? <button className="btn" onClick={() => void send({ cmd: 'git_install' }).catch((e: unknown) => toast(errText(tr, e)))}><Icon n="dl" s={14} /> {tr('toolkit.act.installGit')}</button> : null}
      {git.code === 'git_license' ? <button className="btn" onClick={() => void navigator.clipboard?.writeText(LICENSE_CMD).then(() => toast(tr('toolkit.copied')))}><Icon n="copy" s={14} /> {tr('toolkit.act.copyCmd')}</button> : null}
      {recheck}</div> : null}
  </>;
}

/** Opening the tab / the step runs `toolkit_check` (a check < 60 s old is reused); `check(true)` forces one. */
function useToolkitCheck(send: (c: Command) => Promise<unknown>, toast: (t: string) => void): [boolean, (force: boolean) => void] {
  const tr = useT();
  const [checking, setChecking] = useState(true); // the open check starts at mount: TK1-chk from the first paint
  const check = (force: boolean) => {
    setChecking(true);
    void send({ cmd: 'toolkit_check', ...(force ? { force } : {}) }).catch((e: unknown) => toast(errText(tr, e))).finally(() => setChecking(false));
  };
  useEffect(() => { check(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once per open
  return [checking, check];
}

/** The row spins from the click (a local pending key) until the ack, which already carries the row `running` (e2e v25-toolkit). */
function useRowAct(send: (c: Command) => Promise<unknown>, toast: (t: string) => void, onLogin: (id: string) => void, onGraphUpdate: () => void): [ReadonlySet<ToolkitKey>, (a: TkAct) => void] {
  const tr = useT();
  const [pend, setPend] = useState<ReadonlySet<ToolkitKey>>(new Set());
  const act = (a: TkAct) => {
    if (a.t === 'login') return onLogin(a.id);
    if (a.t === 'graphUpdate') return onGraphUpdate();
    const key = a.key;
    setPend(p => new Set(p).add(key));
    void send(a.t === 'install' ? { cmd: 'toolkit_install', keys: [key] } : { cmd: 'toolkit_update', key }).catch((e: unknown) => toast(errText(tr, e)))
      .finally(() => setPend(p => { const n = new Set(p); n.delete(key); return n; }));
  };
  return [pend, act];
}

interface ToolkitTabProps {
  view: ToolkitView | undefined; mcp: readonly TkMcp[] | null; connected: boolean;
  send: (c: Command) => Promise<unknown>; toast: (t: string) => void;
  /** "Đăng nhập" → K3 of that MCP id (the sheet's login dialog). */
  onLogin: (id: string) => void;
  /** TK2 "Mở Graph code" on the graph tool row → the Graph code tab. */
  onGraph: () => void;
  /** The graph tool row's "Cập nhật…" → GR-upd (the sheet's dialog). */
  onGraphUpdate: () => void;
}

/** §6 TK2: summary + "Kiểm tra", the bands, the list. */
export function ToolkitTab(p: ToolkitTabProps): ReactElement {
  const tr = useT();
  const [checking, check] = useToolkitCheck(p.send, p.toast);
  const [pend, act] = useRowAct(p.send, p.toast, p.onLogin, p.onGraphUpdate);
  const view = p.view;
  if (!view) return <div className="tktab"><p className="smload"><span className="spin sm" aria-hidden="true" />{tr('toolkit.checking')}</p></div>;
  const rows = shownRows(view, p.mcp);
  const firstCheck = checking && view.checkedAt === undefined && !view.checkError;
  return (
    <div className="tktab">
      <TkBands view={view} rows={rows} connected={p.connected} checking={checking} check={check} send={p.send} toast={p.toast} />
      <div className="smsum">
        <span>{firstCheck ? tr('toolkit.checking') : summaryText(tr, rows, view.checkedAt)}</span>
        <button className="btn" onClick={() => check(true)} disabled={checking || !p.connected}>{checking ? <span className="spin sm" aria-hidden="true" /> : <Icon n="refresh" s={14} />} {tr('toolkit.act.check')}</button>
      </div>
      <ToolkitList rows={rows} busy={view.busy} act={act} pend={pend} checking={firstCheck} onGraph={p.onGraph} off={!p.connected} />
    </div>
  );
}

export interface ToolkitStepProps {
  view: ToolkitView | undefined; mcpView: SkillsMcpView | undefined; projects: readonly ProjectView[];
  /** The graph tool (TK1-mix "Cập nhật…" → GR-upd over the wizard). */
  graph: GraphToolView | undefined;
  send: (c: Command) => Promise<unknown>; toast: (t: string) => void;
  onBack: () => void;
  /** "Tiếp" and "Để sau": installs keep running in the engine (TK1-run note). */
  onNext: () => void;
}

/** §6 TK1 the wizard step 3 below its title: bands, the list with ticks, "Sẽ chạy", the note, the foot; K3 over the wizard. */
export function ToolkitStep(p: ToolkitStepProps): ReactElement {
  const tr = useT();
  const [checking, check] = useToolkitCheck(p.send, p.toast);
  const [unticked, setUnticked] = useState<ReadonlySet<ToolkitKey>>(new Set());
  const [cmdOpen, setCmdOpen] = useState(false);
  const [login, setLogin] = useState<string | null>(null);
  const [grUpd, setGrUpd] = useState(false);
  const [sending, setSending] = useState(false); // the click spins at once; the ack brings the rows `running`
  const [pend, act] = useRowAct(p.send, p.toast, setLogin, () => setGrUpd(true));
  const view = p.view;
  const rows = view ? shownRows(view, p.mcpView?.mcp.rows ?? null) : [];
  const firstCheck = !view || (checking && view.checkedAt === undefined && !view.checkError);
  const foot = firstCheck ? 'pick' : stepFoot(rows);
  const keys = pickedKeys(rows, unticked);
  const offline = view?.checkError?.code === 'offline';
  const note = firstCheck ? null : stepNote(rows);
  const pick: TkPick = { ticked: k => !unticked.has(k), toggle: k => setUnticked(u => { const n = new Set(u); if (!n.delete(k)) n.add(k); return n; }) };
  const install = () => {
    setSending(true);
    void p.send({ cmd: 'toolkit_install', keys }).catch((e: unknown) => p.toast(errText(tr, e))).finally(() => setSending(false));
  };
  const cmds = installCommands(rows, keys);
  const loginRow = login ? p.mcpView?.mcp.rows.find(r => r.id === login) : undefined;
  return <>
    {firstCheck ? <p className="tkwait"><span className="spin sm" aria-hidden="true" />{tr('wizard.tk.checking')}</p> : null}
    {view ? <TkBands view={view} rows={rows} connected checking={checking} check={check} send={p.send} toast={p.toast} /> : null}
    {note?.k === 'all' ? <p className="tkall st ok" role="status"><Icon n="circleCheck" s={16} />{tr('toolkit.wiz.all', { n: note.n })}</p> : null}
    {view ? <ToolkitList rows={rows} busy={view.busy} act={act} pend={pend} checking={firstCheck} pick={foot === 'pick' ? pick : null} /> : null}
    {foot === 'pick' && cmds.length ? <div className="tkcmd">
      <button className="lnk" aria-expanded={cmdOpen} onClick={() => setCmdOpen(o => !o)}><Icon n={cmdOpen ? 'chev' : 'chevR'} s={14} /> {tr('toolkit.wiz.willRun')}
        {cmdOpen ? null : <> <Rich text={[keys.some(k => k !== 'graph') ? code('claude plugin install …') : null,
          keys.includes('graph') ? tr('toolkit.wiz.graphInstaller', { tool: code(GRAPH_NAME) }) : null].filter(x => x !== null).join(' · ')} /></>}</button>
      {cmdOpen ? <pre className="tklog">{cmds.map(c => `$ ${c}`).join('\n')}</pre> : null}
    </div> : null}
    {note?.k === 'run' || note?.k === 'login' ? <p className="tknote">{tr(note.k === 'run' ? 'toolkit.wiz.runNote' : 'toolkit.wiz.loginNote')}</p> : null}
    <div className="mf">{foot === 'pick' ? <>
      <button className="btn" onClick={p.onBack}>{tr('common.back')}</button>
      <button className="btn" onClick={p.onNext}>{tr('common.later')}</button>
      <button className="btn pri" disabled={firstCheck || !keys.length || offline || sending} title={offline ? tr('toolkit.wiz.needNet') : undefined} onClick={install}>
        {sending ? <span className="spin sm" aria-hidden="true" /> : <Icon n="dl" s={14} />} {firstCheck ? tr('wizard.tk.install') : tr('wizard.tk.installN', { n: keys.length })}</button>
    </> : <>
      <button className="btn" disabled={foot === 'run'} onClick={p.onBack}>{tr('common.back')}</button>
      <button className="btn pri" onClick={p.onNext}>{tr('common.next')}</button>
    </>}</div>
    {loginRow && p.mcpView ? <div className="smdlg tkdlg" onMouseDown={e => { if (e.target === e.currentTarget) setLogin(null); }}>
      <McpLoginDialog key={loginRow.id} row={loginRow} view={p.mcpView} sourcePath={rowSourcePath(loginRow, p.projects, p.mcpView.claudeJson.path)}
        send={p.send} toast={p.toast} onClose={() => setLogin(null)} onEdit={() => setLogin(null)} onOpenSource={() => setLogin(null)} onLog={() => setLogin(null)} />
    </div> : null}
    {grUpd && p.graph ? <div className="smdlg tkdlg" onMouseDown={e => { if (e.target === e.currentTarget) setGrUpd(false); }}>
      <GraphUpdateDialog tool={p.graph} connected send={p.send} onClose={() => setGrUpd(false)} />
    </div> : null}
  </>;
}
