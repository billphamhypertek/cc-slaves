import { describe, expect, test } from 'bun:test';
import { WorkflowLibError } from '../../src/workflow/library.ts';
import { CARD_ACTION_CMD, REMOTE_ALLOWED, type Command } from '../../../shared/protocol.ts';
import { CardError } from '../../src/cards/store.ts';
import { LaneError } from '../../src/lane/manager.ts';
import { ALL_COMMANDS, CommandError, route, type Handlers } from '../../src/server/router.ts';

const sample: { [K in Command['cmd']]: Extract<Command, { cmd: K }> } = {
  send: { cmd: 'send', target: { kind: 'orchestrator', projectId: 'p' }, text: 'x' },
  interrupt: { cmd: 'interrupt', target: { kind: 'orchestrator', projectId: 'p' } },
  lane_stop: { cmd: 'lane_stop', projectId: 'p', name: 'D1', mode: 'drain' },
  lane_resume: { cmd: 'lane_resume', projectId: 'p', name: 'D1' },
  lane_finish: { cmd: 'lane_finish', projectId: 'p', name: 'D1' },
  lane_switch_account: { cmd: 'lane_switch_account', projectId: 'p', name: 'D1', account: null },
  card_answer: { cmd: 'card_answer', id: 1, answer: { option: 'A' } },
  card_action: { cmd: 'card_action', id: 1, action: 'dismiss' },
  watch: { cmd: 'watch', target: null },
  presence: { cmd: 'presence', visible: true },
  history: { cmd: 'history', target: { kind: 'orchestrator', projectId: 'p' } },
  subagent_history: { cmd: 'subagent_history', target: { kind: 'orchestrator', projectId: 'p' }, taskId: 't' },
  done_lanes_list: { cmd: 'done_lanes_list', projectId: 'p', limit: 6 },
  stop_all: { cmd: 'stop_all' },
  orchestrator_restart: { cmd: 'orchestrator_restart', projectId: 'p' },
  orchestrator_new: { cmd: 'orchestrator_new', projectId: 'p' },
  sessions_list: { cmd: 'sessions_list', projectId: 'p' },
  session_open: { cmd: 'session_open', projectId: 'p' },
  session_models: { cmd: 'session_models', projectId: 'p' },
  session_set_model: { cmd: 'session_set_model', sessionId: 's', model: 'sonnet' },
  session_model_cancel: { cmd: 'session_model_cancel', sessionId: 's' },
  lane_set_model: { cmd: 'lane_set_model', projectId: 'p', name: 'D2', model: null },
  lane_model_cancel: { cmd: 'lane_model_cancel', projectId: 'p', name: 'D2' },
  session_end: { cmd: 'session_end', sessionId: 's' },
  lane_reassign: { cmd: 'lane_reassign', projectId: 'p', name: 'D1', toSession: 's' },
  session_resume: { cmd: 'session_resume', sessionId: 's', mode: 'parallel' },
  session_resume_preview: { cmd: 'session_resume_preview', sessionId: 's' },
  session_rename: { cmd: 'session_rename', sessionId: 's', title: 'hotfix' },
  lane_continue: { cmd: 'lane_continue', projectId: 'p', name: 'D1', toSession: 's' },
  lane_continue_preview: { cmd: 'lane_continue_preview', projectId: 'p', name: 'D1' },
  remote_off: { cmd: 'remote_off' },
  device_revoke_self: { cmd: 'device_revoke_self' },
  project_add: { cmd: 'project_add', name: 'P', path: '/p' },
  project_update: { cmd: 'project_update', id: 'p', patch: {} },
  project_remove: { cmd: 'project_remove', id: 'p' },
  project_close: { cmd: 'project_close', id: 'p' },
  project_resume: { cmd: 'project_resume', id: 'p' },
  caps_update: { cmd: 'caps_update', caps: {} },
  config_update: { cmd: 'config_update', patch: {} },
  quota_refresh: { cmd: 'quota_refresh' },
  setup_check: { cmd: 'setup_check' },
  setup_install: { cmd: 'setup_install', what: 'claude' },
  git_install: { cmd: 'git_install' }, git_identity_set: { cmd: 'git_identity_set', name: 'n', email: 'n@x-dev.test' }, gh_login: { cmd: 'gh_login' }, gh_login_cancel: { cmd: 'gh_login_cancel' },
  open_in_vscode: { cmd: 'open_in_vscode', path: '/p' },
  engine_shutdown: { cmd: 'engine_shutdown' },
  account_add: { cmd: 'account_add', email: 'a@x' },
  account_login: { cmd: 'account_login', email: 'a@x' },
  account_login_cancel: { cmd: 'account_login_cancel' },
  account_paste_code: { cmd: 'account_paste_code', code: 'c#s' },
  account_login_resolve: { cmd: 'account_login_resolve', choice: 'keep' },
  account_logout: { cmd: 'account_logout', email: 'a@x' },
  account_delete: { cmd: 'account_delete', email: 'a@x' },
  shared_cfg_merge: { cmd: 'shared_cfg_merge', email: 'a@x', name: 'plans' },
  shared_cfg_toggle: { cmd: 'shared_cfg_toggle', name: 'hooks', shared: true },
  account_open_private: { cmd: 'account_open_private', url: 'https://x' },
  folder_pick: { cmd: 'folder_pick' },
  accounts_info: { cmd: 'accounts_info' },
  account_open_terminal: { cmd: 'account_open_terminal', email: 'a@x' },
  shared_cfg_reveal: { cmd: 'shared_cfg_reveal', email: 'a@x', name: 'plans', file: 'a.md' },
  mcp_add: { cmd: 'mcp_add', name: 'x', config: { command: 'x' } },
  mcp_edit: { cmd: 'mcp_edit', name: 'x', config: { command: 'y' } },
  mcp_which: { cmd: 'mcp_which', command: 'npx' },
  mcp_remove: { cmd: 'mcp_remove', name: 'x' },
  mcp_toggle: { cmd: 'mcp_toggle', id: 'user:x', on: false },
  mcp_project_enable: { cmd: 'mcp_project_enable', id: 'project:p:x', on: true },
  mcp_check: { cmd: 'mcp_check', id: 'user:x' },
  mcp_login: { cmd: 'mcp_login', id: 'user:x' },
  mcp_login_cancel: { cmd: 'mcp_login_cancel', id: 'user:x' },
  mcp_logout: { cmd: 'mcp_logout', id: 'user:x' },
  mcp_keychain_retry: { cmd: 'mcp_keychain_retry', id: 'user:x' },
  mcp_snooze: { cmd: 'mcp_snooze', id: 'user:x' },
  skill_add_folder: { cmd: 'skill_add_folder', path: '/s', mode: 'link' },
  skill_check_folder: { cmd: 'skill_check_folder', path: '/s' },
  skill_git_fetch: { cmd: 'skill_git_fetch', url: 'https://g/x.git' },
  skill_git_add: { cmd: 'skill_git_add', cloneId: 'c', names: ['x'] },
  skill_git_cancel: { cmd: 'skill_git_cancel', cloneId: 'c' },
  skill_remove: { cmd: 'skill_remove', id: 'user:x' },
  skill_fix: { cmd: 'skill_fix', issueId: 'appLink:/s', fix: 'copy' },
  skill_ack: { cmd: 'skill_ack', issueId: 'duplicate:/s', on: true },
  skill_toggle: { cmd: 'skill_toggle', id: 'user:x', on: false },
  plugin_toggle: { cmd: 'plugin_toggle', key: 'vercel@m', on: false },
  fs_list: { cmd: 'fs_list', projectId: 'p', src: { kind: 'base' }, dir: '', showIgnored: false },
  fs_find: { cmd: 'fs_find', projectId: 'p', src: { kind: 'base' }, query: 'a', showIgnored: false },
  fs_read: { cmd: 'fs_read', projectId: 'p', src: { kind: 'lane', laneId: 'D1' }, path: 'a.ts' },
  fs_write: { cmd: 'fs_write', projectId: 'p', src: { kind: 'base' }, path: 'a.ts', text: 'x', eol: 'lf', bom: false, baseHash: 'h' },
  git_branches: { cmd: 'git_branches', projectId: 'p' },
  git_changes: { cmd: 'git_changes', projectId: 'p', of: { branch: 'lane/d1' } },
  git_diff: { cmd: 'git_diff', projectId: 'p', path: 'a.ts', of: { dirty: { kind: 'base' } } },
  git_log: { cmd: 'git_log', projectId: 'p', refs: [], limit: 200 },
  git_watch: { cmd: 'git_watch', projectId: 'p', on: true },
  issue_ok: { cmd: 'issue_ok', projectId: 'p', key: 'B-1' },
  issue_seen: { cmd: 'issue_seen', projectId: 'p', key: 'B-1' },
  issue_file: { cmd: 'issue_file', projectId: 'p', key: 'B-1', id: 1 },
  spec_new: { cmd: 'spec_new', projectId: 'p' },
  spec_build: { cmd: 'spec_build', projectId: 'p', path: 'docs/specs/a.md' },
  spec_edit: { cmd: 'spec_edit', projectId: 'p', path: 'docs/specs/a.md' },
  spec_mark: { cmd: 'spec_mark', projectId: 'p', path: 'docs/specs/a.md', state: 'approved' },
  spec_scan: { cmd: 'spec_scan', projectId: 'p' },
  spec_import_hide: { cmd: 'spec_import_hide', projectId: 'p' },
  spec_prior_sessions: { cmd: 'spec_prior_sessions', projectId: 'p', path: 'docs/specs/a.md' },
  spec_outputs: { cmd: 'spec_outputs', projectId: 'p', path: 'docs/specs/a.md' },
  session_pick: { cmd: 'session_pick', projectId: 'p', kind: 'build' },
  issue_cancel_preview: { cmd: 'issue_cancel_preview', projectId: 'p', key: 'T-1' },
  issue_cancel: { cmd: 'issue_cancel', projectId: 'p', key: 'T-1', reason: 'không cần nữa' },
  workflow_get: { cmd: 'workflow_get', id: 'builtin:po' },
  workflow_save: { cmd: 'workflow_save', id: 'x', files: {}, baseRev: 'r' },
  workflow_create: { cmd: 'workflow_create', from: 'builtin:po', name: 'X' },
  workflow_import: { cmd: 'workflow_import', dir: '/tmp/x' },
  workflow_delete: { cmd: 'workflow_delete', id: 'x' },
  project_set_workflow: { cmd: 'project_set_workflow', projectId: 'p', id: 'x' },
  workflow_edit: { cmd: 'workflow_edit', files: {}, edits: [] },
  workflow_draft_start: { cmd: 'workflow_draft_start', fromId: null, text: 'x' },
  workflow_draft_say: { cmd: 'workflow_draft_say', draftId: 'd', text: 'x' },
  workflow_draft_stop: { cmd: 'workflow_draft_stop', draftId: 'd' },
  workflow_draft_discard: { cmd: 'workflow_draft_discard', draftId: 'd' },
  workflow_draft_patch: { cmd: 'workflow_draft_patch', draftId: 'd', edits: [] },
  workflow_draft_save: { cmd: 'workflow_draft_save', draftId: 'd' },
  workflow_draft_undo: { cmd: 'workflow_draft_undo', draftId: 'd' },
  workflow_draft_quota: { cmd: 'workflow_draft_quota', draftId: 'd', go: false },
  toolkit_check: { cmd: 'toolkit_check', force: true },
  toolkit_install: { cmd: 'toolkit_install', keys: ['superpowers'] },
  toolkit_update: { cmd: 'toolkit_update', key: 'superpowers' },
  graph_check: { cmd: 'graph_check', force: true },
  graph_install: { cmd: 'graph_install' },
  graph_update: { cmd: 'graph_update' },
  graph_retry: { cmd: 'graph_retry' },
  graph_impact: { cmd: 'graph_impact' },
  graph_index: { cmd: 'graph_index', projectId: 'p' },
  graph_index_stop: { cmd: 'graph_index_stop', projectId: 'p' },
  graph_orphans: { cmd: 'graph_orphans' },
  graph_clean: { cmd: 'graph_clean', roots: ['/gone'] },
  graph_toggle: { cmd: 'graph_toggle', projectId: 'p', on: false },
  update_hold: { cmd: 'update_hold', on: true },
  update_commit: { cmd: 'update_commit' },
};

const V22 = ['mcp_add', 'mcp_edit', 'mcp_which', 'mcp_remove', 'mcp_toggle', 'mcp_project_enable', 'mcp_check', 'mcp_login', 'mcp_login_cancel', 'mcp_logout', 'mcp_keychain_retry', 'mcp_snooze',
  'skill_add_folder', 'skill_check_folder', 'skill_git_fetch', 'skill_git_add', 'skill_git_cancel', 'skill_remove', 'skill_fix', 'skill_ack', 'skill_toggle', 'plugin_toggle'] as const;

test('§2 N6 D32: no v2.2 Skills & MCP command is remote-allowed; every one → forbidden_remote on the remote channel, handler never runs', async () => {
  const { h, called } = spyHandlers();
  for (const c of V22) {
    expect(REMOTE_ALLOWED.has(c)).toBe(false);
    expect(await route(h, { channel: 'remote' }, { type: 'command', id: c, command: sample[c] })).toMatchObject({ type: 'error', code: 'forbidden_remote' });
  }
  expect(called).toEqual([]);
});

test('v2.4 §8 / §5.6: session_models / session_set_model / session_model_cancel / lane_set_model / lane_model_cancel / config_update are Mac only; remote → forbidden_remote, handler never runs', async () => {
  const { h, called } = spyHandlers();
  const cmds = ['session_models', 'session_set_model', 'session_model_cancel', 'lane_set_model', 'lane_model_cancel', 'config_update'] as const;
  for (const c of cmds) {
    expect(REMOTE_ALLOWED.has(c)).toBe(false);
    expect(await route(h, { channel: 'remote' }, { type: 'command', id: c, command: sample[c] })).toMatchObject({ type: 'error', code: 'forbidden_remote' });
    expect(await route(h, { channel: 'mac' }, { type: 'command', id: c, command: sample[c] })).toMatchObject({ type: 'ack' });
  }
  expect(called).toEqual([...cmds]);
});

test('v2.7 §8 / §10.1 / R-B12: every issue_* / spec_* command is Mac only; remote → forbidden_remote, handler never runs; Mac → ack', async () => {
  const v27 = ALL_COMMANDS.filter((c) => c.startsWith('issue_') || c.startsWith('spec_'));
  expect(v27.length).toBe(13); // + G3b issue_cancel_preview, issue_cancel, review MINOR-2 issue_file
  const { h, called } = spyHandlers();
  for (const c of v27) {
    expect(REMOTE_ALLOWED.has(c)).toBe(false);
    expect(await route(h, { channel: 'remote' }, { type: 'command', id: c, command: sample[c] })).toMatchObject({ type: 'error', code: 'forbidden_remote' });
  }
  expect(called).toEqual([]);
  for (const c of v27) expect(await route(h, { channel: 'mac' }, { type: 'command', id: c, command: sample[c] })).toMatchObject({ type: 'ack' });
  expect(called).toEqual(v27);
});

test('v2.9 §10.1 / N6: every workflow library command is Mac only; remote → forbidden_remote, handler never runs; Mac → ack', async () => {
  const v29 = ['workflow_get', 'workflow_save', 'workflow_create', 'workflow_import', 'workflow_delete', 'project_set_workflow', 'workflow_edit',
    // §5.9 / §10.3 the author session's commands (R20: a new security surface, never remote)
    'workflow_draft_start', 'workflow_draft_say', 'workflow_draft_stop', 'workflow_draft_discard', 'workflow_draft_patch', 'workflow_draft_save',
    'workflow_draft_undo', 'workflow_draft_quota'] as const;
  expect(ALL_COMMANDS.filter((c) => c.includes('workflow')).sort()).toEqual([...v29].sort());
  const { h, called } = spyHandlers();
  for (const c of v29) {
    expect(REMOTE_ALLOWED.has(c)).toBe(false);
    expect(await route(h, { channel: 'remote' }, { type: 'command', id: c, command: sample[c] })).toMatchObject({ type: 'error', code: 'forbidden_remote' });
  }
  expect(called).toEqual([]);
  for (const c of v29) expect(await route(h, { channel: 'mac' }, { type: 'command', id: c, command: sample[c] })).toMatchObject({ type: 'ack' });
  expect(called).toEqual([...v29]);
});

test('v2.5 §5.8 / N7: every graph_* command is Mac only; remote → forbidden_remote, handler never runs; Mac → ack', async () => {
  const v25 = ALL_COMMANDS.filter((c) => c.startsWith('graph_'));
  expect(v25.length).toBe(10);
  const { h, called } = spyHandlers();
  for (const c of v25) {
    expect(REMOTE_ALLOWED.has(c)).toBe(false);
    expect(await route(h, { channel: 'remote' }, { type: 'command', id: c, command: sample[c] })).toMatchObject({ type: 'error', code: 'forbidden_remote' });
  }
  expect(called).toEqual([]);
  for (const c of v25) expect(await route(h, { channel: 'mac' }, { type: 'command', id: c, command: sample[c] })).toMatchObject({ type: 'ack' });
  expect(called).toEqual(v25);
});

test('v2.3 §8 / §11: no fs_* / git_* / open_in_vscode command is remote-allowed; remote → forbidden_remote, handler never runs', async () => {
  const v23 = ALL_COMMANDS.filter((c) => c.startsWith('fs_') || c.startsWith('git_'));
  // hf1116 (b) adds git_install / git_identity_set (Mac only too)
  expect(v23.sort()).toEqual(['fs_find', 'fs_list', 'fs_read', 'fs_write', 'git_branches', 'git_changes', 'git_diff', 'git_identity_set', 'git_install', 'git_log', 'git_watch']);
  const { h, called } = spyHandlers();
  for (const c of [...v23, 'open_in_vscode'] as const) {
    expect(REMOTE_ALLOWED.has(c)).toBe(false);
    expect(await route(h, { channel: 'remote' }, { type: 'command', id: c, command: sample[c] })).toMatchObject({ type: 'error', code: 'forbidden_remote' });
  }
  expect(called).toEqual([]);
  // the Code form of open_in_vscode is the same command
  expect(await route(h, { channel: 'remote' }, { type: 'command', id: 'o', command: { cmd: 'open_in_vscode', projectId: 'p', src: { kind: 'base' }, path: 'a' } })).toMatchObject({ code: 'forbidden_remote' });
});

test('hf1116 (b) G3: git_install / git_identity_set / gh_login / gh_login_cancel are Mac only; remote → forbidden_remote, handler never runs', async () => {
  const { h, called } = spyHandlers();
  for (const c of ['git_install', 'git_identity_set', 'gh_login', 'gh_login_cancel'] as const) {
    expect(REMOTE_ALLOWED.has(c)).toBe(false);
    expect(await route(h, { channel: 'remote' }, { type: 'command', id: c, command: sample[c] })).toMatchObject({ type: 'error', code: 'forbidden_remote' });
  }
  expect(called).toEqual([]);
});

test('§2 N6 C24: card actions mcp_login / mcp_snooze run commands outside REMOTE_ALLOWED', () => {
  expect(CARD_ACTION_CMD.mcp_login).toBe('mcp_login');
  expect(CARD_ACTION_CMD.mcp_snooze).toBe('mcp_snooze');
  for (const a of ['mcp_login', 'mcp_snooze']) expect(REMOTE_ALLOWED.has(CARD_ACTION_CMD[a]!)).toBe(false);
});

test('v2 §7 N7: no account_* command is remote-allowed; card action account_relogin runs account_login (Mac only)', () => {
  const acct = ALL_COMMANDS.filter((c) => c.startsWith('account_'));
  expect(acct.sort()).toEqual(['account_add', 'account_delete', 'account_login', 'account_login_cancel', 'account_login_resolve', 'account_logout', 'account_open_private', 'account_open_terminal', 'account_paste_code']);
  for (const c of acct) expect(REMOTE_ALLOWED.has(c)).toBe(false);
  expect(CARD_ACTION_CMD.account_relogin).toBe('account_login');
});

test('v2 §7 N7: shared_cfg_merge / shared_cfg_toggle are Mac only, also through their A9 / §5.2 card actions', () => {
  for (const c of ['shared_cfg_merge', 'shared_cfg_toggle', 'shared_cfg_reveal', 'account_open_private', 'accounts_info', 'folder_pick'] as const) expect(REMOTE_ALLOWED.has(c)).toBe(false);
  expect(CARD_ACTION_CMD.shared_cfg_merge).toBe('shared_cfg_merge');
  expect(CARD_ACTION_CMD.shared_cfg_toggle).toBe('shared_cfg_toggle');
});

function spyHandlers(): { h: Handlers; called: string[] } {
  const called: string[] = [];
  const h = Object.fromEntries(ALL_COMMANDS.map((c) => [c, () => { called.push(c); return { ok: c }; }])) as unknown as Handlers;
  return { h, called };
}

describe('§7.2 N2 channel gating — one test per command', () => {
  test('ALL_COMMANDS lists every protocol command', () => {
    expect([...ALL_COMMANDS as readonly string[]].sort()).toEqual(Object.keys(sample).sort());
  });
  for (const cmd of ALL_COMMANDS) {
    const allowed = REMOTE_ALLOWED.has(cmd);
    test(`§7.2 N2 ${cmd}: mac → handler; remote → ${allowed ? 'handler' : 'forbidden_remote'}`, async () => {
      const { h, called } = spyHandlers();
      const mac = await route(h, { channel: 'mac' }, { type: 'command', id: 'm', command: sample[cmd] });
      expect(mac).toEqual({ type: 'ack', id: 'm', result: { ok: cmd } });
      const remote = await route(h, { channel: 'remote' }, { type: 'command', id: 'r', command: sample[cmd] });
      if (allowed) expect(remote).toEqual({ type: 'ack', id: 'r', result: { ok: cmd } });
      else {
        expect(remote).toMatchObject({ type: 'error', id: 'r', code: 'forbidden_remote' });
        expect(called).toEqual([cmd]); // only the mac call reached the handler
      }
    });
  }
});

test('§4.15 remote channel may call done_lanes_list (read-only, REMOTE_ALLOWED)', async () => {
  expect(REMOTE_ALLOWED.has('done_lanes_list')).toBe(true);
  const { h, called } = spyHandlers();
  const r = await route(h, { channel: 'remote' }, { type: 'command', id: 'r', command: { cmd: 'done_lanes_list', projectId: 'p' } });
  expect(r).toEqual({ type: 'ack', id: 'r', result: { ok: 'done_lanes_list' } });
  expect(called).toEqual(['done_lanes_list']);
});

describe('router errors (Vietnamese message to the PO)', () => {
  const { h } = spyHandlers();
  test('malformed message / unknown command', async () => {
    expect(await route(h, { channel: 'mac' }, { nope: 1 })).toMatchObject({ type: 'error', id: '', code: 'bad_message' });
    expect(await route(h, { channel: 'mac' }, { type: 'command', id: 'x', command: { cmd: 'rm_rf' } }))
      .toMatchObject({ type: 'error', id: 'x', code: 'unknown_command' });
  });
  test('LaneError / CardError / CommandError / any KeyedError keep their code; others → internal', async () => {
    const throwing = (e: unknown) => ({ ...h, send: () => { throw e; } }) as Handlers;
    const msg = { type: 'command', id: 'e', command: sample.send };
    expect(await route(throwing(new LaneError('no_lane', 'Không có lane D9')), { channel: 'mac' }, msg))
      .toEqual({ type: 'error', id: 'e', code: 'no_lane', message: 'Không có lane D9' });
    expect(await route(throwing(new CardError('answered', 'Thẻ #1 đã trả lời')), { channel: 'mac' }, msg)).toMatchObject({ code: 'answered' });
    expect(await route(throwing(new CommandError('bad_input', 'Sai')), { channel: 'mac' }, msg)).toMatchObject({ code: 'bad_input' });
    expect(await route(throwing(new CommandError('bad_input', 'Sai', 'common.cmdFailed', { n: 1 })), { channel: 'mac' }, msg))
      .toMatchObject({ code: 'bad_input', message: 'Sai', key: 'common.cmdFailed', params: { n: 1 } }); // §6A key + Vietnamese fallback
    expect(await route(throwing(new CommandError('bad_input', 'Sai')), { channel: 'mac' }, msg)).not.toHaveProperty('key');
    expect(await route(throwing(new WorkflowLibError('in_use', 'đang dùng')), { channel: 'mac' }, msg)).toEqual({ type: 'error', id: 'e', code: 'in_use', message: 'đang dùng' });
    expect(await route(throwing(new Error('boom')), { channel: 'mac' }, msg)).toMatchObject({ code: 'internal', message: 'Lỗi engine: boom' });
  });
});

test('v2.5 §5.8: every toolkit command is Mac only; remote → forbidden_remote, handler never runs; Mac → ack', async () => {
  const v25 = ['toolkit_check', 'toolkit_install', 'toolkit_update'] as const;
  expect(ALL_COMMANDS.filter((c) => c.startsWith('toolkit_')).sort()).toEqual([...v25].sort());
  const { h, called } = spyHandlers();
  for (const c of v25) {
    expect(REMOTE_ALLOWED.has(c)).toBe(false);
    expect(await route(h, { channel: 'remote' }, { type: 'command', id: c, command: sample[c] })).toMatchObject({ type: 'error', code: 'forbidden_remote' });
  }
  expect(called).toEqual([]);
  for (const c of v25) expect(await route(h, { channel: 'mac' }, { type: 'command', id: c, command: sample[c] })).toMatchObject({ type: 'ack' });
  expect(called).toEqual([...v25]);
});

test('v2.6 §10.2: update_hold / update_commit are Mac only; remote → forbidden_remote, handler never runs; Mac → ack', async () => {
  const { h, called } = spyHandlers();
  const cmds = ['update_hold', 'update_commit'] as const;
  for (const c of cmds) {
    expect(REMOTE_ALLOWED.has(c)).toBe(false);
    expect(await route(h, { channel: 'remote' }, { type: 'command', id: c, command: sample[c] })).toMatchObject({ type: 'error', code: 'forbidden_remote' });
  }
  expect(called).toEqual([]);
  for (const c of cmds) expect(await route(h, { channel: 'mac' }, { type: 'command', id: c, command: sample[c] })).toMatchObject({ type: 'ack' });
  expect(called).toEqual([...cmds]);
});
