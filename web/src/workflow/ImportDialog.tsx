// spec v2.9 §4.8 Nhập (WF9 / WF9b / WF9c): the macOS folder panel → a preview (name with the "(2)" rename line, description, the
// chain in small, blocked skills, rules in words, plugins, each step's instruction as a link to a read-only viewer, warnings,
// errors — Thêm dimmed while there is one) → Thêm copies the pack into the library. §10.3 the instruction text is read before
// it can reach a system prompt.
import { useEffect, useState, type ReactElement } from 'react';
import type { Tr } from '../../../shared/i18n/core.ts';
import type { Command } from '../../../shared/protocol.ts';
import type { WorkflowEditResult, WorkflowImportResult, WorkflowRow } from '../../../shared/workflows.ts';
import { Icon } from '../ui/icons.tsx';
import { pickFolder } from '../lib/pick-folder.ts';
import { bodySize, issueText, stepName, wfModel, type WfModel } from '../lib/workflow.ts';
import { MdField } from './MdField.tsx';
import { WfIcon } from './wf-icons.tsx';
import { MiniChain, rulesLine } from './WorkflowDialogs.tsx';

type View = { k: 'pick' } | { k: 'read'; dir: string } | { k: 'preview'; dir: string; r: WorkflowImportResult; m: WfModel } | { k: 'viewer'; dir: string; r: WorkflowImportResult; m: WfModel; step: string | null };

export interface ImportProps {
  tr: Tr; send: (c: Command) => Promise<unknown>; fail: (e: unknown) => void;
  onCancel: () => void; onAdded: (row: WorkflowRow) => void;
}

const kb = (files: Record<string, string>) => (Object.values(files).reduce((n, t) => n + new TextEncoder().encode(t).length, 0) / 1024).toFixed(1);

function Preview({ tr, r, m, onView }: { tr: Tr; r: WorkflowImportResult; m: WfModel; onView: (step: string | null) => void }): ReactElement {
  // one skill names itself; more on one step fold into "6 skill ở Build" (the names on hover)
  const deny = m.steps.filter(s => s.deny.length).map(s => s.deny.length === 1
    ? <span key={s.id}>{tr('workflow.imp.denyAt', { skill: s.deny[0]!.skill, step: stepName(tr, s) })}</span>
    : <span key={s.id} title={s.deny.map(d => d.skill).join('\n')}>{tr('workflow.imp.denyMany', { n: s.deny.length, step: stepName(tr, s) })}</span>);
  return <>
    {m.name && m.name !== r.name ? <div className="band info"><Icon n="info" s={14} /><span>{tr('workflow.imp.renamed', { name: m.name, as: r.name })}</span></div> : null}
    <MiniChain tr={tr} m={m} />
    <div className="kv2">
      <span>{tr('workflow.imp.description')}</span><span>{r.description || '—'}</span>
      <span>{tr('workflow.imp.deny')}</span><span>{deny.length ? deny.flatMap((d, i) => (i ? [' · ', d] : [d])) : '—'}</span>
      <span>{tr('workflow.imp.rules')}</span><span>{rulesLine(tr, m)}</span>
      <span>{tr('workflow.imp.plugins')}</span><span>{m.plugins.join(', ') || tr('workflow.f.pluginNone')}</span>
      <span>{tr('workflow.imp.body')}</span>
      <span className="ldl">
        <a role="button" tabIndex={0} onClick={() => onView(null)} onKeyDown={e => { if (e.key === 'Enter') onView(null); }}>{tr('workflow.imp.bodyLink', { step: tr('workflow.imp.bodyAll'), n: bodySize(m.body).lines })} ›</a>
        {m.steps.map(s => <a key={s.id} role="button" tabIndex={0} onClick={() => onView(s.id)} onKeyDown={e => { if (e.key === 'Enter') onView(s.id); }}>
          {tr('workflow.imp.bodyLink', { step: stepName(tr, s), n: bodySize(s.body).lines })} ›</a>)}
      </span>
    </div>
    {r.warnings.length ? <div className="band warn"><Icon n="alert" s={14} /><ul>{r.warnings.map((w, i) => <li key={i} title={`${w.file ? `${w.file} · ` : ''}${w.msg}`}>{issueText(tr, w)}</li>)}</ul></div> : null}
    {r.errors.length ? <div className="band bad" role="alert"><Icon n="bang" s={14} /><div><b>{tr('workflow.imp.errors', { n: r.errors.length })}</b>
      <ul>{r.errors.map((e, i) => <li key={i} title={`${e.code}${e.file ? ` · ${e.file}` : ''} · ${e.msg}`}>{issueText(tr, e)}</li>)}</ul></div></div> : null}
  </>;
}

export function ImportDialog({ tr, send, fail, onCancel, onAdded }: ImportProps): ReactElement | null {
  const [v, setV] = useState<View>({ k: 'pick' });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void (async () => {
      const dir = await pickFolder(send, tr('workflow.imp.pick'));
      if (!live) return;
      if (!dir) { onCancel(); return; }
      setV({ k: 'read', dir });
      const r = await send({ cmd: 'workflow_import', dir, preview: true }) as WorkflowImportResult;
      const e = await send({ cmd: 'workflow_edit', files: r.files, edits: [] }) as WorkflowEditResult;
      if (live) setV({ k: 'preview', dir, r, m: wfModel(e.docs) });
    })().catch((e: unknown) => { if (live) { fail(e); onCancel(); } });
    return () => { live = false; };
    // once per open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (v.k === 'pick') return null; // the macOS panel is up
  const add = async () => {
    if (v.k !== 'preview') return;
    setBusy(true);
    try { const r = await send({ cmd: 'workflow_import', dir: v.dir }) as WorkflowImportResult; if (r.row) onAdded(r.row); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const name = v.k === 'read' ? '' : v.r.name;
  if (v.k === 'viewer') {
    const s = v.step ? v.m.steps.find(x => x.id === v.step) : null;
    const step = s ? stepName(tr, s) : tr('workflow.imp.bodyAll');
    // WF9c "‹ Xem trước" top left, the text in the read-only instruction box (line numbers, slot chips, "300 dòng · ≈ 4 500 token · chỉ đọc")
    return <div className="wscrim"><div className="modal glass wide" role="dialog" aria-modal="true" aria-label={s ? tr('workflow.imp.viewer', { step }) : tr('workflow.imp.viewerAll')}>
      <div className="mh ldv"><button type="button" className="btn sm" autoFocus onClick={() => setV({ ...v, k: 'preview' })}><WfIcon n="back" s={13} />{tr('workflow.imp.back')}</button>
        <h2>{s ? tr('workflow.imp.viewer', { step }) : tr('workflow.imp.viewerAll')}</h2><span className="fnote vsub">{tr('workflow.imp.viewerSub', { name: v.r.name })}</span></div>
      <MdField tr={tr} value={s ? s.body : v.m.body} readOnly label={s ? tr('workflow.imp.viewer', { step }) : tr('workflow.imp.viewerAll')} onChange={() => {}} />
      <div className="fnote">{tr('workflow.imp.viewerNote', { step })}</div>
    </div></div>;
  }
  return <div className="wscrim"><div className="modal glass wide" role="dialog" aria-modal="true" aria-busy={v.k === 'read' || undefined} aria-label={tr('workflow.imp.title', { name })}>
    <div className="mh"><h2>{tr('workflow.imp.title', { name })}</h2></div>
    {v.k === 'read' ? <div className="fnote ld"><Icon n="loader" s={14} />{tr('workflow.imp.reading')}</div> : <>
      <div className="pathl">{v.dir} · {tr('workflow.imp.meta', { n: Object.keys(v.r.files).length, kb: kb(v.r.files) })}</div>
      <Preview tr={tr} r={v.r} m={v.m} onView={step => setV({ k: 'viewer', dir: v.dir, r: v.r, m: v.m, step })} />
    </>}
    <div className="mf"><button type="button" className="btn" onClick={onCancel}>{tr('common.cancel')}</button>
      <button type="button" className="btn pri" disabled={v.k !== 'preview' || v.r.errors.length > 0 || busy} onClick={() => void add()}>
        {busy ? <Icon n="loader" s={13} /> : null}{tr(busy ? 'workflow.imp.adding' : 'workflow.imp.add')}</button></div>
  </div></div>;
}
