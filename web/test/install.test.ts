import { describe, expect, test } from 'bun:test';
import { Store } from '../src/lib/store.ts';

describe('§6.1 F1b install log', () => {
  test('install_log lines collect per job until done', () => {
    const s = new Store();
    const log = (line: string, extra: object = {}) => s.apply({ type: 'event', event: { type: 'install_log', job: 'claude', line, ...extra } });
    log('$ curl …'); log('Downloading…'); s.apply({ type: 'event', event: { type: 'install_log', job: 'ccswitch', line: 'x' } });
    log('✓ installed', { done: true, ok: true });
    expect(s.get().installs.claude).toEqual({ lines: ['$ curl …', 'Downloading…', '✓ installed'], done: true, ok: true });
    expect(s.get().installs.ccswitch?.done).toBe(false);
  });
  test('a new run of the same job after done starts a fresh log', () => {
    const s = new Store();
    s.apply({ type: 'event', event: { type: 'install_log', job: 'claude', line: 'a', done: true, ok: false } });
    s.apply({ type: 'event', event: { type: 'install_log', job: 'claude', line: 'b' } });
    expect(s.get().installs.claude).toEqual({ lines: ['b'], done: false, ok: false });
  });
});
