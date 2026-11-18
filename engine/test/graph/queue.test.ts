// v2.5 §5.5 the index queue over an in-memory port (no tool): one job at a time engine-wide, one job per directory, the user
// first, Dừng (queued → dropped; running → cancelled, the queue waits until the tool leaves running), the 30-min limit (then
// "Quá hạn — công cụ vẫn đang index" while the tool goes on), R4 tool-run jobs, a lost index front, delete jobs in line.
import { describe, expect, test } from 'bun:test';
import { IndexQueue, type QueuePort, type RunEnd } from '../../src/graph/queue.ts';

interface Run { root: string; args: unknown; end: (r: RunEnd) => void; lose: () => void; cancelled: boolean }

function port() {
  const runs: Run[] = [];
  const tool = new Map<string, string>(); // root → the tool's status:true state
  const removed: string[] = [];
  const failRemove = new Set<string>();
  const p: QueuePort = {
    run(root, args) {
      let end!: (r: RunEnd) => void; let lose!: () => void;
      const done = new Promise<RunEnd>((ok, fail) => { end = ok; lose = () => fail(new Error('front gone')); });
      const r: Run = { root, args, end, lose, cancelled: false };
      runs.push(r);
      tool.set(root, 'running');
      return { done, cancel: () => { r.cancelled = true; } };
    },
    status: async (root) => tool.get(root) ?? 'idle',
    remove: async (name) => { removed.push(name); return failRemove.has(name) ? { ok: false, line: `cannot delete ${name}` } : { ok: true }; },
  };
  return { p, runs, tool, removed, failRemove };
}
const tick = (ms = 15) => Bun.sleep(ms);
const q = (p: QueuePort, o: Partial<{ timeoutMs: number }> = {}) => new IndexQueue(p, { pollMs: 5, ...o });

describe('§5.5 IndexQueue', () => {
  test('one job at a time; ahead counts the running job and the queued ones before', async () => {
    const f = port(); const iq = q(f.p);
    expect(iq.add('/a')).toEqual({ ahead: 0 });
    expect(iq.add('/b')).toEqual({ ahead: 1 });
    expect(iq.add('/c', { mode: 'fast' })).toEqual({ ahead: 2 });
    await tick();
    expect(f.runs.map((r) => r.root)).toEqual(['/a']);
    expect(iq.state('/a')?.state).toBe('running');
    expect(iq.state('/b')).toMatchObject({ state: 'queued', ahead: 1 });
    f.tool.set('/a', 'succeeded'); f.runs[0]!.end({ ok: true });
    await tick();
    expect(iq.state('/a')?.state).toBe('done');
    expect(f.runs.map((r) => r.root)).toEqual(['/a', '/b']);
  });

  test('one job per directory: a second add of a queued or running dir merges (no second run)', async () => {
    const f = port(); const iq = q(f.p);
    iq.add('/a'); iq.add('/b');
    expect(iq.add('/b')).toEqual({ ahead: 1 });
    await tick();
    expect(iq.add('/a')).toEqual({ ahead: 0 });
    f.runs[0]!.end({ ok: true }); await tick();
    f.runs[1]!.end({ ok: true }); await tick();
    expect(f.runs.map((r) => r.root)).toEqual(['/a', '/b']);
  });

  test('the user goes first: a first:true job runs before automatic ones already queued', async () => {
    const f = port(); const iq = q(f.p);
    iq.add('/a'); iq.add('/b'); iq.add('/c');
    expect(iq.add('/c', {}, true)).toEqual({ ahead: 1 });
    await tick(); f.runs[0]!.end({ ok: true }); await tick();
    expect(f.runs.map((r) => r.root)).toEqual(['/a', '/c']);
  });

  test('the args go with the job (mode / persistence); a failure keeps the tool line', async () => {
    const f = port(); const iq = q(f.p);
    iq.add('/a', { mode: 'moderate', persistence: false });
    await tick();
    expect(f.runs[0]!.args).toEqual({ mode: 'moderate', persistence: false });
    f.runs[0]!.end({ ok: false, line: 'repo too large' }); await tick();
    expect(iq.state('/a')).toMatchObject({ state: 'failed', error: 'repo too large' });
  });

  test('Dừng on a queued job drops it; on a running one cancels, shows stopping until the tool leaves running, then cancelled', async () => {
    const f = port(); const iq = q(f.p);
    iq.add('/a'); iq.add('/b'); iq.add('/c');
    expect(iq.stop('/b')).toBe(true);
    expect(iq.state('/b')).toBeNull();
    await tick();
    expect(iq.stop('/a')).toBe(true);
    expect(f.runs[0]!.cancelled).toBe(true);
    f.tool.set('/a', 'cancelling'); f.runs[0]!.end({ ok: false, line: 'Request cancelled' });
    await tick(30);
    expect(iq.state('/a')?.state).toBe('stopping');
    expect(f.runs).toHaveLength(1); // A2: nothing next while the tool still works on /a
    f.tool.set('/a', 'cancelled'); await tick(30);
    expect(iq.state('/a')?.state).toBe('cancelled');
    expect(f.runs.map((r) => r.root)).toEqual(['/a', '/c']);
  });

  test('30-min limit (not counting the wait): cancel → failed "hết giờ"; cancel that does not take → overdue, the queue waits', async () => {
    const f = port(); const iq = q(f.p, { timeoutMs: 60 });
    iq.add('/a'); iq.add('/b');
    await Bun.sleep(40);
    expect(f.runs[0]!.cancelled).toBe(false);
    await Bun.sleep(50);
    expect(f.runs[0]!.cancelled).toBe(true);
    f.runs[0]!.end({ ok: false, line: 'Request cancelled' }); // the reply came, the tool goes on
    await tick(30);
    expect(iq.state('/a')).toMatchObject({ state: 'running', overdue: true });
    expect(f.runs).toHaveLength(1);
    f.tool.set('/a', 'succeeded'); await tick(30);
    expect(iq.state('/a')).toMatchObject({ state: 'failed', error: 'hết giờ' });
    expect(f.runs.map((r) => r.root)).toEqual(['/a', '/b']);
  });

  test('R4: a tool-run job is running by the tool; Dừng is refused; the next job waits until status leaves running', async () => {
    const f = port(); const iq = q(f.p);
    f.tool.set('/t', 'running');
    iq.adopt('/t'); iq.add('/b');
    expect(iq.state('/t')).toMatchObject({ state: 'running', by: 'tool' });
    expect(iq.stop('/t')).toBe(false);
    await tick(30);
    expect(f.runs).toHaveLength(0);
    f.tool.set('/t', 'succeeded'); await tick(30);
    expect(iq.state('/t')?.state).toBe('done');
    expect(f.runs.map((r) => r.root)).toEqual(['/b']);
  });

  test('R4: the tool may not have started yet at the spawn — idle within the grace is not the end of the job', async () => {
    const f = port(); const iq = new IndexQueue(f.p, { pollMs: 5, graceMs: 40 });
    iq.adopt('/t'); iq.add('/b');
    await tick(20);
    expect(iq.state('/t')?.state).toBe('running');
    f.tool.set('/t', 'running'); await tick(30);
    f.tool.set('/t', 'succeeded'); await tick(20);
    expect(iq.state('/t')?.state).toBe('done');
    iq.adopt('/never'); // the tool runs it by itself even while /b runs: shown running, never queued
    expect(iq.state('/never')).toMatchObject({ state: 'running', by: 'tool' });
    f.runs[0]!.end({ ok: true }); await tick(80); // never started within the grace: the queue goes on
    expect(iq.state('/never')?.state).toBe('cancelled');
  });

  test('the index front is lost mid-run: the tool says succeeded → done; else re-queued once at the head, then failed', async () => {
    const f = port(); const iq = q(f.p);
    iq.add('/a'); iq.add('/b');
    await tick();
    f.tool.set('/a', 'succeeded'); f.runs[0]!.lose(); await tick(30);
    expect(iq.state('/a')?.state).toBe('done');
    f.runs[1]!.end({ ok: true }); await tick();
    iq.add('/c'); iq.add('/d'); await tick();
    f.tool.set('/c', 'cancelled'); f.runs[2]!.lose(); await tick(30);
    expect(f.runs.map((r) => r.root)).toEqual(['/a', '/b', '/c', '/c']);
    f.tool.set('/c', 'failed'); f.runs[3]!.lose(); await tick(30);
    expect(iq.state('/c')).toMatchObject({ state: 'failed', error: 'front gone' });
    expect(f.runs.at(-1)!.root).toBe('/d');
  });

  test('delete jobs wait their turn behind a running index; one failure does not stop the next', async () => {
    const f = port(); const iq = q(f.p);
    f.failRemove.add('x');
    iq.add('/a');
    const r1 = iq.remove('x'); const r2 = iq.remove('y');
    await tick();
    expect(f.removed).toEqual([]);
    f.runs[0]!.end({ ok: true });
    expect(await r1).toEqual({ ok: false, line: 'cannot delete x' });
    expect(await r2).toEqual({ ok: true });
    expect(f.removed).toEqual(['x', 'y']);
  });

  test('reply(): the lane view of a dir — queued with ahead, running with started_at, last result in the tool words; unseen → null', async () => {
    const f = port(); const iq = q(f.p);
    expect(iq.reply('/a')).toBeNull();
    iq.add('/a'); iq.add('/b');
    expect(iq.reply('/b')).toEqual({ state: 'queued', repo_path: '/b', ahead: 1 });
    await tick();
    expect(iq.reply('/a')).toMatchObject({ state: 'running', repo_path: '/a', started_at: expect.any(String) });
    f.runs[0]!.end({ ok: false, line: 'boom' }); await tick();
    expect(iq.reply('/a')).toEqual({ state: 'failed', repo_path: '/a', error: 'boom' });
    f.runs[1]!.end({ ok: true }); await tick();
    expect(iq.reply('/b')).toEqual({ state: 'succeeded', repo_path: '/b' });
  });

  test('onChange: a push when a job is queued, starts, is stopped and ends — `true` only when a job ended (the view re-reads its numbers)', async () => {
    const f = port(); const seen: boolean[] = [];
    const iq = new IndexQueue(f.p, { pollMs: 5, onChange: (ended) => seen.push(ended) });
    iq.add('/a'); iq.add('/b');
    await tick();
    expect(seen.filter((x) => !x).length).toBeGreaterThanOrEqual(3); // two queued + /a started
    expect(seen).not.toContain(true);
    const before = seen.length;
    iq.stop('/b');
    expect(seen.length).toBe(before + 1);
    const n = seen.length;
    f.tool.set('/a', 'succeeded'); f.runs[0]!.end({ ok: true });
    await tick();
    expect(seen.slice(n)).toContain(true);
  });
});
