// v2.9 §10.1 the skill block of one session, from the step it is pinned to (§6.1): the `permissions.deny` backstop
// (`Skill(<full name>)`) and the PreToolUse `Skill` hook that gives the model the reason (v2.7 R-B5, measured G0-1). The hook
// is a POSIX sh script written at every boot (R-B9); it looks the skill up in the session's `<home>/skill-deny/<id>.tsv`
// (`<skill>\t<hook JSON>` lines, escaped by compile.ts) and prints that JSON — no `jq`, a reason with `"` / `\` stays valid
// JSON (review r1 I10). §5.8 the plugins a workflow requires.
import { chmodSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { paths, writeFileSecure } from '../paths.ts';
import type { CompiledStep } from '../workflow/compile.ts';
import { shq } from './env.ts';

/** R-B9 `<engineHome>/hooks/skill-gate.sh`. */
export const skillGatePath = (): string => join(paths().home, 'hooks', 'skill-gate.sh');
/** §10.1 the session's blocked skills (removed with its other files). */
export const skillDenyPath = (sessionId: string): string => join(paths().home, 'skill-deny', `${sessionId}.tsv`);

/** The `--settings` fragment of one session: the step's deny rules + the hook with the session's `.tsv` as its only argument
 * (paths quoted: review-B MINOR-2, a home with a space). */
export function skillSettings(sessionId: string, step: Pick<CompiledStep, 'deny'>): { deny: string[]; hooks: Record<string, unknown> } {
  return {
    deny: [...step.deny],
    hooks: { PreToolUse: [{ matcher: 'Skill', hooks: [{ type: 'command', command: `${shq(skillGatePath())} ${shq(skillDenyPath(sessionId))}` }] }] },
  };
}

/** §10.1 the session's `.tsv` (0600), written with its settings at every spawn. */
export function writeSkillDeny(sessionId: string, step: Pick<CompiledStep, 'gate'>): void {
  writeFileSecure(skillDenyPath(sessionId), step.gate);
}
export const removeSkillDeny = (sessionId: string): void => { rmSync(skillDenyPath(sessionId), { force: true }); };

/** R-B9 the script: reads the hook stdin, takes `tool_input.skill`, prints the JSON of its `.tsv` line, else nothing. */
function gateScript(): string {
  return `#!/bin/sh
# cc-slaves v2.9 §10.1 skill gate — written by the engine at every boot; edits are overwritten.
file="$1"
[ -f "$file" ] || exit 0
skill=$(tr -d '\\n' | sed -n 's/.*"skill"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')
[ -n "$skill" ] || exit 0
tab=$(printf '\\t')
while IFS="$tab" read -r name json; do
  if [ "$name" = "$skill" ]; then printf '%s\\n' "$json"; exit 0; fi
done < "$file"
exit 0
`;
}

/** R-B9 at engine boot: (re)write the hook script, mode 0700. */
export function writeSkillGate(): void {
  const p = skillGatePath();
  writeFileSecure(p, gateScript());
  chmodSync(p, 0o700);
}

/** The `enabledPlugins` of the claude settings: a missing file = none on, null = unknown (unreadable / not JSON). */
function enabledPlugins(settingsPath: string): Record<string, unknown> | null {
  let text: string;
  try { text = readFileSync(settingsPath, 'utf8'); } catch (e) { return (e as { code?: string }).code === 'ENOENT' ? {} : null; }
  try { return (JSON.parse(text) as { enabledPlugins?: Record<string, unknown> } | null)?.enabledPlugins ?? {}; } catch { return null; }
}
const firstOff = (plugins: readonly string[], off: { plugins: readonly string[] }, on: Record<string, unknown>): string | null =>
  plugins.find((p) => !Object.entries(on).some(([k, v]) => k.startsWith(`${p}@`) && v === true && !off.plugins.includes(k))) ?? null;

/**
 * §5.8 the first of `plugins` not in effect for a lane (null = all are): `enabledPlugins` has a `<plugin>@…` key = true in
 * the claude settings the sessions use (`<claudeHome>/settings.json`) and that key is not in the project's lane plugin-off
 * list (v2.2 §5.5). Unreadable settings: none is on.
 */
export function missingPlugin(plugins: readonly string[], off: { plugins: readonly string[] }, settingsPath = join(paths().claudeHome, 'settings.json')): string | null {
  if (plugins.length === 0) return null;
  return firstOff(plugins, off, enabledPlugins(settingsPath) ?? {});
}

/** hf-sp `missingPlugin` for a project being added: undefined = the plugin state is unknown (settings unreadable / not JSON). */
export function missingPluginKnown(plugins: readonly string[], off: { plugins: readonly string[] }, settingsPath = join(paths().claudeHome, 'settings.json')): string | null | undefined {
  if (plugins.length === 0) return null;
  const on = enabledPlugins(settingsPath);
  return on === null ? undefined : firstOff(plugins, off, on);
}
