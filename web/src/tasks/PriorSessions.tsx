// v2.7 §4.9 / §5.2-10 (IS17, D92) "Tiếp tục build" of a spec imported while it was being built outside cc-slaves: a popover
// anchored under the button. "Nhận phiên cũ" lists at most 5 recent Claude sessions that named the spec file (first line,
// last time in VN time, turns, folder); one still running elsewhere is dimmed and cannot be picked. "Build mới" opens a clean
// Build session. A very long session (`long`, > 400 turns) is not preselected: Build mới is. Either way the web goes to Deck
// on the new Build session.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { PriorSession, SpecInfo } from '../../../shared/issues.ts';
import type { Tr } from '../../../shared/i18n/core.ts';
import { fmtHmDay } from '../lib/format.ts';
import { useT } from '../lib/i18n.tsx';
import { SplitStart } from './SplitStart.tsx';
import type { TasksCtx } from './tasks-ctx.ts';

const PRIOR_SHOWN = 5;
/** the picked session id; null = Build mới */
export type PriorPick = string | null;

/** §4.9 the rows: at most 5, newest first. */
export const priorRows = (xs: readonly PriorSession[]): PriorSession[] => [...xs].sort((a, b) => b.lastAt - a.lastAt).slice(0, PRIOR_SHOWN);
/** §4.9 a row the PO may take: not running elsewhere (R-B6). */
const priorTakeable = (s: PriorSession): boolean => !s.runningElsewhere;
/** §4.9 the preselected choice: the newest takeable session that is not very long; none → Build mới. */
export function priorDefault(xs: readonly PriorSession[]): PriorPick {
  return priorRows(xs).find(s => priorTakeable(s) && !s.long)?.id ?? null;
}

/** "thư mục gốc" when the session ran at the project root, else "worktree <last folder>". */
export function priorWhere(cwd: string | null, root: string, tr: Tr): string {
  const norm = (p: string) => p.replace(/\/+$/, '');
  if (!cwd || norm(cwd) === norm(root)) return tr('tasks.prior.root');
  return tr('tasks.prior.worktree', { name: norm(cwd).split('/').pop() ?? cwd });
}

export function PriorSessions({ c, spec, anchor, onClose }: { c: TasksCtx; spec: SpecInfo; anchor: { current: HTMLElement | null }; onClose: () => void }): ReactElement {
  const tr = useT();
  const [rows, setRows] = useState<PriorSession[] | null>(null);
  const [pick, setPick] = useState<PriorPick>(null);
  const box = useRef<HTMLDivElement>(null);
  const { cmds, setPop } = c;
  useEffect(() => {
    let live = true;
    cmds.priorSessions(spec.path).then(xs => { if (!live) return; setRows(priorRows(xs)); setPick(priorDefault(xs)); }, () => { if (live) setRows([]); });
    return () => { live = false; };
  }, [cmds, spec.path]);
  useEffect(() => {
    setPop(onClose);
    const down = (e: MouseEvent) => { const t = e.target as Node; if (!box.current?.contains(t) && !anchor.current?.contains(t)) onClose(); };
    document.addEventListener('mousedown', down);
    return () => { setPop(null); document.removeEventListener('mousedown', down); };
  }, [onClose, setPop, anchor]);
  // v2.7.1 §4.2 SA6: either part closes the choice; main = Tự chọn + "Như phiên cũ" / the defaults, ▾ = the start dialog (SA6b)
  const go = (direct: boolean, s?: PriorSession) => {
    onClose();
    c.start({ kind: s ? 'resume' : 'build', path: spec.path, spec: spec.title,
      ...(s ? { resume: { id: s.id, label: tr('tasks.prior.label', { text: s.firstText, at: fmtHmDay(s.lastAt), turns: s.turns }), prior: { model: s.model, effort: s.effort } } } : {}) }, direct);
  };
  const offTip = c.locked ? tr('tasks.locked') : c.capFull ? tr('tasks.card.cap') : null;
  const taken = rows?.find(s => s.id === pick);
  const a = anchor.current?.getBoundingClientRect();
  const style = a ? { top: a.bottom + 8, left: Math.max(8, a.left) } : undefined;
  return (
    <div ref={box} className="ppop" data-pop="" role="dialog" aria-label={tr('tasks.prior.aria')} style={style}>
      {rows === null ? <p className="pload">{tr('tasks.prior.loading')}</p> : rows.length ? (
        <section className="pold">
          <h5>{tr('tasks.prior.title')}</h5>
          <div role="radiogroup" aria-label={tr('tasks.prior.title')}>
            {rows.map(s => {
              const can = priorTakeable(s);
              return (
                <label key={s.id} className={`prow${can ? '' : ' dim'}${pick === s.id ? ' on' : ''}`}>
                  <input type="radio" name="prior" value={s.id} checked={pick === s.id} disabled={!can} onChange={() => setPick(s.id)} />
                  <span>
                    <b>{s.firstText}</b>
                    <small>{tr('tasks.prior.meta', { at: fmtHmDay(s.lastAt), turns: s.turns, where: priorWhere(s.cwd, c.project.path, tr) })}</small>
                    {can ? s.long ? <small>{tr('tasks.prior.long')}</small> : null : <small>{tr('tasks.prior.running')}</small>}
                  </span>
                </label>
              );
            })}
          </div>
          <div className="pact">
            <span className="pdef">{tr('tasks.prior.defaults')}</span>
            <SplitStart cls={pick === null ? 'tbtn2' : 'tbtn'} label={tr('tasks.prior.take')} name={tr('tasks.prior.take')} off={offTip} disabled={!taken}
              onStart={() => go(true, taken)} onPick={() => go(false, taken)} />
          </div>
        </section>
      ) : null}
      <section className="pnew">
        <h5>{tr('tasks.prior.freeTitle')}</h5>
        <div className="pact">
          <span>{tr('tasks.prior.freshNote')}</span>
          <SplitStart cls={pick === null ? 'tbtn' : 'tbtn2'} label={tr('tasks.prior.fresh')} name={tr('tasks.prior.fresh')} off={offTip} disabled={rows === null}
            onStart={() => go(true)} onPick={() => go(false)} />
        </div>
        <p className="pfoot"><span className="kb">Esc</span>{tr('tasks.prior.foot')}</p>
      </section>
    </div>
  );
}
