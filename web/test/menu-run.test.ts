// v2.1 T9 §4.12: node / Inspector / F9 / account row resolve to one source → one item list; destructive items only open
// the existing confirm dialogs (no shortcut).
import { describe, expect, test } from 'bun:test';
import type { Command, OrchestratorView } from '../../shared/protocol.ts';
import { makeT } from '../../shared/i18n/index.ts';
import type { MenuAct, MenuCtx } from '../src/lib/actions.ts';
import { menuItemsFor, nodeMenuSrc, runMenuAct, type MenuHost } from '../src/ui/menuRun.ts';
import { reassignBack } from '../src/lib/sessions.ts';
import { lane, snapshot } from './fixtures.ts';

const VI = makeT('vi');
const orch = (over: Partial<OrchestratorView> = {}): OrchestratorView => ({ projectId: 'p1', state: 'running', account: 'a@x', homeAccount: 'a@x', lastError: null,
  costUsd: 0, contextPct: 41, talkingTo: null, sessionId: 's1', seq: 1, ...over });
const snap = snapshot({ orchestrators: [orch()], lanes: [lane('D2'), lane('D15', { account: 'pm@x' })] });
const ctx: MenuCtx = { tr: VI, snap, offline: false, tauri: true, now: Date.now() };
const subs = () => [{ taskId: 't1', toolUseId: 'u', subagentType: 'tests', description: 'd', status: 'running' as const, background: false, lastTool: null, toolUses: 1, totalTokens: 1 }];

describe('§4.12 one source for node, Inspector, F9 row, account row', () => {
  test('§4.12 deck node ids map to the same sources the Inspector / F9 use', () => {
    expect(nodeMenuSrc('lane:D2', 'p1', snap)).toEqual({ k: 'lane', projectId: 'p1', name: 'D2' });
    expect(nodeMenuSrc('orch:s1', 'p1', snap)).toEqual({ k: 'orch', projectId: 'p1', sessionId: 's1' });
    expect(nodeMenuSrc('orch:p1', 'p1', snap)).toEqual({ k: 'orch', projectId: 'p1', sessionId: null });
    expect(nodeMenuSrc('sub:D2:t:1', 'p1', snap)).toEqual({ k: 'sub', projectId: 'p1', lane: 'D2', taskId: 't:1' });
    expect(nodeMenuSrc('done', 'p1', snap)).toBeNull();
    expect(nodeMenuSrc('more:D2', 'p1', snap)).toBeNull();
  });
  test('§4.12 node "⋯" (lane:D2), Inspector "⋯" and F9 row "⋯" list identical items', () => {
    const node = menuItemsFor(nodeMenuSrc('lane:D2', 'p1', snap)!, ctx, subs);
    const inspector = menuItemsFor({ k: 'lane', projectId: 'p1', name: 'D2' }, ctx, subs);
    expect(node.length).toBeGreaterThan(3);
    expect(node).toEqual(inspector);
  });
  test('§4.12 orch node with an unknown root falls back to the project\'s first session; sub and account resolve', () => {
    expect(menuItemsFor({ k: 'orch', projectId: 'p1', sessionId: null }, ctx, subs).map(i => i.id)[0]).toBe('msg');
    expect(menuItemsFor({ k: 'sub', projectId: 'p1', lane: 'D2', taskId: 't1' }, ctx, subs).map(i => i.id)).toEqual(['view', 'msg', 'interrupt']);
    expect(menuItemsFor({ k: 'account', email: 'pm@x' }, ctx, subs)[0]!.id).toBe('view');
    expect(menuItemsFor({ k: 'lane', projectId: 'p1', name: 'GONE' }, ctx, subs)).toEqual([]);
  });
});

describe('§4.12 runner: destructive items go through the existing confirm dialogs', () => {
  const host = (confirm = false) => {
    const log: string[] = [], sent: Command[] = [];
    const h: MenuHost = {
      t: k => k, switched: (n, to) => `${n}→${to}`, subDraft: n => `về subagent '${n}': `,
      send: c => { sent.push(c); return Promise.resolve(); }, toast: t => log.push(`toast ${t}`), confirm: t => { log.push(`confirm ${t}`); return confirm; },
      lane: (p, n) => snap.lanes.find(l => l.projectId === p && l.name === n), noNewLanes: () => ({ 'x@x': true }),
      talkTo: t => log.push(`talk ${JSON.stringify(t)}`), interrupt: t => log.push(`int ${JSON.stringify(t)}`), select: s => log.push(`sel ${JSON.stringify(s)}`),
      draft: t => log.push(`draft ${t}`), askStop: (p, n) => log.push(`stopDlg ${p}/${n}`), openTerminal: p => log.push(`term ${p}`), openAccount: e => log.push(`acc ${e}`),
      accDialog: d => log.push(`accDlg ${JSON.stringify(d)}`), moveAll: e => log.push(`moveAllDlg ${e}`), accountSettings: () => log.push('caps'), refreshAccount: e => log.push(`refresh ${e}`),
      laneModel: n => log.push(`laneModel ${n}`), sessionDialog: (k, s) => log.push(`session ${k} ${s}`), laneDoneFlow: (k, id) => log.push(`done ${k} ${id}`),
      moved: m => log.push(`moved ${m.name} ${m.from}→${m.toSession}`), closeProject: id => log.push(`close ${id}`),
    };
    return { h, log, sent };
  };
  const run = (a: MenuAct, confirm = false) => { const x = host(confirm); runMenuAct(a, x.h); return x; };
  test('§4.14 Đổi chủ lane: a sent lane_reassign reports the old owner; the 5 s "Hoàn tác" sends the reverse command', async () => {
    const x = host();
    x.h.lane = () => lane('D2', { ownerSession: 's3', ownerSeq: 3 });
    runMenuAct({ t: 'lane_reassign', projectId: 'p1', name: 'D2', toSession: 's4' }, x.h);
    await Promise.resolve(); await Promise.resolve();
    expect(x.sent).toEqual([{ cmd: 'lane_reassign', projectId: 'p1', name: 'D2', toSession: 's4' }]);
    expect(x.log).toContain('moved D2 s3→s4');
    expect(reassignBack({ projectId: 'p1', name: 'D2', from: 's3' })).toEqual({ cmd: 'lane_reassign', projectId: 'p1', name: 'D2', toSession: 's3', undo: true });
  });
  test('§4.12 Dừng… opens the v1 F8 stop dialog, never sends lane_stop', () => {
    const x = run({ t: 'lane', a: 'stop', projectId: 'p1', name: 'D2' });
    expect(x.log).toEqual(['stopDlg p1/D2']);
    expect(x.sent).toEqual([]);
  });
  test('§4.12 Dừng an toàn tất cả lane… asks first; declined = nothing sent, accepted = stop_all of that project / session', () => {
    expect(run({ t: 'orch', a: 'stopAll', projectId: 'p1', sessionId: null }).sent).toEqual([]);
    expect(run({ t: 'orch', a: 'stopAll', projectId: 'p1', sessionId: null }, true).sent).toEqual([{ cmd: 'stop_all', projectId: 'p1' }]);
    expect(run({ t: 'orch', a: 'stopAll', projectId: 'p1', sessionId: 's2' }, true).sent).toEqual([{ cmd: 'stop_all', projectId: 'p1', sessionId: 's2' }]);
  });
  test('review-b MINOR-2 ⋯ "Làm mới số liệu" goes through the account panel (its instant "đang làm mới"), never a silent send', () => {
    const x = run({ t: 'acc', a: 'refresh', email: 'pm@x' });
    expect(x.log).toEqual(['refresh pm@x']);
    expect(x.sent).toEqual([]);
  });
  test('§4.12 Chuyển hết lane / Đăng xuất / Xoá account open their dialogs (v1 F24, A8L, A8)', () => {
    expect(run({ t: 'acc', a: 'moveAll', email: 'pm@x' }).log).toEqual(['moveAllDlg pm@x']);
    expect(run({ t: 'acc', a: 'logout', email: 'pm@x' }).log).toEqual(['accDlg {"k":"logout","email":"pm@x"}']);
    expect(run({ t: 'acc', a: 'delete', email: 'pm@x' }).sent).toEqual([]);
  });
  test('§4.12 subagent "Nhắn lane cha" selects the lane and pre-fills "về subagent \'<tên>\': " (v1 F25)', () => {
    expect(run({ t: 'sub', a: 'msg', projectId: 'p1', lane: 'D2', taskId: 't1', name: 'tests' }).log).toEqual(['sel {"k":"lane","name":"D2"}', "draft về subagent 'tests': "]);
  });
  test('§4.12 Chuyển account pick sends lane_switch_account; pause keeps the other paused accounts', () => {
    expect(run({ t: 'lane_switch', projectId: 'p1', name: 'D2', account: 'pm@x' }).sent).toEqual([{ cmd: 'lane_switch_account', projectId: 'p1', name: 'D2', account: 'pm@x' }]);
    expect(run({ t: 'acc', a: 'pause', email: 'pm@x' }).sent).toEqual([{ cmd: 'config_update', patch: { noNewLanes: { 'x@x': true, 'pm@x': true } } }]);
  });
  test('§4.12 session items go to the T10 dialogs; done-lane items to the T11 flows', () => {
    expect(run({ t: 'session', kind: 'end', projectId: 'p1', sessionId: 's1' }).log).toEqual(['session end s1']);
    expect(run({ t: 'lane', a: 'merge', projectId: 'p1', name: 'D2' }).log).toEqual(['done merge D2']);
  });
});

