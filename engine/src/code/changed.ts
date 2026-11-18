// v2.3 §10.2 "Làm mới" (a) + (d): a session's file tool (`Edit` / `Write` / `MultiEdit` / `NotebookEdit`) or `Bash`
// finished → which files changed (absolute, from the tool input) or, for `Bash`, "any file". The tool use is seen in an
// assistant message, its end in the `tool_result` of a user message (same stream). No `fs.watch` of the tree.
import { isObj } from '../../../shared/json.ts';
import type { StreamEvent } from '../stream/parser.ts';

const FILE_KEY: Readonly<Record<string, string>> = { Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };

/** `files` absolute paths the tool named; null = `Bash` (any file of the session's dir). */
export interface ToolDone { files: string[] | null }

const blocks = (m: unknown): Record<string, unknown>[] =>
  isObj(m) && Array.isArray(m.content) ? m.content.filter((b): b is Record<string, unknown> => isObj(b)) : [];

export class ToolWatch {
  /** session → tool_use id → what it will change. */
  private readonly open = new Map<string, Map<string, ToolDone>>();

  /** Feeds one stream event of `session`; returns the tools that finished with it. */
  event(session: string, ev: StreamEvent): ToolDone[] {
    if (ev.kind === 'result') { this.open.delete(session); return []; }
    if (ev.kind !== 'assistant' && ev.kind !== 'user') return [];
    const done: ToolDone[] = [];
    for (const b of blocks(ev.message)) {
      if (ev.kind === 'assistant' && b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        const key = FILE_KEY[b.name];
        const file = key && isObj(b.input) ? b.input[key] : undefined;
        if (b.name === 'Bash') this.track(session, b.id, { files: null });
        else if (typeof file === 'string' && file !== '') this.track(session, b.id, { files: [file] });
      } else if (ev.kind === 'user' && b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        const m = this.open.get(session);
        const t = m?.get(b.tool_use_id);
        if (t) { m!.delete(b.tool_use_id); done.push(t); }
      }
    }
    return done;
  }

  private track(session: string, id: string, t: ToolDone): void {
    let m = this.open.get(session);
    if (!m) { m = new Map<string, ToolDone>(); this.open.set(session, m); }
    m.set(id, t);
  }
}
