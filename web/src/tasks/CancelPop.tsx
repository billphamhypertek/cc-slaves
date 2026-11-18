// v2.7 §4.4 the Huỷ popover (IS4a / IS4b / IS4c, D75): opened by the detail's red-outline Huỷ, placed under the detail head,
// not modal. It shows the numbers `issue_cancel_preview` measured (R-B12, §5.7-4) before the PO confirms (fetched again when
// the issue moves while it is open): `todo` "Chưa có code.", no lane stopped, a waiting dependant "sẽ bị chặn"; `doing` not merged
// → stop the lane now + drop its branch; `done` (or `doing` merged in part) → the revert issue, its commits on the target
// branch; every dependant (open → blocked until the orchestrator unlinks, done → the revert may conflict). One-line Lý do
// (to the orchestrator, onto the issue, A5); red primary by case · Thôi (default focus, Esc). IS5b "Huỷ cả hai…" opens it
// for both keys (`askCancel`), the one built on the other first.
import { Fragment, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import type { IssueCancelPreview, IssueInfo } from '../../../shared/issues.ts';
import type { Tr } from '../../../shared/i18n/core.ts';
import { useT } from '../lib/i18n.tsx';
import { Icon } from '../ui/icons.tsx';
import type { TasksCtx } from './tasks-ctx.ts';

// ---------- IS5b: the Deck card asks Tasks to open IS4 for several keys ----------
type Ask = (pid: string, keys: string[]) => void;
const asks = new Set<Ask>();
/** IS5b "Huỷ cả hai…" (card action `revert_cancel_both`, args.keys): the Tasks tab of `pid` opens IS4 for `keys`. */
export function askCancel(pid: string, keys: string[]): void { for (const f of asks) f(pid, keys); }
export function onAskCancel(f: Ask): () => void { asks.add(f); return () => { asks.delete(f); }; }

// ---------- the texts (pure) ----------
/** §5.7 who may press Huỷ: not a cancelled issue, not one whose revert is pending / running / in conflict (the card answers
 *  it, §5.7-5), not a `prior` issue (no trailer to find its commits, §5.2-10), not a revert issue (G3b ruling, R-B15). */
export const canCancel = (i: Pick<IssueInfo, 'state' | 'revert' | 'source' | 'reverts'>): boolean =>
  i.state !== 'cancelled' && (i.revert === 'none' || i.revert === 'done') && i.source !== 'prior' && i.reverts === null;

export interface CancelText {
  head: string;
  /** what the cancel does (the bullet list) */
  does: string[];
  /** the dependants (⚠ lines) */
  warns: string[];
}
const SHAS_SHOWN = 3;

/** §4.4 the popover's text for one preview (`state` = the issue's state now: a `revert` of a `doing` reads "đang làm"). */
export function cancelText(p: IssueCancelPreview, state: IssueInfo['state'], tr: Tr): CancelText {
  const key = p.key;
  const head = tr(p.mode === 'cancel' ? 'tasks.cancel.head.todo' : state === 'done' ? 'tasks.cancel.head.done' : 'tasks.cancel.head.doing', { key });
  const does: string[] = [];
  if (p.mode === 'cancel') does.push(tr('tasks.cancel.todo'));
  if (p.mode === 'stop') {
    if (p.lane) does.push(tr('tasks.cancel.stop', { lane: p.lane.name }));
    does.push(p.lane?.branch && p.lane.commits ? tr('tasks.cancel.dropBranch', { branch: p.lane.branch, n: p.lane.commits }) : tr('tasks.cancel.dropNone'));
  }
  if (p.mode === 'revert' && p.revert) {
    const { branch, shas, key: rk } = p.revert;
    const list = shas.slice(0, SHAS_SHOWN).join(', ') + (shas.length > SHAS_SHOWN ? ', …' : '');
    does.push(branch && shas.length ? tr('tasks.cancel.revert', { rk, key, n: shas.length, branch, shas: list }) : tr('tasks.cancel.revertNoGit', { rk, key }));
    does.push(tr('tasks.cancel.conflictNote'));
  }
  const warns = [
    ...p.dependants.open.map(k => tr(p.mode === 'cancel' ? 'tasks.cancel.depWait' : 'tasks.cancel.depOpen', { key: k, orig: key })),
    ...p.dependants.done.map(k => tr('tasks.cancel.depDone', { key: k, orig: key })),
  ];
  return { head, does, warns };
}

/** §4.4 the red button's words: several keys → "Huỷ cả hai"; any revert → "Huỷ và hoàn tác"; else "Huỷ mục". */
export function confirmLabel(ps: readonly IssueCancelPreview[], tr: Tr): string {
  if (ps.length > 1) return tr('tasks.cancel.confirmBoth');
  return tr(ps.some(p => p.mode === 'revert') ? 'tasks.cancel.confirmRevert' : 'tasks.cancel.confirmItem');
}

/** `<b>` bold · `<c>` mono (branch) · `<k>` key chip, the only marks the catalog strings carry. */
function rich(s: string): ReactNode {
  return s.split(/(<[bck]>[^<]*<\/[bck]>)/).map((part, i) => {
    const m = /^<([bck])>([^<]*)<\/\1>$/.exec(part);
    if (!m) return <Fragment key={i}>{part}</Fragment>;
    return m[1] === 'b' ? <b key={i}>{m[2]}</b> : <code key={i} className={m[1] === 'k' ? 'ck' : undefined}>{m[2]}</code>;
  });
}

/** §5.7-4 what the preview depends on, per key: when an issue moves while IS4 is open (a lane takes it, it merges, a
 *  dependant appears) the numbers are fetched again before the PO can confirm. */
export const previewSig = (issues: readonly IssueInfo[], keys: readonly string[]): string => keys.map(k => {
  const i = issues.find(x => x.key === k);
  return i ? [k, i.state, i.revert, i.lane?.name ?? '', i.commits.length, i.blocks.join(',')].join(':') : k;
}).join('\n');

// ---------- the button + popover ----------
type Pv = { key: string; p: IssueCancelPreview | null; state: IssueInfo['state'] };

/** §4.4 the detail's red-outline Huỷ and its popover (hidden when `canCancel` says so; locked offline, IS8c). */
export function CancelAction({ c, issue }: { c: TasksCtx; issue: IssueInfo }): ReactElement | null {
  const tr = useT();
  const [keys, setKeys] = useState<string[] | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const askN = c.ask && c.ask.keys[c.ask.keys.length - 1] === issue.key ? c.ask.n : 0;
  useEffect(() => { if (askN && c.ask) setKeys(c.ask.keys); }, [askN]); // eslint-disable-line react-hooks/exhaustive-deps -- one ask, once
  if (!canCancel(issue) && !keys) return null;
  return (<>
    <button ref={btn} type="button" className="dcx" disabled={c.locked} title={c.locked ? tr('tasks.locked') : undefined}
      aria-expanded={!!keys} onClick={() => setKeys(k => (k ? null : [issue.key]))}>{tr('tasks.cancel.btn')}</button>
    {keys ? <CancelPop c={c} keys={keys} anchor={btn} onClose={() => setKeys(null)} /> : null}
  </>);
}

function CancelPop({ c, keys, anchor, onClose }: { c: TasksCtx; keys: string[]; anchor: { current: HTMLElement | null }; onClose: () => void }): ReactElement {
  const tr = useT();
  const stateOf = (k: string) => c.pi.issues.find(i => i.key === k)?.state ?? 'todo';
  const fresh = () => keys.map((key): Pv => ({ key, p: null, state: stateOf(key) }));
  const [pvs, setPvs] = useState<Pv[]>(fresh);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const { cmds, setPop } = c;
  const sig = useRef(''); // re-review NEW-1: frozen once a confirm starts — the cancel's own issue_changed must not re-fetch (a refusal toast)
  if (!busy) sig.current = previewSig(c.pi.issues, keys);
  const first = useRef(true);
  useEffect(() => {
    let live = true;
    if (first.current) first.current = false; else setPvs(fresh()); // the issue moved: not ready until the new numbers land
    keys.forEach((key, i) => {
      cmds.cancelPreview(key).then(
        p => { if (live) setPvs(xs => xs.map((x, j) => (j === i ? { ...x, p } : x))); },
        () => { if (live) onClose(); }, // refused (prior, revert open, …): the toast says why
      );
    });
    return () => { live = false; };
  }, [sig.current]); // eslint-disable-line react-hooks/exhaustive-deps -- `sig` carries the keys and what their preview depends on
  useEffect(() => { keep.current?.focus(); }, []);
  useEffect(() => {
    setPop(onClose);
    const down = (e: MouseEvent) => { const t = e.target as Node; if (!box.current?.contains(t) && !anchor.current?.contains(t)) onClose(); };
    document.addEventListener('mousedown', down);
    return () => { setPop(null); document.removeEventListener('mousedown', down); };
  }, [onClose, setPop, anchor]);
  const ready = pvs.every(x => x.p);
  const confirm = async () => {
    setBusy(true);
    const r = reason.trim() || undefined;
    for (const x of pvs) { try { await cmds.cancel(x.key, r); } catch { break; } } // a refusal toasts; the rest is not sent
    onClose();
  };
  // UX I2: under the detail's head (key line + title stay readable), right edge with the Huỷ button
  const a = anchor.current?.getBoundingClientRect(), head = anchor.current?.closest('.dtop')?.getBoundingClientRect() ?? a;
  const style = a && head ? { top: head.bottom + 12, right: Math.max(8, window.innerWidth - a.right - 4) } : undefined;
  return (
    <div ref={box} className="cpop" data-pop="" role="dialog" aria-label={tr('tasks.cancel.aria')} style={style}>
      {pvs.map(x => {
        if (!x.p) return <p key={x.key} className="cload">{tr('tasks.cancel.loading')}</p>;
        const t = cancelText(x.p, x.state, tr);
        return (
          <section key={x.key}>
            <h4>{t.head}</h4>
            <ul>{t.does.map((d, i) => <li key={i}>{rich(d)}</li>)}</ul>
            {t.warns.length ? <div className="cwarn">{t.warns.map((w, i) => <p key={i}><Icon n="alert" s={13} /><span>{rich(w)}</span></p>)}</div> : null}
          </section>
        );
      })}
      <label className="creason">{tr('tasks.cancel.reason')}
        <input type="text" value={reason} placeholder={tr('tasks.cancel.reasonPh')} maxLength={300} onChange={e => setReason(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && ready && !busy) void confirm(); }} />
      </label>
      <div className="cfoot">
        <span className="kb">{tr('tasks.cancel.esc')}</span>
        <button ref={keep} type="button" className="ckeep" onClick={onClose}>{tr('tasks.cancel.keep')}</button>
        <button type="button" className="cgo" disabled={!ready || busy || c.locked} onClick={() => void confirm()}>
          {busy ? <><span className="spin sm" aria-hidden="true" />{tr('tasks.cancel.busy')}</> /* hf1117-perf never a silent disabled button */
            : confirmLabel(pvs.flatMap(x => (x.p ? [x.p] : [])), tr)}
        </button>
      </div>
    </div>
  );
}
