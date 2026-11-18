// v2.7 §4.3 the issue list (IS2, IS6, IS9, IS10): the head (spec name — a button back to the overview, D99 — progress `8/13`
// and its grey line, Xem trên Deck · Bổ sung yêu cầu · Tài liệu ▾, the Tất cả / Bug / Task filter that folds
// to "Tất cả ▾" while a detail is open next to the three buttons; narrow: the spec menu + "⋯"), then the blocks in their
// fixed order (`issueBlocks`), rows 34 px: status icon, key, full title, `↑`, the right cluster (under the title when narrow).
import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import type { IssueInfo, SpecInfo } from '../../../shared/issues.ts';
import { useT } from '../lib/i18n.tsx';
import { isArising, issueBlocks, issuesOf, progressFor, type IssueBlock, type SpecSel } from '../lib/issues.ts';
import { Icon } from '../ui/icons.tsx';
import { clusterOf, filterIssues, headSub, showUp, specOfSel, type ClusterCtx, type IssueFilter } from './IssueList.model.ts';
import { DocsMenu } from './DocsList.tsx';
import { ProgressBar } from './ProgressBar.tsx';
import { SpecRail } from './SpecRail.tsx';
import type { TasksCtx } from './tasks-ctx.ts';
import './IssueList.css';
import { SplitStart } from './SplitStart.tsx';

type Tr = ReturnType<typeof useT>;
const FILTERS: readonly IssueFilter[] = ['all', 'bug', 'task'];
const FILTER_KEY = { all: 'tasks.list.filter.all', bug: 'tasks.list.filter.bug', task: 'tasks.list.filter.task' } as const;

/** §4.3 the filter folded while a detail is open: a "Tất cả ⌄" button like Tài liệu ▾ (UX M12), its menu keyboard-driven
 *  (Enter / Space opens, ↑ ↓ move, Esc / a click elsewhere closes). */
function FilterMenu({ c, filter, pick }: { c: TasksCtx; filter: IssueFilter; pick: (f: IssueFilter) => void }): ReactElement {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const { setPop } = c;
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    setPop(close);
    box.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const down = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) close(); };
    document.addEventListener('mousedown', down);
    return () => { setPop(null); document.removeEventListener('mousedown', down); };
  }, [open, setPop]);
  const step = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...(box.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  };
  return (
    <div className="lmenu" ref={box}>
      <button type="button" className="lfsel" aria-label={tr('tasks.list.filter.aria')} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        {tr(FILTER_KEY[filter])}<Icon n="chev" s={12} />
      </button>
      {open ? (
        <div className="lpop r lpf" role="menu" aria-label={tr('tasks.list.filter.aria')} onKeyDown={step}>
          {FILTERS.map(f => <button key={f} type="button" role="menuitemradio" aria-checked={filter === f} className={filter === f ? 'on' : undefined}
            onClick={() => { setOpen(false); pick(f); }}>{tr(FILTER_KEY[f])}</button>)}
        </div>
      ) : null}
    </div>
  );
}

/** §4.3 the status icon: empty = waiting, dashed = blocked, half = doing, full = done, struck = cancelled, orange half = unseen. */
function StatusIcon({ i, tr }: { i: IssueInfo; tr: Tr }): ReactElement {
  const k = isArising(i) ? 'new' : i.state === 'todo' ? (i.waitingOn.length ? 'blocked' : 'todo') : i.state;
  const label = tr(k === 'new' ? 'tasks.list.st.new' : k === 'blocked' ? 'tasks.list.st.blocked' : k === 'todo' ? 'tasks.list.st.todo'
    : k === 'doing' ? 'tasks.list.st.doing' : k === 'done' ? 'tasks.list.st.done' : 'tasks.list.st.cancelled');
  return (
    <svg className={`tsi ${k}`} width="14" height="14" viewBox="0 0 14 14" role="img" aria-label={label}>
      {k === 'done' ? <><circle cx="7" cy="7" r="6" className="fill" /><path d="M4.2 7.2l1.9 1.9 3.7-3.9" className="tick" /></>
        : k === 'cancelled' ? <><circle cx="7" cy="7" r="5.5" /><path d="M3.2 10.8l7.6-7.6" /></>
          : <><circle cx="7" cy="7" r="5.5" />{k === 'doing' || k === 'new' ? <path d="M7 1.5a5.5 5.5 0 0 1 0 11z" className="half" /> : null}</>}
    </svg>
  );
}

const BLOCK_KEY = { arising: 'tasks.list.block.arising', doing: 'tasks.list.block.doing', ready: 'tasks.list.block.ready', blocked: 'tasks.list.block.blocked',
  done: 'tasks.list.block.done', cancelled: 'tasks.list.block.cancelled' } as const;

export interface IssueListProps {
  c: TasksCtx; sel: SpecSel;
  /** the open issue (selected row) */
  open: string | null;
  /** a detail / overview stands next to the list (the progress bar hides) */
  side: boolean;
  /** D99 the spec name: back to the overview (wide) / the overview overlay (narrow) */
  onSpecName: () => void;
}

export function IssueList({ c, sel, open, side, onSpecName }: IssueListProps): ReactElement {
  const tr = useT();
  const [filter, setFilter] = useState<IssueFilter>('all');
  const [menu, setMenu] = useState<'spec' | 'more' | null>(null);
  const spec = specOfSel(c.pi, sel);
  const all = issuesOf(c.pi, sel);
  const p = progressFor(c.pi, sel);
  const building = spec?.state === 'active';
  const pickFilter = (f: IssueFilter) => { setFilter(f); if (c.ui.arising) c.setUi({ arising: false }); };
  // IS3b from the issues_new card: the Phát sinh block alone until the chip (or a filter / spec pick) clears it
  const blocks = issueBlocks(filterIssues(all, filter), { arising: c.ui.arising, doneOpen: c.ui.doneOpen }).filter(b => !c.ui.arising || b.block === 'arising');
  const cx: ClusterCtx = { tr, now: c.now, quotaAt: c.live.quotaAt, all: c.pi.issues };
  const folded = (b: IssueBlock) => (b === 'cancelled' ? !c.ui.cancelledOpen : c.ui.folded.includes(b));
  const fold = (b: IssueBlock) => (b === 'cancelled' ? c.setUi({ cancelledOpen: !c.ui.cancelledOpen })
    : c.setUi({ folded: c.ui.folded.includes(b) ? c.ui.folded.filter(x => x !== b) : [...c.ui.folded, b] }));
  // §4.3 while an issue detail is open (IS22: the overview keeps the three); UX I10 also while "đang bổ sung · Tới phiên"
  // shares the head with the overview, so the grey line and the spec name both stay readable
  const outsideName = c.wf.slots.docless ? c.wf.slots.outside : tr('tasks.list.outside'); // v2.9 §4.7 Giao thẳng: "Việc"
  const collapse = building && !c.narrow && (open !== null || (side && !!spec?.editing && !!spec.sessions.edit));

  return (
    <section className={`tlist${c.narrow ? ' nw' : ''}`} aria-label={tr('tasks.region.list')}>
      <header className="lhead">
        {c.narrow ? (
          <div className="lmenu">
            <button type="button" className="lspec" aria-haspopup="menu" aria-expanded={menu === 'spec'} title={tr('tasks.list.specMenu')}
              onClick={() => setMenu(m => (m === 'spec' ? null : 'spec'))}>
              {spec ? spec.title : outsideName}<Icon n="chev" s={12} />
            </button>
            {menu === 'spec' ? <div className="lpop" role="menu" onClick={e => { if ((e.target as Element).closest('.splitm')) setMenu(null); }}><SpecRail c={c} sel={sel} menu pick={s => { setMenu(null); c.setUi({ sel: s, issue: null, arising: false }); }} /></div> : null}
          </div>
        ) : spec && spec.state !== 'draft' && spec.state !== 'approved'
          ? <button type="button" className="lname" title={tr('tasks.list.toOverview')} onClick={onSpecName}>{spec.title}</button>
          : <b className="lname">{spec ? spec.title : outsideName}</b>}
        {spec && (c.narrow || !side) ? <ProgressBar p={p} finished={spec.state === 'done'} /> : null}
        {spec ? <span className="lnum">{p.done}/{p.total}</span> : null}
        <span className="lsub">{(spec ? ' · ' : '') + headSub(c.pi, sel, all, tr, c.now)}</span>
        <span className="lgap" />
        {building && spec ? <HeadActions c={c} spec={spec} narrow={c.narrow} menu={menu === 'more'} setMenu={o => setMenu(o ? 'more' : null)} /> : null}
        {c.ui.arising ? <button type="button" className="lchip" aria-pressed="true" title={tr('tasks.list.arisingOff')} onClick={() => c.setUi({ arising: false })}>
          {tr('tasks.list.block.arising')}<Icon n="x" s={11} /></button> : null}
        {collapse ? <FilterMenu c={c} filter={filter} pick={pickFilter} /> : (
          <div className="lseg" role="radiogroup" aria-label={tr('tasks.list.filter.aria')}>
            {FILTERS.map(f => <button key={f} type="button" role="radio" aria-checked={filter === f} className={filter === f ? 'on' : undefined} onClick={() => pickFilter(f)}>
              {tr(FILTER_KEY[f])}</button>)}
          </div>
        )}
      </header>
      <div className="lbody">
        {blocks.length ? blocks.map(b => (
          <div key={b.block} className="lblk" role="group" aria-label={tr(BLOCK_KEY[b.block])}>
            <button type="button" className="lbh" aria-expanded={!folded(b.block)} onClick={() => fold(b.block)}>
              <Icon n={folded(b.block) ? 'chevR' : 'chev'} s={11} />{tr(BLOCK_KEY[b.block])}<span>{b.block === 'done' ? b.issues.length + b.more : b.issues.length}</span>
            </button>
            {folded(b.block) ? null : <>
              {b.issues.map(i => {
                const cl = clusterOf(i, cx);
                return (
                  <button key={i.key} type="button" className={`lrow${open === i.key ? ' on' : ''}${i.state === 'cancelled' ? ' cx' : ''}`} aria-current={open === i.key || undefined}
                    data-key={i.key} onClick={() => c.setUi({ issue: i.key })}>
                    <StatusIcon i={i} tr={tr} />
                    <span className="k">{i.key}</span>
                    <span className="t">{i.title}</span>
                    {showUp(i, sel) ? <span className="up" title={tr('tasks.list.up')}>↑</span> : null}
                    <span className={`cl${cl.tone ? ' ' + cl.tone : ''}`}>{cl.text}</span>
                  </button>
                );
              })}
              {b.more ? <div className="lmrow"><i /><i /><button type="button" className="lnk" onClick={() => c.setUi({ doneOpen: true })}>{tr('tasks.list.more', { n: b.more })}</button></div> : null}
            </>}
          </div>
        )) : <p className="lempty">{tr('tasks.list.empty')}</p>}
      </div>
    </section>
  );
}

/** §4.3 / §4.8 the building spec's head buttons: Xem trên Deck · Bổ sung yêu cầu · Tài liệu ▾; while a Thiết kế session
 *  amends it, "đang bổ sung · Tới phiên" leads and Bổ sung yêu cầu goes (IS19); narrow → one "⋯" menu (IS10c). */
function HeadActions({ c, spec, narrow, menu, setMenu }: { c: TasksCtx; spec: SpecInfo; narrow: boolean; menu: boolean; setMenu: (o: boolean) => void }): ReactElement {
  const tr = useT();
  const toDeck = () => c.toDeck(spec.sessions.build ?? undefined);
  const amend = (direct: boolean) => c.start({ kind: 'amend', path: spec.path, spec: spec.title }, direct);
  const amendLock = c.locked ? tr('tasks.locked') : c.capFull ? tr('errors.sessionCap') : null;
  const amendName = tr('tasks.list.amendReq');
  const editing = spec.editing && spec.sessions.edit;
  if (narrow) {
    return (
      <div className="lmenu">
        <button type="button" className="lbtn icon" aria-label={tr('tasks.list.menu')} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
          ⋯
        </button>
        {menu ? (
          <div className="lpop r" role="menu">
            <button type="button" role="menuitem" onClick={() => { setMenu(false); toDeck(); }}><Icon n="workflow" s={13} />{tr('tasks.list.toDeck')}</button>
            {editing ? <button type="button" role="menuitem" onClick={() => { setMenu(false); c.toDeck(spec.sessions.edit!); }}><Icon n="pencil" s={13} />{tr('tasks.list.toSession')}</button>
              : <SplitStart menu="item" cls="" label={<><Icon n="pencil" s={13} />{amendName}</>} name={amendName} off={amendLock}
                onStart={() => { setMenu(false); amend(true); }} onPick={() => { setMenu(false); amend(false); }} />}
            <DocsMenu c={c} spec={spec} item />
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <>
      {editing ? <><span className="lamend">{tr('tasks.list.amending')} ·</span>
        <button type="button" className="lbtn" onClick={() => c.toDeck(spec.sessions.edit!)}>{tr('tasks.list.toSession')}</button></> : null}
      <button type="button" className="lbtn" onClick={toDeck}>{tr('tasks.list.toDeck')}</button>
      {editing ? null : <SplitStart cls="lbtn" label={amendName} name={amendName} off={amendLock} onStart={() => amend(true)} onPick={() => amend(false)} />}
      <DocsMenu c={c} spec={spec} />
    </>
  );
}
