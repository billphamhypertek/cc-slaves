// spec v2.9 §4.2 the Quy trình screen (lazy chunk, Mac only, full window under the top bar like Skills & MCP): the library column
// (240), the canvas with its bar (name, "Chưa lưu", the §4.6 impact line, Bỏ thay đổi, Lưu, ⋯), the Kiểm gói list, the property
// panel (360; a right overlay closed by ✕ / Esc under 1280, WF13) and every §6.2 state: skeleton after 100 ms (WF8a), offline
// (WF8b), leave with unsaved changes (WF8c), check errors (WF5), a hand-edited file broken (WF5b), the save conflict (WF5c);
// §4.10 author by prompt: "Sửa bằng lời" (WF2b), the draft rows, the draft canvas ("mới" / "đổi", removed steps struck) beside the
// author chat (WF15–WF16), Lưu / Bỏ nháp / Hoàn tác.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { extendCatalog } from '../../../shared/i18n/core.ts';
import enWorkflow from '../../../shared/i18n/en/workflow.json';
import viWorkflow from '../../../shared/i18n/vi/workflow.json';
import type { Command, Snapshot } from '../../../shared/protocol.ts';
import type { DraftView, WorkflowEdit, WorkflowEditResult, WorkflowRow, WorkflowSaveResult } from '../../../shared/workflows.ts';
import { errText, useT } from '../lib/i18n.tsx';
import { fmtHmDay } from '../lib/format.ts';
import { hasTauri, invoke } from '../lib/tauri.ts';
import { impactLine, installedSkills, issueText, layoutOf, LAYOUT_FILE, libraryGroups, parseLayout, rowSub, stepById, stepName, type WfChange, type WfIssue, type WfModel } from '../lib/workflow.ts';
import { AuthorChat } from './AuthorChat.tsx';
import { useDraft } from './useDraft.ts';
import { Icon } from '../ui/icons.tsx';
import { EdgePanel } from './EdgePanel.tsx';
import { ImportDialog } from './ImportDialog.tsx';
import { StepPanel } from './StepPanel.tsx';
import { usePack, type PackApi } from './usePack.ts';
import { edgeEnds, WorkflowCanvas, type Sel } from './WorkflowCanvas.tsx';
import { ClonePop, ConflictDialog, CreateDialog, DeleteDialog, DiscardDraftDialog, LeaveDialog } from './WorkflowDialogs.tsx';
import { WorkflowSettings } from './WorkflowSettings.tsx';
import { TypeIcon, WfIcon } from './wf-icons.tsx';
import './workflow.css';

// §6A the `workflow` namespace ships with this chunk only (first paint; also in lazy.ts LAZY_NS for engine / tests)
extendCatalog('vi', { workflow: viWorkflow });
extendCatalog('en', { workflow: enWorkflow });

const NARROW = 1280;
const SKELETON_MS = 100; // §6.2 + ruling v29-fx3 (M11): the loading feedback rule (≤ 100 ms) wins over the 200 ms anti-flash
const LEGEND_KEY = 'ccs.wf.legend';

export interface WorkflowScreenProps {
  snap: Snapshot; connected: boolean;
  /** the pack to open first (G5 "Sửa / Xem quy trình này"); none = the first row */
  openId?: string;
  send: (c: Command) => Promise<unknown>;
  toast: (level: 'info' | 'error', text: string) => void;
  onClose: () => void;
}
type Dlg = { k: 'create' } | { k: 'discard'; id: string } | { k: 'import' } | { k: 'delete'; row: WorkflowRow } | { k: 'conflict' } | { k: 'leave'; then: () => void } | { k: 'clone'; row: WorkflowRow };
type Tr = ReturnType<typeof useT>;
/** `text` in the UI's words (§4.9); the engine's own sentence, the code and the file only on hover */
type Finding = { bad: boolean; text: string; engine: string; code: string; file?: string; step?: string };

const openPath = (send: WorkflowScreenProps['send'], path: string) => { if (hasTauri()) void invoke('open_path', { path }); else void send({ cmd: 'open_in_vscode', path }); };

/** §4.10 a draft's pack name: `name` of its WORKFLOW.md (what Claude proposed), else "Bản nháp mới". */
const draftName = (tr: Tr, d: DraftView): string => /^name:\s*(.+)$/m.exec(d.files['WORKFLOW.md'] ?? '')?.[1]?.trim().replace(/^["']|["']$/g, '') || tr('workflow.author.newDraft');

interface LibProps {
  tr: Tr; rows: WorkflowRow[] | null; drafts: readonly DraftView[]; cur: string | null; curDraft: string | null; off: boolean;
  onPick: (id: string) => void; onPickDraft: (id: string) => void; onNew: () => void; onImport: () => void;
}
function Library({ tr, rows, drafts, cur, curDraft, off, onPick, onPickDraft, onNew, onImport }: LibProps): ReactElement {
  const g = libraryGroups(rows ?? []);
  const row = (r: WorkflowRow) => {
    const d = drafts.find(x => x.fromId === r.id && x.state !== 'saved');
    const sub = d ? { text: tr('workflow.author.rowHasDraft'), bad: false } : rowSub(tr, r);
    const on = d ? d.id === curDraft : r.id === cur && curDraft === null;
    return <button key={r.id} type="button" className={`lr${on ? ' on' : ''}`} aria-current={on || undefined} data-row={r.id} onClick={() => (d ? onPickDraft(d.id) : onPick(r.id))}>
      <span className="n">{r.name}</span><span className={`s${sub.bad ? ' bad' : ''}`}>{sub.text}</span></button>;
  };
  const fresh = drafts.filter(d => d.fromId === null && d.state !== 'saved').map(d =>
    <button key={d.id} type="button" className={`lr${d.id === curDraft ? ' on' : ''}`} aria-current={d.id === curDraft || undefined} data-draft-row={d.id} onClick={() => onPickDraft(d.id)}>
      <span className="n">{draftName(tr, d)}</span><span className="s">{tr('workflow.author.rowDraft')}</span></button>);
  return <aside className={`wlib${off ? ' off' : ''}`} aria-label={tr('workflow.title')}>
    <div className="lh2">
      <button type="button" className="btn sm" disabled={off || !rows} onClick={onNew}><Icon n="plus" s={13} />{tr('workflow.new')}</button>
      <button type="button" className="btn sm" disabled={off || !rows} onClick={onImport}><Icon n="dl" s={13} />{tr('workflow.import')}</button>
    </div>
    {rows === null ? <div className="lsk" aria-busy="true">{[0, 1, 2, 3].map(i => <div key={i} className="lr"><span className="sk w60" /><span className="sk w40" /></div>)}</div> : <>
      <div className="lg"><Icon n="lock" s={11} />{tr('workflow.group.builtin')}</div>{g.builtin.map(row)}
      <div className="lg">{tr('workflow.group.user')}</div>
      {fresh}{g.user.length ? g.user.map(row) : fresh.length ? null : <div className="lr empty">{tr('workflow.group.userEmpty')}</div>}
    </>}
  </aside>;
}

function findings(tr: Tr, p: { m: WfModel; res: Pick<WorkflowEditResult, 'errors' | 'warnings'> } | null): Finding[] {
  if (!p) return [];
  const one = (bad: boolean) => (i: WfIssue): Finding => {
    const s = i.step ? stepById(p.m, i.step) : undefined;
    const msg = issueText(tr, i);
    return { bad, code: i.code, file: i.file, step: i.step, engine: i.msg, text: s ? tr('workflow.check.at', { step: stepName(tr, s), msg }) : msg };
  };
  return [...p.res.errors.map(one(true)), ...p.res.warnings.map(one(false))];
}

function Problems({ tr, list, onPick }: { tr: Tr; list: Finding[]; onPick: (step: string) => void }): ReactElement | null {
  if (!list.length) return null;
  const e = list.filter(f => f.bad).length;
  return <div className="wprob" role="region" aria-label={tr('workflow.check.title')}>
    <div className="ph2">{tr('workflow.check.title')}<span className="c">{tr('workflow.check.count', { e, w: list.length - e })}{e ? ` · ${tr('workflow.check.locked')}` : ''}</span></div>
    {list.map((f, i) => <button key={i} type="button" className="pr" title={`${f.code}${f.file ? ` · ${f.file}` : ''} · ${f.engine}`} onClick={() => { if (f.step) onPick(f.step); }}>
      <span className={`i ${f.bad ? 'b' : 'w'}`}><Icon n={f.bad ? 'bang' : 'alert'} s={14} /></span><span className="t">{f.text}</span></button>)}
  </div>;
}

function PanelHead({ tr, icon, title, sub, onClose }: { tr: Tr; icon: ReactElement; title: string; sub: string; onClose: () => void }): ReactElement {
  return <div className="pph"><span className="g">{icon}</span><span className="tt"><b>{title}</b><span>{sub}</span></span>
    <button type="button" className="x" aria-label={tr('workflow.panel.close')} onClick={onClose}><Icon n="x" /></button></div>;
}
function Legend({ tr }: { tr: Tr }): ReactElement | null {
  const [shown, setShown] = useState(() => localStorage.getItem(LEGEND_KEY) !== '0');
  if (!shown) return null;
  return <div className="wleg"><div>
    <span><Icon n="lock" s={12} /><b>{tr('workflow.legend.hard')}:</b> {tr('workflow.legend.hardText')}</span>
    <span><Icon n="msg" s={12} /><b>{tr('workflow.legend.soft')}:</b> {tr('workflow.legend.softText')}</span>
  </div><button type="button" className="x" aria-label={tr('workflow.legend.close')} onClick={() => { localStorage.setItem(LEGEND_KEY, '0'); setShown(false); }}><Icon n="x" s={12} /></button></div>;
}

function useWidth(): number {
  const [w, setW] = useState(window.innerWidth);
  useEffect(() => { const f = () => setW(window.innerWidth); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); }, []);
  return w;
}
/** WF8a the skeleton only when loading takes longer than 100 ms. */
function useLate(on: boolean): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => { if (!on) { setLate(false); return; } const t = window.setTimeout(() => setLate(true), SKELETON_MS); return () => window.clearTimeout(t); }, [on]);
  return late;
}

export function WorkflowScreen(p: WorkflowScreenProps): ReactElement {
  const tr = useT();
  const { connected } = p;
  // the shell passes fresh arrows each render: keep one stable function each so the library is read once
  const live = useRef(p);
  live.current = p;
  const send = useCallback((c: Command) => live.current.send(c), []);
  const toast = useCallback((level: 'info' | 'error', text: string) => live.current.toast(level, text), []);
  const fail = useCallback((e: unknown) => toast('error', errText(tr, e)), [toast, tr]);
  const api = usePack({ send, rows: p.snap.workflows ?? null, fail });
  const { rows, pack, row, dirty } = api;
  const [sel, setSel] = useState<Sel>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const [menu, setMenu] = useState(false);
  const [reset, setReset] = useState<string | null>(null);
  const narrow = useWidth() < NARROW;
  const off = !connected;
  const builtin = row?.builtin ?? pack?.id.startsWith('builtin:') ?? false;

  const late = useLate(rows === null || (api.opening !== null && !pack));
  // §4.10 the open draft (or "Sửa bằng lời" just clicked on a pack: `pending`); a saved draft that went away stays frozen (WF16h)
  const drafts = useMemo(() => p.snap.drafts ?? [], [p.snap.drafts]);
  const [draftSel, setDraftSel] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [frozen, setFrozen] = useState<DraftView | null>(null);
  const liveDraft = drafts.find(d => d.id === draftSel) ?? null;
  const lastDraft = useRef<DraftView | null>(null);
  useEffect(() => {
    if (liveDraft) { lastDraft.current = liveDraft; setFrozen(null); return; }
    if (draftSel && lastDraft.current?.id === draftSel) { if (lastDraft.current.saved) setFrozen(lastDraft.current); else setDraftSel(null); }
  }, [liveDraft, draftSel]);
  const draft = liveDraft ?? (frozen && frozen.id === draftSel ? frozen : null);
  // WF16c / WF16d / WF16h a saved draft: the saved pack on the canvas, the closed chat beside it (Hoàn tác while the window lasts)
  const savedDraft = draft?.saved ? draft : null;
  const openDraft = draft && !draft.saved ? draft : null;
  const savedKey = savedDraft ? `${savedDraft.id}@${savedDraft.saved!.until}` : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (savedKey && savedDraft) void api.open(savedDraft.saved!.id); }, [savedKey]);
  const full = drafts.filter(d => d.state !== 'saved').length >= 3;
  const leaveDraft = () => { setDraftSel(null); setPending(null); setFrozen(null); };

  // open the asked pack (or the first row) once the library is known
  const first = useRef(false);
  useEffect(() => {
    if (first.current || !rows?.length) return;
    first.current = true;
    void api.open(rows.some(r => r.id === p.openId) ? p.openId! : rows[0]!.id);
  }, [rows, p.openId, api]);

  /** Leaving the open pack (another pack, ←): asks first when the canvas holds a change (WF8c). */
  const guard = useCallback((then: () => void) => { if (dirty) setDlg({ k: 'leave', then }); else then(); }, [dirty]);
  const pick = (id: string) => {
    if ((draftSel || pending) && id === pack?.id) { leaveDraft(); return; }
    if (id !== pack?.id) guard(() => { leaveDraft(); setSel(null); setReset(null); void api.open(id); });
  };
  const pickDraft = (id: string) => guard(() => {
    setSel(null); setPending(null); setFrozen(null); setDraftSel(id);
    const from = drafts.find(d => d.id === id)?.fromId;
    if (from && from !== pack?.id) void api.open(from);
  });
  const startDraft = async (fromId: string | null, text: string): Promise<boolean> => {
    try {
      const v = await send({ cmd: 'workflow_draft_start', fromId, text }) as DraftView;
      setDlg(null); setSel(null); setPending(null); setFrozen(null); setDraftSel(v.id);
      return true;
    } catch (e) { fail(e); return false; }
  };
  const discardDraft = async (id: string) => {
    const from = drafts.find(d => d.id === id)?.fromId ?? null;
    try { await send({ cmd: 'workflow_draft_discard', draftId: id }); } catch (e) { fail(e); return; }
    setDlg(null); leaveDraft();
    if (!from && !(pack && rows?.some(r => r.id === pack.id))) await api.open(rows?.[0]?.id ?? null);
  };
  const select = (s: Sel) => { setSel(s); setPanelOpen(true); setMenu(false); };

  const edit = useCallback((edits: WorkflowEdit[]) => {
    void api.edit(edits).then(r => { if (r?.failed.length) toast('error', `${r.failed[0]!.key}: ${r.failed[0]!.reason}`); });
  }, [api, toast]);
  const change = useCallback((c: WfChange) => {
    if (!c.edits.length || !pack) return;
    void api.edit(c.edits).then(r => {
      if (!r) return;
      if (r.failed.length) toast('error', `${r.failed[0]!.key}: ${r.failed[0]!.reason}`);
      setSel(c.select ? { k: 'step', id: c.select } : null);
      if (c.select) setPanelOpen(true);
      setReset(c.reset);
    });
  }, [api, pack, toast]);

  const doSave = async (force?: string) => {
    const out = await api.save(force);
    if (out === 'saved') { setDlg(null); setReset(null); toast('info', tr('workflow.saved', { name: pack?.m.name ?? '' })); }
    else if (out === 'conflict') setDlg({ k: 'conflict' });
    else if (out === 'errors') setDlg(null);
  };
  const create = async (from: string, name: string) => {
    try {
      const r = await send({ cmd: 'workflow_create', from, name }) as WorkflowRow;
      setDlg(null); setSel(null); toast('info', tr('workflow.created', { name: r.name }));
      await api.open(r.id);
    } catch (e) { fail(e); }
  };
  const remove = async (r: WorkflowRow) => {
    try {
      await send({ cmd: 'workflow_delete', id: r.id });
      setDlg(null); setSel(null); toast('info', tr('workflow.deleted', { name: r.name }));
      const next = rows?.find(x => x.id !== r.id);
      await api.open(next?.id ?? null);
    } catch (e) { fail(e); }
  };

  // Esc: a dialog first (Huỷ / Ở lại), then the menu, the overlay panel, the selection, then leave the screen (asks when dirty)
  const escRef = useRef<() => void>(() => {});
  escRef.current = () => {
    if (dlg) { if (dlg.k !== 'import') setDlg(null); return; }
    if (menu) { setMenu(false); return; }
    if (pending) { setPending(null); return; }
    if (narrow && panelOpen) { setPanelOpen(false); return; }
    if (sel) { setSel(null); return; }
    guard(p.onClose);
  };
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('.cm-editor') && t.closest('.cm-panels')) return; // CodeMirror's own search panel
      e.stopPropagation();
      escRef.current();
    };
    window.addEventListener('keydown', f, true);
    return () => window.removeEventListener('keydown', f, true);
  }, []);

  const skills = useMemo(() => (p.snap.skillsMcp ? [...installedSkills(p.snap.skillsMcp.skills.rows)].sort() : null), [p.snap.skillsMcp]);
  const plugins = useMemo(() => (p.snap.skillsMcp ? p.snap.skillsMcp.skills.plugins.map(x => x.key.split('@')[0]!).sort() : null), [p.snap.skillsMcp]);
  const list = useMemo(() => findings(tr, pack), [tr, pack]);
  const errs = useMemo(() => new Map(list.filter(f => f.bad && f.step).map(f => [f.step!, f.text] as const).reverse()), [list]);
  const nErr = list.filter(f => f.bad).length;
  const impact = impactLine(tr, row, p.snap.issues ?? []);
  const libDir = rows?.find(r => r.dir)?.dir?.replace(/\/[^/]+$/, '') ?? null;
  const step = pack && sel?.k === 'step' ? stepById(pack.m, sel.id) : undefined;
  const edgeFrom = pack && sel?.k === 'edge' ? stepById(pack.m, sel.from) : undefined;
  const ends = pack && sel?.k === 'edge' ? edgeEnds(tr, pack.m, sel.from) : null;
  const showPanel = !!pack && (!narrow || panelOpen);
  const broken = !!(pack && row && !row.builtin && row.errors.length && row.diskRev === pack.baseRev);
  // WF5b a file on disk that does not even parse: the form would read as empty — view only, fixed in the file (v29-ux M8)
  const unreadable = broken && !!row?.errors.some(e => e.code === 'V1' || e.code === 'V2');
  const ro = builtin || off || unreadable;
  // the author chat sits beside the canvas at every width (an overlay would cover the bar's buttons)
  const chatSide = (!!pending && pack?.id === pending) || (!!savedDraft && !step && !edgeFrom);
  const closePanel = () => { if (narrow) setPanelOpen(false); else setSel(null); };
  // under 1280 the impact line drops under the bar; a built-in saves nothing, so it has none (WF4 / WF13)
  const imp2 = !!pack && narrow && !builtin;

  return <div className={`wf${narrow ? ' nar' : ''}`} data-screen="workflows">
    <div className="wfh">
      <button type="button" className="bk" onClick={() => guard(p.onClose)}><WfIcon n="back" s={14} />{tr('workflow.back')}</button>
      <span className="ttl">{tr('workflow.title')}</span>{libDir ? <span className="pth">{libDir}</span> : null}
    </div>
    <Library tr={tr} rows={rows} drafts={drafts} cur={pack?.id ?? null} curDraft={openDraft?.id ?? null} off={off} onPick={pick} onPickDraft={pickDraft}
      onNew={() => guard(() => setDlg({ k: 'create' }))} onImport={() => guard(() => setDlg({ k: 'import' }))} />
    {openDraft ? <DraftArea key={openDraft.id} tr={tr} draft={openDraft} row={openDraft.fromId ? rows?.find(r => r.id === openDraft.fromId) ?? null : null} rows={rows ?? []}
      snap={p.snap} off={off} narrow={narrow} skills={skills} send={send} fail={fail} onDiscard={() => setDlg({ k: 'discard', id: openDraft.id })} /> : <>
    <section className={`wcv${(showPanel && !narrow) || chatSide ? '' : ' full'}${off || broken ? ' ban' : ''}${imp2 ? ' i2' : ''}`} aria-busy={late || undefined}>
      {pack ? <CanvasBar tr={tr} api={api} row={row} builtin={builtin} off={off} nErr={nErr} impact={narrow ? null : impact} reset={reset} menu={menu} setMenu={setMenu}
        authorWhy={off ? tr('workflow.offline') : dirty ? tr('workflow.author.editDirty') : full ? tr('workflow.author.limit') : null} onAuthor={() => { setSel(null); setPending(pack.id); }}
        onSave={() => void doSave()} onClone={r => setDlg({ k: 'clone', row: r })} onDelete={r => setDlg({ k: 'delete', row: r })} onOpenDir={d => openPath(send, d)} /> : <div className="wtb" />}
      {pack && dlg?.k === 'clone' ? <ClonePop tr={tr} row={dlg.row} files={Object.keys(pack.files).length} onCancel={() => setDlg(null)} onCreate={name => create(dlg.row.id, name)} /> : null}
      {imp2 ? <div className="wimp2">{impact}</div> : null}
      {off ? <div className="wban warn" role="status"><Icon n="wifi" s={14} /><span className="t">{tr('workflow.offline')}</span></div> : null}
      {broken && !off ? <div className="wban" role="alert"><Icon n="bang" s={14} />
        <span className="t">{row.validAt ? tr('workflow.broken.title', { at: fmtHmDay(row.validAt) }) : tr('workflow.broken.none')} · {tr('workflow.bar.brokenDisk')}</span>
        {row.dir ? <button type="button" className="btn sm" onClick={() => openPath(send, row.dir!)}><Icon n="folder" s={13} />{tr('workflow.menu.open')}</button> : null}</div> : null}
      {pack ? <WorkflowCanvas key={pack.id} tr={tr} m={pack.m} files={pack.files} readOnly={builtin || unreadable} offline={off} band={off || broken} cover={narrow && showPanel && !chatSide ? 360 : 0} errs={errs} sel={sel} onSel={select} onChange={change}
        onLayout={text => edit([{ path: '.layout.json', text }])}>
        <Problems tr={tr} list={list} onPick={id => select({ k: 'step', id })} />
      </WorkflowCanvas> : late ? <div className="wvp skel" aria-label={tr('workflow.loading')}>{(['n0', 'n1', 'n2'] as const).map(c => <div key={c} className={`skn ${c}`}><span className="sk w60" /><span className="sk w40" /></div>)}</div> : <div className="wvp" />}
    </section>
    {pending && pack?.id === pending ? <aside className={`wpp${off ? ' off' : ''}`} aria-label={tr('workflow.author.chat')}>
      <AuthorChat tr={tr} draft={null} closed={false} accounts={p.snap.accounts} off={off} send={text => startDraft(pending, text)} onStop={() => {}} onUndo={() => {}} onQuota={() => {}} />
    </aside> : chatSide && savedDraft ? <aside className={`wpp${off ? ' off' : ''}`} aria-label={tr('workflow.author.chat')}>
      <AuthorChat tr={tr} draft={savedDraft} closed={savedDraft !== liveDraft} accounts={p.snap.accounts} off={off} send={async () => false} onStop={() => {}}
        onUndo={() => { void send({ cmd: 'workflow_draft_undo', draftId: savedDraft.id }).catch(fail); }} onQuota={() => {}} />
    </aside> : showPanel && pack ? <aside className={`wpp${narrow ? ' ovl' : ''}${off ? ' off' : ''}`} aria-label={tr('workflow.panel.settings')}>
      {step ? <PanelHead tr={tr} icon={<TypeIcon type={step.type} />} title={stepName(tr, step)} sub={step.type ? tr(`workflow.type.${step.type}`) : ''} onClose={closePanel} />
        : edgeFrom && ends ? <PanelHead tr={tr} icon={<Icon n="chevR" />} title={tr('workflow.edgeP.title', ends)} sub={`${ends.from} → ${ends.to}`} onClose={closePanel} />
          : <PanelHead tr={tr} icon={<Icon n="gear" />} title={tr('workflow.panel.settings')} sub={builtin ? tr('workflow.panel.readOnlySub') : tr('workflow.panel.settingsSub')} onClose={closePanel} />}
      <Legend tr={tr} />
      {builtin && row ? <div className="robar"><button type="button" className="btn sm" onClick={() => setDlg({ k: 'clone', row })}><Icon n="copy" s={13} />{tr('workflow.bar.clone')}</button>
        <span className="fnote">{tr('workflow.panel.readOnlyNote')}</span></div> : null}
      {unreadable && row ? <div className="robar"><span className="fnote">{tr('workflow.panel.brokenNote')}</span>
        {row.dir ? <button type="button" className="btn sm" onClick={() => openPath(send, row.dir!)}><Icon n="folder" s={13} />{tr('workflow.menu.open')}</button> : null}</div> : null}
      {step ? <StepPanel key={step.id} tr={tr} m={pack.m} s={step} files={pack.files} base={pack.base} ro={ro} skills={skills} edit={edit} change={change} />
        : edgeFrom ? <EdgePanel tr={tr} m={pack.m} s={edgeFrom} ro={ro} edit={edit} />
          : <WorkflowSettings tr={tr} m={pack.m} ro={ro} plugins={plugins} edit={edit} />}
    </aside> : null}</>}
    {dlg?.k === 'create' && rows ? <CreateDialog tr={tr} rows={rows} send={send} full={full || off} note={tr('workflow.author.createNoteAuto')} onAuthor={async t => { await startDraft(null, t); }}
      onCancel={() => setDlg(null)} onCreate={create} /> : null}
    {dlg?.k === 'discard' ? <DiscardDraftDialog tr={tr} onStay={() => setDlg(null)} onDiscard={() => discardDraft(dlg.id)} /> : null}
    {dlg?.k === 'import' ? <ImportDialog tr={tr} send={send} fail={fail} onCancel={() => setDlg(null)}
      onAdded={r => { setDlg(null); setSel(null); toast('info', tr('workflow.imported', { name: r.name })); void api.open(r.id); }} /> : null}
    {dlg?.k === 'delete' ? <DeleteDialog tr={tr} row={dlg.row} onCancel={() => setDlg(null)} onDelete={() => remove(dlg.row)} /> : null}
    {dlg?.k === 'conflict' && pack ? <ConflictDialog tr={tr} name={pack.m.name} busy={api.saving} onCancel={() => setDlg(null)}
      onReload={() => { setDlg(null); setSel(null); void api.open(pack.id); }} onOverwrite={() => void doSave(row?.diskRev)} /> : null}
    {dlg?.k === 'leave' && pack ? <LeaveDialog tr={tr} name={pack.m.name} onStay={() => setDlg(null)} onLeave={() => { const t = dlg.then; setDlg(null); void api.discard().catch(() => {}).then(t); }} /> : null}
  </div>;
}

interface DraftAreaProps {
  tr: Tr; draft: DraftView; row: WorkflowRow | null; rows: readonly WorkflowRow[]; snap: Snapshot; off: boolean; narrow: boolean;
  skills: readonly string[] | null; send: (c: Command) => Promise<unknown>; fail: (e: unknown) => void; onDiscard: () => void;
}
/** §4.10 a draft open: the bar ("3 thay đổi · 0 lỗi", the impact line, Bỏ nháp, Lưu), the draft canvas (view only while a turn
 *  runs), Kiểm gói, and the author chat — or a step's panel over it while the session waits (✕ back to the chat). */
function DraftArea({ tr, draft, row, rows, snap, off, narrow, skills, send, fail, onDiscard }: DraftAreaProps): ReactElement {
  const { pack, patch } = useDraft(send, draft, fail);
  const [sel, setSel] = useState<Sel>(null);
  const [saving, setSaving] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  const editable = !off && draft.state === 'idle';
  useEffect(() => { if (!editable) setSel(null); }, [editable]);
  // the errors are the engine's (they gate Lưu and include a stray file, V11, the canvas model never sees); warnings the canvas's
  const list = useMemo(() => findings(tr, pack && { m: pack.m, res: { errors: draft.errors, warnings: pack.res.warnings } }), [tr, pack, draft.errors]);
  const errs = useMemo(() => new Map(list.filter(f => f.bad && f.step).map(f => [f.step!, f.text] as const).reverse()), [list]);
  const nErr = list.filter(f => f.bad).length;
  const n = draft.changed.added.length + draft.changed.changed.length + draft.changed.removed.length;
  const idOf = (path: string) => path.replace(/^steps\/|\.md$/g, '');
  const tags = useMemo(() => new Map([...draft.changed.added.map(p => [idOf(p), tr('workflow.author.tagNew')] as const),
    ...draft.changed.changed.filter(p => p !== 'WORKFLOW.md').map(p => [idOf(p), tr('workflow.author.tagChanged')] as const)]), [draft.changed, tr]);
  const ghosts = useMemo(() => {
    const bm = pack?.baseM;
    if (!bm) return [];
    const at = layoutOf(bm, parseLayout(draft.base[LAYOUT_FILE]));
    return draft.changed.removed.flatMap(p => { const s = bm.steps.find(x => x.path === p); return s ? [{ s, at: { x: (at[s.id]?.x ?? 0), y: (at[s.id]?.y ?? 0) + 260 } }] : []; });
  }, [pack, draft.base, draft.changed.removed]);
  const edit = useCallback((edits: WorkflowEdit[]) => { void patch(edits); }, [patch]);
  const change = useCallback((c: WfChange) => { if (c.edits.length) void patch(c.edits).then(() => { if (c.select) setSel({ k: 'step', id: c.select }); }); }, [patch]);
  const save = async () => {
    setSaving(true);
    try { await send({ cmd: 'workflow_draft_save', draftId: draft.id, ...(naming?.trim() ? { name: naming.trim() } : {}) }) as WorkflowSaveResult; } catch (e) { fail(e); } finally { setSaving(false); }
  };
  const commitName = () => { if (naming !== null && naming.trim() && pack && naming.trim() !== pack.m.name) void patch([{ path: 'WORKFLOW.md', key: 'name', value: naming.trim() }]); setNaming(null); };
  const say = async (text: string): Promise<boolean> => {
    try { await send({ cmd: 'workflow_draft_say', draftId: draft.id, text }); return true; } catch (e) { fail(e); return false; }
  };
  const cmd = (c: Command) => { void send(c).catch(fail); };
  const running = draft.state === 'running';
  const status = running ? tr('workflow.author.running', { n }) : draft.state === 'quota' ? tr('workflow.author.stopped', { n }) : tr('workflow.author.changes', { n, e: nErr });
  const fromName = draft.fromId === null ? (() => { const b = /^based_on:\s*(\S+?)@/m.exec(draft.files['WORKFLOW.md'] ?? '')?.[1]; return b ? rows.find(r => r.id === b)?.name ?? null : null; })() : null;
  const why = off ? tr('workflow.offline') : nErr ? tr('workflow.bar.fixErrors', { n: nErr }) : undefined;
  const step = pack && sel?.k === 'step' ? stepById(pack.m, sel.id) : undefined;
  const impact = draft.fromId !== null && row?.usedBy.length ? impactLine(tr, row, snap.issues ?? []) : null;
  const name = pack?.m.name || (draft.fromId === null ? tr('workflow.author.newDraft') : row?.name ?? '');
  return <>
    <section className={`wcv${off ? ' ban' : ''}${impact && narrow ? ' i2' : ''}`} data-draft={draft.id}>
      <div className="wtb">
        {draft.fromId === null && naming !== null ? <input className="fld wnmi" autoFocus value={naming} aria-label={tr('workflow.author.newName')} onChange={e => setNaming(e.currentTarget.value)} onBlur={commitName}
          onKeyDown={e => { if (e.key === 'Enter') commitName(); else if (e.key === 'Escape') { e.stopPropagation(); setNaming(null); } }} />
          : <button type="button" className="wnm" disabled={!editable || draft.fromId !== null} title={draft.fromId === null ? tr('workflow.author.newName') : undefined} onClick={() => setNaming(name)}>
            {name}{draft.fromId === null && editable ? <Icon n="pencil" s={12} /> : null}</button>}
        {fromName ? <span className="lnote">{tr('workflow.author.from', { name: fromName })}</span> : null}
        {impact && !narrow ? <span className="imp" title={impact}>{impact}</span> : null}
        <span className="sp" />
        <span className="dstat" data-testid="draft-status">{status}</span>
        <button type="button" className="btn" disabled={off} onClick={onDiscard}>{tr('workflow.author.discard')}</button>
        <button type="button" className="btn pri" disabled={off || running || draft.state === 'quota' || nErr > 0 || n === 0 || saving} title={why} onClick={() => void save()}>
          {saving ? <Icon n="loader" s={13} /> : null}{tr(saving ? 'workflow.bar.saving' : 'workflow.bar.save')}</button>
      </div>
      {impact && narrow ? <div className="wimp2">{impact}</div> : null}
      {off ? <div className="wban warn" role="status"><Icon n="wifi" s={14} /><span className="t">{tr('workflow.offline')}</span></div> : null}
      {pack ? <WorkflowCanvas key={draft.id} tr={tr} m={pack.m} files={pack.files} readOnly={!editable} offline={off} band={off} errs={errs} sel={sel} onSel={s => { if (editable) setSel(s); }}
        onChange={change} onLayout={text => edit([{ path: LAYOUT_FILE, text }])} tags={tags} ghosts={ghosts}>
        <Problems tr={tr} list={list} onPick={id => { if (editable) setSel({ k: 'step', id }); }} />
      </WorkflowCanvas> : <div className="wvp" aria-busy="true" />}
    </section>
    <aside className={`wpp${off ? ' off' : ''}`} aria-label={tr('workflow.author.chat')}>
      {step && pack ? <>
        <PanelHead tr={tr} icon={<TypeIcon type={step.type} />} title={stepName(tr, step)} sub={step.type ? tr(`workflow.type.${step.type}`) : ''} onClose={() => setSel(null)} />
        <StepPanel key={step.id} tr={tr} m={pack.m} s={step} files={pack.files} base={draft.base} ro={!editable} skills={skills} edit={edit} change={change} />
      </> : <AuthorChat tr={tr} draft={draft} closed={false} accounts={snap.accounts} off={off} send={say}
        onStop={() => cmd({ cmd: 'workflow_draft_stop', draftId: draft.id })} onUndo={() => cmd({ cmd: 'workflow_draft_undo', draftId: draft.id })}
        onQuota={go => cmd({ cmd: 'workflow_draft_quota', draftId: draft.id, go })} />}
    </aside>
  </>;
}

interface BarProps {
  tr: Tr; api: PackApi; row: WorkflowRow | null; builtin: boolean; off: boolean; nErr: number; impact: string | null; reset: string | null;
  menu: boolean; setMenu: (f: (o: boolean) => boolean) => void;
  onSave: () => void; onClone: (r: WorkflowRow) => void; onDelete: (r: WorkflowRow) => void; onOpenDir: (dir: string) => void;
  /** §4.10 / WF2b why "Sửa bằng lời" is dimmed (offline, unsaved hand changes, 3 drafts); null = enabled */
  authorWhy: string | null; onAuthor: () => void;
}
/** §4.2 the canvas bar: built-in = lock + name + "Mẫu có sẵn — chỉ xem" + Nhân bản để sửa; else name (edited in place), Chưa lưu,
 *  the impact line, Bỏ thay đổi, Lưu (dimmed with no change / an error / offline), ⋯ Nhân bản · Mở thư mục · Xoá (WF10a). */
function CanvasBar({ tr, api, row, builtin, off, nErr, impact, reset, menu, setMenu, onSave, onClone, onDelete, onOpenDir, authorWhy, onAuthor }: BarProps): ReactElement {
  const pack = api.pack!;
  const [naming, setNaming] = useState<string | null>(null);
  const resetStep = reset ? stepById(pack.m, reset) : undefined;
  const commitName = () => { if (naming !== null && naming.trim() && naming.trim() !== pack.m.name) void api.edit([{ path: 'WORKFLOW.md', key: 'name', value: naming.trim() }]); setNaming(null); };
  if (builtin) {
    return <div className="wtb"><span className="wnm"><Icon n="lock" s={14} />{pack.m.name}</span><span className="ro">{tr('workflow.bar.readOnly')}</span><span className="sp" />
      {row ? <button type="button" className="btn pri" onClick={() => onClone(row)}><Icon n="copy" s={13} />{tr('workflow.bar.clone')}</button> : null}</div>;
  }
  const used = row?.usedBy ?? [];
  const why = off ? tr('workflow.offline') : nErr ? tr('workflow.bar.fixErrors', { n: nErr }) : undefined;
  return <div className="wtb">
    {naming === null ? <button type="button" className="wnm" title={tr('workflow.bar.rename')} disabled={off} onClick={() => setNaming(pack.m.name)}>{pack.m.name || row?.name}<Icon n="pencil" s={12} /></button>
      : <input className="fld wnmi" autoFocus value={naming} aria-label={tr('workflow.bar.rename')} onChange={e => setNaming(e.currentTarget.value)} onBlur={commitName}
        onKeyDown={e => { if (e.key === 'Enter') commitName(); else if (e.key === 'Escape') { e.stopPropagation(); setNaming(null); } }} />}
    {api.dirty ? <span className="dirty"><i />{tr('workflow.bar.unsaved')}</span> : null}
    {resetStep ? <span className="lnote">{tr('workflow.bar.labelsReset', { step: stepName(tr, resetStep) })}</span> : null}
    {impact ? <span className="imp" title={impact}>{impact}</span> : null}
    <span className="sp" />
    <button type="button" className="btn" disabled={authorWhy !== null} title={authorWhy ?? undefined} onClick={onAuthor}>
      <Icon n="msg" s={13} />{tr('workflow.author.edit')}</button>
    <button type="button" className="btn" disabled={!api.dirty || api.saving} onClick={() => void api.discard()}><WfIcon n="undo" s={13} />{tr('workflow.bar.discard')}</button>
    <button type="button" className="btn pri" disabled={!api.dirty || nErr > 0 || off || api.saving} title={why} onClick={onSave}>
      {api.saving ? <Icon n="loader" s={13} /> : null}{tr(api.saving ? 'workflow.bar.saving' : 'workflow.bar.save')}</button>
    <span className="mn">
      <button type="button" className="btn ic" aria-label={tr('workflow.bar.more')} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(o => !o)}><WfIcon n="more" /></button>
      {menu && row ? <div className="wmenu" role="menu">
        <button type="button" role="menuitem" className="mr" disabled={off} onClick={() => { setMenu(() => false); onClone(row); }}><Icon n="copy" s={14} />{tr('workflow.menu.clone')}</button>
        {row.dir ? <button type="button" role="menuitem" className="mr" onClick={() => { setMenu(() => false); onOpenDir(row.dir!); }}><Icon n="folder" s={14} />{tr('workflow.menu.open')}</button> : null}
        <div className="sep" />
        <button type="button" role="menuitem" className="mr" disabled={off || used.length > 0} aria-disabled={used.length > 0 || undefined} onClick={() => { setMenu(() => false); onDelete(row); }}>
          <WfIcon n="trash" s={14} /><span>{tr('workflow.menu.delete')}{used.length ? <small>{tr('workflow.menu.deleteUsed', { names: used.map(u => u.name).join(', ') })}</small> : null}</span></button>
      </div> : null}
    </span>
  </div>;
}
