// v2.4 §6.6 the one `/` matcher, shared by web (composer) and engine (`send` with `raw`). Call it on the text after the
// `@lane …` split. The whole first token counts (`^/(\S+)`, case-insensitive): `/new-feature` is a skill, not `/new`.

/** Commands cc-slaves answers itself (v1 M9 + §6.6 `/model`, `/effort`); they never reach Claude Code. */
const OWN = ['lanes', 'quota', 'stop', 'handoff', 'new', 'model', 'effort'] as const;
/** Y34: never sent — `/clear` drops the session id (NC §8-18); accounts are the engine's (v2 §5). */
const BLOCKED = ['clear', 'login', 'logout'] as const;

type OwnSlash = (typeof OWN)[number];
type BlockedSlash = (typeof BLOCKED)[number];
export type SlashMatch =
  | { kind: 'own'; cmd: OwnSlash; args: string }
  | { kind: 'blocked'; cmd: BlockedSlash }
  /** a skill, a built-in Claude Code command or an MCP prompt: sent as is, without the `[PO]` prefix. */
  | { kind: 'pass'; name: string };

const has = <T extends string>(list: readonly T[], v: string): v is T => (list as readonly string[]).includes(v);

/** null = the text does not start with a `/` command. */
export function matchSlash(text: string): SlashMatch | null {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim());
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  if (has(OWN, name)) return { kind: 'own', cmd: name, args: m[2]!.trim() };
  if (has(BLOCKED, name)) return { kind: 'blocked', cmd: name };
  return { kind: 'pass', name: m[1]! };
}
