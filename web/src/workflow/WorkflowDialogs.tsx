// spec v2.9 the Quy trình screen's dialogs: the name popover of "Nhân bản để sửa" (WF1b), "+ Quy trình mới" = describe it (WF14,
// §4.10) or pick a pack to copy (WF11, R9; "Trống" last), Bỏ nháp (§4.10), Xoá (WF10b, R12), the save conflict (WF5c) and leaving with unsaved changes (WF8c). The default button of each is
// the safe one (Tải lại, Ở lại) and holds the focus; Esc = Huỷ / Ở lại (the screen routes it).
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import type { Tr } from '../../../shared/i18n/core.ts';
import type { Command } from '../../../shared/protocol.ts';
import { BLANK_TEMPLATE, type WorkflowDetail, type WorkflowEditResult, type WorkflowRow } from '../../../shared/workflows.ts';
import { Icon } from '../ui/icons.tsx';
import { bodySize, edgeLabel, stepById, stepName, wfModel, type WfModel } from '../lib/workflow.ts';
import { TypeIcon } from './wf-icons.tsx';

function Dlg({ tr, title, wide, children }: { tr: Tr; title: string; wide?: boolean; children: ReactNode }): ReactElement {
  return <div className="wscrim"><div className={`modal glass${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title || tr('workflow.title')}>{children}</div></div>;
}

/** §4.8 / WF11 the chain in small: steps with the mini edge labels, then "+ Chung · Lane (n pha)". */
export function MiniChain({ tr, m }: { tr: Tr; m: WfModel }): ReactElement {
  return <div className="mini">
    <div className="ch">{m.chain.map(id => {
      const s = stepById(m, id)!;
      return <span key={id} className="ms"><span className="s"><TypeIcon type={s.type} s={13} />{stepName(tr, s)}</span><span className="a">{edgeLabel(tr, s, true)}</span></span>;
    })}<span className="s e"><Icon n="check" s={13} />{tr('workflow.done')}</span></div>
    <div className="lo">{tr('workflow.mini.more', { n: m.lane?.phases?.length ?? 0 })}</div>
  </div>;
}
/** The enabled rules in words (WF4 names, never the keys), "3 phiên tài liệu cùng lúc" last. */
export function rulesLine(tr: Tr, m: WfModel): string {
  const on = (Object.keys(m.rules.flags) as (keyof WfModel['rules']['flags'])[]).filter(k => m.rules.flags[k]).map(k => tr(`workflow.rule.${k}`));
  return [...on, tr('workflow.imp.maxRule', { n: m.rules.max })].join(' · ');
}
const packLines = (m: WfModel) => m.steps.reduce((n, s) => n + bodySize(s.body).lines, bodySize(m.body).lines);

export function ClonePop({ tr, row, files, onCancel, onCreate }: { tr: Tr; row: WorkflowRow; /** files in the pack */ files: number; onCancel: () => void; onCreate: (name: string) => Promise<void> }): ReactElement {
  const [name, setName] = useState(tr('workflow.copyName', { name: row.name }));
  const [busy, setBusy] = useState(false);
  const go = () => { if (!name.trim() || busy) return; setBusy(true); void onCreate(name.trim()).finally(() => setBusy(false)); };
  return <div className="pop" role="dialog" aria-label={tr('workflow.clone.title')}>
    <div className="fgl">{tr('workflow.clone.title')}</div>
    <input className="fld w" autoFocus value={name} aria-label={tr('workflow.clone.title')} onFocus={e => e.currentTarget.select()} onChange={e => setName(e.currentTarget.value)}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); go(); } else if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }} />
    <div className="fnote">{tr('workflow.clone.hint', { n: files })}</div>
    <div className="mf"><button type="button" className="btn sm" onClick={onCancel}>{tr('common.cancel')}</button>
      <button type="button" className="btn sm pri" disabled={!name.trim() || busy} onClick={go}>{busy ? <Icon n="loader" s={12} /> : null}{tr(busy ? 'workflow.create.busy' : 'workflow.clone.create')}</button></div>
  </div>;
}

/** WF14 / WF14b §4.10 the description box on top (Tạo / Enter opens an author draft; dimmed at 3 drafts). */
function Describe({ tr, full, note, onAuthor }: { tr: Tr; full: boolean; note: string; onAuthor: (text: string) => Promise<void> }): ReactElement {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const go = () => { const t = text.trim(); if (!t || busy || full) return; setBusy(true); void onAuthor(t).finally(() => setBusy(false)); };
  return <div className="wdesc">
    <div className="fgl">{tr('workflow.author.describe')}</div>
    <textarea className="fld w" rows={3} autoFocus disabled={full} value={text} placeholder={tr('workflow.author.describeHint')} aria-label={tr('workflow.author.describe')}
      onChange={e => setText(e.currentTarget.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); go(); } }} />
    <div className="dr"><span className="fnote">{full ? tr('workflow.author.limit') : note}</span>
      <button type="button" className="btn pri" disabled={full || busy || !text.trim()} title={full ? tr('workflow.author.limit') : undefined} onClick={go}>
        {busy ? <Icon n="loader" s={13} /> : null}{tr(busy ? 'workflow.author.creating' : 'workflow.author.create')}</button></div>
    <div className="orl"><span>{tr('workflow.author.or')}</span></div>
  </div>;
}

/** WF11 / WF14 the description box (author by prompt), then the packs to copy (built-ins first, then the user's), a preview of
 *  the picked one, its new name. */
export function CreateDialog({ tr, rows, send, full, note, onAuthor, onCancel, onCreate }: {
  tr: Tr; rows: readonly WorkflowRow[]; send: (c: Command) => Promise<unknown>;
  /** §6.2 WF14b 3 drafts open */ full: boolean; note: string; onAuthor: (text: string) => Promise<void>;
  onCancel: () => void; onCreate: (from: string, name: string) => Promise<void>;
}): ReactElement {
  const [from, setFrom] = useState(rows[0]?.id ?? '');
  const row = rows.find(r => r.id === from) ?? null;
  const blank = from === BLANK_TEMPLATE;
  const [name, setName] = useState(row ? tr('workflow.copyName', { name: row.name }) : '');
  const [m, setM] = useState<WfModel | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setM(null);
    if (!from) return;
    void (async () => {
      const d = await send({ cmd: 'workflow_get', id: from }) as WorkflowDetail;
      const r = await send({ cmd: 'workflow_edit', files: d.files, edits: [] }) as WorkflowEditResult;
      if (live) setM(wfModel(r.docs));
    })().catch(() => {});
    return () => { live = false; };
  }, [from, send]);
  const pick = (r: WorkflowRow) => { setFrom(r.id); setName(tr('workflow.copyName', { name: r.name })); };
  const pickBlank = () => { setFrom(BLANK_TEMPLATE); setName(tr('workflow.create.blankName')); };
  const go = () => { if (!name.trim() || !from || busy) return; setBusy(true); void onCreate(from, name.trim()).finally(() => setBusy(false)); };
  return <Dlg tr={tr} title={tr('workflow.create.title')} wide>
    <div className="mh"><h2>{tr('workflow.create.title')}</h2></div>
    <Describe tr={tr} full={full} note={note} onAuthor={onAuthor} />
    <div className="tpl">
      <div className="tl2" role="listbox" aria-label={tr('workflow.create.pick')}>{rows.map(r =>
        <button key={r.id} type="button" role="option" aria-selected={r.id === from} className={`tr3${r.id === from ? ' on' : ''}`} onClick={() => pick(r)}>
          <b>{r.builtin ? <Icon n="lock" s={12} /> : null}{r.name}</b><small>{r.description}</small></button>)}
        {/* R9 "Trống" last: copied only, never applied */}
        <button type="button" role="option" aria-selected={blank} className={`tr3${blank ? ' on' : ''}`} onClick={pickBlank}>
          <b>{tr('workflow.create.blank')}</b><small>{tr('workflow.create.blankSub')}</small></button></div>
      <div className="pv">
        {row ? <><div className="fgl">{row.name}</div><div className="fst">{row.description}</div></>
          : blank ? <><div className="fgl">{tr('workflow.create.blank')}</div><div className="fst">{tr('workflow.create.blankSub')}</div></> : null}
        {m ? <><MiniChain tr={tr} m={m} />
          <div className="kv2"><span>{tr('workflow.create.rules')}</span><span>{rulesLine(tr, m)}</span>
            <span>{tr('workflow.create.plugins')}</span><span>{m.plugins.join(', ') || tr('workflow.f.pluginNone')}</span>
            <span>{tr('workflow.create.body')}</span><span>{tr('workflow.create.bodyLine', { n: packLines(m), steps: m.steps.length })}</span></div></>
          : <div className="sk skl3" aria-busy="true" />}
        <div className="fgl">{tr('workflow.create.name')}</div>
        <input className="fld w" value={name} aria-label={tr('workflow.create.name')} onChange={e => setName(e.currentTarget.value)} onKeyDown={e => { if (e.key === 'Enter') go(); }} />
      </div>
    </div>
    <div className="mf"><button type="button" className="btn" onClick={onCancel}>{tr('common.cancel')}</button>
      <button type="button" className="btn pri" disabled={!name.trim() || !from || busy} onClick={go}>{busy ? <Icon n="loader" s={13} /> : null}{tr(busy ? 'workflow.create.busy' : 'workflow.create.ok')}</button></div>
  </Dlg>;
}

export function DeleteDialog({ tr, row, onCancel, onDelete }: { tr: Tr; row: WorkflowRow; onCancel: () => void; onDelete: () => Promise<void> }): ReactElement {
  const [busy, setBusy] = useState(false);
  return <Dlg tr={tr} title={tr('workflow.delete.title', { name: row.name })}>
    <div className="mh"><h2>{tr('workflow.delete.title', { name: row.name })}</h2></div>
    <p>{tr('workflow.delete.text')}</p>
    {row.dir ? <div className="pathl">{row.dir}</div> : null}
    <div className="mf"><button type="button" className="btn" autoFocus onClick={onCancel}>{tr('common.cancel')}</button>
      <button type="button" className="btn bad" disabled={busy} onClick={() => { setBusy(true); void onDelete().finally(() => setBusy(false)); }}>
        {busy ? <Icon n="loader" s={13} /> : null}{tr('workflow.delete.ok')}</button></div>
  </Dlg>;
}

export function ConflictDialog({ tr, name, busy, onCancel, onReload, onOverwrite }: { tr: Tr; name: string; busy: boolean; onCancel: () => void; onReload: () => void; onOverwrite: () => void }): ReactElement {
  const def = useRef<HTMLButtonElement>(null);
  useEffect(() => def.current?.focus(), []);
  return <Dlg tr={tr} title={tr('workflow.conflict.title')}>
    <div className="mh"><h2>{tr('workflow.conflict.title')}</h2></div>
    <p>{tr('workflow.conflict.text', { name })}</p>
    <p className="fnote">{tr('workflow.conflict.how')}</p>
    <div className="mf"><button type="button" className="btn" onClick={onCancel}>{tr('common.cancel')}</button>
      <button type="button" className="btn bad" disabled={busy} onClick={onOverwrite}>{tr('workflow.conflict.overwrite')}</button>
      <button type="button" ref={def} className="btn pri" disabled={busy} onClick={onReload}>{tr('workflow.conflict.reload')}</button></div>
  </Dlg>;
}

export function LeaveDialog({ tr, name, onStay, onLeave }: { tr: Tr; name: string; onStay: () => void; onLeave: () => void }): ReactElement {
  const def = useRef<HTMLButtonElement>(null);
  useEffect(() => def.current?.focus(), []);
  return <Dlg tr={tr} title={tr('workflow.leave.title')}>
    <div className="mh"><h2>{tr('workflow.leave.title')}</h2></div>
    <p>{tr('workflow.leave.text', { name })}</p>
    <div className="mf"><button type="button" className="btn bad" onClick={onLeave}>{tr('workflow.leave.discard')}</button>
      <button type="button" ref={def} className="btn pri" onClick={onStay}>{tr('workflow.leave.stay')}</button></div>
  </Dlg>;
}

/** §4.10 Bỏ nháp: "Ở lại" is the safe default. */
export function DiscardDraftDialog({ tr, onStay, onDiscard }: { tr: Tr; onStay: () => void; onDiscard: () => Promise<void> }): ReactElement {
  const def = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => def.current?.focus(), []);
  return <Dlg tr={tr} title={tr('workflow.author.discardTitle')}>
    <div className="mh"><h2>{tr('workflow.author.discardTitle')}</h2></div>
    <p>{tr('workflow.author.discardText')}</p>
    <div className="mf"><button type="button" className="btn bad" disabled={busy} onClick={() => { setBusy(true); void onDiscard().finally(() => setBusy(false)); }}>
      {busy ? <Icon n="loader" s={13} /> : null}{tr('workflow.author.discard')}</button>
      <button type="button" ref={def} className="btn pri" onClick={onStay}>{tr('workflow.author.stay')}</button></div>
  </Dlg>;
}
