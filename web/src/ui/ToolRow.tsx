// spec v2.2 §14.5 "Dòng công cụ" (frames S4, S4-narrow, S5, S11): one line per tool — icon by kind, name, short main
// parameter, `+12 −3`, state, time past 2 s; a click opens the full parameters + the first 12 result lines. ≥ 3 read-only
// rows fold into "Đã xem n · …" (lib/tool-rows.ts); "Ẩn công cụ" leaves one "n công cụ" line. v2.7 §4.6 cc-slaves' own tools
// read as Vietnamese labels ("đọc mục T-47"); a Skill the cc-slaves policy refused is a grey ⊘ row + why, never red.
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { fmtNum } from '../../../shared/i18n/core.ts';
import { fmtElapsed, fmtSecs } from '../lib/format.ts';
import { useT, type Tr } from '../lib/i18n.tsx';
import { blockedSkill, ccsLabel, mcpParts, paramLine, resultView, shortArg, showTime, toolKind, type Row, type ToolCall, type ToolKind, type ToolState } from '../lib/tool-rows.ts';
import { Icon, type IconName } from './icons.tsx';
import './toolrow.css';

const KIND_ICON: Record<ToolKind, IconName> = { read: 'file', edit: 'pencil', bash: 'term', search: 'search', web: 'globe', mcp: 'plug', task: 'fork', other: 'wrench' };

function State({ s, tr }: { s: ToolState; tr: Tr }): ReactElement {
  if (s === 'running') return <span className="tr-st tr-run" aria-label={tr('stream.tool.running')}><i />…</span>;
  if (s === 'error') return <span className="tr-st tr-err"><Icon n="x" s={13} />{tr('stream.tool.error')}</span>;
  return <span className="tr-st tr-ok" aria-label={tr('stream.tool.done')}><Icon n="check" s={13} /></span>;
}

/** §14.5 S4 / S7 (F-M9) a 1 s clock while `on` (a running tool, "Đang nghĩ…"); off = no timer. */
export function useClock(on: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** §14.5 the time cell: a running call's elapsed seconds (F-M9), a finished one's duration — each only past 2 s. */
function Time({ state, ms, startedAt }: { state: ToolState; ms: number | null; startedAt?: number }): ReactElement {
  const tr = useT();
  const now = useClock(state === 'running' && startedAt !== undefined);
  const run = state === 'running' && startedAt !== undefined ? now - startedAt : null;
  return <span className="tr-tm">{run !== null ? (showTime(run) ? fmtElapsed(run, tr) : null) : showTime(ms) ? fmtSecs(ms!, tr) : null}</span>;
}

function Line({ icon, name, server, arg, diff, state, ms, startedAt, open, onClick, group, blocked, label }: {
  icon: IconName; name: ReactNode; server?: string; arg?: string; diff?: ToolCall['diff']; state: ToolState; ms: number | null; startedAt?: number;
  open: boolean; onClick: () => void; group?: boolean;
  /** §4.6 a refused Skill: no state cell (not an error); `label` = a cc-slaves tool's Vietnamese label (body font) */
  blocked?: boolean; label?: boolean;
}): ReactElement {
  const tr = useT();
  return <button type="button" className={`tr-row${group ? ' tr-gp' : ''}${open ? ' tr-open' : ''}${blocked ? ' tr-blk' : ''}${label ? ' tr-lbl' : ''}`} aria-expanded={open} onClick={onClick}>
    <Icon n={icon} s={13} />
    <span className="tr-name">{name}</span>
    {/* §14.5 S4-narrow: the parameter is cut from the left; the diff and the state never are */}
    <span className="tr-arg" title={arg}><bdi>{arg}</bdi></span>
    <span className="tr-df">{diff ? <>+{diff.add} <b>−{diff.del}</b></> : server ? <span className="tr-srv">{server}</span> : null}</span>
    {blocked ? <span className="tr-st" /> : <State s={state} tr={tr} />}
    <Time state={state} ms={ms} startedAt={startedAt} />
  </button>;
}

/** The opened row: the full parameters, then the result — 12 lines, footer "Xem hết" + "n dòng · exit k" (S5), the 8 KB note. */
function ToolBox({ call }: { call: ToolCall }): ReactElement {
  const tr = useT();
  const [all, setAll] = useState(false);
  const v = call.result === undefined ? null : resultView(call.result, all);
  const exit = call.exitCode !== undefined;
  return <div className="tr-box">
    {call.input ? <div className="tr-in">{paramLine(call.name, call.input)}</div> : null}
    {v ? <pre className={call.state === 'error' ? 'tr-out tr-bad' : 'tr-out'}>{v.lines.join('\n')}</pre> : null}
    {v && (v.more || exit) ? <div className="tr-foot">
      {v.more ? <button type="button" className="tr-more" onClick={() => setAll(true)}><Icon n="chev" s={13} />{tr('stream.tool.seeAll')}</button> : null}
      <span className="tr-meta">{tr('stream.tool.lines', { n: fmtNum(tr.lang, v.total) })}{exit ? ` · ${tr('stream.tool.exit', { k: call.exitCode! })}` : null}</span>
    </div> : null}
    {call.truncated && (all || !v?.more) ? <div className="tr-cut">
      <span>{tr('stream.tool.truncated', { n: fmtNum(tr.lang, call.truncated.lines) })}</span>
    </div> : null}
  </div>;
}

export interface ToolRowProps {
  call: ToolCall;
  /** Task (subagent): the row leads to the sub (v2.1) instead of opening */
  onTask?: (id: string) => void;
  /** opened from the start (a failed row inside an auto-opened group stays closed until clicked) */
  initialOpen?: boolean;
}

export function ToolRow({ call, onTask, initialOpen = false }: ToolRowProps): ReactElement {
  const tr = useT();
  const [open, setOpen] = useState(initialOpen);
  const kind = toolKind(call.name);
  const click = kind === 'task' && onTask ? () => onTask(call.id) : () => setOpen(o => !o);
  const blocked = blockedSkill(call);
  if (blocked) return <div className="tr">
    <Line blocked icon="ban" name={call.name} arg={shortArg(call)} state={call.state} ms={call.ms} open={open} onClick={click} />
    <div className="tr-why"><b>{tr('stream.tool.blocked')}</b>{blocked.reason ? <span>{blocked.reason}</span> : null}</div>
    {open ? <ToolBox call={call} /> : null}
  </div>;
  const ccs = ccsLabel(call); // §4.6 "đọc mục T-47", no tool name, no server
  const mcp = ccs ? null : mcpParts(call.name); // §14.5 S1 (F-M8) "lane_status D2", the server as a small label
  return <div className="tr">
    <Line icon={KIND_ICON[kind]} name={ccs ? tr(`stream.ccs.${ccs.key}`, { x: ccs.x, y: ccs.y }).replace(/\s+/g, ' ').trim() : mcp?.tool ?? call.name} label={!!ccs}
      server={mcp?.server} arg={ccs ? '' : shortArg(call)} diff={call.diff} state={call.state} ms={call.ms} startedAt={call.startedAt} open={open} onClick={click} />
    {open ? <ToolBox call={call} /> : null}
  </div>;
}

/** §14.5 "Đã xem 5 · Read ×3, Grep ×2": folded; open by itself when one of its tools failed. */
export function ToolGroup({ group }: { group: Extract<Row<unknown>, { k: 'group' }> }): ReactElement {
  const tr = useT();
  const [open, setOpen] = useState(group.open);
  const list = group.summary.map(([name, n]) => `${name} ×${n}`).join(', ');
  return <div className="tr">
    <Line group icon={open ? 'chev' : 'chevR'} name={tr('stream.tool.group', { n: group.calls.length, list })} state={group.state} ms={group.ms} open={open} onClick={() => setOpen(o => !o)} />
    {open ? <div className="tr-in-gp">{group.calls.map(c => <ToolRow key={c.id} call={c} initialOpen={c.state === 'error'} />)}</div> : null}
  </div>;
}

/** §14.5 S11 "Ẩn công cụ" on: one quiet line in place of a stretch of tools. */
export function ToolCount({ n }: { n: number }): ReactElement {
  const tr = useT();
  return <div className="tr-count"><Icon n="eyeOff" s={13} />{tr('stream.tool.hidden', { n })}</div>;
}
