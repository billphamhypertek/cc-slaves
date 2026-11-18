import { describe, expect, test } from 'bun:test';
import { canRun } from '../src/lib/remote.ts';

describe('§7.2 N2 REMOTE channel hides Mac-only actions', () => {
  test('mac channel can run everything', () => {
    expect(canRun('mac', 'stop_all')).toBe(true);
    expect(canRun('mac', 'account_login')).toBe(true);
  });
  test('remote channel only runs REMOTE_ALLOWED commands', () => {
    expect(canRun('remote', 'card_answer')).toBe(true);
    expect(canRun('remote', 'lane_resume')).toBe(true);
    expect(canRun('remote', 'account_login')).toBe(false);
    expect(canRun('remote', 'stop_all')).toBe(false);
    expect(canRun('remote', 'orchestrator_new')).toBe(false);
    expect(canRun('remote', 'config_update')).toBe(false);
  });
  test('unknown channel (no snapshot yet) is treated as remote', () => {
    expect(canRun(null, 'account_login')).toBe(false);
  });
});

import { cardActions } from '../src/lib/remote.ts';
import { card } from './fixtures.ts';
describe('§7.2 N2 system card actions on the remote channel', () => {
  const c = card(1, { kind: 'logged_out', actions: [{ id: 'account_relogin', label: 'Đăng nhập lại' }, { id: 'lane_resume', label: 'Chạy lại' }, { id: 'restart_orchestrator', label: 'Khởi động lại' }] });
  test('mac sees all actions', () => expect(cardActions(c, 'mac').map(a => a.id)).toEqual(['account_relogin', 'lane_resume', 'restart_orchestrator']));
  test('remote hides Mac-only actions', () => expect(cardActions(c, 'remote').map(a => a.id)).toEqual(['lane_resume']));
});
