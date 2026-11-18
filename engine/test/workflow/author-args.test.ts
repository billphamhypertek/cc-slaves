// v2.9 §5.9 / R20 the author session's argv whitelist (measured by G0 §4), its draft files and its appendix (from vocab.ts).
import { describe, expect, test } from 'bun:test';
import { authorAppendix, buildAuthorArgs, draftMcpConfig, draftSettings } from '../../src/workflow/author-args.ts';
import { BOOL_RULES, KICKOFF_KEYS, LABEL_KEYS, REQUIRED_SLOTS, STEP_KEYS, STEP_TYPES, WORKFLOW_KEYS } from '../../src/workflow/vocab.ts';

const D = '/h/.cc-slaves/workflow-drafts/d1';
const base = { draftDir: D, sessionId: 'sid-1', resume: false, appendix: 'APX' };
const valueOf = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

describe('buildAuthorArgs (§5.9, G0 §4 argv)', () => {
  test('the exact G0 whitelist argv, new session', () => {
    expect(buildAuthorArgs(base, {})).toEqual([
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages',
      '--restricted', '--tools', 'Read,Write,Edit,Glob,Grep', '--disable-slash-commands',
      '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
      '--mcp-config', `${D}/mcp.json`, '--strict-mcp-config', '--allowedTools', 'mcp__cc_draft__draft_save',
      '--add-dir', `${D}/examples`, '--settings', `${D}/settings.json`,
      '--system-prompt-snapshot', 'off', '--append-system-prompt', 'APX', '--session-id', 'sid-1',
    ]);
  });

  test('never skip-permissions, never Bash / WebFetch, never the account dir', () => {
    const a = buildAuthorArgs({ ...base, model: 'opus' }, {}).join(' ');
    expect(a).not.toContain('dangerously');
    expect(a).not.toContain('bypassPermissions');
    expect(a).not.toContain('Bash');
    expect(a).not.toContain('WebFetch');
    expect(a).not.toContain('--setting-sources');
    expect(a).not.toContain('--permission-prompt-tool');
    expect(buildAuthorArgs(base, {}).filter((x) => x === '--add-dir')).toHaveLength(1);
  });

  test('resume, model, test model override', () => {
    const r = buildAuthorArgs({ ...base, resume: true, model: 'opus' }, {});
    expect(valueOf(r, '--resume')).toBe('sid-1');
    expect(r).not.toContain('--session-id');
    expect(valueOf(r, '--model')).toBe('opus');
    expect(valueOf(buildAuthorArgs({ ...base, model: 'opus' }, { CC_SLAVES_MODEL_OVERRIDE: 'haiku' }), '--model')).toBe('haiku');
    expect(buildAuthorArgs({ ...base, model: null }, {})).not.toContain('--model');
  });
});

describe('draft files', () => {
  test('settings deny examples with the // absolute prefix (G0 4e)', () => {
    expect(draftSettings(D)).toEqual({ permissions: { deny: [`Edit(/${D}/examples/**)`, `Write(/${D}/examples/**)`] } });
    expect(JSON.stringify(draftSettings(D))).toContain('Edit(//h/');
  });
  test('mcp config: only cc_draft on /mcp-draft with the draft token', () => {
    expect(draftMcpConfig(47800, 'tok')).toEqual({ mcpServers: { cc_draft: { type: 'http', url: 'http://127.0.0.1:47800/mcp-draft', headers: { Authorization: 'Bearer tok' } } } });
  });
});

describe('authorAppendix (§5.9 from vocab.ts)', () => {
  const a = authorAppendix({ skills: ['brainstorming', 'superpowers:tdd'], plugins: ['superpowers'] });
  test('every step type, key, slot and rule of the vocabulary', () => {
    for (const t of STEP_TYPES) {
      expect(a).toContain(`\`${t}\``);
      for (const k of STEP_KEYS[t]) expect(a).toContain(k);
      for (const s of REQUIRED_SLOTS[t]) expect(a).toContain(`{{${s}}}`);
    }
    for (const k of WORKFLOW_KEYS) expect(a).toContain(k);
    for (const k of [...LABEL_KEYS, ...KICKOFF_KEYS.design, ...KICKOFF_KEYS.build, ...BOOL_RULES]) expect(a).toContain(k);
  });
  test('installed skills / plugins, the examples, the save rule', () => {
    expect(a).toContain('superpowers:tdd');
    expect(a).toContain('brainstorming');
    expect(a).toContain('examples/');
    expect(a).toContain('draft_save');
    expect(a).toContain('200');
  });
  test('no skill installed → says so', () => {
    expect(authorAppendix({ skills: [], plugins: [] })).toContain('(không có)');
  });
});
