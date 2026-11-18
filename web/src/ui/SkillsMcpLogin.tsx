// v2.2 §5.3 / §6 K3 Đăng nhập MCP (K3-find, K3 waiting, K3-done = close + toast) and K3e named errors (K3e-client with
// the Client ID / secret fields, C18). The engine runs the whole login; this dialog only starts it and draws its state.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { Command, McpLoginDetail, McpLoginError, McpOAuthView, McpRowView, SkillsMcpView } from '../../../shared/protocol.ts';
import { fmtClock } from '../lib/format.ts';
import { errText, useT, type Tr } from '../lib/i18n.tsx';
import { openExternal } from '../lib/links.ts';
import { K3_FATAL, k3Live, redirectUri, type K3Stage } from '../lib/skills-mcp-login.ts';
import { mcpShort } from '../lib/skills-mcp-sheet.ts';
import { Icon } from './icons.tsx';

type K3Act = { t: 'cancel' | 'close' | 'copy' | 'reopen' | 'edit' | 'source' | 'log' } | { t: 'retry'; clientId?: string; clientSecret?: string };

type Step = ['ok' | 'spin' | 'todo' | 'bad', 'find' | 'found' | 'register' | 'registered' | 'registerFail' | 'consent' | 'waiting'];
function steps(stage: K3Stage): Step[] {
  if (stage.s === 'find') return [['spin', 'find'], ['todo', 'register'], ['todo', 'consent']];
  if (stage.s === 'wait') return [['ok', 'found'], ['ok', 'registered'], ['spin', 'waiting']];
  return stage.s === 'error' && stage.err === 'client_registration' ? [['ok', 'found'], ['bad', 'registerFail']] : [];
}
const srcLabel = (r: McpRowView) => (r.source === 'plugin' ? `plugin ${(r.plugin ?? '').split('@')[0]}` : r.source);

/** K3e-iss / K3e-net the engine's detail line (issuers compared, or host: error), ahead of the fix. */
const detailText = (tr: Tr, d: McpLoginDetail | undefined): string =>
  !d ? '' : d.kind === 'network' ? `${tr('mcpLogin.detail.network', { host: d.host, text: d.text })} `
    : `${d.received === null ? tr('mcpLogin.detail.issuerNone', { expected: d.expected }) : tr('mcpLogin.detail.issuer', { expected: d.expected, received: d.received })} `;

/** §5.3 one cause line + one fix line; a fatal error adds the fix that follows the source (user → Sửa, else the provider). */
function ErrBox({ tr, r, err, detail }: { tr: Tr; r: McpRowView; err: McpLoginError; detail: McpLoginDetail | undefined }): ReactElement {
  const bySource = K3_FATAL.has(err) ? ` ${r.editable ? tr('mcpLogin.fix.user') : tr('mcpLogin.fix.source', { source: srcLabel(r) })}` : '';
  return <div className="k3err" role="alert"><Icon n="bang" s={14} /><div><b>{tr(`mcpLogin.err.${err}`)}</b>
    <p>{detailText(tr, detail)}{tr(`mcpLogin.fix.${err}`)}{bySource}</p></div></div>;
}

export interface LoginBodyProps {
  row: McpRowView; stage: K3Stage; now: number;
  /** K3e-client: the redirect address the PO registers. */
  redirect: string;
  /** "Mở file nguồn" target (non-user rows); null = unknown to the web (plugins). */
  sourcePath?: string | null;
  /** A refused `mcp_login` (engine error text). */
  failed?: string | null;
  act: (a: K3Act) => void;
}

/** §6 K3 / K3e drawn from the stage (pure: the container owns the engine traffic). */
export function LoginBody({ row: r, stage, now, redirect, sourcePath = null, failed = null, act }: LoginBodyProps): ReactElement {
  const tr = useT();
  const [cid, setCid] = useState('');
  const [secret, setSecret] = useState('');
  const [show, setShow] = useState(false);
  const err = stage.s === 'error' ? stage.err : null;
  const client = err === 'client_registration';
  const fatal = err !== null && K3_FATAL.has(err);
  const name = mcpShort(r);
  const left = stage.s === 'wait' && stage.until !== null ? fmtClock(stage.until - now) : null;
  const close = <button className={`btn ${fatal || failed ? 'pri' : ''}`} onClick={() => act({ t: 'close' })}>{tr('common.close')}</button>;
  return (
    <div className="modal glass smd k3" role="dialog" aria-label={`${tr('mcpLogin.verb')} ${name}`}>
      <div className="mh"><h2>{tr('mcpLogin.verb')} <span className="mono">{name}</span></h2>
        <button className="x" onClick={() => act({ t: 'close' })} aria-label={tr('common.close')}><Icon n="x" /></button></div>
      <p className="k3sub">{tr('mcpLogin.sub')}</p>
      {steps(stage).length ? <ul className="k3steps">{steps(stage).map(([st, k]) => <li key={k} className={`st-${st}`}>
        {st === 'spin' ? <span className="spin" /> : st === 'ok' ? <Icon n="check" s={14} /> : st === 'bad' ? <Icon n="bang" s={14} /> : <i className="todo" />}{tr(`mcpLogin.step.${k}`)}</li>)}</ul> : null}
      {err ? <ErrBox tr={tr} r={r} err={err} detail={stage.s === 'error' ? stage.detail : undefined} /> : null}
      {failed ? <div className="k3err" role="alert"><Icon n="bang" s={14} /><div><b>{failed}</b></div></div> : null}
      {client ? <>
        <label className="fld"><span>{tr('mcpLogin.clientId')}</span><input className="field mono" autoFocus value={cid} onChange={e => setCid(e.target.value)} /></label>
        <label className="fld"><span>{tr('mcpLogin.clientSecret')} <i>{tr('mcpLogin.optional')}</i></span><span className="k3in">
          <input className="field mono" type={show ? 'text' : 'password'} value={secret} onChange={e => setSecret(e.target.value)} />
          <button className="ib" aria-label={tr('mcpLogin.showSecret')} aria-pressed={show} onClick={() => setShow(s => !s)}><Icon n="eyeOff" s={14} /></button></span></label>
        <label className="fld"><span>{tr('mcpLogin.redirect')}</span><span className="k3in">
          <input className="field mono" readOnly value={redirect} />
          <button className="ib" aria-label={tr('mcpLogin.copyRedirect')} onClick={() => void navigator.clipboard?.writeText(redirect)}><Icon n="copy" s={14} /></button></span></label>
        <span className="foot">{tr('mcpLogin.keychainNote')}</span>
      </> : null}
      <div className="mf">
        {left !== null ? <span className="k3left"><Icon n="clock" s={14} />{tr('mcpLogin.left', { time: left })}</span> : null}
        {err ? <button className="lnk k3log" onClick={() => act({ t: 'log' })}><Icon n="file" s={14} /> {tr('mcpLogin.log')}</button> : null}
        {stage.s === 'find' || stage.s === 'wait' ? <button className="btn" onClick={() => act({ t: 'cancel' })}>{tr('common.cancel')}</button> : null}
        {stage.s === 'wait' ? <>
          <button className="btn" disabled={!stage.url} onClick={() => act({ t: 'copy' })}><Icon n="copy" s={14} /> {tr('mcpLogin.copy')}</button>
          <button className="btn" disabled={!stage.url} onClick={() => act({ t: 'reopen' })}><Icon n="globe" s={14} /> {tr('mcpLogin.reopen')}</button>
        </> : null}
        {fatal ? (r.editable ? <button className="btn" onClick={() => act({ t: 'edit' })}><Icon n="pencil" s={14} /> {tr('mcpLogin.edit')}</button>
          : sourcePath ? <button className="btn" onClick={() => act({ t: 'source' })}><Icon n="file" s={14} /> {tr('mcpLogin.openSource')}</button> : null) : null}
        {err || failed ? close : null}
        {err && !fatal ? <button className="btn pri" disabled={client && !cid.trim()}
          onClick={() => act(client ? { t: 'retry', clientId: cid.trim(), ...(secret ? { clientSecret: secret } : {}) } : { t: 'retry' })}><Icon n="refresh" s={14} /> {tr('common.retry')}</button> : null}
      </div>
    </div>
  );
}

export interface LoginDialogProps {
  row: McpRowView; view: SkillsMcpView; sourcePath: string | null;
  send: (c: Command) => Promise<unknown>; toast: (t: string) => void;
  onClose: () => void; onEdit: () => void; onOpenSource: () => void; onLog: () => void;
}

/** §6 K3: starts `mcp_login` on open, then follows the server's OAuth state (`k3Live`). */
export function McpLoginDialog(p: LoginDialogProps): ReactElement {
  const tr = useT();
  const { row, view } = p;
  const viewRef = useRef(view);
  viewRef.current = view;
  const [ack, setAck] = useState<{ ref: SkillsMcpView; o: McpOAuthView | undefined } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const start = (client: { clientId?: string; clientSecret?: string } = {}) => {
    setAck(null); setFailed(null);
    p.send({ cmd: 'mcp_login', id: row.id, ...client }).then(
      v => setAck({ ref: viewRef.current, o: (v as SkillsMcpView | null)?.mcp?.rows.find(x => x.id === row.id)?.oauth }),
      (e: unknown) => setFailed(errText(tr, e)));
  };
  useEffect(() => { start(); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once per opened dialog
  const stage: K3Stage = failed ? { s: 'idle' } : k3Live(ack, view, row.oauth);
  useEffect(() => {
    if (stage.s !== 'wait') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [stage.s]);
  const { onClose, toast } = p;
  useEffect(() => {
    if (stage.s === 'done') {
      const name = mcpShort(row);
      toast(row.tools !== null ? tr('mcpLogin.doneTools', { name, n: row.tools }) : tr('mcpLogin.done', { name }));
      onClose();
    } else if (stage.s === 'idle' && !failed && ack) onClose(); // cancelled elsewhere / the server went
  }, [stage.s]); // eslint-disable-line react-hooks/exhaustive-deps -- one reaction per stage change
  const url = stage.s === 'wait' ? stage.url : null;
  const act = (a: K3Act) => {
    switch (a.t) {
      case 'cancel': void p.send({ cmd: 'mcp_login_cancel', id: row.id }).catch(() => {}); return onClose();
      case 'close': return onClose();
      case 'copy': if (url) void navigator.clipboard?.writeText(url).then(() => toast(tr('mcpLogin.copied'))); return;
      case 'reopen': if (url) openExternal(url); return;
      case 'edit': return p.onEdit();
      case 'source': return p.onOpenSource();
      case 'log': return p.onLog();
      case 'retry': return start(a.clientId ? { clientId: a.clientId, ...(a.clientSecret ? { clientSecret: a.clientSecret } : {}) } : {});
    }
  };
  return <LoginBody row={row} stage={stage} now={now} redirect={redirectUri(row, location.origin)} sourcePath={p.sourcePath} failed={failed} act={act} />;
}
