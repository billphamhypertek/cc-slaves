// v2.2 §6 K4 Thêm MCP (Dán JSON / Điền form, checks before writing, "Sẽ chạy:"), K5 Sửa MCP (same form filled, two
// commands + restore note), K4e write errors (form kept), K14 "vừa đổi" band, K6 Xoá MCP.
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { Command, McpRowView, SkillsMcpView } from '../../../shared/protocol.ts';
import { errText, useT } from '../lib/i18n.tsx';
import { addJsonCmd, checkParts, checkServer, draftOf, editPlan, formConfig, localCommands, parsePaste, type FormDraft, type LoginMode, type Paste } from '../lib/skills-mcp-sheet.ts';
import { CommandError } from '../lib/ws.ts';
import { Icon } from './icons.tsx';

const BLANK: FormDraft = { kind: 'local', command: '', args: '', env: '', url: '', headers: '', login: 'auto', clientId: '', clientSecret: '', oauthKeep: {} };
const userNames = (v: SkillsMcpView) => v.mcp.rows.filter(r => r.source === 'user').map(r => r.name);
const LOGINS: readonly LoginMode[] = ['auto', 'none', 'client'];

function Cmds({ lines }: { lines: string[] }): ReactElement {
  return <div className="cmds">{lines.map((l, i) => <code key={i} className="cmd">{lines.length > 1 ? <i>{i + 1}</i> : <i>$</i>}{l}</code>)}</div>;
}

/** A failed write as the dialog keeps it: the catalog key + params the engine sent (K4e) and the text of anything else. */
export interface WriteErr { key: string | null; params: Record<string, string | number>; text: string }
const writeErr = (tr: ReturnType<typeof useT>, e: unknown): WriteErr =>
  ({ key: e instanceof CommandError ? e.key ?? null : null, params: e instanceof CommandError ? e.params ?? {} : {}, text: errText(tr, e) });

/** §6 K4e-race / K4e-restore: the write error on top of the form, its title + why (exit text); the form stays as typed. */
export function WriteErrorBlock({ err }: { err: WriteErr }): ReactElement {
  const tr = useT();
  const p = err.params;
  const why = err.key === 'skillsMcp.err.busy' ? tr('skillsMcp.k4e.why.busy')
    : err.key === 'skillsMcp.err.restored' ? tr(p.exit ? 'skillsMcp.k4e.why.restoredExit' : 'skillsMcp.k4e.why.restoredRead', p) : null;
  return <div className={`band k4e ${err.key === 'skillsMcp.err.restored' ? 'warn' : 'bad'}`} role="alert">
    <Icon n="alert" s={14} /><span><b>{err.text}</b>{why}</span></div>;
}

/** §6 K5 / §5.3 a new URL drops the login: said before saving, with the lanes that lose the server's tools until then. */
export function UrlChangedBand({ lanes }: { lanes: readonly string[] }): ReactElement {
  const tr = useT();
  return <div className="band warn k4e"><Icon n="alert" s={14} /><span><b>{tr('skillsMcp.k5.urlTitle')}</b>{tr('skillsMcp.k5.urlText')}
    {lanes.length ? ` ${tr('skillsMcp.k5.urlLanes', { lanes: lanes.join(', ') })}` : null}</span></div>;
}

export interface AddProps {
  view: SkillsMcpView;
  /** K5: the row being edited (a user entry); null = K4. */
  edit: McpRowView | null;
  /** K5: the lanes using the edited server (a URL change names them). */
  lanes: readonly string[];
  send: (c: Command) => Promise<unknown>;
  onClose: () => void;
}

/** §6 K4 / K5. */
export function McpAddDialog({ view, edit, lanes, send, onClose }: AddProps): ReactElement {
  const tr = useT();
  const [mode, setMode] = useState<'json' | 'form'>(edit ? 'form' : 'json');
  const [text, setText] = useState('');
  const [name, setName] = useState(edit?.name ?? '');
  const [draft, setDraft] = useState<FormDraft>(edit ? draftOf(edit.config, edit.noLogin === true) : BLANK);
  const [rev, setRev] = useState(view.claudeJson.rev);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<WriteErr | null>(null);
  const [paths, setPaths] = useState<Record<string, string | null>>({});
  const live = edit ? view.mcp.rows.find(r => r.id === edit.id) ?? edit : null;
  const taken = userNames(view).filter(n => n !== edit?.name);
  const parsed: Paste = useMemo(() => (mode === 'json' ? parsePaste(text, name, taken) : checkServer(name.trim(), formConfig(draft), taken)), [mode, text, name, draft, taken.join('\0')]); // eslint-disable-line react-hooks/exhaustive-deps
  const cmds = parsed.ok ? localCommands(parsed.servers) : [];
  // K4 "npx có trên PATH (…)": the engine looks each new command up on the login PATH (debounced while typing)
  useEffect(() => {
    const todo = cmds.filter(c => !(c in paths));
    if (!todo.length) return;
    const t = setTimeout(() => { for (const c of todo) send({ cmd: 'mcp_which', command: c }).then(r => setPaths(p => ({ ...p, [c]: (r as { path: string | null }).path })), () => {}); }, 300);
    return () => clearTimeout(t);
  }, [cmds.join('\0')]); // eslint-disable-line react-hooks/exhaustive-deps
  // our own failed write changed the file (K4e-restore wrote the old entry back): adopt the next rev, no "vừa đổi" band
  const [adopt, setAdopt] = useState(false);
  useEffect(() => { if (adopt && rev !== view.claudeJson.rev) { setRev(view.claudeJson.rev); setAdopt(false); } }, [adopt, rev, view.claudeJson.rev]);
  const changed = !adopt && rev !== view.claudeJson.rev;
  const reload = () => { setRev(view.claudeJson.rev); if (live) setDraft(draftOf(live.config, live.noLogin === true)); setErr(null); };
  const plan = edit && parsed.ok ? editPlan(edit.name, parsed.servers[0]!.name, live!.config, parsed.servers[0]!.config) : null;
  const set = <K extends keyof FormDraft>(k: K, v: FormDraft[K]) => setDraft(d => ({ ...d, [k]: v }));
  const remoteForm = mode === 'form' && draft.kind === 'remote';
  const login = remoteForm ? { ...(draft.login === 'none' ? { noLogin: true } : {}), ...(draft.login === 'client' && draft.clientSecret ? { clientSecret: draft.clientSecret } : {}) } : {};
  const save = async () => {
    if (!parsed.ok) return;
    setBusy(true); setErr(null);
    try {
      for (const s of parsed.servers) {
        await send(edit ? { cmd: 'mcp_edit', name: edit.name, ...(s.name !== edit.name ? { to: s.name } : {}), config: s.config, rev, ...login } : { cmd: 'mcp_add', name: s.name, config: s.config, rev, ...login });
      }
      onClose();
    } catch (e) {
      const w = writeErr(tr, e);
      setErr(w);
      setAdopt(w.key !== 'skillsMcp.err.sourceChanged');
    } finally { setBusy(false); }
  };
  const ok = parsed.ok ? checkParts(parsed.servers, mode === 'form', paths, edit?.name ?? null) : null;
  const checkLine = !parsed.ok ? (parsed.err === 'empty' ? null : <div className="err"><Icon n="alert" s={14} /><span>{tr(`skillsMcp.k4.err.${parsed.err}`, { name: parsed.name ?? '', line: parsed.line ?? 1, col: parsed.col ?? 1 })}</span></div>)
    : <>{<div className="okline"><Icon n="check" s={14} /><span>{ok!.parts.map(x => tr(x.key, x.params)).join(' · ')}</span></div>}
      {ok!.missing.map(cmd => <div key={cmd} className="warnline"><Icon n="alert" s={14} /><span>{tr('skillsMcp.k4.ok.notOnPath', { cmd })}</span></div>)}</>;
  const field = (k: 'command' | 'args' | 'env' | 'url' | 'headers' | 'clientId' | 'clientSecret', label: string, ph = '', area = false) => <label className="fld"><span>{label}</span>
    {area ? <textarea className="field mono" rows={2} value={draft[k]} placeholder={ph} onChange={e => set(k, e.target.value)} />
      : <input className="field mono" type={k === 'clientSecret' ? 'password' : 'text'} value={draft[k]} placeholder={ph} onChange={e => set(k, e.target.value)} />}</label>;
  const retry = err !== null && err.key !== 'skillsMcp.err.sourceChanged';
  return (
    <div className="modal glass smd" role="dialog" aria-label={edit ? tr('skillsMcp.k5.title', { name: edit.name }) : tr('skillsMcp.k4.title')}>
      <div className="mh"><h2>{edit ? <>{tr('skillsMcp.k5.verb')} <span className="mono">{edit.name}</span></> : tr('skillsMcp.k4.title')}</h2>
        <button className="x" onClick={onClose} aria-label={tr('common.close')}><Icon n="x" /></button></div>
      {err ? <WriteErrorBlock err={err} /> : null}
      {changed ? <div className="band warn"><Icon n="alert" s={14} /><span>{tr('skillsMcp.k14.changed')}</span><button className="btn" onClick={reload}>{tr('skillsMcp.k14.reload')}</button></div> : null}
      {!edit ? <div className="stabs" role="tablist">
        <button role="tab" aria-selected={mode === 'json'} className={mode === 'json' ? 'on' : ''} onClick={() => setMode('json')}><Icon n="file" s={14} /> {tr('skillsMcp.k4.json')}</button>
        <button role="tab" aria-selected={mode === 'form'} className={mode === 'form' ? 'on' : ''} onClick={() => setMode('form')}><Icon n="list" s={14} /> {tr('skillsMcp.k4.form')}</button>
      </div> : null}
      {mode === 'json' ? <>
        <label className="fld"><span>{tr('skillsMcp.k4.pasteHint')}</span>
          <textarea className={`field mono paste${!parsed.ok && parsed.err === 'badJson' ? ' bad' : ''}`} rows={8} autoFocus value={text} onChange={e => setText(e.target.value)} aria-label={tr('skillsMcp.k4.json')} /></label>
        {parsed.ok || parsed.err !== 'needName' ? null : <label className="fld"><span>{tr('skillsMcp.k4.name')}</span><input className="field mono" value={name} onChange={e => setName(e.target.value)} /></label>}
      </> : <>
        <div className="frow">
          <label className="fld"><span>{tr('skillsMcp.k4.name')}</span><input className="field mono" value={name} onChange={e => setName(e.target.value)} /></label>
          <div className="fld"><span>{tr('skillsMcp.k4.kind')}</span><div className="seg" role="radiogroup">
            {(['local', 'remote'] as const).map(k => <button key={k} role="radio" aria-checked={draft.kind === k} className={draft.kind === k ? 'on' : ''} onClick={() => set('kind', k)}>
              <Icon n={k === 'local' ? 'term' : 'globe'} s={14} /> {tr(`skillsMcp.k4.kind.${k}`)}</button>)}</div></div>
        </div>
        {draft.kind === 'local' ? <>{field('command', tr('skillsMcp.k4.command'), 'npx')}{field('args', tr('skillsMcp.k4.args'), '-y @scope/mcp')}{field('env', tr('skillsMcp.k4.env'), 'KEY=value', true)}</>
          : <>{field('url', 'URL', 'https://')}
            {plan?.urlChanged ? <UrlChangedBand lanes={lanes} /> : null}
            {field('headers', tr('skillsMcp.k4.headers'), tr('skillsMcp.k4.headersPh'), true)}
            <div className="fld"><span>{tr('skillsMcp.k4.login')}</span><div className="seg" role="radiogroup" aria-label={tr('skillsMcp.k4.login')}>
              {LOGINS.map(m => <button key={m} role="radio" aria-checked={draft.login === m} className={draft.login === m ? 'on' : ''} onClick={() => set('login', m)}>{tr(`skillsMcp.k4.login.${m}`)}</button>)}</div></div>
            {draft.login === 'client' ? <div className="frow">{field('clientId', tr('skillsMcp.k4.login.client'))}{field('clientSecret', tr('skillsMcp.k4.clientSecret'))}</div> : null}</>}
      </>}
      {checkLine}
      {edit && plan?.remote ? <div className="band inf"><Icon n="term" s={14} /><span><b>{tr('skillsMcp.k5.terminal', { name: edit.name })}</b> {tr('skillsMcp.k5.terminalText')}</span></div> : null}
      <div className="fld"><span>{tr('skillsMcp.k4.willRun')}</span>
        <Cmds lines={plan ? plan.cmds : parsed.ok ? parsed.servers.map(s => addJsonCmd(s.name, s.config)) : [addJsonCmd(name || '…', {})]} />
        {edit ? <span className="foot">{tr('skillsMcp.k5.restoreNote')}</span> : null}</div>
      <div className="mf"><span className="foot" style={{ marginRight: 'auto' }}>{tr(edit ? 'skillsMcp.applyNext' : 'skillsMcp.k4.foot')}</span>
        <button className="btn" onClick={onClose}>{tr('common.cancel')}</button>
        <button className="btn pri" disabled={!parsed.ok || busy || !view.claude.found || !view.claudeJson.ok} onClick={() => void save()}>
          {retry ? <><Icon n="refresh" s={14} /> {tr('skillsMcp.retry')}</> : tr('common.save')}</button></div>
    </div>
  );
}

/** §6 K6 Xoá MCP: the terminal loses it too, lanes in use lose it from their next run, the login in cc-slaves goes. */
export function McpRemoveDialog({ row, lanes, rev, send, onClose }: { row: McpRowView; lanes: string[]; rev: string; send: (c: Command) => Promise<unknown>; onClose: () => void }): ReactElement {
  const tr = useT();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = () => { setBusy(true); send({ cmd: 'mcp_remove', name: row.name, rev }).then(onClose, (e: unknown) => { setErr(errText(tr, e)); setBusy(false); }); };
  return (
    <div className="modal glass smd small" role="dialog" aria-label={tr('skillsMcp.k6.title', { name: row.name })}>
      <h2>{tr('skillsMcp.k6.title', { name: row.name })}</h2>
      <ul className="k6">
        <li><Icon n="term" s={14} />{tr('skillsMcp.k6.terminal')}</li>
        {lanes.length ? <li><Icon n="fork" s={14} />{tr('skillsMcp.k6.lanes', { lanes: lanes.join(', ') })}</li> : null}
        {row.kind !== 'stdio' ? <li><Icon n="lock" s={14} />{tr('skillsMcp.k6.login')}</li> : null}
      </ul>
      <Cmds lines={[`claude mcp remove -s user ${row.name}`]} />
      {err ? <div className="err" role="alert"><Icon n="alert" s={14} /><span>{err}</span></div> : null}
      <div className="mf"><button className="btn" onClick={onClose}>{tr('common.cancel')}</button><button className="btn bad solid" disabled={busy} onClick={go}>{tr('skillsMcp.k6.verb')}</button></div>
    </div>
  );
}
