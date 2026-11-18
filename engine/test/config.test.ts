import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogPrefs, DEFAULT_CAPS, DEFAULT_CONFIG, issueText, lanesOff, loadCaps, loadConfig, resolveCaps, saveCaps, saveConfig, stripRegistryKeys, validateCaps, validateConfig } from '../src/config.ts';
import { CommandError } from '../src/server/router.ts';
import { t } from '../../shared/i18n/index.ts';
import { PO_CAPS } from './_fixtures/po-caps.ts';

const KEYS = ['CC_SLAVES_HOME', 'CLAUDE_HOME'] as const;
let saved: Record<string, string | undefined>;
let tmp: string;
let home: string;
let claude: string;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  tmp = mkdtempSync(join(tmpdir(), 'ccs-cfg-'));
  home = join(tmp, 'h');
  claude = join(tmp, 'cl');
  process.env.CC_SLAVES_HOME = home;
  process.env.CLAUDE_HOME = claude;
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('config.json', () => {
  test('§7.4 defaults: machine 8 lanes, 3 per account, remote auto-off 12 h, caffeinate + quota on', () => {
    const r = loadConfig();
    expect(r.error).toBeNull();
    expect(r.config).toEqual({
      maxLanes: 8, maxLanesPerAccount: 3, remoteAutoOffHours: 12, caffeinate: true, quotaReading: true,
      laneCaps: {}, noNewLanes: {}, notify: {}, sound: true, volume: 25, reducedMotion: false, sharedExtra: [],
      ui: { lang: 'vi' }, mcp: { offForLanes: [], projectOn: [], noLogin: [] }, skills: { offForLanes: [], acked: {} }, plugins: { offForLanes: [] },
      graph: { offProjects: [] }, modelDefaults: { orchestrator: { model: null, effort: null }, lane: { model: null, effort: null } },
    });
    expect(r.config).toEqual(DEFAULT_CONFIG);
  });

  test('§5.6 modelDefaults: loader fills a missing row / cell with null; validateConfig refuses "", an unknown effort, > 100 chars, an unknown row', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ modelDefaults: { lane: { model: 'sonnet' } } }));
    const r = loadConfig();
    expect(r.error).toBeNull();
    expect(r.config.modelDefaults).toEqual({ orchestrator: { model: null, effort: null }, lane: { model: 'sonnet', effort: null } });
    const ok = { modelDefaults: { orchestrator: { model: 'opus', effort: 'xhigh' }, lane: { model: null, effort: 'medium' } } };
    expect(validateConfig(ok)).toBeNull();
    for (const bad of [{ lane: { model: '' } }, { lane: { effort: 'turbo' } }, { lane: { model: 'x'.repeat(101) } }, { po: {} }, { lane: { model: 3 } }, { lane: 'sonnet' }]) {
      expect(validateConfig({ modelDefaults: bad })).toEqual({ key: 'config.modelDefaults', params: { field: 'modelDefaults' } });
    }
  });

  test('partial file is merged over defaults', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ maxLanes: 4 }));
    const r = loadConfig();
    expect(r.error).toBeNull();
    expect(r.config.maxLanes).toBe(4);
    expect(r.config.maxLanesPerAccount).toBe(3);
  });

  test('bad JSON → defaults + error, no throw', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), '{nope');
    const r = loadConfig();
    expect(r.config).toEqual(DEFAULT_CONFIG);
    expect(r.error).toBeString();
  });

  test('invalid field value → defaults + error naming the field', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ maxLanes: 0, caffeinate: 'yes' }));
    const r = loadConfig();
    expect(r.config).toEqual(DEFAULT_CONFIG);
    expect(r.error).toContain('maxLanes');
  });
});

describe('config.json UI keys (§6.12 F12, §6.8A F24)', () => {
  test('laneCaps / noNewLanes / volume are validated per value', () => {
    mkdirSync(home, { recursive: true });
    for (const [bad, field] of [[{ laneCaps: { a: 17 } }, 'laneCaps'], [{ noNewLanes: { a: 'x' } }, 'noNewLanes'], [{ volume: 101 }, 'volume'], [{ notify: [] }, 'notify']] as const) {
      writeFileSync(join(home, 'config.json'), JSON.stringify(bad));
      const r = loadConfig();
      expect(r.config).toEqual(DEFAULT_CONFIG);
      expect(r.error).toContain(field);
    }
    writeFileSync(join(home, 'config.json'), JSON.stringify({ laneCaps: { 'a@x': 0 }, noNewLanes: { 'a@x': true }, volume: 0, reducedMotion: true }));
    const r = loadConfig();
    expect(r.error).toBeNull();
    expect(r.config).toMatchObject({ laneCaps: { 'a@x': 0 }, noNewLanes: { 'a@x': true }, volume: 0, reducedMotion: true });
  });
});

describe('v2.2 §5.4 lane switches (config.json mcp / skills / plugins)', () => {
  test('§5.4 a partial mcp object is merged over the defaults; unknown sibling keys are kept', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ mcp: { offForLanes: ['user:linear'] }, skills: { offForLanes: [], acked: { a: 'b' } } }));
    const r = loadConfig();
    expect(r.error).toBeNull();
    expect(r.config.mcp).toEqual({ offForLanes: ['user:linear'], projectOn: [], noLogin: [] });
    expect(r.config.skills as unknown).toEqual({ offForLanes: [], acked: { a: 'b' } });
    expect(r.config.plugins).toEqual({ offForLanes: [] });
  });

  test('§5.4 a non-string id list → defaults + error naming the field', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ plugins: { offForLanes: [1] } }));
    const r = loadConfig();
    expect(r.config).toEqual(DEFAULT_CONFIG);
    expect(r.error).toContain('plugins');
    expect(validateConfig({ mcp: [] })).toEqual({ key: 'config.idLists', params: { field: 'mcp' } });
    expect(validateConfig({ mcp: { noLogin: [1] } })).toEqual({ key: 'config.idLists', params: { field: 'mcp' } }); // §6 K4 "Đăng nhập: Không"
  });

  test('§5.5 lanesOff: user skills + this project\'s skills by name, plugins by key; catalogPrefs maps mcp + plugins', () => {
    const c = { ...DEFAULT_CONFIG, mcp: { offForLanes: ['user:a'], projectOn: ['project:p:b'], noLogin: [] },
      skills: { offForLanes: ['user:h-ops', 'project:p:deploy', 'project:q:other'], acked: {} }, plugins: { offForLanes: ['vercel@m'] } };
    expect(lanesOff(c, 'p')).toEqual({ skills: ['h-ops', 'deploy'], plugins: ['vercel@m'] });
    expect(lanesOff(c, 'q')).toEqual({ skills: ['h-ops', 'other'], plugins: ['vercel@m'] });
    expect(catalogPrefs(c)).toEqual({ offForLanes: ['user:a'], projectOn: ['project:p:b'], pluginsOff: ['vercel@m'] });
  });
});

describe('v2.5 §5.7 graph.offProjects (config.json)', () => {
  test('§5.7 default empty (graph on for every project); a partial file is merged; a non-string id → defaults + error naming graph', () => {
    expect(loadConfig().config.graph).toEqual({ offProjects: [] });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ graph: { offProjects: ['p1'] } }));
    expect(loadConfig().config.graph).toEqual({ offProjects: ['p1'] });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ graph: { offProjects: [3] } }));
    expect(loadConfig().error).toContain('graph');
    expect(validateConfig({ graph: [] })).toEqual({ key: 'config.idLists', params: { field: 'graph' } });
  });
});

describe('§6A ui.lang (config.json)', () => {
  test('§6A default vi (no macOS guess)', () => expect(loadConfig().config.ui).toEqual({ lang: 'vi' }));
  test('§6A ui.lang en loads; fr / non-object → defaults + error naming ui', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ ui: { lang: 'en' } }));
    expect(loadConfig()).toMatchObject({ error: null, config: { ui: { lang: 'en' } } });
    for (const bad of [{ ui: { lang: 'fr' } }, { ui: 'en' }, { ui: {} }]) {
      writeFileSync(join(home, 'config.json'), JSON.stringify(bad));
      const r = loadConfig();
      expect(r.config.ui).toEqual({ lang: 'vi' });
      expect(r.error).toContain('ui');
    }
  });
  test('§6A lang persisted: saveConfig → loadConfig keeps en', () => {
    saveConfig({ ...DEFAULT_CONFIG, ui: { lang: 'en' } });
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).ui).toEqual({ lang: 'en' });
    expect(loadConfig().config.ui.lang).toBe('en');
  });
});

describe('§7.1-2 laneCaps / noNewLanes live in the account table (one source)', () => {
  test('§7.1-2 saveConfig never writes laneCaps / noNewLanes to config.json', () => {
    saveConfig({ ...DEFAULT_CONFIG, laneCaps: { 'a@x': 1 }, noNewLanes: { 'a@x': true }, volume: 7 });
    const j = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    expect(j.volume).toBe(7);
    expect('laneCaps' in j || 'noNewLanes' in j).toBe(false);
  });
  test('§7.1-2 stripRegistryKeys removes them from an existing file, keeps every other key; no file / no keys → untouched', () => {
    expect(stripRegistryKeys()).toBe(false);
    mkdirSync(home, { recursive: true });
    const f = join(home, 'config.json');
    writeFileSync(f, JSON.stringify({ laneCaps: { 'a@x': 0 }, noNewLanes: { 'a@x': true }, volume: 3 }));
    expect(stripRegistryKeys()).toBe(true);
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ volume: 3 });
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(stripRegistryKeys()).toBe(false);
    writeFileSync(f, 'garbage');
    expect(stripRegistryKeys()).toBe(false);
    expect(readFileSync(f, 'utf8')).toBe('garbage');
  });
});

describe('caps.json', () => {
  test('§7.1 G5 DEFAULT_CAPS holds only the generic default, no hard-coded emails', () => {
    expect(DEFAULT_CAPS).toEqual({ default: { week: 98, five: 95 } } as never);
  });

  test('§3.4 no files anywhere → defaults written 0600, no error', () => {
    const r = loadCaps();
    expect(r.error).toBeNull();
    expect(r.imported).toBe(false);
    expect(r.caps).toEqual(DEFAULT_CAPS);
    const f = join(home, 'caps.json');
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual(DEFAULT_CAPS);
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  test('§3.4 first run imports ~/.claude/state/cc-lanes-caps.json when caps.json is missing', () => {
    mkdirSync(join(claude, 'state'), { recursive: true });
    writeFileSync(join(claude, 'state', 'cc-lanes-caps.json'), JSON.stringify({
      default: { week: 90, five: 90 },
      'x@y': { role: 'backup', week: 50, hard: true },
    }));
    const r = loadCaps();
    expect(r.imported).toBe(true);
    expect(r.error).toBeNull();
    expect(r.caps.default).toEqual({ week: 90, five: 90 });
    expect(r.caps['x@y']).toEqual({ role: 'backup', week: 50, hard: true });
    expect(JSON.parse(readFileSync(join(home, 'caps.json'), 'utf8'))).toEqual(r.caps);
    // second run reads caps.json, does not import again
    writeFileSync(join(claude, 'state', 'cc-lanes-caps.json'), JSON.stringify({ default: { week: 10 } }));
    const r2 = loadCaps();
    expect(r2.imported).toBe(false);
    expect(r2.caps.default.week).toBe(90);
  });

  test('§3.4 legacy file unreadable → defaults + error, caps.json not written', () => {
    mkdirSync(join(claude, 'state'), { recursive: true });
    writeFileSync(join(claude, 'state', 'cc-lanes-caps.json'), 'garbage');
    const r = loadCaps();
    expect(r.caps).toEqual(DEFAULT_CAPS);
    expect(r.error).toBeString();
    expect(() => statSync(join(home, 'caps.json'))).toThrow();
  });

  test('§3.4 legacy file valid JSON but invalid caps (no default) → defaults + error, not imported', () => {
    mkdirSync(join(claude, 'state'), { recursive: true });
    writeFileSync(join(claude, 'state', 'cc-lanes-caps.json'), JSON.stringify({ 'x@y': { week: 500 } }));
    const r = loadCaps();
    expect(r.imported).toBe(false);
    expect(r.caps).toEqual(DEFAULT_CAPS);
    expect(r.error).toContain('Không nhập được');
    expect(() => statSync(join(home, 'caps.json'))).toThrow();
  });

  test('bad caps.json → defaults + error, file left untouched for the PO to fix', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'caps.json'), '{bad');
    const r = loadCaps();
    expect(r.caps).toEqual(DEFAULT_CAPS);
    expect(r.error).toBeString();
    expect(readFileSync(join(home, 'caps.json'), 'utf8')).toBe('{bad');
  });

  test('invalid entry (week > 100, unknown role) → defaults + error', () => {
    mkdirSync(home, { recursive: true });
    for (const bad of [{ default: { week: 101 } }, { default: { week: 90 }, 'a@b': { role: 'boss', week: 50 } }, { 'a@b': { week: 50 } }]) {
      writeFileSync(join(home, 'caps.json'), JSON.stringify(bad));
      const r = loadCaps();
      expect(r.caps).toEqual(DEFAULT_CAPS);
      expect(r.error).toBeString();
    }
  });
});

describe('resolveCaps', () => {
  test('§3.4 hard cap: leave at cap−1, admit new lane only at ≤ cap−3', () => {
    const r = resolveCaps(PO_CAPS, 'dev2609@example.com');
    expect(r).toMatchObject({ role: 'primary', hard: true, week: 60, weekLeaveAt: 59, weekAdmitMax: 57 });
  });

  test('§3.4 soft cap: leave at cap, admit below cap; 5h always soft even on a hard account', () => {
    const r = resolveCaps(PO_CAPS, 'pm@example.net');
    expect(r).toMatchObject({ role: 'primary', hard: false, week: 99, weekLeaveAt: 99, weekAdmitMax: 99, five: 95, fiveLeaveAt: 95 });
    const ba = resolveCaps(PO_CAPS, 'ba@example.net');
    expect(ba).toMatchObject({ role: 'backup', hard: true, five: 95, fiveLeaveAt: 95, weekLeaveAt: 69, weekAdmitMax: 67 });
  });

  test('unknown account inherits default as primary', () => {
    expect(resolveCaps(DEFAULT_CAPS, 'new@x')).toMatchObject({ role: 'primary', hard: false, week: 98, five: 95 });
  });
});

describe('§6A config.ts validation texts are keyed (T11)', () => {
  test('§6A validateConfig → {key, params}; vi and en render the same field + range', () => {
    const i = validateConfig({ ...DEFAULT_CONFIG, maxLanes: 0 })!;
    expect(i).toEqual({ key: 'config.int', params: { field: 'maxLanes', min: 1, max: 64 } });
    expect(t('vi', i.key, i.params)).toBe('config.json sai: maxLanes phải là số nguyên 1–64');
    expect(t('en', i.key, i.params)).toBe('config.json invalid: maxLanes must be an integer 1–64');
    expect(validateConfig(DEFAULT_CONFIG)).toBeNull();
  });
  test('§6A every config field kind has its own key', () => {
    const cases: [Record<string, unknown>, string, string][] = [
      [{ caffeinate: 'yes' }, 'config.bool', 'caffeinate'],
      [{ laneCaps: { a: 17 } }, 'config.emailInt', 'laneCaps'],
      [{ noNewLanes: { a: 'x' } }, 'config.emailBool', 'noNewLanes'],
      [{ notify: [] }, 'config.object', 'notify'],
      [{ ui: { lang: 'fr' } }, 'config.uiLang', 'ui'],
      [{ sharedExtra: ['../x'] }, 'config.sharedExtra', 'sharedExtra'],
      [{ volume: 101 }, 'config.int', 'volume'],
    ];
    for (const [patch, key, field] of cases) {
      const i = validateConfig({ ...DEFAULT_CONFIG, ...patch })!;
      expect(i.key).toBe(key as never);
      for (const l of ['vi', 'en'] as const) expect(t(l, i.key, i.params)).toContain(field);
    }
    expect(validateConfig([])).toEqual({ key: 'config.notObject', params: { file: 'config.json' } });
  });
  test('§6A validateCaps → {key, params} in both languages', () => {
    expect(validateCaps('x')).toEqual({ key: 'config.notObject', params: { file: 'caps.json' } });
    expect(validateCaps({})).toEqual({ key: 'config.capsNoDefault' });
    expect(validateCaps({ default: { week: 98 }, 'a@x': 3 })).toEqual({ key: 'config.capsEntry', params: { name: 'a@x' } });
    const pct = validateCaps({ default: { week: 98 }, 'a@x': { week: 98, five: 0 } })!;
    expect(pct).toEqual({ key: 'config.capsPct', params: { name: 'a@x', field: 'five' } });
    expect(t('en', pct.key, pct.params)).toBe('caps.json: "a@x".five must be a number 1–100');
    expect(t('vi', pct.key, pct.params)).toBe('caps.json: "a@x".five phải là số 1–100');
    expect(validateCaps({ default: { week: 101 } })).toMatchObject({ key: 'config.capsPct', params: { name: 'default', field: 'week' } });
    expect(validateCaps({ default: { week: 98, role: 'boss' } })).toMatchObject({ key: 'config.capsRole' });
    expect(validateCaps({ default: { week: 98, hard: 1 } })).toMatchObject({ key: 'config.capsHard' });
    expect(validateCaps({ default: { week: 98 } })).toBeNull();
  });
  test('§6A CommandError from a config issue carries the key; message = vi fallback', () => {
    const i = validateConfig({ ...DEFAULT_CONFIG, volume: -1 })!;
    const e = new CommandError('bad_input', i);
    expect(e.key).toBe('config.int');
    expect(e.params).toEqual({ field: 'volume', min: 0, max: 100 });
    expect(e.message).toBe('config.json sai: volume phải là số nguyên 0–100');
    expect(issueText(i)).toBe(e.message);
  });
  test('§6A save/load still surface the vi text', () => {
    expect(() => saveConfig({ ...DEFAULT_CONFIG, maxLanes: 99 })).toThrow('config.json sai: maxLanes phải là số nguyên 1–64');
    expect(() => saveCaps({ default: { week: 0 } })).toThrow('caps.json: "default".week phải là số 1–100');
  });
});
