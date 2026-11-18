// v2.4 G3b: SessionProcess with multi-block outbox rows on fake-claude — the hold flag gates them (§5.3), image bytes never
// leave as stdout data (A5), the replay event carries "ours" (§10.2), a raw row with no replay is delivered at its result (§6.6).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AttachStore } from '../src/attach/store.ts';
import { listUndelivered, openDb, type Db } from '../src/db.ts';
import { Outbox, PREFIX } from '../src/outbox.ts';
import { paths } from '../src/paths.ts';
import { childEnv } from '../src/session/env.ts';
import { SessionProcess } from '../src/session/process.ts';
import type { MessageEvent, StreamEvent } from '../src/stream/parser.ts';

const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
const EMAIL = 'po@example.com';
const KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ATTACH', 'CLAUDE_JSON'] as const;
const SAVED = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const ARGS = { settingsPath: '/h/deny.json', mcpConfigPath: '/h/mcp.json', appendSystemPrompt: 'vai trò' };
const LOOP = { steps: [{ waitUser: 'never-sent' }] }; // every message → a quick success result

let tmp: string;
let db: Db;
let store: AttachStore;
let outbox: Outbox;
let live: SessionProcess[] = [];
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-satt-'));
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  process.env.CC_SLAVES_ATTACH = join(tmp, 'attach');
  process.env.CLAUDE_JSON = join(tmp, 'claude.json');
  writeFileSync(process.env.CLAUDE_JSON, JSON.stringify({ oauthAccount: { emailAddress: EMAIL } }));
  db = openDb(join(tmp, 'state.db'));
  store = new AttachStore({ referenced: () => outbox.referencedCopies() });
  outbox = new Outbox(db, store);
});
afterEach(async () => {
  for (const s of live) await s.terminate(500);
  live = [];
  db.close();
  for (const k of KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; }
  rmSync(tmp, { recursive: true, force: true });
});

function make(scenario: Record<string, unknown>) {
  const file = join(tmp, 'scenario.json');
  writeFileSync(file, JSON.stringify(scenario));
  const stdin = join(tmp, 'stdin.log');
  const s = new SessionProcess({
    sessionId: 'sess-1', resume: false, projectId: 'p1', lane: 'orchestrator', runN: 1, args: ARGS, cwd: tmp,
    account: { email: EMAIL, configDir: join(tmp, 'acct') }, outbox, command: ['bun', FAKE],
    env: () => ({
      ...childEnv({ PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, { configDir: join(tmp, 'acct') }),
      FAKE_CLAUDE_SCENARIO: file, FAKE_CLAUDE_STDIN_LOG: stdin,
    }),
    initTimeoutMs: 5000,
  });
  live.push(s);
  const events: StreamEvent[] = [];
  s.on('event', (e) => events.push(e));
  async function until(pred: () => boolean, ms = 5000): Promise<void> {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error(`timeout; got ${events.map((e) => e.kind).join(',')}`);
      await Bun.sleep(20);
    }
  }
  const users = (): { uuid: string; content: unknown }[] => {
    try {
      return readFileSync(stdin, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((l) => l.type === 'user').map((l) => ({ uuid: l.uuid as string, content: (l.message as { content: unknown }).content }));
    } catch { return []; }
  };
  const results = () => events.filter((e) => e.kind === 'result').length;
  return { s, events, until, users, results };
}

/** A PNG-headed payload with a long, unmistakable base64. */
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 6000 }, (_, i) => (i * 31 + 11) % 256)]);
const B64 = Buffer.from(PNG_BYTES).toString('base64');

async function imageRow(text: string): Promise<{ uuid: string; id: string }> {
  const s = store.put('ảnh.png', PNG_BYTES);
  const t = await store.take([{ up: s.id }]);
  if (!t.ok) throw new Error('take');
  return { uuid: outbox.enqueue('sess-1', text, PREFIX.po, { attachments: t.list }).uuid, id: s.id };
}

describe('multi-block rows on a live process (v2.4 §10.2)', () => {
  test('§5.3 a held image row stays off stdin; release() writes it with its image block', async () => {
    const f = make(LOOP);
    outbox.enqueue('sess-1', 'go 1', null);
    await f.s.start();
    await f.until(() => f.results() >= 1);
    f.s.hold();
    const { uuid } = await imageRow('go ảnh');
    expect(f.s.flush()).toBe(0);
    await Bun.sleep(200);
    expect(f.users().map((u) => u.uuid)).not.toContain(uuid);
    expect(f.s.release()).toBe(1);
    await f.until(() => f.users().some((u) => u.uuid === uuid));
    const sent = f.users().find((u) => u.uuid === uuid)!.content as { type: string; source?: { data: string } }[];
    expect(sent.map((b) => b.type)).toEqual(['text', 'image']);
    expect(sent[1]!.source!.data).toBe(B64);
  });

  test('§10.2 A5 image bytes reach stdin but never the event bus, the run log, recentLines or state.db; the copy stays past replay (v2.7 §5.1)', async () => {
    const f = make(LOOP);
    const { uuid, id } = await imageRow('go xem');
    await f.s.start();
    await f.until(() => f.results() >= 1);
    expect(JSON.stringify(f.users())).toContain(B64);
    const replay = f.events.find((e) => e.kind === 'user' && e.uuid === uuid);
    expect(replay).toBeDefined();
    expect(JSON.stringify(f.events)).not.toContain(B64.slice(0, 200));
    expect(JSON.stringify(replay)).toContain(`<lược ${PNG_BYTES.length} byte>`);
    expect(f.s.recentLines.join('\n')).not.toContain(B64.slice(0, 200));
    await f.s.terminate(500); // closes the run log
    const log = readFileSync(paths().runLog('p1', 'orchestrator', 1), 'utf8');
    expect(log).toContain(`<lược ${PNG_BYTES.length} byte>`);
    expect(log).not.toContain(B64.slice(0, 200));
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    for (const n of readdirSync(tmp).filter((x) => x.startsWith('state.db'))) {
      expect(readFileSync(join(tmp, n)).toString('latin1')).not.toContain(B64.slice(0, 200));
    }
    expect(listUndelivered(db, 'sess-1')).toEqual([]);
    expect(existsSync(join(tmp, 'attach', id))).toBe(true); // v2.7 §5.1 kept until the session ends (issue_create files)
  });

  test('§7.6 / §6.4 a plain row queued after an image row never overtakes it on stdin while the image is read', async () => {
    const f = make(LOOP);
    const img = await imageRow('go ảnh');
    const plain = outbox.enqueue('sess-1', 'go chữ', PREFIX.po);
    await f.s.start();
    await f.until(() => f.users().length >= 2);
    expect(f.users().map((u) => u.uuid)).toEqual([img.uuid, plain.uuid]);
  });

  test('§10.2 the replay event carries "ours": true for our uuid, false for a foreign one', async () => {
    const f = make({ steps: [{ waitUser: 'go' }, { foreignReplay: 'Base directory for this skill: /x' }, { emit: { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, permission_denials: [] } }] });
    const m = outbox.enqueue('sess-1', 'go', null);
    await f.s.start();
    await f.until(() => f.results() >= 1);
    const replays = f.events.filter((e) => e.kind === 'user' && e.isReplay) as MessageEvent[];
    expect(replays.map((e) => [e.uuid === m.uuid, e.ours])).toEqual([[true, true], [false, false]]);
  });

  test('§10.2 R4 a row still rendering when its process dies is never written to the next process', async () => {
    const f = make(LOOP);
    outbox.enqueue('sess-1', 'go 1', null);
    await f.s.start();
    await f.until(() => f.results() >= 1);
    const fifo = join(tmp, 'slow.png');
    expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0);
    const row = outbox.enqueue('sess-1', 'ảnh chậm', PREFIX.po, { attachments: [{ kind: 'image', name: 'slow.png', size: 12, mime: 'image/png', path: fifo, copy: true, up: '00000000-0000-4000-8000-000000000000' }] });
    expect(f.s.flush()).toBe(1); // its render blocks on the fifo (= a read held by a TCC prompt)
    await f.s.terminate(500);
    db.query('DELETE FROM outbox WHERE uuid = ?').run(row.uuid); // the row moved away meanwhile
    outbox.enqueue('sess-1', 'go 2', null);
    await f.s.start();
    await f.until(() => f.results() >= 2);
    const fd = openSync(fifo, 'w'); writeSync(fd, PNG_BYTES.subarray(0, 12)); closeSync(fd); // the old render resolves now
    await Bun.sleep(300);
    expect(f.users().map((u) => u.uuid)).not.toContain(row.uuid);
  });
  test('§6.6 a raw row with no replay (/resume) is delivered at the result of its own turn', async () => {
    const f = make(LOOP);
    outbox.enqueue('sess-1', 'go 1', null);
    await f.s.start();
    await f.until(() => f.results() >= 1);
    const raw = f.s.send('/resume', PREFIX.raw);
    await f.until(() => f.results() >= 2);
    expect(f.users().find((u) => u.uuid === raw.uuid)!.content).toBe('/resume');
    expect(f.events.some((e) => e.kind === 'user' && e.uuid === raw.uuid)).toBe(false);
    expect(listUndelivered(db, 'sess-1')).toEqual([]);
    expect(outbox.hasUnreplayed('sess-1')).toBe(false);
  });
});
