// v2.5 §6 the Graph code dialogs over the Skills & MCP sheet: GR-upd (T5, the real numbers of `graph_impact`, worded by where the
// update starts) and GR-clean (T8, `graph_orphans` → `graph_clean` with exactly the roots the user saw). Both ask the engine
// when they open and show what they are counting at once.
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { GRAPH_NAME, type GraphImpact, type GraphOrphans, type GraphToolView } from '../../../shared/graph.ts';
import type { Command } from '../../../shared/protocol.ts';
import { tildePath } from '../lib/account-ui.ts';
import { code, codeParts, fmtSize, impactLines, type ImpactIcon } from '../lib/graph.ts';
import { errText, useT } from '../lib/i18n.tsx';
import { Icon, type IconName } from './icons.tsx';

/** A text whose marked params show mono or as a chip (lib/graph.ts `code` / `chip`). */
export const Rich = ({ text }: { text: string }): ReactElement =>
  <>{codeParts(text).map((p, i) => p.k === 'code' ? <code key={i}>{p.s}</code> : p.k === 'chip' ? <code key={i} className="chip">{p.s}</code> : p.s)}</>;

/** The engine's one-line install / update command ("Sẽ chạy:"). */
export const WillRun = ({ command }: { command: string }): ReactElement => {
  const tr = useT();
  return <div className="grwr"><span>{tr('graph.g0.willRun')}</span><code className="cmd"><i>$</i>{command}</code></div>;
};

type Send = (c: Command) => Promise<unknown>;

/** Ask once when the dialog opens: null while it counts, the answer, or the error text. */
function useAsk<T>(send: Send, cmd: Command): { data: T | null; err: string | null } {
  const tr = useT();
  const [s, setS] = useState<{ data: T | null; err: string | null }>({ data: null, err: null });
  useEffect(() => {
    let live = true;
    send(cmd).then(d => { if (live) setS({ data: d as T, err: null }); }, (e: unknown) => { if (live) setS({ data: null, err: errText(tr, e) }); });
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once per open
  return s;
}

function Shell({ label, title, children, foot, err }: { label: string; title: ReactNode; children: ReactNode; foot: ReactNode; err: string | null }): ReactElement {
  return (
    <div className="modal glass smd grd" role="dialog" aria-label={label}>
      <h2>{title}</h2>
      {children}
      {err ? <div className="err" role="alert"><Icon n="alert" s={14} /><span>{err}</span></div> : null}
      <div className="mf">{foot}</div>
    </div>
  );
}
const Counting = ({ text }: { text: string }): ReactElement => <p className="smload" role="status"><span className="spin sm" aria-hidden="true" />{text}</p>;

const IMPACT_ICON: Record<ImpactIcon, IconName> = { db: 'db', fork: 'fork', term: 'term', cpu: 'cpu', lock: 'lock' };

/** §6.1 GR-upd: title with the versions, one line per real number, "Sẽ chạy:", Huỷ / Cập nhật. */
/** `connected` false (engine lost): the primary is disabled (blocked, not an error after the press). */
export function GraphUpdateDialog({ tool, connected, send, onClose }: { tool: GraphToolView; connected: boolean; send: Send; onClose: () => void }): ReactElement {
  const tr = useT();
  const imp = useAsk<GraphImpact>(send, { cmd: 'graph_impact' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const from = tool.version ?? '';
  const versions = tool.latest ? `${from} → ${tool.latest}` : from;
  const go = () => { setBusy(true); send({ cmd: 'graph_update' }).then(onClose, (e: unknown) => { setErr(errText(tr, e)); setBusy(false); }); };
  return (
    <Shell label={tr('graph.upd.title', { tool: GRAPH_NAME, v: versions })} title={<Rich text={tr('graph.upd.title', { tool: GRAPH_NAME, v: code(versions) })} />} err={err ?? imp.err}
      foot={<><button className="btn" onClick={onClose}>{tr('common.cancel')}</button>
        <button className="btn pri" disabled={busy || !imp.data || !connected} onClick={go}>{busy ? <span className="spin sm" aria-hidden="true" /> : <Icon n="refresh" s={14} />} {tr('graph.upd.verb')}</button></>}>
      {imp.data ? <ul className="k6">{impactLines(tr, imp.data, tool.state === 'old' ? 'old' : 'ready', from).map(l =>
        <li key={l.i}><Icon n={IMPACT_ICON[l.i]} s={14} /><span><Rich text={l.text} /></span></li>)}</ul>
        : imp.err ? null : <Counting text={tr('graph.upd.counting')} />}
      {tool.command ? <WillRun command={tool.command} /> : null}
    </Shell>
  );
}

/** §6.1 GR-clean / GR-clean-list: the counts, kept / skipped lines, the folded list, Huỷ / Dọn n index. */
export function GraphCleanDialog({ connected, send, onClose }: { connected: boolean; send: Send; onClose: () => void }): ReactElement {
  const tr = useT();
  const o = useAsk<GraphOrphans>(send, { cmd: 'graph_orphans' });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const rows = o.data?.rows ?? [];
  const go = () => { setBusy(true); send({ cmd: 'graph_clean', roots: rows.map(r => r.root_path) }).then(onClose, (e: unknown) => { setErr(errText(tr, e)); setBusy(false); }); };
  const d = o.data;
  return (
    <Shell label={tr('graph.clean.title')} title={tr('graph.clean.title')} err={err ?? o.err}
      foot={<><button className="btn" onClick={onClose}>{tr('common.cancel')}</button>
        <button className="btn bad solid" disabled={busy || !rows.length || !connected} onClick={go}>{busy ? <span className="spin sm" aria-hidden="true" /> : <Icon n="trash" s={14} />} {tr('graph.clean.verb', { n: rows.length })}</button></>}>
      {d ? <>
        <ul className="k6">
          {rows.length ? <li><Icon n="trash" s={14} /><span>{tr('graph.clean.what', { n: rows.length, size: fmtSize(tr, d.bytes) })}</span></li>
            : <li><Icon n="circleCheck" s={14} /><span>{tr('graph.clean.none')}</span></li>}
          <li><Icon n="lock" s={14} /><span>{tr('graph.clean.kept', { n: d.kept })}</span></li>
          {d.skipped.n ? <li><Icon n="ban" s={14} /><span>{tr('graph.clean.skipped', { n: d.skipped.n })}</span></li> : null}
        </ul>
        {rows.length ? <button className="lnk grdisc" aria-expanded={open} onClick={() => setOpen(v => !v)}><Icon n={open ? 'chev' : 'chevR'} s={14} />{tr('graph.clean.list')}<span className="n">{rows.length}</span></button> : null}
        {open ? <div className="grol" role="table">
          <div className="grolh" role="row"><span role="columnheader">{tr('graph.clean.colPath')}</span><span role="columnheader">{tr('graph.clean.colSize')}</span></div>
          {rows.map(r => <div key={r.root_path} className="grolr" role="row"><span role="cell" title={tildePath(r.root_path)}>{tildePath(r.root_path)}</span><span role="cell">{fmtSize(tr, r.bytes)}</span></div>)}
        </div> : null}
      </> : o.err ? null : <Counting text={tr('graph.clean.finding')} />}
    </Shell>
  );
}
