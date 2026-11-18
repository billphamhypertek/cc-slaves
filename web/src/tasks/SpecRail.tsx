// v2.7 §4.3 the spec rail (240, IS2) — also the narrow window's spec menu (IS10b, same groups and order): head (project +
// "+ Spec mới"; v2.9 §4.1 the workflow chip under it), IS16 the one-time grey "Đã nhập n spec … · Ẩn" line, groups by the
// pack's steps (`specRail`, v2.9 §4.7: labels of each spec's rev; "Giao thẳng" = only "Việc", no "+"), "Bắt đầu build" on a
// Chờ build row with the §6 locks (engine down, 3 sessions, `after` not done → "sau v2.5"; a spec being edited shows grey
// "đang sửa" instead, IS18), "Xem thêm n" for Xong, the yellow "đang build dở ngoài cc-slaves" and the red "mất file" lines.
// Lock reasons are styled tooltips (LockTip, R-B19 M7). Selecting = neutral background (D90).
import type { ReactElement } from 'react';
import type { SpecInfo } from '../../../shared/issues.ts';
import { useT } from '../lib/i18n.tsx';
import { specRail, type RailGroup, type SpecSel } from '../lib/issues.ts';
import { Icon } from '../ui/icons.tsx';
import { specShort } from '../lib/traces.ts';
import { LockTip } from './LockTip.tsx';
import { ProgressBar } from './ProgressBar.tsx';
import { SplitStart } from './SplitStart.tsx';
import type { TasksCtx } from './tasks-ctx.ts';
import './SpecRail.css';

import { WfChip } from './WfChip.tsx';

const sameSel = (a: SpecSel | null, b: SpecSel) => (a === 'outside' || b === 'outside' ? a === b : a?.spec === b.spec);

/** §6 why "Bắt đầu build" is locked (null = it may run). */
function buildLock(s: SpecInfo, c: Pick<TasksCtx, 'locked' | 'capFull'>, tr: ReturnType<typeof useT>): string | null {
  if (s.after && s.after.state !== 'done') return tr('tasks.rail.afterWhy', { spec: specShort(s.after.title) });
  if (c.locked) return tr('tasks.locked');
  if (c.capFull) return tr('errors.sessionCap');
  return null;
}

/** `pick` selects a spec / Ngoài spec (the narrow menu closes on it). */
export function SpecRail({ c, sel, pick, menu = false }: { c: TasksCtx; sel: SpecSel | null; pick: (s: SpecSel) => void; menu?: boolean }): ReactElement {
  const tr = useT();
  const groups = specRail(c.pi, c.wf.slots, { doneOpen: c.ui.specDoneOpen });
  const build = (s: SpecInfo, direct: boolean) => c.start({ kind: 'build', path: s.path, spec: s.title }, direct);
  const form = menu ? 'rail' as const : undefined;
  const row = (s: SpecInfo, rg: RailGroup) => {
    const g = rg.group, start = rg.start ?? tr('tasks.rail.build');
    const on = sameSel(sel, { spec: s.id });
    const lock = g === 'ready' ? buildLock(s, c, tr) : null;
    const sub = s.missing ? <small className="bad">{tr('tasks.rail.missing')}</small>
      : s.outsideBuild && g === 'ready' ? <small className="warn">{tr('tasks.rail.outsideBuild')}</small> : null;
    return (
      <div key={s.id} className={`srow${on ? ' on' : ''}`}>
        <button type="button" className="sname" aria-current={on || undefined} onClick={() => pick({ spec: s.id })}>
          <span className="t">{s.title}</span>{sub}
        </button>
        {g === 'designing' ? <span className="sx">{tr('tasks.rail.draft')}</span> : null}
        {g === 'ready' && !s.outsideBuild ? (
          s.editing ? <span className="sx">{tr('tasks.rail.editing')}</span>
            : s.after && s.after.state !== 'done'
              ? <LockTip tip={lock}><span className="sbtn off">{tr('tasks.rail.after', { spec: specShort(s.after.title) })}</span></LockTip>
              : <SplitStart cls="sbtn" label={start} name={start} off={lock} menu={form} onStart={() => build(s, true)} onPick={() => build(s, false)} />
        ) : null}
        {g === 'building' ? <><ProgressBar p={s.progress} /><span className="sx n">{s.progress.done}/{s.progress.total}</span></> : null}
        {g === 'done' ? <span className="sx n">{s.progress.done}/{s.progress.total}</span> : null}
      </div>
    );
  };
  return (
    <div className={`srail${menu ? ' menu' : ''}`}>
      <div className="shead">
        <b>{c.project.name}</b>
        {c.wf.slots.docless ? null : <SplitStart cls="snew" label={<><Icon n="plus" s={13} />{tr('tasks.rail.newSpec')}</>} name={tr('tasks.rail.newSpec')} menu={form}
          off={c.locked ? tr('tasks.locked') : c.capFull ? tr('errors.sessionCap') : null} onStart={() => c.start({ kind: 'new' }, true)} onPick={() => c.start({ kind: 'new' }, false)} />}
      </div>
      <WfChip c={c} />
      <div className="sbody">
        {c.live.importNotice ? (
          <p className="simp"><span title={tr('tasks.rail.imported', { n: c.live.importNotice })}>{tr('tasks.rail.imported', { n: c.live.importNotice })}</span> · <button type="button" className="lnk" disabled={c.locked}
            onClick={() => { c.cmds.specImportHide().catch(() => {}); }}>{tr('tasks.rail.hide')}</button></p>
        ) : null}
        {groups.map(g => (
          <div key={`${g.group}:${g.label}`} className="sgrp" role="group" aria-label={g.label}>
            <h4>{g.label}</h4>
            {g.group === 'outside' ? (
              <div className={`srow${sameSel(sel, 'outside') ? ' on' : ''}`}>
                <button type="button" className="sname" aria-current={sameSel(sel, 'outside') || undefined} onClick={() => pick('outside')}>
                  <span className="t">{c.wf.slots.outsideRow}</span>
                </button>
                <span className="sx n">{g.open}</span>
              </div>
            ) : g.specs.map(s => row(s, g))}
            {g.more ? <button type="button" className="lnk smore" onClick={() => c.setUi({ specDoneOpen: true })}>{tr('tasks.rail.more', { n: g.more })}</button> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
