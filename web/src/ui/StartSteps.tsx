// v2.7.1 §4.1 SA3 / SA4 the step list of a session start, shared by the start dialog (▾), the split button's main part (G2b)
// and the v2.4 Deck dialogs (L11 / L14): spinner → ✓ + time per step, ✗ + the engine's reason on failure with "Đóng" and the
// fix ("Chọn account khác" for an account refusal, "Thử lại" otherwise). Feedback ≤ 100 ms: the list shows on the click.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { AccountView, OrchestratorView } from '../../../shared/protocol.ts';
import { errText, reasonText, useT } from '../lib/i18n.tsx';
import { fillRun, fmtStepTime, startSteps, trackRun, type StartFix, type StartRun, type StartStep } from '../lib/start.ts';
import { CommandError } from '../lib/ws.ts';
import { Icon } from './icons.tsx';

/** How long the all-ticked list stays before the Deck takes over (the PO sees every step finish; hf1117 "Thêm project"). */
const DONE_HOLD_MS = 450;
const TICK_MS = 250;

const mark = (st: StartStep['st']): ReactElement | null =>
  st === 'run' ? <span className="spin" /> : st === 'ok' ? <Icon n="check" s={11} /> : st === 'bad' ? <Icon n="x" s={11} /> : null;

/** SA3 / SA4 the rows. */
function StepList({ steps }: { steps: StartStep[] }): ReactElement {
  const tr = useT();
  return (
    <div className="ssteps" role="list" aria-label={tr('session.stStepsAria')}>{steps.map(s => (
      <div key={s.key} role="listitem" className={`sst st-${s.st}`}>
        <span className="ic" aria-hidden="true">{mark(s.st)}</span>
        <b>{s.label}</b>{s.ms !== null ? <span className="t mono">{fmtStepTime(tr, s.ms)}</span> : null}
        {s.note ? <small>{s.note}</small> : null}
      </div>))}
    </div>
  );
}

type RunInfo = Pick<StartRun, 'account' | 'auto' | 'pct' | 'model'>;
/** One start → its steps. `begin(start, info, what)` sends at once (the list shows on the same click); `start` resolves
 *  the new session id; `what` ("#4", "Build · v2.6 Updater") is frozen at the click (the snapshot then holds the new one). The snapshot moves steps 1–2, the ack step 3; then `finish(sid)` (step 4: the Deck selects it).
 *  `fill(info)` = what the dialog learnt after the click (the main part sends before `session_pick` / the model list answer). */
export function useStartRun(os: OrchestratorView[], accounts: AccountView[], finish: (sessionId: string) => void) {
  const tr = useT();
  const [run, setRun] = useState<StartRun | null>(null), [now, setNow] = useState(() => Date.now());
  const before = useRef<ReadonlySet<string>>(new Set()), last = useRef<{ start: () => Promise<string>; info: RunInfo; what: string } | null>(null);
  const reason = (o: OrchestratorView) => reasonText(tr, o.lastError, o.lastErrorKeyed);
  const pctOf = (email: string) => accounts.find(a => a.email === email)?.headroomPct ?? null;
  const begin = (start: () => Promise<string>, info: RunInfo, what: string) => {
    before.current = new Set(os.flatMap(o => (o.sessionId ? [o.sessionId] : [])));
    last.current = { start, info, what };
    const t0 = Date.now();
    setNow(t0);
    setRun({ t0, sid: null, seenAt: null, bootAt: null, ackAt: null, deckAt: null, err: null, bootErr: null, ...info });
    const mine = (f: (r: StartRun) => StartRun) => setRun(r => (r && r.t0 === t0 ? f(r) : r));
    start().then(sid => { const at = Date.now(); mine(r => ({ ...r, sid, ackAt: at, seenAt: r.seenAt ?? at })); },
      (e: unknown) => {
        const code = e instanceof CommandError ? e.code : null;
        const fix: StartFix = code === 'no_account' ? 'panel' : code === 'account_unusable' ? 'account' : 'retry';
        mine(r => ({ ...r, err: { text: errText(tr, e), fix } }));
      });
  };
  const live = !!run && !run.err && !run.bootErr && run.deckAt === null;
  // steps 1–2 from the snapshot (a session not there before, then the one the ack named)
  useEffect(() => { if (live) setRun(r => (r ? trackRun(r, os, before.current, Date.now(), reason, pctOf) : r)); }, [os, live, run?.sid]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!live) return;
    const h = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(h);
  }, [live]);
  // step 4 once the ack and the boot are both in
  const ready = !!run && !run.err && !run.bootErr && run.ackAt !== null && run.bootAt !== null && run.sid !== null; // stays true past deckAt
  useEffect(() => {
    if (!ready || !run?.sid) return;
    const sid = run.sid;
    setRun(r => (r ? { ...r, deckAt: Date.now() } : r));
    const h = setTimeout(() => finish(sid), DONE_HOLD_MS);
    return () => clearTimeout(h);
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps
  const retry = () => { if (last.current) begin(last.current.start, last.current.info, last.current.what); };
  const fill = (info: RunInfo) => { if (last.current) last.current.info = info; setRun(r => (r && !r.err ? fillRun(r, info) : r)); };
  return { run, what: last.current?.what ?? '', now: Math.max(now, run?.t0 ?? 0), begin, retry, fill, reset: () => setRun(null) };
}

/** SA3 / SA4 the dialog body + foot. `what` = "Build · v2.6 Updater"; `onOtherAccount` = back to the choice with the list
 *  open (account refusals); `onAccounts` = the Account panel (no account left, §4.1 SA9 main part). */
export function StartProgress({ what, run, now, onClose, onRetry, onOtherAccount, onAccounts }: {
  what: string; run: StartRun; now: number; onClose: () => void; onRetry: () => void; onOtherAccount: () => void; onAccounts: () => void;
}): ReactElement {
  const tr = useT();
  const steps = startSteps(tr, run, now);
  const failed = steps.some(s => s.st === 'bad'), fix = run.err?.fix ?? 'retry', accountErr = fix !== 'retry';
  const lead = !failed ? tr('session.stRunLead') : run.bootErr !== null || run.seenAt !== null ? tr('session.stBadLeadBoot')
    : accountErr ? tr('session.stBadLeadAcc') : tr('session.stBadLead');
  return (
    <div className="modal glass sdlg sstart" role="dialog" aria-label={tr(failed ? 'session.stBadTitle' : 'session.stRunTitle', { what })} aria-busy={!failed || undefined}>
      <div className="mh"><h2>{tr(failed ? 'session.stBadTitle' : 'session.stRunTitle', { what })}</h2></div>
      <p className="lead">{lead}</p>
      <StepList steps={steps} />
      <div className="mf">
        <button className="btn" autoFocus={!failed} onClick={onClose}>{tr('common.close')}</button>
        {!failed ? null : fix === 'panel' ? <button className="btn pri" autoFocus onClick={onAccounts}>{tr('session.stOpenAccounts')}</button>
          : fix === 'account' ? <button className="btn pri" autoFocus onClick={onOtherAccount}>{tr('session.stOtherAcc')}</button>
          : <button className="btn pri" autoFocus onClick={onRetry}>{tr('session.stRetry')}</button>}
      </div>
    </div>
  );
}
