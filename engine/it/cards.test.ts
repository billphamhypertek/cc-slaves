import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { join } from 'node:path';
import { EXPIRE_TEXT, type CardEvent } from '../src/cards/store.ts';
import { getLane } from '../src/db.ts';
import { ManualTimers, reach, SCENARIOS, startArgs, until, world, type World } from './_cards-setup.ts';
import { rejects } from '../test/_fixtures/rejects.ts';

setDefaultTimeout(20_000);
const PERM = join(SCENARIOS, 'permission-request.json');
let w: World | null = null;
afterEach(async () => { await w?.close(); w = null; });

const openPermission = (x: World) => x.cards.list({ status: 'open' }).find((c) => c.kind === 'permission');

describe('permission cards on a real session (§6.15 F15, §3.3-13/14)', () => {
  test('§3.3-13 control_request → card → allow → control_response reaches the process → turn finishes', async () => {
    w = world({ scenario: () => PERM });
    const events: CardEvent[] = [];
    w.cards.on((e) => events.push(e));
    const x = w;
    await x.m.start(startArgs(x, 'D2'));
    await until(() => openPermission(x) !== undefined, 'permission card');
    const c = openPermission(x)!;
    const sid = getLane(x.db, 'p1', 'D2')!.sessionId!;
    expect(c).toMatchObject({ sessionId: sid, projectId: 'p1', payload: { title: 'D2 xin chạy: Write s1-c.txt', allowAlways: true } });
    expect(events[0]).toMatchObject({ type: 'card_created', card: { id: c.id } });
    await x.cards.answer(c.id, { behavior: 'allow' });
    await reach(x, 'D2', 'idle');
    expect(x.m.result('p1', 'D2')).toBe('Đã ghi file.'); // the allow branch ran: the response reached the process
    expect(x.cards.get(c.id)!.status).toBe('answered');
    expect(x.db.query('SELECT COUNT(*) AS n FROM outbox WHERE text LIKE ?').get('%#%')).toEqual({ n: 0 }); // never an outbox message
  });

  test('§3.3-14 interrupt while the permission is pending → control_cancel_request → card cancelled; late answer refused', async () => {
    w = world({ scenario: () => PERM });
    const x = w;
    await x.m.start(startArgs(x, 'D2'));
    await until(() => openPermission(x) !== undefined, 'permission card');
    const c = openPermission(x)!;
    await x.m.interrupt('p1', 'D2');
    await until(() => x.cards.get(c.id)!.status === 'cancelled', 'cancelled');
    await rejects(x.cards.answer(c.id, { behavior: 'allow' })).toMatchObject({ code: 'cancelled' });
    await reach(x, 'D2', 'idle');
    expect(x.m.get('p1', 'D2')!.failCount).toBe(0);
  });

  test('§6.15 expiry 30 min → deny "PO chưa trả lời trong 30 phút" reaches the process; late answer → expired', async () => {
    const timers = new ManualTimers();
    w = world({ scenario: () => PERM, cardTimers: timers });
    const x = w;
    await x.m.start(startArgs(x, 'D2'));
    await until(() => openPermission(x) !== undefined, 'permission card');
    const c = openPermission(x)!;
    expect(timers.pending.map((t) => t.ms)).toEqual([1_800_000]);
    timers.fireAll();
    expect(x.cards.get(c.id)).toMatchObject({ status: 'expired', answer: { behavior: 'deny', reason: EXPIRE_TEXT } });
    await reach(x, 'D2', 'idle');
    expect(x.m.result('p1', 'D2')).toBe('Không được ghi.'); // the deny branch ran
    await rejects(x.cards.answer(c.id, { behavior: 'allow' })).toMatchObject({ code: 'expired' });
  });

  test('§6.15 the lane is stopped while the permission is pending → process gone → card cancelled', async () => {
    w = world({ scenario: () => PERM });
    const x = w;
    await x.m.start(startArgs(x, 'D2'));
    await until(() => openPermission(x) !== undefined, 'permission card');
    const c = openPermission(x)!;
    await x.m.stop('p1', 'D2', 'now');
    await until(() => x.cards.get(c.id)!.status === 'cancelled', 'cancelled on exit');
    expect(x.m.writeControl(c.sessionId!, '{}\n')).toBe(false);
  });
});
