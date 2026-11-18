// v2 §6A (D19) T10: engine-emitted texts — system cards carry `titleKey` + `params`, errors carry `key` + `params`,
// macOS notifications / toasts / Google Chat are rendered in `config.ui.lang` at send time.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineEvent, ServerMsg } from '../../shared/protocol.ts';
import { hasKey, keyedText, LANGS, makeT, reason, t, type Key, type Lang } from '../../shared/i18n/index.ts';
import { AccountError } from '../src/accounts/remove.ts';
import { act, CardError, CardStore, keyedBody, ORCH_SOURCE, type Card, type SystemPayload } from '../src/cards/store.ts';
import { attachOrchestratorCards, attachSystemCards } from '../src/cards/wire.ts';
import { insertProject, openDb, type Db } from '../src/db.ts';
import type { LaneUiEvent, LaneView } from '../src/lane/manager.ts';
import { LaneError } from '../src/lane/manager.ts';
import { gchatText, Notifier, type NotifierDeps } from '../src/notify/notify.ts';
import type { OrchestratorEvent } from '../src/orchestrator/session.ts';
import { CommandError, route, type Handlers } from '../src/server/router.ts';
import { cardView } from '../src/server/views.ts';

const SRC = join(import.meta.dir, '../src');
function srcFiles(dir = SRC): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? srcFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}
const resolvesBoth = (k: string) => LANGS.every((l) => hasKey(l, k));

describe('§6A system cards carry a catalog titleKey', () => {
  let tmp: string; let db: Db; let store: CardStore;
  const laneL: ((e: LaneUiEvent) => void)[] = [];
  const orchL: ((e: OrchestratorEvent) => void)[] = [];
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ccs-i18n-'));
    db = openDb(join(tmp, 'state.db'));
    insertProject(db, { id: 'p1', name: 'hagenta', path: join(tmp, 'p1') });
    store = new CardStore({ db, sessions: { writeControl: () => false, askOpen: () => {}, askClose: () => {}, deliver: () => {} } });
    laneL.length = 0; orchL.length = 0;
    attachSystemCards(store, db, { lanes: { on: (f) => { laneL.push(f); } }, orchestrators: { on: (f) => { orchL.push(f); } } });
  });
  afterEach(() => { store.shutdown(); db.close(); rmSync(tmp, { recursive: true, force: true }); });

  test('§6A every wire card kind → titleKey resolves in vi and en, vi text = stored title', () => {
    const lane = { projectId: 'p1', name: 'D2', sessionId: 's', state: 'broken', lastError: 'x' } as unknown as LaneView;
    for (const f of laneL) {
      f({ type: 'lane', lane });
      f({ type: 'account_logged_out', account: 'a@x-com.test' } as LaneUiEvent);
      f({ type: 'claude_version', version: '2.1.0', ok: true }); // baseline
      f({ type: 'claude_version', version: '2.2.0', ok: true });
      f({ type: 'claude_version', version: '2.3.0', ok: false, message: 'm' });
    }
    for (const f of orchL) f({ type: 'system_card', kind: 'orchestrator_down', projectId: 'p1', sessionId: 's-o', reason: 'r' });
    const cards = store.list({ status: 'open' });
    expect(new Set(cards.map((c) => c.kind))).toEqual(new Set(['broken', 'logged_out', 'cc_updated', 'orchestrator_down']));
    expect(cards.length).toBe(5);
    for (const c of cards) {
      const p = c.payload as SystemPayload;
      expect(p.titleKey && resolvesBoth(p.titleKey)).toBe(true);
      expect(t('vi', p.titleKey as Key, p.params)).toBe(p.title);
      expect(t('en', p.titleKey as Key, p.params)).not.toBe(p.title);
      const v = cardView(c);
      expect(v.titleKey).toBe(p.titleKey);
      expect(v.params).toEqual(p.params);
    }
  });

  test('§6A T9c every wire card action carries a labelKey, a literal body a bodyKey (vi = stored text)', () => {
    const lane = { projectId: 'p1', name: 'D2', sessionId: 's', state: 'broken', lastError: 'x' } as unknown as LaneView;
    for (const f of laneL) {
      f({ type: 'lane', lane });
      f({ type: 'account_logged_out', account: 'a@x-com.test' } as LaneUiEvent);
      f({ type: 'claude_version', version: '2.1.0', ok: true });
      f({ type: 'claude_version', version: '2.2.0', ok: true });
      f({ type: 'claude_version', version: '2.3.0', ok: false, message: 'm' });
    }
    for (const f of orchL) f({ type: 'system_card', kind: 'orchestrator_down', projectId: 'p1', sessionId: 's-o', reason: 'r' });
    const cards = store.list({ status: 'open' });
    let acts = 0;
    for (const c of cards) {
      const p = c.payload as SystemPayload, v = cardView(c);
      for (const [i, a] of p.actions.entries()) {
        acts++;
        expect(a.labelKey && resolvesBoth(a.labelKey) ? a.labelKey : `${c.kind}/${a.action}: no labelKey`).toMatch(/^cardText\.act\./);
        expect(t('vi', a.labelKey!, a.labelParams)).toBe(a.label);
        expect(v.actions![i]).toMatchObject({ id: a.action, label: a.label, labelKey: a.labelKey });
      }
    }
    expect(acts).toBe(9);
    const ok = cards.find((c) => (c.payload as SystemPayload).titleKey === 'cards.ccUpdatedOk')!;
    const v = cardView(ok);
    expect(v.bodyKey).toBe('cardText.body.ccUpdatedOk');
    expect(t('vi', v.bodyKey as Key, v.bodyParams)).toBe(v.context!);
    expect(t('en', v.bodyKey as Key, v.bodyParams)).toBe('Start check passed: system/init, version, MCP cc_slaves.');
    // a dynamic body (Claude / engine error text) has no key: it is shown as sent (§6A "Không dịch": logs)
    expect(cardView(cards.find((c) => c.kind === 'broken')!).bodyKey).toBeUndefined();
  });

  test('G5 NEW-1 F17 bad-version card body is keyed from failure.reason (vi = stored body, en translated)', () => {
    const { text, ...r } = reason('errors.start_old_version', { version: '2.3.0', min: '2.1.300' });
    for (const f of laneL) {
      f({ type: 'claude_version', version: '2.1.0', ok: true });
      f({ type: 'claude_version', version: '2.3.0', ok: false, message: text, reason: r });
    }
    const bad = cardView(store.list({ status: 'open' }).find((c) => (c.payload as SystemPayload).titleKey === 'cards.ccUpdatedBad')!);
    expect(bad.bodyKey).toBe('errors.start_old_version');
    expect(t('vi', bad.bodyKey as Key, bad.bodyParams)).toBe(text);
    expect(t('en', bad.bodyKey as Key, bad.bodyParams)).not.toBe(text);
  });

  test('§6A G5-fix engine-composed reasons keyed: broken card + orchestrator_down card carry bodyKey (vi = stored body)', () => {
    const lane = { projectId: 'p1', name: 'D2', sessionId: 's', state: 'broken', lastError: 'claude thoát (mã 1) khi chưa xong lượt',
      lastErrorKeyed: { key: 'errors.exitCode', params: { code: 1 } } } as unknown as LaneView;
    for (const f of laneL) f({ type: 'lane', lane });
    const reasonKeyed = { key: 'errors.orchStart', inner: { key: 'errors.start_init_timeout', params: { s: 60 } } };
    for (const f of orchL) f({ type: 'system_card', kind: 'orchestrator_down', projectId: 'p1', sessionId: 's-o',
      reason: 'không khởi động được: claude không phát system/init trong 60 s', reasonKeyed });
    const b = cardView(store.list({ status: 'open' }).find((c) => c.kind === 'broken')!);
    expect(b).toMatchObject({ context: 'claude thoát (mã 1) khi chưa xong lượt', bodyKey: 'errors.exitCode', bodyParams: { code: 1 } });
    expect(keyedText(makeT('en'), { key: b.bodyKey!, params: b.bodyParams })).toBe('claude exited (code 1) before the turn finished');
    const o = cardView(store.list({ status: 'open' }).find((c) => c.kind === 'orchestrator_down')!);
    expect(o).toMatchObject({ context: 'không khởi động được: claude không phát system/init trong 60 s', bodyKey: 'errors.orchStart', bodyInner: reasonKeyed.inner });
    expect(keyedText(makeT('en'), { key: o.bodyKey!, inner: o.bodyInner })).toBe('could not start: claude sent no system/init within 60 s');
  });

  test('§6A G5-fix orchestrator source: stored as "orchestrator", titles / gchat render the role in ui.lang (old "Điều phối" rows too)', () => {
    const ev = { kind: 'can_use_tool', requestId: 'r1', toolName: 'Bash', input: { command: 'ls' }, description: null, permissionSuggestions: [] };
    const c = store.permission({ projectId: 'p1', sessionId: 's-o', source: ORCH_SOURCE, event: ev as never });
    expect((c.payload as { source: string; title: string }).title).toBe('Điều phối xin chạy: Bash ls');
    const v = cardView(c);
    expect(v).toMatchObject({ source: 'orchestrator', titleKey: 'cards.permission', params: { source: 'orchestrator' } }); // the web maps it (cardTitle)
    expect(gchatText(c, { name: 'Shop', gchatSendCommandText: false }, { enabled: false, hostname: null }, 'en')).toBe('Shop · Orchestrator · Permission · Orchestrator wants to run Bash');
    // the wire (attachOrchestratorCards) stores ORCH_SOURCE for the orchestrator's can_use_tool
    const ol: ((e: unknown) => void)[] = [];
    attachOrchestratorCards(store, { on: (f) => { ol.push(f as (e: unknown) => void); } });
    for (const f of ol) f({ type: 'control', projectId: 'p1', sessionId: 's-o2', event: { ...ev, requestId: 'r2' } });
    expect(store.list({ status: 'open' }).filter((x) => x.kind === 'permission').map((x) => (x.payload as { source: string }).source)).toEqual(['orchestrator', 'orchestrator']);
    const old = { ...c, payload: { ...(c.payload as object), source: 'Điều phối' } } as Card;
    expect(gchatText(old, { name: 'Shop', gchatSendCommandText: true }, { enabled: false, hostname: null }, 'en')).toBe('Shop · Orchestrator · Permission · Orchestrator wants to run: Bash ls');
  });

  test('§6A T9c updateSystem replaces the body key (no stale bodyKey after a refresh)', () => {
    const c = store.createSystem({ kind: 'shared_cfg', key: 'a@x/k', titleKey: 'cards.sharedCfgNew', params: { name: 'k' }, ...keyedBody('cardText.body.sharedNew'), actions: [act('cardText.act.later', 'dismiss')] });
    expect((c.payload as SystemPayload).body).toBe(t('vi', 'cardText.body.sharedNew'));
    const u = store.updateSystem(c.id, { body: 'plain', actions: [act('cardText.act.merge', 'shared_cfg_merge')] });
    expect(cardView(u).bodyKey).toBeUndefined();
    expect(cardView(u).context).toBe('plain');
    const k = store.updateSystem(c.id, { ...keyedBody('cardText.body.issue.missingLink', { path: '/p' }), actions: [] });
    expect(cardView(k)).toMatchObject({ bodyKey: 'cardText.body.issue.missingLink', bodyParams: { path: '/p' }, context: 'Thiếu link: /p' });
  });

  test('§6A T9c v1 open_ccswitch action read back gets the relogin labelKey', () => {
    db.query("INSERT INTO card (kind, payload, status, created_at) VALUES ('logged_out', ?, 'open', 1)")
      .run(JSON.stringify({ title: 'old', body: null, key: 'bob@x-com.test', actions: [{ label: 'Mở CC Switch', action: 'open_ccswitch' }] }));
    expect(cardView(store.list({ status: 'open' })[0]!).actions).toEqual([{ id: 'account_relogin', label: 'Đăng nhập lại', labelKey: 'cardText.act.relogin' }]);
  });

  test('§6A T9c engine/src: no action label literal, no literal card body outside the catalog', () => {
    const bad: string[] = [];
    for (const f of srcFiles()) {
      const s = readFileSync(f, 'utf8');
      for (const m of s.matchAll(/\{ label: [^{}]*?action: '[^']+'/g)) bad.push(`${f}: ${m[0].slice(0, 60)}`);
      for (const m of s.matchAll(/\.(?:createSystem|updateSystem)\(([^;]*?)\);/gs)) {
        if (/\bbody: ['`]/.test(m[1]!)) bad.push(`${f}: literal body in ${m[1]!.slice(0, 60)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test('§6A T9c A9 merge body keyed: vi text kept (list ≤ 20 + "… và n file nữa"), en rendered', async () => {
    const { mergeBody } = await import('../src/engine/shared-cfg.ts');
    const files = Array.from({ length: 22 }, (_, i) => `f${i}.md`);
    const many = mergeBody({ ok: true, name: 'plans', files, clashes: [] });
    expect(many.bodyKey).toBe('cardText.body.mergeFilesMore');
    expect(many.body).toBe(['Sẽ chuyển 22 file vào ~/.claude/plans:', ...files.slice(0, 20).map((f) => `- ${f}`), '… và 2 file nữa', 'Không ghi đè.'].join('\n'));
    expect(t('en', many.bodyKey, many.bodyParams).split('\n').at(-2)).toBe('… and 2 more files');
    const few = mergeBody({ ok: true, name: 'plans', files: ['a'], clashes: [] });
    expect(few).toEqual({ body: 'Sẽ chuyển 1 file vào ~/.claude/plans:\n- a\nKhông ghi đè.', bodyKey: 'cardText.body.mergeFiles', bodyParams: { n: 1, name: 'plans', list: '- a' } });
    expect(mergeBody({ ok: true, name: 'x', files: [], clashes: [] }).body).toBe('Thư mục trống — chỉ đổi thành link tới ~/.claude/x.\nKhông ghi đè.');
    expect(mergeBody({ ok: false, name: 'x', reason: 'clash', files: [], clashes: ['c'] }).body).toBe('Trùng tên, không gộp được:\n- c\nKhông ghi đè.');
    expect(mergeBody({ ok: false, name: 'x', reason: 'not_real_dir', files: [], clashes: [] }).body).toBe('Không có thư mục thật để gộp (đã là link?). Không ghi đè.');
  });

  test('§6A createSystem with an unknown titleKey throws (tests are strict)', () => {
    expect(() => store.createSystem({ kind: 'broken', key: 'k', titleKey: 'cards.nope' as Key, actions: [] })).toThrow(/cards\.nope/);
  });

  test('§6A v1 logged_out row read back gets the v2 titleKey', () => {
    db.query("INSERT INTO card (kind, payload, status, created_at) VALUES ('logged_out', ?, 'open', 1)")
      .run(JSON.stringify({ title: 'old', body: null, key: 'bob@x-com.test', actions: [{ label: 'Mở CC Switch', action: 'open_ccswitch' }] }));
    const v = cardView(store.list({ status: 'open' })[0]!);
    expect(v.titleKey).toBe('cards.loggedOut');
    expect(t('en', v.titleKey as Key, v.params)).toContain('bob@');
  });

  test('§6A every createSystem call in engine/src passes a titleKey that exists in both catalogs', () => {
    let calls = 0;
    for (const f of srcFiles()) {
      const s = readFileSync(f, 'utf8');
      for (const m of s.matchAll(/\.createSystem\(\{([\s\S]*?)\}\);/g)) {
        calls++;
        const k = /titleKey: '([^']+)'/.exec(m[1]!);
        if (!k && /[\s,{]titleKey[,\s}]/.test(m[1]!)) {
          // a computed `titleKey` (v2.2 K13 picks one of four): every `cards.*` literal of that file must resolve
          const keys = [...s.matchAll(/'(cards\.[A-Za-z.]+)'/g)].map((x) => x[1]!);
          expect(keys.length).toBeGreaterThan(0);
          for (const key of keys) expect(`${key}:${resolvesBoth(key)}`).toBe(`${key}:true`);
          continue;
        }
        expect(k ? `${f}: ${k[1]}` : `${f}: NO titleKey in ${m[1]!.slice(0, 60)}`).toMatch(/: cards\./);
        expect(resolvesBoth(k![1]!)).toBe(true);
      }
    }
    expect(calls).toBeGreaterThanOrEqual(9);
  });

  test('§6A ask / permission views carry titleKey + params; vi render = the old title', () => {
    const ask = { id: 1, kind: 'ask', projectId: 'p1', sessionId: 's', requestId: null, status: 'open', createdAt: 1, resolvedAt: null, answer: null,
      payload: { source: 'D2', question: 'Q?', options: [], recommended: null, context: null } } as Card;
    const perm = { ...ask, id: 2, kind: 'permission', payload: { source: 'D2', title: 'D2 xin chạy: Bash ls', toolName: 'Bash', input: { command: 'ls' }, description: null, suggestions: [], allowAlways: false } } as Card;
    for (const c of [ask, perm]) {
      const v = cardView(c);
      expect(resolvesBoth(v.titleKey!)).toBe(true);
      expect(t('vi', v.titleKey as Key, v.params)).toBe(v.title);
    }
    expect(t('en', cardView(perm).titleKey as Key, cardView(perm).params)).toBe('D2 wants to run: Bash ls');
  });
});

describe('§6A engine errors carry key + params', () => {
  test('§6A every literal error key in engine/src exists in both catalogs', () => {
    const keys = new Set<string>();
    for (const f of srcFiles()) for (const m of readFileSync(f, 'utf8').matchAll(/\{ key: '([a-z]+\.[\w.]+)'/g)) keys.add(m[1]!);
    expect(keys.size).toBeGreaterThan(40);
    expect([...keys].filter((k) => !resolvesBoth(k))).toEqual([]);
  });

  test('§6A keyed form: message = the vi text, key/params kept', () => {
    const e = new LaneError('no_lane', { key: 'errors.noLane', params: { name: 'D9' } });
    expect(e.message).toBe('Không có lane D9');
    expect(e.key).toBe('errors.noLane');
    expect(t('en', e.key!, e.params)).toBe('No lane D9');
  });

  test('§6A a keyed error with a missing param throws (tests are strict)', () => {
    expect(() => new CardError('no_card', { key: 'errors.noCard' })).toThrow(/\{id\}/);
  });

  test('§6A router forwards key + params for every engine error class', async () => {
    const errs = [
      new LaneError('no_lane', { key: 'errors.noLane', params: { name: 'D9' } }),
      new CardError('no_card', { key: 'errors.noCard', params: { id: 4 } }),
      new AccountError('no_account', { key: 'errors.noAccount', params: { email: 'a@x' } }),
      new CommandError('bad_input', { key: 'errors.badTarget' }),
    ];
    for (const err of errs) {
      const h = { stop_all: () => { throw err; } } as unknown as Handlers;
      const r = await route(h, { channel: 'mac' }, { type: 'command', id: '1', command: { cmd: 'stop_all' } }) as Extract<ServerMsg, { type: 'error' }>;
      expect(r.key).toBe(err.key);
      expect(r.message).toBe(err.message);
      if (err.params) expect(r.params).toEqual(err.params);
    }
  });

  test('§6A G5-fix an unexpected throw → code internal with key errors.internal {detail}', async () => {
    const h = { stop_all: () => { throw new Error('boom'); } } as unknown as Handlers;
    const r = await route(h, { channel: 'mac' }, { type: 'command', id: '1', command: { cmd: 'stop_all' } }) as Extract<ServerMsg, { type: 'error' }>;
    expect(r).toMatchObject({ code: 'internal', message: 'Lỗi engine: boom', key: 'errors.internal', params: { detail: 'boom' } });
    expect(t('en', r.key as Key, r.params)).toBe('Engine error: boom');
  });
});

describe('§6A notifications follow ui.lang', () => {
  const sys = (): Card => ({
    id: 14, kind: 'broken', projectId: 'p', sessionId: 's', requestId: null, status: 'open', createdAt: 1, resolvedAt: null, answer: null,
    payload: { title: 'Lane D2 hỏng', body: null, actions: [], key: 'lane:D2', titleKey: 'cards.laneBroken', params: { name: 'D2' } },
  });
  function world(lang: Lang) {
    const events: EngineEvent[] = []; const osa: string[] = []; const posts: string[] = [];
    const deps: NotifierDeps = {
      project: () => ({ name: 'Shop', gchatWebhook: 'https://chat.googleapis.com/h', gchatSendCommandText: false }),
      projectIds: () => ['p'], targetOf: () => ({ kind: 'orchestrator', projectId: 'p' }), emit: (e) => events.push(e),
      appConnected: () => true, viewing: () => false, osascript: (a, b) => osa.push(`${a}|${b}`),
      postGchat: async (_u, text) => { posts.push(text); }, remote: () => ({ enabled: false, hostname: null }), lang: () => lang,
    };
    return { n: new Notifier(deps), events, posts };
  }
  const body = (e: EngineEvent[]) => e.filter((x) => x.type === 'notify').map((x) => (x as { title: string; body: string }));
  const toasts = (e: EngineEvent[]) => e.filter((x) => x.type === 'toast').map((x) => (x as { text: string }).text);

  test('§6A system card notify + gchat in en / vi', async () => {
    const en = world('en'); await en.n.card(sys());
    expect(body(en.events)[0]).toMatchObject({ title: 'Shop · Orchestrator', body: 'Lane D2 broken' });
    expect(en.posts[0]).toBe('Shop · Lane broken · Lane D2 broken');
    const vi = world('vi'); await vi.n.card(sys());
    expect(body(vi.events)[0]).toMatchObject({ title: 'Shop · Điều phối', body: 'Lane D2 hỏng' });
    expect(vi.posts[0]).toBe('Shop · Lane hỏng · Lane D2 hỏng');
  });

  test('§6A toasts (lane done, switch, all full) in en', async () => {
    const w = world('en');
    await w.n.laneDone('p', 'D2');
    await w.n.accountSwitch('p', 'D2', 'b@x');
    await w.n.accountsFull(true);
    expect(toasts(w.events)).toEqual(['Shop · D2 is done', 'Shop · D2 switched to b@x', 'Every account is full — lanes wait for quota']);
    expect(w.posts).toEqual(['Shop · Every account is full — lanes wait for quota']);
  });

  test('§6A lane remind toast: keyed → ui.lang, unkeyed → its text', async () => {
    const w = world('en');
    await w.n.remind({ text: 'D2 đã dừng — tin sẽ gửi khi Chạy lại', key: 'notify.laneStoppedQueued', params: { name: 'D2' } });
    await w.n.remind({ text: 'plain' });
    expect(toasts(w.events)).toEqual(['D2 is stopped — the message is sent on Resume', 'plain']);
  });

  test('§6A reducer remind_po carries the key; vi catalog = its text', async () => {
    const { newLaneCtx, reduce } = await import('../src/lane/reducer.ts');
    const c = { ...newLaneCtx({ id: '1', name: 'D2', sessionId: 's', account: 'a@x' }), state: 'stopped' as const };
    const ef = reduce(c, { type: 'message', text: 'a', from: 'po' }).effects.find((x) => x.type === 'remind_po') as { text: string; key: Key; params: Record<string, string> };
    expect(ef.key).toBe('notify.laneStoppedQueued');
    expect(t('vi', ef.key, ef.params)).toBe(ef.text);
  });

  test('§6A gchatText permission summary in en', () => {
    const perm = { id: 2, kind: 'permission', projectId: 'p', sessionId: 's', requestId: 'r', status: 'open', createdAt: 1, resolvedAt: null, answer: null,
      payload: { source: 'D2', title: 'x', toolName: 'Bash', input: {}, description: null, suggestions: [], allowAlways: false } } as Card;
    expect(gchatText(perm, { name: 'Shop', gchatSendCommandText: false }, { enabled: false, hostname: null }, 'en')).toBe('Shop · D2 · Permission · D2 wants to run Bash');
  });
});
