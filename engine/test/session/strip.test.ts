// v2.4 §10.2 A5 `stripImageData`: no image byte from a stdout line reaches the run log, lane_tail or the event bus.
import { describe, expect, test } from 'bun:test';
import { stripImageData } from '../../src/session/process.ts';

const bytes = Uint8Array.from(Array.from({ length: 1000 }, (_, i) => (i * 7) % 256));
const data = Buffer.from(bytes).toString('base64');
const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data } };

describe('stripImageData (v2.4 §10.2 A5)', () => {
  test('§10.2 a replayed user line: every image data → "<lược n byte>" (n = decoded bytes), the rest kept', () => {
    const line = JSON.stringify({ type: 'user', uuid: 'u', isReplay: true, message: { role: 'user', content: [{ type: 'text', text: 'xem' }, img, img] } });
    const out = JSON.parse(stripImageData(line));
    expect(out.message.content.map((b: { source?: { data: string } }) => b.source?.data)).toEqual([undefined, '<lược 1000 byte>', '<lược 1000 byte>']);
    expect(out.message.content[1].source.media_type).toBe('image/png');
    expect(out.uuid).toBe('u');
  });

  test('§10.2 an image inside a tool_result is stripped too; padding counts (998 / 999 bytes)', () => {
    const pad = (n: number) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(bytes.subarray(0, n)).toString('base64') } });
    const line = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: [pad(998), pad(999)] }] } });
    expect(stripImageData(line)).not.toContain(data.slice(0, 100));
    expect(JSON.parse(stripImageData(line)).message.content[0].content.map((b: { source: { data: string } }) => b.source.data))
      .toEqual(['<lược 998 byte>', '<lược 999 byte>']);
  });

  test('§10.2 a line without an image block is returned as is (same string)', () => {
    const line = '{"type":"assistant","message":{"content":[{"type":"text","text":"an \\"image\\" word"}]}}';
    expect(stripImageData(line)).toBe(line);
    expect(stripImageData('not json "image"')).toBe('not json "image"');
  });
});
