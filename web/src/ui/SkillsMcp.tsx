// v2.2 §6 the Skills & MCP sheet (lazy chunk, Mac only): head with the tabs and their C25 badges, the MCP tab
// (SkillsMcpList.tsx) + dialogs (SkillsMcpDialogs.tsx), the Skills tab (SkillsMcpSkills.tsx) + K9 / K10
// (SkillsMcpSkillsDialogs.tsx), v2.5 Bộ công cụ (Toolkit.tsx, TK2), Graph code (GraphTab.tsx, GR1; GR-upd / GR-clean in
// GraphDialogs.tsx) and Thư mục chung (SkillsMcpShared.tsx, K12).
import { useEffect, useState, type MutableRefObject, type ReactElement } from 'react';
import type { AccountsInfo, Command, McpRowView, Snapshot, SkillRowView, SkillsMcpView } from '../../../shared/protocol.ts';
import type { GraphView } from '../../../shared/graph.ts';
import type { ToolkitView } from '../../../shared/toolkit.ts';
import { errText, useT } from '../lib/i18n.tsx';
import type { SmOpen, SmTab } from '../lib/skills-mcp.ts';
import { tabCount } from '../lib/graph.ts';
import { pickFolder } from '../lib/pick-folder.ts';
import { lanesUsing, rowSourcePath } from '../lib/skills-mcp-sheet.ts';
import { hasTauri, invoke } from '../lib/tauri.ts';
import { GraphCleanDialog, GraphUpdateDialog } from './GraphDialogs.tsx';
import { GraphTab } from './GraphTab.tsx';
import { Icon } from './icons.tsx';
import { McpAddDialog, McpRemoveDialog } from './SkillsMcpDialogs.tsx';
import { McpLoginDialog } from './SkillsMcpLogin.tsx';
import { McpTab, type McpAct } from './SkillsMcpList.tsx';
import { SharedTab } from './SkillsMcpShared.tsx';
import { SkillsTab, type SkAct } from './SkillsMcpSkills.tsx';
import { SkillAddDialog, SkillRemoveDialog } from './SkillsMcpSkillsDialogs.tsx';
import { ToolkitTab } from './Toolkit.tsx'; // brings skillsMcp.css and the lazy catalogs (also reached from the wizard step 3)

const TABS: readonly SmTab[] = ['mcp', 'skills', 'toolkit', 'graph', 'shared'];
const Badge = ({ red, yellow }: { red: number; yellow: number }) => <>
  {red ? <span className="b red"><Icon n="bang" s={12} />{red}</span> : null}
  {yellow ? <span className="b yel"><Icon n="alert" s={12} />{yellow}</span> : null}
</>;

/** §6 head: title, MCP · n / Skills · n / Bộ công cụ · n / Graph code · n / Thư mục chung with their C25 badges (none on Bộ công
 *  cụ, v2.5 §7; Graph code: `counts.graph`, GR-err), Esc hint, ✕ (28 × 28). */
export function SheetHead({ view, toolkit, graph, tab, onTab, onClose }: {
  view: SkillsMcpView | undefined; toolkit: ToolkitView | undefined; graph: GraphView | undefined; tab: SmTab; onTab: (t: SmTab) => void; onClose: () => void;
}): ReactElement {
  const tr = useT();
  const n: Record<SmTab, number | null> = { mcp: view?.mcp.servers ?? null, skills: view?.skills.rows.length ?? null, toolkit: toolkit?.rows.length ?? null, graph: tabCount(graph), shared: null };
  const badge = (t: SmTab) => !view || t === 'toolkit' ? null : t === 'graph' ? (view.counts.graph ? <Badge {...view.counts.graph} /> : null) : <Badge {...view.counts[t]} />;
  return (
    <div className="smh">
      <h2>{tr('skillsMcp.title')}</h2>
      <div className="smtabs" role="tablist">{TABS.map(t => <button key={t} role="tab" aria-selected={t === tab} className={t === tab ? 'on' : ''} onClick={() => onTab(t)}>
        {tr(`skillsMcp.tab.${t}`)}{n[t] !== null ? <span className="n">{n[t]}</span> : null}{badge(t)}</button>)}</div>
      <kbd className="esc">Esc</kbd>
      <button className="x" onClick={onClose} aria-label={tr('common.close')}><Icon n="x" /></button>
    </div>
  );
}

type Dlg = { k: 'add' } | { k: 'edit'; row: McpRowView } | { k: 'remove'; row: McpRowView } | { k: 'skillAdd' } | { k: 'skillRemove'; row: SkillRowView }
  | { k: 'login'; id: string } | { k: 'grUpd' } | { k: 'grClean' };

export interface SkillsMcpProps {
  snap: Snapshot; open: SmOpen; connected: boolean;
  onTab: (t: SmTab) => void; onClose: () => void;
  send: (c: Command) => Promise<unknown>; toast: (t: string) => void;
  /** The shell's Esc (useKeyMap): true = the sheet closed something of its own (dialog, menu), else the sheet closes. */
  escRef: MutableRefObject<(() => boolean) | null>;
  /** v2 §6 A2 engine facts (`accounts_info`) for K12; null until it answers. */
  accInfo: AccountsInfo | null;
  /** K12 "Gộp vào ~/.claude" → the v2 A9 merge dialog (stacks over the sheet). */
  onMerge: (email: string, name: string, cardId?: number) => void;
  /** v2.5 GR-empty "Cài đặt › Project". */
  onProjects: () => void;
}

export function SkillsMcp(p: SkillsMcpProps): ReactElement {
  const tr = useT();
  const view = p.snap.skillsMcp;
  const [dlg, setDlg] = useState<Dlg | null>(p.open.add ? { k: 'add' } : p.open.login ? { k: 'login', id: p.open.login } : null);
  const [rowOpen, setRowOpen] = useState<string | null>(null);
  const [rowLog, setRowLog] = useState<string | null>(null);
  const { escRef } = p;
  useEffect(() => { if (p.open.login) setDlg({ k: 'login', id: p.open.login }); }, [p.open]); // K13 / ⌘K while the sheet is open
  useEffect(() => {
    escRef.current = () => { if (!dlg) return false; setDlg(null); return true; };
    return () => { escRef.current = null; };
  }, [dlg, escRef]);
  const run = (c: Command) => void p.send(c).catch((e: unknown) => p.toast(errText(tr, e)));
  const openPath = (path: string) => { if (hasTauri()) void invoke('open_path', { path }); else run({ cmd: 'open_in_vscode', path }); };
  const act = (a: McpAct) => {
    switch (a.t) {
      case 'add': return setDlg({ k: 'add' });
      case 'edit': return setDlg({ k: 'edit', row: a.row });
      case 'remove': return setDlg({ k: 'remove', row: a.row });
      case 'toggle': return run({ cmd: 'mcp_toggle', id: a.row.id, on: a.on });
      case 'project': return run(a.on ? { cmd: 'mcp_project_enable', id: a.row.id, on: true } : { cmd: 'mcp_toggle', id: a.row.id, on: false });
      case 'check': return run({ cmd: 'mcp_check', id: a.row.id });
      case 'login': return setDlg({ k: 'login', id: a.row.id }); // K3 starts the login
      case 'logout': return run({ cmd: 'mcp_logout', id: a.row.id });
      case 'open': return openPath(a.path);
      case 'copy': void navigator.clipboard?.writeText(a.text).then(() => p.toast(tr('skillsMcp.copied'))); return;
      case 'graph': return p.onTab('graph'); // v2.5 K1-graph
    }
  };
  const pickDir = (): Promise<string | null> => pickFolder(p.send, tr('labels.pickRepo'));
  const skAct = (a: SkAct) => {
    switch (a.t) {
      case 'add': return setDlg({ k: 'skillAdd' });
      case 'remove': return setDlg({ k: 'skillRemove', row: a.row });
      case 'open': return openPath(a.path);
      case 'toggle': return run({ cmd: 'skill_toggle', id: a.row.id, on: a.on });
      case 'plugin': return run({ cmd: 'plugin_toggle', key: a.key, on: a.on });
      case 'fix': {
        const id = a.issue.id;
        if (a.fix === 'open') return openPath(a.issue.path);
        if (a.fix === 'ack' || a.fix === 'unack') return run({ cmd: 'skill_ack', issueId: id, on: a.fix === 'ack' });
        if (a.fix === 'relink') return void pickDir().then(t => { if (t) run({ cmd: 'skill_fix', issueId: id, fix: 'relink', target: t }); }, (e: unknown) => p.toast(errText(tr, e)));
        return run({ cmd: 'skill_fix', issueId: id, fix: a.fix });
      }
    }
  };
  /** §6 K3 for server `id` (gone from the catalog → nothing to log in to). */
  const loginDlg = (id: string) => {
    const row = view?.mcp.rows.find(r => r.id === id);
    if (!view || !row) return null;
    const path = rowSourcePath(row, p.snap.projects, view.claudeJson.path);
    return <McpLoginDialog key={id} row={row} view={view} sourcePath={path} send={p.send} toast={p.toast} onClose={() => setDlg(null)}
      onEdit={() => setDlg({ k: 'edit', row })} onOpenSource={() => { if (path) openPath(path); }} onLog={() => { setDlg(null); setRowOpen(id); setRowLog(id); }} />;
  };
  const tab = p.open.tab;
  return (
    <div className={`modal glass sm ${p.connected ? '' : 'off'}`} role="dialog" aria-label={tr('skillsMcp.title')}>
      <SheetHead view={view} toolkit={p.snap.toolkit} graph={p.snap.graph} tab={tab} onTab={p.onTab} onClose={p.onClose} />
      <div className="smbody">
        {tab === 'mcp' ? <McpTab view={view} snap={p.snap} graph={p.snap.graph?.tool.state} open={rowOpen} onOpen={setRowOpen} log={rowLog} onLog={setRowLog} act={act} connected={p.connected} />
          : tab === 'skills' ? <SkillsTab view={view} projects={p.snap.projects} act={skAct} connected={p.connected} />
          : tab === 'graph' ? <GraphTab view={p.snap.graph} connected={p.connected} send={p.send} toast={p.toast}
            onUpdate={() => setDlg({ k: 'grUpd' })} onClean={() => setDlg({ k: 'grClean' })} onProjects={p.onProjects} />
          : tab === 'toolkit' ? <ToolkitTab view={p.snap.toolkit} mcp={view?.mcp.rows ?? null} connected={p.connected} send={p.send} toast={p.toast} onLogin={id => setDlg({ k: 'login', id })} onGraph={() => p.onTab('graph')} onGraphUpdate={() => setDlg({ k: 'grUpd' })} />
          : <SharedTab snap={p.snap} info={p.accInfo} connected={p.connected} send={p.send} toast={p.toast} onMerge={p.onMerge} />}
      </div>
      {dlg ? <div className="smdlg" onMouseDown={e => { if (e.target === e.currentTarget) setDlg(null); }}>
        {dlg.k === 'grUpd' ? (p.snap.graph ? <GraphUpdateDialog tool={p.snap.graph.tool} connected={p.connected} send={p.send} onClose={() => setDlg(null)} /> : null)
          : dlg.k === 'grClean' ? <GraphCleanDialog connected={p.connected} send={p.send} onClose={() => setDlg(null)} />
          : !view ? null
          : dlg.k === 'login' ? loginDlg(dlg.id)
          : dlg.k === 'skillAdd' ? <SkillAddDialog view={view} send={p.send} onClose={() => setDlg(null)} />
          : dlg.k === 'skillRemove' ? <SkillRemoveDialog row={dlg.row} send={p.send} onClose={() => setDlg(null)} />
          : dlg.k === 'remove'
          ? <McpRemoveDialog row={dlg.row} lanes={lanesUsing(dlg.row, p.snap.lanes)} rev={view.claudeJson.rev} send={p.send} onClose={() => setDlg(null)} />
          : <McpAddDialog view={view} edit={dlg.k === 'edit' ? dlg.row : null} lanes={dlg.k === 'edit' ? lanesUsing(dlg.row, p.snap.lanes) : []} send={p.send} onClose={() => setDlg(null)} />}
      </div> : null}
    </div>
  );
}
