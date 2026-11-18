// v2.2 §6 the Skills tab: summary, filter (K8-filter), groups Cần xem (K11, K11-ack) → Của bạn → Project → Plugin (K8-plugin,
// folded), rows with the "Lane" switch and "⋯" (K8-menu). Dialogs K9 / K10: SkillsMcpSkillsDialogs.tsx.
import { useState, type ReactElement, type ReactNode } from 'react';
import type { ProjectView, SkillIssueView, SkillRowView, SkillsMcpView } from '../../../shared/protocol.ts';
import { fmtTok } from '../lib/format.ts';
import { useT, type Tr } from '../lib/i18n.tsx';
import { issueFixes, pluginParts, skillGroups, skillSummary, type IssueFix, type PluginGroup } from '../lib/skills-mcp-skills.ts';
import { Icon, type IconName } from './icons.tsx';

export type SkAct =
  | { t: 'add' } | { t: 'remove'; row: SkillRowView } | { t: 'open'; path: string }
  | { t: 'toggle'; row: SkillRowView; on: boolean } | { t: 'plugin'; key: string; on: boolean }
  | { t: 'fix'; issue: SkillIssueView; fix: IssueFix | 'unack' };

/** Claude Code issue number: a project whose `.claude/skills` is the user folder loads every skill twice (engine skills/scan.ts). */
const DOUBLE_LOAD = 109687;
const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');
const ICON: Record<SkillIssueView['code'], { i: IconName; cls: string }> = {
  appLink: { i: 'swap', cls: 'bad' }, brokenLink: { i: 'eyeOff', cls: 'bad' }, missingSkillMd: { i: 'file', cls: 'warn' },
  nameMismatch: { i: 'pencil', cls: 'warn' }, badChars: { i: 'pencil', cls: 'warn' }, duplicate: { i: 'info', cls: 'na' }, nestedSkillsDir: { i: 'copy', cls: 'warn' },
};

/** K8-filter highlight: the matched part of a name in a <mark>. */
function Hl({ text, q }: { text: string; q: string | null }): ReactNode {
  const at = q ? text.toLowerCase().indexOf(q) : -1;
  if (!q || at < 0) return text;
  return <>{text.slice(0, at)}<mark>{text.slice(at, at + q.length)}</mark>{text.slice(at + q.length)}</>;
}

function Menu({ tr, r, act, onClose }: { tr: Tr; r: SkillRowView; act: (a: SkAct) => void; onClose: () => void }): ReactElement {
  const item = (label: string, a: SkAct, bad = false) => <button role="menuitem" className={bad ? 'bad' : ''} onClick={() => { onClose(); act(a); }}>{label}</button>;
  return (
    <div className="rmenu glass" role="menu">
      {item(tr('skillsMcp.sk.act.openDir'), { t: 'open', path: r.path })}
      {item(tr('skillsMcp.sk.act.openMd'), { t: 'open', path: `${r.path}/SKILL.md` })}
      {r.scope === 'user' ? item(tr(r.link ? 'skillsMcp.sk.act.unlink' : 'skillsMcp.sk.act.remove'), { t: 'remove', row: r }, true) : null}
    </div>
  );
}

function Row({ tr, r, q, act }: { tr: Tr; r: SkillRowView; q: string | null; act: (a: SkAct) => void }): ReactElement {
  const [menu, setMenu] = useState(false);
  return (
    <div className="skr">
      <b className="nm mono"><Hl text={r.name} q={q} /></b>
      <span className="ds" title={r.description}>{r.description}</span>
      <span className="wh mono" title={r.link ?? r.path}>{r.link ? <><Icon n="swap" s={12} />{tr('skillsMcp.sk.link', { to: tilde(r.link) })}</> : <><Icon n="folder" s={12} />{tr('skillsMcp.sk.folder')}</>}</span>
      <button className={`sw ${r.forLanes ? 'on' : ''}`} role="switch" aria-checked={r.forLanes} aria-label={tr('skillsMcp.sk.switchAria', { name: r.name })} onClick={() => act({ t: 'toggle', row: r, on: !r.forLanes })}><i /></button>
      <span className="mn"><button className="ib" aria-label={tr('skillsMcp.moreAria', { name: r.name })} aria-expanded={menu} onClick={() => setMenu(m => !m)}>⋯</button>
        {menu ? <Menu tr={tr} r={r} act={act} onClose={() => setMenu(false)} /> : null}</span>
      {r.shadowed ? <div className="why">{tr('skillsMcp.sk.shadowed')}</div> : null}
    </div>
  );
}

function Plugin({ tr, g, q, act }: { tr: Tr; g: PluginGroup; q: string | null; act: (a: SkAct) => void }): ReactElement {
  const [open, setOpen] = useState(false);
  const shown = open || !!q; // K8-filter: matched plugin skills show without unfolding
  const { plugin, market } = pluginParts(g.row.key);
  return (
    <div className={`skp ${shown ? 'open' : ''}`}>
      <div className="skr plug">
        <button className="nm mono fold" aria-expanded={shown} aria-label={tr('skillsMcp.sk.expandAria', { name: plugin })} onClick={() => setOpen(o => !o)}>
          <Icon n="chevR" s={12} />{plugin}</button>
        <span className="ds">{tr('skillsMcp.sk.pluginSkills', { n: g.row.skills })}</span>
        <span className="wh mono">{tr('skillsMcp.sk.pluginWhere', { market })}</span>
        <button className={`sw ${g.row.forLanes ? 'on' : ''}`} role="switch" aria-checked={g.row.forLanes} aria-label={tr('skillsMcp.sk.pluginAria', { name: plugin })} onClick={() => act({ t: 'plugin', key: g.row.key, on: !g.row.forLanes })}><i /></button>
        <span />
      </div>
      {shown ? g.skills.map(s => <div key={s.id} className="skr kid"><b className="nm mono"><Hl text={s.name} q={q} /></b>
        <span className="ds" title={s.description}>{s.description}</span><span className="wh">{tr('skillsMcp.sk.pluginOne')}</span><span /><span /></div>) : null}
    </div>
  );
}

/** §6 K11 the headline and explanation of one issue (explanations wrap, never cut). */
const APP_NAME: Record<string, string> = { 'cc-switch': 'CC Switch' };
function issueText(tr: Tr, i: SkillIssueView, c: IssueCtx): { title: string; why: string } {
  const link = c.rows.find(r => r.path === i.path)?.link ?? null;
  const p = { name: i.dir ?? '', to: tilde(link ?? i.path), app: APP_NAME[i.app ?? ''] ?? i.app ?? '', project: c.projects.find(x => x.id === i.project)?.name ?? i.project ?? '' };
  return { title: tr(`skillsMcp.sk.iss.${i.code}`, p), why: tr(`skillsMcp.sk.iss.${i.code}Why`, p) };
}

interface IssueCtx { tr: Tr; projects: readonly ProjectView[]; rows: readonly SkillRowView[]; act: (a: SkAct) => void }
function Issue({ c, i }: { c: IssueCtx; i: SkillIssueView }): ReactElement {
  const { tr, act } = c, t = issueText(tr, i, c), icon = ICON[i.code];
  const btn = (f: IssueFix | 'unack') => <button key={f} className={`btn ${f === 'copy' ? 'pri' : f === 'ack' || f === 'unack' ? 'ghost' : ''}`} onClick={() => act({ t: 'fix', issue: i, fix: f })}>
    {f === 'ack' ? <Icon n="check" s={14} /> : f === 'copy' ? <Icon n="copy" s={14} /> : f === 'open' ? <Icon n="folder" s={14} /> : null}{tr(`skillsMcp.sk.fix.${f}`)}</button>;
  return (
    <div className={`ski ${i.acked ? 'acked' : ''}`} data-code={i.code}>
      <span className={`st ${icon.cls}`}><Icon n={icon.i} s={16} /></span>
      <div className="im"><b>{t.title}</b><div className="why">{t.why}</div></div>
      <div className="ia">{i.acked ? (i.ackable ? btn('unack') : null) : issueFixes(i).map(btn)}</div>
    </div>
  );
}

export interface SkillsTabProps { view: SkillsMcpView | undefined; projects: readonly ProjectView[]; act: (a: SkAct) => void; connected: boolean }

export function SkillsTab({ view, projects, act, connected }: SkillsTabProps): ReactElement {
  const tr = useT();
  const [filter, setFilter] = useState('');
  const [ackOpen, setAckOpen] = useState(false);
  if (!view) return <div className="smlist" aria-busy="true">{[0, 1, 2, 3].map(i => <div key={i} className="skel" />)}</div>;
  const s = view.skills, g = skillGroups(s, filter), sum = skillSummary(s), q = g.q;
  const info = g.review.filter(i => i.level === 'info').length;
  const pname = (id: string) => projects.find(p => p.id === id)?.name ?? id;
  const head = (label: string, n: number, right?: ReactNode, warn = false) => <h4 className={warn ? 'warn' : ''}>{warn ? <Icon n="alert" s={14} /> : null}{label} <span>{n}</span>{right ? <em>{right}</em> : null}</h4>;
  const rows = (list: readonly SkillRowView[]) => list.map(r => <Row key={r.id} tr={tr} r={r} q={q} act={act} />);
  const ic: IssueCtx = { tr, projects, rows: s.rows, act };
  const noProject = projects.filter(p => !g.project.some(x => x.owner === p.id)).map(p => p.name);
  return (
    <div className="smlist skl">
      {!connected ? <div className="band bad" role="status"><Icon n="wifi" s={14} />{tr('skillsMcp.engineLost')}</div> : null}
      <div className="smsum">
        <span>{tr('skillsMcp.sk.sum', { all: sum.all, user: sum.user, plugin: sum.plugin, plugins: sum.plugins, tok: fmtTok(s.descTokens, tr) })}</span>
        <label className="skf"><Icon n="search" s={14} /><input type="search" value={filter} placeholder={tr('skillsMcp.sk.filter')} aria-label={tr('skillsMcp.sk.filterAria')} onChange={e => setFilter(e.target.value)} /></label>
        <button className="btn pri" onClick={() => act({ t: 'add' })}><Icon n="plus" s={14} /> {tr('skillsMcp.sk.add')}</button>
      </div>
      <div className="skr skh" aria-hidden="true"><span>{tr('skillsMcp.col.name')}</span><span>{tr('skillsMcp.sk.col.desc')}</span><span>{tr('skillsMcp.sk.col.where')}</span><span>{tr('skillsMcp.col.lane')}</span><span /></div>
      {q ? <section>{head(tr('skillsMcp.sk.match', { q: filter.trim() }), g.matches, tr('skillsMcp.sk.matchHint'))}</section> : null}
      {g.review.length || g.acked.length ? <section className="skrev">
        {head(tr('skillsMcp.group.review'), g.review.length - info, info ? tr('skillsMcp.sk.info', { n: info }) : undefined, true)}
        {g.review.map(i => <Issue key={i.id} c={ic} i={i} />)}
        {g.acked.length ? <>
          <button className="skack" aria-expanded={ackOpen} onClick={() => setAckOpen(o => !o)}><Icon n="chevR" s={12} />{tr('skillsMcp.sk.acked', { n: g.acked.length })}
            <span className="mono">{g.acked.map(i => i.dir ?? `#${DOUBLE_LOAD} ${pname(i.project ?? '')}`).join(' · ')}</span><em>{tr('skillsMcp.sk.ackedHint')}</em></button>
          {ackOpen ? g.acked.map(i => <Issue key={i.id} c={ic} i={i} />) : null}
        </> : null}
      </section> : null}
      <section>{head(tr('skillsMcp.sk.group.user'), g.user.length, '~/.claude/skills')}{rows(g.user)}
        {!g.user.length ? <div className="smempty">{tr(q ? 'skillsMcp.sk.noMatch' : 'skillsMcp.sk.noUser')}</div> : null}</section>
      <section>{head(tr('skillsMcp.sk.group.project'), g.project.reduce((n, x) => n + x.rows.length, 0))}
        {g.project.map(x => <div key={x.owner}><div className="skown mono">{pname(x.owner)}/.claude/skills</div>{rows(x.rows)}</div>)}
        {!q && noProject.length ? <div className="smempty">{tr('skillsMcp.sk.projectNone', { projects: noProject.join(', ') })}</div> : null}</section>
      <section>{head(tr('skillsMcp.sk.group.plugin'), g.plugins.reduce((n, x) => n + (q ? x.skills.length : x.row.skills), 0), q ? undefined : tr('skillsMcp.sk.pluginHint'))}
        {g.plugins.map(x => <Plugin key={x.row.key} tr={tr} g={x} q={q} act={act} />)}
        {q && !g.plugins.length ? <div className="smempty">{tr('skillsMcp.sk.noPluginMatch')}</div> : null}</section>
    </div>
  );
}
