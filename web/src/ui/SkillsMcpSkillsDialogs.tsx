// v2.2 §6 K9 Thêm skill (Git: fetch on paste / Enter, every valid skill preselected with its description; Thư mục: the
// engine's §5.5 dry-run checks of the picked folder block "Thêm", link (default) / copy) and K10 Xoá skill (link → unlink, the target stays; real folder → Trash).
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { Command, SkillDirCheck, SkillGitFetch, SkillRowView, SkillsMcpView } from '../../../shared/protocol.ts';
import { errText, useT } from '../lib/i18n.tsx';
import { pickFolder } from '../lib/pick-folder.ts';
import { dirErr, folderLines, gitPicks } from '../lib/skills-mcp-skills.ts';
import { Icon } from './icons.tsx';

type Send = (c: Command) => Promise<unknown>;
const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');
const Err = ({ text }: { text: string | null }) => (text ? <div className="err" role="alert"><Icon n="alert" s={14} /><span>{text}</span></div> : null);

function GitTab({ send, onClose }: { send: Send; onClose: () => void }): ReactElement {
  const tr = useT();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fetched, setFetched] = useState<SkillGitFetch | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const clone = useRef<string | null>(null);
  const sendRef = useRef(send);
  sendRef.current = send;
  // closing the dialog (or the other tab) drops the clone the engine keeps
  useEffect(() => () => { if (clone.current) void sendRef.current({ cmd: 'skill_git_cancel', cloneId: clone.current }).catch(() => {}); }, []);
  const picks = fetched ? gitPicks(fetched.candidates) : [];
  const fetch = (u: string) => {
    if (!u.trim() || busy) return;
    setBusy(true); setErr(null); setFetched(null);
    send({ cmd: 'skill_git_fetch', url: u.trim() }).then(r => {
      const f = r as SkillGitFetch;
      clone.current = f.cloneId; setFetched(f);
      setPicked(new Set(gitPicks(f.candidates).filter(p => !p.err).map(p => p.name))); // §4.3 T6 preselected
    }, (e: unknown) => setErr(errText(tr, e))).finally(() => setBusy(false));
  };
  const add = () => {
    if (!fetched) return;
    setBusy(true);
    send({ cmd: 'skill_git_add', cloneId: fetched.cloneId, names: [...picked] }).then(() => { clone.current = null; onClose(); },
      (e: unknown) => { setErr(errText(tr, e)); setBusy(false); });
  };
  const flip = (n: string) => setPicked(s => { const x = new Set(s); if (x.has(n)) x.delete(n); else x.add(n); return x; });
  return <>
    <label className="fld"><span>{tr('skillsMcp.k9.url')}</span>
      <input className="field mono" autoFocus value={url} placeholder="https://github.com/…" onChange={e => setUrl(e.target.value)}
        onPaste={e => { const t = e.clipboardData.getData('text'); setTimeout(() => fetch(t), 0); }} onKeyDown={e => { if (e.key === 'Enter') fetch(url); }} /></label>
    {busy && !fetched ? <div className="foot"><span className="spin" /> {tr('skillsMcp.k9.fetching')}</div>
      : fetched ? <div className="okline"><Icon n="check" s={14} />{tr('skillsMcp.k9.found', { n: fetched.candidates.length })}</div>
      : <div className="foot">{tr('skillsMcp.k9.hint')}</div>}
    {fetched ? <div className="k9l">{picks.map(p => <label key={p.name} className={p.err ? 'bad' : ''}>
      <input type="checkbox" checked={picked.has(p.name)} disabled={!!p.err} onChange={() => flip(p.name)} />
      <b className="mono">{p.name}</b>{p.err ? <span className="why">{tr(`skillsMcp.k9.err.${p.err}`, { name: p.name, fm: p.fm })}</span>
        : <span className="desc">{p.description}</span>}</label>)}</div> : null}
    <span className="foot">{tr('skillsMcp.k9.dest')}</span>
    <Err text={err} />
    <div className="mf"><button className="btn" onClick={onClose}>{tr('common.cancel')}</button>
      <button className="btn pri" disabled={!picked.size || busy} onClick={add}>{tr('skillsMcp.k9.addN', { n: picked.size })}</button></div>
  </>;
}

/** K9-folder: the engine's dry run of `path` (debounced while typing; re-run when the skills view changes). */
function useFolderCheck(path: string, view: SkillsMcpView, send: Send): { path: string; c: SkillDirCheck | null; err: unknown } | null {
  const [res, setRes] = useState<{ path: string; c: SkillDirCheck | null; err: unknown } | null>(null);
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    const p = path.trim();
    if (!p) { setRes(null); return; }
    let live = true;
    const t = setTimeout(() => void sendRef.current({ cmd: 'skill_check_folder', path: p })
      .then(r => { if (live) setRes({ path: p, c: r as SkillDirCheck, err: null }); }, (e: unknown) => { if (live) setRes({ path: p, c: null, err: e }); }), 250);
    return () => { live = false; clearTimeout(t); };
  }, [path, view.skills]);
  return res;
}

function FolderTab({ view, send, onClose }: { view: SkillsMcpView; send: Send; onClose: () => void }): ReactElement {
  const tr = useT();
  const [path, setPath] = useState('');
  const [mode, setMode] = useState<'link' | 'copy'>('link'); // §4.4 default: link (the PO edits the skill where it lives)
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const res = useFolderCheck(path, view, send);
  const chk = res?.path === path.trim() ? res : null; // a result for an older path never unlocks "Thêm"
  const ok = !!chk?.c && !dirErr(chk.c);
  const pick = () => void pickFolder(send, tr('labels.pickRepo')).then(p => { if (p) setPath(p); }, (e: unknown) => setErr(errText(tr, e)));
  const add = () => {
    setBusy(true); setErr(null);
    send({ cmd: 'skill_add_folder', path: path.trim(), mode }).then(onClose, (e: unknown) => { setErr(errText(tr, e)); setBusy(false); });
  };
  const opt = (m: 'link' | 'copy') => <label className={`k9o ${mode === m ? 'on' : ''}`}><input type="radio" name="k9mode" checked={mode === m} onChange={() => setMode(m)} />
    <span><b>{tr(`skillsMcp.k9.${m}`)}</b><span className="foot">{tr(`skillsMcp.k9.${m}Why`, { name: chk?.c?.dir ?? '<tên>' })}</span></span></label>;
  return <>
    <div className="fld"><span>{tr('skillsMcp.k9.dir')}</span><div className="frow">
      <input className="field mono" value={path} aria-label={tr('skillsMcp.k9.dir')} placeholder="~/Works/Projects/…" onChange={e => setPath(e.target.value)} />
      <button className="btn" onClick={pick}><Icon n="folder" s={14} /> {tr('skillsMcp.k9.pick')}</button></div></div>
    {path.trim() ? <div className="k9c">
      {!chk ? <div className="foot"><span className="spin" /> {tr('skillsMcp.k9.checking')}</div>
        : chk.c ? folderLines(chk.c).map(l => <div key={l.key} className={l.ok ? 'okline' : 'err'}><Icon n={l.ok ? 'check' : 'bang'} s={14} />
          <span>{tr(l.key, { name: l.name ?? '', to: tilde(l.to ?? '') })}</span></div>)
        : <div className="err"><Icon n="bang" s={14} /><span>{errText(tr, chk.err)}</span></div>}</div> : null}
    {opt('link')}{opt('copy')}
    <Err text={err} />
    <div className="mf">{chk && !ok ? <span className="foot bad" style={{ marginRight: 'auto' }}>{tr('skillsMcp.k9.fixFirst')}</span> : null}
      <button className="btn" onClick={onClose}>{tr('common.cancel')}</button>
      <button className="btn pri" disabled={!ok || busy} onClick={add}>{tr('skillsMcp.k9.add')}</button></div>
  </>;
}

/** §6 K9 Thêm skill: two tabs, Git first. */
export function SkillAddDialog({ view, send, onClose }: { view: SkillsMcpView; send: Send; onClose: () => void }): ReactElement {
  const tr = useT();
  const [tab, setTab] = useState<'git' | 'folder'>('git');
  return (
    <div className="modal glass smd" role="dialog" aria-label={tr('skillsMcp.k9.title')}>
      <div className="mh"><h2>{tr('skillsMcp.k9.title')}</h2><button className="x" onClick={onClose} aria-label={tr('common.close')}><Icon n="x" /></button></div>
      <div className="stabs" role="tablist">{(['git', 'folder'] as const).map(t => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
        <Icon n={t === 'git' ? 'fork' : 'folder'} s={14} />{tr(`skillsMcp.k9.${t}`)}</button>)}</div>
      {tab === 'git' ? <GitTab send={send} onClose={onClose} /> : <FolderTab view={view} send={send} onClose={onClose} />}
    </div>
  );
}

/** §6 K10 Xoá skill: a link is unlinked (its target stays), a real folder goes to the Trash; running lanes keep it until their next run. */
export function SkillRemoveDialog({ row, send, onClose }: { row: SkillRowView; send: Send; onClose: () => void }): ReactElement {
  const tr = useT();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const k = row.link ? 'Link' : 'Dir';
  const go = () => { setBusy(true); send({ cmd: 'skill_remove', id: row.id }).then(onClose, (e: unknown) => { setErr(errText(tr, e)); setBusy(false); }); };
  return (
    <div className="modal glass smd small" role="dialog" aria-label={tr(`skillsMcp.k10.title${k}`, { name: row.name })}>
      <h2>{tr(`skillsMcp.k10.title${k}`, { name: row.name })}</h2>
      <ul className="k6">
        <li><Icon n={row.link ? 'swap' : 'folder'} s={14} />{row.link ? tr('skillsMcp.k10.link', { name: row.name, to: tilde(row.link) }) : tr('skillsMcp.k10.dir', { name: row.name })}</li>
        <li><Icon n="fork" s={14} />{tr('skillsMcp.k10.lanes')}</li>
      </ul>
      <Err text={err} />
      <div className="mf"><button className="btn" onClick={onClose}>{tr('common.cancel')}</button>
        <button className="btn bad solid" disabled={busy} onClick={go}>{tr(`skillsMcp.k10.verb${k}`)}</button></div>
    </div>
  );
}
