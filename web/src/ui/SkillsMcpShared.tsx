// v2.2 §6 K12 Thư mục chung (moved from Settings › Account, spec §7): the v2 §5.2 entry lists — Dùng chung · Chép · Riêng ·
// Lạ with its "Dùng chung" switch — the §5.2 new-entry cards, and the account × link table with v2 A9 "Gộp vào ~/.claude".
import { useState, type ReactElement } from 'react';
import type { AccountsInfo, CardView, Command, Snapshot } from '../../../shared/protocol.ts';
import { parseA9Key } from '../lib/account-ui.ts';
import { shortEmail } from '../lib/format.ts';
import { actionLabel, cardTitle, errText, useT } from '../lib/i18n.tsx';
import { accountLinks, COPIED, sharedCols } from '../lib/skills-mcp-skills.ts';
import { Icon } from './icons.tsx';
import { Rich } from './Rich.tsx';

/** Rows shown before "Hiện n account khác" (mockup K12). */
const FIRST = 6;

export interface SharedTabProps {
  snap: Snapshot; info: AccountsInfo | null; connected: boolean;
  send: (c: Command) => Promise<unknown>; toast: (t: string) => void;
  /** v2 A9 merge dialog (dry run first); `cardId` = the open A9 card of that entry, if any. */
  onMerge: (email: string, name: string, cardId?: number) => void;
}

export function SharedTab({ snap, info, connected, send, toast, onMerge }: SharedTabProps): ReactElement {
  const tr = useT();
  const [more, setMore] = useState(false);
  const run = (c: Command) => void send(c).catch((e: unknown) => toast(errText(tr, e)));
  const open = snap.cards.filter(c => c.status === 'open');
  const fresh = open.filter(c => c.kind === 'shared_cfg_new');
  const a9 = (email: string, name: string): CardView | undefined => open.find(c => c.kind === 'shared_cfg' && parseA9Key(c.key)?.email === email && parseA9Key(c.key)?.name === name);
  if (!info) return <div className="smlist" aria-busy="true"><div className="foot">{tr('skillsMcp.sh.reading')}</div>{[0, 1, 2].map(i => <div key={i} className="skel" />)}</div>;
  const cols = sharedCols(info);
  const links = accountLinks(snap.accounts, cols.shared.length);
  const shown = more ? links : links.filter((r, i) => r.issues.length || i < FIRST);
  const hidden = links.length - shown.length;
  const col = (icon: 'swap' | 'copy' | 'lock' | 'info', k: 'shared' | 'copied' | 'private' | 'unknown', n: number, body: ReactElement) =>
    <div className="shc"><h4><Icon n={icon} s={14} />{tr(`skillsMcp.sh.${k}`)} <span>{n}</span></h4><div className="foot">{tr(`skillsMcp.sh.${k}Sub`)}</div>{body}</div>;
  const note = (name: string) => (name === 'projects' ? ` ${tr('skillsMcp.sh.projectsNote')}` : name === '.claude.json' ? ` ${tr('skillsMcp.sh.login')}` : name === 'CLAUDE.md' ? ' (@import)' : '');
  return (
    <div className="smlist shl">
      {!connected ? <div className="band bad" role="status"><Icon n="wifi" s={14} />{tr('skillsMcp.engineLost')}</div> : null}
      <div className="smsum"><span>{tr('skillsMcp.sh.lead')}</span></div>
      {fresh.map(c => <div key={c.id} className="band"><Icon n="info" s={14} /><span><Rich text={cardTitle(tr, c)} /></span>
        {(c.actions ?? []).map((a, i) => <button key={a.id} className={`btn${i === 0 ? ' pri' : ''}`} onClick={() => run({ cmd: 'card_action', id: c.id, action: a.id })}>{actionLabel(tr, a)}</button>)}</div>)}
      <div className="shcols">
        {col('swap', 'shared', cols.shared.length, <ul className="mono">{cols.shared.map(n => <li key={n}>{n}<span className="foot">{note(n)}</span></li>)}</ul>)}
        {col('copy', 'copied', COPIED.length, <ul className="mono">{COPIED.map(n => <li key={n}>{n}<span className="foot">{note(n)}</span></li>)}</ul>)}
        {col('lock', 'private', cols.private.length, <ul className="mono">{cols.private.map(n => <li key={n}>{n}<span className="foot">{note(n)}</span></li>)}</ul>)}
        {col('info', 'unknown', cols.unknown.length, <ul className="mono">{cols.unknown.map(e => <li key={e.name}>{e.name}
          <button className={`sw ${e.shared ? 'on' : ''}`} role="switch" aria-checked={e.shared} aria-label={tr('skillsMcp.sh.shareAria', { name: e.name })}
            onClick={() => run({ cmd: 'shared_cfg_toggle', name: e.name, shared: !e.shared })}><i /></button></li>)}</ul>)}
      </div>
      <section>
        <h4>{tr('skillsMcp.sh.links')} <span>{links.length}</span><em>{tr('skillsMcp.sh.linksHint')}</em></h4>
        {links.length ? <table className="t sht"><thead><tr><th>{tr('skillsMcp.sh.col.account')}</th><th>{tr('skillsMcp.sh.col.links')}</th><th>{tr('skillsMcp.sh.col.note')}</th><th /></tr></thead>
          <tbody>{shown.map(r => {
            const real = r.issues.filter(i => i.kind === 'real-entry').map(i => i.name), other = r.issues.filter(i => i.kind !== 'real-entry').map(i => i.name || i.path);
            const card = r.merge ? a9(r.email, r.merge) : undefined;
            return <tr key={r.email} data-email={r.email} className={r.issues.length ? 'bad' : ''}>
              <td className="mono" title={r.email}>{shortEmail(r.email)}</td>
              <td className={r.issues.length ? 'warn' : 'ok'}><Icon n={r.issues.length ? 'alert' : 'check'} s={14} />{tr('skillsMcp.sh.okN', { ok: r.ok, total: r.total })}</td>
              <td className="wr">{[real.length ? tr('skillsMcp.sh.realEntry', { names: real.join(', ') }) : '', other.length ? tr('skillsMcp.sh.notLinked', { names: other.join(', ') }) : ''].filter(Boolean).join(' · ')}</td>
              <td>{r.merge ? <button className="btn pri" onClick={() => onMerge(r.email, r.merge!, card?.id)}><Icon n="dl" s={14} /> {tr('skillsMcp.sh.merge')}</button> : null}</td>
            </tr>;
          })}</tbody></table> : <div className="smempty">{tr('skillsMcp.sh.none')}</div>}
        {hidden > 0 ? <button className="skack" onClick={() => setMore(true)}><Icon n="chevR" s={12} />{tr('skillsMcp.sh.more', { n: hidden, total: cols.shared.length })}</button> : null}
      </section>
    </div>
  );
}
