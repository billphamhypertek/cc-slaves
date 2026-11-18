// v2.2 §6 the MCP tab: summary, K14 / lost / no-claude bands, groups (K1), rows with the "Lane" switch and "⋯", the K2
// detail in place, K7 pending entries, K1-local, K1-empty, K1-load and the claude.ai connector line (K1-claudeai); v2.5 K1-graph
// (the user's codebase-memory-mcp row, locked while the graph module is ready). Row buttons are plain buttons (v2.5 Z20).
import { useState, type ReactElement } from 'react';
import type { GraphToolState } from '../../../shared/graph.ts';
import type { LaneView, McpErrorView, McpLogLineView, McpRowView, ProjectView, SkillsMcpView } from '../../../shared/protocol.ts';
import { fmtHm, fmtSecs } from '../lib/format.ts';
import { useT, type Key, type Tr } from '../lib/i18n.tsx';
import { graphLocked, lanesUsing, maskConfig, mcpGroups, mcpShort, rowActs, rowIssue, rowMenu, rowSourcePath, type MenuItem } from '../lib/skills-mcp-sheet.ts';
import { Icon, type IconName } from './icons.tsx';

export type McpAct =
  | { t: 'add' } | { t: 'edit' | 'remove' | 'check' | 'login' | 'logout'; row: McpRowView }
  | { t: 'toggle' | 'project'; row: McpRowView; on: boolean } | { t: 'open'; path: string } | { t: 'copy'; text: string } | { t: 'graph' };

interface Ctx {
  tr: Tr; snap: { lanes: readonly LaneView[]; projects: readonly ProjectView[] }; view: SkillsMcpView; act: (a: McpAct) => void;
  /** K2 open row / its log shown ("Xem log", F-I2). */
  onOpen: (id: string | null) => void; log: string | null; onLog: (id: string | null) => void;
}

const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');
const projName = (c: Ctx, id: string | null) => c.snap.projects.find(x => x.id === id)?.name ?? id ?? '';
function sourceLabel(c: Ctx, r: McpRowView): string {
  if (r.unused) return 'local ~';
  if (r.source === 'plugin') return `plugin ${(r.plugin ?? '').split('@')[0]}`;
  return r.source === 'user' ? 'user' : `${r.source} ${projName(c, r.projectId)}`;
}
const sourcePath = (c: Ctx, r: McpRowView) => rowSourcePath(r, c.snap.projects, c.view.claudeJson.path);
type StKey = 'connected' | 'needsLogin' | 'needsRelogin' | 'error' | 'unchecked' | 'unused';
const STATUS: Record<McpRowView['status'], { k: StKey; i: IconName; cls: string }> = {
  connected: { k: 'connected', i: 'check', cls: 'ok' }, needs_login: { k: 'needsLogin', i: 'lock', cls: 'bad' },
  needs_relogin: { k: 'needsRelogin', i: 'lock', cls: 'bad' }, error: { k: 'error', i: 'bang', cls: 'bad' }, unchecked: { k: 'unchecked', i: 'clock', cls: 'na' },
};
const cmdLine = (cfg: Record<string, unknown>) => {
  const m = maskConfig(cfg);
  return typeof m.url === 'string' ? m.url : [m.command, ...(Array.isArray(m.args) ? (m.args as unknown[]) : [])].map(String).join(' ');
};

/** C20 / §5.3 the catalog error of a row. */
const errText = (tr: Ctx['tr'], e: NonNullable<McpRowView['error']>): string =>
  tr(e.code === 'bad_name' ? 'skillsMcp.why.badName' : 'skillsMcp.why.pluginVar', { name: e.name });
/** §5.4b / §5.2 a check / proxy error: its cause line (the engine sends `skillsMcp.mcpErr.*` keys). */
const causeText = (tr: Tr, e: McpErrorView) => tr(e.key as Key, { detail: e.detail ?? '' });

/** §6 K1 / K2-err the red line of an `error` row: the latest of the lane report and the check (F-I4: never a "—" template). */
function errorLine(tr: Tr, r: McpRowView): string | null {
  const li = r.lastInit, p = r.probe;
  if (p?.error && (!li || p.at >= li.at)) return tr('skillsMcp.why.checkErr', { time: fmtHm(p.at), err: causeText(tr, p.error), fix: tr(p.error.fix as Key) });
  return li ? tr('skillsMcp.why.error', { lane: li.lane, time: fmtHm(li.at) }) : null;
}

/** The explanation under a row (always wraps, never cut: §6 narrow window). */
function why(c: Ctx, r: McpRowView): string | null {
  const { tr } = c;
  if (r.error?.code === 'bad_name') return errText(tr, r.error);
  if (r.unused) return tr('skillsMcp.why.unused', { path: tilde(r.unused.path) === '~' ? `~ (${r.unused.path})` : tilde(r.unused.path) });
  if (!r.forLanes) return tr('skillsMcp.why.off');
  if (r.error) return errText(tr, r.error);
  if (r.status === 'needs_login') return tr('skillsMcp.why.needsLogin');
  if (r.status === 'needs_relogin') return tr('skillsMcp.why.needsRelogin');
  if (r.status === 'error') return errorLine(tr, r);
  if (rowIssue(r) === 'yellow') return tr('skillsMcp.why.zeroTools');
  return null;
}

const ITEM_ICON: Record<MenuItem, IconName> = {
  login: 'lock', check: 'refresh', edit: 'pencil', logout: 'power', log: 'file', open: 'file', remove: 'x', pluginNote: 'info',
};

function RowMenu({ c, r, onClose }: { c: Ctx; r: McpRowView; onClose: () => void }): ReactElement {
  const { tr } = c, path = sourcePath(c, r), locked = !c.view.claude.found, acts = rowActs(r);
  const run: Record<Exclude<MenuItem, 'pluginNote'>, () => void> = {
    login: () => c.act({ t: 'login', row: r }), check: () => c.act({ t: 'check', row: r }), edit: () => c.act({ t: 'edit', row: r }),
    logout: () => c.act({ t: 'logout', row: r }), log: () => { c.onOpen(r.id); c.onLog(r.id); },
    open: () => { if (path) c.act({ t: 'open', path }); }, remove: () => c.act({ t: 'remove', row: r }),
  };
  const label: Record<MenuItem, string> = {
    login: tr(acts.logout ? 'skillsMcp.act.relogin' : 'skillsMcp.act.login'), check: tr('skillsMcp.act.check'), edit: tr('skillsMcp.act.edit'),
    logout: tr('skillsMcp.act.logout'), log: tr('skillsMcp.act.log'), open: tr('skillsMcp.act.openSource'), remove: tr('skillsMcp.act.remove'),
    pluginNote: tr('skillsMcp.pluginNote', { plugin: mcpPlugin(r) }),
  };
  return (
    <div className="rmenu glass" role="menu">
      {rowMenu(r, path).map((k) => {
        if (k === 'pluginNote') return <span key={k} role="menuitem" aria-disabled="true" className="note"><Icon n="info" s={14} />{label[k]}</span>;
        const dis = locked && (k === 'edit' || k === 'remove');
        return <button key={k} role="menuitem" className={k === 'remove' ? 'bad' : ''} disabled={dis} title={dis ? tr('skillsMcp.noClaudeShort') : undefined}
          onClick={() => { onClose(); run[k](); }}><Icon n={ITEM_ICON[k]} s={14} />{label[k]}</button>;
      })}
    </div>
  );
}

const mcpPlugin = (r: McpRowView) => (r.plugin ?? '').split('@')[0] ?? '';
const TOOL_FOLD = 12;

/** §6 K2 "Công cụ · n": the last check's tool names, folded after 12. */
function ToolList({ tr, names }: { tr: Tr; names: readonly string[] }): ReactElement {
  const [all, setAll] = useState(false);
  return (
    <div className="smtools">
      <h4>{tr('skillsMcp.det.tools', { n: names.length })}</h4>
      <ul className="mono">{(all ? names : names.slice(0, TOOL_FOLD)).map((n) => <li key={n}>{n}</li>)}</ul>
      {names.length > TOOL_FOLD ? <button className="lnk" aria-expanded={all} onClick={() => setAll((x) => !x)}>
        <Icon n="chevR" s={14} />{all ? tr('skillsMcp.det.fewerTools') : tr('skillsMcp.det.moreTools', { n: names.length - TOOL_FOLD })}</button> : null}
    </div>
  );
}

/** §5.2 K2 "Xem log": the proxy's last lines of a server (time, call, status, duration, error). */
export function McpLog({ lines }: { lines: readonly McpLogLineView[] }): ReactElement {
  const tr = useT();
  return (
    <div className="smlog">
      <h4>{tr('skillsMcp.det.log')}</h4>
      {lines.length ? <ol className="mono">{lines.map((l, i) => <li key={i} className={l.error || l.status >= 400 ? 'bad' : ''}>
        <span>{fmtHm(l.at)}</span> <span>{l.method} {l.path}</span> <span>{l.status}</span> <span>{fmtSecs(l.ms, tr)}</span>
        {l.error ? <span> {causeText(tr, l.error)}</span> : null}</li>)}</ol> : <p className="why">{tr('skillsMcp.det.logEmpty')}</p>}
    </div>
  );
}

/** §6 K2 the login line from `oauth`: "Đã đăng nhập · làm mới lúc 13:05 · hết hạn 14:05". */
function loginLine(tr: Tr, o: NonNullable<McpRowView['oauth']>): string {
  return [tr(o.loggedIn ? 'skillsMcp.det.loggedIn' : 'skillsMcp.det.notLoggedIn'),
    o.loggedIn && o.refreshedAt !== null ? tr('skillsMcp.det.refreshed', { time: fmtHm(o.refreshedAt) }) : '',
    o.loggedIn && o.expiresAt !== null ? tr('skillsMcp.det.expires', { time: fmtHm(o.expiresAt) }) : ''].filter(Boolean).join(' · ');
}

/** §6 K2 R-I2 the login block, except for a connected server that is neither logged in nor asked for a login. */
const showLogin = (o: NonNullable<McpRowView['oauth']>, st: McpRowView['status']): boolean => o.loggedIn || o.needsLogin !== null || st !== 'connected';

/** §6 K2 the detail under its row: config (secrets masked, "Hiện"), source, id, login, last lane report, lanes using it,
 *  the last check's tools, the log and the buttons; a plugin row says where to edit it (K1-src). */
function Detail({ c, r }: { c: Ctx; r: McpRowView }): ReactElement {
  const { tr } = c;
  const [show, setShow] = useState(false);
  const cfg = show ? r.config : maskConfig(r.config);
  const pairs = (k: 'env' | 'headers', sep: string) => { const v = cfg[k]; return v && typeof v === 'object' ? Object.entries(v as Record<string, unknown>).map(([n, x]) => `${n}${sep}${String(x)}`) : []; };
  const secrets = [...pairs('env', '='), ...pairs('headers', ': ')];
  const path = sourcePath(c, r), using = lanesUsing(r, c.snap.lanes), li = r.lastInit, logOpen = c.log === r.id;
  const lastErr = r.error ? errText(tr, r.error) : r.status === 'error' ? errorLine(tr, r) : null;
  const p = r.probe, tools = p && (!li || p.at >= li.at) ? (p.state === 'connected' ? p.tools : []) : li?.toolNames ?? []; // §5.4b the latest wins
  return (
    <div className="smdet">
      <div className="kv">
        <h4>{tr('skillsMcp.det.config')}</h4>
        <span>{typeof cfg.url === 'string' ? 'URL' : tr('skillsMcp.det.command')}</span><code>{cmdLine(cfg)}</code>
        {secrets.length ? <><span>{tr('skillsMcp.det.secrets')}</span><span><code>{secrets.join('  ')}</code> <button className="lnk" onClick={() => setShow(s => !s)}>{tr(show ? 'skillsMcp.det.hide' : 'skillsMcp.det.show')}</button></span></> : null}
        <span>{tr('skillsMcp.det.source')}</span><code>{path ? tilde(path) : r.plugin}</code>
        <span>Id</span><code>{r.id}</code>
      </div>
      <div className="kv">
        {r.oauth && showLogin(r.oauth, r.status) ? <><h4>{tr('skillsMcp.det.login')}</h4>
          <div className={`smlogin ${r.oauth.loggedIn ? 'ok' : 'bad'}`}><Icon n={r.oauth.loggedIn ? 'check' : 'lock'} s={14} />{loginLine(tr, r.oauth)}</div></> : null}
        <h4>{tr('skillsMcp.det.lanes')}</h4>
        <span>{tr('skillsMcp.det.last')}</span><span>{li ? tr('skillsMcp.det.lastLine', { lane: li.lane, time: fmtHm(li.at), state: tr(`skillsMcp.init.${li.state === 'connected' ? 'connected' : li.state === 'needs-auth' ? 'needsAuth' : 'failed'}`), n: li.tools }) : tr('skillsMcp.det.never')}</span>
        <span>{tr('skillsMcp.det.using')}</span><span>{tr('skillsMcp.det.usingLine', { lanes: using.length ? using.join(', ') : '—' })}</span>
        <span>{tr('skillsMcp.det.lastErr')}</span><span>{lastErr ?? tr('skillsMcp.det.none')}</span>
      </div>
      {tools.length ? <ToolList tr={tr} names={tools} /> : null}
      {logOpen ? <McpLog lines={r.log} /> : null}
      <div className="row">
        <button className="btn" onClick={() => c.act({ t: 'check', row: r })}><Icon n="refresh" s={14} /> {tr('skillsMcp.act.check')}</button>
        {r.kind !== 'stdio' ? <button className={`btn ${logOpen ? 'on' : ''}`} aria-pressed={logOpen} onClick={() => c.onLog(logOpen ? null : r.id)}><Icon n="file" s={14} /> {tr(logOpen ? 'skillsMcp.act.hideLog' : 'skillsMcp.act.log')}</button> : null}
        {path ? <button className="btn" onClick={() => c.act({ t: 'open', path })}><Icon n="file" s={14} /> {tr('skillsMcp.act.openSource')}</button> : null}
        {r.source === 'plugin' ? <span className="note"><Icon n="info" s={14} />{tr('skillsMcp.pluginNote', { plugin: mcpPlugin(r) })}</span> : null}
      </div>
    </div>
  );
}

/** §6 K7 a `.mcp.json` entry waiting: where it is new, the command it will run, "Bật cho lane" / "Để tắt" / "Mở file". */
function Pending({ c, r }: { c: Ctx; r: McpRowView }): ReactElement {
  const { tr } = c, p = c.snap.projects.find(x => x.id === r.projectId), path = sourcePath(c, r);
  return (
    <div className="smr pend">
      <span className="st warn"><Icon n="plus" s={14} />{tr('skillsMcp.st.pending')}</span>
      <div className="pmain">
        <div><b className="mono">{r.name}</b> <span className="src mono">{tr('skillsMcp.k7.where', { project: p?.name ?? '', file: `${p?.name ?? ''}/.mcp.json` })}</span> <span className="run">{tr(r.kind === 'stdio' ? 'skillsMcp.local' : 'skillsMcp.remote')}</span></div>
        <div className="why">{tr('skillsMcp.k7.why')}</div>
        <code className="cmd">{cmdLine(r.config)}</code>
        <div className="row">
          <button className="btn pri" onClick={() => c.act({ t: 'project', row: r, on: true })}><Icon n="check" s={14} /> {tr('skillsMcp.k7.enable')}</button>
          <button className="btn" onClick={() => c.act({ t: 'project', row: r, on: false })}>{tr('skillsMcp.k7.leave')}</button>
          {path ? <button className="btn ghost" onClick={() => c.act({ t: 'open', path })}><Icon n="file" s={14} /> {tr('skillsMcp.openFile')}</button> : null}
        </div>
      </div>
    </div>
  );
}

/** §6 C25 F-I1 the `cc_slaves` row: counted like any row, locked on, no menu, no detail. */
function OwnRow({ c, r }: { c: Ctx; r: McpRowView }): ReactElement {
  const { tr } = c;
  return (
    <div className="smr lock"><span className="rowbtn"><span className="st ok"><Icon n="check" s={14} />{tr('skillsMcp.st.connected')}</span><b className="nm mono">{r.name}</b>
      <span className="src mono">{tr('skillsMcp.ccSrc')}</span><span className="run">{tr('skillsMcp.local')}</span>
      <span className="tools mono">{r.tools !== null ? tr('skillsMcp.tools', { n: r.tools }) : '—'}</span></span><span className="pa" />
      <span className="sw"><Icon n="lock" s={14} /></span><span className="mn" /><div className="why">{tr('skillsMcp.ccWhy')}</div></div>
  );
}

/** v2.5 §6.1 K1-graph the user's `codebase-memory-mcp` while the module is ready: cc-slaves' own, no switch, no menu; the line
 *  opens the Graph code tab (where its switch lives). */
function GraphRow({ c, r }: { c: Ctx; r: McpRowView }): ReactElement {
  const { tr } = c, st = STATUS[r.status];
  return (
    <div className="smr lock"><span className="rowbtn"><span className={`st ${st.cls}`}><Icon n={st.i} s={14} />{tr(`skillsMcp.st.${st.k}`)}</span><b className="nm mono">{mcpShort(r)}</b>
      <span className="src mono">{tr('skillsMcp.ccSrc')}</span><span className="run">{tr(r.kind === 'stdio' ? 'skillsMcp.local' : 'skillsMcp.remote')}</span>
      <span className="tools mono">{r.tools !== null ? tr('skillsMcp.tools', { n: r.tools }) : '—'}</span></span><span className="pa" />
      <span className="sw"><Icon n="lock" s={14} /></span><span className="mn" />
      <div className="why"><button type="button" className="lnk grlock" onClick={() => c.act({ t: 'graph' })}>{tr('skillsMcp.graphLock')}<Icon n="chevR" s={14} /></button></div></div>
  );
}

function Row({ c, r, open }: { c: Ctx; r: McpRowView; open: boolean }): ReactElement {
  const { tr } = c;
  const [menu, setMenu] = useState(false);
  const zero = r.status === 'connected' && r.tools === 0; // §6 K2-zero F-M4: own icon, not the green check
  const st: { k: StKey; i: IconName; cls: string } = r.unused ? { k: 'unused', i: 'check', cls: 'na' } : zero ? { k: 'connected', i: 'alert', cls: 'warn' } : STATUS[r.status];
  const { inline } = rowActs(r);
  const w = why(c, r);
  return (
    <div className={`smr ${open ? 'open' : ''} ${r.unused ? 'dim' : ''}`}>
      <button className="rowbtn" aria-expanded={open} onClick={() => c.onOpen(open ? null : r.id)}>
        <span className={`st ${st.cls}`}><Icon n={st.i} s={14} />{tr(`skillsMcp.st.${st.k}`)}</span>
        <b className="nm mono">{mcpShort(r)}</b>
        <span className="src mono">{sourceLabel(c, r)}</span>
        <span className="run">{tr(r.kind === 'stdio' ? 'skillsMcp.local' : 'skillsMcp.remote')}</span>
        {zero ? <span className="tools mono warn"><Icon n="alert" s={14} />{tr('skillsMcp.tools', { n: 0 })}</span>
          : <span className="tools mono">{r.tools !== null ? tr('skillsMcp.tools', { n: r.tools }) : '—'}</span>}
      </button>
      <span className="pa">{inline ? <button className="btn" onClick={() => c.act({ t: inline, row: r })}>
        <Icon n={inline === 'login' ? 'lock' : 'refresh'} s={14} /> {tr(`skillsMcp.act.${inline}`)}</button> : null}</span>
      {r.unused ? <span className="sw">—</span>
        : <button className={`sw ${r.forLanes ? 'on' : ''}`} role="switch" aria-checked={r.forLanes} aria-label={tr('skillsMcp.switchAria', { name: mcpShort(r) })} onClick={() => c.act({ t: 'toggle', row: r, on: !r.forLanes })}><i /></button>}
      <span className="mn"><button className="ib" aria-label={tr('skillsMcp.moreAria', { name: mcpShort(r) })} aria-expanded={menu} onClick={() => setMenu(m => !m)}>⋯</button>
        {menu ? <RowMenu c={c} r={r} onClose={() => setMenu(false)} /> : null}</span>
      {w ? <div className={`why ${rowIssue(r) === 'red' ? 'bad' : ''}`}>{w}</div> : null}
      {open ? <Detail c={c} r={r} /> : null}
    </div>
  );
}

export interface McpTabProps {
  /** undefined = the catalog is still building (K1-load). */
  view: SkillsMcpView | undefined;
  snap: Ctx['snap'];
  /** v2.5 K1-graph: the graph module's state (`ready` locks the user's codebase-memory-mcp row). */
  graph?: GraphToolState | undefined;
  open: string | null; onOpen: (id: string | null) => void;
  /** The row whose K2 log is shown ("Xem log" in the menu, K2 or K3e). */
  log: string | null; onLog: (id: string | null) => void;
  act: (a: McpAct) => void;
  connected: boolean;
}

function Cols({ tr }: { tr: Tr }): ReactElement {
  return <div className="smcols" aria-hidden="true"><span className="hd"><span>{tr('skillsMcp.col.status')}</span><span>{tr('skillsMcp.col.name')}</span><span>{tr('skillsMcp.col.source')}</span>
    <span className="run">{tr('skillsMcp.col.run')}</span><span>{tr('skillsMcp.col.tools')}</span></span><span /><span>{tr('skillsMcp.col.lane')}</span></div>;
}

export function McpTab({ view, snap, graph, open, onOpen, log, onLog, act, connected }: McpTabProps): ReactElement {
  const tr = useT();
  const [n4, setN4] = useState(false);
  if (!view) {
    return <div className="smlist" aria-busy="true"><Cols tr={tr} /><p className="smload">{tr('skillsMcp.loading', { n: snap.projects.length })}</p>
      {[0, 1, 2, 3].map(i => <div key={i} className="skel" />)}</div>;
  }
  const c: Ctx = { tr, snap, view, act, onOpen, log, onLog };
  const one = (r: McpRowView) => (r.builtin ? <OwnRow key={r.id} c={c} r={r} /> : graphLocked(r, graph) ? <GraphRow key={r.id} c={c} r={r} /> : r.pending ? <Pending key={r.id} c={c} r={r} /> : <Row key={r.id} c={c} r={r} open={open === r.id} />);
  const g = mcpGroups(view.mcp.rows, graph);
  const group = (k: 'review' | 'used' | 'off' | 'unused', rows: McpRowView[]) => rows.length ? <section key={k}>
    <h4 className={k === 'review' ? 'warn' : ''}>{k === 'review' ? <Icon n="alert" s={14} /> : null}{tr(`skillsMcp.group.${k}`)} <span>{rows.length}</span></h4>
    {rows.map(one)}
  </section> : null;
  const empty = view.mcp.rows.every(r => r.builtin); // K1-empty: only cc_slaves left
  return (
    <div className="smlist">
      {!connected ? <div className="band bad" role="status"><Icon n="wifi" s={14} />{tr('skillsMcp.engineLost')}</div> : null}
      {!view.claudeJson.ok ? <div className="band bad"><Icon n="file" s={14} /><span>{tr('skillsMcp.k14.json', { line: view.claudeJson.line ?? '?' })}</span>
        <button className="btn" onClick={() => act({ t: 'open', path: view.claudeJson.path })}>{tr('skillsMcp.openFile')}</button></div> : null}
      {!view.claude.found ? <div className="band bad"><Icon n="term" s={14} /><span>{tr('skillsMcp.noClaude', { cmd: view.claude.install })}</span></div> : null}
      {view.lost.map(l => <div key={l.name} className="band bad"><Icon n="alert" s={14} /><span>{tr('skillsMcp.lost', { name: l.name })}</span>
        <button className="btn" onClick={() => act({ t: 'copy', text: l.command })}><Icon n="copy" s={14} /> {tr('skillsMcp.copyOld')}</button></div>)}
      <div className="smsum">
        <span>{tr('skillsMcp.sum', { servers: view.mcp.servers, on: view.mcp.forLanes, tools: view.mcp.tools })}</span>
        <button className="btn pri" disabled={!view.claude.found} onClick={() => act({ t: 'add' })}><Icon n="plus" s={14} /> {tr('skillsMcp.add')}</button>
      </div>
      <Cols tr={tr} />
      {empty ? <>{view.mcp.rows.map(one)}
        <div className="smempty"><Icon n="plug" s={16} /><b>{tr('skillsMcp.empty')}</b><span>{tr('skillsMcp.emptyHint')}</span>
          <button className="btn pri" disabled={!view.claude.found} onClick={() => act({ t: 'add' })}><Icon n="plus" s={14} /> {tr('skillsMcp.add')}</button></div></>
        : <>{group('review', g.review)}{group('used', g.used)}{group('off', g.off)}{group('unused', g.unused)}</>}
      <button className="smcai" aria-expanded={n4} onClick={() => setN4(o => !o)}><Icon n="info" s={14} />{tr('skillsMcp.claudeai')}<Icon n="chevR" s={14} /></button>
      {n4 ? <div className="why smcai-x">{tr('skillsMcp.claudeaiWhy')}</div> : null}
    </div>
  );
}
