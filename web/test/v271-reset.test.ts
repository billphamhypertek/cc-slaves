// v2.7.1 §4.5 / L8: one reset formatter "HH:MM dd/mm" everywhere (no weekday, no hour-only form); D103 Ultra = no 5-hour text.
import { describe, expect, test } from 'bun:test';
import { makeT } from '../../shared/i18n/index.ts';
import { fmtResetTime } from '../src/lib/format.ts';
import { laneLine2 } from '../src/deck/cards.ts';
import { switchOptions } from '../src/lib/accounts.ts';
import { runLocal } from '../src/ui/localCmd.ts';
import { account, lane, snapshot } from './fixtures.ts';
const VI = makeT('vi');

describe('v2.7.1 L8 fmtResetTime', () => {
  test('today keeps the date: "13:20 17/11" (the hour-only form is gone)', () => {
    expect(fmtResetTime(new Date(2026, 10, 17, 13, 20).getTime())).toBe('13:20 17/11');
  });
  test('tomorrow / another month / another year: HH:MM dd/mm, never a weekday', () => {
    expect(fmtResetTime(new Date(2026, 10, 18, 5, 59).getTime())).toBe('05:59 18/11');
    expect(fmtResetTime(new Date(2026, 11, 1, 0, 5).getTime())).toBe('00:05 01/12');
    expect(fmtResetTime(new Date(2027, 0, 2, 21, 40).getTime())).toBe('21:40 02/01');
    expect(fmtResetTime(new Date(2026, 10, 18, 5, 59).getTime())).not.toMatch(/T\d|CN/);
  });
  test('VN time zone (UTC+7): 22:59 UTC 17/11 reads "05:59 18/11"', () => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone; // restore the runner's zone exactly (deleting TZ does not)
    process.env.TZ = 'Asia/Ho_Chi_Minh';
    try { expect(fmtResetTime(Date.UTC(2026, 10, 17, 22, 59))).toBe('05:59 18/11'); } finally { process.env.TZ = tz; }
  });
  test('unknown reset → null (the caller drops the item)', () => {
    expect(fmtResetTime(null)).toBeNull();
  });
});

describe('v2.7.1 L8 callers print the new form', () => {
  const at = new Date(2026, 10, 20, 21, 40).getTime();
  test('lane node "Chờ quota · reset …" = HH:MM dd/mm', () => {
    const accs = [account('a@x', { full: true, headroomPct: 0, weekResetsAt: at })];
    expect(laneLine2(lane('D2', { state: 'waiting_quota' }), [], accs, VI)).toEqual({ kind: 'quota', at: '21:40 20/11' });
  });
  test('switch menu: a full account says when it reopens with the date', () => {
    const o = switchOptions(VI, lane('D2', { account: 'pm@x' }), [account('pm@x'), account('b@x', { full: true, headroomPct: 0, weekResetsAt: at })]);
    expect(o.find(x => x.email === 'b@x')!.reason).toContain('21:40 20/11');
    expect(o.find(x => x.email === 'b@x')!.reason).not.toMatch(/\bT\d\b/);
  });
  test('/quota in the composer: the reset reads HH:MM dd/mm, never a weekday', () => {
    const out: string[] = [], snap = snapshot({ accounts: [account('b@x', { full: true, headroomPct: 0, weekResetsAt: at })] });
    runLocal('quota', { target: { kind: 'orchestrator', projectId: 'p1' } as never, pid: 'p1', snap, project: snap.projects[0]!, lanes: [],
      store: { localLine: (_t: unknown, l: { text: string }) => out.push(l.text) } as never, tr: VI, send: () => Promise.resolve() });
    expect(out).toEqual([expect.stringContaining('· reset 21:40 20/11')]);
  });
});
