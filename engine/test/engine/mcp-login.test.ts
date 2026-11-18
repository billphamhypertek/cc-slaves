// v2.2 §6 K13 / C26 the MCP login card: one system card per server (projectId null, key = id), lanes merged,
// "Để sau" = 4 h or until another lane misses it, closes by itself after a login.
import { beforeEach, describe, expect, test } from 'bun:test';
import type { McpOAuthView } from '../../../shared/protocol.ts';
import { CardStore, type CardSessions, type SystemPayload } from '../../src/cards/store.ts';
import { openDb } from '../../src/db.ts';
import { McpLoginCards, SNOOZE_MS, type MissingLane } from '../../src/engine/mcp-login.ts';
import { cardView } from '../../src/server/views.ts';

const sessions: CardSessions = { writeControl: () => true, askOpen: () => {}, askClose: () => {}, deliver: () => {} };
const ID = 'user:vercel';
let cards: CardStore;
let now: number;
let view: McpOAuthView | null;
let lanes: MissingLane[];
let k13: McpLoginCards;
let timers: { fn: () => void; ms: number }[];

const base: McpOAuthView = { loggedIn: false, expiresAt: null, refreshedAt: null, needsLogin: null, keychainFailed: false, login: null, error: null };
const open = () => cards.findOpenSystem('mcp_login', ID, null);
const payload = () => open()!.payload as SystemPayload;

beforeEach(() => {
  cards = new CardStore({ db: openDb(':memory:'), sessions, now: () => now });
  now = 1_000_000;
  view = base;
  lanes = [{ name: 'D2', projectId: 'p1' }, { name: 'B3', projectId: 'p2' }];
  timers = [];
  k13 = new McpLoginCards({
    cards, view: () => view, name: () => 'vercel', missing: () => lanes, now: () => now,
    timers: { set: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clear: () => {} },
  });
});

describe('§6 K13', () => {
  test('§6 K13 invalid_grant → one system card (projectId null, key = id), lanes merged, Đăng nhập + Để sau', () => {
    view = { ...base, needsLogin: { reason: 'invalid_grant', scope: null } };
    k13.sync(ID);
    k13.sync(ID);
    const c = open()!;
    expect(c.projectId).toBeNull();
    expect(payload().title).toBe('MCP vercel cần đăng nhập lại · D2, B3 đang thiếu công cụ này');
    expect(payload().actions.map((a) => a.action)).toEqual(['mcp_login', 'mcp_snooze']);
    expect(payload().actions[0]!.args).toEqual({ id: ID, projectIds: ['p1', 'p2'] });
    expect(cards.list().filter((x) => x.kind === 'mcp_login')).toHaveLength(1);
  });

  test('§5.2 insufficient_scope → "(thiếu quyền: <scope>)"', () => {
    view = { ...base, loggedIn: true, needsLogin: { reason: 'insufficient_scope', scope: 'files:write' } };
    k13.sync(ID);
    expect(payload().title).toBe('MCP vercel cần đăng nhập lại (thiếu quyền: files:write) · D2, B3 đang thiếu công cụ này');
  });

  test('§6 K13 never logged in + no lane missing it → no card; a lane hits it → "cần đăng nhập"', () => {
    view = { ...base, needsLogin: { reason: 'no_token', scope: null } };
    lanes = [];
    k13.sync(ID);
    expect(open()).toBeNull();
    lanes = [{ name: 'D2', projectId: 'p1' }];
    k13.sync(ID);
    expect(payload().title).toBe('MCP vercel cần đăng nhập · D2 đang thiếu công cụ này');
  });

  test('§6 K13 a login closes the card by itself', () => {
    view = { ...base, needsLogin: { reason: 'invalid_grant', scope: null } };
    k13.sync(ID);
    const id = open()!.id;
    view = { ...base, loggedIn: true };
    k13.sync(ID);
    expect(open()).toBeNull();
    expect(cards.get(id)!.status).not.toBe('open');
  });

  test('§6 C26 "Để sau" hides it 4 h; same lanes → stays hidden; a new lane missing it → back', () => {
    view = { ...base, needsLogin: { reason: 'invalid_grant', scope: null } };
    k13.sync(ID);
    k13.snooze(ID);
    expect(open()).toBeNull();
    k13.sync(ID);
    expect(open()).toBeNull();
    lanes = [...lanes, { name: 'C1', projectId: 'p1' }];
    k13.sync(ID);
    expect(payload().title).toContain('D2, B3, C1');
  });

  test('§6 C26 "Để sau" ends after 4 h (timer re-syncs)', () => {
    view = { ...base, needsLogin: { reason: 'invalid_grant', scope: null } };
    k13.sync(ID);
    k13.snooze(ID);
    expect(timers.at(-1)!.ms).toBe(SNOOZE_MS);
    expect(SNOOZE_MS).toBe(4 * 3600_000);
    now += SNOOZE_MS;
    timers.at(-1)!.fn();
    expect(open()).not.toBeNull();
  });

  test('C26 the card view carries the projects of the lanes missing the server (the tab badge counts it only there)', () => {
    view = { ...base, needsLogin: { reason: 'invalid_grant', scope: null } };
    k13.sync(ID);
    expect(cardView(open()!).projectIds).toEqual(['p1', 'p2']);
    lanes = [];
    view = { ...base, needsLogin: { reason: 'insufficient_scope', scope: 'x' } };
    k13.sync(ID);
    expect(cardView(open()!).projectIds).toEqual([]);
  });
});
