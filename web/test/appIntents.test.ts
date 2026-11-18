// The shell's intent dispatch (ui/appIntents.ts) and menu close (ui/appMenus.ts), split out of App by lane v22-prep:
// each palette pick / card button / deck click reaches the same action as before the split.
import { describe, expect, test } from 'bun:test';
import type { CardView, Command } from '../../shared/protocol.ts';
import { MENU_CLOSE_MS } from '../src/lib/menu.ts';
import { onAskCancel } from '../src/tasks/CancelPop.tsx';
import { cardAction, deckIntent, palRun } from '../src/ui/appIntents.ts';
import { appMenus } from '../src/ui/appMenus.ts';
import type { ShellCtx } from '../src/ui/shellCtx.ts';

/** A ShellCtx whose every action / setter records `[name, ...args]`; `send` resolves unless `fail`. */
function ctx(o: { fail?: boolean; menu?: unknown } = {}) {
  const log: unknown[][] = [];
  const rec = (name: string) => (...a: unknown[]) => { log.push([name, ...a]); };
  const ui = new Proxy<Record<string, unknown>>({ menu: o.menu ?? null }, { get: (t, k: string) => (k in t ? t[k] : rec(k)) });
  const send = (c: Command) => { log.push(['send', c]); return o.fail ? Promise.reject(new Error('x')) : Promise.resolve(null); };
  const c = {
    ui, pid: 'p1', lanes: [{ name: 'D1', state: 'done' }, { name: 'D2', state: 'running' }], send,
    ss: { view: rec('view'), dialog: rec('dialog'), onMoved: rec('moved') }, done: { openLane: rec('openLane'), expand: rec('expand'), flow: rec('flow') },
    pickProject: rec('pickProject'), openTasks: rec('openTasks'), setTarget: rec('setTarget'), focusInput: rec('focusInput'), interruptT: rec('interruptT'), drawer: rec('drawer'),
    openAccount: rec('openAccount'), toggleList: rec('toggleList'), toggleInbox: rec('toggleInbox'), toggleMute: rec('toggleMute'), flash: rec('flash'),
    snap: null, st: { subagents: {} }, target: null, offline: false, now: 0, tr: (k: string) => k, store: { toast: rec('toast') },
  } as unknown as ShellCtx;
  return { c, log };
}
const card = (p: Partial<CardView>): CardView => ({ id: 7, key: null, title: 'T', source: null, projectId: null, ...p }) as CardView;
const tick = () => new Promise(r => setTimeout(r, 0));

describe('F22 ⌘K palette picks (palRun)', () => {
  test.each([
    [{ t: 'lane', projectId: 'p2', name: 'D3' }, [['openLane', 'p2', 'D3']]],
    [{ t: 'project', id: 'p2' }, [['pickProject', 'p2']]],
    [{ t: 'account', email: 'a@x' }, [['openAccount', 'a@x']]],
    [{ t: 'menu', act: { a: 'stop' } }, [['runMenu', { a: 'stop' }]]],
    [{ t: 'settings' }, [['setSettingsTab', 'proj']]],
    [{ t: 'list' }, [['toggleList']]],
    [{ t: 'inbox' }, [['toggleInbox']]],
    [{ t: 'sound' }, [['toggleMute']]],
    [{ t: 'console' }, [['setTarget', { kind: 'orchestrator', projectId: 'p1' }], ['focusInput']]],
    [{ t: 'addProject' }, [['setAddOpen', true]]],
    [{ t: 'setup' }, [['setWizardOpen', true]]],
    [{ t: 'skillsMcp' }, [['setSm', { tab: 'mcp' }]]], // v2.2 §6 ⌘K "Skills & MCP" opens the MCP tab (C17)
    [{ t: 'mcpAdd' }, [['setSm', { tab: 'mcp', add: true }]]], // v2.2 §6 ⌘K "Thêm MCP…" opens K4
    [{ t: 'toolkit' }, [['setSm', { tab: 'toolkit' }]]], // v2.5 §6 ⌘K "Bộ công cụ" opens its tab
    [{ t: 'graph' }, [['setSm', { tab: 'graph' }]]], // v2.5 §6 ⌘K "Graph code" opens its tab
  ])('%o → %o', (a, want) => {
    const { c, log } = ctx();
    palRun(a as never, c, m => log.push(['runMenu', m]));
    expect(log).toEqual(want);
  });
  test('§6 ⌘K "Đăng nhập MCP…" opens K3 for the first server needing a login; none → the MCP tab only', () => {
    const a = ctx();
    (a.c as { snap: unknown }).snap = { skillsMcp: { mcp: { rows: [
      { id: 'user:ok', kind: 'http', status: 'connected', oauth: {} }, { id: 'user:v', kind: 'http', status: 'needs_login', oauth: {} },
    ] } } };
    palRun({ t: 'mcpLogin' }, a.c, () => {});
    expect(a.log).toEqual([['setSm', { tab: 'mcp', login: 'user:v' }]]);
    const b = ctx();
    palRun({ t: 'mcpLogin' }, b.c, () => {});
    expect(b.log).toEqual([['setSm', { tab: 'mcp' }]]);
  });
});

describe('v2 §6 Chờ PO card buttons (cardAction)', () => {
  test('F16 relogin opens A6 at once and sends; a failed send closes the dialog', async () => {
    const { c, log } = ctx({ fail: true });
    cardAction(card({ key: 'a@x' }), 'account_relogin', c);
    await tick();
    expect(log).toEqual([['setAccDlg', { k: 'relogin', email: 'a@x', started: true }], ['send', { cmd: 'card_action', id: 7, action: 'account_relogin' }], ['setAccDlg', null]]);
  });
  test('A9 merge / A8 orphan delete / §7.1-3 add open their dialog without a send', () => {
    for (const [cv, action, dlg] of [
      [card({ key: 'a@x/settings.json' }), 'shared_cfg_merge', { k: 'merge', email: 'a@x', name: 'settings.json', cardId: 7 }],
      [card({}), 'account_orphan_delete', { k: 'orphan_delete', cardId: 7, title: 'T' }],
      [card({}), 'account_add', { k: 'add' }],
    ] as const) {
      const { c, log } = ctx();
      cardAction(cv, action, c);
      expect(log).toEqual([['setAccDlg', dlg]]);
    }
  });
  test('§6 K13 "Đăng nhập" opens K3 for the card\'s server (the dialog starts the login); "Để sau" is sent', () => {
    const a = ctx();
    cardAction(card({ kind: 'mcp_login', key: 'user:vercel' }), 'mcp_login', a.c);
    expect(a.log).toEqual([['setSm', { tab: 'mcp', login: 'user:vercel' }]]);
    const b = ctx();
    cardAction(card({ kind: 'mcp_login', key: 'user:vercel' }), 'mcp_snooze', b.c);
    expect(b.log).toEqual([['send', { cmd: 'card_action', id: 7, action: 'mcp_snooze' }]]);
  });
  test('view_log of a lane card selects that lane; any other action is sent', () => {
    const a = ctx();
    cardAction(card({ source: 'D2', projectId: 'p3' }), 'view_log', a.c);
    expect(a.log).toEqual([['setTarget', { kind: 'lane', projectId: 'p3', name: 'D2' }]]);
    const b = ctx();
    cardAction(card({ source: 'orchestrator' }), 'view_log', b.c);
    expect(b.log).toEqual([['send', { cmd: 'card_action', id: 7, action: 'view_log' }]]);
  });
  test('§5.7-5 IS5b revert_cancel_both → Tasks on the issue + askCancel(pid, [blocker, key]); nothing sent to the engine', () => {
    const { c, log } = ctx();
    const got: string[] = [];
    const off = onAskCancel((pid, keys) => got.push(`${pid}:${keys.join(',')}`));
    cardAction(card({ kind: 'revert_conflict', projectId: 'p1', params: { key: 'T-46', blocker: 'T-53' } }), 'revert_cancel_both', c);
    off();
    expect(got).toEqual(['p1:T-53,T-46']);
    expect(log).toEqual([['openTasks', {}]]);
  });
  test('§4.2-4 issues_view → Tasks with the Phát sinh filter (≥ 2 unseen, IS3b)', () => {
    const { c, log } = ctx();
    cardAction(card({ kind: 'issues_new', projectId: 'p1', params: { n: 2 } }), 'issues_view', c);
    expect(log).toEqual([['openTasks', { arising: true }]]);
  });
});

describe('§4.11 deck clicks (deckIntent)', () => {
  test('a lane node selects it (done lane → its done view) and opens the narrow drawer', () => {
    const { c, log } = ctx();
    deckIntent({ t: 'lane', name: 'D1' } as never, c);
    expect(log).toEqual([['pick', { k: 'doneLane', name: 'D1' }], ['drawer', 'node']]);
  });
  test('v1.1 §4.4 / v2.4 §6.7 a deck card focuses its Chờ PO row, opens its detail box, unfolds the block and glows; a card-less badge only selects', () => {
    const a = ctx();
    deckIntent({ t: 'card', lane: 'D2', cardId: 9 } as never, a.c);
    expect(a.log).toEqual([['pick', { k: 'lane', name: 'D2' }], ['drawer', 'card'], ['setFocusPick', 9], ['setCardBox', { id: 9, status: 'open' }],
      ['setFold', { folded: false, resolvedOpen: false }], ['flash']]);
    const b = ctx();
    deckIntent({ t: 'card', lane: null, cardId: null } as never, b.c);
    expect(b.log).toEqual([['pick', { k: 'orch' }], ['drawer', 'card']]);
  });
  test('§4.14 a session root is viewed; restart of a second root names its session', () => {
    const a = ctx();
    deckIntent({ t: 'orch', root: 's2' } as never, a.c);
    expect(a.log).toEqual([['view', 's2'], ['drawer', 'node']]);
    const b = ctx();
    deckIntent({ t: 'orch_restart', root: 's2' } as never, b.c);
    deckIntent({ t: 'orch_restart', root: 'p1' } as never, b.c);
    expect(b.log).toEqual([['send', { cmd: 'orchestrator_restart', projectId: 'p1', sessionId: 's2' }], ['send', { cmd: 'orchestrator_restart', projectId: 'p1' }]]);
  });
  test('expand / done list / more / sub / account / add project', () => {
    const { c, log } = ctx();
    for (const i of [{ t: 'expand', root: 'r' }, { t: 'done_list' }, { t: 'more', lane: 'D2' }, { t: 'sub', lane: 'D2', taskId: 'k' }, { t: 'sub', lane: 'D2', taskId: null },
      { t: 'account', email: 'a@x' }, { t: 'add_project' }]) deckIntent(i as never, c);
    expect(log).toEqual([['expand', 'p1', 'r'], ['pick', { k: 'doneList' }], ['drawer', 'node'], ['pick', { k: 'lane', name: 'D2', subsFirst: true }], ['drawer', 'node'],
      ['pick', { k: 'sub', lane: 'D2', taskId: 'k' }], ['drawer', 'node'], ['pick', { k: 'lane', name: 'D2' }], ['drawer', 'node'], ['openAccount', 'a@x'], ['setAddOpen', true]]);
  });
});

describe('§4.12 menu close (appMenus)', () => {
  test('the menu fades (leaving) and goes after MENU_CLOSE_MS, focus back to its opener only on refocus', async () => {
    let focused = 0;
    const { c, log } = ctx({ menu: { opener: { focus: () => { focused++; } } } });
    const m = appMenus(c, { current: null });
    expect(m.menuItems({ k: 'account', email: 'a@x' })).toEqual([]); // no snapshot yet → no items
    m.closeMenu(true);
    const [, up] = log[0] as [string, (x: unknown) => unknown];
    expect(up({ leaving: false, id: 1 })).toEqual({ leaving: true, id: 1 });
    await new Promise(r => setTimeout(r, MENU_CLOSE_MS + 20));
    const [, gone] = log[1] as [string, (x: unknown) => unknown];
    expect([gone({ leaving: true }), gone({ leaving: false })]).toEqual([null, { leaving: false }]);
    expect(focused).toBe(1);
    appMenus(c, { current: null }).closeMenu(false); // closed by a pick: focus stays where the action put it
    await new Promise(r => setTimeout(r, MENU_CLOSE_MS + 20));
    expect(focused).toBe(1);
  });
});
