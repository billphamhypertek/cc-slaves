// Orchestrator session texts and small helpers (split from orchestrator/session.ts).
import type { KeyedReason } from '../../../../shared/protocol.ts';

/** §7.5 resume message (the outbox adds the `[cc-slaves]` prefix). */
export const resumeText = (account: string): string =>
  `Phiên được nối lại trên ${account} sau khi bị ngắt. Gọi lanes_list để cập nhật rồi tiếp tục.`;
/** F21 default handoff file, relative to the project. */
export const handoffPathFor = (date: string): string => `.local-check/handoff-${date}/orchestrator.md`;
/** §4.14 "Kết thúc phiên": the handoff file of session #n. */
export const endHandoffPathFor = (date: string, seq: number | null): string => `.local-check/handoff-${date}/orchestrator-${seq ?? 'x'}.md`;
/** F21 first message of a new orchestrator session. */
export const newSessionText = (handoff: string): string =>
  `Phiên điều phối mới. Đọc ${handoff} rồi \`lanes_list\` và tiếp tục.`;
export const handoffRequestText = (handoff: string): string =>
  `Viết handoff vào ${handoff} (việc đang dở, lane đang chạy, bước tiếp theo) rồi kết thúc lượt. Phiên này sẽ được đóng.`;
export const FIRST_TEXT = 'Bắt đầu điều phối. Gọi lanes_list rồi chờ tin PO.';
/** Automatic restarts after an abnormal death before F11 (§7.5 "một lần"). */
export const MAX_AUTO_RESTARTS = 1;

/** Tool-name prefix of our MCP server: `mcp__<key>__` where `<key>` is the `--mcp-config` server key (session/files.ts). */
export const MCP_TOOL_PREFIX = 'mcp__cc_slaves__';

/** v1.1 §5.2: the `name` argument of the last cc-slaves MCP `tool_use` in an assistant message carrying a non-empty
 *  string `name`; undefined = the message does not change `talkingTo`. */
export function talkingToOf(message: unknown): string | undefined {
  const content = (message as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return undefined;
  let found: string | undefined;
  for (const b of content as { type?: unknown; name?: unknown; input?: { name?: unknown } | null }[]) {
    if (b?.type !== 'tool_use' || typeof b.name !== 'string' || !b.name.startsWith(MCP_TOOL_PREFIX)) continue;
    const n = b.input?.name;
    if (typeof n === 'string' && n !== '') found = n;
  }
  return found;
}

export const todayIso = () => new Date().toISOString().slice(0, 10);

export const kr = (key: string, params?: Record<string, string | number>): KeyedReason => ({ key, ...(params ? { params } : {}) });
