import { describe, expect, test } from 'bun:test';
import { matchSlash } from '../../shared/slash.ts';

describe('shared/slash.ts — the one `/` matcher (v2.4 §6.6)', () => {
  test('§6.6 not a slash message → null', () => {
    expect(matchSlash('chạy tiếp')).toBeNull();
    expect(matchSlash('  ')).toBeNull();
    expect(matchSlash('/')).toBeNull();
    expect(matchSlash('a /model')).toBeNull();
  });
  test('§6.6 own commands: v1 list + /model, /effort; args kept', () => {
    for (const c of ['lanes', 'quota', 'stop', 'handoff', 'new', 'model', 'effort'] as const) {
      expect(matchSlash(`/${c}`)).toEqual({ kind: 'own', cmd: c, args: '' });
    }
    expect(matchSlash('/stop D2')).toEqual({ kind: 'own', cmd: 'stop', args: 'D2' });
    expect(matchSlash('  /model   sonnet 1m ')).toEqual({ kind: 'own', cmd: 'model', args: 'sonnet 1m' });
  });
  test('§6.6 whole first token, case-insensitive: /MODEL is own', () => {
    expect(matchSlash('/MODEL x')).toEqual({ kind: 'own', cmd: 'model', args: 'x' });
    expect(matchSlash('/Clear')).toEqual({ kind: 'blocked', cmd: 'clear' });
  });
  test('§6.6 /new-feature, /model-router, /handoff:write are not cc-slaves commands → pass-through', () => {
    expect(matchSlash('/new-feature x')).toEqual({ kind: 'pass', name: 'new-feature' });
    expect(matchSlash('/model-router')).toEqual({ kind: 'pass', name: 'model-router' });
    expect(matchSlash('/handoff:write')).toEqual({ kind: 'pass', name: 'handoff:write' });
    expect(matchSlash('/mcp__srv__prompt a')).toEqual({ kind: 'pass', name: 'mcp__srv__prompt' });
    expect(matchSlash('/compact')).toEqual({ kind: 'pass', name: 'compact' });
  });
  test('§6.6 Y34 blocked group: /clear, /login, /logout', () => {
    for (const c of ['clear', 'login', 'logout'] as const) expect(matchSlash(`/${c} now`)).toEqual({ kind: 'blocked', cmd: c });
    expect(matchSlash('/clearer')).toEqual({ kind: 'pass', name: 'clearer' });
  });
  test('§6.6 a multi-line message matches on its first token only', () => {
    expect(matchSlash('/model\nsonnet')).toEqual({ kind: 'own', cmd: 'model', args: 'sonnet' });
  });
});
