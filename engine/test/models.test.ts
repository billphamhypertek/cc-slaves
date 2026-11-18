// v2.4 §5.4 the model cache (models per account, default per (account, project), 60 s) and the `session_models` source
// paths that need no process: fresh cache, the session's own process, a flagged / unknown account (no spawn).
import { describe, expect, test } from 'bun:test';
import { defaultModelOf, findModel, ModelCache, ModelSource, parseSettings, sessionModels, tiered, UNAVAILABLE, type ModelInfo, type ProbeDeps } from '../src/models.ts';

const M = (value: string, resolvedModel: string, displayName: string): ModelInfo => ({ value, resolvedModel, displayName, effortLevels: ['low', 'high'] });
const LIST = [M('default', 'claude-opus-5-5', 'Default (recommended)'), M('opus', 'claude-opus-5-5', 'Opus 5.5'), M('fable', 'claude-fable-5-2', 'Fable 5.2')];

describe('§5.4 ModelCache', () => {
  test('§5.4 models per account, remembered 60 s; the other account is not served from it', () => {
    let now = 1_000;
    const c = new ModelCache(() => now);
    c.putModels('a@x', LIST);
    expect(c.models('a@x')).toEqual(LIST);
    expect(c.models('b@x')).toBeNull();
    now += 59_999;
    expect(c.models('a@x')).toEqual(LIST);
    now += 1;
    expect(c.models('a@x')).toBeNull();
    expect(c.lastModels('a@x')).toEqual(LIST); // display names keep the last list
  });
  test('§5.4 defaultModel per (account, project), 60 s: another project of the same account is not served', () => {
    let now = 0;
    const c = new ModelCache(() => now);
    c.putConfigured('a@x', '/p1', 'fable', 'high');
    c.putConfigured('a@x', '/p2', null);
    expect(c.configured('a@x', '/p1')).toEqual({ configured: 'fable', configuredEffort: 'high' });
    expect(c.configured('a@x', '/p2')).toEqual({ configured: null, configuredEffort: null });
    expect(c.configured('b@x', '/p1')).toBeNull();
    now = 60_000;
    expect(c.configured('a@x', '/p1')).toBeNull();
  });
});

describe('§4.1 / A3 findModel', () => {
  test('A3 a resolved model names its alias row, never the `default` row listed first; `default` itself still resolves', () => {
    expect(findModel(LIST, 'claude-opus-5-5')?.displayName).toBe('Opus 5.5');
    expect(findModel(LIST, 'claude-opus-5-5[1m]')?.displayName).toBe('Opus 5.5');
    expect(findModel(LIST, 'opus')?.displayName).toBe('Opus 5.5');
    expect(findModel(LIST, 'default')?.displayName).toBe('Default (recommended)');
    expect(findModel([M('default', 'claude-x', 'Default')], 'claude-x')?.displayName).toBe('Default'); // only row: kept
    expect(findModel(LIST, 'nope')).toBeNull();
  });
});

describe('§5.1 / §5.5 defaults', () => {
  test('§5.1 configured model wins; none → the plan default row; ack carries its display name', () => {
    expect(defaultModelOf(LIST, 'fable')).toBe('fable');
    expect(defaultModelOf(LIST, null)).toBe('claude-opus-5-5');
    expect(sessionModels(LIST, 'fable')).toEqual({
      models: LIST, defaultModel: 'fable', defaultModelName: 'Fable 5.2', defaultSource: 'claude', defaultEffort: null,
      claudeModel: 'fable', claudeEffort: null, claudeSource: 'claude',
    });
    expect(sessionModels(LIST, null).defaultModelName).toBe('Opus 5.5'); // A3: the `default` row is never a name
    expect(sessionModels(LIST, null).defaultSource).toBe('plan');
  });
  test('§5.6 tiers 2/3 win over settings.json / plan: defaultModel + defaultSource + defaultAgent + defaultEffort', () => {
    expect(sessionModels(LIST, 'fable', tiered({ model: 'opus', effort: 'low' }))).toMatchObject({ defaultModel: 'opus', defaultModelName: 'Opus 5.5', defaultSource: 'settings', defaultEffort: 'low' });
    const a = sessionModels(LIST, 'fable', tiered({ model: 'opus', effort: null }, { name: 'coder-medium', model: 'fable', effort: 'medium' }));
    expect(a).toMatchObject({ defaultModel: 'fable', defaultSource: 'agent', defaultAgent: 'coder-medium', defaultEffort: 'medium' });
    expect(sessionModels(LIST, 'fable', tiered({ model: null, effort: 'high' }))).toMatchObject({ defaultModel: 'fable', defaultSource: 'claude', defaultEffort: 'high' });
  });
  test('§5.6 tier 4 always in the ack (what Claude Code would use), also when tier 2/3 decide the default', () => {
    expect(sessionModels(LIST, 'fable', tiered({ model: 'opus', effort: 'low' }), 'high')).toMatchObject({
      defaultModel: 'opus', defaultEffort: 'low', claudeModel: 'fable', claudeEffort: 'high', claudeSource: 'claude',
    });
    expect(sessionModels(LIST, null, tiered({ model: 'opus', effort: null }))).toMatchObject({ claudeModel: 'claude-opus-5-5', claudeEffort: null, claudeSource: 'plan' });
  });
  test('§5.6 tier-4 effort = effortLevel of the last non-flag layer', () => {
    const r = { applied: { model: 'm', effort: 'low' }, sources: [
      { source: 'userSettings', settings: { effortLevel: 'high' } }, { source: 'projectSettings', settings: { effortLevel: 'medium' } },
      { source: 'localSettings', settings: {} }, { source: 'flagSettings', settings: { effortLevel: 'low' } },
    ] };
    expect(parseSettings(r).configuredEffort).toBe('medium');
    expect(parseSettings({ sources: [{ source: 'flagSettings', settings: { effortLevel: 'low' } }] }).configuredEffort).toBeNull();
  });
  test('NC §8-26 measured get_settings layer shape {source, settings}: model of the last non-flag layer', () => {
    const r = { applied: { model: 'claude-opus-5-5', effort: 'medium' }, effective: {},
      sources: [{ source: 'userSettings', settings: { env: {}, permissions: {} } }, { source: 'projectSettings', settings: { model: 'sonnet' } }, { source: 'flagSettings', settings: { model: 'haiku' } }] };
    expect(parseSettings(r)).toEqual({ applied: { model: 'claude-opus-5-5', effort: 'medium' }, configured: 'sonnet', configuredEffort: null });
  });
});

function deps(o: Partial<ProbeDeps> & { spawned?: string[] } = {}): ProbeDeps {
  const spawned = o.spawned ?? [];
  return {
    cache: new ModelCache(), configDir: (a) => (a === 'gone@x' ? null : `/accts/${a}`), flagged: () => false,
    preSpawn: (d) => { spawned.push(`pre ${d}`); return true; },
    // a probe that reaches here spawns: `false` exits at once with no reply → unavailable
    command: ['false'], env: () => ({ PATH: process.env.PATH ?? '' }), timeoutMs: 1_000, ...o,
  };
}

describe('§5.4 ModelSource without a probe', () => {
  test('§5.4 fresh cache → answered from it, no own process asked, no spawn', async () => {
    const spawned: string[] = [];
    const d = deps({ spawned });
    d.cache.putModels('a@x', LIST);
    d.cache.putConfigured('a@x', '/p', 'fable', 'max');
    let asked = 0;
    const r = await new ModelSource(d).list('a@x', '/p', async () => { asked++; return { list: [], configured: null, configuredEffort: null }; });
    expect(r).toEqual(sessionModels(LIST, 'fable', undefined, 'max'));
    expect(asked).toBe(0);
    expect(spawned).toEqual([]);
  });
  test('§5.4 sessionId: the session\'s own process answers and fills the cache (no probe)', async () => {
    const spawned: string[] = [];
    const d = deps({ spawned });
    const src = new ModelSource(d);
    expect(await src.list('a@x', '/p', async () => ({ list: LIST, configured: null, configuredEffort: 'low' }))).toEqual(sessionModels(LIST, null, undefined, 'low'));
    expect(spawned).toEqual([]);
    expect(d.cache.models('a@x')).toEqual(LIST);
    expect(d.cache.configured('a@x', '/p')).toEqual({ configured: null, configuredEffort: 'low' });
  });
  test('§5.4 flagged account → unavailable, preSpawn never runs, nothing spawned', async () => {
    const spawned: string[] = [];
    expect(await new ModelSource(deps({ spawned, flagged: () => true })).list('a@x', '/p')).toEqual(UNAVAILABLE);
    expect(spawned).toEqual([]);
  });
  test('§5.4 preSpawn first; a flagged shared config (false) → unavailable, no spawn', async () => {
    const spawned: string[] = [];
    const d = deps({ spawned, preSpawn: (dir) => { spawned.push(`pre ${dir}`); return false; }, command: ['/no/such/claude'] });
    expect(await new ModelSource(d).list('a@x', '/p')).toEqual(UNAVAILABLE);
    expect(spawned).toEqual(['pre /accts/a@x']);
  });
  test('§5.4 the spawn itself throws (project folder gone) → unavailable, not an error', async () => {
    expect(await new ModelSource(deps({ command: ['true'] })).list('a@x', '/tmp/ccs-no-such-project-dir')).toEqual(UNAVAILABLE);
  });
  test('§5.4 unknown account → unavailable', async () => {
    expect(await new ModelSource(deps()).list('gone@x', '/p')).toEqual(UNAVAILABLE);
  });
});
