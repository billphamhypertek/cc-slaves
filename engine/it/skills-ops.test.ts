import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCatalog } from '../src/skills/catalog.ts';
import { scanSkills, type SkillRoots } from '../src/skills/scan.ts';
import {
  addFromFolder, checkSkillDir, cloneSkillRepo, copyOverAppLink, disposeClone, installFromClone, relinkSkill, removeSkill, unlinkBroken, type SkillOpError,
} from '../src/skills/ops.ts';
import { watchSkillDirs } from '../src/skills/watch.ts';
import { execIn } from '../src/setup/setup.ts';

let root: string;
let r: SkillRoots;
const skillsDir = () => join(r.claudeHome, 'skills');
const mkSkill = (dir: string, name = dir.split('/').pop()!, extra: Record<string, string> = {}) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: does ${name}\n---\nbody\n`);
  for (const [f, c] of Object.entries(extra)) writeFileSync(join(dir, f), c);
  return dir;
};
const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as SkillOpError).code; } return 'no-throw'; };
const codeAsync = async (f: () => Promise<unknown>) => { try { await f(); } catch (e) { return (e as SkillOpError).code; } return 'no-throw'; };
const trash = () => (existsSync(join(r.home, '.Trash')) ? readdirSync(join(r.home, '.Trash')) : []);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'skills-it-')));
  r = { home: join(root, 'home'), claudeHome: join(root, 'home', '.claude') };
  mkdirSync(skillsDir(), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('§5.5 scan → catalog', () => {
  test('§5.5 user + project + plugin skills; broken link; ~/.cc-switch link; #109687 on the project ~', () => {
    mkSkill(join(skillsDir(), 'real-one'));
    symlinkSync(mkSkill(join(r.home, '.cc-switch', 'skills', 'find-skills')), join(skillsDir(), 'find-skills'));
    symlinkSync(join(root, 'gone'), join(skillsDir(), 'dead'));
    const proj = join(root, 'proj');
    mkSkill(join(proj, '.claude', 'skills', 'real-one'));
    const plugin = join(root, 'plug');
    mkSkill(join(plugin, 'skills', 'deploy'));
    const s = scanSkills(r, { projects: [{ id: 'p', name: 'proj', path: proj }, { id: 'h', name: '~', path: r.home }], plugins: [{ id: 'vercel@m', installPath: plugin }] });
    const c = buildCatalog(s, {});
    expect(c.skills.map((k) => `${k.scope}:${k.name}`).sort()).toEqual(['plugin:deploy', 'project:real-one', 'user:dead', 'user:find-skills', 'user:real-one']);
    expect(c.issues.map((i) => `${i.code}:${i.dir ?? i.project}`).sort()).toEqual(['appLink:find-skills', 'brokenLink:dead', 'duplicate:real-one', 'nestedSkillsDir:h']);
  });
  test('§5.5 missing skills folders are fine (no project / plugin skills dir)', () => {
    const s = scanSkills(r, { projects: [{ id: 'p', name: 'p', path: join(root, 'nope') }], plugins: [{ id: 'x@m', installPath: join(root, 'nope2') }] });
    expect(s.entries).toEqual([]);
  });
});

describe('§5.5 add from folder', () => {
  test('§5.5 default "Liên kết" = absolute symlink to the realpath', () => {
    const src = mkSkill(join(root, 'src', 'alpha'));
    const dest = addFromFolder(r, src, 'link');
    expect(readlinkSync(dest)).toBe(src);
    expect(dest).toBe(join(skillsDir(), 'alpha'));
  });
  test('§5.5 "Chép" copies a real folder', () => {
    const src = mkSkill(join(root, 'src', 'beta'), 'beta', { 'x.txt': 'X' });
    const dest = addFromFolder(r, src, 'copy');
    expect(lstatSync(dest).isDirectory()).toBe(true);
    expect(readFileSync(join(dest, 'x.txt'), 'utf8')).toBe('X');
    expect(existsSync(`${dest}.tmp`)).toBe(false);
  });
  test('§5.5 same name → stop, nothing overwritten (also over a broken link)', () => {
    symlinkSync(join(root, 'gone'), join(skillsDir(), 'alpha'));
    expect(code(() => addFromFolder(r, mkSkill(join(root, 'src', 'alpha')), 'copy'))).toBe('exists');
    expect(readlinkSync(join(skillsDir(), 'alpha'))).toBe(join(root, 'gone'));
  });
  test('§5.5 a folder without SKILL.md is refused', () => {
    mkdirSync(join(root, 'empty'));
    expect(code(() => addFromFolder(r, join(root, 'empty'), 'link'))).toBe('noSkillMd');
  });
});

describe('§5.5 K9 dry-run checks of a skill folder', () => {
  test('§5.5 K9-folder: dest name = frontmatter name; SKILL.md, chars, taken (link → this very folder) all reported', () => {
    const src = mkSkill(join(root, 'src', 'h-ops-skill'), 'h-ops');
    symlinkSync(src, join(skillsDir(), 'h-ops'));
    expect(checkSkillDir(r, src)).toEqual({ dir: 'h-ops', name: 'h-ops', description: 'does h-ops', skillMd: true, badChars: false, exists: { link: src, same: true } });
    const other = mkSkill(join(root, 'other', 'h-ops'));
    expect(checkSkillDir(r, other).exists).toEqual({ link: src, same: false });
    mkSkill(join(skillsDir(), 'real'));
    expect(checkSkillDir(r, mkSkill(join(root, 'o2', 'real'))).exists).toEqual({ link: null, same: false });
  });
  test('§5.5 K9-folder: no SKILL.md → named by the folder, skillMd false; bad chars flagged; nothing written', () => {
    mkdirSync(join(root, 'bare', 'Bad Name'), { recursive: true });
    expect(checkSkillDir(r, join(root, 'bare', 'Bad Name'))).toEqual({ dir: 'Bad Name', name: 'Bad Name', description: '', skillMd: false, badChars: true, exists: null });
    expect(readdirSync(skillsDir())).toEqual([]);
    expect(code(() => checkSkillDir(r, join(root, 'nope')))).toBe('noFolder');
  });
  test('§5.5 add from folder uses the frontmatter name and refuses bad chars', () => {
    expect(addFromFolder(r, mkSkill(join(root, 'src', 'h-ops-skill'), 'h-ops'), 'link')).toBe(join(skillsDir(), 'h-ops'));
    expect(code(() => addFromFolder(r, mkSkill(join(root, 'src', 'x'), 'Bad Name'), 'link'))).toBe('badName');
    expect(readdirSync(skillsDir())).toEqual(['h-ops']);
  });
});

describe('§5.5 add from git (file:// repo, no network)', () => {
  const repo = (layout: (dir: string) => void) => {
    const dir = join(root, 'repo');
    mkdirSync(dir);
    layout(dir);
    for (const a of [['init', '-q'], ['add', '.'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x']]) {
      expect(Bun.spawnSync(['git', '-C', dir, ...a]).exitCode).toBe(0);
    }
    return `file://${dir}`;
  };
  test('§5.5 skills/*/SKILL.md → candidates → picked ones moved to ~/.claude/skills/<name>, temp removed', async () => {
    const url = repo((d) => { mkSkill(join(d, 'skills', 'one')); mkSkill(join(d, 'skills', 'two')); mkdirSync(join(d, 'skills', 'notes')); writeFileSync(join(d, 'skills', 'notes', 'a'), ''); });
    const clone = await cloneSkillRepo(url, execIn(process.env));
    expect(clone.candidates.map((c) => c.name).sort()).toEqual(['one', 'two']);
    expect(installFromClone(r, clone, ['two'])).toEqual([join(skillsDir(), 'two')]);
    expect(readFileSync(join(skillsDir(), 'two', 'SKILL.md'), 'utf8')).toContain('does two');
    expect(existsSync(join(skillsDir(), 'one'))).toBe(false);
    disposeClone(clone);
    expect(existsSync(clone.dir)).toBe(false);
  });
  test('§5.5 K9-git: each candidate carries its check (description, name ≠ folder, chars, taken); a blocked pick is refused', async () => {
    const url = repo((d) => { mkSkill(join(d, 'skills', 'pdf')); mkSkill(join(d, 'skills', 'template-skill'), 'template'); mkSkill(join(d, 'skills', 'mine')); });
    mkSkill(join(skillsDir(), 'mine'));
    const clone = await cloneSkillRepo(url, execIn(process.env));
    const by = Object.fromEntries(clone.candidates.map((c) => [c.name, checkSkillDir(r, c.path, c.name)]));
    expect(by.pdf).toEqual({ dir: 'pdf', name: 'pdf', description: 'does pdf', skillMd: true, badChars: false, exists: null });
    expect(by['template-skill']).toMatchObject({ dir: 'template-skill', name: 'template' });
    expect(by.mine!.exists).toEqual({ link: null, same: false });
    expect(code(() => installFromClone(r, clone, ['pdf', 'template-skill']))).toBe('badName');
    expect(existsSync(join(skillsDir(), 'pdf'))).toBe(false);
    disposeClone(clone);
  });
  test('§5.5 SKILL.md at the repo root → one candidate named by its frontmatter', async () => {
    const clone = await cloneSkillRepo(repo((d) => mkSkill(d, 'rooty')), execIn(process.env));
    expect(clone.candidates.map((c) => c.name)).toEqual(['rooty']);
    installFromClone(r, clone, ['rooty']);
    expect(existsSync(join(skillsDir(), 'rooty', 'SKILL.md'))).toBe(true);
    disposeClone(clone);
  });
  test('§5.5 git: a picked name that exists → stop before writing any', async () => {
    const clone = await cloneSkillRepo(repo((d) => { mkSkill(join(d, 'skills', 'one')); mkSkill(join(d, 'skills', 'two')); }), execIn(process.env));
    mkSkill(join(skillsDir(), 'two'), 'two', { 'mine.txt': 'keep' });
    expect(code(() => installFromClone(r, clone, ['one', 'two']))).toBe('exists');
    expect(existsSync(join(skillsDir(), 'one'))).toBe(false);
    expect(readFileSync(join(skillsDir(), 'two', 'mine.txt'), 'utf8')).toBe('keep');
    disposeClone(clone);
  });
  test('§5.5 git: no SKILL.md in the repo / clone fails / option-looking URL → typed errors, temp cleaned', async () => {
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('cc-slaves-skill-')).length;
    expect(await codeAsync(() => cloneSkillRepo(repo((d) => writeFileSync(join(d, 'README'), 'x')), execIn(process.env)))).toBe('noSkillsInRepo');
    expect(await codeAsync(() => cloneSkillRepo(`file://${join(root, 'missing')}`, execIn(process.env)))).toBe('gitFailed');
    expect(await codeAsync(() => cloneSkillRepo('--upload-pack=touch /tmp/x', execIn(process.env)))).toBe('badUrl');
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('cc-slaves-skill-')).length).toBe(before);
  });
});

describe('§5.5 remove', () => {
  test('§5.5 A4 link → unlink, target kept', () => {
    const tgt = mkSkill(join(root, 'tgt', 'l'));
    symlinkSync(tgt, join(skillsDir(), 'l'));
    expect(removeSkill(r, { scope: 'user', path: join(skillsDir(), 'l') })).toEqual({ trashed: null });
    expect(existsSync(join(skillsDir(), 'l'))).toBe(false);
    expect(existsSync(join(tgt, 'SKILL.md'))).toBe(true);
  });
  test('§5.5 A5 real dir → ~/.Trash/<name> <time>; a second one with the same name does not clobber', () => {
    mkSkill(join(skillsDir(), 'd'));
    const at = new Date(2026, 10, 16, 9, 5, 7);
    const a = removeSkill(r, { scope: 'user', path: join(skillsDir(), 'd') }, () => at);
    expect(a.trashed).toBe(join(r.home, '.Trash', 'd 09.05.07'));
    mkSkill(join(skillsDir(), 'd'));
    removeSkill(r, { scope: 'user', path: join(skillsDir(), 'd') }, () => at);
    expect(trash().sort()).toEqual(['d 09.05.07', 'd 09.05.07 2']);
    expect(existsSync(join(r.home, '.Trash', 'd 09.05.07', 'SKILL.md'))).toBe(true);
  });
  test('§5.5 plugin / project skills are refused; a path outside ~/.claude/skills is refused', () => {
    const p = mkSkill(join(root, 'proj', '.claude', 'skills', 'x'));
    expect(code(() => removeSkill(r, { scope: 'project', path: p }))).toBe('refused');
    expect(code(() => removeSkill(r, { scope: 'plugin', path: p }))).toBe('refused');
    expect(code(() => removeSkill(r, { scope: 'user', path: p }))).toBe('notInSkills');
    expect(code(() => removeSkill(r, { scope: 'user', path: join(skillsDir(), '..', 'settings.json') }))).toBe('notInSkills');
    expect(existsSync(join(p, 'SKILL.md'))).toBe(true);
  });
});

describe('§5.5 fixes', () => {
  test('§5.5 CC Switch dep → copy into ~/.claude/skills/<name> atomically, CC Switch folder kept', () => {
    const cc = mkSkill(join(r.home, '.cc-switch', 'skills', 'find-skills'), 'find-skills', { 'ref.md': 'R' });
    symlinkSync(cc, join(skillsDir(), 'find-skills'));
    copyOverAppLink(r, 'find-skills');
    const dest = join(skillsDir(), 'find-skills');
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dest, 'ref.md'), 'utf8')).toBe('R');
    expect(readFileSync(join(cc, 'ref.md'), 'utf8')).toBe('R');
    expect(readdirSync(skillsDir())).toEqual(['find-skills']);
    expect(buildCatalog(scanSkills(r, { projects: [], plugins: [] }), {}).issues).toEqual([]);
  });
  test('§5.5 copy-over refuses an entry that is not an app link (real dir, other link)', () => {
    mkSkill(join(skillsDir(), 'real'));
    symlinkSync(mkSkill(join(root, 'elsewhere', 'o')), join(skillsDir(), 'o'));
    expect(code(() => copyOverAppLink(r, 'real'))).toBe('notAppLink');
    expect(code(() => copyOverAppLink(r, 'o'))).toBe('notAppLink');
  });
  test('§5.5 copy-over: a failed copy leaves the link untouched and no .tmp behind', () => {
    const cc = mkSkill(join(r.home, '.cc-switch', 'skills', 'f'));
    symlinkSync(cc, join(skillsDir(), 'f'));
    symlinkSync(join(root, 'nowhere'), join(cc, 'dangling'));
    mkdirSync(join(cc, 'locked'));
    writeFileSync(join(cc, 'locked', 'secret'), 's');
    Bun.spawnSync(['chmod', '000', join(cc, 'locked')]);
    try {
      expect(code(() => copyOverAppLink(r, 'f'))).not.toBe('no-throw');
    } finally { Bun.spawnSync(['chmod', '755', join(cc, 'locked')]); }
    expect(readlinkSync(join(skillsDir(), 'f'))).toBe(cc);
    expect(readdirSync(skillsDir())).toEqual(['f']);
  });
  test('§5.5 broken link: "Gỡ link" unlinks; refuses a link that resolves', () => {
    symlinkSync(join(root, 'gone'), join(skillsDir(), 'x'));
    symlinkSync(mkSkill(join(root, 'ok', 'y')), join(skillsDir(), 'y'));
    expect(code(() => unlinkBroken(r, 'y'))).toBe('notBroken');
    unlinkBroken(r, 'x');
    expect(readdirSync(skillsDir())).toEqual(['y']);
  });
  test('§5.5 broken link: "Trỏ lại…" swaps the link to the new folder; new folder must hold SKILL.md', () => {
    symlinkSync(join(root, 'gone'), join(skillsDir(), 'x'));
    mkdirSync(join(root, 'bare'));
    expect(code(() => relinkSkill(r, 'x', join(root, 'bare')))).toBe('noSkillMd');
    const t = mkSkill(join(root, 'new', 'x'));
    relinkSkill(r, 'x', t);
    expect(readlinkSync(join(skillsDir(), 'x'))).toBe(t);
    expect(readdirSync(skillsDir())).toEqual(['x']);
  });
});

describe('§5.5 temp names can never be a skill', () => {
  const fooTmp = () => readFileSync(join(skillsDir(), 'foo.tmp', 'SKILL.md'), 'utf8');
  test('§5.5 a real foo.tmp skill survives "Chép" of foo, copy-over of foo and "Trỏ lại…" of foo; no temp left', () => {
    mkSkill(join(skillsDir(), 'foo.tmp'), 'foo.tmp');
    const before = fooTmp();
    addFromFolder(r, mkSkill(join(root, 'src', 'foo')), 'copy');
    expect(fooTmp()).toBe(before);
    rmSync(join(skillsDir(), 'foo'), { recursive: true });
    symlinkSync(mkSkill(join(r.home, '.cc-switch', 'skills', 'foo')), join(skillsDir(), 'foo'));
    copyOverAppLink(r, 'foo');
    expect(fooTmp()).toBe(before);
    rmSync(join(skillsDir(), 'foo'), { recursive: true });
    symlinkSync(join(root, 'gone'), join(skillsDir(), 'foo'));
    relinkSkill(r, 'foo', mkSkill(join(root, 'new', 'foo')));
    expect(fooTmp()).toBe(before);
    expect(readdirSync(skillsDir()).sort()).toEqual(['foo', 'foo.tmp']);
    expect(trash()).toEqual([]);
  });
});

describe('§5.5 fs watch → rescan hook', () => {
  const waitFor = async (ok: () => boolean) => { const end = Date.now() + 3000; while (!ok() && Date.now() < end) await Bun.sleep(20); };
  test('§5.5 a burst of changes fires the hook once (debounced); stop ends it', async () => {
    let n = 0;
    const { stop } = watchSkillDirs([skillsDir()], () => { n++; }, { debounceMs: 80, pollMs: 30 });
    mkSkill(join(skillsDir(), 'a'));
    mkSkill(join(skillsDir(), 'b'));
    await waitFor(() => n > 0);
    await Bun.sleep(200);
    expect(n).toBe(1);
    stop();
    mkSkill(join(skillsDir(), 'c'));
    await Bun.sleep(200);
    expect(n).toBe(1);
  });
  test('§5.5 a folder that appears later (new project skills dir) and a SKILL.md edit are both seen', async () => {
    let n = 0;
    const later = join(root, 'proj', '.claude', 'skills');
    const { stop } = watchSkillDirs([skillsDir(), later], () => { n++; }, { debounceMs: 40, pollMs: 30 });
    try {
      mkSkill(join(later, 'p'));
      await waitFor(() => n === 1);
      expect(n).toBe(1);
      await Bun.sleep(30);
      writeFileSync(join(later, 'p', 'SKILL.md'), '---\nname: p\ndescription: edited\n---\n');
      await waitFor(() => n === 2);
      expect(n).toBe(2);
    } finally { stop(); }
  });
  test('hf1117-perf `set` keeps the watchers of folders still listed (no re-arm), watches a new one, drops a removed one', async () => {
    let n = 0;
    const other = join(root, 'proj2', '.claude', 'skills');
    mkdirSync(other, { recursive: true });
    mkdirSync(skillsDir(), { recursive: true });
    const made: string[] = [], closed: string[] = [];
    const w = watchSkillDirs([skillsDir()], () => { n++; }, { debounceMs: 40, pollMs: 30, watch: (d, f) => { made.push(d); const x = watch(d, { recursive: true }, f); return { close: () => { closed.push(d); x.close(); } }; } });
    try {
      w.set([skillsDir(), other]);
      expect(made).toEqual([skillsDir(), other]);
      expect(closed).toEqual([]);
      mkSkill(join(other, 'q'));
      await waitFor(() => n === 1);
      expect(n).toBe(1);
      w.set([other]);
      expect(closed).toEqual([skillsDir()]);
      expect(made).toHaveLength(2);
      mkSkill(join(skillsDir(), 'gone'));
      await Bun.sleep(200);
      expect(n).toBe(1); // the dropped folder is neither watched nor polled
    } finally { w.stop(); }
  });
});
