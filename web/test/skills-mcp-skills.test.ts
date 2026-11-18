// v2.2 §6 K8 / K9 / K11 / K12 pure logic (web/src/lib/skills-mcp-skills.ts).
import { describe, expect, test } from 'bun:test';
import type { AccountsInfo, SkillDirCheck, SkillIssueView, SkillRowView, SkillsMcpView } from '../../shared/protocol.ts';
import { accountLinks, dirErr, folderLines, gitPicks, issueFixes, pluginParts, sharedCols, skillGroups, skillSummary } from '../src/lib/skills-mcp-skills.ts';
import { account } from './fixtures.ts';

const sk = (name: string, over: Partial<SkillRowView> = {}): SkillRowView => ({
  id: `user:${name}`, scope: 'user', owner: null, dir: name, path: `/h/.claude/skills/${name}`, name, description: `about ${name}`, shadowed: false, link: null, forLanes: true, ...over,
});
const iss = (code: SkillIssueView['code'], dir: string, over: Partial<SkillIssueView> = {}): SkillIssueView => ({
  id: `${code}:/h/.claude/skills/${dir}`, code, level: 'warn', ackable: true, acked: false, path: `/h/.claude/skills/${dir}`, dir, project: null, ...over,
});
const SKILLS: SkillsMcpView['skills'] = {
  rows: [
    sk('h-ops', { link: '/w/h-ops-skill', description: 'Unified DevOps toolkit' }), sk('gpt-taste', { description: 'Elite UX motion' }),
    sk('find-skills', { link: '/h/.cc-switch/skills/find-skills' }), sk('synced', { description: '' }),
    sk('tauri-development', { id: 'project:p1:tauri-development', scope: 'project', owner: 'p1', path: '/r/hagenta/.claude/skills/tauri-development' }),
    sk('brand', { id: 'plugin:ui@m:brand', scope: 'plugin', owner: 'ui@m', description: 'Brand voice' }),
    sk('slides', { id: 'plugin:ui@m:slides', scope: 'plugin', owner: 'ui@m', description: 'taste of slides' }),
    sk('vercel-cli', { id: 'plugin:vercel@o:vercel-cli', scope: 'plugin', owner: 'vercel@o' }),
  ],
  issues: [
    iss('duplicate', 'tauri-development', { level: 'info', project: 'p1', path: '/r/hagenta/.claude/skills/tauri-development' }),
    iss('missingSkillMd', 'learned'), iss('missingSkillMd', 'synced', { acked: true }),
    iss('appLink', 'find-skills', { level: 'error', ackable: false, app: 'CC Switch' }),
  ],
  plugins: [{ key: 'ui@m', skills: 2, servers: 0, forLanes: true }, { key: 'vercel@o', skills: 1, servers: 1, forLanes: false }],
  descTokens: 9100,
};

describe('§6 K8 groups', () => {
  test('§6 K11 Cần xem = issues not "Đã biết", lane-breaking first, info last; K11-ack folds the acked ones', () => {
    const g = skillGroups(SKILLS, '');
    expect(g.review.map(i => i.dir)).toEqual(['find-skills', 'learned', 'tauri-development']);
    expect(g.acked.map(i => i.dir)).toEqual(['synced']);
  });
  test('§6 K8 Của bạn hides a row that sits in Cần xem (not an info one) and a folder without SKILL.md even "Đã biết"; Project per project; Plugin one row each', () => {
    const g = skillGroups(SKILLS, '');
    expect(g.user.map(r => r.name)).toEqual(['h-ops', 'gpt-taste']);
    expect(g.project).toEqual([{ owner: 'p1', rows: [SKILLS.rows[4]!] }]);
    expect(g.plugins.map(p => [p.row.key, p.skills.length])).toEqual([['ui@m', 2], ['vercel@o', 1]]);
    expect(g.q).toBeNull();
  });
  test('§6 K8-filter searches name + description of every skill (plugin skills too), no review groups', () => {
    const g = skillGroups(SKILLS, '  TASTE ');
    expect(g.q).toBe('taste');
    expect(g.review).toEqual([]); expect(g.acked).toEqual([]);
    expect(g.user.map(r => r.name)).toEqual(['gpt-taste']);
    expect(g.plugins.map(p => [p.row.key, p.skills.map(s => s.name)])).toEqual([['ui@m', ['slides']]]);
    expect(g.matches).toBe(2);
    expect(skillGroups(SKILLS, 'find').user.map(r => r.name)).toEqual(['find-skills']); // a flagged row is found by the filter
  });
  test('§6 K8 summary counts', () => {
    expect(skillSummary(SKILLS)).toEqual({ all: 8, user: 4, plugin: 3, plugins: 2 });
  });
});

describe('§5.5 / §6 K11 fixes', () => {
  test('§5.5 lane-breaking issues have no "Đã biết"; each code its own buttons', () => {
    expect(issueFixes({ code: 'appLink', ackable: false })).toEqual(['copy']);
    expect(issueFixes({ code: 'brokenLink', ackable: false })).toEqual(['unlink', 'relink']);
    expect(issueFixes({ code: 'brokenLink', ackable: true })).toEqual(['unlink', 'relink']);
    expect(issueFixes({ code: 'missingSkillMd', ackable: true })).toEqual(['trash', 'open', 'ack']);
    expect(issueFixes({ code: 'duplicate', ackable: true })).toEqual(['ack']);
    expect(issueFixes({ code: 'nestedSkillsDir', ackable: true })).toEqual(['ack']);
    expect(issueFixes({ code: 'nameMismatch', ackable: false })).toEqual(['open']);
  });
});

describe('§6 K9 checks before writing (engine dry run, §5.5)', () => {
  const chk = (over: Partial<SkillDirCheck> = {}): SkillDirCheck =>
    ({ dir: 'pdf', name: 'pdf', description: 'PDF: đọc, tách', skillMd: true, badChars: false, exists: null, ...over });
  test('§5.5 the first blocking check: no SKILL.md → name ≠ folder → bad chars → taken; none → null', () => {
    expect(dirErr(chk())).toBeNull();
    expect(dirErr(chk({ skillMd: false, exists: { link: null, same: false } }))).toBe('noSkillMd');
    expect(dirErr(chk({ name: 'template', dir: 'template-skill', badChars: true }))).toBe('nameMismatch');
    expect(dirErr(chk({ badChars: true }))).toBe('badChars');
    expect(dirErr(chk({ exists: { link: null, same: false } }))).toBe('exists');
  });
  test('§4.3 T6 K9-git every valid skill preselected, with its description; blocked ones carry the error', () => {
    expect(gitPicks([{ name: 'pdf', check: chk() }, { name: 'template-skill', check: chk({ dir: 'template-skill', name: 'template', description: 'x' }) }]))
      .toEqual([{ name: 'pdf', description: 'PDF: đọc, tách', err: null, fm: 'pdf' }, { name: 'template-skill', description: 'x', err: 'nameMismatch', fm: 'template' }]);
  });
  test('§6 K9-folder check lines: SKILL.md, name + chars, taken (link → this folder / elsewhere / a real folder)', () => {
    expect(folderLines(chk({ dir: 'h-ops', name: 'h-ops', exists: { link: '/w/h-ops-skill', same: true } }))).toEqual([
      { ok: true, key: 'skillsMcp.k9.chk.md' },
      { ok: true, key: 'skillsMcp.k9.nameOk', name: 'h-ops' },
      { ok: false, key: 'skillsMcp.k9.chk.takenSame', name: 'h-ops' },
    ]);
    expect(folderLines(chk({ skillMd: false, badChars: true, name: 'Bad', dir: 'Bad', exists: { link: '/x/y', same: false } }))).toEqual([
      { ok: false, key: 'skillsMcp.k9.chk.noMd' },
      { ok: false, key: 'skillsMcp.k9.err.badChars', name: 'Bad' },
      { ok: false, key: 'skillsMcp.k9.chk.takenLink', name: 'Bad', to: '/x/y' },
    ]);
    expect(folderLines(chk({ exists: { link: null, same: false } })).at(-1)).toEqual({ ok: false, key: 'skillsMcp.k9.chk.takenDir', name: 'pdf' });
  });
  test('K8-plugin key parts', () => {
    expect(pluginParts('ui-ux-pro-max@ui-ux-pro-max-skill')).toEqual({ plugin: 'ui-ux-pro-max', market: 'ui-ux-pro-max-skill' });
    expect(pluginParts('solo')).toEqual({ plugin: 'solo', market: '' });
  });
});

describe('§6 K12 Thư mục chung', () => {
  const info: AccountsInfo = {
    privateWindow: false,
    entries: [
      { name: '.claude.json', cls: 'never', shared: false }, { name: 'CLAUDE.md', cls: 'never', shared: false }, { name: 'hooks', cls: 'unknown', shared: true },
      { name: 'plans', cls: 'shared', shared: true }, { name: 'sessions', cls: 'never', shared: false }, { name: 'settings.json', cls: 'never', shared: false },
      { name: 'skills', cls: 'shared', shared: true }, { name: 'teams', cls: 'private', shared: false },
    ],
  };
  test('§6 K12 columns: shared, private (copied files out), unknown with their switch state', () => {
    const c = sharedCols(info);
    expect(c.shared).toEqual(['plans', 'skills']);
    expect(c.private).toEqual(['.claude.json', 'sessions', 'teams']);
    expect(c.unknown.map(e => [e.name, e.shared])).toEqual([['hooks', true]]);
  });
  test('§6 K12 account × links: bad first, "n / total", merge = first real folder (v2 A9)', () => {
    const bad = account('acc51@x', { sharedCfg: { ok: false, issues: [{ kind: 'missing-link', name: 'todos', path: '/a/todos' }, { kind: 'real-entry', name: 'plans', path: '/a/plans' }] } });
    const rows = accountLinks([account('ok@x'), bad], 11);
    expect(rows.map(r => [r.email, r.ok, r.total, r.merge])).toEqual([['acc51@x', 9, 11, 'plans'], ['ok@x', 11, 11, null]]);
  });
});
