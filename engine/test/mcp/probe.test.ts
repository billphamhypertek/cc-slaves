// v2.2 §5.4b / §8 "Unit › phạm vi probe (C22)": the scope table row by row, `${VAR}` expansion of the spawn entry,
// and the auto-probe queue (≤ 4 in parallel, PO check first, one run per id at a time).
import { describe, expect, test } from 'bun:test';
import { expandVars, ProbeRunner, probeScope, type ProbeResult, type ProbeTarget } from '../../src/mcp/probe.ts';

const t = (o: Partial<ProbeTarget>): ProbeTarget => ({ source: 'user', kind: 'stdio', forLanes: true, unused: false, error: false, selfAuthHelper: false, ...o });

describe('§5.4b C22 probe scope', () => {
  test('§5.4b C22 row 1: an id going into lanes (user / plugin / local of a root / approved project, switch on) → auto + PO', () => {
    for (const source of ['user', 'plugin', 'local', 'project'] as const) {
      expect(probeScope(t({ source }))).toEqual({ auto: true, po: true });
      expect(probeScope(t({ source, kind: 'http' }))).toEqual({ auto: true, po: true });
    }
  });

  test('§5.4b C22 row 2: user / plugin off for lanes → no auto, PO yes (the PO runs it in a terminal anyway)', () => {
    expect(probeScope(t({ source: 'user', forLanes: false }))).toEqual({ auto: false, po: true });
    expect(probeScope(t({ source: 'plugin', forLanes: false, kind: 'sse' }))).toEqual({ auto: false, po: true });
  });

  test('§5.4b C22 row 3: K1-local (no project root) → never auto; PO only when remote, a local command never (button hidden)', () => {
    expect(probeScope(t({ source: 'local', unused: true, forLanes: false, kind: 'http' }))).toEqual({ auto: false, po: true });
    expect(probeScope(t({ source: 'local', unused: true, forLanes: false, kind: 'sse' }))).toEqual({ auto: false, po: true });
    expect(probeScope(t({ source: 'local', unused: true, forLanes: false, kind: 'stdio' }))).toEqual({ auto: false, po: false });
  });

  test('§5.4b C22 row 4: an unapproved / left-off `project:` entry (K7) → never, not even the PO (F3)', () => {
    expect(probeScope(t({ source: 'project', forLanes: false }))).toEqual({ auto: false, po: false });
    expect(probeScope(t({ source: 'project', forLanes: false, kind: 'http' }))).toEqual({ auto: false, po: false });
  });

  test('§5.4b C20 a plugin entry with an unknown ${CLAUDE_PLUGIN_*} never spawns; ws / headersHelper are not probed', () => {
    expect(probeScope(t({ source: 'plugin', error: true }))).toEqual({ auto: false, po: false });
    expect(probeScope(t({ kind: 'ws' }))).toEqual({ auto: false, po: false });
    expect(probeScope(t({ kind: 'http', selfAuthHelper: true }))).toEqual({ auto: false, po: false });
  });
});

describe('§5.4b the spawn entry is expanded like Claude Code expands the session file', () => {
  test('§5.1 ${VAR} and ${VAR:-default} expand from the env in command / args / env; unknown stays literal', () => {
    const env = { HOME: '/h', TOKEN: 's3' };
    expect(expandVars({ command: '${HOME}/bin/x', args: ['--k', '${TOKEN}', '${NOPE:-dflt}', '${NOPE}'], env: { A: 'a-${TOKEN}' } }, env))
      .toEqual({ command: '/h/bin/x', args: ['--k', 's3', 'dflt', '${NOPE}'], env: { A: 'a-s3' } });
  });
});

const ok = (at = 1): ProbeResult => ({ state: 'connected', tools: ['a'], error: null, at });

describe('§5.4b auto-probe queue', () => {
  test('§5.4b auto probes run at most 4 in parallel; every id once', async () => {
    let running = 0;
    let peak = 0;
    const done: string[] = [];
    const r = new ProbeRunner({
      run: async (id) => { running++; peak = Math.max(peak, running); await Bun.sleep(15); running--; done.push(id); return ok(); },
      onChange: () => {},
    });
    r.schedule(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'a', 'b']);
    await r.idle();
    expect(peak).toBe(4);
    expect(done.sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(r.result('c')?.state).toBe('connected');
  });

  test('§5.4b a PO check goes before queued auto probes and is never run twice at once', async () => {
    const order: string[] = [];
    const r = new ProbeRunner({ run: async (id) => { order.push(id); await Bun.sleep(10); return ok(); }, onChange: () => {}, limit: 1 });
    r.schedule(['a', 'b', 'c']);
    r.check('z');
    r.check('z');
    expect(r.running('z') || r.queued('z')).toBe(true);
    await r.idle();
    expect(order).toEqual(['a', 'z', 'b', 'c']);
  });

  test('§5.4b a run that throws records an error result (never a stuck "checking")', async () => {
    const r = new ProbeRunner({ run: () => Promise.reject(new Error('boom')), onChange: () => {} });
    r.check('x');
    await r.idle();
    expect(r.running('x')).toBe(false);
    expect(r.result('x')).toMatchObject({ state: 'error', error: { code: 'exited', detail: 'boom' } });
  });
});
