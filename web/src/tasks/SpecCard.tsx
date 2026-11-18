// v2.7 §4.3 / §4.7 / §4.8 / §4.9 (IS14, IS15, IS17, IS18, D85 D86 D89 D92 D93) the spec card: the middle region when a spec
// Đang thiết kế / Chờ build is picked. Head (name, state line: nháp · nhập từ docs/specs · đang sửa · đang build dở ngoài
// cc-slaves · mất file · làm sau …), the table (Nhóm việc, Phiên Thiết kế, Duyệt, Làm sau, Nhánh), Tài liệu, then the §4.8
// buttons by state. Bắt đầu build / Sửa spec / Mở phiên open a session and the web goes to Deck on it (no confirm, §4.7).
// Locks (§6): offline (IS8c), 3 Thiết kế / Build sessions (IS13b, R34), `after` not done ("sau v2.5"), being edited (IS18).
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { type SpecInfo } from '../../../shared/issues.ts';
import type { Tr } from '../../../shared/i18n/core.ts';
import { fmtHmDay } from '../lib/format.ts';
import { useT } from '../lib/i18n.tsx';
import { DocsBlock } from './DocsList.tsx';
import { PriorSessions } from './PriorSessions.tsx';
import { SplitStart } from './SplitStart.tsx';
import type { TasksCtx } from './tasks-ctx.ts';

type Act = 'open' | 'build' | 'resume' | 'edit';
interface CardBtn { act: Act; primary: boolean; off: string | null }
export interface CardModel {
  btns: CardBtn[];
  /** IS18 "đang sửa spec · Tới phiên" (the Thiết kế session editing it) */
  editingGoto: string | null;
  /** the line right of the buttons: the hint, or why they are locked */
  note: string;
  /** IS15 `after` not done: the grey "sau v2.5" chip replaces Bắt đầu build */
  afterChip: string | null;
  /** §4.8 "⋯ → Đánh dấu" (imported, never built in cc-slaves) */
  mark: boolean;
}

/** "v2.5 Toolkit graph" → "v2.5" (the chip and the short "sau …" words). */
const shortTitle = (t: string): string => t.split(/\s+/)[0] ?? t;
const running = (c: Pick<TasksCtx, 'sessions'>, id: string | null) => !!id && c.sessions.some(o => o.sessionId === id);

/** §4.8 the buttons of a Đang thiết kế / Chờ build card and their locks. */
export function cardModel(spec: SpecInfo, c: Pick<TasksCtx, 'sessions' | 'capFull' | 'locked' | 'pi'>, tr: Tr): CardModel {
  const lock = c.locked ? tr('tasks.locked') : c.capFull ? tr('tasks.card.cap') : null;
  const mark = spec.origin === 'imported' && !spec.resumed && spec.openedAt === null && spec.sessions.build === null;
  if (spec.state === 'draft') {
    const live = running(c, spec.sessions.design); // UX I7: a live session's "Tới phiên" is on its table row only
    const btns: CardBtn[] = live ? [] : [{ act: 'open', primary: true, off: lock }];
    return { btns, editingGoto: null, note: !live && lock ? lock : tr('tasks.card.hint.design'), afterChip: null, mark };
  }
  const editing = spec.editing && spec.sessions.edit ? spec.sessions.edit : null;
  const after = spec.after && spec.after.state !== 'done' ? spec.after : null;
  const resume = spec.outsideBuild && !spec.resumed;
  if (after) {
    const left = c.pi.specs.find(s => s.id === after.id)?.progress;
    const n = left ? left.total - left.done : 0;
    const short = shortTitle(after.title);
    return {
      btns: [{ act: 'edit', primary: false, off: editing ? tr('tasks.card.editingLock') : lock }], editingGoto: editing,
      note: tr('tasks.card.afterNote', { title: after.title, n, short }), afterChip: tr('tasks.card.afterChip', { short }), mark,
    };
  }
  const buildOff = c.locked ? lock : editing ? tr('tasks.card.editingLock') : lock;
  const btns: CardBtn[] = [{ act: resume ? 'resume' : 'build', primary: true, off: buildOff }];
  if (!editing) btns.push({ act: 'edit', primary: false, off: lock });
  const note = editing ? '' : lock ?? tr(resume ? 'tasks.card.hint.resume' : 'tasks.card.hint.build');
  return { btns, editingGoto: editing, note, afterChip: null, mark };
}

/** The state line under the name: state · nháp / nhập từ docs/specs · đang sửa · đang build dở … (yellow) · mất file (red) · làm sau. */
function SubLine({ spec, state, tr }: { spec: SpecInfo; state: string; tr: Tr }): ReactElement {
  const parts: ReactElement[] = [<span key="s">{state}</span>];
  if (spec.origin === 'imported') parts.push(<span key="i">{tr('tasks.card.imported')}</span>);
  else if (spec.state === 'draft') parts.push(<span key="d">{tr('tasks.card.draft')}</span>);
  if (spec.editing) parts.push(<span key="e">{tr('tasks.card.editing')}</span>);
  if (spec.outsideBuild && !spec.resumed) parts.push(<span key="o" className="warn">{tr('tasks.card.outsideBuild')}</span>);
  if (spec.missing) parts.push(<span key="m" className="bad">{tr('tasks.card.missing')}</span>);
  if (spec.after && spec.after.state !== 'done') parts.push(<span key="a">{tr('tasks.card.afterSub', { short: shortTitle(spec.after.title) })}</span>);
  return <p className="ssub">{parts.flatMap((p, i) => (i ? [<span key={`d${i}`}> · </span>, p] : [p]))}</p>;
}

/** §4.3 the card's table: Nhóm việc (Chờ build), Phiên Thiết kế, Duyệt, Làm sau, Nhánh (Chờ build). */
function cardRows(spec: SpecInfo, c: Pick<TasksCtx, 'sessions' | 'toDeck'>, tr: Tr): [string, ReactElement | string][] {
  const L = (k: string) => tr(`tasks.card.${k}` as Parameters<Tr>[0]);
  const rows: [string, ReactElement | string][] = [];
  if (spec.state === 'approved' && spec.groups) rows.push([L('row.groups'), <>{spec.groups} <small>{L(spec.outsideBuild && !spec.resumed ? 'groupsNoteResume' : 'groupsNote')}</small></>]);
  const sid = spec.sessions.edit ?? spec.sessions.design;
  const o = sid ? c.sessions.find(x => x.sessionId === sid) : undefined;
  const title = o?.title ?? L('design.untitled');
  const design = !sid ? L('design.none') : o ? tr('tasks.card.design.open', { title }) : tr('tasks.card.design.closed', { title });
  rows.push([L('row.design'), spec.state === 'draft' && o ? <>{design} <button type="button" className="tbtn2 sm" onClick={() => c.toDeck(sid!)}>{L('act.goto')}</button></> : design]);
  rows.push([L('row.approved'), spec.state === 'draft' ? L('approved.no') : spec.approvedAt === null ? L('approved.imported') : fmtHmDay(spec.approvedAt)]);
  rows.push([L('row.after'), spec.after ? tr('tasks.card.after.of', { title: spec.after.title, state: tr(`tasks.card.state.${spec.after.state}`) }) : L(spec.state === 'approved' ? 'after.free' : 'after.none')]);
  if (spec.state === 'approved') rows.push([L('row.branch'), <code>{spec.branch ?? 'main'}</code>]);
  return rows;
}

type Mark = 'draft' | 'approved';
/** §4.8 a pick in "Đánh dấu": the current state changes nothing (UX I8 — it is shown checked, not disabled). */
export const markPick = (current: SpecInfo['state'], send: (s: Mark) => void) => (s: Mark): void => { if (s !== current) send(s); };

/** IS16 "⋯ → Đánh dấu": ✓ on the current state (neutral --sel row), then what the change touches (UX I8). */
export function MarkMenu({ state, pick }: { state: SpecInfo['state']; pick: (s: Mark) => void }): ReactElement {
  const tr = useT();
  return (
    <span className="smenu" role="menu">
      <b>{tr('tasks.card.mark.head')}</b>
      {(['draft', 'approved'] as const).map(s => (
        <button key={s} type="button" role="menuitemradio" aria-checked={state === s} className={state === s ? 'on' : undefined} onClick={() => pick(s)}>
          <span className="ck">{state === s ? '✓' : ''}</span>{tr(`tasks.card.mark.${s}`)}
        </button>
      ))}
      <small>{tr('tasks.card.mark.note')}</small>
    </span>
  );
}

/** IS14 / IS15 / IS17 / IS18 the card (draft / approved; the overview covers active / done). */
export function SpecCard({ c, spec }: { c: TasksCtx; spec: SpecInfo }): ReactElement {
  const tr = useT();
  const m = cardModel(spec, c, tr);
  const slot = c.wf.slots.slot(spec); // v2.9 §4.7 the state + start words of the spec's own rev ("Chờ plan", "Bắt đầu plan")
  const [prior, setPrior] = useState(false);
  const [menu, setMenu] = useState(false);
  const resumeBtn = useRef<HTMLButtonElement>(null);
  const closePrior = useCallback(() => setPrior(false), []);
  const { cmds } = c;
  // v2.7.1 §4.1 build = a Build session; open / edit = a Thiết kế session bound to the spec (§4.8)
  const run = (a: Exclude<Act, 'resume'>, direct: boolean) => c.start({ kind: a, path: spec.path, spec: spec.title }, direct);
  const { setPop } = c;
  useEffect(() => { // the ⋯ menu: Esc / a click elsewhere closes it
    if (!menu) return;
    const close = () => setMenu(false);
    setPop(close);
    const down = (e: MouseEvent) => { if (!(e.target as Element).closest?.('.smark')) close(); };
    document.addEventListener('mousedown', down);
    return () => { setPop(null); document.removeEventListener('mousedown', down); };
  }, [menu, setPop]);
  const mark = markPick(spec.state, state => { void cmds.specMark(spec.path, state).catch(() => {}); });
  return (
    <article className="scard" aria-label={spec.title}>
      <header>
        <h3>{spec.title}</h3>
        <SubLine spec={spec} state={slot.label} tr={tr} />
      </header>
      <dl className="stab">{cardRows(spec, c, tr).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      <DocsBlock c={c} spec={spec} />
      {spec.missing ? <p className="smiss">{tr('tasks.card.missingNote')}</p> : null}
      <footer className="sact">
        {m.afterChip ? <span className="schip">{m.afterChip}</span> : null}
        {m.btns.map(b => {
          const cls = b.primary ? 'tbtn' : 'tbtn2', label = b.act === 'build' && slot.start ? slot.start : tr(`tasks.card.act.${b.act}`), act = b.act;
          // IS17 "Tiếp tục build" opens the choice (no session yet): not split; its own buttons are (PriorSessions)
          return act === 'resume'
            ? <button key={act} ref={resumeBtn} type="button" className={cls} disabled={!!b.off} title={b.off ?? undefined} aria-expanded={prior} onClick={() => setPrior(x => !x)}>{label}</button>
            : <SplitStart key={act} cls={cls} label={label} name={label} off={b.off} onStart={() => run(act, true)} onPick={() => run(act, false)} />;
        })}
        {m.mark ? (
          <span className="smark">
            <button type="button" className="tbtn2 ic" aria-label={tr('tasks.card.act.more')} aria-expanded={menu} disabled={c.locked} onClick={() => setMenu(x => !x)}>⋯</button>
            {menu ? <MarkMenu state={spec.state} pick={s => { setMenu(false); mark(s); }} /> : null}
          </span>
        ) : null}
        {m.editingGoto ? <span className="sedit">{tr('tasks.card.editingLine')} <button type="button" className="tbtn2 sm" onClick={() => c.toDeck(m.editingGoto!)}>{tr('tasks.card.act.goto')}</button></span> : null}
        {m.note ? <span className="snote">{m.note}</span> : null}
      </footer>
      {prior ? <PriorSessions c={c} spec={spec} anchor={resumeBtn} onClose={closePrior} /> : null}
    </article>
  );
}
