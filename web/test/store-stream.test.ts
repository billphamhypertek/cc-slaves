// spec v2.2 §14.5 "Nối" + "Nhịp" + "Đổi sang dòng đầy đủ tại chỗ" (store side) and §14.4 last bullet (protocol mismatch).
import { describe, expect, test } from 'bun:test';
import { PROTOCOL_VERSION, type EngineEvent, type StreamLine } from '../../shared/protocol.ts';
import type { RevealClock } from '../src/lib/stream-reveal.ts';
import { blocksOf } from '../src/lib/partials.ts';
import { Store, targetKey } from '../src/lib/store.ts';
import { snapshot } from './fixtures.ts';

const d2 = { kind: 'lane', projectId: 'p1', name: 'D2' } as const;
const tk = targetKey(d2);
const ev = (event: EngineEvent) => ({ type: 'event' as const, event });
const delta = (key: string, text: string, parent: string | null = null) => ev({ type: 'partial', target: d2, key, parent, delta: text });
const line = (seq: number, over: Partial<StreamLine> = {}): StreamLine => ({ seq, ts: seq, kind: 'assistant', text: 'x', ...over });
const lines = (...ls: StreamLine[]) => ev({ type: 'stream', target: d2, lines: ls });

function fakeClock(): RevealClock & { tick(ms?: number): void; pending(): number; calls: number } {
  let t = 0, id = 0; const q = new Map<number, () => void>();
  const c = {
    calls: 0,
    now: () => t,
    raf: (cb: () => void) => { c.calls++; q.set(++id, cb); return id; },
    caf: (i: number) => { q.delete(i); },
    tick(ms = 1000 / 60) { t += ms; const cbs = [...q.values()]; q.clear(); for (const cb of cbs) cb(); },
    pending: () => q.size,
  };
  return c;
}
const paced = (reducedOS = false) => {
  const clock = fakeClock(), s = new Store(() => 0, null, { clock });
  s.setReducedOS(reducedOS);
  s.apply({ type: 'snapshot', snapshot: snapshot() });
  return { s, clock };
};

describe('§14.5 Nối: partials[target][key]', () => {
  test('§14.5 delta appends by key; two keys stream side by side', () => {
    const s = new Store(() => 0, null);
    s.apply({ type: 'snapshot', snapshot: snapshot() });
    s.apply(delta('m:0', 'Đa')); s.apply(delta('m:1', 'Một')); s.apply(delta('m:0', 'ng '));
    const b = s.get().partials[tk]!;
    expect(b['m:0']!.text).toBe('Đang ');
    expect(b['m:1']!.text).toBe('Một');
    s.apply(ev({ type: 'partial', target: d2, key: 'm:0', parent: null, full: 'Đang chạy' }));
    expect(s.get().partials[tk]!['m:0']!.text).toBe('Đang chạy'); // full (mid-stream watch) replaces
  });

  test('§14.5 sub text (parent ≠ null) only in that sub\'s surface, never the lane\'s', () => {
    const s = new Store(() => 0, null);
    s.apply(delta('m:0', 'lane nói')); s.apply(delta('s:0', 'sub nói', 'toolu_1'));
    const all = s.get().partials[tk];
    expect(blocksOf(all, null).map(([k]) => k)).toEqual(['m:0']);
    expect(blocksOf(all, 'toolu_1').map(([k]) => k)).toEqual(['s:0']);
  });

  test('§14.5 the full line with the same key replaces the block in ONE set (never both, never neither)', () => {
    const { s, clock } = paced();
    const off = s.show(tk, null);
    const seen: string[] = [];
    s.subscribe(() => {
      const st = s.get(), has = !!st.partials[tk]?.['m:0'], done = (st.streams[tk]?.lines ?? []).some(l => l.key === 'm:0');
      seen.push(has && done ? 'both' : has ? 'block' : done ? 'line' : 'neither');
    });
    s.apply(delta('m:0', 'chữ '.repeat(150)));
    s.apply(lines(line(7, { key: 'm:0', text: 'chữ '.repeat(150) }), line(8, { kind: 'tool_use', tool: 'Read', text: 'Read: /a' })));
    expect(s.get().streams[tk]?.lines ?? []).toEqual([]); // the tool line waits behind the held text line
    for (let i = 0; i < 30; i++) clock.tick();
    expect(seen).not.toContain('both');
    expect(seen).not.toContain('neither');
    expect(seen.at(-1)).toBe('line');
    expect(s.get().streams[tk]!.lines.map(l => l.seq)).toEqual([7, 8]);
    expect(s.get().partials[tk]!['m:0']).toBeUndefined();
    off();
  });

  test('§14.5 a block already fully shown swaps at once when its line arrives', () => {
    const s = new Store(() => 0, null);
    s.apply(delta('m:0', 'xong'));
    s.apply(lines(line(3, { key: 'm:0', text: 'xong' })));
    expect(s.get().partials[tk]!['m:0']).toBeUndefined();
    expect(s.get().streams[tk]!.lines.map(l => l.seq)).toEqual([3]);
  });

  test('§14.5 a held line only holds lines of its own surface; the sub\'s lines go on', () => {
    const { s } = paced();
    s.show(tk, null);
    s.apply(delta('m:0', 'a'.repeat(500)));
    s.apply(lines(line(5, { key: 'm:0' }), line(6, { kind: 'tool_use', parentToolUseId: 'toolu_1', text: 'Read: /b' })));
    expect(s.get().streams[tk]!.lines.map(l => l.seq)).toEqual([6]);
  });

  test('§14.4 a line without key (ledger lost) drops the open blocks of its surface, like v2.1', () => {
    const s = new Store(() => 0, null);
    s.apply(delta('m:0', 'dở')); s.apply(delta('s:0', 'sub', 'toolu_1'));
    s.apply(lines(line(4, { text: 'Đang chạy' })));
    expect(Object.keys(s.get().partials[tk]!)).toEqual(['s:0']);
  });

  test('§14.5 an ended block that never got its line (interrupt / process died) is dropped by the next keyed text line of its surface', () => {
    const s = new Store(() => 0, null);
    s.apply({ type: 'snapshot', snapshot: snapshot() });
    s.apply(delta('m1:0', 'chữ bị cắt')); s.apply(ev({ type: 'partial_end', target: d2, key: 'm1:0' }));
    s.apply(lines(line(10, { kind: 'po', text: 'tiếp' })));
    expect(Object.keys(s.get().partials[tk]!)).toEqual(['m1:0']); // still shown until the next answer
    s.apply(delta('m2:0', 'mới')); s.apply(delta('s:0', 'sub', 'toolu_1')); s.apply(ev({ type: 'partial_end', target: d2, key: 's:0' }));
    s.apply(lines(line(11, { key: 'm2:0', text: 'mới' })));
    expect(Object.keys(s.get().partials[tk]!)).toEqual(['s:0']); // another surface's block stays
    expect(s.get().streams[tk]!.lines.map(l => l.seq)).toEqual([10, 11]);
  });
  test('§14.5 a block of the same message waiting for its line is not an orphan (m:0 ended, line of m:1 first)', () => {
    const s = new Store(() => 0, null);
    s.apply({ type: 'snapshot', snapshot: snapshot() });
    s.apply(delta('m:0', 'a')); s.apply(ev({ type: 'partial_end', target: d2, key: 'm:0' }));
    s.apply(lines(line(5, { key: 'm:1', text: 'b' })));
    expect(Object.keys(s.get().partials[tk]!)).toEqual(['m:0']);
  });
  test('§14.5 a block remembers the last line seq it arrived after (orders an orphan by arrival)', () => {
    const s = new Store(() => 0, null);
    s.apply({ type: 'snapshot', snapshot: snapshot() });
    s.apply(lines(line(7, { kind: 'po', text: 'hi' })));
    s.apply(delta('m:0', 'a'));
    expect(s.get().partials[tk]!['m:0']!.at).toBe(7);
  });
});

describe('§14.5 Nhịp: one rAF loop for shown surfaces', () => {
  test('§14.5 a surface not on screen: no pacing, no rAF, text kept whole', () => {
    const { s, clock } = paced();
    s.apply(delta('m:0', 'x'.repeat(600)));
    expect(clock.calls).toBe(0);
    expect(s.get().partials[tk]!['m:0']!.shown).toBe(600);
  });

  test('§14.5 a shown surface drains 600 chars in ≤ 16 frames, shown only grows', () => {
    const { s, clock } = paced();
    s.show(tk, null);
    s.apply(delta('m:0', 'chữ '.repeat(150)));
    let last = 0, frames = 0;
    while (s.get().partials[tk]!['m:0']!.shown < 600 && frames < 40) {
      clock.tick(); frames++;
      const n = s.get().partials[tk]!['m:0']!.shown;
      expect(n).toBeGreaterThanOrEqual(last); last = n;
    }
    expect(frames).toBeLessThanOrEqual(16);
  });

  test('§14.5 shown again: text already on screen stays, only later text is paced', () => {
    const { s, clock } = paced();
    s.apply(delta('m:0', 'đã có '));
    const off = s.show(tk, null);
    s.apply(delta('m:0', 'y'.repeat(300)));
    expect(s.get().partials[tk]!['m:0']!.shown).toBe(6);
    clock.tick();
    expect(s.get().partials[tk]!['m:0']!.shown).toBeGreaterThan(6);
    for (let i = 0; i < 20; i++) clock.tick();
    expect(s.get().partials[tk]!['m:0']!.shown).toBe(306); // the seeded part counts: the whole text drains
    off();
  });

  test('§14.5 reduced motion (config or macOS) shows all that arrived on the next frame', () => {
    for (const [cfg, os] of [[true, false], [false, true]] as const) {
      const { s, clock } = paced(os);
      s.apply({ type: 'snapshot', snapshot: snapshot({ config: { ...snapshot().config, reducedMotion: cfg } }) });
      s.show(tk, null);
      s.apply(delta('m:0', 'z'.repeat(900)));
      clock.tick();
      expect(s.get().partials[tk]!['m:0']!.shown).toBe(900);
    }
  });

  test('§14.5 coding-standard §4: the store never reads the OS itself — paced until the shell says "reduced", then all at once', () => {
    const { s, clock } = paced();
    s.show(tk, null);
    s.apply(delta('m:0', 'z'.repeat(900)));
    clock.tick();
    expect(s.get().partials[tk]!['m:0']!.shown).toBeLessThan(900);
    s.setReducedOS(true);
    clock.tick();
    expect(s.get().partials[tk]!['m:0']!.shown).toBe(900);
  });

  test('§14.5 hidden tab: the loop stops (no rAF); back → the whole backlog in one push', () => {
    const { s, clock } = paced();
    s.show(tk, null);
    s.setTabHidden(true);
    s.apply(delta('m:0', 'w'.repeat(400)));
    expect(clock.pending()).toBe(0);
    s.setTabHidden(false);
    expect(s.get().partials[tk]!['m:0']!.shown).toBe(400);
  });
});

describe('§14.5 / §14.4 watch, thinking, Ẩn công cụ, protocol', () => {
  test('§14.4 a (re)watch: blocks not re-sent as `full` before the newest page are dropped; keys in the page too', () => {
    const s = new Store(() => 0, null);
    s.apply(delta('m:0', 'cũ')); s.apply(delta('m:1', 'đang mở')); s.apply(delta('m:2', 'đã xong'));
    s.watching(d2);
    s.apply(ev({ type: 'partial', target: d2, key: 'm:1', parent: null, full: 'đang mở tiếp' }));
    s.resync(d2, [line(9, { key: 'm:2', text: 'đã xong' })], 100);
    expect(Object.keys(s.get().partials[tk]!)).toEqual(['m:1']);
  });

  test('§14.5 S7 thinking on / off per surface; each keeps when it started (F-M9 "Đang nghĩ… n s")', () => {
    let t = 1_000;
    const s = new Store(() => t, null);
    s.apply(ev({ type: 'thinking', target: d2, parent: null, on: true }));
    t = 2_000;
    s.apply(ev({ type: 'thinking', target: d2, parent: 'toolu_1', on: true }));
    s.apply(ev({ type: 'thinking', target: d2, parent: null, on: true })); // a repeated "on" keeps the first start
    s.apply(ev({ type: 'thinking', target: d2, parent: 'toolu_1', on: false }));
    expect(s.get().thinking[tk]).toEqual({ '': 1_000 });
  });

  test('§14.5 S11 "Ẩn công cụ" is remembered on this machine', () => {
    const mem = new Map<string, string>();
    const keys = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
    const a = new Store(() => 0, keys);
    expect(a.get().hideTools).toBe(false);
    a.setHideTools(true);
    expect(new Store(() => 0, keys).get().hideTools).toBe(true);
  });

  test('§14.4 an engine on another protocol: reload band, `partial` ignored', () => {
    const s = new Store(() => 0, null);
    const snap = snapshot();
    s.apply({ type: 'snapshot', snapshot: { ...snap, engine: { ...snap.engine, protocol: PROTOCOL_VERSION + 1 } } });
    expect(s.get().protocolMismatch).toBe(true);
    s.apply(delta('m:0', 'lạ'));
    expect(s.get().partials[tk]).toBeUndefined();
    s.apply({ type: 'snapshot', snapshot: snap });
    expect(s.get().protocolMismatch).toBe(false);
  });
});
