// v2.2 §5.5 skills catalog: pure functions over a scan result (`skills/scan.ts` reads the disk). Lists user, project and
// enabled-plugin skills, runs the K11 checks and keeps the C23 "Đã biết" state (`config.json` `skills.acked`).
import type { Config } from '../config.ts';

export type SkillScope = 'user' | 'project' | 'plugin';

export interface ScanEntry {
  scope: SkillScope;
  /** Project id (project scope) or `<plugin>@<marketplace>` (plugin scope); null for user skills. */
  owner: string | null;
  /** Entry name inside its `skills` folder. */
  dir: string;
  /** Absolute path of the entry itself (the link, when it is one). */
  path: string;
  /** Raw `readlink` target (absolutised) when the entry is a symlink. */
  link: { target: string; broken: boolean } | null;
  /** realpath of the entry; null when it cannot be resolved (broken link). */
  real: string | null;
  /** Content of `SKILL.md`, null when missing. */
  skillMd: string | null;
}

interface ScanProject { id: string; name: string; /** realpath of the project root */ real: string }

export interface SkillScan {
  /** The user's home (app-dir prefixes resolve against it). */
  home: string;
  /** realpath of `~/.claude/skills`, null when it does not exist. */
  userSkillsReal: string | null;
  projects: ScanProject[];
  entries: ScanEntry[];
}

interface Skill {
  scope: SkillScope;
  owner: string | null;
  dir: string;
  path: string;
  name: string;
  description: string;
  /** A project skill hidden by a user skill of the same name (user wins). */
  shadowed: boolean;
}

type IssueCode = 'brokenLink' | 'appLink' | 'missingSkillMd' | 'nameMismatch' | 'badChars' | 'duplicate' | 'nestedSkillsDir';
/** error = breaks a lane (no "Đã biết"); info = shown but never counted (C25). */
type IssueLevel = 'error' | 'warn' | 'info';

export interface SkillIssue {
  /** Stable key of this issue instance: the `skills.acked` key. */
  id: string;
  code: IssueCode;
  level: IssueLevel;
  ackable: boolean;
  /** C23: type + path + target realpath. */
  fingerprint: string;
  acked: boolean;
  /** The entry (or, for #109687, the project root) the issue sits on. */
  path: string;
  /** The skill's dir name; null for #109687. */
  dir: string | null;
  /** Project the issue concerns (project duplicate, #109687). */
  project: string | null;
  /** appLink: which app owns the target. */
  app?: string;
}

export interface SkillCatalog { skills: Skill[]; issues: SkillIssue[]; descTokens: number }

/** §5.5 folders of other apps a skill must not depend on (`~/<prefix>/…`). */
const APP_DIR_PREFIXES: readonly { app: string; dir: string }[] = [{ app: 'cc-switch', dir: '.cc-switch' }];

/** §5.5 Claude Code caps one skill description in the listing at this many characters. */
const DESC_CAP = 1536;
const LANE_BREAKING: ReadonlySet<IssueCode> = new Set(['brokenLink', 'appLink']);
const LEVEL: Record<IssueCode, IssueLevel> = {
  brokenLink: 'error', appLink: 'error', missingSkillMd: 'warn', nameMismatch: 'warn', badChars: 'warn', duplicate: 'info', nestedSkillsDir: 'warn',
};

const unquote = (v: string) => (/^(["']).*\1$/.test(v) ? v.slice(1, -1) : v);

/** §5.5 frontmatter `name` / `description`; fallbacks: dir name / first non-empty body line (heading marks dropped). */
export function parseSkillMd(text: string, dir: string): { name: string; description: string } {
  const lines = text.split(/\r?\n/);
  const fields: Record<string, string> = {};
  let body = lines;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    const head = end > 0 ? lines.slice(1, end) : [];
    body = end > 0 ? lines.slice(end + 1) : [];
    for (let i = 0; i < head.length; i++) {
      const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(head[i]!);
      if (!m) continue;
      let v = m[2]!.trim();
      if (/^[>|][+-]?$/.test(v)) {
        const block: string[] = [];
        while (i + 1 < head.length && (/^\s/.test(head[i + 1]!) || head[i + 1] === '')) block.push(head[++i]!.trim());
        v = block.filter(Boolean).join(v.startsWith('|') ? '\n' : ' ');
      }
      fields[m[1]!] = unquote(v);
    }
  }
  const first = body.map((l) => l.trim()).find(Boolean) ?? '';
  return { name: fields.name || dir, description: fields.description || first.replace(/^#+\s*/, '') };
}

/** §5.5 a skill name Claude Code takes as is: `[a-z0-9-_]`. */
export const SKILL_NAME_RE = /^[a-z0-9_-]+$/;

/** §5.5 "token mô tả mỗi lane" ≈ Σ min(len(description), 1536) / 4. */
export function estimateDescTokens(skills: readonly { description: string }[]): number {
  return Math.ceil(skills.reduce((n, s) => n + Math.min(s.description.length, DESC_CAP), 0) / 4);
}

const under = (p: string, root: string) => p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`);

/** §5.5 the app (APP_DIR_PREFIXES) whose folder holds `target`, else null. */
export const appDirOf = (home: string, target: string): string | null =>
  APP_DIR_PREFIXES.find((a) => under(target, `${home}/${a.dir}`))?.app ?? null;

function appOf(home: string, e: ScanEntry): string | null {
  const target = e.real ?? e.link?.target;
  return e.link && target ? appDirOf(home, target) : null;
}

type Draft = Omit<SkillIssue, 'id' | 'level' | 'ackable' | 'fingerprint' | 'acked'> & { target: string };

function finish(d: Draft, acked: Readonly<Record<string, string>>): SkillIssue {
  const { target, ...rest } = d;
  const id = `${d.code}:${d.path}`;
  const fingerprint = `${d.code}|${d.path}|${target}`;
  const ackable = !LANE_BREAKING.has(d.code);
  return { ...rest, id, level: LEVEL[d.code], ackable, fingerprint, acked: ackable && acked[id] === fingerprint };
}

function entryIssues(home: string, e: ScanEntry, name: string): Draft[] {
  const base = { path: e.path, dir: e.dir, project: e.scope === 'project' ? e.owner : null };
  if (e.link?.broken || e.real === null) return [{ ...base, code: 'brokenLink', target: e.link?.target ?? '' }];
  const out: Draft[] = [];
  const app = appOf(home, e);
  if (app) out.push({ ...base, code: 'appLink', app, target: e.real });
  if (e.skillMd === null) out.push({ ...base, code: 'missingSkillMd', target: e.real });
  else if (name !== e.dir) out.push({ ...base, code: 'nameMismatch', target: `${e.real}#${name}` });
  if (!SKILL_NAME_RE.test(name)) out.push({ ...base, code: 'badChars', target: e.real });
  return out;
}

/** §5.5 the catalog + K11 issues; `acked` is `config.json` `skills.acked`. */
export function buildCatalog(scan: SkillScan, acked: Readonly<Record<string, string>>): SkillCatalog {
  const drafts: Draft[] = [];
  const userByName = new Map<string, ScanEntry>();
  const named = scan.entries.map((e) => {
    const meta = e.skillMd === null ? { name: e.dir, description: '' } : parseSkillMd(e.skillMd, e.dir);
    if (e.scope === 'user' && e.skillMd !== null) userByName.set(meta.name, e);
    return { e, ...meta };
  });
  const skills: Skill[] = [];
  const loaded: Skill[] = [];
  for (const { e, name, description } of named) {
    if (e.scope !== 'plugin') drafts.push(...entryIssues(scan.home, e, name));
    const loads = e.skillMd !== null && e.real !== null;
    if (e.scope === 'plugin' && !loads) continue;
    const winner = e.scope === 'project' ? userByName.get(name) : undefined;
    if (winner && loads) drafts.push({ code: 'duplicate', path: e.path, dir: e.dir, project: e.owner, target: winner.real ?? winner.path });
    const skill: Skill = { scope: e.scope, owner: e.owner, dir: e.dir, path: e.path, name, description, shadowed: winner !== undefined };
    skills.push(skill);
    if (loads && !winner) loaded.push(skill);
  }
  if (scan.userSkillsReal) {
    for (const p of scan.projects) {
      if (under(scan.userSkillsReal, p.real)) drafts.push({ code: 'nestedSkillsDir', path: p.real, dir: null, project: p.id, target: scan.userSkillsReal });
    }
  }
  return { skills, issues: drafts.map((d) => finish(d, acked)), descTokens: estimateDescTokens(loaded) };
}

/** C23 "Đã biết": returns a new map; refuses lane-breaking issues. */
export function ackIssue(acked: Readonly<Record<string, string>>, issue: SkillIssue): Record<string, string> {
  if (!issue.ackable) throw new Error(`skill issue not ackable: ${issue.code}`);
  return { ...acked, [issue.id]: issue.fingerprint };
}

/** C23 "Bỏ đã biết". */
export function unackIssue(acked: Readonly<Record<string, string>>, id: string): Record<string, string> {
  const { [id]: _drop, ...rest } = acked;
  return rest;
}

/** `config.json` `skills.acked` (the caller saves with `saveConfig`, like every other config write). */
export const ackedOf = (c: Readonly<Config>): Readonly<Record<string, string>> => c.skills.acked;
export const withAcked = (c: Readonly<Config>, acked: Record<string, string>): Config => ({ ...c, skills: { ...c.skills, acked } });
