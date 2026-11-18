// spec v2.7 §5.2-10 / §4.9 IS17 (candidate prior sessions for "Tiếp tục build"), §16 (> 400 turns → Build mới by default),
// §13 "tìm phiên ứng viên trên thư mục projects giả (14 ngày, tối đa 5, worktree), đang chạy ở nơi khác". Synthetic fixtures.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findPriorSessions } from '../../src/specs/prior-sessions.ts';

const NOW = Date.parse('2026-11-17T10:00:00Z');
const DAY = 86_400_000;
const ROOT = '/Users/u/p/proj';
const WT = '/Users/u/p/proj-wt1';
const SPEC = 'docs/specs/2026-11-01-x-design.md';
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'ccs-prior-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

const slug = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-');
const user = (text: string | { type: string; text?: string }[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', cwd: extra.cwd ?? ROOT, sessionId: 'x', message: { role: 'user', content: text }, ...extra });
const asst = (text: string) => JSON.stringify({ type: 'assistant', cwd: ROOT, message: { role: 'assistant', content: [{ type: 'text', text }] } });

function session(dir: string, id: string, lines: string[], ageMs: number): void {
  const d = join(home, 'projects', dir);
  mkdirSync(d, { recursive: true });
  const p = join(d, `${id}.jsonl`);
  writeFileSync(p, lines.join('\n') + '\n');
  const t = (NOW - ageMs) / 1000;
  utimesSync(p, t, t);
}
const mention = (cwd = ROOT) => [user('Build spec 2026-11-01-x-design.md giúp anh', { cwd }), asst('ok'), user('tiếp đi')];
type FindOpts = { ps?: () => Promise<readonly string[]>; worktrees?: string[]; configDirs?: string[]; alive?: (pid: number) => boolean; exclude?: string[] };
const find = (o: FindOpts = {}) => findPriorSessions({
  claudeHome: home, projectRoot: ROOT, worktrees: o.worktrees ?? [WT], specFile: SPEC, now: NOW, ps: o.ps ?? (async () => []),
  configDirs: o.configDirs ?? [home], alive: o.alive ?? (() => false), exclude: new Set(o.exclude ?? []),
});
function liveFile(dir: string, pid: number, sessionId: string): void {
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  writeFileSync(join(dir, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, kind: 'interactive', status: 'busy', cwd: ROOT }));
}

describe('§5.2-10 findPriorSessions', () => {
  test('§5.2-10 a session whose user message names the spec file → id, first text, last time, turns, cwd', async () => {
    session(slug(ROOT), 's1', [JSON.stringify({ type: 'queue-operation', sessionId: 's1' }), ...mention()], DAY);
    expect(await find()).toEqual([{ id: 's1', firstText: 'Build spec 2026-11-01-x-design.md giúp anh', lastAt: NOW - DAY, turns: 2, cwd: ROOT, runningElsewhere: false, long: false, model: null, effort: null }]);
  });

  test('v2.7.1 SA6b model / effort = the latest main-thread assistant line (sidechain and "<synthetic>" skipped); none → null', async () => {
    const a = (model: string, effort: string | null, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ type: 'assistant', cwd: ROOT, ...(effort ? { effort } : {}), message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }] }, ...extra });
    session(slug(ROOT), 's1', [...mention(), a('claude-sonnet-5-5', 'low'), a('claude-opus-5-5', 'high'), a('claude-haiku-5', 'max', { isSidechain: true }), a('<synthetic>', null)], DAY);
    expect(await find()).toMatchObject([{ id: 's1', model: 'claude-opus-5-5', effort: 'high' }]);
  });

  test('§5.2-10 the spec name only in an assistant message / tool result / sidechain / meta does not count', async () => {
    session(slug(ROOT), 'a', [user('hi'), asst('đọc 2026-11-01-x-design.md')], DAY);
    session(slug(ROOT), 'b', [user([{ type: 'tool_result', text: '2026-11-01-x-design.md' }])], DAY);
    session(slug(ROOT), 'c', [user('2026-11-01-x-design.md', { isSidechain: true })], DAY);
    session(slug(ROOT), 'd', [user('2026-11-01-x-design.md', { isMeta: true })], DAY);
    expect(await find()).toEqual([]);
  });

  test('§5.2-10 array content: text parts count; turns = user text messages only', async () => {
    session(slug(ROOT), 's', [user([{ type: 'text', text: 'xem docs/specs/2026-11-01-x-design.md' }]), user([{ type: 'tool_result' }]), user('ok')], DAY);
    const [s] = await find();
    expect(s?.turns).toBe(2);
    expect(s?.firstText).toBe('xem docs/specs/2026-11-01-x-design.md');
  });

  test('§5.2-10 older than 14 days → not listed', async () => {
    session(slug(ROOT), 'old', mention(), 14 * DAY + 1000);
    session(slug(ROOT), 'edge', mention(), 14 * DAY - 1000);
    expect((await find()).map((s) => s.id)).toEqual(['edge']);
  });

  test('§5.2-10 at most 5, newest first', async () => {
    for (let i = 0; i < 7; i++) session(slug(ROOT), `s${i}`, mention(), (i + 1) * DAY);
    expect((await find()).map((s) => s.id)).toEqual(['s0', 's1', 's2', 's3', 's4']);
  });

  test('§5.2-10 / R-B8 session ids cc-slaves owns are dropped before the cap: 7 − 2 owned → still 5', async () => {
    for (let i = 0; i < 7; i++) session(slug(ROOT), `s${i}`, mention(), (i + 1) * DAY);
    expect((await find({ exclude: ['s0', 's1'] })).map((s) => s.id)).toEqual(['s2', 's3', 's4', 's5', 's6']);
  });

  test('§5.2-10 an unreadable transcript is skipped, the others still listed', async () => {
    session(slug(ROOT), 'locked', mention(), DAY);
    session(slug(ROOT), 'ok', mention(), 2 * DAY);
    chmodSync(join(home, 'projects', slug(ROOT), 'locked.jsonl'), 0);
    expect((await find()).map((s) => s.id)).toEqual(['ok']);
  });

  test('§5.2-10 worktree slugs count, the session cwd is read from the file; other projects do not', async () => {
    session(slug(WT), 'w', mention(WT), DAY);
    session(slug('/Users/u/p/other'), 'o', mention('/Users/u/p/other'), DAY);
    const r = await find({ worktrees: ['/Users/u/elsewhere/wt9'] });
    // `proj-wt1` starts with the root slug (`<slug>*`), so it is found even without being in `worktrees`
    expect(r.map((s) => [s.id, s.cwd])).toEqual([['w', WT]]);
    session(slug('/Users/u/elsewhere/wt9'), 'e', mention('/Users/u/elsewhere/wt9'), 2 * DAY);
    expect((await find({ worktrees: ['/Users/u/elsewhere/wt9'] })).map((s) => s.id)).toEqual(['w', 'e']);
  });

  test('§5.2-10 running elsewhere: a `claude` process carrying the id, or the file written < 120 s ago', async () => {
    session(slug(ROOT), 'busy', mention(), DAY);
    session(slug(ROOT), 'fresh', mention(), 60_000);
    session(slug(ROOT), 'idle', mention(), 2 * DAY);
    session(slug(ROOT), 'other', mention(), 3 * DAY);
    const r = await find({ ps: async () => ['/opt/bin/claude --resume busy --verbose', 'vim other.txt'] });
    expect(r.map((s) => [s.id, s.runningElsewhere])).toEqual([['fresh', true], ['busy', true], ['idle', false], ['other', false]]);
  });

  test('§5.2-10 / R-B6 running elsewhere: `sessions/<pid>.json` naming the id with a live pid, in any config dir', async () => {
    session(slug(ROOT), 'term', mention(), DAY);
    session(slug(ROOT), 'acct', mention(), 2 * DAY);
    session(slug(ROOT), 'dead', mention(), 3 * DAY);
    const acct = join(home, 'acct1');
    liveFile(home, 101, 'term');
    liveFile(acct, 202, 'acct');
    liveFile(acct, 303, 'dead');
    writeFileSync(join(acct, 'sessions', 'junk.json'), '{oops');
    const r = await find({ configDirs: [home, acct], alive: (pid) => pid !== 303 });
    expect(r.map((s) => [s.id, s.runningElsewhere])).toEqual([['term', true], ['acct', true], ['dead', false]]);
    // a config dir not passed is not looked at
    expect((await find({ configDirs: [home], alive: () => true })).map((s) => s.runningElsewhere)).toEqual([true, false, false]);
  });

  test('§5.2-10 / R-B6 cwd = the first `type:user` line (a later resume elsewhere writes other cwds)', async () => {
    const att = JSON.stringify({ type: 'attachment', cwd: '/tmp/x', sessionId: 's', message: { role: 'user' } });
    session(slug(ROOT), 's', [att, user('2026-11-01-x-design.md', { cwd: WT }), user('next', { cwd: '/Users/u/elsewhere' })], DAY);
    expect((await find())[0]?.cwd).toBe(WT);
  });

  test('§5.2-10 ps failing falls back to the 120 s rule', async () => {
    session(slug(ROOT), 's', mention(), DAY);
    expect((await find({ ps: () => Promise.reject(new Error('ps')) }))[0]?.runningElsewhere).toBe(false);
  });

  test('§16 > 400 turns → long (IS17 defaults to Build mới)', async () => {
    session(slug(ROOT), 'big', [...mention(), ...Array.from({ length: 399 }, () => user('x'))], DAY);
    session(slug(ROOT), 'ok', [...mention(), ...Array.from({ length: 398 }, () => user('x'))], 2 * DAY);
    expect((await find()).map((s) => [s.id, s.turns, s.long])).toEqual([['big', 401, true], ['ok', 400, false]]);
  });

  test('§5.2-10 a broken line is skipped; no projects dir → empty', async () => {
    session(slug(ROOT), 's', ['{not json', ...mention()], DAY);
    expect((await find()).map((s) => s.id)).toEqual(['s']);
    rmSync(join(home, 'projects'), { recursive: true });
    expect(await find()).toEqual([]);
  });

  test('§5.2-10 the first text is one line, at most 160 chars', async () => {
    session(slug(ROOT), 's', [user(`${'a'.repeat(200)} 2026-11-01-x-design.md\nsecond line`)], DAY);
    const [s] = await find();
    expect(s?.firstText).toBe(`${'a'.repeat(159)}…`);
  });
});
