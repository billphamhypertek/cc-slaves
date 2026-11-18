import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SHARED_ENTRIES, applyLayout, checkLayout, classifyEntry, healLayout, nodeLayoutFs, planLayout, safeDeleteAccountDir,
  entryList, unknownEntries, type Step,
} from '../../src/accounts/layout.ts';

const SPEC_SHARED = [
  'projects', 'todos', 'plans', 'file-history', 'skills', 'agents', 'commands', 'rules', 'output-styles', 'plugins',
  'workflows',
];

let tmp: string;
let claudeHome: string;
let root: string;
let acct: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-layout-'));
  claudeHome = join(tmp, 'home', '.claude');
  root = join(tmp, 'home', '.cc-slaves-accounts');
  acct = join(root, 'a1b2c3d4e5f6');
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(root, { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const mode = (p: string) => statSync(p).mode & 0o777;
const links = (steps: Step[]) => steps.filter((s) => s.op === 'symlink');
const setup = () => applyLayout(planLayout(claudeHome, acct));

describe('classification (§5.2)', () => {
  test('§5.2 the shared list is exactly the 11 named entries', () => {
    expect(([...SHARED_ENTRIES] as string[]).sort()).toEqual([...SPEC_SHARED].sort());
    for (const n of SPEC_SHARED) expect(classifyEntry(n)).toBe('shared');
  });

  test('§5.2 never-shared entries, including patterns', () => {
    for (const n of [
      '.claude.json', '.credentials.json', 'CLAUDE.md', 'settings.json', 'settings.local.json', 'sessions', 'session-env',
      'shell-snapshots', 'cache', 'statsig', 'backups', 'paste-cache', 'ide', 'daemon', 'daemon.log',
      'daemon-auth-status.json', 'mcp-needs-auth-cache.json', 'stats-cache.json', '.last-cleanup',
      '.last-update-result.json', 'settings.json.bak', 'CLAUDE.md.bak-20260906-062330', '.DS_Store',
    ]) expect(classifyEntry(n)).toBe('never');
  });

  test('§5.2 Claude Code private runtime state is not shared', () => {
    for (const n of ['teams', 'jobs', 'session-data', 'chrome', 'metrics', 'state', 'history.jsonl']) {
      expect(classifyEntry(n)).toBe('private');
    }
  });

  test('§5.2 unknown entries default to not shared and are listed', () => {
    expect(classifyEntry('hooks')).toBe('unknown');
    expect(unknownEntries(['hooks', 'projects', 'tools', 'sessions', 'teams', 'docs', '.DS_Store'])).toEqual([
      'docs', 'hooks', 'tools',
    ]);
  });
});

describe('planLayout (§5.1, §5.2)', () => {
  test('§5.2 the plan links exactly the shared list, one level, absolute targets in ~/.claude', () => {
    const steps = links(planLayout(claudeHome, acct));
    expect(steps.map((s) => s.path).sort()).toEqual(SPEC_SHARED.map((n) => join(acct, n)).sort());
    for (const s of steps) {
      if (s.op !== 'symlink') continue;
      expect(s.target.startsWith('/')).toBe(true);
      expect(s.target).toBe(join(claudeHome, s.path.slice(acct.length + 1)));
    }
  });

  test('§5.2 the plan never touches never-shared or private entries', () => {
    const touched = planLayout(claudeHome, acct).map((s) => s.path);
    for (const n of ['settings.json', '.claude.json', 'CLAUDE.md', 'sessions', 'history.jsonl', 'hooks']) {
      expect(touched).not.toContain(join(acct, n));
      expect(touched).not.toContain(join(claudeHome, n));
    }
  });

  test('§5.2 relative paths are refused (links must be absolute)', () => {
    expect(() => planLayout('rel/.claude', acct)).toThrow();
    expect(() => planLayout(claudeHome, 'rel/acct')).toThrow();
  });

  test('§5.2 extraShared adds only unknown entries', () => {
    expect(links(planLayout(claudeHome, acct, { extraShared: ['hooks'] })).map((s) => s.path)).toContain(join(acct, 'hooks'));
    expect(() => planLayout(claudeHome, acct, { extraShared: ['settings.json'] })).toThrow();
    expect(() => planLayout(claudeHome, acct, { extraShared: ['sessions'] })).toThrow();
    expect(() => planLayout(claudeHome, acct, { extraShared: ['../x'] })).toThrow();
  });
});

describe('applyLayout (§5.1, §5.2)', () => {
  test('§5.1 account dir is 0700 and every shared entry is a one-level absolute link', () => {
    const r = setup();
    expect(r.conflicts).toEqual([]);
    expect(mode(acct)).toBe(0o700);
    for (const n of SPEC_SHARED) {
      const p = join(acct, n);
      expect(lstatSync(p).isSymbolicLink()).toBe(true);
      expect(readlinkSync(p)).toBe(join(claudeHome, n));
      expect(lstatSync(join(claudeHome, n)).isDirectory()).toBe(true);
    }
  });

  test('§5.2 missing shared targets (plans, todos) are created in ~/.claude (M9)', () => {
    mkdirSync(join(claudeHome, 'projects'));
    writeFileSync(join(claudeHome, 'projects', 'keep'), 'x');
    setup();
    expect(statSync(join(claudeHome, 'plans')).isDirectory()).toBe(true);
    expect(statSync(join(claudeHome, 'todos')).isDirectory()).toBe(true);
    expect(readFileSync(join(claudeHome, 'projects', 'keep'), 'utf8')).toBe('x');
  });

  test('§5.2 absent ~/.claude is created 0700', () => {
    rmSync(claudeHome, { recursive: true });
    setup();
    expect(mode(claudeHome)).toBe(0o700);
  });

  test('§5.2 an existing ~/.claude keeps its mode', () => {
    chmodSync(claudeHome, 0o755);
    setup();
    expect(mode(claudeHome)).toBe(0o755);
  });

  test('§5.5 re-apply is idempotent', () => {
    setup();
    const r = setup();
    expect(r.created).toEqual([]);
    expect(r.conflicts).toEqual([]);
    expect(checkLayout(claudeHome, acct)).toEqual([]);
  });

  test('§5.5 apply never overwrites a real dir where a link belongs', () => {
    mkdirSync(join(acct, 'projects'), { recursive: true });
    writeFileSync(join(acct, 'projects', 'mine.jsonl'), 'data');
    const r = setup();
    expect(r.conflicts.map((c) => c.kind)).toEqual(['real-entry']);
    expect(readFileSync(join(acct, 'projects', 'mine.jsonl'), 'utf8')).toBe('data');
  });

  test('§3.2 SA5 a file written through the account link is the same inode as in ~/.claude', () => {
    setup();
    mkdirSync(join(acct, 'projects', '-Users-x-repo'));
    writeFileSync(join(acct, 'projects', '-Users-x-repo', 'sid.jsonl'), '{"a":1}\n');
    const viaAcct = statSync(join(acct, 'projects', '-Users-x-repo', 'sid.jsonl'));
    const inHome = statSync(join(claudeHome, 'projects', '-Users-x-repo', 'sid.jsonl'));
    expect(viaAcct.ino).toBe(inHome.ino);
    expect(viaAcct.dev).toBe(inHome.dev);
  });
});

describe('checkLayout / healLayout (§5.5)', () => {
  test('§5.5 missing link → reported and created', () => {
    setup();
    rmSync(join(acct, 'skills'));
    expect(checkLayout(claudeHome, acct).map((i) => [i.kind, i.name])).toEqual([['missing-link', 'skills']]);
    const r = healLayout(claudeHome, acct);
    expect(r.remaining).toEqual([]);
    expect(readlinkSync(join(acct, 'skills'))).toBe(join(claudeHome, 'skills'));
  });

  test('§5.5 missing target in ~/.claude → reported and created', () => {
    setup();
    rmSync(join(claudeHome, 'todos'), { recursive: true });
    expect(checkLayout(claudeHome, acct).map((i) => i.kind)).toEqual(['missing-target']);
    healLayout(claudeHome, acct);
    expect(statSync(join(claudeHome, 'todos')).isDirectory()).toBe(true);
  });

  test('§5.5 wrong target → fixed, old target untouched', () => {
    setup();
    const other = join(tmp, 'other');
    mkdirSync(other);
    writeFileSync(join(other, 'canary'), 'c');
    rmSync(join(acct, 'agents'));
    symlinkSync(other, join(acct, 'agents'));
    expect(checkLayout(claudeHome, acct)).toEqual([
      { kind: 'wrong-target', name: 'agents', path: join(acct, 'agents'), actual: other },
    ]);
    healLayout(claudeHome, acct);
    expect(readlinkSync(join(acct, 'agents'))).toBe(join(claudeHome, 'agents'));
    expect(readFileSync(join(other, 'canary'), 'utf8')).toBe('c');
  });

  test('§5.5 multi-level link → replaced by a one-level link', () => {
    setup();
    const hop = join(tmp, 'hop');
    symlinkSync(join(claudeHome, 'rules'), hop);
    rmSync(join(acct, 'rules'));
    symlinkSync(hop, join(acct, 'rules'));
    expect(checkLayout(claudeHome, acct).map((i) => i.kind)).toEqual(['wrong-target']);
    healLayout(claudeHome, acct);
    expect(readlinkSync(join(acct, 'rules'))).toBe(join(claudeHome, 'rules'));
  });

  test('§5.5 relative link with the right destination is replaced by an absolute one', () => {
    setup();
    rmSync(join(acct, 'plans'));
    symlinkSync('../../.claude/plans', join(acct, 'plans'));
    expect(checkLayout(claudeHome, acct).map((i) => i.kind)).toEqual(['wrong-target']);
    healLayout(claudeHome, acct);
    expect(readlinkSync(join(acct, 'plans'))).toBe(join(claudeHome, 'plans'));
  });

  test('§5.5 real dir where a link belongs → reported, never deleted or merged', () => {
    setup();
    rmSync(join(acct, 'projects'));
    mkdirSync(join(acct, 'projects', 'slug'), { recursive: true });
    writeFileSync(join(acct, 'projects', 'slug', 's.jsonl'), 'hist');
    const r = healLayout(claudeHome, acct);
    expect(r.remaining.map((i) => [i.kind, i.name])).toEqual([['real-entry', 'projects']]);
    expect(lstatSync(join(acct, 'projects')).isDirectory()).toBe(true);
    expect(readFileSync(join(acct, 'projects', 'slug', 's.jsonl'), 'utf8')).toBe('hist');
  });

  test('§5.5 real file where a link belongs → reported, kept', () => {
    setup();
    rmSync(join(acct, 'workflows'));
    writeFileSync(join(acct, 'workflows'), 'user');
    const r = healLayout(claudeHome, acct);
    expect(r.remaining.map((i) => i.kind)).toEqual(['real-entry']);
    expect(readFileSync(join(acct, 'workflows'), 'utf8')).toBe('user');
  });

  test('§5.5 heal on a missing account dir creates the full layout', () => {
    const r = healLayout(claudeHome, acct);
    expect(r.remaining).toEqual([]);
    expect(checkLayout(claudeHome, acct)).toEqual([]);
  });

  // IMPORTANT-3 (G1 review): the account dir itself is a link (here into ~/.claude, whose `projects` is the user's own
  // link to another disk) or a file → one `real-entry` issue for the dir, and nothing is linked, unlinked or mkdir'd.
  const accountDirIsLink = () => {
    const ext = join(tmp, 'ext-projects');
    mkdirSync(ext);
    writeFileSync(join(ext, 'hist.jsonl'), 'x');
    symlinkSync(ext, join(claudeHome, 'projects'));
    symlinkSync(claudeHome, acct);
    return ext;
  };
  const untouched = (ext: string) => {
    expect(readlinkSync(join(claudeHome, 'projects'))).toBe(ext);
    expect(readFileSync(join(claudeHome, 'projects', 'hist.jsonl'), 'utf8')).toBe('x');
    expect(readdirSync(claudeHome)).toEqual(['projects']);
  };

  test('IMPORTANT-3 §5.5 heal: account dir is a link → one real-entry issue, ~/.claude untouched', () => {
    const ext = accountDirIsLink();
    const r = healLayout(claudeHome, acct);
    expect(r).toEqual({ fixed: [], remaining: [{ kind: 'real-entry', name: 'a1b2c3d4e5f6', path: acct }] });
    untouched(ext);
    expect(readlinkSync(acct)).toBe(claudeHome);
  });

  test('IMPORTANT-3 §5.1 apply: account dir is a link → one real-entry conflict, ~/.claude untouched', () => {
    const ext = accountDirIsLink();
    expect(setup()).toEqual({ created: [], conflicts: [{ kind: 'real-entry', name: 'a1b2c3d4e5f6', path: acct }] });
    untouched(ext);
  });

  test('IMPORTANT-3 §5.5 heal/apply: account dir is a file → one real-entry issue, file kept', () => {
    writeFileSync(acct, 'user');
    const issue = { kind: 'real-entry' as const, name: 'a1b2c3d4e5f6', path: acct };
    expect(healLayout(claudeHome, acct)).toEqual({ fixed: [], remaining: [issue] });
    expect(setup()).toEqual({ created: [], conflicts: [issue] });
    expect(readFileSync(acct, 'utf8')).toBe('user');
    expect(readdirSync(claudeHome)).toEqual([]);
  });
});

describe('safeDeleteAccountDir (§7 safe delete)', () => {
  test('§7 safe delete unlinks links and never follows them (canary in ~/.claude survives)', () => {
    setup();
    writeFileSync(join(claudeHome, 'projects', 'canary'), 'keep');
    mkdirSync(join(claudeHome, 'skills', 'deep'), { recursive: true });
    writeFileSync(join(claudeHome, 'skills', 'deep', 'canary'), 'keep');
    mkdirSync(join(acct, 'sessions', 'x'), { recursive: true });
    writeFileSync(join(acct, 'sessions', 'x', 'f'), 'gone');
    // A link nested inside a private dir must not be followed either.
    symlinkSync(join(claudeHome, 'skills'), join(acct, 'sessions', 'x', 'nested-link'));
    safeDeleteAccountDir(acct, root);
    expect(existsSync(acct)).toBe(false);
    expect(readFileSync(join(claudeHome, 'projects', 'canary'), 'utf8')).toBe('keep');
    expect(readFileSync(join(claudeHome, 'skills', 'deep', 'canary'), 'utf8')).toBe('keep');
    for (const n of SPEC_SHARED) expect(existsSync(join(claudeHome, n))).toBe(true);
  });

  test('§7 root check refuses ~/.claude, /, the root itself, a path with .., and non-id names', () => {
    setup();
    writeFileSync(join(claudeHome, 'projects', 'canary'), 'keep');
    for (const bad of [
      claudeHome, '/', root, `${root}/../.claude`, `${root}/a1b2c3d4e5f6/..`, join(root, 'not-an-id'),
      join(acct, 'projects'), 'relative/a1b2c3d4e5f6', `${acct}/`, join(tmp, 'elsewhere', 'a1b2c3d4e5f6'),
    ]) {
      expect(() => safeDeleteAccountDir(bad, root)).toThrow();
    }
    expect(readFileSync(join(claudeHome, 'projects', 'canary'), 'utf8')).toBe('keep');
    expect(existsSync(acct)).toBe(true);
  });

  test('§7 an id-named dir outside the root is refused and kept', () => {
    const outside = join(tmp, 'elsewhere', 'a1b2c3d4e5f6');
    mkdirSync(outside, { recursive: true });
    expect(() => safeDeleteAccountDir(outside, root)).toThrow();
    expect(existsSync(outside)).toBe(true);
  });

  test('§7 refuses when the account dir itself is a link', () => {
    const real = join(tmp, 'real');
    mkdirSync(real);
    writeFileSync(join(real, 'canary'), 'keep');
    symlinkSync(real, join(root, 'ffffffffffff'));
    expect(() => safeDeleteAccountDir(join(root, 'ffffffffffff'), root)).toThrow();
    expect(readFileSync(join(real, 'canary'), 'utf8')).toBe('keep');
  });

  test('§7 refuses when the accounts root is a link (e.g. pointing into ~/.claude)', () => {
    const linkRoot = join(tmp, 'link-root');
    symlinkSync(claudeHome, linkRoot);
    mkdirSync(join(claudeHome, 'a1b2c3d4e5f6'));
    writeFileSync(join(claudeHome, 'a1b2c3d4e5f6', 'canary'), 'keep');
    expect(() => safeDeleteAccountDir(join(linkRoot, 'a1b2c3d4e5f6'), linkRoot)).toThrow();
    expect(readFileSync(join(claudeHome, 'a1b2c3d4e5f6', 'canary'), 'utf8')).toBe('keep');
  });

  test('MINOR-2 §7 refuses a root equal to or inside ~/.claude, or equal to $HOME (case C5)', () => {
    const userHome = join(tmp, 'home');
    const guard = { claudeHome, userHome };
    for (const r of [claudeHome, join(claudeHome, 'sub'), userHome]) {
      mkdirSync(join(r, 'abcdefabcdef'), { recursive: true });
      writeFileSync(join(r, 'abcdefabcdef', 'canary'), 'keep');
      expect(() => safeDeleteAccountDir(join(r, 'abcdefabcdef'), r, nodeLayoutFs, guard)).toThrow(/is ~\/.claude, inside it, or \$HOME/);
      expect(readFileSync(join(r, 'abcdefabcdef', 'canary'), 'utf8')).toBe('keep');
    }
    // the normal root (a sibling of ~/.claude inside $HOME) still works
    setup();
    safeDeleteAccountDir(acct, root, nodeLayoutFs, guard);
    expect(existsSync(acct)).toBe(false);
  });

  test('MINOR-2 §7 the guard defaults to paths() (CLAUDE_HOME)', () => {
    const saved = process.env.CLAUDE_HOME;
    process.env.CLAUDE_HOME = claudeHome;
    try {
      mkdirSync(join(claudeHome, 'abcdefabcdef'));
      expect(() => safeDeleteAccountDir(join(claudeHome, 'abcdefabcdef'), claudeHome)).toThrow(/is ~\/.claude, inside it, or \$HOME/);
      expect(existsSync(join(claudeHome, 'abcdefabcdef'))).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_HOME; else process.env.CLAUDE_HOME = saved;
    }
  });

  test('§7 refuses a root of / or a relative root', () => {
    expect(() => safeDeleteAccountDir('/a1b2c3d4e5f6', '/')).toThrow();
    expect(() => safeDeleteAccountDir('x/a1b2c3d4e5f6', 'x')).toThrow();
  });

  test('§7 missing account dir is a no-op', () => {
    expect(() => safeDeleteAccountDir(acct, root)).not.toThrow();
  });

  test('injectable fs: apply goes only through the given fs', () => {
    const calls: string[] = [];
    const fake = {
      ...nodeLayoutFs,
      kind: () => null,
      mkdir: (p: string) => void calls.push(`mkdir ${p}`),
      symlink: (t: string, p: string) => void calls.push(`link ${p}->${t}`),
    };
    applyLayout(planLayout('/H/.claude', '/R/abcabcabcabc'), fake);
    expect(calls).toContain('link /R/abcabcabcabc/projects->/H/.claude/projects');
    expect(calls).toContain('mkdir /H/.claude');
    expect(calls.length).toBe(1 + 11 + 1 + 11);
  });
});

describe('v2 §5.2 Account › "Cấu hình chung" list', () => {
  test('§5.2 every ~/.claude entry with its class; the 11 shared always listed; unknown ones carry the PO toggle', () => {
    const l = entryList(['hooks', 'projects', 'sessions', 'teams', 'docs', '.DS_Store'], ['docs']);
    expect(l.filter((e) => e.cls === 'shared').map((e) => e.name)).toEqual([...SHARED_ENTRIES].sort());
    expect(l.find((e) => e.name === 'hooks')).toEqual({ name: 'hooks', cls: 'unknown', shared: false });
    expect(l.find((e) => e.name === 'docs')).toEqual({ name: 'docs', cls: 'unknown', shared: true });
    expect(l.find((e) => e.name === 'teams')).toEqual({ name: 'teams', cls: 'private', shared: false });
    expect(l.find((e) => e.name === 'sessions')?.cls).toBe('never');
    expect(l.some((e) => e.name === '.DS_Store')).toBe(false); // noise, not shown
  });
});
