// v2 Settings › Account (spec v2 §6 A1–A9, F16): the account table and the dialogs A3–A7 (login), A8L / A8 (confirm),
// A9 merge. "Cấu hình chung" moved to Skills & MCP › Thư mục chung (v2.2 §6 K12, §7); the ⚠ chip opens it. State → view mapping lives in lib/account-ui.ts (unit-tested).
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import type { AccountLoginView, Command, Role, Snapshot } from '../../../shared/protocol.ts';
import {
  a3Block, a4Buttons, liveLoginToAdopt, a5Defaults, a5Payload, capsText, cfgIssues, countdown, f16Adopt, lanesText, loginChip, loginDialog,
  cancelsLogin, clashLine, logoutImpact, logoutMoves, tildePath, type ClashCopyView, type A5Values, type DlgAction,
} from '../lib/account-ui.ts';
import { shortEmail } from '../lib/format.ts';
import { errText, useT } from '../lib/i18n.tsx';
import { ROLE_KEY } from '../lib/labels.ts';
import { copyText, openExternal } from '../lib/links.ts';
import { withRole } from '../lib/wizard.ts';
import { Icon } from './icons.tsx';

type Send = (c: Command) => Promise<unknown>;

/** The dialogs this module owns; App keeps one at a time on top of everything else. */
export type AccDlg =
  | { k: 'add'; noA5?: boolean } // noA5: F1 step 2 (v2 §6) returns to the list
  | { k: 'relogin'; email: string; started?: boolean }
  | { k: 'logout'; email: string }
  | { k: 'delete'; email: string }
  | { k: 'merge'; email: string; name: string; cardId?: number }
  | { k: 'orphan_delete'; cardId: number; title: string };

// ---------------------------------------------------------------- A1 / A2
export interface AccountsTabProps {
  snap: Snapshot; onDlg: (d: AccDlg) => void; editor: ReactNode;
  /** G4 UX 5(c): "Sửa vai trò & ngưỡng" in the toolbar (absent = editor open / wizard). */
  onEditRoles?: () => void;
  /** F1 step 2 (G4 UX M1): no Vai trò column — step 3 sets the roles. */
  noRoles?: boolean;
  /** v2.2 §6 / §7 the ⚠ "cấu hình chung lỗi" chip opens Skills & MCP › Thư mục chung (K12); absent (F1 wizard) = a plain chip. */
  onCfg?: () => void;
  /** v2.1 §4.12 the row "⋯": the App's one account menu (lib/actions.ts), opened at that button. */
  onMenu: (email: string, anchor: Element) => void;
}

export function AccountsTab(p: AccountsTabProps): ReactElement {
  const { snap } = p;
  const tr = useT();
  const laneCaps = (snap.config.laneCaps ?? {}) as Record<string, number>;

  if (!snap.accounts.length) {
    return <div className="acc-empty">
      <h3>{tr('accounts.empty.title')}</h3>
      <p className="foot">{tr('accounts.empty.lead')}</p>
      <div><button className="btn pri" onClick={() => p.onDlg({ k: 'add' })}><Icon n="plus" /> {tr('accounts.add')}</button></div>
    </div>;
  }

  return <>
    <div className="row" style={{ justifyContent: 'flex-end' }}>
      {p.onEditRoles ? <button className="btn sm" onClick={p.onEditRoles}>{tr('accounts.editRoles')}</button> : null}
      <button className="btn sm pri" onClick={() => p.onDlg({ k: 'add' })}><Icon n="plus" s={14} /> {tr('accounts.add')}</button>
    </div>
    <div className="tw-wrap" style={{ overflow: 'visible' }}><table className="t acc-t">
      <colgroup><col style={{ width: '34%' }} />{p.noRoles ? null : <col style={{ width: '20%' }} />}<col style={{ width: '12%' }} /><col /><col style={{ width: 44 }} /></colgroup>
      <thead><tr><th>{tr('accounts.th.account')}</th>{p.noRoles ? null : <th>{tr('accounts.th.role')}</th>}<th>{tr('accounts.th.lane')}</th><th>{tr('accounts.th.status')}</th><th /></tr></thead>
      <tbody>{snap.accounts.map(a => {
        const chip = loginChip(tr, a);
        const issues = cfgIssues(tr, a);
        return <tr key={a.email} data-email={a.email}>
          <td className="wr"><b title={a.email}>{a.email}</b>{a.terminal ? <> <TerminalTag /></> : null}<div className="foot">{planText(a.plan)}</div></td>
          {p.noRoles ? null : <td><span className={`role r-${a.role}`}>{tr(ROLE_KEY[a.role])}</span><div className="foot mono">{capsText(tr, a)}</div></td>}
          <td className="mono">{p.noRoles ? a.lanes : lanesText(tr, a, laneCaps, snap.orchestrators)}</td>
          <td><span className="row" style={{ gap: 'var(--s2)' }}>
            {chip.relogin ? <button className={`pill ${chip.cls}`} title={chip.title} aria-label={`${chip.text} — ${tr('accounts.reloginOf', { email: a.email })}`} onClick={() => p.onDlg({ k: 'relogin', email: a.email })}>{chip.text}</button>
              : <span className={`pill ${chip.cls}`} title={chip.title}>{chip.text}</span>}
            {issues.length ? p.onCfg ? <button className="pill warn" title={issues.join(' · ')} aria-label={tr('accounts.cfgBadAria', { issues: issues.join(', ') })} onClick={p.onCfg}>⚠ {tr('labels.sw.cfgBad')}</button>
              : <span className="pill warn" title={issues.join(' · ')} aria-label={tr('accounts.cfgBadAria', { issues: issues.join(', ') })}>⚠ {tr('labels.sw.cfgBad')}</span> : null}
          </span></td>
          <td><button className="ib" aria-haspopup="menu" aria-label={tr('accounts.actionsFor', { email: a.email })} onClick={e => p.onMenu(a.email, e.currentTarget)}>⋯</button></td>
        </tr>;
      })}
      </tbody></table></div>
    {p.editor}
  </>;
}

/** hf1116 T4: the terminal's own login, listed like any account; a small neutral tag says where it comes from. */
function TerminalTag(): ReactElement {
  const tr = useT();
  return <span className="pill" title={tr('accounts.terminalTip')}>{tr('accounts.terminalTag')}</span>;
}

const planText = (plan: string | null) => {
  if (!plan) return '';
  const m = /max_(\d+)x/i.exec(plan);
  return m ? `Max ${m[1]}x` : plan.replace(/^default_claude_/, '').replace(/_/g, ' ');
};

// ---------------------------------------------------------------- A3–A7 login dialog
export interface LoginDialogProps {
  req: Extract<AccDlg, { k: 'add' } | { k: 'relogin' }>;
  snap: Snapshot; privateWindow: boolean; now: number; send: Send; onClose: () => void; toast: (t: string) => void;
  /** Same as `send` without the error toast (a refused login start shows its reason inside the dialog). */
  sendQuiet: Send;
  /** App's Escape: same as Huỷ (A4) / ✕ (A5). */
  escRef: { current: (() => void) | null };
}

const SEG_ROLES: Role[] = ['primary', 'backup', 'orchestrator'];

export function LoginDialog(p: LoginDialogProps): ReactElement {
  const { snap } = p;
  const tr = useT();
  // F16: the card action starts the login; `snap.login` at open time is the last one (maybe a finished relogin of this account)
  const f16Start = useRef<AccountLoginView | null | undefined>(p.req.k === 'relogin' && p.req.started ? snap.login : undefined);
  const adopt = useRef(liveLoginToAdopt(p.req, snap.login)); // a login already live (page reload, lost dialog): follow it
  const [id, setId] = useState<string | null>(adopt.current);
  const [email, setEmail] = useState('');
  const [sso, setSso] = useState(false);
  const [paste, setPaste] = useState(false);
  const [code, setCode] = useState('');
  const [noPrivate, setNoPrivate] = useState(false);
  const [a5, setA5] = useState<(A5Values & { restored: boolean }) | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState(p.req.k === 'add' ? 'add' : 'relogin');

  const start = async (c: Command) => {
    setErr(null); setPaste(false); setCode('');
    // A7 "Thử lại" right after a failure needs no retry: the engine broadcasts the terminal state only after the old
    // login's groups are dead and its slot is free (login.ts finish()).
    try { const v = (await p.sendQuiet(c)) as AccountLoginView | undefined; if (v?.id) setId(v.id); } catch (e) { setErr(errText(tr, e)); }
  };
  // A6 from the chip / menu: start at once (§4.3 T2 = chip + "nút mở"). F16: the card action already started it.
  useEffect(() => {
    if (p.req.k === 'relogin' && !p.req.started && !adopt.current) void start({ cmd: 'account_login', email: p.req.email });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // F16: follow the login the engine started for this account (lib f16Adopt: by data, not by the reusable row id).
  useEffect(() => {
    if (id || f16Start.current === undefined || p.req.k !== 'relogin') return;
    const got = f16Adopt(f16Start.current, snap.login, p.req.email);
    if (got) setId(got);
  }, [snap.login, id, p.req]);

  // B-I2: taken when the dialog opens — a wrong-email terminal re-login removes that row at the next refresh
  const [termRelogin] = useState(() => { const r = p.req; return r.k === 'relogin' && snap.accounts.some(a => a.terminal && a.email === r.email); });
  const l = id && snap.login?.id === id ? snap.login : null;
  const v = l ? loginDialog(tr, l, { noA5: p.req.k === 'add' && !!p.req.noA5, terminal: termRelogin }) : null;
  const doneEmail = l?.state === 'done' ? (l.realEmail ?? l.email) : null;
  useEffect(() => {
    if (v?.frame === 'A5' && doneEmail && !a5) setA5(a5Defaults(doneEmail, snap.config, snap.accounts));
    if (v?.frame === 'close') {
      if (l?.state === 'done') p.toast(tr(l.mode === 'add' ? 'accounts.toastAdded' : 'accounts.toastRelogged', { email: shortEmail(doneEmail ?? '') }));
      p.onClose();
    }
  }, [v?.frame]); // eslint-disable-line react-hooks/exhaustive-deps

  // G4 UX M6: once the link is there, focus sits on the primary open button (Enter never cancels a login)
  const priRef = useRef<HTMLButtonElement | null>(null);
  const openable = (v?.frame === 'A4' || v?.frame === 'A6') && !!l?.url;
  useEffect(() => { if (openable) priRef.current?.focus(); }, [openable, noPrivate]);

  const saveA5 = async () => {
    if (!doneEmail || !a5) return p.onClose();
    try {
      const pl = a5Payload(doneEmail, a5, snap.config);
      await p.send({ cmd: 'caps_update', caps: pl.caps as never });
      await p.send({ cmd: 'config_update', patch: { laneCaps: pl.laneCaps } });
      p.onClose();
    } catch (e) { setErr(errText(tr, e)); }
  };
  const cancel = async () => {
    if (cancelsLogin(l, p.req, snap.login)) await p.send({ cmd: 'account_login_cancel' }).catch(() => {});
    p.onClose();
  };
  const act = async (a: DlgAction) => {
    if (a.id === 'close') return p.onClose();
    if (a.id === 'keep' || a.id === 'drop') return void p.send({ cmd: 'account_login_resolve', choice: a.id }).catch(e => setErr(errText(tr, e)));
    if (a.id === 'relogin') { setMode('relogin'); setA5(null); return start({ cmd: 'account_login', email: a.email }); }
    // retry
    setA5(null);
    if (mode === 'relogin' && l?.email) return start({ cmd: 'account_login', email: l.email });
    return start({ cmd: 'account_add', ...(email.trim() ? { email: email.trim() } : {}), ...(sso ? { sso: true } : {}) });
  };
  p.escRef.current = v?.frame === 'A5' ? () => void saveA5() : () => void cancel();

  // A3 (add, not started yet)
  if (!l) {
    if (p.req.k === 'relogin') {
      return <Small title={tr('accounts.reTitle', { email: p.req.email })} onX={() => void cancel()} foot={<button className="btn" onClick={() => void cancel()}>{tr('common.cancel')}</button>}>
        {err ? <div className="err"><Icon n="alert" s={14} /><span>{err}</span></div> : <p className="foot"><span className="spin" /> {tr('accounts.opening')}</p>}
      </Small>;
    }
    const block = a3Block(tr, snap.login);
    return <Small title={tr('accounts.add')} onX={p.onClose} foot={<>
      <button className="btn" onClick={p.onClose}>{tr('common.cancel')}</button>
      <button className="btn pri" disabled={!!block} title={block ?? undefined} onClick={() => void start({ cmd: 'account_add', ...(email.trim() ? { email: email.trim() } : {}), ...(sso ? { sso: true } : {}) })}>{tr('accounts.a3.login')}</button>
    </>}>
      <label className="acc-f"><span className="foot">{tr('accounts.a3.email')}</span><input className="field" type="email" placeholder={tr('accounts.a3.placeholder')} value={email} onChange={e => setEmail(e.target.value)} autoFocus /></label>
      <div className="row"><span className="foot">{tr('accounts.a3.kind')}</span><div className="seg" role="radiogroup" aria-label={tr('accounts.a3.kind')}>
        <button role="radio" aria-checked={!sso} className={!sso ? 'on' : ''} onClick={() => setSso(false)}>{tr('accounts.a3.sub')}</button>
        <button role="radio" aria-checked={sso} className={sso ? 'on' : ''} onClick={() => setSso(true)}>SSO</button></div></div>
      <div className="preview"><Icon n="alert" /><span>{tr('accounts.a3.privateHint')}</span></div>
      {block ? <div className="foot">{block}</div> : null}
      {err ? <div className="err"><Icon n="alert" s={14} /><span>{err}</span></div> : null}
    </Small>;
  }

  if (v!.frame === 'A4' || v!.frame === 'A6') {
    const btns = a4Buttons(tr, p.privateWindow && !noPrivate);
    const url = l.url;
    const run = async (b: 'private' | 'browser' | 'copy') => {
      if (!url) return;
      if (b === 'copy') { copyText(url); p.toast(tr('accounts.copiedLink')); return; }
      if (b === 'browser') { openExternal(url); return; }
      const r = (await p.send({ cmd: 'account_open_private', url }).catch(() => ({ ok: false }))) as { ok: boolean };
      if (!r?.ok) { setNoPrivate(true); p.toast(tr('accounts.noPrivate')); }
    };
    return <Small title={v!.title} onX={() => void cancel()} foot={<button className="btn" onClick={() => void cancel()}>{tr('common.cancel')}</button>}>
      <p className="foot acc-lead">{v!.lead}</p>
      <div className="row">{btns.map(b => <button key={b.id} ref={b.pri ? priRef : undefined} className={`btn${b.pri ? ' pri' : ''}`} disabled={!url} onClick={() => void run(b.id)}>{b.label}</button>)}</div>
      <code className="url" title={url ?? ''}>{url ?? tr('accounts.gettingLink')}</code>
      {url ? <p className="foot">{tr('accounts.autoHint')}</p> : null}
      <div className="row"><span className="foot">{tr('accounts.left')}</span><span className="mono acc-timer">{countdown(l.deadline, p.now)}</span><span style={{ flex: 1 }} />
        {l.state === 'verifying' ? <span className="foot"><span className="spin" /> {tr('accounts.verifying')}</span> : !paste ? <button className="btn ghost sm" onClick={() => setPaste(true)}>{tr('accounts.pasteCode')}</button> : null}</div>
      {paste ? <><p className="foot">{tr('accounts.codeLead')}</p>
        <div className="row"><code className="url" title={l.codeUrl ?? url ?? ''} style={{ flex: 1 }}>{l.codeUrl ?? url}</code>
          <button className="btn sm" onClick={() => { copyText(l.codeUrl ?? url ?? ''); p.toast(tr('accounts.copiedLink')); }}>{tr('accounts.copyCodeLink')}</button></div></> : null}
      {paste ? <div className="row">
        <input className="field" aria-label={tr('accounts.codeAria')} placeholder="abc123…#xyz…" value={code} onChange={e => setCode(e.target.value)} style={{ flex: 1 }} autoFocus />
        <button className="btn pri sm" disabled={!/^\S+#\S+$/.test(code.trim())} onClick={() => void p.send({ cmd: 'account_paste_code', code: code.trim() }).catch(e => setErr(errText(tr, e)))}>{tr('accounts.sendCode')}</button>
      </div> : null}
      {err ? <div className="err"><Icon n="alert" s={14} /><span>{err}</span></div> : null}
    </Small>;
  }

  if (v!.frame === 'A5' && a5 && doneEmail) {
    const acc = snap.accounts.find(a => a.email === doneEmail);
    const set = (patch: Partial<A5Values>) => setA5({ ...a5, ...patch });
    return <Small title={tr('accounts.a5.title')} onX={() => void saveA5()} foot={<>
      <button className="btn ghost" style={{ color: 'var(--bad)' }} onClick={() => void p.send({ cmd: 'account_delete', email: doneEmail }).then(p.onClose, e => setErr(errText(tr, e)))}>{tr('accounts.a5.drop')}</button>
      <button className="btn pri" onClick={() => void saveA5()}>{tr('common.save')}</button>
    </>}>
      <div className="preview inf"><Icon n="check" /><span><b>{doneEmail}</b>{acc?.plan ? ` · ${planText(acc.plan)}` : ''}{a5.restored ? <span className="foot">{tr('accounts.a5.restored')}</span> : null}</span></div>
      <div className="acc-form">
        <span className="foot">{tr('accounts.a5.role')}</span><div className="seg" role="radiogroup" aria-label={tr('accounts.a5.role')}>{SEG_ROLES.map(r => <button key={r} role="radio" aria-checked={a5.role === r} className={a5.role === r ? 'on' : ''} onClick={() => setA5(withRole(a5, r, !snap.accounts.some(x => x.email !== doneEmail)))}>{tr(ROLE_KEY[r])}</button>)}</div>
        <span className="foot">{tr('accounts.a5.week')}</span><span className="row"><input className="field num" type="number" min={1} max={100} aria-label={tr('accounts.a5.week')} value={a5.week} onChange={e => set({ week: Number(e.target.value) })} /><span className="foot">%</span>
          <span className="seg"><button className={!a5.hard ? 'on' : ''} onClick={() => set({ hard: false })}>{tr('accounts.a5.soft')}</button><button className={a5.hard ? 'on' : ''} onClick={() => set({ hard: true })}>{tr('accounts.a5.hard')}</button></span></span>
        <span className="foot">{tr('accounts.a5.five')}</span><span className="row"><input className="field num" aria-label={tr('accounts.a5.five')} placeholder="—" value={a5.five} onChange={e => set({ five: e.target.value })} /><span className="foot">%</span></span>
        <span className="foot">{tr('accounts.a5.maxLanes')}</span><input className="field num" type="number" min={0} max={16} aria-label={tr('accounts.a5.maxLanes')} value={a5.maxLanes} onChange={e => set({ maxLanes: Number(e.target.value) })} />
        {a5.role === 'orchestrator' ? <><span /><span className="foot">{tr('roles.orchLanesHint')}</span></> : null}
      </div>
      {err ? <div className="err"><Icon n="alert" s={14} /><span>{err}</span></div> : null}
    </Small>;
  }

  // A7 (a)–(f)
  if (v!.frame === 'A7') {
    const sec = v!.secondary, pri = v!.primary;
    return <Small title={v!.title} onX={p.onClose} foot={<>
      {sec ? <button className="btn" onClick={() => void act(sec)}>{sec.label}</button> : null}
      {pri ? <button className="btn pri" onClick={() => void act(pri)}>{pri.label}</button> : null}
    </>}>
      <div className={`preview${v!.tone === 'bad' ? ' bad' : ''}`}><Icon n="alert" /><div>
        {v!.detail ? <code className="url">{v!.detail}</code> : null}<div>{v!.text}</div></div></div>
      {err ? <div className="err"><Icon n="alert" s={14} /><span>{err}</span></div> : null}
    </Small>;
  }
  return <Small title={v!.title || tr('accounts.loggingInTitle')} onX={p.onClose} foot={null}><p className="foot"><span className="spin" /></p></Small>;
}

function Small({ title, children, foot, onX }: { title: string; children: ReactNode; foot: ReactNode; onX: () => void }): ReactElement {
  const tr = useT();
  return <div className="modal glass acc-dlg" role="dialog" aria-label={title}>
    <div className="mh"><h2>{title}</h2><button className="x" onClick={onX} aria-label={tr('common.close')}><Icon n="x" /></button></div>
    {children}
    {foot ? <div className="row" style={{ justifyContent: 'flex-end' }}>{foot}</div> : null}
  </div>;
}

// ---------------------------------------------------------------- A8L / A8 / orphan delete
export function ConfirmDialog({ req, snap, send, onClose }: { req: Extract<AccDlg, { k: 'logout' } | { k: 'delete' } | { k: 'orphan_delete' }>; snap: Snapshot; send: Send; onClose: () => void }): ReactElement {
  const tr = useT();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (c: Command) => {
    setBusy(true); setErr(null);
    try { await send(c); onClose(); } catch (e) { setErr(errText(tr, e)); } finally { setBusy(false); }
  };
  const errLine = err ? <div className="err"><Icon n="alert" s={14} /><span>{err}</span></div> : null;
  if (req.k === 'logout') {
    const a = snap.accounts.find(x => x.email === req.email);
    const lines = a ? logoutImpact(tr, a, snap) : [];
    const impact = !!a && logoutMoves(a, snap);
    return <Small title={tr('accounts.logout.title', { email: req.email })} onX={onClose} foot={<><button className="btn" onClick={onClose}>{tr('common.cancel')}</button>
      <button className="btn bad" disabled={busy} onClick={() => void run({ cmd: 'account_logout', email: req.email })}>{tr('accounts.logout.btn')}</button></>}>
      {/* G4 UX M4: no impact = a plain line; ⚠ only when lanes / the orchestrator move */}
      {impact ? <div className="preview"><Icon n="alert" /><div>{lines.map(t => <div key={t}>{t}</div>)}<div className="foot">{tr('accounts.logout.stays')}</div></div></div>
        : <div><div className="foot">{lines.join(' ')}</div><div className="foot">{tr('accounts.logout.stays')}</div></div>}
      <p className="foot">{tr('accounts.noRevoke')}</p>{errLine}
    </Small>;
  }
  const what = req.k === 'delete' ? req.email : req.title;
  // hf1116 T3: "Xoá" on the terminal account only takes it off the list; its login, ~/.claude and Keychain item stay
  const term = req.k === 'delete' && snap.accounts.some(x => x.email === req.email && x.terminal);
  const cmd: Command = req.k === 'delete' ? { cmd: 'account_delete', email: req.email } : { cmd: 'card_action', id: req.cardId, action: 'account_orphan_delete' };
  return <Small title={req.k === 'delete' ? tr('accounts.delete.title', { email: what }) : tr('accounts.orphan.title')} onX={onClose} foot={<><button className="btn" onClick={onClose}>{tr('common.cancel')}</button>
    <button className="btn bad" disabled={busy} onClick={() => void run(cmd)}>{tr('accounts.delete.btn')}</button></>}>
    <div className="acc-cols two">
      {term ? <>
        <div><h4>{tr('accounts.delete.removes')}</h4><ul className="acc-l"><li>{tr('accounts.delete.fromList')}</li><li>{tr('accounts.delete.quota')}</li></ul></div>
        <div><h4>{tr('accounts.delete.keeps')}</h4><ul className="acc-l"><li>{tr('accounts.delete.terminalLogin')}</li><li>{tr('accounts.delete.history')}</li><li>{tr('accounts.delete.skills')}</li></ul></div>
      </> : <>
        <div><h4>{tr('accounts.delete.removes')}</h4><ul className="acc-l"><li>{tr('accounts.delete.login')}</li><li>{tr('accounts.delete.dir')}</li><li>{tr('accounts.delete.keychain')}</li><li>{tr('accounts.delete.quota')}</li></ul></div>
        <div><h4>{tr('accounts.delete.keeps')}</h4><ul className="acc-l"><li>{tr('accounts.delete.history')}</li><li>{tr('accounts.delete.skills')}</li><li>{tr('accounts.delete.roles')}</li></ul></div>
      </>}
    </div>
    <p className="foot">{tr(term ? 'accounts.delete.terminalNote' : 'accounts.noRevoke')}</p>{errLine}
  </Small>;
}

// ---------------------------------------------------------------- A9 merge (dry run first)
interface MergePlanView { ok: boolean; name: string; reason?: string; files: string[]; clashes: string[]; copies?: ClashCopyView[] }
export function MergeDialog({ req, send, onClose }: { req: Extract<AccDlg, { k: 'merge' }>; send: Send; onClose: () => void }): ReactElement {
  const tr = useT();
  const [plan, setPlan] = useState<MergePlanView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    setPlan(null); setErr(null);
    send({ cmd: 'shared_cfg_merge', email: req.email, name: req.name, dryRun: true }).then(r => setPlan(r as MergePlanView), e => setErr(errText(tr, e)));
  }, [n]); // eslint-disable-line react-hooks/exhaustive-deps
  const go = async () => {
    try {
      await send(req.cardId !== undefined ? { cmd: 'card_action', id: req.cardId, action: 'shared_cfg_merge' } : { cmd: 'shared_cfg_merge', email: req.email, name: req.name });
      onClose();
    } catch (e) { setErr(errText(tr, e)); setN(x => x + 1); }
  };
  const who = shortEmail(req.email);
  if (plan && !plan.ok && plan.reason === 'clash') {
    // G4 UX I2 (mockup A9C): both copies — owner + mtime, both folders — and "Mở Finder" on the account copy
    const copies = plan.copies ?? [];
    const reveal = (file: string) => void send({ cmd: 'shared_cfg_reveal', email: req.email, name: req.name, file }).catch(e => setErr(errText(tr, e)));
    return <Small title={tr('accounts.clash.title')} onX={onClose} foot={<>
      <button className="btn" onClick={onClose}>{tr('common.close')}</button>
      {copies.length === 1 ? <button className="btn" onClick={() => reveal(copies[0]!.file)}>{tr('accounts.clash.finder')}</button> : null}
      <button className="btn pri" onClick={() => setN(x => x + 1)}>{tr('common.retry')}</button></>}>
      <div className="preview bad"><Icon n="alert" /><div>
        <ul className="acc-l">{copies.length ? copies.map(c => <li key={c.file}><code>{c.file}</code>: {clashLine(tr, c, req.email)}
          {copies.length > 1 ? <> <button className="btn ghost sm" onClick={() => reveal(c.file)}>{tr('accounts.clash.finder')}</button></> : null}</li>)
          : plan.clashes.map(c => <li key={c} className="mono">{c}</li>)}</ul>
        {copies[0] ? <div className="foot mono acc-dirs">{who}: {tildePath(copies[0].account.dir)}<br />{tr('accounts.clash.shared')}: {tildePath(copies[0].shared.dir)}</div> : null}
        <div className="foot">{tr('accounts.clash.note')}</div></div></div>
      {err ? <div className="err"><Icon n="alert" s={14} /><span>{err}</span></div> : null}
    </Small>;
  }
  return <Small title={tr('accounts.merge.title', { name: req.name, email: who })} onX={onClose} foot={<><button className="btn" onClick={onClose}>{tr('common.cancel')}</button>
    <button className="btn pri" disabled={!plan?.ok} onClick={() => void go()}>{tr('accounts.merge.btn')}</button></>}>
    {plan ? plan.ok ? <>
      <p className="foot">{tr('accounts.merge.moves', { n: plan.files.length })} <code>~/.claude/{plan.name}</code>. {tr('accounts.merge.noOverwrite')}</p>
      <ul className="acc-l mono acc-files">{plan.files.map(f => <li key={f}>{f}</li>)}</ul>
    </> : <div className="preview bad"><Icon n="alert" /><span>{tr('accounts.merge.cant', { reason: plan.reason ?? '' })}</span></div>
      : err ? null : <p className="foot"><span className="spin" /> {tr('accounts.merge.previewing')}</p>}
    {err ? <div className="err"><Icon n="alert" s={14} /><span>{err}</span></div> : null}
  </Small>;
}
