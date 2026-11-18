import { describe, expect, test } from 'bun:test';
import { allowLine, denyLine, interruptLine, userLine } from '../../src/stream/writer.ts';
import { parseLine } from '../../src/stream/parser.ts';

const parse = (l: string) => {
  expect(l.endsWith('\n')).toBe(true);
  expect(l.slice(0, -1).includes('\n')).toBe(false);
  return JSON.parse(l);
};

describe('stdin line builders', () => {
  test('§3.3-5 §7.6 user message carries uuid, content is the text verbatim', () => {
    expect(parse(userLine('[PO] dòng 1\ndòng 2', 'u-1'))).toEqual({
      type: 'user', uuid: 'u-1', message: { role: 'user', content: '[PO] dòng 1\ndòng 2' },
    });
  });

  test('§6.4 user message with blocks: one line, the text block then the image blocks as given', () => {
    const blocks = [
      { type: 'text' as const, text: '[PO] xem\n- /a.png' },
      { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'iVBORw0K' } },
    ];
    expect(parse(userLine(blocks, 'u-2'))).toEqual({ type: 'user', uuid: 'u-2', message: { role: 'user', content: blocks } });
  });

  test('§3.3-6 interrupt control_request', () => {
    expect(parse(interruptLine('i-1'))).toEqual({ type: 'control_request', request_id: 'i-1', request: { subtype: 'interrupt' } });
  });

  test('§3.3-13 allow with updatedInput; "allow always" adds updatedPermissions', () => {
    expect(parse(allowLine('r1', { file_path: '/a' }))).toEqual({ type: 'control_response', response: {
      subtype: 'success', request_id: 'r1', response: { behavior: 'allow', updatedInput: { file_path: '/a' } } } });
    const sugg = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }];
    expect(parse(allowLine('r1', {}, sugg)).response.response.updatedPermissions).toEqual(sugg);
  });

  test('§3.3-13 deny with message', () => {
    expect(parse(denyLine('r2', 'PO từ chối'))).toEqual({ type: 'control_response', response: {
      subtype: 'success', request_id: 'r2', response: { behavior: 'deny', message: 'PO từ chối' } } });
  });

  test('§3.3-13 the echo of our own allow parses back as control_response', () => {
    expect(parseLine(allowLine('r1', {}).trim())).toMatchObject({ kind: 'control_response', requestId: 'r1', behavior: 'allow' });
  });
});
