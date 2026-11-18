// Shared setup for cards.test.ts / mcp.test.ts: a LaneManager on fake-claude, a CardStore wired to it, temp home.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Account } from '../src/accounts/registry.ts';
import { QuotaTracker } from '../src/accounts/quota.ts';
import { CardStore, type Timers } from '../src/cards/store.ts';
import { attachLaneCards, laneCardSessions } from '../src/cards/wire.ts';
import type { Caps } from '../src/config.ts';
import { insertProject, openDb, type Db, type LaneState } from '../src/db.ts';
import { LaneManager } from '../src/lane/manager.ts';
import type { LaneIssueHook } from '../src/lane/manager/types.ts';
import { Outbox } from '../src/outbox.ts';
import type { SessionSpawn } from '../src/session/files.ts';

const FAKE = resolve(import.meta.dir, '../../fake-claude/src/index.ts');
export const SCENARIOS = resolve(import.meta.dir, '../../fake-claude/scenarios');
const A = 'a@x.test';
const CAPS: Caps = { default: { week: 98, five: 95 } };

export class ManualTimers implements Timers {
  pending: { fn: () => void; ms: number; done: boolean }[] = [];
  set(fn: () => void, ms: number) { const t = { fn, ms, done: false }; this.pending.push(t); return t; }
  clear(h: unknown) { (h as { done: boolean }).done = true; }
  fireAll() { for (const t of this.pending) if (!t.done) { t.done = true; t.fn(); } }
}

export interface World {
  tmp: string; db: Db; outbox: Outbox; m: LaneManager; cards: CardStore; tokens: Map<string, string>; notes: string[];
  close(): Promise<void>;
}

/** `scenario(n)` = the n-th spawn's scenario (an object, or a path to a scenario file). */
export function world(o: {
  scenario: (n: number) => object | string; cardTimers?: Timers; onMcpToken?: (sid: string, sp: SessionSpawn) => void;
  /** v2.7 §5.3 the lane issue hook (built over the world's db + outbox). */
  issues?: (db: Db, outbox: Outbox) => LaneIssueHook;
}): World {
  const tmp = mkdtempSync(join(tmpdir(), 'ccs-cards-'));
  const saved = process.env.CC_SLAVES_HOME;
  process.env.CC_SLAVES_HOME = join(tmp, 'home');
  const db = openDb(join(tmp, 'state.db'));
  insertProject(db, { id: 'p1', name: 'P1', path: join(tmp, 'p1') });
  const outbox = new Outbox(db);
  const acct: Account = { email: A, id: null, configDir: join(tmp, 'cfg'), keychainService: 'k', planTier: 'max', terminal: false };
  const notes: string[] = [];
  const tokens = new Map<string, string>();
  let n = 0;
  const tracker: QuotaTracker = new QuotaTracker({
    db, source: { fetchUsage: () => Promise.reject(new Error('no network in tests')) }, onAccountChanged: (e) => m.accountChanged(e),
  });
  const m: LaneManager = new LaneManager({
    db, outbox, accounts: () => [acct], quota: tracker, caps: () => CAPS, config: () => ({ maxLanes: 8, maxLanesPerAccount: 3 }),
    command: ['bun', FAKE], mcpPort: 1,
    env: () => {
      const s = o.scenario(++n);
      let file: string;
      if (typeof s === 'string') file = s;
      else { file = join(tmp, `scn-${n}.json`); writeFileSync(file, JSON.stringify(s)); }
      return { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', FAKE_CLAUDE_SCENARIO: file };
    },
    onMcpToken: (sid, sp) => { tokens.set(sid, sp.token); o.onMcpToken?.(sid, sp); },
    notify: (_p, t) => notes.push(t),
    ...(o.issues ? { issues: o.issues(db, outbox) } : {}),
    session: { initTimeoutMs: 5000, interruptTimeoutMs: 300 },
    closeGraceMs: 300,
  });
  const cards = new CardStore({ db, sessions: laneCardSessions(m, outbox), ...(o.cardTimers ? { timers: o.cardTimers } : {}) });
  attachLaneCards(cards, m);
  return {
    tmp, db, outbox, m, cards, tokens, notes,
    async close() {
      cards.shutdown();
      await m.shutdown();
      db.close();
      if (saved === undefined) delete process.env.CC_SLAVES_HOME; else process.env.CC_SLAVES_HOME = saved;
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

let laneNo = 0;
export function startArgs(w: World, name: string) {
  const cwd = join(w.tmp, `wt-${name}-${++laneNo}`);
  mkdirSync(cwd, { recursive: true });
  return { projectId: 'p1', name, cwd, briefPath: `/briefs/${name}.md` };
}

export async function until(cond: () => boolean, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await Bun.sleep(15);
  }
}

export const reach = (w: World, name: string, s: LaneState) =>
  until(() => w.m.get('p1', name)?.state === s, `${name} ${s} (now ${w.m.get('p1', name)?.state})`);

type Step = Record<string, unknown>;
const assistant = (text = 'Đang làm…'): Step => ({
  emit: { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', model: 'claude-fake', content: [{ type: 'text', text }] } },
});
const result = (text = 'Xong.'): Step => ({
  emit: { type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, total_cost_usd: 0.01, permission_denials: [] },
});
export const turns = (k: number): Step[] =>
  Array.from({ length: k }, (_, i) => [{ waitUser: true }, assistant(), result(`Xong lượt ${i + 1}.`)]).flat();
