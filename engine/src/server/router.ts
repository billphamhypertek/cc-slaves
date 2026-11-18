// WS command router (spec §7.9, §7.2 N2): `command` (id) → `ack` | `error`. The channel is fixed per connection by the
// server (the port it came in on), never read from the message; the remote channel only reaches REMOTE_ALLOWED.
import { REMOTE_ALLOWED, type Channel, type Command, type ServerMsg } from '../../../shared/protocol.ts';
import { KeyedError, type Msg } from '../errors.ts';
import { t, type Key, type Params } from '../../../shared/i18n/index.ts';
import { isObj } from '../../../shared/json.ts';

/** §6A: `message` stays the Vietnamese fallback; `key` (+ `params`) is what the UI renders in its language. */
export class CommandError extends KeyedError {
  constructor(code: string, m: Msg, key?: Key, params?: Params) { super(code, m, key, params); this.name = 'CommandError'; }
}

export interface CommandCtx { channel: Channel }

export type Handlers = {
  [K in Command['cmd']]: (c: Extract<Command, { cmd: K }>, ctx: CommandCtx) => unknown;
};

/** Every protocol command; `satisfies` + the router test keep it complete. */
export const ALL_COMMANDS = [
  'send', 'interrupt', 'lane_stop', 'lane_resume', 'lane_finish', 'lane_switch_account', 'card_answer', 'card_action',
  'watch', 'presence', 'history', 'subagent_history', 'done_lanes_list', 'stop_all', 'orchestrator_restart', 'orchestrator_new', 'remote_off',
  'sessions_list', 'session_open', 'session_end', 'lane_reassign', 'session_models', 'session_set_model', 'session_model_cancel', 'lane_set_model', 'lane_model_cancel',
  'session_resume', 'session_resume_preview', 'session_rename', 'lane_continue', 'lane_continue_preview',
  'device_revoke_self', 'project_add', 'project_update', 'project_remove', 'project_close', 'project_resume', 'caps_update', 'config_update',
  'quota_refresh', 'setup_check', 'setup_install', 'git_install', 'git_identity_set', 'gh_login', 'gh_login_cancel', 'open_in_vscode', 'engine_shutdown',
  'account_add', 'account_login', 'account_login_cancel', 'account_paste_code', 'account_login_resolve', 'account_logout', 'account_delete',
  'shared_cfg_merge', 'shared_cfg_toggle', 'shared_cfg_reveal', 'account_open_private', 'accounts_info', 'account_open_terminal', 'folder_pick',
  'mcp_add', 'mcp_edit', 'mcp_which', 'mcp_remove', 'mcp_toggle', 'mcp_project_enable', 'mcp_check', 'mcp_login', 'mcp_login_cancel', 'mcp_logout', 'mcp_keychain_retry', 'mcp_snooze',
  'skill_add_folder', 'skill_check_folder', 'skill_git_fetch', 'skill_git_add', 'skill_git_cancel', 'skill_remove', 'skill_fix', 'skill_ack', 'skill_toggle', 'plugin_toggle',
  'fs_list', 'fs_find', 'fs_read', 'fs_write', 'git_branches', 'git_changes', 'git_diff', 'git_log', 'git_watch',
  'issue_ok', 'issue_seen', 'issue_file', 'issue_cancel_preview', 'issue_cancel', 'spec_new', 'spec_build', 'spec_edit', 'spec_mark', 'spec_scan', 'spec_import_hide', 'spec_prior_sessions', 'spec_outputs', 'session_pick',
  'workflow_get', 'workflow_save', 'workflow_create', 'workflow_import', 'workflow_delete', 'project_set_workflow',
  'workflow_edit', 'workflow_draft_start', 'workflow_draft_say', 'workflow_draft_stop', 'workflow_draft_discard', 'workflow_draft_patch',
  'workflow_draft_save', 'workflow_draft_undo', 'workflow_draft_quota',
  'toolkit_check', 'toolkit_install', 'toolkit_update',
  'update_hold', 'update_commit',
  'graph_check', 'graph_install', 'graph_update', 'graph_retry', 'graph_impact', 'graph_index', 'graph_index_stop', 'graph_orphans', 'graph_clean', 'graph_toggle',
] as const satisfies readonly Command['cmd'][];
type Missing = Exclude<Command['cmd'], (typeof ALL_COMMANDS)[number]>;
const _complete: Missing extends never ? true : never = true;
void _complete;

const KNOWN: ReadonlySet<string> = new Set(ALL_COMMANDS);

export async function route(h: Handlers, ctx: CommandCtx, raw: unknown): Promise<ServerMsg> {
  if (!isObj(raw) || raw.type !== 'command' || typeof raw.id !== 'string' || !isObj(raw.command)) {
    return { type: 'error', id: isObj(raw) && typeof raw.id === 'string' ? raw.id : '', code: 'bad_message', message: t('vi', 'errors.badMessage'), key: 'errors.badMessage' };
  }
  const id = raw.id;
  const c = raw.command;
  if (typeof c.cmd !== 'string' || !KNOWN.has(c.cmd)) {
    return { type: 'error', id, code: 'unknown_command', message: t('vi', 'errors.unknownCommand', { cmd: String(c.cmd) }), key: 'errors.unknownCommand', params: { cmd: String(c.cmd) } };
  }
  const cmd = c.cmd as Command['cmd'];
  if (ctx.channel !== 'mac' && !REMOTE_ALLOWED.has(cmd)) {
    return { type: 'error', id, code: 'forbidden_remote', message: t('vi', 'errors.forbiddenRemote'), key: 'errors.forbiddenRemote' };
  }
  try {
    const fn = h[cmd] as (c: Command, ctx: CommandCtx) => unknown;
    const result = await fn(c as unknown as Command, ctx);
    return result === undefined ? { type: 'ack', id } : { type: 'ack', id, result };
  } catch (e) {
    if (e instanceof KeyedError) { // every engine error (lane, card, account, command, v2.9 workflow): code + message (+ key)
      return { type: 'error', id, code: e.code, message: e.message, ...(e.key ? { key: e.key } : {}), ...(e.params ? { params: e.params } : {}) };
    }
    const detail = e instanceof Error ? e.message : String(e);
    return { type: 'error', id, code: 'internal', message: t('vi', 'errors.internal', { detail }), key: 'errors.internal', params: { detail } };
  }
}
