// v2.4 G7b1 D55 web: the lane chip + picker (§4.5 LM1, LM2, LM4), the default row's source (§5.6), `/model` to a lane
// (§6.6 Y45), the "⋯" / ⌘K item and the lane node tooltip.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRef, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LaneView, ModelInfo, OrchestratorView, SessionModels } from '../../shared/protocol.ts';
import { makeT } from '../../shared/i18n/index.ts';
import { LangProvider } from '../src/lib/i18n.tsx';
import { laneActions } from '../src/lib/actions.ts';
import { parseInput } from '../src/lib/console.ts';
import { composerFor, ORCH } from '../src/lib/inspector.ts';
import { buildItems } from '../src/lib/palette.ts';
import { runMenuAct, type MenuHost } from '../src/ui/menuRun.ts';
import { buildFlow, type LaneData } from '../src/deck/flow/model.ts';
import { chipText, laneSubject } from '../src/lib/model.ts';
import { defaultSource, effortRow, impactLine, mismatchPick, modelRows } from '../src/lib/model-menu.ts';
import { Inspector, type InspectorProps } from '../src/ui/Inspector.tsx';
import { MenuBody, menuCmds } from '../src/ui/ModelMenu.tsx';
import { lane, snapshot } from './fixtures.ts';

const VI = makeT('vi');
const html = (el: ReactElement) => renderToStaticMarkup(<LangProvider lang="vi">{el}</LangProvider>);
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const M = (value: string, displayName: string, resolvedModel: string, effortLevels = ['low', 'medium', 'high', 'xhigh', 'max']): ModelInfo => ({ value, displayName, resolvedModel, effortLevels });
const MODELS: SessionModels = {
  defaultModel: 'opus', defaultModelName: 'Opus 5.5', defaultSource: 'settings',
  models: [M('opus', 'Opus 5.5', 'claude-opus-5-5'), M('sonnet', 'Sonnet 5.5', 'claude-sonnet-5-5'), M('haiku', 'Haiku 4.5', 'claude-haiku-4-5', [])],
};
const RUN = { model: 'claude-opus-5-5', modelName: 'Opus 5.5', effort: 'medium' };
const D2 = (over: Partial<LaneView> = {}) => lane('D2', { state: 'idle', run: RUN, ...over });
const orch = (over: Partial<OrchestratorView> = {}): OrchestratorView => ({
  projectId: 'p1', state: 'idle', account: 'a@x', homeAccount: 'a@x', lastError: null, costUsd: 1, contextPct: 41, talkingTo: null,
  sessionId: 's1', model: 'claude-fable-5-2', modelName: 'Fable 5.2', effort: 'high', modelPick: null, effortPick: null, ...over,
});

const props = (l: LaneView, over: Partial<InspectorProps> = {}, channel: 'mac' | 'remote' = 'mac'): InspectorProps => {
  const o = orch(), s = snapshot({ channel, orchestrators: [o], lanes: [l] }), sel = { k: 'lane' as const, name: l.name };
  return {
    sel, target: composerFor(sel, 'p1', 's1', s.lanes, null), snap: s, project: s.projects[0]!, now: 0, offline: false, dataAt: null, subs: {},
    stream: undefined, live: undefined, subLive: undefined, hideTools: false, onHideTools() {}, subLines: [], subLoading: false, paused: false, draft: null,
    inputRef: createRef<HTMLTextAreaElement>(), onSel() {}, onClose() {}, onMenu() {}, onSend: () => Promise.resolve(), onInterrupt() {}, onLocal() {}, onStopAsk() {}, onOrchestrator() {},
    onOlder() {}, onJumpEnd() {}, onError() {}, onResume() {}, onProjectResume: () => Promise.resolve(), onPause() {}, onMoveAll() {}, onRelogin() {}, onEditCaps() {},
    sessions: [o], viewed: o, sessionsList: null, onHistory() {}, onView() {}, onSessionResume() {}, onOpenHandoff() {}, loadPreview: () => Promise.resolve(null),
    done: { total: null, cleanupDays: 30, load: () => Promise.resolve(null), onMerge() {}, onContinue() {}, onVscode() {}, onRetry() {} },
    modelSend: () => Promise.resolve(null), modelReq: { n: 0 }, modal: false, token: () => null, onFocusInput() {}, ...over,
  };
};
const chip = (h: string) => h.match(/<(button|span) [^>]*class="mchip[^"]*"[^>]*>.*?<\/(button|span)>/)?.[0] ?? '';
const laneHtml = (l: LaneView, over: Partial<InspectorProps> = {}, channel: 'mac' | 'remote' = 'mac') => html(<Inspector {...props(l, over, channel)} />);

describe('§4.5 LM1 the lane chip in Đang xem, by the states table', () => {
  test('§4.5 LM1 chip "Opus 5.5 · medium ▾" on its own line under the lane name, above the account · tok line', () => {
    const h = laneHtml(D2());
    expect(text(chip(h))).toBe('Opus 5.5 · medium ▾');
    expect(chip(h)).toMatch(/^<button/);
    const head = h.slice(h.indexOf('class="lhead"'));
    expect(head.indexOf('class="mchip')).toBeGreaterThan(head.indexOf('class="row"'));
    expect(head.indexOf('class="mchip')).toBeLessThan(head.indexOf('pm@'));
  });
  test('§4.5 the chip reads `run` (what really runs), not the tier-1 pick', () => {
    expect(text(chip(laneHtml(D2({ model: 'sonnet', effort: 'high' }))))).toBe('Opus 5.5 · medium ▾');
  });
  test('§4.5 LM2 busy + pending: "Opus 5.5 → Sonnet 5.5 · chờ hết lượt"; composer reads "Gửi khi lượt này xong…"', () => {
    const h = laneHtml(D2({ state: 'running', pending: { model: 'sonnet', modelName: 'Sonnet 5.5' } }));
    expect(text(chip(h))).toBe('Opus 5.5 → Sonnet 5.5 · chờ hết lượt ▾');
    expect(chip(h)).toContain('wait');
    expect(h).toContain('placeholder="Gửi khi lượt này xong…"');
  });
  test('§4.5 stopped / broken / waiting quota: the chip stays a button', () => {
    for (const state of ['stopped', 'broken', 'waiting_quota'] as const) expect(chip(laneHtml(D2({ state })))).toMatch(/^<button/);
  });
  test('§4.5 a lane Claude Code has not reported yet: the pick, else "Theo mặc định"', () => {
    expect(text(chip(laneHtml(D2({ state: 'stopped', run: undefined }))))).toBe('Theo mặc định ▾');
    expect(text(chip(laneHtml(D2({ state: 'stopped', run: undefined, model: 'sonnet', effort: 'high' }))))).toBe('sonnet · high ▾');
  });
  test('§4.5 Xong: no chip; its last model · effort leads the facts line (MD12)', () => {
    const h = laneHtml(D2({ state: 'done' }));
    expect(chip(h)).toBe('');
    expect(text(h)).toContain('Opus 5.5 · medium · pm@');
  });
  test('§4.5 subagent selection: no chip', () => {
    const l = D2({ state: 'running' });
    const sub = { taskId: 't1', toolUseId: 'u1', lane: 'D2', projectId: 'p1', subagentType: 'Explore', description: 'x', status: 'running', background: false, startedAt: 0, endedAt: null, toolUses: null, totalTokens: null } as never;
    expect(laneHtml(l, { sel: { k: 'sub', lane: 'D2', taskId: 't1' }, subs: { D2: [sub] } })).not.toContain('mchip');
  });
  test('§4.5 offline: chip dimmed, still a button (picker read only)', () => {
    expect(chip(laneHtml(D2(), { offline: true }))).toContain('class="mchip off"');
  });
  test('§4.5 MD9 mismatch: amber dot on the lane chip', () => {
    expect(chip(laneHtml(D2({ modelMismatch: true, model: 'sonnet' })))).toContain('adot');
  });
  test('§4.5 LM4 / Y44 remote: plain text + lock "Đổi model trên Mac", no ▾ — the lane and Điều phối alike', () => {
    const r = chip(laneHtml(D2(), {}, 'remote'));
    expect(r).toMatch(/^<span class="mchip ro" title="Đổi model trên Mac"/);
    expect(r).toContain('<rect'); // the lock icon
    expect(text(r)).toBe('Opus 5.5 · medium');
    const o = orch(), s = snapshot({ channel: 'remote', orchestrators: [o] });
    const ro = chip(html(<Inspector {...props(D2(), { snap: s, sel: ORCH, target: composerFor(ORCH, 'p1', 's1', s.lanes, null) })} />));
    expect(ro).toMatch(/^<span class="mchip ro" title="Đổi model trên Mac"/);
  });
  test('§4.5 the `fails` line no longer carries the model (the chip replaced it)', () => {
    const h = laneHtml(D2({ state: 'stopped', model: 'sonnet', effort: 'high' }));
    const dd = h.match(/<dd class="num">.*?<\/dd>/)?.[0] ?? '';
    expect(dd).toContain('0 / 3 · ctx 40 %');
    expect(dd).not.toContain('sonnet');
  });
});

describe('§4.5 / §5.6 the lane picker', () => {
  const body = (l: LaneView, m: SessionModels | null = MODELS) => text(html(<MenuBody o={laneSubject(VI, l)!} who="lane" name="D2" models={m} loading={false}
    busy={null} err={null} olderOpen={false} lastModel={false} ro={null} account="acc11@" onModel={() => {}} onEffort={() => {}} onOlder={() => {}} onCancel={() => {}} onRetry={() => {}} />));
  test('§4.5 title "Model và effort · D2"', () => {
    expect(body(D2())).toContain('Model và effort · D2');
  });
  test('§4.5 "Theo mặc định" names the lane default + its source: agent · Cài đặt › Lane · settings.json · gói', () => {
    expect(defaultSource(VI, { ...MODELS, defaultSource: 'agent', defaultAgent: 'coder-medium' }, 'lane')).toBe('agent coder-medium');
    expect(defaultSource(VI, MODELS, 'lane')).toBe('Cài đặt › Lane');
    expect(defaultSource(VI, MODELS, 'orch')).toBe('Cài đặt › Điều phối');
    expect(defaultSource(VI, { ...MODELS, defaultSource: 'claude' }, 'lane')).toBe('~/.claude/settings.json');
    expect(defaultSource(VI, { ...MODELS, defaultSource: 'plan' }, 'lane')).toBe('mặc định của gói');
    expect(modelRows(VI, MODELS, 'lane').top[0]).toMatchObject({ value: null, name: 'Opus 5.5', code: 'Cài đặt › Lane' });
    expect(body(D2())).toContain('Theo mặc định Opus 5.5 Cài đặt › Lane');
  });
  test('§4.5 LM2 the lane wait sentence names it twice; cancel offered while pending', () => {
    const s = laneSubject(VI, D2({ state: 'running', pending: { model: 'sonnet', modelName: 'Sonnet 5.5' } }))!;
    expect(impactLine(VI, s, 'D2', false, 'lane')).toEqual({ text: 'D2 đang chạy một lượt. Sẽ đổi khi lượt này xong; tin gửi cho D2 từ giờ tới lúc đó nằm chờ.', cancel: true });
    expect(impactLine(VI, laneSubject(VI, D2({ state: 'switching' }))!, 'D2', false, 'lane')!.text).toContain('D2 đang chạy một lượt');
  });
  test('§4.5 idle → "Áp dụng từ lượt sau." (+ cache after a model change); no process → "Áp dụng khi lane chạy lại."', () => {
    expect(impactLine(VI, laneSubject(VI, D2({ state: 'waiting_po' }))!, 'D2', true, 'lane')!.text).toBe('Áp dụng từ lượt sau. Lượt đó đọc lại toàn bộ hội thoại, không dùng được cache của model cũ.');
    for (const state of ['stopped', 'broken', 'waiting_quota'] as const) expect(impactLine(VI, laneSubject(VI, D2({ state }))!, 'D2', false, 'lane')!.text).toBe('Áp dụng khi lane chạy lại.');
  });
  test('§5.6 MD9 a tier 2/3 mismatch names the default and its source', () => {
    const s = laneSubject(VI, D2({ modelMismatch: true, run: { model: 'claude-sonnet-5-5', modelName: 'Sonnet 5.5', effort: 'medium' } }))!;
    expect(mismatchPick(VI, s, MODELS, 'lane')).toBe('Opus 5.5 (Cài đặt › Lane)');
    expect(body(D2({ modelMismatch: true, run: { model: 'claude-sonnet-5-5', modelName: 'Sonnet 5.5', effort: 'medium' } })))
      .toContain('acc11@ không có Opus 5.5 (Cài đặt › Lane) — đang chạy Sonnet 5.5.');
    expect(mismatchPick(VI, { ...s, modelPick: 'sonnet' }, MODELS, 'lane')).toBe('Sonnet 5.5');
  });
  test('§4.5 a lane not reported yet: the effort row uses the levels of what it will run', () => {
    const e = effortRow(VI, laneSubject(VI, D2({ state: 'stopped', run: undefined, model: 'haiku' }))!, MODELS);
    expect(e.levels.every(l => !l.on)).toBe(true);
    expect(effortRow(VI, laneSubject(VI, D2({ state: 'stopped', run: undefined }))!, MODELS).levels.every(l => l.on)).toBe(true);
  });
  test('§5.6 the lane picker sends `session_models {lane}`, `lane_set_model`, `lane_model_cancel`', () => {
    const c = menuCmds({ kind: 'lane', projectId: 'p1', name: 'D2' });
    expect(c.list).toEqual({ cmd: 'session_models', projectId: 'p1', lane: 'D2' });
    expect(c.set({ model: 'sonnet' })).toEqual({ cmd: 'lane_set_model', projectId: 'p1', name: 'D2', model: 'sonnet' });
    expect(c.cancel).toEqual({ cmd: 'lane_model_cancel', projectId: 'p1', name: 'D2' });
    expect(menuCmds({ kind: 'orch', projectId: 'p1', sessionId: 's1' }).set({ effort: 'max' })).toEqual({ cmd: 'session_set_model', sessionId: 's1', effort: 'max' });
  });
  test('§4.5 chip text of a lane with pending effort only', () => {
    expect(chipText(VI, laneSubject(VI, D2({ pending: { effort: 'high' } }))!)).toBe('Opus 5.5 · medium → high · chờ hết lượt');
  });
});

describe('§4.5 G7b1b the other ways in: "⋯" of the lane, ⌘K, `/model` to a lane, the node tooltip', () => {
  const ctx = (l: LaneView, channel: 'mac' | 'remote' = 'mac') => ({ tr: VI, snap: snapshot({ channel, lanes: [l] }), offline: false, now: 0, tauri: true });
  test('§4.5 "⋯" of a lane has "Model / effort…" (act lane · model); a lane Xong has none; the remote channel hides it', () => {
    const it = laneActions(D2(), ctx(D2())).find(i => i.id === 'model');
    expect(it).toMatchObject({ label: 'Model / effort…', act: { t: 'lane', a: 'model', projectId: 'p1', name: 'D2' } });
    expect(laneActions(D2({ state: 'done' }), ctx(D2({ state: 'done' }))).some(i => i.id === 'model')).toBe(false);
    expect(laneActions(D2(), ctx(D2(), 'remote')).some(i => i.id === 'model')).toBe(false);
  });
  test('§4.5 ⌘K lists "D2 · Model / effort…" for the selected lane', () => {
    const pal = buildItems(VI, snapshot({ lanes: [D2()] }), { projectId: 'p1', selectedLane: 'D2', keys: ['D2'], offline: false, tauri: true });
    expect(pal.some(i => i.label === 'D2 · Model / effort…')).toBe(true);
  });
  test('§4.5 the runner selects the lane and asks for its picker (MenuHost.laneModel), no command sent', () => {
    const log: string[] = [];
    const h = { laneModel: (n: string) => log.push(`laneModel ${n}`), lane: () => D2(), send: () => { log.push('send'); return Promise.resolve(); } } as unknown as MenuHost;
    runMenuAct({ t: 'lane', a: 'model', projectId: 'p1', name: 'D2' }, h);
    expect(log).toEqual(['laneModel D2']);
  });
  test('§4.5 appMenus: laneModel picks the lane and bumps modelReq with its name (source pin)', () => {
    const src = readFileSync(new URL('../src/ui/appMenus.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/laneModel: name => \{ pick\(\{ k: 'lane', name \}\); setModelReq\(r => \(\{ n: r\.n \+ 1, lane: name \}\)\); \}/);
  });
  test('§6.6 Y45 `/model` on a lane target → the lane\'s picker (Composer passes the target lane; source pin); `@D2 /model` names D2', () => {
    expect(parseInput(VI, '/model sonnet', ['D2'])).toEqual({ kind: 'local', cmd: 'model' });
    expect(parseInput(VI, '@D2 /model', ['D2'])).toEqual({ kind: 'local', cmd: 'model', lane: 'D2' });
    expect(parseInput(VI, 'đổi sang /model x', ['D2'])).toEqual({ kind: 'send', text: 'đổi sang /model x' }); // mid-sentence: plain text
    const src = readFileSync(new URL('../src/ui/Inspector.tsx', import.meta.url), 'utf8');
    expect(src).toContain("else if (r.cmd === 'model') p.onModel(r.lane ?? lane?.name);");
  });
  test('§6.6 the slash popup names the target: "đổi model của D2"', () => {
    const h = text(laneHtml(D2()));
    expect(h).not.toContain('đổi model của Điều phối'); // popup closed in SSR; the label is per target (catalog {name})
    expect(VI('model.slashModel', { name: 'D2' })).toBe('đổi model của D2');
  });
  test('§4.5 the lane node tooltip shows what runs (`run.modelName` · `run.effort`), even "Theo mặc định"', () => {
    const tipOf = (l: LaneView) => {
      const m = buildFlow({ snap: snapshot({ lanes: [l] }), projectId: 'p1', subagents: {}, selected: null, now: 0, tr: VI, live: true });
      return (m.nodes.find(n => n.id === 'lane:D2')!.data as LaneData).tip.join(' | ');
    };
    expect(tipOf(D2())).toContain('Opus 5.5 · medium');
    expect(tipOf(D2({ model: 'sonnet', effort: 'high' }))).not.toContain('sonnet');
  });
});
