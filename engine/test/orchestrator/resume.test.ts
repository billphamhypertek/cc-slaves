import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { insertEvent, insertLane, insertProject, insertSession, openDb, type Db } from '../../src/db.ts';
import { notifySeq } from '../../src/server/session-views.ts';
import {
  cleanupPeriodDays, contextHigh, encodeCwd, estimateFirstTurn, MIN_SAMPLES, quotaSamples, resumeFirstText, transcriptInfo,
  transcriptPath, TurnFive, type QuotaSample,
} from '../../src/orchestrator/resume.ts';

const s = (tokens: number, before: number, after: number): QuotaSample => ({ tokens, before, after });

describe('§4.14 first-turn quota estimate (pure)', () => {
  test('§4.14 < 5 samples → tokens only, no %', () => {
    const e = estimateFirstTurn(142_000, [s(10_000, 1, 2), s(10_000, 1, 2), s(10_000, 1, 2), s(10_000, 1, 2)]);
    expect(e).toEqual({ tokens: 142_000, pct: null, samples: 4 });
    expect(MIN_SAMPLES).toBe(5);
  });

  test('§4.14 ≥ 5 samples → ctx_last × median(Δfive/Δtok), rounded', () => {
    // ratios per token: 1e-4, 2e-4, 0.5e-4, 1e-4, 3e-4 → median 1e-4 → 142k × 1e-4 = 14.2 → 14
    const fixture = [s(10_000, 10, 11), s(10_000, 10, 12), s(20_000, 5, 6), s(30_000, 40, 43), s(10_000, 0, 3)];
    expect(estimateFirstTurn(142_000, fixture)).toEqual({ tokens: 142_000, pct: 14, samples: 5 });
  });

  test('§4.14 even count → median of the two middle ratios', () => {
    const fixture = [s(10_000, 0, 1), s(10_000, 0, 1), s(10_000, 0, 2), s(10_000, 0, 2), s(10_000, 0, 3), s(10_000, 0, 3)];
    expect(estimateFirstTurn(100_000, fixture)?.pct).toBe(20);
  });

  test('§4.14 samples with no tokens or a 5 h reset in between (Δ < 0) are not counted', () => {
    const fixture = [s(0, 1, 2), s(10_000, 50, 2), s(10_000, 1, 2), s(10_000, 1, 2), s(10_000, 1, 2), s(10_000, 1, 2)];
    expect(estimateFirstTurn(100_000, fixture)).toEqual({ tokens: 100_000, pct: null, samples: 4 });
  });

  test('§4.14 no ctx_last → no estimate', () => {
    expect(estimateFirstTurn(null, [s(1, 0, 1)])).toBeNull();
  });

  test('§4.14 context ≥ 80 % flag', () => {
    expect(contextHigh(160_000, 200_000)).toBe(true);
    expect(contextHigh(159_999, 200_000)).toBe(false);
    expect(contextHigh(null, 200_000)).toBe(false);
  });

  test('§4.14 first engine message of a resumed session', () => {
    expect(resumeFirstText('2 giờ', ['D7 xong', 'D9 → #3'])).toBe(
      'Phiên này được nối lại sau 2 giờ. Từ lúc dừng: D7 xong, D9 → #3. Gọi `lanes_list` trước khi ra lệnh.');
    expect(resumeFirstText('5 phút', [])).toBe('Phiên này được nối lại sau 5 phút. Từ lúc dừng: không có lane đổi. Gọi `lanes_list` trước khi ra lệnh.');
  });
});

describe('§4.14 quota samples from stored results', () => {
  let tmp: string; let db: Db;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ccs-resume-'));
    db = openDb(join(tmp, 'state.db'));
    insertProject(db, { id: 'p', name: 'P', path: tmp, orchestratorAccount: 'a@x' });
    insertSession(db, { id: 's1', projectId: 'p', kind: 'orchestrator', account: 'a@x' });
  });
  afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

  /** A stored turn: its tokens and the account's cached five_pct (+ that reading's fetch time) before / after it. */
  const turn = (account: string, tokens: number, before: [pct: number, at: number] | null, after: [pct: number, at: number] | null) =>
    insertEvent(db, { sessionId: 's1', type: 'result', json: {
      usage: { input: tokens, output: 0, cacheWrite: 0, cacheRead: 0 }, account,
      fiveBefore: before?.[0] ?? null, fiveAtBefore: before?.[1] ?? null, fiveAfter: after?.[0] ?? null, fiveAtAfter: after?.[1] ?? null,
    } });
  /** 30 s turns of 20k tok on a cached five_pct refreshed every `every` turns; true cost 1 % per 20k tok. */
  const polled = (n: number, every: number, account = 'a@x') => {
    const at = (i: number) => 1000 + Math.floor(i / every) * 300;
    const pct = (i: number) => 10 + Math.floor(i / every) * every;
    for (let i = 0; i < n; i++) turn(account, 20_000, [pct(i), at(i)], [pct(i + 1), at(i + 1)]);
  };

  test('§4.14 samples are refresh intervals: Δfive between two fetches ÷ Σ tokens of the turns in between (g3 IMPORTANT-3)', () => {
    polled(30, 5); // 6 refreshes, each +5 % over 100k tok; most turns see before == after
    const got = quotaSamples(db, 'a@x', Date.now() + 5);
    expect(got).toHaveLength(6);
    expect(got.every((x) => x.tokens === 100_000 && x.after - x.before === 5)).toBe(true);
    expect(estimateFirstTurn(142_000, got)).toEqual({ tokens: 142_000, pct: 7, samples: 6 }); // true ≈ 7 %, not ≈ 0 %
  });

  test('§4.14 a refresh that did not move five_pct still closes an interval (Δ 0), a reset (Δ < 0) is kept for the filter', () => {
    turn('a@x', 20_000, [10, 1000], [10, 1300]);
    turn('a@x', 20_000, [10, 1300], [12, 1600]);
    turn('a@x', 20_000, [12, 1600], [1, 1900]);
    expect(quotaSamples(db, 'a@x', Date.now() + 5)).toEqual([
      { tokens: 20_000, before: 10, after: 10 }, { tokens: 20_000, before: 10, after: 12 }, { tokens: 20_000, before: 12, after: 1 },
    ]);
  });

  test('§4.14 12 turns but < 5 refresh intervals → no % (tokens only)', () => {
    polled(12, 5); // the cached value moved twice in 12 turns
    const got = quotaSamples(db, 'a@x', Date.now() + 5);
    expect(got).toHaveLength(2);
    expect(estimateFirstTurn(142_000, got)).toEqual({ tokens: 142_000, pct: null, samples: 2 });
  });

  test('§4.14 only that account, only readings with a fetch time, ≤ 12 intervals, within 7 days (event ts = ms)', () => {
    polled(70, 5); // 14 intervals
    turn('b@x', 20_000, [10, 1000], [90, 1300]);
    turn('a@x', 20_000, null, null); // no reading: its tokens still count toward the open interval
    db.query('UPDATE event SET ts = ts - 8 * 86400 * 1000 WHERE id = 1').run(); // older than 7 days
    const got = quotaSamples(db, 'a@x', Date.now() + 5);
    expect(got).toHaveLength(12);
    expect(got.every((x) => x.after - x.before === 5 && x.tokens === 100_000)).toBe(true);
  });

  test('§4.14 TurnFive keeps the reading\'s fetch time; a non-ok row (rejected 100 %, needs_probe) is no reading', () => {
    let row: { fivePct: number | null; fetchedAt: number; status: string } | null = { fivePct: 12, fetchedAt: 500, status: 'ok' };
    const f = new TurnFive(() => row);
    f.start('a@x');
    row = { fivePct: 100, fetchedAt: 600, status: 'rejected' };
    expect(f.end('a@x')).toEqual({ account: 'a@x', fiveBefore: 12, fiveAtBefore: 500, fiveAfter: null, fiveAtAfter: null });
  });
});

describe('§4.15 §4 notification #n', () => {
  test('§4.15 §4 #n only when > 1 running; lane → its owner session\'s #n; orchestrator → its own', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ccs-nseq-'));
    const db = openDb(join(tmp, 'state.db'));
    insertProject(db, { id: 'p', name: 'P', path: tmp, orchestratorAccount: 'a@x' });
    for (const [id, n] of [['s3', 3], ['s4', 4]] as const) {
      insertSession(db, { id, projectId: 'p', kind: 'orchestrator', account: 'a@x' });
      db.query('UPDATE session SET seq = ? WHERE id = ?').run(n, id);
    }
    insertLane(db, { projectId: 'p', name: 'H2', cwd: join(tmp, 'wt'), ownerSession: 's4', state: 'idle' });
    expect(notifySeq(db, { kind: 'lane', projectId: 'p', name: 'H2' }, 2)).toBe(4);
    expect(notifySeq(db, { kind: 'orchestrator', projectId: 'p', sessionId: 's3' }, 2)).toBe(3);
    expect(notifySeq(db, { kind: 'lane', projectId: 'p', name: 'H2' }, 1)).toBeNull();
    db.close(); rmSync(tmp, { recursive: true, force: true });
  });
});

describe('§4.14 Claude Code transcript (jsonl) + cleanupPeriodDays', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'ccs-claude-')); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test('§4.14 path = <claude home>/projects/<cwd, non-alphanumerics → "-">/<id>.jsonl', () => {
    expect(encodeCwd('/Users/x/my.proj_1')).toBe('-Users-x-my-proj-1');
    expect(transcriptPath(home, '/a/b', 'sid')).toBe(join(home, 'projects', '-a-b', 'sid.jsonl'));
  });

  test('§4.14 cleanupPeriodDays read from the shared settings.json, default 30, bad value → 30', () => {
    expect(cleanupPeriodDays(home)).toBe(30);
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 90 }));
    expect(cleanupPeriodDays(home)).toBe(90);
    writeFileSync(join(home, 'settings.json'), '{not json');
    expect(cleanupPeriodDays(home)).toBe(30);
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ cleanupPeriodDays: -2 }));
    expect(cleanupPeriodDays(home)).toBe(30);
  });

  test('§4.14 missing jsonl → not there; present → days left from its mtime; ≤ 5 days flagged', () => {
    expect(transcriptInfo(home, '/a/b', 'sid', 1_000_000)).toEqual({ exists: false, expiresInDays: null });
    const p = transcriptPath(home, '/a/b', 'sid');
    mkdirSync(join(home, 'projects', '-a-b'), { recursive: true });
    writeFileSync(p, '{}\n');
    const now = Math.floor(Date.now() / 1000);
    utimesSync(p, now - 26 * 86400, now - 26 * 86400);
    expect(transcriptInfo(home, '/a/b', 'sid', now)).toEqual({ exists: true, expiresInDays: 4 });
    utimesSync(p, now - 2 * 86400, now - 2 * 86400);
    expect(transcriptInfo(home, '/a/b', 'sid', now)).toEqual({ exists: true, expiresInDays: null });
  });
});
