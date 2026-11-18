// spec v2.3 §6 / §7 / §10.2 the Git view's read machinery, pure: the seq-guarded reader, the shown gate, git_branches per
// project (web review I1 / I2 race), the R17 not-a-repo marker, the window-hidden gate (M3) and the rev clock (M4).
import { describe, expect, test } from 'bun:test';
import type { Command, GitBranchesResult } from '../../../shared/protocol.ts';
import { askBranches, gitShown, isNotRepo, reader, RevClock, shownGate, type Got } from '../../src/git/useGit.ts';

const deferred = <T>() => {
  let res!: (v: T) => void, rej!: (e: unknown) => void;
  const p = new Promise<T>((a, b) => { res = a; rej = b; });
  return { p, res, rej };
};
const tick = () => new Promise(r => setTimeout(r, 0));
const A: GitBranchesResult = { base: { name: 'main', unpushed: 0 }, lanes: [{ lane: 'D1', name: 'lane/d1', branch: null }] };
const NOT_REPO: GitBranchesResult = { base: null, lanes: [], notRepo: true };

/** A Git view as the hooks drive it: one reader + one gate, `show(projectId)` = a render of that project with rev 0. */
function view() {
  let got: Got<GitBranchesResult> = { v: null, err: null };
  const asks = new Map<string, ReturnType<typeof deferred<unknown>>[]>();
  const send = (c: Command) => { const d = deferred<unknown>(); const id = (c as { projectId: string }).projectId; const list = asks.get(id) ?? []; list.push(d); asks.set(id, list); return d.p; };
  const load = reader<GitBranchesResult>(f => { got = f(got); }, e => String((e as Error).message));
  const gate = shownGate();
  return {
    show(projectId: string, rev = 0) {
      const r = gate({ shown: true, open: true, sig: `${rev}|${projectId}`, key: projectId });
      if (r) askBranches({ send, projectId }, load)(r.same);
    },
    ask: (id: string, i = 0) => asks.get(id)![i]!,
    get got() { return got; },
  };
}

describe('§10.2 reader + gate (web review I1 / I2)', () => {
  test('§10.2 I1 a late git_timeout of project A never paints on B, and B never keeps A\'s branches', async () => {
    const v = view();
    v.show('A'); v.ask('A').res(A); await tick();
    expect(v.got.v).toBe(A);
    v.show('A', 1); // a re-read of A (rev bump) that will time out late
    v.show('B');
    expect(v.got).toEqual({ v: null, err: null }); // B starts empty: A's list is not kept
    v.ask('A', 1).rej(new Error('quá 5 s')); await tick();
    expect(v.got).toEqual({ v: null, err: null });
    v.ask('B').rej(new Error('B timeout')); await tick();
    expect(v.got).toEqual({ v: null, err: 'B timeout' }); // B's own error shows, with nothing of A under it
  });

  test('§7 G7 I2 a late not-a-repo answer of project A never turns git project B into G7', async () => {
    const v = view();
    v.show('A');
    v.show('B'); v.ask('B').res(A); await tick();
    v.ask('A').res(NOT_REPO); await tick();
    expect(isNotRepo(v.got.v)).toBe(false);
    expect(v.got.v).toBe(A);
  });

  test('§10.2 a re-read of the same project keeps the list on screen while it loads and under its error', async () => {
    const v = view();
    v.show('A'); v.ask('A').res(A); await tick();
    v.show('A', 1);
    expect(v.got.v).toBe(A);
    v.ask('A', 1).rej(new Error('x')); await tick();
    expect(v.got).toEqual({ v: A, err: 'x' });
  });

  test('§10.2 the gate: nothing while hidden or offline, once per sig, and a hidden change runs on the next show', () => {
    const g = shownGate();
    expect(g({ shown: false, open: true, sig: '0|A', key: 'A' })).toBeNull();
    expect(g({ shown: true, open: false, sig: '0|A', key: 'A' })).toBeNull();
    expect(g({ shown: true, open: true, sig: '0|A', key: 'A' })).toEqual({ same: false });
    expect(g({ shown: true, open: true, sig: '0|A', key: 'A' })).toBeNull();
    expect(g({ shown: true, open: true, sig: '1|A', key: 'A' })).toEqual({ same: true });
    expect(g({ shown: true, open: true, sig: '1|B', key: 'B' })).toEqual({ same: false });
  });
});

describe('§7 G7 R17 not a git repo', () => {
  test('§7 G7 only the engine marker counts (no stderr parsing in the web)', () => {
    expect(isNotRepo(NOT_REPO)).toBe(true);
    expect(isNotRepo(A)).toBe(false);
    expect(isNotRepo(null)).toBe(false);
  });
});

describe('§10.2 M3 window hidden', () => {
  test('§10.2 M3 the Git view counts as shown only while its mode shows and the window is visible', () => {
    expect(gitShown(true, false)).toBe(true);
    expect(gitShown(true, true)).toBe(false);
    expect(gitShown(false, false)).toBe(false);
  });
});

describe('§10.2 M4 / V17 rev clock', () => {
  test('§10.2 M4 the first show reads at rev 0 only (no bump, one git_branches), even after a change while never shown', () => {
    const t = 1_000_000;
    const c = new RevClock(() => t);
    expect(c.changed(false)).toBe(false);
    expect(c.show()).toBe(false);
  });
  test('§10.2 V17 a later show bumps past 60 s or after a change while hidden; focus only past 60 s', () => {
    let t = 1_000_000;
    const c = new RevClock(() => t);
    c.show();
    t += 30_000;
    expect(c.show()).toBe(false);
    expect(c.focus(true)).toBe(false);
    expect(c.changed(false)).toBe(false);
    expect(c.show()).toBe(true);
    c.read();
    t += 61_000;
    expect(c.focus(false)).toBe(false);
    expect(c.focus(true)).toBe(true);
    expect(c.show()).toBe(true);
    expect(c.changed(true)).toBe(true);
  });
});
