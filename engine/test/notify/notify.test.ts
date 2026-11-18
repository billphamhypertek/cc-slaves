import { describe, expect, test } from 'bun:test';
import type { EngineEvent, Target } from '../../../shared/protocol.ts';
import type { Card } from '../../src/cards/store.ts';
import { gchatText, Notifier, notifyTitle, ROUTES, type NotifierDeps } from '../../src/notify/notify.ts';
import { sameTarget } from '../../src/server/ws.ts';
import { sessionTarget } from '../../src/server/session-views.ts';

const ask = (o: Partial<Card> = {}, q = 'Chọn cách sửa lỗi build?'): Card => ({
  id: 12, kind: 'ask', projectId: 'p', sessionId: 's', requestId: null, status: 'open', createdAt: 1, resolvedAt: null, answer: null,
  payload: { source: 'D2', question: q, options: [{ label: 'Sửa nhanh' }, { label: 'Viết lại' }], recommended: 'Sửa nhanh', context: 'BÍ MẬT context' },
  ...o,
});
const perm = (): Card => ({
  id: 13, kind: 'permission', projectId: 'p', sessionId: 's', requestId: 'r', status: 'open', createdAt: 1, resolvedAt: null, answer: null,
  payload: { source: 'D2', title: 'D2 xin chạy: Bash rm -rf build/', toolName: 'Bash', input: { command: 'rm -rf build/' }, description: null, suggestions: [], allowAlways: false },
});
const broken = (): Card => ({
  id: 14, kind: 'broken', projectId: 'p', sessionId: 's', requestId: null, status: 'open', createdAt: 1, resolvedAt: null, answer: null,
  payload: { title: 'Lane D2 hỏng', body: 'stack trace', actions: [], key: 'lane:D2' },
});

function world(o: { connected?: boolean; viewing?: boolean; webhook?: string | null; sendCmd?: boolean; remote?: boolean; notify?: unknown; sound?: boolean } = {}) {
  const events: EngineEvent[] = [];
  const osa: string[] = [];
  const posts: { url: string; text: string }[] = [];
  const deps: NotifierDeps = {
    project: () => ({ name: 'Shop', gchatWebhook: o.webhook === undefined ? 'https://chat.googleapis.com/hook' : o.webhook, gchatSendCommandText: o.sendCmd ?? false }),
    projectIds: () => ['p'],
    targetOf: (c) => ({ kind: 'lane', projectId: c.projectId!, name: 'D2' }),
    emit: (e) => events.push(e),
    appConnected: () => o.connected ?? true,
    viewing: (_t: Target) => o.viewing ?? false,
    osascript: (t, b) => osa.push(`${t}|${b}`),
    postGchat: async (url, text) => { posts.push({ url, text }); },
    remote: () => ({ enabled: o.remote ?? false, hostname: o.remote ? 'ccs.example.com' : null }),
    prefs: () => ({ notify: o.notify, sound: o.sound }),
  };
  return { n: new Notifier(deps), events, osa, posts };
}
const notifies = (e: EngineEvent[]) => e.filter((x) => x.type === 'notify');

describe('§8.3 routing table', () => {
  test('table rows', () => {
    expect(ROUTES.ask).toEqual({ sound: true, mac: true, gchat: true });
    expect(ROUTES.permission).toEqual({ sound: true, mac: true, gchat: true });
    expect(ROUTES.broken).toEqual({ sound: false, mac: true, gchat: true });
    expect(ROUTES.orchestrator_down).toEqual({ sound: false, mac: true, gchat: true });
    expect(ROUTES.logged_out).toEqual({ sound: false, mac: true, gchat: true });
    expect(ROUTES.all_full).toEqual({ sound: false, mac: true, gchat: true });
    expect(ROUTES.lane_done).toEqual({ sound: true, mac: true, gchat: false });
    expect(ROUTES.account_switch).toEqual({ sound: false, mac: false, gchat: false });
  });

  test('§8.3 ask card: app connected → notify event (mac + sound), gchat post, no osascript', async () => {
    const w = world();
    await w.n.card(ask());
    expect(notifies(w.events)).toEqual([{ type: 'notify', kind: 'ask', title: 'Shop · D2', body: 'Chọn cách sửa lỗi build?', sound: true, mac: true, cardId: 12, projectId: 'p', lane: 'D2' }]);
    expect(w.osa).toEqual([]);
    expect(w.posts.length).toBe(1);
  });

  test('§8.3 no app connected → osascript fallback', async () => {
    const w = world({ connected: false });
    await w.n.card(broken());
    expect(w.osa).toEqual(['Shop · D2|Lane D2 hỏng']);
  });

  test('§8.3 R10 PO viewing that lane → no macOS notification (event keeps mac=false, no osascript)', async () => {
    const off = world({ viewing: true, connected: false });
    await off.n.card(ask());
    expect(off.osa).toEqual([]);
    const on = world({ viewing: true, connected: true });
    await on.n.card(ask());
    expect(notifies(on.events)[0]).toMatchObject({ mac: false, sound: true });
  });

  test('§8.3 no webhook → no post', async () => {
    const w = world({ webhook: null });
    await w.n.card(ask());
    expect(w.posts).toEqual([]);
  });

  test('§8.3 lane done → toast + sound + mac, no gchat; account switch → toast only', async () => {
    const w = world();
    await w.n.laneDone('p', 'D2');
    await w.n.accountSwitch('p', 'D2', 'b@x');
    expect(w.events.filter((e) => e.type === 'toast').length).toBe(2);
    expect(notifies(w.events)).toEqual([{ type: 'notify', kind: 'lane_done', title: 'Shop · D2', body: 'D2 đã xong', sound: true, mac: true, projectId: 'p', lane: 'D2' }]);
    expect(w.posts).toEqual([]);
  });

  test('§8.3 all full: once per episode (mac + gchat), again after an account frees up', async () => {
    const w = world();
    await w.n.accountsFull(true);
    await w.n.accountsFull(true);
    expect(notifies(w.events).length).toBe(1);
    expect(w.posts.length).toBe(1);
    await w.n.accountsFull(false);
    await w.n.accountsFull(true);
    expect(notifies(w.events).length).toBe(2);
    expect(w.posts.length).toBe(2);
  });
});

describe('§8.3 N6 Google Chat text', () => {
  const remoteOff = { enabled: false, hostname: null };
  test('N6 ask: project · lane · kind · question · option labels; never context', () => {
    const t = gchatText(ask(), { name: 'Shop', gchatSendCommandText: false }, remoteOff);
    expect(t).toBe('Shop · D2 · Câu hỏi · Chọn cách sửa lỗi build? · Sửa nhanh / Viết lại');
    expect(t).not.toContain('BÍ MẬT');
  });
  test('N6 question clipped to ≤ 200 chars', () => {
    const t = gchatText(ask({}, 'q'.repeat(400)), { name: 'Shop', gchatSendCommandText: false }, remoteOff);
    const q = t.split(' · ')[3]!;
    expect(q.length).toBeLessThanOrEqual(200);
    expect(q.endsWith('…')).toBe(true);
  });
  test('N6 permission: only "D2 xin chạy Bash" unless the project opts in', () => {
    const off = gchatText(perm(), { name: 'Shop', gchatSendCommandText: false }, remoteOff);
    expect(off).toBe('Shop · D2 · Xin quyền · D2 xin chạy Bash');
    expect(off).not.toContain('rm -rf');
    const on = gchatText(perm(), { name: 'Shop', gchatSendCommandText: true }, remoteOff);
    expect(on).toContain('rm -rf build/');
  });
  test('N6 link /c/<id> only when remote access is on', () => {
    expect(gchatText(ask(), { name: 'Shop', gchatSendCommandText: false }, { enabled: true, hostname: 'ccs.example.com' }))
      .toEndWith(' · https://ccs.example.com/c/12');
    expect(gchatText(ask(), { name: 'Shop', gchatSendCommandText: false }, { enabled: false, hostname: 'ccs.example.com' })).not.toContain('https://');
  });
  test('N6 system card: no body (may hold stack traces / paths)', () => {
    const t = gchatText(broken(), { name: 'Shop', gchatSendCommandText: false }, remoteOff);
    expect(t).toBe('Shop · Lane hỏng · Lane D2 hỏng');
    expect(t).not.toContain('stack');
  });
});

describe('§4.15 §4 notifications with several sessions', () => {
  const orchCard = (sid: string): Card => ({ ...broken(), id: 20, kind: 'orchestrator_down', sessionId: sid, payload: { title: 'Điều phối #4 ngừng', body: '', actions: [], key: `orchestrator:${sid}` } });
  function multi(o: { seq: number | null; watch: Target | null }) {
    const events: EngineEvent[] = [];
    const posts: string[] = [];
    const deps: NotifierDeps = {
      project: () => ({ name: 'hagenta', gchatWebhook: 'https://chat/hook', gchatSendCommandText: false }),
      projectIds: () => ['p'],
      // the engine's real mapping: orchestrator sessions s3 / s4, lane session sl → H2
      targetOf: (c) => sessionTarget(c.sessionId, (x) => (x === 'sl' ? { projectId: 'p', name: 'H2' } : null), (x) => (x.startsWith('s') ? { projectId: 'p' } : null)),
      emit: (e) => events.push(e), appConnected: () => true,
      viewing: (t) => o.watch !== null && sameTarget(o.watch, t),
      seqOf: () => o.seq,
      osascript: () => {}, postGchat: async (_u, text) => { posts.push(text); }, remote: () => ({ enabled: false, hostname: null }),
    };
    return { n: new Notifier(deps), events, posts };
  }

  test('§4.15 §4 title "project · #n · lane" when > 1 running (the "#n" once, no separate seq field); Google Chat same pattern', async () => {
    const w = multi({ seq: 4, watch: null });
    await w.n.card(ask({ sessionId: 'sl' }, 'rollback 2.3?'));
    const e = notifies(w.events)[0]!;
    expect(e).toEqual({ type: 'notify', kind: 'ask', title: 'hagenta · #4 · H2', body: 'rollback 2.3?', sound: true, mac: true, cardId: e.cardId, projectId: 'p', lane: 'H2' });
    expect(w.posts[0]!.startsWith('hagenta · #4 · D2 · ')).toBe(true);
  });

  test('§4.15 §4 one running session → no "#n" anywhere', async () => {
    const w = multi({ seq: null, watch: null });
    await w.n.card(ask({ sessionId: 'sl' }, 'rollback 2.3?'));
    const e = notifies(w.events)[0]!;
    expect(e).toMatchObject({ title: 'hagenta · H2' });
    expect(w.posts[0]!.startsWith('hagenta · D2 · ')).toBe(true);
    expect(notifyTitle('hagenta', null, 'H2')).toBe('hagenta · H2');
    expect(notifyTitle('hagenta', 4, 'H2')).toBe('hagenta · #4 · H2');
  });

  test('§4.15 §4 R10 per node: watching root #3 does not suppress #4\'s card; watching #4 does', async () => {
    const w3 = multi({ seq: 4, watch: { kind: 'orchestrator', projectId: 'p', sessionId: 's3' } });
    await w3.n.card(orchCard('s4'));
    expect(notifies(w3.events)[0]).toMatchObject({ mac: true });
    const w4 = multi({ seq: 4, watch: { kind: 'orchestrator', projectId: 'p', sessionId: 's4' } });
    await w4.n.card(orchCard('s4'));
    expect(notifies(w4.events)[0]).toMatchObject({ mac: false });
  });

  test('§4.15 §4 R10 per node: watching root #3 does not suppress a card of lane H2 (owned by #4)', async () => {
    const w = multi({ seq: 4, watch: { kind: 'orchestrator', projectId: 'p', sessionId: 's3' } });
    await w.n.card(ask({ sessionId: 'sl' }));
    expect(notifies(w.events)[0]).toMatchObject({ mac: true });
  });
});

describe('Cài đặt › Thông báo matrix (config.notify + config.sound) is read at send time', () => {
  test('ask: macOS off → event mac=false, no osascript; Google Chat off → no post; Trong app off → no sound', async () => {
    const w = world({ notify: { ask: { macos: false, gchat: false, app: false } } });
    await w.n.card(ask());
    await w.n.card(perm()); // permission follows the "ask" row
    expect(notifies(w.events).map((e) => e.type === 'notify' && [e.kind, e.sound, e.mac])).toEqual([['ask', false, false], ['permission', false, false]]);
    expect(w.posts).toEqual([]);
    const off = world({ connected: false, notify: { ask: { macos: false } } });
    await off.n.card(ask());
    expect(off.osa).toEqual([]);
  });

  test('config.sound false → no sound; mac + Google Chat unchanged', async () => {
    const w = world({ sound: false });
    await w.n.card(ask());
    expect(notifies(w.events)[0]).toMatchObject({ sound: false, mac: true });
    expect(w.posts.length).toBe(1);
  });

  test('broken: Google Chat off → no post, macOS still on', async () => {
    const w = world({ notify: { broken: { gchat: false } } });
    await w.n.card(broken());
    expect(w.posts).toEqual([]);
    expect(notifies(w.events)[0]).toMatchObject({ kind: 'broken', mac: true });
  });

  test('lane done: Google Chat can be switched on; Trong app off → no toast, no sound', async () => {
    const w = world({ notify: { lane_done: { gchat: true, app: false } } });
    await w.n.laneDone('p', 'D2');
    expect(w.posts).toEqual([{ url: 'https://chat.googleapis.com/hook', text: 'Shop · D2 đã xong' }]);
    expect(w.events.filter((e) => e.type === 'toast')).toEqual([]);
    expect(notifies(w.events)[0]).toMatchObject({ kind: 'lane_done', sound: false, mac: true });
  });

  test('account switch: macOS + Google Chat switched on → notify mac + post; Trong app off → no toast', async () => {
    const w = world({ notify: { switch: { macos: true, gchat: true, app: false } } });
    await w.n.accountSwitch('p', 'D2', 'b@x');
    expect(notifies(w.events)).toEqual([expect.objectContaining({ kind: 'account_switch', mac: true, sound: false })]);
    expect(w.posts.length).toBe(1);
    expect(w.events.filter((e) => e.type === 'toast')).toEqual([]);
  });

  test('all full: Google Chat off → no post; macOS off → mac=false', async () => {
    const w = world({ notify: { all_full: { gchat: false, macos: false } } });
    await w.n.accountsFull(true);
    expect(w.posts).toEqual([]);
    expect(notifies(w.events)[0]).toMatchObject({ kind: 'all_full', mac: false });
  });
});
