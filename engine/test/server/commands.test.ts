import { describe, expect, test } from 'bun:test';
import type { Card } from '../../src/cards/store.ts';
import type { Engine } from '../../src/engine.ts';
import { buildHandlers } from '../../src/server/commands.ts';
import { cardView } from '../../src/server/views.ts';
import { CommandError, route } from '../../src/server/router.ts';
import type { Conn } from '../../src/server/ws.ts';

const conn: Conn = { channel: 'mac', watch: null, present: false, send: () => {} };
const sys = (kind: Card['kind'], actions: { label: string; action: string }[]): Card => ({
  id: 5, kind, projectId: null, sessionId: null, requestId: null, status: 'open', createdAt: 1, resolvedAt: null, answer: null,
  payload: { title: 't', body: null, key: 'a@x', actions },
});

function fakeEngine(o: { busy?: string[]; card?: Card; exec?: { code: number; stdout: string; stderr: string } } = {}) {
  const calls: string[] = [];
  let shutdowns = 0;
  const e = {
    busyLanes: () => o.busy ?? [],
    o: { onShutdownRequest: () => { shutdowns++; } },
    exec: async (argv: string[]) => { calls.push(argv.join(' ')); return o.exec ?? { code: 0, stdout: '', stderr: '' }; },
    config: {},
    cards: {
      get: () => o.card ?? null,
      resolveSystem: (id: number, action?: string) => { calls.push(`resolve ${id} ${action}`); return { ...o.card!, status: 'answered' }; },
    },
    cardViewOf: (c: Card) => cardView(c), // v2.1 §4.14 the engine adds sessionId / seq
    projectRow: () => ({ id: 'p', name: 'P', path: '/p', orchestrator_account: null, gchat_webhook: null, gchat_send_command_text: 0 }),
    projectRows: () => [],
    projectView: () => ({ id: 'p', name: 'P', path: '/p', orchestratorAccount: null, gchatWebhookSet: false, gchatSendCommandText: false, unmerged: 0 }),
    broadcast: (ev: unknown) => { calls.push(`broadcast ${JSON.stringify(ev)}`); },
    db: { query: (sql: string) => ({ run: () => { calls.push(`sql ${sql}`); } }) },
    startAccountLogin: (opts: { accountEmail?: string }) => { calls.push(`relogin ${opts.accountEmail}`); return { id: 'l1' }; },
    hub: { setPresent: (c: Conn, v: boolean) => { calls.push(`present ${c === conn} ${v}`); } },
  } as unknown as Engine;
  return { h: buildHandlers(e, conn), calls, shutdowns: () => shutdowns };
}

describe('§7.1 NC4 engine_shutdown', () => {
  test('§7.1 refused while a lane runs (Vietnamese reason, nothing scheduled)', async () => {
    const f = fakeEngine({ busy: ['p/D2'] });
    const r = await route(f.h, { channel: 'mac' }, { type: 'command', id: '1', command: { cmd: 'engine_shutdown' } });
    expect(r).toMatchObject({ type: 'error', code: 'lanes_running' });
    expect((r as { message: string }).message).toContain('dừng an toàn');
    await Bun.sleep(80);
    expect(f.shutdowns()).toBe(0);
  });
  test('§7.1 accepted with no running lane → shutdown requested after the ack', async () => {
    const f = fakeEngine();
    expect(await f.h.engine_shutdown({ cmd: 'engine_shutdown' }, { channel: 'mac' })).toEqual({ shuttingDown: true });
    await Bun.sleep(80);
    expect(f.shutdowns()).toBe(1);
  });
});

describe('card_action (system cards)', () => {
  test('v2 §7 no CC Switch path left: no open_ccswitch command, setup_install ccswitch refused, nothing run', async () => {
    const f = fakeEngine();
    expect((f.h as Record<string, unknown>).open_ccswitch).toBeUndefined();
    const r = await route(f.h, { channel: 'mac' }, { type: 'command', id: '1', command: { cmd: 'open_ccswitch' } as never });
    expect(r).toMatchObject({ type: 'error' });
    const i = await route(f.h, { channel: 'mac' }, { type: 'command', id: '2', command: { cmd: 'setup_install', what: 'ccswitch' } as never });
    expect(i).toMatchObject({ type: 'error', code: 'bad_input' });
    await Bun.sleep(20);
    expect(f.calls).toEqual([]);
  });
  test('v2 §6 F16 "Đăng nhập lại" (account_relogin) starts A6 for the card account; the card stays open until the login is back', async () => {
    const f = fakeEngine({ card: sys('logged_out', [{ label: 'Đăng nhập lại', action: 'account_relogin' }]) });
    await f.h.card_action({ cmd: 'card_action', id: 5, action: 'account_relogin' }, { channel: 'mac' });
    expect(f.calls).toEqual(['relogin a@x']);
  });
  test('dismiss resolves; an action not on the card is refused', async () => {
    const f = fakeEngine({ card: sys('cc_updated', [{ label: 'Đã xem', action: 'dismiss' }]) });
    await f.h.card_action({ cmd: 'card_action', id: 5, action: 'dismiss' }, { channel: 'mac' });
    expect(f.calls).toEqual(['resolve 5 dismiss']);
    expect(() => f.h.card_action({ cmd: 'card_action', id: 5, action: 'lane_resume' }, { channel: 'mac' })).toThrow();
  });
});

describe('§7.2 N2 I4 card_action on the remote channel runs only remote-allowed commands', () => {
  const macOnly: [string, string][] = [
    ['restart_orchestrator', ''], ['orchestrator_restart', ''], ['new_orchestrator', ''],
    ['new_orchestrator_session', ''], ['orchestrator_new', ''], ['setup_check', ''], ['account_relogin', ''],
  ];
  for (const [action] of macOnly) {
    test(`remote ${action} → forbidden_remote, nothing run, card stays open`, async () => {
      const f = fakeEngine({ card: sys('logged_out', [{ label: 'x', action }]) });
      const r = await route(f.h, { channel: 'remote' }, { type: 'command', id: '1', command: { cmd: 'card_action', id: 5, action } });
      expect(r).toMatchObject({ type: 'error', code: 'forbidden_remote' });
      expect(f.calls).toEqual([]);
    });
  }
  test('remote dismiss still resolves; mac account_relogin still runs', async () => {
    const f = fakeEngine({ card: sys('cc_updated', [{ label: 'Đã xem', action: 'dismiss' }, { label: 'm', action: 'account_relogin' }]) });
    expect(await route(f.h, { channel: 'remote' }, { type: 'command', id: '1', command: { cmd: 'card_action', id: 5, action: 'dismiss' } })).toMatchObject({ type: 'ack' });
    await route(f.h, { channel: 'mac' }, { type: 'command', id: '2', command: { cmd: 'card_action', id: 5, action: 'account_relogin' } });
    expect(f.calls).toEqual(['resolve 5 dismiss', 'relogin a@x']);
  });
});

describe('§7 D18/D24 no per-project permission mode, no signed bypass', () => {
  test('project_update ignores a stray permissionMode (no write, no forbidden_native)', async () => {
    const f = fakeEngine();
    const r = await route(f.h, { channel: 'mac' }, { type: 'command', id: '1', command: { cmd: 'project_update', id: 'p', patch: { permissionMode: 'bypassPermissions' } as never } });
    expect(r).toMatchObject({ type: 'ack' });
    expect(JSON.stringify(r)).not.toContain('permissionMode');
    expect(f.calls.filter((c) => c.startsWith('sql'))).toEqual([]); // nothing to write
  });
  test('project_set_mode_signed and app_register_key are unknown commands', async () => {
    const f = fakeEngine();
    for (const cmd of ['project_set_mode_signed', 'app_register_key']) {
      const r = await route(f.h, { channel: 'mac' }, { type: 'command', id: '1', command: { cmd, payload: '{}', sig: '00' } as never });
      expect(r).toMatchObject({ type: 'error', code: 'unknown_command' });
    }
  });
});

test('§8.3 R10 I5 presence sets this connection present / not present (anything but true = hidden)', async () => {
  const f = fakeEngine();
  await f.h.presence({ cmd: 'presence', visible: true }, { channel: 'mac' });
  await f.h.presence({ cmd: 'presence', visible: 'yes' as unknown as boolean }, { channel: 'mac' });
  expect(f.calls).toEqual(['present true true', 'present true false']);
});

describe('v2 §6 A2 accounts_info / account_open_terminal', () => {
  test('§6 A2 accounts_info returns the engine view (entries, default ~/.claude email, private-window support)', async () => {
    const info = { entries: [], privateWindow: true };
    const e = { accountsInfo: async () => info } as unknown as Engine;
    expect(await buildHandlers(e, conn).accounts_info({ cmd: 'accounts_info' }, { channel: 'mac' })).toEqual(info);
  });
  test('§6 A2 "Mở Terminal" opens Terminal at the account dir from the registry, never a path from the client', async () => {
    const calls: string[][] = [];
    const e = {
      exec: async (argv: string[]) => { calls.push(argv); return { code: 0, stdout: '', stderr: '' }; },
      accountDir: (email: string) => (email === 'a@x' ? '/acc/a' : null),
    } as unknown as Engine;
    const h = buildHandlers(e, conn);
    await h.account_open_terminal({ cmd: 'account_open_terminal', email: 'a@x' }, { channel: 'mac' });
    expect(calls).toEqual([['open', '-a', 'Terminal', '/acc/a']]);
    expect(() => h.account_open_terminal({ cmd: 'account_open_terminal', email: 'zz@x' }, { channel: 'mac' })).toThrow(CommandError);
  });
});

describe('G4 UX I2 §6 A9C "Mở Finder" (shared_cfg_reveal)', () => {
  test('§6 A9C reveals the account copy from the merge plan; a file not in the plan\'s clashes runs nothing', async () => {
    const calls: string[][] = [];
    const e = {
      exec: async (argv: string[]) => { calls.push(argv); return { code: 0, stdout: '', stderr: '' }; },
      clashPath: (email: string, name: string, file: string) => (email === 'a@x' && name === 'plans' && file === 'a.md' ? '/acc/a/plans/a.md' : null),
    } as unknown as Engine;
    const h = buildHandlers(e, conn);
    await h.shared_cfg_reveal({ cmd: 'shared_cfg_reveal', email: 'a@x', name: 'plans', file: 'a.md' }, { channel: 'mac' });
    expect(calls).toEqual([['open', '-R', '/acc/a/plans/a.md']]);
    expect(() => h.shared_cfg_reveal({ cmd: 'shared_cfg_reveal', email: 'a@x', name: 'plans', file: '../../etc/passwd' }, { channel: 'mac' })).toThrow(CommandError);
    expect(calls.length).toBe(1);
  });
});

describe('project_update', () => {
  test('§8.3 webhook must be a Google Chat URL', () => {
    const f = fakeEngine();
    expect(() => f.h.project_update({ cmd: 'project_update', id: 'p', patch: { gchatWebhook: 'http://evil.example/x' } }, { channel: 'mac' }))
      .toThrow(CommandError);
  });
  test('open_in_vscode refuses a relative / missing path', () => {
    const f = fakeEngine();
    expect(() => f.h.open_in_vscode({ cmd: 'open_in_vscode', path: 'rel/path' }, { channel: 'mac' })).toThrow(CommandError);
    expect(f.calls).toEqual([]);
  });
});

describe('§6A config_update ui.lang · v2.4 §5.6 modelDefaults', () => {
  test('§6A ui.lang en is saved to config.json and broadcast; fr refused', async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { DEFAULT_CONFIG } = await import('../../src/config.ts');
    const prev = process.env.CC_SLAVES_HOME;
    const dir = mkdtempSync(join(tmpdir(), 'ccs-lang-'));
    process.env.CC_SLAVES_HOME = dir;
    try {
      const sent: unknown[] = [];
      const e = {
        config: { ...DEFAULT_CONFIG }, registryImported: () => false, readRegistry: () => {}, db: null,
        broadcast: (ev: unknown) => sent.push(ev), configView(this: { config: unknown }) { return { ...(this.config as object) }; },
      } as unknown as Engine;
      const h = buildHandlers(e, conn);
      await h.config_update({ cmd: 'config_update', patch: { ui: { lang: 'en' } } }, { channel: 'mac' });
      expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).ui).toEqual({ lang: 'en' });
      expect(sent).toEqual([{ type: 'config', config: expect.objectContaining({ ui: { lang: 'en' } }) }]);
      expect(() => h.config_update({ cmd: 'config_update', patch: { ui: { lang: 'fr' } } }, { channel: 'mac' })).toThrow(CommandError);
      expect((e as unknown as { config: { ui: unknown } }).config.ui).toEqual({ lang: 'en' });
      // v2.4 §5.6 the whole modelDefaults object; a missing row / cell → null (saved and in memory)
      await h.config_update({ cmd: 'config_update', patch: { modelDefaults: { lane: { model: 'sonnet' } } } }, { channel: 'mac' });
      const want = { orchestrator: { model: null, effort: null }, lane: { model: 'sonnet', effort: null } };
      expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).modelDefaults).toEqual(want);
      expect((e as unknown as { config: { modelDefaults: unknown } }).config.modelDefaults).toEqual(want);
      expect(() => h.config_update({ cmd: 'config_update', patch: { modelDefaults: { lane: { effort: 'turbo' } } } }, { channel: 'mac' })).toThrow(CommandError);
    } finally {
      if (prev === undefined) delete process.env.CC_SLAVES_HOME; else process.env.CC_SLAVES_HOME = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PO 2026-11-15 folder_pick (review M-3)', () => {
  const run = (exec: { code: number; stdout: string; stderr: string }) => {
    const f = fakeEngine({ exec });
    return route(f.h, { channel: 'mac' }, { type: 'command', id: '1', command: { cmd: 'folder_pick' } }).then((r) => ({ r, calls: f.calls }));
  };
  test('a chosen folder → its path, trailing slash trimmed; argv is osascript activate + choose folder (no shell)', async () => {
    const { r, calls } = await run({ code: 0, stdout: '/Users/x/Works/shop/\n', stderr: '' });
    expect(r).toMatchObject({ type: 'ack', result: { path: '/Users/x/Works/shop' } });
    expect(calls[0]).toStartWith('osascript -e activate -e POSIX path of (choose folder with prompt "');
  });
  test('cancel (-128) → { path: null }; another failure → open_failed', async () => {
    expect((await run({ code: 1, stdout: '', stderr: 'execution error: User canceled. (-128)' })).r).toMatchObject({ type: 'ack', result: { path: null } });
    expect((await run({ code: 1, stdout: '', stderr: 'execution error: boom (-1700)' })).r).toMatchObject({ type: 'error', code: 'open_failed' });
  });
  test('the remote channel is refused', async () => {
    const f = fakeEngine();
    expect(await route(f.h, { channel: 'remote' }, { type: 'command', id: '1', command: { cmd: 'folder_pick' } })).toMatchObject({ type: 'error', code: 'forbidden_remote' });
    expect(f.calls).toEqual([]);
  });
});
