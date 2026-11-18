// v2.9 §4.1 / §4.6 (WF6a, WF6a2, WF6b) the workflow chip at the top of the Tasks rail: the project's workflow name ▾ (hover
// "Quy trình của project"); its menu lists the library (✓ the one applied, its one-line description), then "Sửa quy trình
// này" (a library pack) or "Xem quy trình này" (a built-in), "Quản lý quy trình…". Another workflow → the Áp dụng box: the
// mini chain of that workflow and the impact ("Tài liệu mới và phiên Chung theo quy trình mới. n tài liệu đang làm giữ quy
// trình cũ tới khi xong: …"). Áp dụng sends `project_set_workflow` (ruling 22:36: no Chung restart). Mac only (N6). hf-sp: under the head, why the project got Giao thẳng.
import { useEffect, useState, type ReactElement } from 'react';
import type { WorkflowRow } from '../../../shared/workflows.ts';
import { useT } from '../lib/i18n.tsx';
import { specShort } from '../lib/traces.ts';
import type { WfDoc } from '../lib/wf-tasks.ts';
import { Icon } from '../ui/icons.tsx';
import type { TasksCtx } from './tasks-ctx.ts';
import { useWfDocs } from './useWfDocs.ts';
import './wf-chip.css';

export function WfChip({ c }: { c: TasksCtx }): ReactElement | null {
  const tr = useT();
  /** where the menu opens (viewport px under the chip): the rail clips its overflow, the 400 px menu must not */
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const open = at !== null;
  const [ask, setAsk] = useState<WorkflowRow | null>(null);
  const { setPop } = c;
  useEffect(() => {
    if (!open && !ask) return;
    setPop(() => { setAt(null); setAsk(null); });
    return () => setPop(null);
  }, [open, ask, setPop]);
  const rows = c.wf.rows;
  const cur = rows.find(r => r.id === c.wf.id);
  const name = cur?.name ?? c.wf.cur?.name ?? '';
  const go = (id: string | null) => { setAt(null); c.wf.openWorkflows(id); };
  return (
    <div className="wfchip">
      <button type="button" className={`wfc${open ? ' open' : ''}`} title={tr('tasks.wf.chipTip')} aria-haspopup="menu" aria-expanded={open}
        onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setAt(open ? null : { x: Math.max(0, Math.min(r.left, window.innerWidth - 412)), y: r.bottom + 4 }); }}><Icon n="fork" s={12} />{name}<Icon n="chev" s={11} /></button>
      {at ? (
        <div className="wfmenu" role="menu" style={{ left: at.x, top: at.y }} aria-label={tr('tasks.wf.menuHead', { project: c.project.name })}>
          <h4>{tr('tasks.wf.menuHead', { project: c.project.name })}</h4>
          {c.wf.fallback ? <p className="why">{tr('tasks.wf.fallback', { plugin: c.wf.fallback })}</p> : null}
          {rows.map(r => (
            <button key={r.id} type="button" role="menuitemradio" aria-checked={r.id === c.wf.id} className={r.id === c.wf.id ? 'on' : undefined}
              disabled={r.rev === null || c.locked} onClick={() => { setAt(null); if (r.id !== c.wf.id) setAsk(r); }}>
              <span className="ck">{r.id === c.wf.id ? <Icon n="check" s={14} /> : null}</span>{r.name}<small>{r.description}</small>
            </button>
          ))}
          <div className="sep" />
          <button type="button" role="menuitem" onClick={() => go(c.wf.id)}>
            <span className="ck"><Icon n={cur?.builtin === false ? 'pencil' : 'eye'} s={14} /></span>{tr(cur?.builtin === false ? 'tasks.wf.edit' : 'tasks.wf.view')}
          </button>
          <button type="button" role="menuitem" onClick={() => go(null)}>
            <span className="ck"><Icon n="gear" s={14} /></span>{tr('tasks.wf.manage')}
          </button>
        </div>
      ) : null}
      {ask ? <ApplyBox c={c} row={ask} onClose={() => setAsk(null)} /> : null}
    </div>
  );
}

/** §4.6 the box: the chosen workflow's chain, the impact, Huỷ / Áp dụng (busy while the engine answers). */
function ApplyBox({ c, row, onClose }: { c: TasksCtx; row: WorkflowRow; onClose: () => void }): ReactElement {
  const tr = useT();
  const [busy, setBusy] = useState(false);
  const { docs, loading } = useWfDocs(c.send, [row.rev!], !c.locked);
  const target = docs.get(row.rev!) ?? null;
  const keep = c.pi.specs.filter(s => s.state !== 'done').map(s => `${specShort(s.title)} (${c.wf.slots?.slot(s).label ?? ''})`);
  const apply = () => {
    setBusy(true);
    c.send({ cmd: 'project_set_workflow', projectId: c.project.id, id: row.id }).then(onClose, () => setBusy(false));
  };
  return (
    <div className="wfscrim">
      <div className="modal glass wide wfapply" role="dialog" aria-modal="true" aria-label={tr('tasks.wf.apply.title', { name: row.name, project: c.project.name })} aria-busy={busy || loading || undefined}>
        <h2>{tr('tasks.wf.apply.title', { name: row.name, project: c.project.name })}</h2>
        {target ? <MiniChain w={target} /> : <p className="wfload" role="status"><span className="spin" />{tr('tasks.wf.loading')}</p>}
        <p>{tr('tasks.wf.apply.impact')}{keep.length ? ` ${tr('tasks.wf.apply.keep', { n: keep.length, list: keep.join(', ') })}` : ''}</p>
        <div className="mf">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>{tr('common.cancel')}</button>
          <button type="button" className="btn pri" onClick={apply} disabled={busy || c.locked} autoFocus>
            {busy ? <><span className="spin" />{tr('tasks.wf.apply.busy')}</> : tr('tasks.wf.apply.ok')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** §4.6 the mini chain: doc / build steps with the edge words ("bấm Bắt đầu" / "tự chạy" / "hết mục"), Xong, then Chung · Lane. */
function MiniChain({ w }: { w: WfDoc }): ReactElement {
  const tr = useT();
  const chain = w.steps.filter(s => s.type === 'design' || s.type === 'build');
  const lane = w.steps.find(s => s.type === 'lane');
  const edge = (s: (typeof chain)[number]) => tr(s.type === 'build' ? 'tasks.wf.mini.end' : s.next?.start === 'button' ? 'tasks.wf.mini.button' : 'tasks.wf.mini.auto');
  return (
    <div className="wfmini">
      {chain.length ? (
        <div className="ch">
          {chain.map(s => <span key={s.id} className="st"><span className="s"><Icon n={s.type === 'build' ? 'branch' : 'file'} s={12} />{s.name}</span><span className="a">{edge(s)}</span></span>)}
          <span className="s e"><Icon n="check" s={12} />{tr('tasks.wf.mini.done')}</span>
        </div>
      ) : null}
      <span className="lo">{tr('tasks.wf.mini.extra', { n: lane?.phases?.length ?? 0 })}</span>
    </div>
  );
}
