// spec v2.9 §4.3 the panel of one step (WF2), fields in the order they are used: Tên · Loại (Áp cứng) · Lời dặn · Tin mở bước ·
// Skill bị chặn (Áp cứng) · Pha (Lane) · Thư mục tài liệu · Nhãn trong tab Tasks (folded) · Xoá bước. A built-in shows the
// same as plain text (§4.2); a key the canvas cannot rewrite safely (§10.2) is plain text + "sửa trong file".
import { useState, type ReactElement, type ReactNode } from 'react';
import type { Tr } from '../../../shared/i18n/core.ts';
import { LAST_PHASE, MAX_PHASES, PHASE_RE, STEP_TYPES, type StepType, type WorkflowEdit } from '../../../shared/workflows.ts';
import { isObj } from '../../../shared/json.ts';
import { Icon } from '../ui/icons.tsx';
import { removeStep, renameNew, stepName, type WfChange, type WfModel, type WfStep } from '../lib/workflow.ts';
import { MdField } from './MdField.tsx';
import { TypeIcon, WfIcon } from './wf-icons.tsx';

/** §4.3 the two layer tags: Áp cứng (lock) and Lời dặn (speech bubble), same grey; hover = the legend sentence. */
export function Tag({ tr, k }: { tr: Tr; k: 'hard' | 'soft' }): ReactElement {
  return <span className="tg3" title={tr(k === 'hard' ? 'workflow.legend.hardText' : 'workflow.legend.softText')}>
    <Icon n={k === 'hard' ? 'lock' : 'msg'} s={11} />{tr(k === 'hard' ? 'workflow.legend.hard' : 'workflow.legend.soft')}</span>;
}
export function FieldHead({ label, tag, right }: { label: string; tag?: ReactNode; right?: ReactNode }): ReactElement {
  return <div className="fgl">{label}{tag}{right ? <span className="rr">{right}</span> : null}</div>;
}
/** One line of text: an input committed on blur / Enter (Esc = back), or plain text when read-only. */
export function TextField(p: { value: string; ro: boolean; label: string; max?: number; mono?: boolean; placeholder?: string; onCommit: (v: string) => void }): ReactElement {
  const [v, setV] = useState(p.value);
  const [was, setWas] = useState(p.value);
  if (p.value !== was) { setWas(p.value); setV(p.value); }
  if (p.ro) return <div className={`rot${p.mono ? ' md' : ''}`}>{p.value || '—'}</div>;
  const commit = () => { if (v !== p.value) p.onCommit(v); };
  return <input className={`fld w${p.mono ? ' mono' : ''}`} value={v} maxLength={p.max} aria-label={p.label} placeholder={p.placeholder}
    onChange={e => setV(e.currentTarget.value)} onBlur={commit}
    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape' && v !== p.value) { e.stopPropagation(); setV(p.value); } }} />;
}
export const InFile = ({ tr }: { tr: Tr }) => <span className="tg3">{tr('workflow.panel.inFile')}</span>;

export interface StepPanelProps {
  tr: Tr; m: WfModel; s: WfStep; files: Readonly<Record<string, string>>; base: Readonly<Record<string, string>>;
  ro: boolean;
  /** installed skills (`plugin:name` / bare) for the Skill bị chặn picker, null = not known yet */
  skills: readonly string[] | null;
  edit: (edits: WorkflowEdit[]) => void;
  change: (c: WfChange) => void;
}

const kickoffOf = (s: WfStep): string => {
  const k = s.fm?.kickoff;
  return typeof k === 'string' ? k : isObj(k) && typeof k.new === 'string' ? k.new : '';
};

function DenyList({ tr, s, ro, skills, edit }: Pick<StepPanelProps, 'tr' | 's' | 'ro' | 'skills' | 'edit'>): ReactElement {
  const [pick, setPick] = useState('');
  const [why, setWhy] = useState('');
  const write = (list: WfStep['deny']) => edit([{ path: s.path, key: 'skills_deny', value: list.length ? list.map(d => (d.reason ? { skill: d.skill, reason: d.reason } : d.skill)) : undefined }]);
  const have = new Set(s.deny.map(d => d.skill));
  const free = (skills ?? []).filter(k => !have.has(k));
  return <>
    {s.deny.length ? <div className="skl">{s.deny.map(d => {
      return <div key={d.skill} className="sr">
        <span className="kx"><span className="k">{d.skill}</span></span>
        {d.reason ? <span className="why" title={d.reason}>{d.reason}</span> : null}
        {ro ? null : <button type="button" className="x" aria-label={tr('workflow.f.denyRemove', { skill: d.skill })} onClick={() => write(s.deny.filter(x => x.skill !== d.skill))}><Icon n="x" s={12} /></button>}
      </div>;
    })}</div> : <div className="fnote">{tr('workflow.f.denyNone')}</div>}
    {ro ? null : <div className="addr">
      <select className="fld" value={pick} aria-label={tr('workflow.f.denyPick')} onChange={e => setPick(e.currentTarget.value)}>
        <option value="">{tr('workflow.f.denyAdd')}</option>{free.map(k => <option key={k} value={k}>{k}</option>)}</select>
      <input className="fld" value={why} placeholder={tr('workflow.f.denyReason')} aria-label={tr('workflow.f.denyReason')} onChange={e => setWhy(e.currentTarget.value)} />
      <button type="button" className="btn sm" disabled={!pick} onClick={() => { write([...s.deny, { skill: pick, reason: why.trim() || null }]); setPick(''); setWhy(''); }}>
        <Icon n="plus" s={12} />{tr('workflow.f.denyPick')}</button>
    </div>}
  </>;
}

function Phases({ tr, s, ro, edit }: Pick<StepPanelProps, 'tr' | 's' | 'ro' | 'edit'>): ReactElement {
  const list = s.phases ?? [];
  const [name, setName] = useState('');
  const [drag, setDrag] = useState<number | null>(null);
  const write = (p: string[]) => edit([{ path: s.path, key: 'phases', value: p }]);
  const body = list.filter(p => p !== LAST_PHASE);
  const move = (from: number, to: number) => { const b = [...body]; const [x] = b.splice(from, 1); b.splice(to, 0, x!); write([...b, LAST_PHASE]); };
  const ok = PHASE_RE.test(name) && name !== LAST_PHASE && !list.includes(name) && list.length < MAX_PHASES;
  return <>
    <div className="phl">{list.map((p, i) => {
      const last = p === LAST_PHASE;
      return <div key={p} className={`pr2${last ? ' lk' : ''}`} draggable={!ro && !last} onDragStart={() => setDrag(i)} onDragEnd={() => setDrag(null)}
        onDragOver={e => { if (drag !== null && !last) e.preventDefault(); }} onDrop={() => { if (drag !== null && drag !== i) move(drag, i); setDrag(null); }}>
        {ro || last ? <Icon n="lock" s={11} /> : <span className="gr" title={tr('workflow.f.phaseDrag')}><WfIcon n="grip" s={12} /></span>}
        <span className="n2">{i + 1}</span>{p}
        {ro || last ? null : <button type="button" className="x" aria-label={tr('workflow.f.phaseRemove', { phase: p })} onClick={() => write(list.filter(x => x !== p))}><Icon n="x" s={11} /></button>}
      </div>;
    })}</div>
    {ro ? null : <div className="addr">
      <input className="fld mono" value={name} placeholder={tr('workflow.f.phaseNew')} aria-label={tr('workflow.f.phaseNew')} onChange={e => setName(e.currentTarget.value.trim())}
        onKeyDown={e => { if (e.key === 'Enter' && ok) { write([...body, name, LAST_PHASE]); setName(''); } }} />
      <button type="button" className="btn sm" disabled={!ok} onClick={() => { write([...body, name, LAST_PHASE]); setName(''); }}><Icon n="plus" s={12} />{tr('workflow.f.phaseAdd')}</button>
    </div>}
    {/* WF5 a hand-edited list that does not end in done: one click puts done last (the engine refuses the pack until then) */}
    {!ro && list.length && list[list.length - 1] !== LAST_PHASE ? <button type="button" className="lnk" onClick={() => write([...body, LAST_PHASE])}>
      <Icon n="plus" s={12} />{tr('workflow.f.phaseAddDone')}</button> : null}
  </>;
}

function Labels({ tr, s, ro, edit }: Pick<StepPanelProps, 'tr' | 's' | 'ro' | 'edit'>): ReactElement {
  const own = !!(s.labels.group || s.labels.waiting || s.labels.start);
  const [open, setOpen] = useState(false);
  const write = (k: 'group' | 'waiting' | 'start', v: string) => {
    const next = { ...s.labels, [k]: v.trim() || undefined };
    const kept = Object.fromEntries(Object.entries(next).filter(([, x]) => x));
    edit([{ path: s.path, key: 'labels', value: Object.keys(kept).length ? kept : undefined }]);
  };
  const lockedLabels = s.readOnly.includes('labels');
  return <div className="fg">
    <button type="button" className="fold" aria-expanded={open} onClick={() => setOpen(o => !o)}>
      <Icon n={open ? 'chev' : 'chevR'} s={12} />{tr('workflow.f.labels')} · {tr(own ? 'workflow.f.labelsOwn' : 'workflow.f.labelsAuto')}</button>
    {open ? <div className="lbr">{(['group', 'waiting', 'start'] as const).map(k => <LabelRow key={k} tr={tr} k={k} value={s.labels[k] ?? ''} ro={ro || lockedLabels} onCommit={v => write(k, v)} />)}</div> : null}
    {open && lockedLabels && !ro ? <InFile tr={tr} /> : null}
  </div>;
}
function LabelRow({ tr, k, value, ro, onCommit }: { tr: Tr; k: 'group' | 'waiting' | 'start'; value: string; ro: boolean; onCommit: (v: string) => void }): ReactElement {
  const label = tr(k === 'group' ? 'workflow.f.labelGroup' : k === 'waiting' ? 'workflow.f.labelWaiting' : 'workflow.f.labelStart');
  return <><span>{label}</span><TextField value={value} ro={ro} label={label} placeholder={tr('workflow.f.labelsAuto')} onCommit={onCommit} /></>;
}

export function StepPanel(p: StepPanelProps): ReactElement {
  const { tr, m, s, ro, edit, change } = p;
  const lockedKey = (k: string) => s.readOnly.includes(k);
  const connected = !!s.next || m.steps.some(x => x.next?.to === s.id) || s.type === 'general' || s.type === 'lane';
  const isNew = !(s.path in p.base);
  const rename = (name: string) => {
    const r = isNew ? renameNew(m, p.files, s.id, name) : null;
    if (!r) { edit([{ path: s.path, key: 'name', value: name.trim() || undefined }]); return; }
    change({ ...r, edits: [...r.edits, { path: `steps/${r.select}.md`, key: 'name', value: name.trim() }] });
  };
  const kick = kickoffOf(s);
  const setKick = (v: string) => {
    const k = s.fm?.kickoff;
    const rest = isObj(k) ? Object.fromEntries(Object.entries(k).filter(([x]) => x !== 'new')) : {};
    const value = v.trim() ? { ...rest, new: v.trim() } : Object.keys(rest).length ? rest : undefined;
    edit([{ path: s.path, key: 'kickoff', value }]);
  };
  return <div className="ppb" data-panel="step">
    <div className="fg">
      <FieldHead label={tr('workflow.f.name')} right={ro ? null : `${stepName(tr, s).length}/24`} />
      <TextField value={s.name} ro={ro || lockedKey('name')} label={tr('workflow.f.name')} max={24} onCommit={rename} />
    </div>
    <div className="fg">
      <FieldHead label={tr('workflow.f.type')} tag={<Tag tr={tr} k="hard" />} />
      {ro ? <div className="rot">{s.type ? tr(`workflow.type.${s.type}`) : '—'}</div>
        : <div className={`tys${connected ? ' lk' : ''}`} role="radiogroup" aria-label={tr('workflow.f.type')}>{STEP_TYPES.map((t: StepType) =>
          <button key={t} type="button" role="radio" aria-checked={s.type === t} className={s.type === t ? 'on' : ''} disabled={connected || t === 'general' || t === 'lane'}
            onClick={() => edit([{ path: s.path, key: 'type', value: t }])}><TypeIcon type={t} s={14} />{tr(`workflow.type.${t}`)}</button>)}</div>}
      <div className="fnote">{s.type ? tr(`workflow.typeHint.${s.type}`) : ''}{connected && !ro ? ` ${tr('workflow.typeHint.locked')}` : ''}</div>
    </div>
    <div className="fg">
      <FieldHead label={tr('workflow.f.body')} tag={<Tag tr={tr} k="soft" />} />
      <MdField key={`${s.id}:${ro ? 1 : 0}`} tr={tr} value={s.body} readOnly={ro} label={tr('workflow.f.body')} onChange={body => edit([{ path: s.path, body }])} />
    </div>
    {s.type === 'design' || s.type === 'build' || kick ? <div className="fg">
      <FieldHead label={tr('workflow.f.kickoff')} tag={<Tag tr={tr} k="soft" />} right={tr('workflow.f.kickoffHint')} />
      {lockedKey('kickoff') ? <><div className="rot">{kick || '—'}</div>{ro ? null : <InFile tr={tr} />}</>
        : <TextField value={kick} ro={ro} label={tr('workflow.f.kickoff')} placeholder={tr('workflow.f.kickoffEmpty')} onCommit={setKick} />}
    </div> : null}
    <div className="fg">
      <FieldHead label={tr('workflow.f.deny')} tag={<><span className="ct">{s.deny.length}</span><Tag tr={tr} k="hard" /></>} />
      <DenyList tr={tr} s={s} ro={ro || lockedKey('skills_deny')} skills={p.skills} edit={edit} />
      {lockedKey('skills_deny') && !ro ? <InFile tr={tr} /> : null}
    </div>
    {s.type === 'lane' ? <div className="fg">
      <FieldHead label={tr('workflow.f.phases')} tag={<Tag tr={tr} k="hard" />} right={tr('workflow.f.phasesHint', { n: s.phases?.length ?? 0, max: MAX_PHASES })} />
      <Phases tr={tr} s={s} ro={ro || lockedKey('phases')} edit={edit} />
    </div> : null}
    {s.type === 'design' ? <div className="fg">
      <FieldHead label={tr('workflow.f.docs')} tag={<Tag tr={tr} k="hard" />} />
      <TextField value={s.docs ?? ''} ro={ro || lockedKey('docs')} mono label={tr('workflow.f.docs')} onCommit={v => edit([{ path: s.path, key: 'docs', value: v.trim() || undefined }])} />
      <div className="fnote">{tr('workflow.f.docsHint')}</div>
    </div> : null}
    {s.type === 'design' || s.type === 'build' ? <Labels tr={tr} s={s} ro={ro} edit={edit} /> : null}
    {!ro && (s.type === 'design' || s.type === 'build') ? <div className="fg">
      <button type="button" className="btn sm bad" onClick={() => change(removeStep(m, s.id))}><WfIcon n="trash" s={13} />{tr('workflow.f.removeStep')}</button>
    </div> : null}
  </div>;
}
