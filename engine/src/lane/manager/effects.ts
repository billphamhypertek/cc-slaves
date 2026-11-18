// LaneManager effect runner: executes one reducer effect for a lane (split from lane/manager.ts).
import { cancelCards } from '../../db.ts';
import type { LaneEffect } from '../reducer.ts';
import { pickToEvent } from '../switcher.ts';
import type { LaneManager } from '../manager.ts';
import { waitReasonOf, type Rt } from './types.ts';

export async function run(m: LaneManager, rt: Rt, ef: LaneEffect): Promise<void> {
  const { outbox } = m.d;
  const sid = rt.ctx.sessionId;
  switch (ef.type) {
    case 'write_stdin':
      if (rt.proc?.alive) { rt.proc.send(ef.text, ef.send?.prefix ?? null, ef.send?.extra); return; }
      // Ruling: the process left by itself while quiet → persist, then respawn `--resume` on the same session; the
      // resume start delivers every undelivered message.
      outbox.enqueue(sid, ef.text, ef.send?.prefix ?? null, ef.send?.extra);
      if (rt.ctx.account !== null && !m.closed) await m.spawn(rt, rt.ctx.sawAssistant ? 'resume' : 'fresh', rt.ctx.account);
      return;
    case 'enqueue_outbox':
      outbox.enqueue(sid, ef.text, ef.send?.prefix ?? null, ef.send?.extra);
      return;
    case 'flush_outbox':
      rt.proc?.flush();
      return;
    case 'interrupt':
      if (rt.proc?.alive) await rt.proc.interrupt();
      return;
    case 'close_stdin': {
      const p = m.detach(rt);
      if (!p?.alive) return;
      p.closeStdin();
      const exit = rt.procExit.get(p)!;
      const grace = m.d.closeGraceMs ?? 5000;
      const t = await Promise.race([exit.then(() => 'exited' as const), Bun.sleep(grace).then(() => 'timeout' as const)]);
      if (t === 'timeout') await p.terminate(2000);
      return;
    }
    case 'kill': {
      const p = m.detach(rt);
      if (p?.alive) await p.terminate(2000);
      return;
    }
    case 'pick_account': {
      const r = m.pickFor(rt, ef.exclude);
      rt.waitReason = waitReasonOf(r);
      await m.apply(rt, pickToEvent(r));
      return;
    }
    case 'spawn':
      if (!m.closed) await m.spawn(rt, ef.mode, ef.account);
      return;
    case 'schedule_retry':
      if (rt.retry !== null) m.timers.clear(rt.retry);
      rt.retry = m.timers.set(() => {
        rt.retry = null;
        void m.job(rt, () => m.apply(rt, { type: 'retry_timer' }));
      }, ef.seconds * 1000);
      return;
    case 'notify_orchestrator':
      m.notify(rt, ef.text);
      return;
    case 'remind_po':
      m.emit({ type: 'remind', projectId: rt.projectId, name: rt.ctx.name, text: ef.text, ...(ef.key ? { key: ef.key, params: ef.params } : {}), action: ef.action });
      return;
    case 'mark_card':
      m.emit({ type: 'card', projectId: rt.projectId, name: rt.ctx.name, cardId: ef.cardId, open: ef.open });
      return;
    case 'mark_cards_cancelled':
      cancelCards(m.d.db, ef.cardIds);
      for (const id of ef.cardIds) m.emit({ type: 'card', projectId: rt.projectId, name: rt.ctx.name, cardId: id, open: false });
      return;
    case 'account_logged_out':
      // T3 §7.1-3: an account the registry no longer has (spawn `!acct`, a v1 lane at the cutover) is not "logged out":
      // no F16 card, no note — the lane just re-picks (or waits `no_account`).
      if (!m.account(ef.account)) return;
      m.emit({ type: 'account_logged_out', projectId: rt.projectId, name: rt.ctx.name, account: ef.account });
      m.notify(rt, `[cc-slaves] account ${ef.account} bị đăng xuất — lane ${rt.ctx.name} chuyển account`);
      return;
    case 'check_cap_before_write':
      await m.apply(rt, { type: 'cap_checked', ok: m.capOk(rt) });
      return;
    case 'park_unit':
      m.emit({ type: 'park_unit', projectId: rt.projectId, name: rt.ctx.name, zone: ef.zone });
      return;
    case 'error':
      if (ef.code === 'lane_broken') m.notify(rt, `[cc-slaves] lane ${ef.text}`);
      return;
  }
}
