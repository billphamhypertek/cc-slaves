// v2.4 §5.6 tier 2: a lane's agent definition, found like Claude Code finds it — by the frontmatter `name:` (not the file
// name) in `*.md` under `<lane cwd>/.claude/agents/`, then `<account configDir>/agents/` (the mirror of ~/.claude); the
// project wins. Only the frontmatter is parsed; read at each spawn, never cached. NC §8-27: Claude Code applies the agent's
// `model` but ignores its `effort` in the main session, so the engine reads both and puts them on argv.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface AgentDef { name: string; model: string | null; effort: string | null }

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The scalar fields of a `---` frontmatter block; null = no well-formed block. */
function frontmatter(text: string): Record<string, string> | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?(?:\n|$)/.exec(text);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*?)\s*$/.exec(line);
    if (kv) out[kv[1]!] = kv[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function mdFiles(dir: string): string[] {
  try {
    return (readdirSync(dir, { recursive: true, encoding: 'utf8' })).filter((f) => f.endsWith('.md')).sort().map((f) => join(dir, f));
  } catch { return []; } // no agents dir
}

/**
 * The agent called `name` in the first dir that has it; `model: inherit` / an unknown effort count as unset. Not found or
 * a broken frontmatter → null (tier 2 skipped) and one log line.
 */
export function readAgent(name: string, dirs: readonly string[], log?: (line: string) => void): AgentDef | null {
  for (const dir of dirs) {
    for (const file of mdFiles(dir)) {
      let fm: Record<string, string> | null;
      try { fm = frontmatter(readFileSync(file, 'utf8')); } catch { continue; }
      if (fm?.name !== name) continue;
      const model = fm.model && fm.model !== 'inherit' ? fm.model : null;
      const effort = fm.effort && EFFORTS.includes(fm.effort) ? fm.effort : null;
      return { name, model, effort };
    }
  }
  log?.(`agent ${name}: không thấy định nghĩa (frontmatter name:) trong ${dirs.join(', ')} — bỏ tầng agent`);
  return null;
}
