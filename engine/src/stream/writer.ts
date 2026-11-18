// Builders for stdin lines of `claude -p --input-format stream-json` (spec §3.3-5/6/13, §7.6).
// Every builder returns one JSON line terminated by '\n' (JSON.stringify escapes inner newlines).

const line = (o: unknown): string => `${JSON.stringify(o)}\n`;

/** v2.4 §6.4 a content block of a user message: the text, then one block per image (NC §8-6). */
export type Block =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/** User message; `uuid` is kept by Claude Code on replay (§3.3-17), never put in the text. */
export function userLine(content: string | Block[], uuid: string): string {
  return line({ type: 'user', uuid, message: { role: 'user', content } });
}

export function interruptLine(requestId: string): string {
  return line({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } });
}

/** Allow a can_use_tool request. `updatedPermissions` = the request's permission_suggestions for "allow always". */
export function allowLine(requestId: string, updatedInput: Record<string, unknown>, updatedPermissions?: unknown[]): string {
  const response: Record<string, unknown> = { behavior: 'allow', updatedInput };
  if (updatedPermissions !== undefined) response.updatedPermissions = updatedPermissions;
  return line({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
}

export function denyLine(requestId: string, message: string): string {
  return line({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message } },
  });
}
