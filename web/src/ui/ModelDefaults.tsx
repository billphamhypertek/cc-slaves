// v2.4 §4.5 LM3 Cài đặt › Model (D55): the tier-3 default of §5.6 — rows Điều phối and Lane, cells Model / Effort, the
// resolved column. Lazy chunk with ModelMenu (its list hook, `modelMenu` catalog and model.css); each change applies at once.
import { useEffect, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import type { Command, ProjectView, SessionModels } from '../../../shared/protocol.ts';
import { shortEmail } from '../lib/format.ts';
import { errText, useT, type Tr } from '../lib/i18n.tsx';
import { EFFORTS, modelRows, type ModelRow } from '../lib/model-menu.ts';
import { modelDefaultsOf, modelDefaultsPatch, type ModelCell, type ModelDefaults } from '../lib/settings.ts';
import { ListFail, useModelList } from './ModelMenu.tsx';
import { Icon } from './icons.tsx';
import './model-defaults.css';

type Row = keyof ModelDefaults;
const ROWS: Row[] = ['orchestrator', 'lane'];

const listOf = (m: SessionModels | null) => (m && !m.unavailable ? m.models : null);
const find = (m: SessionModels | null, v: string | null | undefined) => (v ? listOf(m)?.find(x => x.value === v) ?? listOf(m)?.find(x => x.resolvedModel === v && x.value !== 'default') : undefined);

/** §5.6 tier 4 ("Theo Claude Code"): settings.json's model, else the plan's; settings.json's effort (null = not set). */
export interface Tier4 { model: string; name: string; src: 'claude' | 'plan'; effort: string | null }
/** §5.6 the `session_models` ack names tier 4 in its `claude*` fields, whatever tiers 2–3 decide. */
export function tier4Of(m: SessionModels | null): Tier4 | null {
  if (!m || m.unavailable || !m.claudeModel) return null;
  const name = find(m, m.claudeModel)?.displayName ?? m.claudeModel;
  return { model: m.claudeModel, name, src: m.claudeSource ?? 'plan', effort: m.claudeEffort ?? null };
}

export interface RowFacts {
  model: { label: string; dim: string | null; lacks: boolean };
  effort: { label: string; dim: string | null };
  /** the levels after "Theo Claude Code"; `on: false` = the row's model lacks it (dimmed, §4.2). */
  levels: { level: string; on: boolean }[];
  /** "Phiên / lane mới sẽ chạy": the resolved value and its source lines. */
  res: { main: string; small: string[] };
}

/** §4.5 LM3 one row: the cell labels, the effort levels of the row's model (tier 4 when "Theo Claude Code"), the resolved column. */
export function rowFacts(tr: Tr, row: Row, cell: ModelCell, m: SessionModels | null, t4: Tier4 | null, account: string): RowFacts {
  const by = tr('settings.model.byClaude'), list = listOf(m);
  const info = find(m, cell.model), lacks = cell.model !== null && list !== null && !info;
  const runs = cell.model === null ? find(m, t4?.model) : info;
  const levels = runs ? EFFORTS.map(level => ({ level, on: runs.effortLevels.includes(level) }))
    : list ? EFFORTS.map(level => ({ level, on: true })) : cell.effort ? [{ level: cell.effort, on: true }] : [];
  const name = cell.model === null ? t4?.name ?? by : info?.displayName ?? cell.model;
  // §5.6 no effort picked → Claude Code's (settings.json), when the model it runs has that level
  const t4Effort = t4?.effort && (!runs || runs.effortLevels.includes(t4.effort)) ? t4.effort : null, effort = cell.effort ?? t4Effort;
  const small = [
    ...(cell.model === null && t4 ? [tr(t4.src === 'claude' ? 'settings.model.srcFile' : 'settings.model.srcPlan')] : []),
    ...(lacks ? [tr('settings.model.lacks', { account })] : []),
    ...(row === 'lane' ? [tr('settings.model.laneNote')] : []),
  ];
  return {
    model: cell.model === null ? { label: by, dim: t4?.name ?? null, lacks: false } : { label: info?.displayName ?? cell.model, dim: null, lacks },
    effort: cell.effort ? { label: cell.effort, dim: null } : { label: by, dim: t4Effort }, levels,
    res: { main: effort ? `${name} · ${effort}` : name, small },
  };
}

/** §4.4 rule: a model change keeps the effort unless the model it runs is known to lack it. */
export function nextCell(m: SessionModels | null, t4: Tier4 | null, cell: ModelCell, ch: { model?: string | null; effort?: string | null }): ModelCell {
  if (ch.model === undefined) return { model: cell.model, effort: ch.effort ?? null };
  const runs = find(m, ch.model ?? t4?.model);
  return { model: ch.model, effort: cell.effort && runs && !runs.effortLevels.includes(cell.effort) ? null : cell.effort };
}

interface Opt { value: string | null; label: string; name?: string; code?: string; off?: boolean; older?: boolean }

/** a field that opens a list under it (fixed, in the window: the Settings body clips its children), like §4.4 ModelPick. */
function Drop(p: { label: string; dim: string | null; lack?: boolean; aria: string; opts: Opt[]; olderN: number; value: string | null; ro: boolean; onPick: (v: string | null) => void }): ReactElement {
  const tr = useT();
  const [open, setOpen] = useState<{ left: number; top: number; width: number } | null>(null), [olderOpen, setOlderOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!(e.target as Element | null)?.closest('.mpop, .mpick')) setOpen(null); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); setOpen(null); } };
    document.addEventListener('mousedown', down); window.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', down); window.removeEventListener('keydown', key, true); };
  }, [open]);
  const olderShown = olderOpen || p.opts.some(o => o.older && o.value === p.value);
  const row = (o: Opt) => <button type="button" key={o.value ?? ''} role="option" aria-selected={o.value === p.value} disabled={o.off || undefined}
    className={`mrow${o.value === p.value ? ' pick' : ''}`} onClick={() => { setOpen(null); if (o.value !== p.value) p.onPick(o.value); }}>
    <span className="mk">{o.value === p.value ? <Icon n="check" s={12} /> : null}</span><b>{o.label}</b>
    <span className="mx">{o.name ? <span className="mn">{o.name}</span> : null}{o.code ? <code>{o.code}</code> : null}</span></button>;
  return <>
    <button type="button" className={`field mpick${p.lack ? ' lack' : ''}`} aria-label={p.aria} aria-haspopup="listbox" aria-expanded={!!open} disabled={p.ro || undefined}
      onClick={e => { const b = e.currentTarget.getBoundingClientRect(); setOpen(o => (o ? null : { left: b.left, top: b.bottom + 4, width: Math.max(b.width, 340) })); }}>
      <span className="mdl"><span>{p.label}</span>{p.dim ? <span className="mut">{p.dim}</span> : null}</span><i className="car" aria-hidden="true">▾</i></button>
    {open ? createPortal(<div className="mpop mdpop glass mlist" role="listbox" aria-label={p.aria} style={open}>
      {p.opts.filter(o => !o.older).map(row)}
      {p.olderN ? <button type="button" className="mrow grp" aria-expanded={olderShown} onClick={() => setOlderOpen(x => !x)}>
        <span className="mk" /><b>{tr('modelMenu.older', { n: p.olderN })}</b><i className="car" aria-hidden="true">{olderShown ? '▾' : '▸'}</i></button> : null}
      {olderShown ? p.opts.filter(o => o.older).map(row) : null}
    </div>, document.body) : null}
  </>;
}

/** the Model field's rows: "Theo Claude Code (<tier 4>)", the aliases, "Model cũ hơn"; a stored model the list lacks stays. */
function modelOpts(tr: Tr, m: SessionModels | null, t4: Tier4 | null, cell: ModelCell): Opt[] {
  const first: Opt = { value: null, label: tr('settings.model.byClaude'), name: t4?.name, code: t4 ? tr(t4.src === 'claude' ? 'modelMenu.srcFile' : 'modelMenu.srcPlan') : undefined };
  const rows = m && !m.unavailable ? modelRows(tr, m) : null;
  const opt = (older: boolean) => (r: ModelRow): Opt => ({ value: r.value, label: r.label, code: r.code, older });
  const out = [first, ...(rows?.top.slice(1).map(opt(false)) ?? []), ...(rows?.older.map(opt(true)) ?? [])];
  return cell.model !== null && !out.some(o => o.value === cell.model) ? [...out, { value: cell.model, label: cell.model }] : out;
}

export interface DefaultsBodyProps {
  cur: ModelDefaults; models: SessionModels | null; loading: boolean; t4: Tier4 | null;
  /** the list's account (short) and project; null = no project */
  account: string | null; project: string | null;
  ro: boolean; err: string | null;
  onCell: (row: Row, ch: { model?: string | null; effort?: string | null }) => void; onRetry: () => void;
}

/** §4.5 LM3 the tab body (static: state comes from props). */
export function DefaultsBody(p: DefaultsBodyProps): ReactElement {
  const tr = useT();
  const fail = !p.loading && (!p.models || !!p.models.unavailable);
  const older = p.models && !p.models.unavailable ? modelRows(tr, p.models).older.length : 0;
  const [impA, impB] = tr('settings.model.impact', { file: '\n' }).split('\n'); // the path set in mono
  return (
    <div className="mdef">
      <div><h3>{tr('settings.model.title')}</h3><div className="foot">{tr('settings.model.sub')}</div></div>
      <table className="t mdt"><thead><tr><th className="mdr" /><th>{tr('modelMenu.model')}</th><th>{tr('modelMenu.effort')}</th><th>{tr('settings.model.th.res')}</th></tr></thead>
        <tbody>{ROWS.map(row => {
          const cell = p.cur[row], f = rowFacts(tr, row, cell, p.models, p.t4, p.account ?? ''), rowName = tr(`settings.model.row.${row}`);
          const effortOpts: Opt[] = [{ value: null, label: tr('settings.model.byClaude') }, ...f.levels.map(l => ({ value: l.level, label: l.level, off: !l.on }))];
          return <tr key={row}><td className="mdr"><b>{rowName}</b></td>
            <td><Drop label={f.model.label} dim={f.model.dim} lack={f.model.lacks} aria={tr('settings.model.aria', { field: tr('modelMenu.model'), row: rowName })}
              opts={modelOpts(tr, p.models, p.t4, cell)} olderN={older} value={cell.model} ro={p.ro} onPick={v => p.onCell(row, { model: v })} /></td>
            <td><Drop label={f.effort.label} dim={f.effort.dim} aria={tr('settings.model.aria', { field: tr('modelMenu.effort'), row: rowName })}
              opts={effortOpts} olderN={0} value={cell.effort} ro={p.ro} onPick={v => p.onCell(row, { effort: v })} /></td>
            <td className="res wr"><span>{f.res.main}</span>{f.res.small.map(s => <small key={s}>{s}</small>)}</td></tr>;
        })}</tbody></table>
      <div className="mnt"><Icon n="info" s={12} /><span>{impA}<span className="mono">~/.claude/settings.json</span>{impB}</span></div>
      {fail ? <ListFail ro={p.ro} onRetry={p.onRetry} />
        : p.account && p.project ? <div className="mnt"><Icon n="list" s={12} /><span>{tr('settings.model.listOf', { account: p.account, project: p.project })}</span></div> : null}
      {p.ro ? <div className="mro"><Icon n="wifi" s={12} /><span>{tr('settings.model.offline')}</span></div> : null}
      {p.err ? <div className="err"><Icon n="alert" s={14} /><span>{p.err}</span></div> : null}
    </div>
  );
}

export interface ModelDefaultsProps {
  config: unknown; project: ProjectView | null; connected: boolean;
  send: (c: Command) => Promise<unknown>;
}

/** §4.5 LM3: the list of the project's orchestrator account, read when the tab opens; a change = one `config_update`
 *  with the whole `modelDefaults` (R40 M6), shown at once and taken back if the engine refuses it. */
export default function ModelDefaultsTab(p: ModelDefaultsProps): ReactElement {
  const tr = useT();
  const pid = p.project?.id ?? null;
  const { models, loading, retry } = useModelList(`set:${pid ?? ''}`, () => (pid ? p.send({ cmd: 'session_models', projectId: pid }) : Promise.reject(new Error('no project'))));
  const saved = modelDefaultsOf(p.config), savedKey = JSON.stringify(saved);
  const [cur, setCur] = useState(saved), [err, setErr] = useState<string | null>(null);
  useEffect(() => setCur(saved), [savedKey]); // eslint-disable-line react-hooks/exhaustive-deps -- the engine's echo
  const t4 = tier4Of(models);
  const onCell = (row: Row, ch: { model?: string | null; effort?: string | null }) => {
    const next = modelDefaultsPatch(cur, row, nextCell(models, t4, cur[row], ch));
    setCur(next.modelDefaults); setErr(null);
    p.send({ cmd: 'config_update', patch: next }).catch((e: unknown) => { setCur(saved); setErr(errText(tr, e)); });
  };
  const acc = p.project?.orchestratorAccount ?? null;
  return <DefaultsBody cur={cur} models={models} loading={loading} t4={t4} account={acc ? shortEmail(acc) : null} project={p.project?.name ?? null}
    ro={!p.connected} err={err} onCell={onCell} onRetry={retry} />;
}
