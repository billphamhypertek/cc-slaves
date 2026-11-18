// argv for one `claude` session (spec §7.3). Pure: same input (+ env) → same argv. Never `--bare` (it drops hooks/CLAUDE.md).

export interface ArgsInput {
  sessionId: string;
  /** true → `--resume <id>` (conversation exists); false → `--session-id <id>` (new or re-run from scratch, §7.4). */
  resume: boolean;
  settingsPath: string;
  mcpConfigPath: string;
  appendSystemPrompt: string;
  /** §5.4 SA2: `<account dir>/projects`, `<account dir>/plans` (see `accountAddDirs`). */
  addDirs: readonly string[];
  agent?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
}

const COMMON_ARGS: readonly string[] = [
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
  // `--permission-prompt-tool stdio` stays with skip-permissions (v2 D18): a stray `can_use_tool` becomes a card, never a hang.
  '--replay-user-messages', '--permission-prompt-tool', 'stdio', '--setting-sources', 'user,project,local',
];

/**
 * TEST-ONLY knob: `CC_SLAVES_MODEL_OVERRIDE=haiku` forces `--model` on every session (orchestrator + lanes) so the live
 * smoke (spec §10, `scripts/smoke/`) spends as little quota as possible. Never set it in the app / LaunchAgent.
 */
const MODEL_OVERRIDE_ENV = 'CC_SLAVES_MODEL_OVERRIDE';
/** The test model forced on every session, null = none (v2.4 §5.2: the orchestrator then skips its model rules). */
export const modelOverride = (env: Record<string, string | undefined> = process.env): string | null => env[MODEL_OVERRIDE_ENV] || null;

export function buildArgs(a: ArgsInput, env: Record<string, string | undefined> = process.env): string[] {
  const out = [
    ...COMMON_ARGS,
    // v2 D18: every session (lane + orchestrator) skips permissions; the engine deny rules in --settings still win.
    '--dangerously-skip-permissions', ...(a.addDirs.length ? ['--add-dir', ...a.addDirs] : []), '--settings', a.settingsPath, '--mcp-config', a.mcpConfigPath,
    // v2.2 §5.1 / §3-1: only the session file loads (no account .claude.json, repo .mcp.json, plugin or claude.ai servers).
    '--strict-mcp-config',
    '--disallowedTools', 'AskUserQuestion', '--append-system-prompt', a.appendSystemPrompt,
    a.resume ? '--resume' : '--session-id', a.sessionId,
  ];
  if (a.agent) out.push('--agent', a.agent);
  const model = modelOverride(env) ?? a.model;
  if (model) out.push('--model', model);
  if (a.effort) out.push('--effort', a.effort);
  return out;
}

/** §7 SA2: the account's `projects/` and `plans/` links (into ~/.claude) are writable without a permission prompt; the
 *  terminal account's ARE `~/.claude`'s own (hf1116 T2), so none. */
export function accountAddDirs(account: { configDir: string; terminal?: boolean }): string[] {
  return account.terminal ? [] : [`${account.configDir}/projects`, `${account.configDir}/plans`];
}
