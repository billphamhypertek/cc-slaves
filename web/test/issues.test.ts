// v2.7 Tasks store slice (spec §4.3, §4.2-2, §5.6): specs / issues per project from the snapshot + `spec_changed` /
// `issue_changed`, the rail groups, the list blocks, unseen, progress, the typed Mac-only senders.
import { describe, expect, test } from 'bun:test';
import type { Command } from '../../shared/protocol.ts';
import {
  hasUnseen, issueBlocks, issueCmds, issuesOf, progressFor, projectIssues, readTasksUi, specRail, unseenCount, writeTasksUi,
} from '../src/lib/issues.ts';
import { Store } from '../src/lib/store.ts';
import { issueInfo as issue, poSlots, projIssues as pi, snapshot, specInfo as spec } from './fixtures.ts';

describe('§4.3 store slice: snapshot + events', () => {
  test('§10.1 spec_changed / issue_changed upsert into the project; a new project entry is created; project_removed drops it', () => {
    const s = new Store();
    s.apply({ type: 'snapshot', snapshot: snapshot({ issues: [pi([spec(1)], [issue(1)])] }) });
    s.apply({ type: 'event', event: { type: 'issue_changed', issue: issue(1, { state: 'doing' }) } });
    s.apply({ type: 'event', event: { type: 'issue_changed', issue: issue(2) } });
    s.apply({ type: 'event', event: { type: 'spec_changed', spec: spec(1, { title: 'v2.5' }) } });
    s.apply({ type: 'event', event: { type: 'spec_changed', spec: spec(9, { projectId: 'p2' }) } });
    const p1 = projectIssues(s.get().snap, 'p1')!;
    expect(p1.issues.map(i => `${i.key}:${i.state}`)).toEqual(['T-1:doing', 'T-2:todo']);
    expect(p1.specs.map(x => x.title)).toEqual(['v2.5']);
    expect(projectIssues(s.get().snap, 'p2')!.specs.map(x => x.id)).toEqual([9]);
    s.apply({ type: 'event', event: { type: 'project_removed', id: 'p1' } });
    expect(projectIssues(s.get().snap, 'p1')).toBeNull();
  });
  test('hf1117-perf a `project` event for a project with no entry adds its empty one (Tasks paints IS8 at once); a known entry is kept', () => {
    const s = new Store();
    s.apply({ type: 'snapshot', snapshot: snapshot({ issues: [pi([spec(1)], [issue(1)])] }) });
    const p2 = { id: 'p2', name: 'new', path: '/w/new', orchestratorAccount: 'a@x', gchatWebhookSet: false, gchatSendCommandText: false };
    s.apply({ type: 'event', event: { type: 'project', project: p2 } });
    expect(projectIssues(s.get().snap, 'p2')).toEqual(pi([], [], 'p2'));
    s.apply({ type: 'event', event: { type: 'project', project: { ...s.get().snap!.projects[0]!, name: 'renamed' } } });
    expect(projectIssues(s.get().snap, 'p1')!.specs.map(x => x.id)).toEqual([1]);
    const r = new Store(); // §8 the remote channel has no issues: none made up
    r.apply({ type: 'snapshot', snapshot: snapshot({ channel: 'remote' }) });
    r.apply({ type: 'event', event: { type: 'project', project: p2 } });
    expect(r.get().snap!.issues).toBeUndefined();
  });
  test('§8 remote snapshot has no issues: nothing for the project', () => {
    expect(projectIssues(snapshot({ channel: 'remote' }), 'p1')).toBeNull();
    expect(projectIssues(null, 'p1')).toBeNull();
  });
});

describe('§4.3 rail groups (fixed order, empty groups hidden)', () => {
  test('§4.3 Đang thiết kế · Chờ build · Đang build · Ngoài spec · Xong; draft/approved/active/done map to them', () => {
    const r = specRail(pi([spec(5, { state: 'done', doneAt: 5 }), spec(1, { state: 'active' }), spec(2, { state: 'draft' }), spec(3, { state: 'approved' })],
      [issue(1, { specId: null }), issue(2, { specId: null, state: 'done' })]), poSlots());
    expect(r.map(g => g.group)).toEqual(['designing', 'ready', 'building', 'outside', 'done']);
    expect(r.find(g => g.group === 'outside')!.open).toBe(1);
  });
  test('§4.3 empty groups are not shown; no outside group without outside issues', () => {
    expect(specRail(pi([spec(1, { state: 'draft' })], []), poSlots()).map(g => g.group)).toEqual(['designing']);
    expect(specRail(pi([], []), poSlots())).toEqual([]);
  });
  test('§4.3 Xong: 5 newest by doneAt + "Xem thêm n"; expanded shows every one', () => {
    const done = Array.from({ length: 7 }, (_, i) => spec(i + 1, { state: 'done', doneAt: i + 1 }));
    const g = specRail(pi(done, []), poSlots()).find(x => x.group === 'done')!;
    expect(g.specs.map(x => x.id)).toEqual([7, 6, 5, 4, 3]);
    expect(g.more).toBe(2);
    const all = specRail(pi(done, []), poSlots(), { doneOpen: true }).find(x => x.group === 'done')!;
    expect(all.specs).toHaveLength(7);
    expect(all.more).toBe(0);
  });
});

describe('§4.3 list blocks', () => {
  const list = [
    issue(1, { state: 'doing' }), issue(2), issue(3, { waitingOn: ['T-1'] }), issue(4, { state: 'done', doneAt: 4 }),
    issue(5, { state: 'cancelled' }), issue(6, { poSeen: false, source: 'lane', kind: 'bug', key: 'B-6' }),
  ];
  test('§4.3 Đang làm · Sẵn sàng · Bị chặn · Xong · Huỷ; todo waiting on an open blocker = Bị chặn', () => {
    const b = issueBlocks(list);
    expect(b.map(x => `${x.block}:${x.issues.map(i => i.key).join(',')}`)).toEqual(['doing:T-1', 'ready:T-2,B-6', 'blocked:T-3', 'done:T-4', 'cancelled:T-5']);
  });
  test('§4.3 Phát sinh only when filtered from the card: unseen issues first, out of their own block', () => {
    const b = issueBlocks(list, { arising: true });
    expect(b[0]!.block).toBe('arising');
    expect(b[0]!.issues.map(i => i.key)).toEqual(['B-6']);
    expect(b.find(x => x.block === 'ready')!.issues.map(i => i.key)).toEqual(['T-2']);
  });
  test('§4.3 + §5.4 (R-B19 M1) open blocks: priority first, then key number', () => {
    const xs = [
      issue(50, { state: 'doing', key: 'B-50', kind: 'bug' }), issue(54, { state: 'doing', priority: true }), issue(49, { state: 'doing' }),
      issue(8), issue(9, { priority: true }), issue(7, { waitingOn: ['T-1'] }), issue(3, { waitingOn: ['T-1'], priority: true }),
      issue(12, { poSeen: false }), issue(11, { poSeen: false, priority: true }),
    ];
    const keys = (b: string, o = {}) => issueBlocks(xs, o).find(x => x.block === b)!.issues.map(i => i.key);
    expect(keys('doing')).toEqual(['T-54', 'T-49', 'B-50']);
    expect(keys('ready')).toEqual(['T-9', 'T-11', 'T-8', 'T-12']);
    expect(keys('blocked')).toEqual(['T-3', 'T-7']);
    expect(keys('arising', { arising: true })).toEqual(['T-11', 'T-12']);
  });
  test('§4.3 Xong: 5 newest + more; an empty block is not listed', () => {
    const done = Array.from({ length: 8 }, (_, i) => issue(i + 1, { state: 'done', doneAt: i + 1 }));
    const b = issueBlocks(done);
    expect(b.map(x => x.block)).toEqual(['done']);
    expect(b[0]!.issues.map(i => i.key)).toEqual(['T-8', 'T-7', 'T-6', 'T-5', 'T-4']);
    expect(b[0]!.more).toBe(3);
    expect(issueBlocks(done, { doneOpen: true })[0]!.issues).toHaveLength(8);
  });
});

describe('§5.6 unseen + §4.2-2 progress', () => {
  test('§5.6 unseen = not seen by the PO and not cancelled (the engine rule)', () => {
    const p = pi([], [issue(1, { poSeen: false }), issue(2, { poSeen: false, state: 'cancelled' }), issue(3)]);
    expect(unseenCount(p)).toBe(1);
    expect(hasUnseen(snapshot({ issues: [p] }), 'p1')).toBe(true);
    expect(hasUnseen(snapshot({ issues: [pi([], [issue(3)])] }), 'p1')).toBe(false);
  });
  test('§4.2-2 progress of a spec / of the outside group goes through the one rule (progressOf)', () => {
    const p = pi([spec(1)], [issue(1, { state: 'done' }), issue(2, { source: 'lane' }), issue(3, { state: 'cancelled' }), issue(4, { specId: null })]);
    expect(issuesOf(p, { spec: 1 }).map(i => i.key)).toEqual(['T-1', 'T-2', 'T-3']);
    expect(progressFor(p, { spec: 1 })).toMatchObject({ done: 1, total: 2, scope: 1, cancelled: 1 });
    expect(progressFor(p, 'outside')).toMatchObject({ done: 0, total: 1 });
  });
});

describe('§10.1 Mac-only senders (one home)', () => {
  test('each sender builds its command with the project id', async () => {
    const sent: Command[] = [];
    const c = issueCmds(async (x: Command) => { sent.push(x); return { sessionId: 's1' }; }, 'p1');
    expect(await c.specNew()).toEqual({ sessionId: 's1' });
    await c.ok('B-50'); await c.seen('B-50'); await c.specBuild('a.md', 'cid'); await c.specBuild('a.md'); await c.specEdit('a.md');
    await c.specMark('a.md', 'approved'); await c.specScan(); await c.specImportHide(); await c.priorSessions('a.md'); await c.outputs('a.md');
    await c.cancelPreview('T-1'); await c.cancel('T-1', 'thừa');
    expect(sent.map(x => x.cmd)).toEqual(['spec_new', 'issue_ok', 'issue_seen', 'spec_build', 'spec_build', 'spec_edit', 'spec_mark', 'spec_scan',
      'spec_import_hide', 'spec_prior_sessions', 'spec_outputs', 'issue_cancel_preview', 'issue_cancel']);
    expect(sent.every(x => (x as { projectId?: string }).projectId === 'p1')).toBe(true);
    expect(sent[3]).toEqual({ cmd: 'spec_build', projectId: 'p1', path: 'a.md', resume: 'cid' });
    expect(sent[4]).toEqual({ cmd: 'spec_build', projectId: 'p1', path: 'a.md' });
    expect(sent.at(-1)).toEqual({ cmd: 'issue_cancel', projectId: 'p1', key: 'T-1', reason: 'thừa' });
  });
});

describe('§4.3 what is remembered per project (localStorage, convenience only)', () => {
  test('selection + open groups per project round-trip; a bad stored value reads as nothing', () => {
    const m = new Map<string, string>(), keys = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    expect(readTasksUi(keys, 'p1')).toEqual({ sel: null, issue: null, doneOpen: false, specDoneOpen: false, cancelledOpen: false, folded: [], arising: false });
    writeTasksUi(keys, 'p1', { sel: { spec: 3 }, issue: 'T-47', doneOpen: true, specDoneOpen: false, cancelledOpen: false, folded: ['ready'], arising: false });
    writeTasksUi(keys, 'p2', { sel: 'outside', issue: null, doneOpen: false, specDoneOpen: true, cancelledOpen: true, folded: [], arising: true });
    expect(readTasksUi(keys, 'p1')).toMatchObject({ sel: { spec: 3 }, issue: 'T-47', doneOpen: true, folded: ['ready'] });
    expect(readTasksUi(keys, 'p2')).toMatchObject({ sel: 'outside', specDoneOpen: true, cancelledOpen: true, arising: true });
    m.set('ccs.tasks', 'not json');
    expect(readTasksUi(keys, 'p1').sel).toBeNull();
    m.set('ccs.tasks', JSON.stringify({ p1: { sel: { spec: 'x' }, issue: 5 } }));
    expect(readTasksUi(keys, 'p1')).toMatchObject({ sel: null, issue: null });
  });
});
