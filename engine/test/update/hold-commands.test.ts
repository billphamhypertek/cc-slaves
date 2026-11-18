// v2.6 §5.4 dispatch of update_hold / update_commit (E1a): the handlers act for their own connection.
import { expect, test } from 'bun:test';
import type { UpdateBusy } from '../../../shared/update.ts';
import type { Engine } from '../../src/engine.ts';
import { buildHandlers } from '../../src/server/commands.ts';
import { route } from '../../src/server/router.ts';
import type { Conn } from '../../src/server/ws.ts';
import { UpdateHold } from '../../src/update/hold.ts';

function world() {
  const st: { busy: UpdateBusy[] } = { busy: [] };
  const update = new UpdateHold({ busy: () => st.busy, held: () => 0, changed: () => {}, tickMs: 0 });
  const e = { update } as unknown as Engine;
  const app: Conn = { channel: 'mac', watch: null, present: false, send: () => {} };
  const web: Conn = { channel: 'mac', watch: null, present: true, send: () => {} };
  const run = (c: Conn, command: object) => route(buildHandlers(e, c), { channel: 'mac' }, { type: 'command', id: '1', command });
  return { update, st, app, web, run };
}

test('§5.4 update_hold {on} holds for the sending connection; {on: false} from it releases', async () => {
  const w = world();
  expect(await w.run(w.app, { cmd: 'update_hold', on: true })).toEqual({ type: 'ack', id: '1' });
  expect(w.update.view().hold).toBe(true);
  await w.run(w.web, { cmd: 'update_hold', on: false });
  expect(w.update.view().hold).toBe(true);
  await w.run(w.app, { cmd: 'update_hold', on: false });
  expect(w.update.view().hold).toBe(false);
});

test('§5.4-9 update_commit: busy → ack { ok: false, busy }; idle → ack { ok: true }; no hold → error not_holding', async () => {
  const w = world();
  expect(await w.run(w.app, { cmd: 'update_commit' })).toMatchObject({ type: 'error', code: 'not_holding' });
  await w.run(w.app, { cmd: 'update_hold', on: true });
  const L: UpdateBusy = { projectId: 'p', kind: 'lane', name: 'a', turnStartedAt: 1 };
  w.st.busy = [L];
  expect(await w.run(w.app, { cmd: 'update_commit' })).toEqual({ type: 'ack', id: '1', result: { ok: false, busy: [L] } });
  w.st.busy = [];
  expect(await w.run(w.app, { cmd: 'update_commit' })).toEqual({ type: 'ack', id: '1', result: { ok: true } });
  expect(await w.run(w.web, { cmd: 'update_commit' })).toMatchObject({ type: 'error', code: 'not_holding' });
});

test('§5.4 update_hold with a non-boolean `on` → bad_input, nothing held', async () => {
  const w = world();
  expect(await w.run(w.app, { cmd: 'update_hold', on: 'yes' })).toMatchObject({ type: 'error', code: 'bad_input' });
  expect(w.update.view().hold).toBe(false);
});
