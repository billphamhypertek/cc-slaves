import { describe, expect, test } from 'bun:test';
import { accountAddDirs, buildArgs } from '../../src/session/args.ts';

const COMMON = [
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
  '--replay-user-messages', '--permission-prompt-tool', 'stdio', '--setting-sources', 'user,project,local',
];
const base = {
  sessionId: 's-1', settingsPath: '/h/deny.json', mcpConfigPath: '/h/mcp/s-1.json',
  appendSystemPrompt: 'phụ lục', addDirs: ['/a/k/projects', '/a/k/plans'],
};
const mid = () => [
  '--dangerously-skip-permissions', '--add-dir', '/a/k/projects', '/a/k/plans', '--settings', '/h/deny.json', '--mcp-config', '/h/mcp/s-1.json',
  '--strict-mcp-config', '--disallowedTools', 'AskUserQuestion', '--append-system-prompt', 'phụ lục',
];

describe('buildArgs (§7.3)', () => {
  test('v2.2 §5.1 --strict-mcp-config exactly once, right after the one --mcp-config (fresh and resume)', () => {
    for (const resume of [false, true]) {
      const a = buildArgs({ ...base, resume });
      expect(a.filter((x) => x === '--strict-mcp-config')).toHaveLength(1);
      expect(a.filter((x) => x === '--mcp-config')).toHaveLength(1);
      expect(a[a.indexOf('--mcp-config') + 2]).toBe('--strict-mcp-config');
    }
  });
  test('§7.3 fresh session, no optional flags → --session-id', () => {
    expect(buildArgs({ ...base, resume: false })).toEqual([...COMMON, ...mid(), '--session-id', 's-1']);
  });
  test('§7.3 resume → --resume instead of --session-id', () => {
    expect(buildArgs({ ...base, resume: true })).toEqual([...COMMON, ...mid(), '--resume', 's-1']);
  });
  test('§7.3 fresh with agent, model, effort in that order', () => {
    expect(buildArgs({ ...base, resume: false, agent: 'coder', model: 'opus', effort: 'high' })).toEqual([
      ...COMMON, ...mid(), '--session-id', 's-1', '--agent', 'coder', '--model', 'opus', '--effort', 'high',
    ]);
  });
  test('§7.3 resume with model only; never --bare', () => {
    const a = buildArgs({ ...base, resume: true, model: 'haiku' });
    expect(a).toEqual([...COMMON, ...mid(), '--resume', 's-1', '--model', 'haiku']);
    expect(a).not.toContain('--bare');
  });
  test('§7 D18 every session skips permissions: no --permission-mode, stdio prompt tool kept, --add-dir kept', () => {
    for (const resume of [false, true]) {
      const a = buildArgs({ ...base, resume });
      expect(a.filter((x) => x === '--dangerously-skip-permissions')).toHaveLength(1);
      expect(a).not.toContain('--permission-mode');
      expect(a.slice(a.indexOf('--permission-prompt-tool'), a.indexOf('--permission-prompt-tool') + 2)).toEqual(['--permission-prompt-tool', 'stdio']);
      expect(a).toContain('--add-dir');
    }
  });
});

describe('§5.4 SA2 --add-dir', () => {
  test('§7 SA2 every session gets --add-dir <acct>/projects <acct>/plans, followed by a flag (variadic option ends)', () => {
    const dirs = accountAddDirs({ configDir: '/Users/x/.cc-slaves-accounts/0123456789ab' });
    expect(dirs).toEqual(['/Users/x/.cc-slaves-accounts/0123456789ab/projects', '/Users/x/.cc-slaves-accounts/0123456789ab/plans']);
    const a = buildArgs({ ...base, resume: false, addDirs: dirs });
    const i = a.indexOf('--add-dir');
    expect(a.slice(i, i + 4)).toEqual(['--add-dir', ...dirs, '--settings']);
    expect(a.filter((x) => x === '--add-dir')).toHaveLength(1);
  });
  test('hf1116 T2 the terminal account gets no --add-dir (its projects/ and plans/ ARE ~/.claude)', () => {
    const dirs = accountAddDirs({ configDir: '/Users/x/.claude', terminal: true });
    expect(dirs).toEqual([]);
    expect(buildArgs({ ...base, resume: false, addDirs: dirs })).not.toContain('--add-dir');
  });
});

describe('CC_SLAVES_MODEL_OVERRIDE (test-only knob, live smoke §10)', () => {
  test('§10 smoke: override replaces the lane model and is added when none was given', () => {
    const env = { CC_SLAVES_MODEL_OVERRIDE: 'haiku' };
    expect(buildArgs({ ...base, resume: false, model: 'opus' }, env)).toEqual([...COMMON, ...mid(), '--session-id', 's-1', '--model', 'haiku']);
    expect(buildArgs({ ...base, resume: true }, env)).toEqual([...COMMON, ...mid(), '--resume', 's-1', '--model', 'haiku']);
  });
  test('§10 smoke: empty / unset override changes nothing', () => {
    expect(buildArgs({ ...base, resume: false, model: 'opus' }, { CC_SLAVES_MODEL_OVERRIDE: '' })).toContain('opus');
    expect(buildArgs({ ...base, resume: false }, {})).not.toContain('--model');
  });
});
