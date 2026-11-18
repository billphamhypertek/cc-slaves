// hotfix 2026-11-16 (b) the optional Git block (docs/ref/hf1116-ux.md): Git · Danh tính commit · GitHub rows in the wizard's
// "Công cụ" step, Cài đặt › Git and the Git tab when git is missing / blocked. Every row is optional (never gates "Tiếp");
// all ✓ → one line. Lazy chunk with its `gitSetup` catalog; the actions are Mac only (rows read-only elsewhere).
import { useEffect, useState, type ReactElement } from 'react';
import { identityIssue } from '../../../shared/git-identity.ts';
import { loadLazyNs } from '../../../shared/i18n/lazy.ts';
import type { Command, GitSetup as Git, SetupStatus } from '../../../shared/protocol.ts';
import { gitAllOk, gitRow, identityOk, identityPrefill, INSTALL_POLL_MS, LICENSE_CMD, polling, readyLine } from '../lib/git-setup.ts';
import { errText, useT } from '../lib/i18n.tsx';
import { copyText, openExternal } from '../lib/links.ts';
import { Icon } from './icons.tsx';
import './gitSetup.css';

loadLazyNs(); // the `gitSetup` namespace ships with this chunk

export interface GitSetupProps {
  setup: SetupStatus;
  send: (c: Command) => Promise<unknown>;
  /** Mac channel: buttons and the identity form; elsewhere the rows are read-only. */
  mac: boolean;
  toast?: (t: string) => void;
  /** The wizard: "Bỏ qua được — thiết lập sau ở Cài đặt › Git." */
  later?: boolean;
  /** @internal tests: the install start time (ms) and the clock. */
  installAt?: number | null;
  now?: number;
}

type Ic = 'ok' | 'na' | 'no' | 'run';
function Row({ ic, title, sub, acts, more }: { ic: Ic; title: string; sub?: ReactElement | string | null; acts?: ReactElement | null; more?: ReactElement | null }): ReactElement {
  const icon = ic === 'run' ? <span className="spin" /> : <Icon n={ic === 'ok' ? 'check' : ic === 'no' ? 'alert' : 'info'} s={15} />;
  return <div className="dep gs-row"><span className={`ic ${ic}`}>{icon}</span><b>{title}</b>{sub ? <small>{sub}</small> : null}
    {acts ? <span className="acts2">{acts}</span> : null}{more ? <div className="more">{more}</div> : null}</div>;
}

function Copy({ text, toast }: { text: string; toast?: (t: string) => void }): ReactElement {
  const tr = useT();
  return <button type="button" className="btn sm" onClick={() => { copyText(text); toast?.(tr('gitSetup.copied')); }}><Icon n="copy" s={13} /> {tr('gitSetup.copy')}</button>;
}

function GitLine({ g, row, p, onInstall }: { g: Git; row: ReturnType<typeof gitRow>; p: GitSetupProps; onInstall: () => void }): ReactElement {
  const tr = useT();
  const recheck = p.mac ? <button type="button" className="btn sm" onClick={() => void p.send({ cmd: 'setup_check' }).catch(() => {})}><Icon n="refresh" s={13} /> {tr('gitSetup.recheck')}</button> : null;
  if (row === 'ok') return <Row ic="ok" title={tr('gitSetup.git.ok', { version: g.version ?? '' })} sub={tr('gitSetup.git.okSub')} />;
  if (row === 'installing') return <Row ic="run" title={tr('gitSetup.git.installing')} sub={tr('gitSetup.git.installingSub')} acts={recheck} />;
  if (row === 'missing') {
    return <Row ic="na" title={tr('gitSetup.git.missing')} sub={tr('gitSetup.git.missingSub')}
      acts={p.mac ? <button type="button" className="btn sm pri" onClick={onInstall}><Icon n="dl" s={13} /> {tr('gitSetup.git.install')}</button> : null} />;
  }
  if (row === 'license') {
    return <Row ic="no" title={tr('gitSetup.git.license')} sub={tr('gitSetup.git.licenseSub')} acts={recheck}
      more={<span className="gs-cmd"><span className="code">{LICENSE_CMD}</span>{p.mac ? <Copy text={LICENSE_CMD} {...(p.toast ? { toast: p.toast } : {})} /> : null}</span>} />;
  }
  return <Row ic="no" title={tr('gitSetup.git.error')} sub={g.detail} acts={recheck} />;
}

function IdentityLine({ p }: { p: GitSetupProps }): ReactElement {
  const tr = useT();
  const g = p.setup.git;
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState(() => identityPrefill(p.setup));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const title = tr('gitSetup.id.title');
  if (g.state !== 'ok') return <Row ic="na" title={title} sub={tr('gitSetup.id.needGit')} />;
  if (identityOk(g) && !edit) {
    return <Row ic="ok" title={title} sub={tr('gitSetup.id.ok', { name: g.identity.name ?? '', email: g.identity.email ?? '' })}
      acts={p.mac ? <button type="button" className="btn sm" onClick={() => { setForm(identityPrefill(p.setup)); setEdit(true); }}><Icon n="pencil" s={13} /> {tr('gitSetup.id.edit')}</button> : null} />;
  }
  if (!p.mac) return <Row ic="na" title={title} sub={tr('gitSetup.id.missingSub')} />;
  const issue = identityIssue(form.name, form.email);
  const hint = issue === 'email' && form.email.trim() ? tr('gitSetup.id.badEmail') : issue === 'name' && form.name.trim() ? tr('gitSetup.id.badName') : null;
  const save = async () => {
    setBusy(true); setErr(null);
    try { await p.send({ cmd: 'git_identity_set', name: form.name, email: form.email }); setEdit(false); } catch (e) { setErr(errText(tr, e)); } finally { setBusy(false); }
  };
  return <Row ic="na" title={title} sub={tr('gitSetup.id.missingSub')} more={<>
    <form className="gs-form" onSubmit={e => { e.preventDefault(); if (!issue && !busy) void save(); }}>
      <input className="field" aria-label={tr('gitSetup.id.name')} placeholder={tr('gitSetup.id.name')} value={form.name} autoComplete="name" onChange={e => setForm({ ...form, name: e.target.value })} />
      <input className="field gs-email" type="email" aria-label={tr('gitSetup.id.email')} placeholder={tr('gitSetup.id.email')} value={form.email} autoComplete="email" onChange={e => setForm({ ...form, email: e.target.value })} />
      <button type="submit" className="btn pri" disabled={!!issue || busy}>{busy ? <span className="spin" /> : null}{tr('gitSetup.id.save')}</button>
    </form>
    {hint || err ? <div className="err"><Icon n="alert" s={14} /><span>{err ?? hint}</span></div> : null}
  </>} />;
}

function GhLine({ p }: { p: GitSetupProps }): ReactElement {
  const tr = useT();
  const g = p.setup.git;
  const title = tr('gitSetup.gh.title');
  const send = (cmd: 'gh_login' | 'gh_login_cancel') => void p.send({ cmd }).catch((e: unknown) => p.toast?.(errText(tr, e)));
  const cancel = p.mac ? <button type="button" className="btn sm" onClick={() => send('gh_login_cancel')}>{tr('gitSetup.gh.cancel')}</button> : null;
  const l = g.ghLogin;
  if (g.gh === 'ok' && !l) return <Row ic="ok" title={title} sub={g.ghUser ? tr('gitSetup.gh.ok', { user: g.ghUser }) : tr('gitSetup.gh.okNoUser')} />;
  if (l?.state === 'waiting' && l.code) {
    return <Row ic="run" title={title} sub={tr('gitSetup.gh.code')} acts={cancel} more={<span className="gs-cmd">
      <span className="gs-code">{l.code}</span>{p.mac ? <><Copy text={l.code} {...(p.toast ? { toast: p.toast } : {})} />
        {l.url ? <button type="button" className="btn sm pri" onClick={() => openExternal(l.url!)}><Icon n="extLink" s={13} /> {tr('gitSetup.gh.open')}</button> : null}</> : null}
    </span>} />;
  }
  if (l && l.state !== 'failed') return <Row ic="run" title={title} sub={tr('gitSetup.gh.starting')} acts={cancel} />;
  const login = (k: 'gitSetup.gh.login' | 'gitSetup.gh.retry') => (p.mac ? <button type="button" className="btn sm" onClick={() => send('gh_login')}><Icon n="logIn" s={13} /> {tr(k)}</button> : null);
  if (l?.state === 'failed') return <Row ic="no" title={title} sub={l.detail ? `${tr('gitSetup.gh.failed')}: ${l.detail}` : tr('gitSetup.gh.failed')} acts={login('gitSetup.gh.retry')} />;
  if (g.gh === 'logged_out') return <Row ic="na" title={title} sub={tr('gitSetup.gh.loggedOut')} acts={login('gitSetup.gh.login')} />;
  return <Row ic="na" title={title} sub={tr('gitSetup.gh.missing')} />;
}

export default function GitSetup(p: GitSetupProps): ReactElement {
  const tr = useT();
  const g = p.setup.git;
  const [installAt, setInstallAt] = useState<number | null>(p.installAt ?? null);
  const [tick, setTick] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const now = p.now ?? tick;
  const poll = polling(g, installAt, now);
  // G3: Apple's installer runs on its own → `setup_check` every 5 s while "Đang cài…" (≤ 30 min, until git is ok)
  useEffect(() => {
    if (!poll) return;
    const t = setInterval(() => { setTick(Date.now()); void p.send({ cmd: 'setup_check' }).catch(() => {}); }, INSTALL_POLL_MS);
    return () => clearInterval(t);
  }, [poll]); // eslint-disable-line react-hooks/exhaustive-deps -- p.send is stable per connection
  const install = async () => {
    try {
      const r = await p.send({ cmd: 'git_install' }) as { opened: boolean };
      if (r.opened) { setInstallAt(Date.now()); setTick(Date.now()); } else { p.toast?.(tr('gitSetup.git.already')); void p.send({ cmd: 'setup_check' }).catch(() => {}); }
    } catch (e) { p.toast?.(errText(tr, e)); }
  };
  const folded = gitAllOk(g) && !open;
  return <section className="gsetup" aria-label={tr('gitSetup.title')}>
    <div className="gs-head"><b>{tr('gitSetup.title')}</b><span className="foot">{tr('gitSetup.why')}{p.later ? ` ${tr('gitSetup.later')}` : ''}</span></div>
    {folded ? <Row ic="ok" title={readyLine(tr, g)} acts={<button type="button" className="btn sm" onClick={() => setOpen(true)}>{tr('gitSetup.details')}</button>} />
      : <><GitLine g={g} row={gitRow(g, installAt, now)} p={p} onInstall={() => void install()} /><IdentityLine p={p} /><GhLine p={p} /></>}
    {p.mac ? null : <span className="foot">{tr('gitSetup.macOnly')}</span>}
  </section>;
}
