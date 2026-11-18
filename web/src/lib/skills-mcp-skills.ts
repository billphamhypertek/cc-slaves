// v2.2 §6 Skills tab (K8, K8-filter, K8-plugin, K9, K10, K11) and Thư mục chung tab (K12) logic — lazy chunk only.
// Every number on screen still comes from the view (`counts`, C25); this file only groups, filters and checks.
import type { Key } from '../../../shared/i18n/core.ts';
import type { AccountView, AccountsInfo, PluginRowView, SkillDirCheck, SkillGitFetch, SkillIssueView, SkillRowView, SkillsMcpView } from '../../../shared/protocol.ts';

type Skills = SkillsMcpView['skills'];
export interface PluginGroup { row: PluginRowView; skills: SkillRowView[] }
export interface SkillGroups {
  /** K11 "Cần xem": issues not "Đã biết", lane-breaking first, info last. */
  review: SkillIssueView[];
  /** K11-ack the folded "Đã biết · n" group. */
  acked: SkillIssueView[];
  user: SkillRowView[];
  project: { owner: string; rows: SkillRowView[] }[];
  plugins: PluginGroup[];
  /** K8-filter: the text filtered on (lower case), null = no filter. */
  q: string | null;
  /** K8-filter "Khớp … n": rows matched (plugin skills included). */
  matches: number;
}

const RANK: Record<SkillIssueView['level'], number> = { error: 0, warn: 1, info: 2 };
const hit = (q: string) => (r: SkillRowView) => r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q);

/** §6 K8 groups: Cần xem → Của bạn → Project (per project) → Plugin (one folded row each). A filter (K8-filter) searches
 *  name + description of every skill, plugin skills included, and drops the review groups. */
export function skillGroups(s: Skills, filter: string): SkillGroups {
  const q = filter.trim().toLowerCase() || null;
  const open = s.issues.filter(i => !i.acked);
  // a row shown in Cần xem is not repeated below; a folder without SKILL.md is no skill for Claude Code even once "Đã biết"
  const flagged = new Set(s.issues.filter(i => (!i.acked && i.level !== 'info') || i.code === 'missingSkillMd').map(i => i.path));
  const keep = q ? hit(q) : (r: SkillRowView) => !flagged.has(r.path);
  const user = s.rows.filter(r => r.scope === 'user' && keep(r));
  const owners = [...new Set(s.rows.filter(r => r.scope === 'project').map(r => r.owner ?? ''))];
  const project = owners.map(owner => ({ owner, rows: s.rows.filter(r => r.scope === 'project' && r.owner === owner && keep(r)) })).filter(g => g.rows.length);
  const plugins = s.plugins.map(row => ({ row, skills: s.rows.filter(r => r.scope === 'plugin' && r.owner === row.key && (!q || hit(q)(r))) }))
    .filter(g => !q || g.skills.length);
  return {
    review: q ? [] : [...open].sort((a, b) => RANK[a.level] - RANK[b.level]), acked: q ? [] : s.issues.filter(i => i.acked),
    user, project, plugins, q,
    matches: user.length + project.reduce((n, g) => n + g.rows.length, 0) + plugins.reduce((n, g) => n + g.skills.length, 0),
  };
}

/** §6 K8 summary "223 skill · 20 của bạn · 203 từ 6 plugin". */
export function skillSummary(s: Skills): { all: number; user: number; plugin: number; plugins: number } {
  return { all: s.rows.length, user: s.rows.filter(r => r.scope === 'user').length, plugin: s.rows.filter(r => r.scope === 'plugin').length, plugins: s.plugins.length };
}

export type IssueFix = 'copy' | 'unlink' | 'relink' | 'trash' | 'open' | 'ack';
/** §5.5 / §6 K11 the buttons of one issue row; lane-breaking issues (link gãy, phụ thuộc CC Switch) never get "Đã biết". */
export function issueFixes(i: Pick<SkillIssueView, 'code' | 'ackable'>): IssueFix[] {
  const by: Record<SkillIssueView['code'], IssueFix[]> = {
    appLink: ['copy'], brokenLink: ['unlink', 'relink'], missingSkillMd: ['trash', 'open', 'ack'],
    nameMismatch: ['open', 'ack'], badChars: ['open', 'ack'], duplicate: ['ack'], nestedSkillsDir: ['ack'],
  };
  return by[i.code].filter(f => f !== 'ack' || i.ackable);
}

/** §5.5 K9 the first check (engine dry run) that stops the add; null = it can be added. */
export type DirErr = 'noSkillMd' | 'nameMismatch' | 'badChars' | 'exists';
export const dirErr = (c: SkillDirCheck): DirErr | null =>
  !c.skillMd ? 'noSkillMd' : c.name !== c.dir ? 'nameMismatch' : c.badChars ? 'badChars' : c.exists ? 'exists' : null;

/** §6 K9 Git: every candidate with its description and blocking error (`fm` = frontmatter name); the valid ones are
 *  the preselected set (§4.3 T6). */
export function gitPicks(candidates: SkillGitFetch['candidates']): { name: string; description: string; err: DirErr | null; fm: string }[] {
  return candidates.map(c => ({ name: c.name, description: c.check.description, err: dirErr(c.check), fm: c.check.name }));
}

/** §6 K9 Thư mục: one line per §5.5 check of the picked folder (✓ / ✗ + catalog key + params). */
export type CheckLine = { ok: boolean; key: Key; name?: string; to?: string };
export function folderLines(c: SkillDirCheck): CheckLine[] {
  const taken: CheckLine | null = !c.exists ? null
    : c.exists.same ? { ok: false, key: 'skillsMcp.k9.chk.takenSame', name: c.dir }
    : c.exists.link ? { ok: false, key: 'skillsMcp.k9.chk.takenLink', name: c.dir, to: c.exists.link }
    : { ok: false, key: 'skillsMcp.k9.chk.takenDir', name: c.dir };
  return [
    c.skillMd ? { ok: true, key: 'skillsMcp.k9.chk.md' } : { ok: false, key: 'skillsMcp.k9.chk.noMd' },
    c.badChars ? { ok: false, key: 'skillsMcp.k9.err.badChars', name: c.name } : { ok: true, key: 'skillsMcp.k9.nameOk', name: c.name },
    ...(taken ? [taken] : []),
  ];
}

/** "plugin@marketplace" → its two parts (K8-plugin "plugin · claude-code-skills"). */
export const pluginParts = (key: string): { plugin: string; market: string } => {
  const at = key.lastIndexOf('@');
  return at > 0 ? { plugin: key.slice(0, at), market: key.slice(at + 1) } : { plugin: key, market: '' };
};

// ---------------------------------------------------------------- K12 Thư mục chung
/** v2 §5.3 the files copied one way into every account (never linked). */
export const COPIED = ['settings.json', 'settings.local.json', 'CLAUDE.md'] as const;
const NOT_PRIVATE = new Set<string>([...COPIED, '.credentials.json']);
export interface SharedCols { shared: string[]; private: string[]; unknown: AccountsInfo['entries'] }
/** §6 K12 the four columns: Dùng chung (linked) · Chép · Riêng · Lạ (the switch of v2 §5.2). */
export function sharedCols(info: AccountsInfo): SharedCols {
  return {
    shared: info.entries.filter(e => e.cls === 'shared').map(e => e.name),
    private: info.entries.filter(e => (e.cls === 'private' || e.cls === 'never') && !NOT_PRIVATE.has(e.name)).map(e => e.name),
    unknown: info.entries.filter(e => e.cls === 'unknown'),
  };
}

export interface AccountLinkRow { email: string; total: number; ok: number; issues: AccountView['sharedCfg']['issues']; merge: string | null }
/** §6 K12 account × link state: "9 / 11 link"; `merge` = the first real folder where a link belongs (v2 A9 "Gộp vào ~/.claude"). */
export function accountLinks(accounts: readonly AccountView[], total: number): AccountLinkRow[] {
  return accounts.map(a => ({
    email: a.email, total, ok: Math.max(0, total - new Set(a.sharedCfg.issues.map(i => i.name)).size), issues: a.sharedCfg.issues,
    merge: a.sharedCfg.issues.find(i => i.kind === 'real-entry')?.name ?? null,
  })).sort((x, y) => Number(y.issues.length > 0) - Number(x.issues.length > 0));
}
