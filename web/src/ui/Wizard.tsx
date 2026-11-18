// F1 first-run wizard, 5 steps (v1 spec §6.1, v2 §6, v2.5 §6): Công cụ → Account → Bộ công cụ → Vai trò & ngưỡng → Xong
// (hf1116 (b): step 1 = Claude Code + the optional, lazy Git block, which never gates "Tiếp"). Gating lives in
// lib/wizard.ts; installs stream through `install_log` (F1b). The account step is the Settings › Account list (A1–A4,
// A6, A7) without A5: a finished add returns to the list, roles are set once at step 4. Step 3 loads the Bộ công cụ list
// (the Skills & MCP chunk + its catalogs) when it opens; until then it shows TK1-chk's waiting line.
import { lazy, Suspense, useEffect, useMemo, useState, type ReactElement } from 'react';
import type { Command, SetupStatus, Snapshot } from '../../../shared/protocol.ts';
import type { InstallLog } from '../lib/store.ts';
import { shortEmail } from '../lib/format.ts';
import { cfgHeader } from '../lib/account-ui.ts';
import { errText, installLast, useT } from '../lib/i18n.tsx';
import { canAdvance, capsPayload, FIRST_STEP, laneCapsPayload, loggedInCount, roleErrors, soloAccount, STEP_KEYS, stepStates, wizardRoles, type RoleRow, type Step } from '../lib/wizard.ts';
import { LANG_NAME, LANGS, type Lang } from '../../../shared/i18n/core.ts';
import type { AccDlg } from './Accounts.tsx';
import { Icon } from './icons.tsx';
import { RolesTable } from './RolesTable.tsx';
// the account step (Settings › Account list) comes with the lazy dialog chunk (spec v2.1 §5.6: one chunk, not two)
const AccountsTab = lazy(() => import('./AppModals.tsx').then(m => ({ default: m.AccountsTab })));
const GitSetup = lazy(() => import('./GitSetup.tsx'));
const ToolkitStep = lazy(() => import('./Toolkit.tsx').then(m => ({ default: m.ToolkitStep })));

const CLAUDE_MIN = '2.1.325';
const CLAUDE_CMD = 'curl -fsSL https://claude.ai/install.sh | bash';
const CLAUDE_HELP = 'https://docs.anthropic.com/en/docs/claude-code/setup';

export interface WizardProps {
  setup: SetupStatus | null;
  snap: Snapshot;
  installs: Record<string, InstallLog>;
  send: (c: Command) => Promise<unknown>;
  /** Opens the shared A3–A8 dialogs (App owns them, on top of the wizard). */
  onAccDlg: (d: AccDlg) => void;
  /** v2.1 §4.12 an account row "⋯" (step 2) → the App's account menu. */
  onAccMenu: (email: string, anchor: Element) => void;
  toast: (t: string) => void;
  onClose: () => void;
  onAddProject: () => void;
  initialStep?: Step;
}

/** §6A language switch ("Tiếng Việt ▾ / English"): each language in its own words; applies at once via `config_update`. */
export function LangSelect({ send, className }: { send: (c: Command) => Promise<unknown>; className?: string }): ReactElement {
  const tr = useT();
  return <select className={`field lang-sel${className ? ` ${className}` : ''}`} aria-label={tr('common.lang')} value={tr.lang}
    onChange={e => void send({ cmd: 'config_update', patch: { ui: { lang: e.target.value as Lang } } }).catch(() => {})}>
    {LANGS.map(l => <option key={l} value={l}>{LANG_NAME[l]}</option>)}
  </select>;
}

function Log({ log }: { log: InstallLog | undefined }): ReactElement | null {
  if (!log) return null;
  const last = log.done ? log.lines.at(-1) : undefined;
  return <div className="term more" style={{ gridColumn: '2/4' }}>{(last === undefined ? log.lines : log.lines.slice(0, -1)).join('\n')}
    {last !== undefined ? <>{log.lines.length > 1 ? '\n' : ''}<span style={{ color: log.ok ? 'var(--ok)' : 'var(--bad)' }}>{last}</span></> : null}</div>;
}

export function Wizard(p: WizardProps): ReactElement {
  const s = p.setup;
  const tr = useT();
  const [step, setStep] = useState<Step>(p.initialStep ?? FIRST_STEP);
  const [rows, setRows] = useState<RoleRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const check = () => { void p.send({ cmd: 'setup_check' }).catch(() => {}); };

  useEffect(() => { if (!s) check(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // account step: an account added / logged in / removed in the shared dialogs → the setup gate is checked again
  const accSig = p.snap.accounts.map(a => `${a.email}:${a.login}`).join();
  useEffect(() => { if (step === 2) check(); }, [accSig, step]); // eslint-disable-line react-hooks/exhaustive-deps
  // an install finished → check again
  const doneSig = Object.entries(p.installs).map(([k, v]) => `${k}:${v.done}`).join();
  useEffect(() => { if (Object.values(p.installs).some(l => l.done)) check(); }, [doneSig]); // eslint-disable-line react-hooks/exhaustive-deps

  const emails = useMemo(() => (s?.accounts.filter(a => a.loggedIn).map(a => a.email) ?? []), [s]);
  const roleRows = rows ?? wizardRoles(emails, p.snap.config);

  if (!s) return <div className="wiz glass"><div className="mh"><span className="logo" /><h2>{tr('wizard.title')}</h2></div><div className="row foot"><span className="spin" /> {tr('wizard.checking')}</div></div>;

  const states = stepStates(s, step, roleRows);
  const stepper = <div className="stepper">{STEP_KEYS.map(k => tr(k)).map((n, i) => (
    <div key={i} className={states[i]}><i /><span>{states[i] === 'ok' ? <Icon n="check" s={12} /> : states[i] === 'no' ? <Icon n="x" s={12} /> : null}{i + 1}. {n}</span></div>))}</div>;
  const install = (what: 'claude' | 'claude_update') => void p.send({ cmd: 'setup_install', what }).catch(() => {});
  const running = (j: string) => !!p.installs[j] && !p.installs[j].done;
  const failed = (j: string) => !!p.installs[j]?.done && !p.installs[j].ok;

  let body: ReactElement, foot: ReactElement | null;
  if (step === 1) {
    const cj = p.installs.claude_update && !p.installs.claude ? 'claude_update' : 'claude';
    const c = s.claude;
    body = <div>
      <div className="dep">
        <span className={`ic ${running(cj) ? 'run' : c.ok ? 'ok' : 'no'}`}>{running(cj) ? <span className="spin" /> : <Icon n={c.ok ? 'check' : 'x'} s={15} />}</span>
        {c.ok ? <><b>{tr('wizard.cc.installed', { version: c.version ?? '' })}</b><small>{c.path}</small></>
          : running(cj) ? <><b>{tr('wizard.cc.installing')}</b><small>{tr('wizard.cc.log')}</small></>
          : c.found ? <><b>{tr('wizard.cc.old', { version: c.version ?? '' })}</b><small>{tr('wizard.cc.need', { min: CLAUDE_MIN })} <code>claude update</code>.</small></>
          : <><b>Claude Code</b><small>{tr('wizard.cc.missingA')} <code>claude</code> {tr('wizard.cc.missingB', { min: CLAUDE_MIN })}</small></>}
        {!c.ok && !running(cj) ? <span className="acts2">
          {c.found ? <button className="btn sm pri" onClick={() => install('claude_update')}><Icon n="refresh" s={14} /> {tr('wizard.cc.update')}</button>
            : <button className="btn sm pri" onClick={() => install('claude')}><Icon n="dl" s={14} /> {failed('claude') ? tr('common.retry') : tr('wizard.cc.install')}</button>}
          {failed(cj) ? <a className="btn sm" href={CLAUDE_HELP} target="_blank" rel="noreferrer">{tr('wizard.cc.guide')}</a> : null}
        </span> : null}
        {!c.ok && !c.found && !p.installs.claude ? <div className="more"><span className="foot">{tr('wizard.cc.willRun')}</span> <span className="code">{CLAUDE_CMD}</span></div> : null}
        {failed(cj) ? <div className="more err"><Icon n="alert" s={14} /><span>{installLast(tr, p.installs[cj]!) ?? tr('wizard.cc.failed')}</span></div> : null}
        <Log log={p.installs[cj]} />
      </div>
      <Suspense fallback={null}><GitSetup setup={s} send={p.send} mac later toast={p.toast} /></Suspense>
    </div>;
    foot = <><button className={`btn${c.ok ? ' pri' : ''}`} disabled={!c.ok} onClick={() => setStep(2)}>{tr('common.next')}</button>
      {c.ok ? null : <button className="btn pri" onClick={check}><Icon n="refresh" s={14} /> {tr('wizard.recheck')}</button>}</>;
  } else if (step === 2) {
    const n = loggedInCount(s);
    // A3 opened from here skips A5 (roles come at step 3)
    const onDlg = (d: AccDlg) => p.onAccDlg(d.k === 'add' ? { ...d, noA5: true } : d);
    body = <div className="wiz-acc">
      <Suspense fallback={null}><AccountsTab snap={p.snap} onDlg={onDlg} onMenu={p.onAccMenu} editor={null} noRoles /></Suspense>
      {n ? null : <p className="foot">{tr('wizard.needOne')}</p>}
    </div>;
    foot = <><button className="btn" onClick={() => setStep(1)}>{tr('common.back')}</button><button className="btn pri" disabled={!canAdvance(2, s, roleRows)} onClick={() => { setRows(null); setStep(3); }}>{tr('common.next')}</button></>;
  } else if (step === 3) {
    // v2.5 §6 TK1: never gates (A3); the lazy step draws its own foot ("Cài n mục" / "Tiếp")
    const wait = <><p className="tkwait"><span className="spin sm" aria-hidden="true" />{tr('wizard.tk.checking')}</p>
      <div className="mf"><button className="btn" onClick={() => setStep(2)}>{tr('common.back')}</button><button className="btn" onClick={() => setStep(4)}>{tr('common.later')}</button>
        <button className="btn pri" disabled><Icon n="dl" s={14} /> {tr('wizard.tk.install')}</button></div></>;
    body = <div className="wiz-tk">
      <div className="tkhead"><h3>{tr('wizard.tk.title')}</h3><p>{tr('wizard.tk.leadA')} <code>~/.claude</code>{tr('wizard.tk.leadB')}</p></div>
      <Suspense fallback={wait}><ToolkitStep view={p.snap.toolkit} mcpView={p.snap.skillsMcp} graph={p.snap.graph?.tool} projects={p.snap.projects} send={p.send} toast={p.toast}
        onBack={() => setStep(2)} onNext={() => setStep(4)} /></Suspense>
    </div>;
    foot = null;
  } else if (step === 4) {
    const errs = roleErrors(tr, roleRows);
    const save = async () => {
      setBusy(true); setErr(null);
      try {
        await p.send({ cmd: 'caps_update', caps: capsPayload(roleRows) });
        await p.send({ cmd: 'config_update', patch: { laneCaps: laneCapsPayload(roleRows) } });
        setStep(5);
      } catch (e) { setErr(errText(tr, e)); } finally { setBusy(false); }
    };
    body = <>
      <p style={{ margin: 0, color: 'var(--fg-2)' }}>{tr('wizard.pickOrch')}</p>
      <RolesTable rows={roleRows} accounts={p.snap.accounts} onChange={setRows} />
      {errs.length || err ? <div className="err"><Icon n="alert" s={14} /><span>{[...errs, err].filter(Boolean).join(' ')}</span></div> : null}
    </>;
    foot = <><button className="btn" onClick={() => setStep(3)}>{tr('common.back')}</button><button className="btn pri" disabled={!!errs.length || busy} onClick={() => void save()}>{tr('common.next')}</button></>;
  } else {
    const orch = roleRows.find(r => r.role === 'orchestrator');
    const mains = roleRows.filter(r => r.role === 'primary'), backups = roleRows.filter(r => r.role === 'backup');
    const cfg = cfgHeader(tr, p.snap.accounts, p.snap.cards.filter(c => c.status === 'open' && c.kind === 'shared_cfg_new').length);
    const lines: [boolean, string][] = [
      [true, `Claude Code ${s.claude.version ?? ''}`],
      [true, tr('wizard.sum.accounts', { n: loggedInCount(s) })],
      [true, `${tr(soloAccount(roleRows) ? 'wizard.sum.orchLane' : 'wizard.sum.orch')}: ${orch ? shortEmail(orch.email) : '—'}${mains.length ? tr('wizard.sum.mains', { n: mains.length }) : ''}${backups.length ? tr('wizard.sum.backups', { n: backups.length }) : ''}`],
      [cfg.n === 0, cfg.n ? cfg.text : tr('accounts.cfg.title')], // M11: the ✓ icon already says "ok"
    ];
    body = <div>{lines.map(([ok, t]) => <div key={t} className="dep"><span className={`ic ${ok ? 'ok' : 'no'}`}><Icon n={ok ? 'check' : 'alert'} s={15} /></span><b>{t}</b></div>)}</div>;
    foot = <><button className="btn" onClick={p.onClose}>{tr('common.later')}</button><button className="btn pri" onClick={p.onAddProject}><Icon n="plus" s={14} /> {tr('wizard.firstProject')}</button></>;
  }
  // §6A: the switch sits top-right on step 1 so someone who cannot read Vietnamese changes it on the first screen
  const lang = step === 1 ? <LangSelect send={p.send} /> : null;
  return <div className="wiz glass" role="dialog" aria-label={tr('wizard.title')}><div className="mh"><span className="logo" /><h2>{tr('wizard.title')}</h2>{lang}</div>{stepper}{body}{foot ? <div className="mf">{foot}</div> : null}</div>;
}
