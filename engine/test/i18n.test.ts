// v2 §6A (D19): the two catalogs, `t()` and the Intl formatters (shared/i18n, used by web, engine and Tauri).
import { afterEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOGS, fmtDate, fmtNum, fmtPct, hasKey, langOf, LANGS, makeT, paramsOf, setI18nStrict, t, type Key } from '../../shared/i18n/index.ts';

afterEach(() => setI18nStrict(null));

describe('§6A catalog parity (vi = source, en = translation)', () => {
  test('§6A every vi key exists in en and vice versa', () => {
    const vi = Object.keys(CATALOGS.vi).sort();
    const en = Object.keys(CATALOGS.en).sort();
    expect(en.filter(k => !(k in CATALOGS.vi))).toEqual([]);
    expect(vi.filter(k => !(k in CATALOGS.en))).toEqual([]);
    expect(vi.length).toBeGreaterThan(50);
  });
  test('§6A same {params} set per key in vi and en', () => {
    const bad = Object.keys(CATALOGS.vi).filter(k => paramsOf(CATALOGS.vi[k]!).join() !== paramsOf(CATALOGS.en[k] ?? '').join());
    expect(bad).toEqual([]);
  });
  test('§6A no empty strings', () => {
    for (const l of LANGS) expect(Object.entries(CATALOGS[l]).filter(([, v]) => !v.trim()).map(([k]) => `${l}:${k}`)).toEqual([]);
  });
  test('R25 no English "(s)" plural: counts use the {n:one|many} helper', () => {
    expect(Object.entries(CATALOGS.en).filter(([, v]) => v.includes('(s)')).map(([k]) => k)).toEqual([]);
    expect(t('en', 'accounts.merge.moves', { n: 1 })).toBe('Move 1 file into');
    expect(t('en', 'settings.engine.lanesLeft', { n: 2 })).toBe('2 lanes still running');
  });
  test('hf1116 A-M1 no catalog file repeats a key (JSON.parse would keep only the last copy)', () => {
    const root = join(import.meta.dir, '../../shared/i18n');
    const dup = LANGS.flatMap((l) => readdirSync(join(root, l)).filter((f) => f.endsWith('.json')).flatMap((f) => {
      const keys = [...readFileSync(join(root, l, f), 'utf8').matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*:/gm)].map((m) => m[1]!);
      return keys.filter((k, i) => keys.indexOf(k) !== i).map((k) => `${l}/${f}:${k}`);
    }));
    expect(dup).toEqual([]);
  });
  test('§6A keys are <ns>.<path>', () => {
    expect(Object.keys(CATALOGS.vi).filter(k => !/^[a-z][a-zA-Z0-9]*\.[\w.]+$/.test(k))).toEqual([]);
  });
});

describe('§6A t()', () => {
  test('§6A {name} interpolation, numbers too, every occurrence', () => {
    expect(t('vi', 'accounts.cfgBad', { n: 3 })).toBe('Cấu hình chung ⚠ 3');
    expect(t('en', 'accounts.cfgBad', { n: 3 })).toBe('Shared config ⚠ 3');
    expect(t('en', 'accounts.wrongText', { got: 'a@', want: 'b@' })).toContain('a@');
  });
  test('§6A the language picks the catalog', () => {
    expect(t('vi', 'common.close')).toBe('Đóng');
    expect(t('en', 'common.close')).toBe('Close');
    expect(makeT('en')('common.close')).toBe('Close');
  });
  test('§6A missing key throws in tests', () => {
    expect(() => t('en', 'nope.missing' as Key)).toThrow(/nope\.missing/);
  });
  test('§6A missing param throws in tests', () => {
    expect(() => t('en', 'accounts.cfgBad')).toThrow(/\{n\}/);
  });
  test('§6A prod: missing key returns the key, never the Vietnamese text', () => {
    setI18nStrict(false);
    expect(t('en', 'nope.missing' as Key)).toBe('nope.missing');
    const en = CATALOGS.en;
    const saved = en['common.close']!;
    delete en['common.close'];
    try {
      expect(t('en', 'common.close')).toBe('common.close');
    } finally { en['common.close'] = saved; }
  });
  test('§6A prod: missing param leaves {name} visible', () => {
    setI18nStrict(false);
    expect(t('en', 'accounts.cfgBad')).toBe('Shared config ⚠ {n}');
  });
  test('§6A {n:one|many} picks the English singular / plural by the param (v2.3 UX M2)', () => {
    expect(t('en', 'git.conflicts', { n: 1 })).toBe('1 conflict');
    expect(t('en', 'git.conflicts', { n: 2 })).toBe('2 conflicts');
    expect(t('en', 'git.conflicts', { n: 0 })).toBe('0 conflicts');
    expect(paramsOf('{n} {n:file|files} in {dir}')).toEqual(['dir', 'n']);
    expect(() => t('en', 'git.unchanged')).toThrow(/\{n\}/);
  });
  test('§6A hasKey', () => {
    expect(hasKey('en', 'common.close')).toBe(true);
    expect(hasKey('en', 'x.y')).toBe(false);
  });
});

describe('§6A Intl formatters (vi-VN / en-US)', () => {
  test('§6A fmtNum groups by locale', () => {
    expect(fmtNum('vi', 12345.5)).toBe('12.345,5');
    expect(fmtNum('en', 12345.5)).toBe('12,345.5');
  });
  test('§6A fmtPct takes 0–100', () => {
    expect(fmtPct('en', 42)).toBe('42%');
    expect(fmtPct('vi', 42.4)).toMatch(/^42\s?%$/);
  });
  test('§6A fmtDate by locale', () => {
    const d = Date.UTC(2026, 10, 15, 9, 5);
    expect(fmtDate('en', d, { timeZone: 'UTC', day: 'numeric', month: 'short' })).toBe('Nov 15');
    expect(fmtDate('vi', d, { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' })).toBe('15/11/2026');
    expect(fmtDate('en', d, { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' })).toBe('11/15/2026');
  });
});

describe('§6A langOf(config)', () => {
  test('§6A default vi; ui.lang en → en; junk → vi', () => {
    expect(langOf({})).toBe('vi');
    expect(langOf({ ui: { lang: 'en' } })).toBe('en');
    expect(langOf({ ui: { lang: 'fr' } })).toBe('vi');
    expect(langOf({ ui: null })).toBe('vi');
  });
});
