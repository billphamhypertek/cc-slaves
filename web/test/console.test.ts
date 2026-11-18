import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { appendLive, emptyBuffer, macOnlyLocal, MAX_LINES, prependHistory, parseInput, resyncTail } from '../src/lib/console.ts';
import type { StreamLine } from '../../shared/protocol.ts';
import { makeT } from '../../shared/i18n/index.ts';
const VI = makeT('vi');

const lines = (from: number, to: number): StreamLine[] =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ seq: from + i, ts: from + i, kind: 'assistant' as const, text: 't' + (from + i) }));

describe('§8.4 console buffer ≤ 500 lines per stream', () => {
  test('live append keeps the newest 500', () => {
    let b = emptyBuffer();
    b = appendLive(b, lines(1, 400));
    b = appendLive(b, lines(401, 650));
    expect(b.lines).toHaveLength(MAX_LINES);
    expect(b.lines[0]!.seq).toBe(151);
    expect(b.lines.at(-1)!.seq).toBe(650);
  });

  test('duplicate seq is ignored and order kept by seq', () => {
    let b = appendLive(emptyBuffer(), lines(1, 3));
    b = appendLive(b, [...lines(3, 4), ...lines(2, 2)]);
    expect(b.lines.map(l => l.seq)).toEqual([1, 2, 3, 4]);
  });

  test('history paging prepends older lines and keeps the oldest 500 (detaches from live tail)', () => {
    let b = appendLive(emptyBuffer(), lines(301, 700));
    b = prependHistory(b, lines(101, 300), true);
    expect(b.lines).toHaveLength(MAX_LINES);
    expect(b.lines[0]!.seq).toBe(101);
    expect(b.lines.at(-1)!.seq).toBe(600);
    expect(b.atTail).toBe(false);
    expect(b.hasOlder).toBe(true);
    // live lines while detached are not kept, only flagged
    b = appendLive(b, lines(701, 702));
    expect(b.lines.at(-1)!.seq).toBe(600);
    expect(b.newer).toBe(true);
  });

  test('history page under the cap stays at tail; empty page means no older', () => {
    let b = appendLive(emptyBuffer(), lines(51, 60));
    b = prependHistory(b, lines(1, 50), false);
    expect(b.lines).toHaveLength(60);
    expect(b.atTail).toBe(true);
    expect(b.hasOlder).toBe(false);
  });
});

describe('§6.3 console input: @lane retarget and / commands', () => {
  const lanes = ['D2', 'D15'];
  test('plain text goes to the current target', () => {
    expect(parseInput(VI, 'chạy tiếp', lanes)).toEqual({ kind: 'send', text: 'chạy tiếp' });
  });
  test('@D2 text retargets to lane D2 (case-insensitive) and strips the mention', () => {
    expect(parseInput(VI, '@d2 nhớ tách migration', lanes)).toEqual({ kind: 'send', lane: 'D2', text: 'nhớ tách migration' });
  });
  test('@unknown lane is sent as plain text', () => {
    expect(parseInput(VI, '@D9 hi', lanes)).toEqual({ kind: 'send', text: '@D9 hi' });
  });
  test('/lanes /quota /handoff /new are handled locally', () => {
    expect(parseInput(VI, '/lanes', lanes)).toEqual({ kind: 'local', cmd: 'lanes' });
    expect(parseInput(VI, '/quota', lanes)).toEqual({ kind: 'local', cmd: 'quota' });
    expect(parseInput(VI, '/handoff', lanes)).toEqual({ kind: 'local', cmd: 'handoff' });
    expect(parseInput(VI, '/new', lanes)).toEqual({ kind: 'local', cmd: 'new' });
  });
  test('/stop D2 → stop lane; /stop without a known lane is an error', () => {
    expect(parseInput(VI, '/stop d2', lanes)).toEqual({ kind: 'local', cmd: 'stop', lane: 'D2' });
    expect(parseInput(VI, '/stop', lanes)).toEqual({ kind: 'error', text: 'Gõ /stop <lane>, ví dụ /stop D2' });
  });
  test('other / commands pass through to Claude Code of the target', () => {
    expect(parseInput(VI, '/compact', lanes)).toEqual({ kind: 'send', text: '/compact', raw: true });
  });
  test('v2.4 §6.6 the whole first token is matched (shared/slash.ts): /new-feature, /lanes-x are skills, not /new, /lanes', () => {
    expect(parseInput(VI, '/new-feature login', lanes)).toEqual({ kind: 'send', text: '/new-feature login', raw: true });
    expect(parseInput(VI, '/lanes-x', lanes)).toEqual({ kind: 'send', text: '/lanes-x', raw: true });
    expect(parseInput(VI, '/NEW', lanes)).toEqual({ kind: 'local', cmd: 'new' });
  });
  test('blank input does nothing', () => {
    expect(parseInput(VI, '   ', lanes)).toEqual({ kind: 'none' });
  });
});

describe('§6.3 I6 re-watch resync: lines missed while looking elsewhere / offline are loaded', () => {
  const seqs = (b: { lines: StreamLine[] }) => b.lines.map(l => l.seq);
  test('switch back: the latest page overlaps the buffer → merged, no gap', () => {
    const b = appendLive(emptyBuffer(), lines(1, 3));
    const r = resyncTail(b, lines(1, 6), 200);
    expect(seqs(r)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(seqs(appendLive(r, lines(7, 7)))).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  test('more than one page missed: the old buffer is dropped (no hole), live lines newer than the page are kept', () => {
    const b = appendLive(emptyBuffer(), [...lines(1, 3), ...lines(600, 600)]); // 600 arrived after the re-watch
    const r = resyncTail(appendLive(emptyBuffer(), lines(1, 3)), lines(300, 499), 200);
    expect(seqs(r)).toEqual(lines(300, 499).map(l => l.seq));
    expect(r.hasOlder).toBe(true);
    const r2 = resyncTail(b, lines(300, 499), 200);
    expect(seqs(r2).at(-1)).toBe(600);
    expect(seqs(r2)[0]).toBe(300);
  });
  test('empty buffer behaves like the first history page', () => {
    const r = resyncTail(emptyBuffer(), lines(1, 5), 200);
    expect(r).toEqual(prependHistory(emptyBuffer(), lines(1, 5), false));
  });
  test('scrolled up (detached): kept as is, flagged newer', () => {
    const b = prependHistory(appendLive(emptyBuffer(), lines(11, 510)), lines(1, 10), true); // 510 > cap → detached
    expect(b.atTail).toBe(false);
    const r = resyncTail(b, lines(500, 520), 200);
    expect(r.lines).toBe(b.lines);
    expect(r.newer).toBe(true);
  });
  test('contiguity is not assumed: a full page starting after the buffer replaces it (older pages reload on scroll)', () => {
    const r = resyncTail(appendLive(emptyBuffer(), lines(1, 3)), lines(4, 203), 200);
    expect(seqs(r)[0]).toBe(4);
    expect(r.hasOlder).toBe(true);
  });
  test('overlap merge keeps the newest 500', () => {
    const b = appendLive(emptyBuffer(), lines(1, 450));
    const r = resyncTail(b, lines(300, 499).concat(lines(500, 520)), 1000);
    expect(r.lines).toHaveLength(MAX_LINES);
    expect(seqs(r).at(-1)).toBe(520);
  });
});

import { boundaryText, resumedTail } from '../src/lib/console.ts';
import { fmtDayHm } from '../src/lib/format.ts';
describe('§4.14 m-5 the resume divider and a resumed session\'s first lines', () => {
  const at = new Date(2026, 10, 15, 15, 20).getTime();
  const res = (mode: 'parallel' | 'replace', replaced: number | null = null): StreamLine =>
    ({ seq: 3, ts: at, kind: 'engine', text: 'vi', boundary: { type: 'resume', seq: 2, at, account: 'acc33@x-io.test', mode, replaced } });
  test('§4.14 divider reads "Chạy tiếp <time> · <acc> · song song" / "· thay #m" (mockup N5-h), en too', () => {
    const vi = makeT('vi'), en = makeT('en'), when = fmtDayHm(at, vi);
    expect(boundaryText(vi, res('parallel'))).toBe(`Chạy tiếp ${when} · acc33@ · song song`);
    expect(boundaryText(vi, res('replace', 3))).toBe(`Chạy tiếp ${when} · acc33@ · thay #3`);
    expect(boundaryText(en, res('parallel'))).toBe(`Resumed ${fmtDayHm(at, en)} · acc33@ · parallel`);
  });
  test('§4.14 a starting resumed session shows only its resume divider and what came after (never the old rows as new output)', () => {
    const old: StreamLine = { seq: 1, ts: at, kind: 'assistant', text: 'D7 xong phần parser' };
    const first: StreamLine = { seq: 4, ts: at, kind: 'engine', text: '[cc-slaves] Phiên này được nối lại sau 2 ngày.' };
    expect(resumedTail([old, res('parallel'), first])?.map(l => l.seq)).toEqual([3, 4]);
    expect(resumedTail([old])).toBeNull();
  });
});

describe('§8 local / commands the remote channel cannot run', () => {
  test('MINOR-1 /model (picker) is Mac only; /handoff and /new follow the remote filter; /lanes /quota /stop run anywhere', () => {
    expect(macOnlyLocal('model', 'remote')).toBe(true);
    expect(macOnlyLocal('model', 'mac')).toBe(false);
    expect(macOnlyLocal('handoff', 'remote')).toBe(true);
    expect(macOnlyLocal('new', 'remote')).toBe(true);
    for (const c of ['lanes', 'quota', 'stop'] as const) expect(macOnlyLocal(c, 'remote')).toBe(false);
    for (const c of ['model', 'handoff', 'new', 'lanes'] as const) expect(macOnlyLocal(c, 'mac')).toBe(false);
  });
  test('MINOR-1 the composer refuses a Mac-only local command with console.macOnly; the picker renders on the Mac channel only (source pins)', () => {
    const src = readFileSync(new URL('../src/ui/Inspector.tsx', import.meta.url), 'utf8');
    expect(src).toMatch(/else if \(macOnlyLocal\(r\.cmd, p\.snap\.channel\)\) return p\.onError\(tr\('console\.macOnly'\)\);/);
    expect(src).toMatch(/\{mm && mac \? <Picker /); // §4.5 Điều phối or the selected lane
  });
});
