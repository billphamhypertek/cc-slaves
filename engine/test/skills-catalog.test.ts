import { describe, expect, test } from 'bun:test';
import { DEFAULT_CONFIG } from '../src/config.ts';
import {
  ackIssue, ackedOf, buildCatalog, estimateDescTokens, parseSkillMd, unackIssue, withAcked,
  type ScanEntry, type SkillScan,
} from '../src/skills/catalog.ts';

const HOME = '/h';
const md = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n# Body\n`;
const entry = (o: Partial<ScanEntry> & Pick<ScanEntry, 'dir'>): ScanEntry => ({
  scope: 'user', owner: null, path: `${HOME}/.claude/skills/${o.dir}`, link: null,
  real: `${HOME}/.claude/skills/${o.dir}`, skillMd: md(o.dir, `does ${o.dir}`), ...o,
});
const scan = (entries: ScanEntry[], o: Partial<SkillScan> = {}): SkillScan => ({
  home: HOME, userSkillsReal: `${HOME}/.claude/skills`, projects: [], entries, ...o,
});
const codes = (s: SkillScan, acked: Record<string, string> = {}) => buildCatalog(s, acked).issues.map((i) => i.code).sort();

describe('§5.5 frontmatter', () => {
  test('§5.5 name + description from frontmatter (quoted, folded block)', () => {
    expect(parseSkillMd('---\nname: "a-b"\ndescription: \'hi there\'\n---\nx', 'dir')).toEqual({ name: 'a-b', description: 'hi there' });
    expect(parseSkillMd('---\nname: x\ndescription: >\n  line one\n  line two\nother: 1\n---\n', 'dir'))
      .toEqual({ name: 'x', description: 'line one line two' });
  });
  test('§5.5 fallbacks: no name → dir name, no description → first body line', () => {
    expect(parseSkillMd('---\nfoo: 1\n---\n\n# Do the thing\nmore', 'my-dir')).toEqual({ name: 'my-dir', description: 'Do the thing' });
    expect(parseSkillMd('plain first line\nsecond', 'd')).toEqual({ name: 'd', description: 'plain first line' });
    expect(parseSkillMd('', 'd')).toEqual({ name: 'd', description: '' });
  });
});

describe('§5.5 token estimate', () => {
  test('§5.5 Σ min(len(desc), 1536) / 4, rounded up', () => {
    expect(estimateDescTokens([{ description: 'x'.repeat(10) }, { description: 'y'.repeat(5000) }])).toBe(Math.ceil((10 + 1536) / 4));
    expect(estimateDescTokens([])).toBe(0);
  });
  test('§5.5 catalog estimate counts loaded skills only (shadowed project duplicate and missing SKILL.md excluded)', () => {
    const c = buildCatalog(scan([
      entry({ dir: 'a', skillMd: md('a', 'x'.repeat(40)) }),
      entry({ dir: 'nomd', skillMd: null }),
      entry({ dir: 'a', scope: 'project', owner: 'p1', path: '/w/p/.claude/skills/a', real: '/w/p/.claude/skills/a', skillMd: md('a', 'y'.repeat(400)) }),
    ], { projects: [{ id: 'p1', name: 'p', real: '/w/p' }] }), {});
    expect(c.descTokens).toBe(10);
  });
});

describe('§5.5 / K11 checks', () => {
  test('K11 broken link → brokenLink (error, not ackable)', () => {
    const c = buildCatalog(scan([entry({ dir: 'x', link: { target: '/gone/x', broken: true }, real: null, skillMd: null })]), {});
    expect(c.issues.map((i) => [i.code, i.level, i.ackable])).toEqual([['brokenLink', 'error', false]]);
  });
  test('K11 link into ~/.cc-switch → appLink (error, not ackable)', () => {
    const c = buildCatalog(scan([entry({ dir: 'find-skills', link: { target: `${HOME}/.cc-switch/skills/find-skills`, broken: false }, real: `${HOME}/.cc-switch/skills/find-skills` })]), {});
    expect(c.issues.map((i) => [i.code, i.level, i.ackable, i.app])).toEqual([['appLink', 'error', false, 'cc-switch']]);
  });
  test('K11 a sibling folder named like the prefix (~/.cc-switch-x) is not an app link', () => {
    expect(codes(scan([entry({ dir: 'a', link: { target: `${HOME}/.cc-switch-x/a`, broken: false }, real: `${HOME}/.cc-switch-x/a` })]))).toEqual([]);
  });
  test('K11 missing SKILL.md → missingSkillMd (warn, ackable)', () => {
    const c = buildCatalog(scan([entry({ dir: 'x', skillMd: null })]), {});
    expect(c.issues.map((i) => [i.code, i.level, i.ackable])).toEqual([['missingSkillMd', 'warn', true]]);
  });
  test('K11 frontmatter name ≠ dir → nameMismatch; chars outside [a-z0-9-_] → badChars', () => {
    expect(codes(scan([entry({ dir: 'x', skillMd: md('y', 'd') })]))).toEqual(['nameMismatch']);
    expect(codes(scan([entry({ dir: 'My Skill', skillMd: md('My Skill', 'd') })]))).toEqual(['badChars']);
    expect(codes(scan([entry({ dir: 'ok_name-1', skillMd: md('ok_name-1', 'd') })]))).toEqual([]);
  });
  test('K11 user vs project duplicate → duplicate (info) on the project row, user wins', () => {
    const c = buildCatalog(scan([
      entry({ dir: 'a' }),
      entry({ dir: 'a', scope: 'project', owner: 'p1', path: '/w/p/.claude/skills/a', real: '/w/p/.claude/skills/a' }),
    ], { projects: [{ id: 'p1', name: 'hagenta', real: '/w/p' }] }), {});
    expect(c.issues.map((i) => [i.code, i.level, i.path, i.project])).toEqual([['duplicate', 'info', '/w/p/.claude/skills/a', 'p1']]);
    expect(c.skills.find((s) => s.scope === 'project')!.shadowed).toBe(true);
    expect(c.skills.find((s) => s.scope === 'user')!.shadowed).toBe(false);
  });
  test('K11 #109687: realpath(~/.claude/skills) inside a project → nestedSkillsDir on that project only', () => {
    const s = scan([], { userSkillsReal: '/h/.claude/skills', projects: [{ id: 'home', name: '~', real: '/h' }, { id: 'w', name: 'w', real: '/h/.claude/skills-other' }] });
    const c = buildCatalog(s, {});
    expect(c.issues.map((i) => [i.code, i.project, i.level])).toEqual([['nestedSkillsDir', 'home', 'warn']]);
  });
  test('§5.5 plugin skills are listed but never checked (namespaced, not fixable)', () => {
    const c = buildCatalog(scan([entry({ dir: 'Bad Name', scope: 'plugin', owner: 'vercel@m', path: '/p/skills/Bad Name', real: '/p/skills/Bad Name', skillMd: md('other', 'd') })]), {});
    expect(c.issues).toEqual([]);
    expect(c.skills.map((s) => [s.scope, s.owner, s.name])).toEqual([['plugin', 'vercel@m', 'other']]);
  });
});

describe('§5.5 C23 "Đã biết"', () => {
  const dupScan = (userReal: string, projectId = 'p1') => scan([
    entry({ dir: 'a', real: userReal }),
    entry({ dir: 'a', scope: 'project', owner: projectId, path: `/w/${projectId}/.claude/skills/a`, real: `/w/${projectId}/.claude/skills/a` }),
  ], { projects: [{ id: projectId, name: projectId, real: `/w/${projectId}` }] });

  test('C23 an acked issue is marked acked while its fingerprint holds', () => {
    const issue = buildCatalog(dupScan('/x/a'), {}).issues[0]!;
    const acked = ackIssue({}, issue);
    expect(buildCatalog(dupScan('/x/a'), acked).issues[0]!.acked).toBe(true);
  });
  test('C23 target realpath changes → fingerprint changes → back to "Cần xem"', () => {
    const acked = ackIssue({}, buildCatalog(dupScan('/x/a'), {}).issues[0]!);
    expect(buildCatalog(dupScan('/y/a'), acked).issues[0]!.acked).toBe(false);
  });
  test('C23 another project → a different issue, not acked', () => {
    const acked = ackIssue({}, buildCatalog(dupScan('/x/a', 'p1'), {}).issues[0]!);
    expect(buildCatalog(dupScan('/x/a', 'p2'), acked).issues[0]!.acked).toBe(false);
  });
  test('C23 missing SKILL.md fingerprint follows the entry realpath', () => {
    const s = (real: string) => scan([entry({ dir: 'x', skillMd: null, real, link: { target: real, broken: false } })]);
    const acked = ackIssue({}, buildCatalog(s('/t/one'), {}).issues[0]!);
    expect(buildCatalog(s('/t/one'), acked).issues[0]!.acked).toBe(true);
    expect(buildCatalog(s('/t/two'), acked).issues[0]!.acked).toBe(false);
  });
  test('C23 #109687 ack keyed per project', () => {
    const s = scan([], { projects: [{ id: 'home', name: '~', real: '/h' }] });
    const acked = ackIssue({}, buildCatalog(s, {}).issues[0]!);
    expect(buildCatalog(s, acked).issues[0]!.acked).toBe(true);
  });
  test('C23 lane-breaking issues (broken link, CC Switch dep) cannot be acked', () => {
    const c = buildCatalog(scan([
      entry({ dir: 'x', link: { target: '/gone', broken: true }, real: null, skillMd: null }),
      entry({ dir: 'y', link: { target: `${HOME}/.cc-switch/skills/y`, broken: false }, real: `${HOME}/.cc-switch/skills/y` }),
    ]), {});
    for (const i of c.issues) expect(() => ackIssue({}, i)).toThrow(/not ackable/);
  });
  test('C23 a hand-edited skills.acked entry for a lane-breaking issue is ignored', () => {
    const s = scan([entry({ dir: 'x', link: { target: '/gone', broken: true }, real: null, skillMd: null })]);
    const i = buildCatalog(s, {}).issues[0]!;
    expect(buildCatalog(s, { [i.id]: i.fingerprint }).issues[0]!.acked).toBe(false);
  });
  test('C23 unack removes the entry; ack does not mutate its input', () => {
    const issue = buildCatalog(dupScan('/x/a'), {}).issues[0]!;
    const before = {};
    const acked = ackIssue(before, issue);
    expect(before).toEqual({});
    expect(unackIssue(acked, issue.id)).toEqual({});
  });
  test('C23 skills.acked lives in config.json (accessor over Config)', () => {
    expect(ackedOf(DEFAULT_CONFIG)).toEqual({});
    const next = withAcked(DEFAULT_CONFIG, { k: 'f' });
    expect(ackedOf(next)).toEqual({ k: 'f' });
    expect(ackedOf(DEFAULT_CONFIG)).toEqual({});
  });
});
