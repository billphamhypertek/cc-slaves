// v2.4 §5.1–§5.3, §5.6 one session's model / effort control (session/model-control.ts) against a scripted control port.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSessionModel, insertProject, insertSession, openDb, type Db } from '../../src/db.ts';
import { CLAUDE_DEFAULTS, ModelCache, parseModels, parseSettings, tiered, type Defaults } from '../../src/models.ts';
import { ModelControl, ModelError, sameModel, sessionPicks, type ControlPort } from '../../src/session/model-control.ts';

type Obj = Record<string, unknown>;
const row = (value: string, resolvedModel: string, displayName: string, levels = ['low', 'medium', 'high', 'max']) =>
  ({ value, resolvedModel, displayName, supportedEffortLevels: levels });
const MODELS = [
  row('default', 'claude-opus-5-5', 'Default (recommended)'), row('opus', 'claude-opus-5-5', 'Opus 5.5'),
  row('fable', 'claude-fable-5-2', 'Fable 5.2'), row('sonnet', 'claude-sonnet-5-5', 'Sonnet 5.5'),
  row('claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001', 'Haiku 4.5', []),
];
const INFO = parseModels({ models: MODELS });

/** A scripted Claude Code: answers like NC §8 (applied model / effort, `sources` layers), records every request. */
function port(o: { model?: string; effort?: string | null; configured?: string | null; level?: string; fail?: Record<string, string>; silent?: string[] } = {}) {
  const sent: Obj[] = [];
  let model = o.model ?? 'claude-fable-5-2';
  let effort = o.effort === undefined ? 'high' : o.effort;
  let flag: Obj | null = null;
  const st = { held: false, alive: true, released: 0 };
  const p: ControlPort & { sent: Obj[]; st: typeof st } = {
    sent, st,
    get held() { return st.held; }, get alive() { return st.alive; },
    hold() { st.held = true; }, release() { st.held = false; st.released++; return 0; },
    control(req) {
      sent.push(req);
      const sub = String(req.subtype);
      if (o.silent?.includes(sub)) return new Promise(() => {});
      const f = o.fail?.[sub];
      if (f) return Promise.resolve({ ok: false as const, error: 'x', errorCode: f });
      if (sub === 'list_models') return Promise.resolve({ ok: true as const, response: { models: MODELS } });
      if (sub === 'get_settings') {
        const sources: Obj[] = [{ source: 'userSettings', settings: { ...(o.configured === null ? {} : { model: o.configured ?? 'fable' }), ...(o.level ? { effortLevel: o.level } : {}) } }];
        if (flag) sources.push({ source: 'flagSettings', settings: flag });
        return Promise.resolve({ ok: true as const, response: { effective: {}, sources, applied: { model, effort } } });
      }
      if (sub === 'set_model') { model = typeof req.model === 'string' ? (INFO.find((m) => m.value === req.model)?.resolvedModel ?? req.model) : 'claude-opus-5-5'; return Promise.resolve({ ok: true as const, response: { model } }); }
      if (sub === 'apply_flag_settings') { flag = { ...flag, ...(req.settings as Obj) }; effort = String((req.settings as Obj).effortLevel); return Promise.resolve({ ok: true as const, response: {} }); }
      return Promise.resolve({ ok: false as const, error: 'unsupported', errorCode: 'unsupported_request' });
    },
  };
  return p;
}

let tmp: string;
let db: Db;
let override = false;
let views = 0;
let tiers: Defaults = CLAUDE_DEFAULTS;
const make = (timeoutMs = 300, cache = new ModelCache()) => new ModelControl({
  db, cache, sessionId: () => 's1', store: sessionPicks(db, () => 's1'), defaults: () => tiers, override: () => override, timeoutMs, changed: () => { views++; },
});
const subtypes = (p: { sent: Obj[] }) => p.sent.map((r) => (r.subtype === 'set_model' ? `set_model:${typeof r.model === 'string' ? r.model : '{}'}` : String(r.subtype)));

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-model-'));
  db = openDb(join(tmp, 'state.db'));
  insertProject(db, { id: 'p1', name: 'P1', path: tmp });
  insertSession(db, { id: 's1', projectId: 'p1', kind: 'orchestrator', account: 'a@x' });
  override = false;
  views = 0;
  tiers = CLAUDE_DEFAULTS;
});
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

describe('parsers (v2.4 §5.1, §5.2)', () => {
  test('§5.1 default = `model` of the sources layers minus flagSettings (later layer wins); none → null', () => {
    const r = { applied: { model: 'claude-sonnet-5-5', effort: 'high' }, sources: [
      { source: 'userSettings', settings: { model: 'fable' } }, { source: 'projectSettings', settings: { model: 'sonnet' } },
      { source: 'localSettings', settings: {} }, { source: 'flagSettings', settings: { model: 'haiku', effortLevel: 'low' } },
    ] };
    expect(parseSettings(r)).toEqual({ applied: { model: 'claude-sonnet-5-5', effort: 'high' }, configured: 'sonnet', configuredEffort: null });
    expect(parseSettings({ applied: { model: 'm', effort: null }, sources: [{ source: 'flagSettings', settings: { model: 'x' } }] }).configured).toBeNull();
    expect(parseSettings({}).applied).toEqual({ model: null, effort: null });
  });

  test('§5.2 models compare through resolvedModel: alias, value, [1m] suffix; unresolvable on either side → same', () => {
    expect(sameModel(INFO, 'sonnet', 'claude-sonnet-5-5')).toBe(true);
    expect(sameModel(INFO, 'claude-sonnet-5-5[1m]', 'sonnet')).toBe(true);
    expect(sameModel(INFO, 'default', 'opus')).toBe(true);
    expect(sameModel(INFO, 'fable', 'claude-opus-5-5')).toBe(false);
    expect(sameModel(INFO, 'no-such', 'claude-opus-5-5')).toBe(true);
    expect(sameModel(INFO, null, 'sonnet')).toBe(true);
    expect(parseModels({ models: [{ value: 'x' }, 3] })).toEqual([]);
  });
});

describe('handshake (v2.4 §5.2)', () => {
  test('§5.2 pick null while applied ≠ default (resume kept the transcript model) → set_model {default}; last* saved', async () => {
    const p = port({ model: 'claude-sonnet-5-5' });
    const m = make();
    await m.handshake(p, 'a@x');
    expect(subtypes(p)).toEqual(['get_settings', 'list_models', 'set_model:fable', 'get_settings']);
    expect(getSessionModel(db, 's1')).toMatchObject({ modelPick: null, lastModel: 'claude-fable-5-2', lastModelName: 'Fable 5.2', lastEffort: 'high' });
    expect(m.view()).toMatchObject({ modelName: 'Fable 5.2', effort: 'high', modelPick: null, effortPick: null, modelMismatch: false });
    expect(views).toBeGreaterThan(0);
  });

  test('§5.2 default from the plan (no layer sets a model) → set_model {} ; applied = default → nothing sent', async () => {
    const p = port({ model: 'claude-sonnet-5-5', configured: null });
    await make().handshake(p, 'a@x');
    expect(subtypes(p)).toContain('set_model:{}');
    const q = port({ model: 'claude-fable-5-2' });
    const m = make();
    await m.handshake(q, 'a@x');
    await m.handshake(q, 'a@x'); // the account's list is known → not asked again
    expect(subtypes(q)).toEqual(['get_settings', 'list_models', 'get_settings']); // no change sent → the first read is the last
  });

  test('§5.2 pick ≠ applied → modelMismatch, no retry (no set_model)', async () => {
    db.query("UPDATE session SET model_pick = 'sonnet' WHERE id = 's1'").run();
    const p = port({ model: 'claude-opus-5-5' });
    const m = make();
    expect(m.argv()).toEqual({ model: 'sonnet' });
    await m.handshake(p, 'a@x');
    expect(subtypes(p).filter((s) => s.startsWith('set_model'))).toEqual([]);
    expect(m.view().modelMismatch).toBe(true);
  });

  test('§5.2 CC_SLAVES_MODEL_OVERRIDE → no set_model at the handshake or after a turn, no modelMismatch', async () => {
    override = true;
    const p = port({ model: 'claude-haiku-4-5-20251001', effort: null });
    const m = make();
    await m.handshake(p, 'a@x');
    expect(await m.reread(p, 'a@x')).toBe(false);
    db.query("UPDATE session SET model_pick = 'sonnet' WHERE id = 's1'").run();
    const n = make();
    await n.handshake(p, 'a@x');
    expect(subtypes(p).filter((s) => s.startsWith('set_model'))).toEqual([]);
    expect(n.view().modelMismatch).toBe(false);
  });

  test('§5.2 a silent reply → the hook gives up at its deadline and sends nothing later', async () => {
    const p = port({ model: 'claude-sonnet-5-5', silent: ['list_models'] });
    const t0 = Date.now();
    expect(await make(200).handshake(p, 'a@x').catch((e: unknown) => e)).toBeInstanceOf(ModelError);
    expect(Date.now() - t0).toBeLessThan(1000);
    await Bun.sleep(300);
    expect(subtypes(p)).toEqual(['get_settings', 'list_models']);
  });
});

describe('after a turn (v2.4 §5.2)', () => {
  test('§5.2 re-read: applied changed (A2 fallback) → last* + view; pick null and applied ≠ default → reset once per process', async () => {
    const p = port({ model: 'claude-fable-5-2' });
    const m = make();
    await m.handshake(p, 'a@x');
    const before = views;
    expect(await m.reread(p, 'a@x')).toBe(false);
    expect(views).toBe(before); // nothing changed → no view
    await p.control({ subtype: 'set_model', model: 'sonnet' }); // Claude Code moved by itself
    expect(await m.reread(p, 'a@x')).toBe(true);
    expect(getSessionModel(db, 's1').lastModel).toBe('claude-sonnet-5-5');
    await m.resetDefault(p, 'a@x');
    expect(getSessionModel(db, 's1').lastModel).toBe('claude-fable-5-2');
    await p.control({ subtype: 'set_model', model: 'sonnet' });
    expect(await m.reread(p, 'a@x')).toBe(false); // once per process
  });
});

describe('change (v2.4 §5.3)', () => {
  test('§5.3 apply now: set_model + apply_flag_settings, picks saved, result read back', async () => {
    const p = port();
    const m = make();
    await m.handshake(p, 'a@x');
    expect(await m.apply(p, 'a@x', { model: 'sonnet', effort: 'max' })).toBe('now');
    expect(subtypes(p).slice(-3)).toEqual(['set_model:sonnet', 'apply_flag_settings', 'get_settings']);
    expect(getSessionModel(db, 's1')).toMatchObject({ modelPick: 'sonnet', effortPick: 'max', lastModel: 'claude-sonnet-5-5', lastEffort: 'max' });
  });

  test('§5.3 "Theo mặc định" mid-session → set_model {default}; with the test override nothing is sent', async () => {
    const p = port({ model: 'claude-sonnet-5-5' });
    db.query("UPDATE session SET model_pick = 'sonnet' WHERE id = 's1'").run();
    const m = make();
    await m.handshake(p, 'a@x');
    await m.apply(p, 'a@x', { model: null });
    expect(subtypes(p)).toContain('set_model:fable');
    expect(getSessionModel(db, 's1').modelPick).toBeNull();
    override = true;
    const q = port({ model: 'claude-sonnet-5-5' });
    await m.apply(q, 'a@x', { model: null });
    expect(subtypes(q).filter((s) => s.startsWith('set_model'))).toEqual([]);
  });

  test('§5.3 unsupported_request → pick saved, `unsupported`; not_found → ModelError model_not_found, pick kept', async () => {
    const m = make();
    expect(await m.apply(port({ fail: { set_model: 'unsupported_request' } }), 'a@x', { model: 'sonnet' })).toBe('unsupported');
    expect(getSessionModel(db, 's1').modelPick).toBe('sonnet');
    const e = await m.apply(port({ fail: { set_model: 'not_found' } }), 'a@x', { model: 'nope' }).catch((x: unknown) => x);
    expect((e as ModelError).code).toBe('model_not_found');
    expect(getSessionModel(db, 's1').modelPick).toBe('sonnet');
  });

  test('§5.3 pending merges; settle (process gone) → pick saved, pending cleared; cancel drops it; inherit / rebind copy picks', () => {
    const m = make();
    m.wait({ model: 'sonnet' });
    m.wait({ effort: 'low' });
    expect(m.view().pending).toEqual({ model: 'sonnet', effort: 'low' });
    m.settle();
    expect(m.view().pending).toBeUndefined();
    expect(getSessionModel(db, 's1')).toMatchObject({ modelPick: 'sonnet', effortPick: 'low' });
    m.wait({ model: 'opus' });
    m.cancel();
    expect(m.view().pending).toBeUndefined();
    expect(getSessionModel(db, 's1').modelPick).toBe('sonnet');
    insertSession(db, { id: 's2', projectId: 'p1', kind: 'orchestrator', account: 'a@x' });
    const n = new ModelControl({ db, cache: new ModelCache(), sessionId: () => 's2', store: sessionPicks(db, () => 's2'), defaults: () => CLAUDE_DEFAULTS, changed: () => {} });
    n.inherit(m);
    expect(getSessionModel(db, 's2')).toMatchObject({ modelPick: 'sonnet', effortPick: 'low' });
    expect(n.argv()).toEqual({ model: 'sonnet', effort: 'low' });
  });
});

describe('§5.6 tiers: pick › agent › Settings › Claude Code', () => {
  test('§5.6 tiered(): per field, agent frontmatter before the Settings row; `source` = the model\'s tier', () => {
    const set = { model: 'sonnet', effort: 'high' };
    expect(tiered(set, { name: 'coder', model: 'opus', effort: null })).toEqual({ model: 'opus', effort: 'high', source: 'agent', agent: 'coder' });
    expect(tiered(set, { name: 'coder', model: null, effort: 'medium' })).toEqual({ model: 'sonnet', effort: 'medium', source: 'settings' });
    expect(tiered({ model: null, effort: null }, null)).toEqual({ model: null, effort: null, source: null });
    expect(tiered({ model: null, effort: 'low' })).toEqual({ model: null, effort: 'low', source: null });
  });

  test('§5.6 argv: tiers 1–3 per field (pick wins), tier 4 → no flag', () => {
    tiers = { model: 'sonnet', effort: 'medium', source: 'settings' };
    expect(make().argv()).toEqual({ model: 'sonnet', effort: 'medium' });
    db.query("UPDATE session SET model_pick = 'opus' WHERE id = 's1'").run();
    expect(make().argv()).toEqual({ model: 'opus', effort: 'medium' });
    tiers = CLAUDE_DEFAULTS;
    db.query("UPDATE session SET model_pick = NULL, effort_pick = 'max' WHERE id = 's1'").run();
    expect(make().argv()).toEqual({ effort: 'max' });
  });

  test('§5.6 default captured at spawn: Settings changed while the process runs → the re-read after a turn resets nothing', async () => {
    tiers = { model: 'sonnet', effort: null, source: 'settings' };
    const m = make();
    m.argv(); // spawn
    const p = port({ model: 'claude-sonnet-5-5' }); // configured (settings.json) = fable ≠ tier 3
    await m.handshake(p, 'a@x');
    tiers = { model: 'opus', effort: null, source: 'settings' }; // PO changes Cài đặt › Model mid-run
    expect(await m.reread(p, 'a@x')).toBe(false);
    expect(subtypes(p).filter((s) => s.startsWith('set_model'))).toEqual([]);
    expect(m.view().modelMismatch).toBe(false);
  });

  test('§5.6 tier 2/3 model the account lacks → applied differs → modelMismatch, no set_model', async () => {
    tiers = { model: 'sonnet', effort: null, source: 'settings' };
    const m = make();
    m.argv();
    const p = port({ model: 'claude-opus-5-5' });
    await m.handshake(p, 'a@x');
    expect(subtypes(p).filter((s) => s.startsWith('set_model'))).toEqual([]);
    expect(m.view().modelMismatch).toBe(true);
    override = true;
    await m.reread(p, 'a@x');
    expect(m.view().modelMismatch).toBe(false); // the test override wins every tier
  });

  test('§5.6 "Theo mặc định" resolves tiers 2–4 at the click: idle → set_model with the new Settings value; busy → the value of the click', async () => {
    db.query("UPDATE session SET model_pick = 'fable' WHERE id = 's1'").run();
    tiers = { model: 'sonnet', effort: null, source: 'settings' };
    const m = make();
    m.argv();
    const p = port();
    await m.handshake(p, 'a@x');
    tiers = { model: 'opus', effort: null, source: 'settings' };
    await m.apply(p, 'a@x', { model: null });
    expect(subtypes(p)).toContain('set_model:opus');
    expect(m.view()).toMatchObject({ modelPick: null, modelMismatch: false });
    m.wait({ model: null }); // clicked while busy: resolved now…
    tiers = { model: 'sonnet', effort: null, source: 'settings' }; // …a later Settings change does not move it
    await m.apply(p, 'a@x', m.pending!);
    expect(subtypes(p).filter((s) => s.startsWith('set_model')).at(-1)).toBe('set_model:opus');
  });

  test('§5.6 "Theo mặc định" refused (model_not_found) → the spawn snapshot stays; mismatch is still judged against it', async () => {
    db.query("UPDATE session SET model_pick = 'fable' WHERE id = 's1'").run();
    tiers = { model: 'sonnet', effort: null, source: 'settings' };
    const m = make();
    m.argv();
    const p = port({ model: 'claude-sonnet-5-5', fail: { set_model: 'not_found' } });
    await m.handshake(p, 'a@x');
    tiers = { model: 'opus', effort: null, source: 'settings' };
    const e = await m.apply(p, 'a@x', { model: null }).catch((x: unknown) => x);
    expect((e as ModelError).code).toBe('model_not_found');
    m.save({ model: null }); // tier 1 cleared: the target is the snapshot's tier 3
    await m.reread(p, 'a@x');
    expect(m.view().modelMismatch).toBe(false); // sonnet = the spawn snapshot, not the refused opus
  });
});

describe('§5.4 / §5.6 session_models from the own process', () => {
  test('§5.6 read() names tier 4: settings.json model and effortLevel', async () => {
    expect(await make().read(port({ configured: 'sonnet', level: 'max' }), 'a@x')).toMatchObject({ configured: 'sonnet', configuredEffort: 'max' });
  });
});

describe('§5.4 one model cache', () => {
  test('§5.4 two sessions of one account share the list (60 s): the second handshake sends no list_models; after 60 s it reads again', async () => {
    let now = 0;
    const cache = new ModelCache(() => now);
    const p1 = port(), p2 = port(), p3 = port();
    await make(300, cache).handshake(p1, 'a@x');
    await make(300, cache).handshake(p2, 'a@x');
    expect(subtypes(p1)).toContain('list_models');
    expect(subtypes(p2)).not.toContain('list_models');
    now = 60_000;
    await make(300, cache).handshake(p3, 'a@x');
    expect(subtypes(p3)).toContain('list_models');
    expect(cache.models('a@x')?.map((m) => m.value)).toContain('sonnet');
  });
});
