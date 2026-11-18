// v2.4 §4.5 LM3 Cài đặt › Model (D55, §5.6 tier 3): two rows, "Theo Claude Code", resolved column, levels the model lacks
// dimmed, list error → "Thử lại", offline → locked, remote → no tab; a change = one `config_update` with the whole object.
import { describe, expect, test } from 'bun:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ModelInfo, SessionModels } from '../../shared/protocol.ts';
import { makeT } from '../../shared/i18n/index.ts';
import { LangProvider } from '../src/lib/i18n.tsx';
import { INSTANT_TABS, modelDefaultsOf, modelDefaultsPatch, settingsTabs } from '../src/lib/settings.ts';
import { DefaultsBody, nextCell, rowFacts, tier4Of } from '../src/ui/ModelDefaults.tsx';

const VI = makeT('vi');
const mi = (value: string, resolvedModel: string, displayName: string, effortLevels = ['low', 'medium', 'high', 'xhigh', 'max']): ModelInfo =>
  ({ value, resolvedModel, displayName, effortLevels });
const MODELS: ModelInfo[] = [mi('default', 'claude-fable-5-2', 'Default (recommended)'), mi('fable', 'claude-fable-5-2', 'Fable 5.2'),
  mi('opus', 'claude-opus-5-5', 'Opus 5.5'), mi('haiku', 'claude-haiku-5-5', 'Haiku 5.5', []), mi('claude-opus-4-6', 'claude-opus-4-6', 'Opus 4.6', ['low', 'medium', 'high'])];
/** session_models of the project while Cài đặt › Điều phối is empty: tier 4 = settings.json `fable` · `high`. */
const LIST: SessionModels = { models: MODELS, defaultModel: 'fable', defaultModelName: 'Fable 5.2', defaultSource: 'claude', defaultEffort: null,
  claudeModel: 'fable', claudeEffort: 'high', claudeSource: 'claude' };
const T4 = tier4Of(LIST);
const NONE = { model: null, effort: null };
const html = (el: ReactElement) => renderToStaticMarkup(<LangProvider lang="vi">{el}</LangProvider>);
const body = (over: Partial<Parameters<typeof DefaultsBody>[0]> = {}) => html(<DefaultsBody cur={{ orchestrator: NONE, lane: { model: 'opus', effort: 'medium' } }}
  models={LIST} loading={false} t4={T4} account="pm@" project="hagenta" ro={false} err={null} onCell={() => {}} onRetry={() => {}} {...over} />);

describe('§4.5 LM3 the Model tab in Settings', () => {
  test('§4.5 tab "Model" between Thông báo and Engine on the Mac; remote channel: no Model tab (v2.1 G4)', () => {
    expect(settingsTabs('mac', false).map(t => t.id)).toEqual(['proj', 'acc', 'noti', 'model', 'git', 'wf', 'engine']); // hf1116 (b): + Git
    expect(settingsTabs('mac', true).map(t => t.id)).toEqual(['proj', 'acc', 'noti', 'model', 'git', 'wf', 'remote', 'engine']);
    expect(settingsTabs('remote', true).map(t => t.id)).toEqual(['remote']);
  });
  test('§4.5 U9 / Y43 the Model tab applies at once (no Lưu / Huỷ)', () => expect(INSTANT_TABS.has('model')).toBe(true));
});

describe('§5.6 modelDefaults: whole object in one config_update (R40 M6)', () => {
  test('§5.6 a missing / malformed config reads as four nulls ("Theo Claude Code")', () => {
    expect(modelDefaultsOf(undefined)).toEqual({ orchestrator: NONE, lane: NONE });
    expect(modelDefaultsOf({ lane: { model: 'opus' }, orchestrator: 7 })).toEqual({ orchestrator: NONE, lane: { model: 'opus', effort: null } });
  });
  test('§5.6 changing one cell sends the whole object (both rows), the other row untouched', () => {
    const cur = { orchestrator: { model: 'fable', effort: 'high' }, lane: NONE };
    expect(modelDefaultsPatch(cur, 'lane', { model: 'opus', effort: null })).toEqual({ modelDefaults: { orchestrator: { model: 'fable', effort: 'high' }, lane: { model: 'opus', effort: null } } });
  });
  test('§4.4 rule: a model that lacks the stored effort resets it to "Theo Claude Code"; one that has it keeps it', () => {
    expect(nextCell(LIST, T4, { model: 'opus', effort: 'xhigh' }, { model: 'claude-opus-4-6' })).toEqual({ model: 'claude-opus-4-6', effort: null });
    expect(nextCell(LIST, T4, { model: 'opus', effort: 'high' }, { model: 'claude-opus-4-6' })).toEqual({ model: 'claude-opus-4-6', effort: 'high' });
    expect(nextCell(LIST, T4, { model: 'opus', effort: 'max' }, { model: null })).toEqual({ model: null, effort: 'max' }); // tier 4 Fable has max
    expect(nextCell(LIST, T4, { model: 'opus', effort: 'max' }, { effort: null })).toEqual({ model: 'opus', effort: null });
    expect(nextCell(null, null, { model: 'opus', effort: 'max' }, { model: 'x' })).toEqual({ model: 'x', effort: 'max' }); // no list: nothing to check
  });
});

describe('§4.5 LM3 row facts', () => {
  test('§5.6 tier 4 = the ack\'s claudeModel / claudeEffort, also while a Settings default decides the session', () => {
    expect(T4).toEqual({ model: 'fable', name: 'Fable 5.2', src: 'claude', effort: 'high' });
    expect(tier4Of({ ...LIST, claudeSource: 'plan', claudeEffort: null })).toMatchObject({ src: 'plan', effort: null });
    expect(tier4Of({ ...LIST, defaultModel: 'opus', defaultModelName: 'Opus 5.5', defaultSource: 'settings' })).toEqual(T4);
    expect(tier4Of({ ...LIST, claudeModel: null })).toBeNull();
    expect(tier4Of({ models: [], defaultModel: null, defaultModelName: null, unavailable: true })).toBeNull();
  });
  test('§4.5 LM3 Điều phối "Theo Claude Code Fable 5.2" · "Theo Claude Code high" → resolved "Fable 5.2 · high" theo ~/.claude/settings.json', () => {
    const f = rowFacts(VI, 'orchestrator', NONE, LIST, T4, 'pm@');
    expect(f.model).toEqual({ label: 'Theo Claude Code', dim: 'Fable 5.2', lacks: false });
    expect(f.effort).toEqual({ label: 'Theo Claude Code', dim: 'high' });
    expect(f.res).toEqual({ main: 'Fable 5.2 · high', small: ['theo ~/.claude/settings.json'] });
    expect(rowFacts(VI, 'lane', { model: 'opus', effort: null }, LIST, T4, 'pm@').res.main).toBe('Opus 5.5 · high'); // tier-4 effort, own model
    expect(rowFacts(VI, 'lane', { model: 'haiku', effort: null }, LIST, T4, 'pm@').res.main).toBe('Haiku 5.5'); // a model with no effort
    expect(rowFacts(VI, 'lane', NONE, LIST, { ...T4!, effort: null }, 'pm@').effort).toEqual({ label: 'Theo Claude Code', dim: null });
    expect(rowFacts(VI, 'orchestrator', NONE, LIST, { ...T4!, src: 'plan' }, 'pm@').res.small).toEqual(['theo mặc định của gói']);
  });
  test('§4.5 LM3 Lane Opus 5.5 · medium → "trừ khi Điều phối hoặc agent của lane chọn riêng"', () => {
    const f = rowFacts(VI, 'lane', { model: 'opus', effort: 'medium' }, LIST, T4, 'pm@');
    expect(f.model).toEqual({ label: 'Opus 5.5', dim: null, lacks: false });
    expect(f.effort).toEqual({ label: 'medium', dim: null });
    expect(f.res).toEqual({ main: 'Opus 5.5 · medium', small: ['trừ khi Điều phối hoặc agent của lane chọn riêng'] });
  });
  test('§4.5 levels the row\'s model lacks are dimmed (Opus 4.6: no xhigh / max; Haiku: none); "Theo Claude Code" follows tier 4', () => {
    const on = (cell: { model: string | null; effort: string | null }) => rowFacts(VI, 'lane', cell, LIST, T4, 'pm@').levels.filter(l => l.on).map(l => l.level);
    expect(on({ model: 'claude-opus-4-6', effort: null })).toEqual(['low', 'medium', 'high']);
    expect(on({ model: 'haiku', effort: null })).toEqual([]);
    expect(on(NONE)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    const old = { model: 'claude-opus-4-6', name: 'Opus 4.6', src: 'claude' as const, effort: null }; // tier 4 = Opus 4.6: its levels, not every level
    expect(rowFacts(VI, 'lane', NONE, LIST, old, 'pm@').levels.filter(l => l.on).map(l => l.level)).toEqual(['low', 'medium', 'high']);
    expect(rowFacts(VI, 'lane', NONE, LIST, T4, 'pm@').levels.map(l => l.level)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
  test('§4.5 a stored model the account lacks is dimmed and named in the resolved column', () => {
    const f = rowFacts(VI, 'orchestrator', { model: 'mythos', effort: null }, LIST, T4, 'pm@');
    expect(f.model).toEqual({ label: 'mythos', dim: null, lacks: true });
    expect(f.res.small).toEqual(['pm@ không có model này']);
  });
  test('§4.5 no list: the cells keep "Theo Claude Code" + the stored value; tier 4 unknown → no name', () => {
    const f = rowFacts(VI, 'lane', { model: 'opus', effort: 'high' }, null, null, 'pm@');
    expect(f.model).toEqual({ label: 'opus', dim: null, lacks: false });
    expect(f.levels).toEqual([{ level: 'high', on: true }]);
    expect(rowFacts(VI, 'orchestrator', NONE, null, null, 'pm@').res).toEqual({ main: 'Theo Claude Code', small: [] });
  });
});

describe('§4.5 LM3 static render', () => {
  test('§4.5 LM3 title, two rows (Điều phối, Lane), four fields, resolved column, impact line, list line', () => {
    const h = body();
    expect(h).toContain('Model mặc định');
    expect(h).toContain('<b>Điều phối</b>');
    expect(h).toContain('<b>Lane</b>');
    expect(h.match(/class="field mpick/g)).toHaveLength(4);
    expect(h).toContain('Phiên / lane mới sẽ chạy');
    expect(h).toContain('Fable 5.2</span>');
    expect(h).toContain('Opus 5.5 · medium');
    expect(h).toContain('Lượt đang chạy không đổi. Không ghi vào <span class="mono">~/.claude/settings.json</span>.');
    expect(h).toContain('Danh sách model của pm@ (account của Điều phối hagenta).');
    expect(h).not.toContain('Chưa lấy được danh sách model');
    expect(h).not.toContain('disabled');
  });
  test('§4.5 MD10c list error → "Chưa lấy được danh sách model" + "Thử lại"; stored values still shown', () => {
    const h = body({ models: { models: [], defaultModel: null, defaultModelName: null, unavailable: true }, t4: null });
    expect(h).toContain('Chưa lấy được danh sách model');
    expect(h).toContain('Thử lại');
    expect(h).toContain('>opus</span>');
    expect(h).not.toContain('Danh sách model của');
  });
  test('§4.5 offline → every field locked + the lost-connection line; "Thử lại" locked too', () => {
    const h = body({ ro: true, models: { models: [], defaultModel: null, defaultModelName: null, unavailable: true } });
    expect(h.match(/class="field mpick[^"]*"[^>]*disabled=""/g)).toHaveLength(4);
    expect(h).toContain('Mất kết nối · đổi được khi nối lại');
  });
  test('§4.5 a stored model the account lacks: field dimmed (class lack)', () => {
    expect(body({ cur: { orchestrator: { model: 'mythos', effort: null }, lane: NONE } })).toContain('class="field mpick lack"');
  });
});
