// spec v2.9 §4.5 Cài đặt quy trình (nothing selected, WF4): Tên, Mô tả, Tên gọi tài liệu, Plugin bắt buộc, Luật (§5.7: four
// switches + one number, each with its sentence + Áp cứng), the base-rules line, Lời dặn chung. A built-in: plain text, rules
// "Bật" / "Tắt" (§4.2).
import { useState, type ReactElement } from 'react';
import type { Tr } from '../../../shared/i18n/core.ts';
import { BOOL_RULES, MAX_DOC_SESSIONS, type BoolRule, type WorkflowEdit } from '../../../shared/workflows.ts';
import { Icon } from '../ui/icons.tsx';
import { WF_FILE, type WfModel } from '../lib/workflow.ts';
import { MdField } from './MdField.tsx';
import { FieldHead, InFile, Tag, TextField } from './StepPanel.tsx';
import { WfIcon } from './wf-icons.tsx';

export interface SettingsProps {
  tr: Tr; m: WfModel; ro: boolean;
  /** installed plugin names (`superpowers`), null = not known yet */
  plugins: readonly string[] | null;
  edit: (edits: WorkflowEdit[]) => void;
}

function Rules({ tr, m, ro, edit }: Omit<SettingsProps, 'plugins'>): ReactElement {
  const { flags, max } = m.rules;
  const write = (f: Record<BoolRule, boolean>, n: number) => edit([{ path: WF_FILE, key: 'rules', value: { ...f, max_doc_sessions: n } }]);
  const clamp = (n: number) => Math.min(MAX_DOC_SESSIONS.max, Math.max(MAX_DOC_SESSIONS.min, n));
  return <div className="rl">
    {BOOL_RULES.map(k => <div key={k} className="rw">
      <div className="tx"><div className="t1">{tr(`workflow.rule.${k}`)}</div><div className="t2">{tr(`workflow.rule.${k}.hint`)}</div></div>
      {ro ? <span className="rov">{tr(flags[k] ? 'workflow.panel.on' : 'workflow.panel.off')}</span>
        : <button type="button" className={`sw${flags[k] ? ' on' : ''}`} role="switch" aria-checked={flags[k]} aria-label={tr(`workflow.rule.${k}`)}
          onClick={() => write({ ...flags, [k]: !flags[k] }, max)}><i /></button>}
    </div>)}
    <div className="rw">
      <div className="tx"><div className="t1">{tr('workflow.rule.max')}</div><div className="t2">{tr('workflow.rule.max.hint')}</div></div>
      {ro ? <span className="rov">{max}</span> : <span className="stp" role="group" aria-label={tr('workflow.rule.max')}>
        <button type="button" aria-label={tr('workflow.rule.less')} disabled={max <= MAX_DOC_SESSIONS.min} onClick={() => write(flags, clamp(max - 1))}><WfIcon n="minus" s={12} /></button>
        <b aria-live="polite">{max}</b>
        <button type="button" aria-label={tr('workflow.rule.more')} disabled={max >= MAX_DOC_SESSIONS.max} onClick={() => write(flags, clamp(max + 1))}><Icon n="plus" s={12} /></button>
      </span>}
    </div>
  </div>;
}

function Plugins({ tr, m, ro, plugins, edit }: SettingsProps): ReactElement {
  const [pick, setPick] = useState('');
  const write = (list: string[]) => edit([{ path: WF_FILE, key: 'require_plugins', value: list.length ? list : undefined }]);
  if (ro) return <div className="rot">{m.plugins.join(', ') || tr('workflow.f.pluginNone')}</div>;
  const free = (plugins ?? []).filter(x => !m.plugins.includes(x));
  return <div className="chips">
    {m.plugins.map(x => <span key={x} className="chp">{x}<button type="button" className="x" aria-label={tr('workflow.f.pluginRemove', { plugin: x })} onClick={() => write(m.plugins.filter(y => y !== x))}><Icon n="x" s={11} /></button></span>)}
    {free.length ? <select className="fld" value={pick} aria-label={tr('workflow.f.pluginAdd')} onChange={e => { const v = e.currentTarget.value; setPick(''); if (v) write([...m.plugins, v]); }}>
      <option value="">{tr('workflow.f.pluginAdd')}</option>{free.map(x => <option key={x} value={x}>{x}</option>)}</select> : null}
  </div>;
}

export function WorkflowSettings(p: SettingsProps): ReactElement {
  const { tr, m, ro, edit } = p;
  const locked = (k: string) => m.wfReadOnly.includes(k);
  const set = (key: string) => (v: string) => edit([{ path: WF_FILE, key, value: v.trim() || undefined }]);
  return <div className="ppb" data-panel="settings">
    <div className="fg"><FieldHead label={tr('workflow.f.name')} />
      <TextField value={m.name} ro={ro || locked('name')} label={tr('workflow.f.name')} onCommit={set('name')} /></div>
    <div className="fg"><FieldHead label={tr('workflow.f.description')} right={tr('workflow.f.descriptionHint')} />
      <TextField value={m.description} ro={ro || locked('description')} label={tr('workflow.f.description')} onCommit={set('description')} /></div>
    <div className="fg2">
      <div className="fg"><FieldHead label={tr('workflow.f.docLabel')} />
        <TextField value={m.docLabel} ro={ro || locked('doc_label')} label={tr('workflow.f.docLabel')} placeholder={tr('workflow.f.docLabelHint')} onCommit={set('doc_label')} /></div>
      <div className="fg"><FieldHead label={tr('workflow.f.plugins')} />
        <Plugins {...p} ro={ro || locked('require_plugins')} /></div>
    </div>
    <div className="fg"><FieldHead label={tr('workflow.f.rules')} tag={<Tag tr={tr} k="hard" />} />
      <Rules tr={tr} m={m} ro={ro || locked('rules')} edit={edit} />
      {locked('rules') && !ro ? <InFile tr={tr} /> : null}
      <div className="fnote">{tr('workflow.f.rulesBase')}</div></div>
    <div className="fg"><FieldHead label={tr('workflow.f.wfBody')} tag={<Tag tr={tr} k="soft" />} />
      <MdField key={ro ? 'ro' : 'rw'} tr={tr} value={m.body} readOnly={ro} label={tr('workflow.f.wfBody')} onChange={body => edit([{ path: WF_FILE, body }])} /></div>
  </div>;
}
