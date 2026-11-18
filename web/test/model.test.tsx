// v2.4 G2 web part A: the model chip (§4.1), the picker (§4.2 MD2–MD9), the session dialog row (§4.4 MD10–MD11), `/model`,
// `/effort`, the blocked group and the `raw` flag (§6.6), the D51 composer frame (§6.2).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRef, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ModelInfo, OrchestratorView, SessionModels, SessionRowView } from '../../shared/protocol.ts';
import { makeT } from '../../shared/i18n/index.ts';
import { LangProvider } from '../src/lib/i18n.tsx';
import { composerFor, ORCH } from '../src/lib/inspector.ts';
import { parseInput } from '../src/lib/console.ts';
import { freshCmd, openCmd, resumeCmd } from '../src/lib/sessions.ts';
import { chipText, columnFit, COMPOSER_BAR_H, composerFrame, HIST_FLOOR, MENU_MIN_H, menuPlace } from '../src/lib/model.ts';
import { cacheDirty, effortRow, impactLine, modelRows, pickModel, rowMark, setModelError } from '../src/lib/model-menu.ts';
import { Inspector, type InspectorProps } from '../src/ui/Inspector.tsx';
import { MenuBody, ModelPick } from '../src/ui/ModelMenu.tsx';
import { SessionView } from '../src/ui/SessionView.tsx';
import { buildFlow, type OrchData } from '../src/deck/flow/model.ts';
import { lane, snapshot } from './fixtures.ts';

const VI = makeT('vi');
const html = (el: ReactElement) => renderToStaticMarkup(<LangProvider lang="vi">{el}</LangProvider>);
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

const M = (value: string, displayName: string, resolvedModel: string, effortLevels = ['low', 'medium', 'high', 'xhigh', 'max']): ModelInfo => ({ value, displayName, resolvedModel, effortLevels });
const MODELS: SessionModels = {
  defaultModel: 'fable', defaultModelName: 'Fable 5.2',
  models: [M('default', 'Mặc định', 'claude-fable-5-2'), M('opus', 'Opus 5.5', 'claude-opus-5-5'), M('fable', 'Fable 5.2', 'claude-fable-5-2'),
    M('sonnet', 'Sonnet 5.5', 'claude-sonnet-5-5'), M('haiku', 'Haiku 4.5', 'claude-haiku-4-5', []),
    M('claude-opus-4-6', 'Opus 4.6', 'claude-opus-4-6', ['low', 'medium', 'high', 'max']), M('claude-sonnet-4-5', 'Sonnet 4.5', 'claude-sonnet-4-5')],
};
const orch = (over: Partial<OrchestratorView> = {}): OrchestratorView => ({
  projectId: 'p1', state: 'idle', account: 'a@x', homeAccount: 'a@x', lastError: null, costUsd: 1, contextPct: 41, talkingTo: null,
  sessionId: 's1', model: 'claude-fable-5-2', modelName: 'Fable 5.2', effort: 'high', modelPick: null, effortPick: null, ...over,
});

describe('§4.1 chip text: the running model · effort, the pending change', () => {
  test('§4.1 MD1 chip = "Fable 5.2 · high"; MD5 a model without effort shows only its name', () => {
    expect(chipText(VI, orch())).toBe('Fable 5.2 · high');
    expect(chipText(VI, orch({ modelName: 'Haiku 4.5', effort: null }))).toBe('Haiku 4.5');
  });
  test('§4.2 MD4 / MD4b pending: model, effort only, both', () => {
    expect(chipText(VI, orch({ pending: { model: 'sonnet', modelName: 'Sonnet 5.5' } }))).toBe('Fable 5.2 → Sonnet 5.5 · chờ hết lượt');
    expect(chipText(VI, orch({ pending: { effort: 'max' } }))).toBe('Fable 5.2 · high → max · chờ hết lượt');
    expect(chipText(VI, orch({ pending: { model: 'sonnet', modelName: 'Sonnet 5.5', effort: 'max' } }))).toBe('Fable 5.2 · high → Sonnet 5.5 · max · chờ hết lượt');
  });
  test('§4.2 pending "Theo mặc định" with no display name reads the default label', () => {
    expect(chipText(VI, orch({ modelPick: 'opus', model: 'claude-opus-5-5', modelName: 'Opus 5.5', pending: { model: null } }))).toBe('Opus 5.5 → Theo mặc định · chờ hết lượt');
  });
});

describe('§4.2 model list: default row first, aliases, older group; one rule for the marks', () => {
  test('§4.2 "Theo mặc định" + its model + the settings source; `default` hidden (A3); aliases in order; full ids in "Model cũ hơn"', () => {
    const r = modelRows(VI, MODELS);
    expect(r.top.map(x => x.label)).toEqual(['Theo mặc định', 'Opus 5.5', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 4.5']);
    expect(r.top[0]).toMatchObject({ value: null, name: 'Fable 5.2', code: '~/.claude/settings.json' });
    expect(r.top[1]).toMatchObject({ value: 'opus', code: 'claude-opus-5-5' });
    expect(r.older.map(x => x.value)).toEqual(['claude-opus-4-6', 'claude-sonnet-4-5']);
    expect(modelRows(VI, { ...MODELS, defaultModel: null }).top[0]!.code).toBe('mặc định của gói');
  });
  test('§4.2 marks: ✓ = the pick ("Theo mặc định" when none, never on the alias of the same model); clock = pending; amber = running ≠ pick (MD9)', () => {
    const rows = modelRows(VI, MODELS);
    const marks = (o: OrchestratorView) => [...rows.top, ...rows.older].map(r => rowMark(o, r));
    expect(marks(orch())).toEqual(['pick', null, null, null, null, null, null]);
    expect(marks(orch({ pending: { model: 'sonnet', modelName: 'Sonnet 5.5' } }))[3]).toBe('pending');
    expect(marks(orch({ modelPick: 'opus', model: 'claude-sonnet-5-5', modelName: 'Sonnet 5.5', modelMismatch: true })))
      .toEqual([null, 'pick', null, 'running', null, null, null]);
  });
});

describe('§4.2 effort row: running level lit, levels by model, fallback note', () => {
  test('§4.2 MD2 running level lit even with no pick; all five enabled', () => {
    const e = effortRow(VI, orch(), MODELS);
    expect(e.lit).toBe('high');
    expect(e.levels.filter(l => l.on).map(l => l.level)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(e.note).toBeNull();
  });
  test('§4.2 MD3 a level the model lacks is dimmed and named: "Opus 4.6 không có mức xhigh"', () => {
    const e = effortRow(VI, orch({ model: 'claude-opus-4-6', modelName: 'Opus 4.6', modelPick: 'claude-opus-4-6' }), MODELS);
    expect(e.levels.find(l => l.level === 'xhigh')!.on).toBe(false);
    expect(e.note).toBe('Opus 4.6 không có mức xhigh');
  });
  test('§4.2 picked xhigh, Opus 4.6 runs high → lit = high + "Đã chọn xhigh; Opus 4.6 chạy high."', () => {
    const e = effortRow(VI, orch({ model: 'claude-opus-4-6', modelName: 'Opus 4.6', effortPick: 'xhigh', effort: 'high' }), MODELS);
    expect(e.lit).toBe('high');
    expect(e.note).toBe('Đã chọn xhigh; Opus 4.6 chạy high.');
  });
  test('§4.2 the fallback note only when the running level differs from the pick (same level → the plain "không có mức" note)', () => {
    const e = effortRow(VI, orch({ model: 'claude-opus-4-6', modelName: 'Opus 4.6', effortPick: 'xhigh', effort: 'xhigh' }), MODELS);
    expect(e.note).toBe('Opus 4.6 không có mức xhigh');
  });
  test('§4.2 MD5 a model without effort: every level dimmed + "<model> không có mức effort"', () => {
    const e = effortRow(VI, orch({ model: 'claude-haiku-4-5', modelName: 'Haiku 4.5', effort: null }), MODELS);
    expect(e.levels.every(l => !l.on)).toBe(true);
    expect(e.note).toBe('Haiku 4.5 không có mức effort');
  });
  test('§4.2 MD8 list not loaded: only the running level is lit, the row is locked', () => {
    const e = effortRow(VI, orch(), null);
    expect(e.levels.every(l => !l.on)).toBe(true);
    expect(e.lit).toBe('high');
  });
  test('§4.2 MD4 a pending effort carries the clock; the levels follow the pending model', () => {
    const e = effortRow(VI, orch({ pending: { effort: 'max' } }), MODELS);
    expect(e.pending).toBe('max');
    expect(effortRow(VI, orch({ pending: { model: 'haiku', modelName: 'Haiku 4.5' } }), MODELS).note).toBe('Haiku 4.5 không có mức effort');
  });
});

describe('§4.2 impact line', () => {
  test('§4.2 first turn / idle / idle after a model change (+ cache) / running (MD4) / stopped (MD7) / mismatch (MD9 → none)', () => {
    expect(impactLine(VI, orch({ contextPct: null }), 'Điều phối', false)).toEqual({ text: 'Áp dụng từ lượt đầu tiên.', cancel: false });
    expect(impactLine(VI, orch(), 'Điều phối', false)!.text).toBe('Áp dụng từ lượt sau.');
    expect(impactLine(VI, orch(), 'Điều phối', true)!.text).toBe('Áp dụng từ lượt sau. Lượt đó đọc lại toàn bộ hội thoại, không dùng được cache của model cũ.');
    expect(impactLine(VI, orch({ state: 'running', pending: { effort: 'max' } }), 'Điều phối', false))
      .toEqual({ text: 'Điều phối đang chạy một lượt. Sẽ đổi khi lượt này xong; tin gửi từ giờ tới lúc đó nằm chờ.', cancel: true });
    expect(impactLine(VI, orch({ state: 'running' }), 'Điều phối', false)!.cancel).toBe(false);
    expect(impactLine(VI, orch({ state: 'stopped' }), 'Điều phối', false)!.text).toBe('Áp dụng khi phiên chạy lại.');
    expect(impactLine(VI, orch({ modelMismatch: true }), 'Điều phối', false)).toBeNull();
  });
  test('§4.2 MD6 errors: model_not_found names the id, timeout, unsupported', () => {
    expect(setModelError(VI, 'model_not_found', 'claude-opus-5-5')).toBe('Không đổi được: Claude Code không nhận model claude-opus-5-5.');
    expect(setModelError(VI, 'timeout', 'x')).toBe('Claude Code không trả lời sau 5 giây. Thử lại.');
    expect(setModelError(VI, 'unsupported', 'x')).toBe('Bản Claude Code này không đổi được model giữa phiên. Lựa chọn sẽ áp dụng khi phiên chạy lại.');
  });
});

describe('§4.2 picker body (static render)', () => {
  const body = (o: OrchestratorView, over: Partial<Parameters<typeof MenuBody>[0]> = {}) => html(<MenuBody o={o} name="Điều phối" models={MODELS} loading={false}
    busy={null} err={null} olderOpen={false} lastModel={false} ro={null} account="pm@" onModel={() => {}} onEffort={() => {}} onOlder={() => {}} onCancel={() => {}} onRetry={() => {}} {...over} />);
  test('§4.2 MD2 title, rows, EFFORT row with five buttons, impact line', () => {
    const t = text(body(orch()));
    expect(t).toContain('Model và effort · Điều phối');
    expect(t).toContain('Theo mặc định Fable 5.2 ~/.claude/settings.json');
    expect(t).toContain('Model cũ hơn (2)');
    expect(t).toContain('Áp dụng từ lượt sau.');
    expect(body(orch()).match(/class="lv[^"]*"/g)!.length).toBe(5);
    expect(body(orch())).toContain('class="lv lit"');
  });
  test('§4.2 MD2b while waiting for Claude Code: the clicked row spins, every other row and the effort row are locked', () => {
    const h = body(orch(), { busy: 'opus' });
    expect(h).toMatch(/<button[^>]*class="mrow[^"]*busy[^"]*"[^>]*>/);
    expect((h.match(/<button[^>]*class="mrow[^"]*"[^>]*disabled=""/g) ?? []).length).toBe(5); // 6 rows (5 + older toggle) − the busy one
    expect((h.match(/<button[^>]*class="lv[^"]*"[^>]*disabled=""/g) ?? []).length).toBe(5);
  });
  test('§4.2 MD3 the older group opens with its head first; the running older model opens it by itself', () => {
    expect(text(body(orch(), { olderOpen: true }))).toContain('Opus 4.6 claude-opus-4-6');
    expect(text(body(orch({ model: 'claude-opus-4-6', modelName: 'Opus 4.6', modelPick: 'claude-opus-4-6' })))).toContain('Opus 4.6 claude-opus-4-6');
    expect(text(body(orch()))).not.toContain('claude-opus-4-6');
  });
  test('§4.2 MD4 pending: clock row + "Bỏ thay đổi đang chờ" beside the waiting sentence', () => {
    const h = body(orch({ state: 'running', pending: { model: 'sonnet', modelName: 'Sonnet 5.5' } }));
    expect(h).toContain('class="mrow pending"');
    expect(text(h)).toContain('Bỏ thay đổi đang chờ');
  });
  test('§4.2 MD6 error line in red; MD8 skeleton rows; MD8b "Chưa lấy được danh sách model · Thử lại" keeps default + running rows', () => {
    expect(body(orch(), { err: 'Claude Code không trả lời sau 5 giây. Thử lại.' })).toContain('class="merr"');
    expect(body(orch(), { models: null, loading: true })).toContain('class="mskel"');
    const t = text(body(orch(), { models: { models: [], defaultModel: null, defaultModelName: null, unavailable: true } }));
    expect(t).toContain('Chưa lấy được danh sách model');
    expect(t).toContain('Thử lại');
    expect(t).toContain('Theo mặc định');
    expect(t).toContain('Fable 5.2');
  });
  test('§4.2 MD8 / MD8b no list, no pick: "Theo mặc định" (✓) + the running model row; MD8b retry is a button', () => {
    for (const m of [null, { models: [], defaultModel: null, defaultModelName: null, unavailable: true }]) {
      const h = body(orch(), { models: m, loading: m === null });
      expect(text(h)).toContain('Theo mặc định Fable 5.2 Fable 5.2 claude-fable-5-2');
      expect(h.match(/<button[^>]*class="mrow[^"]*"/g)!.length).toBe(2);
    }
    expect(body(orch(), { models: { models: [], defaultModel: null, defaultModelName: null, unavailable: true } })).toMatch(/class="mfail".*<button[^>]*class="btn sm"/);
  });
  test('§4.2 MD9 mismatch: amber dot row + "<account> không có <A> — đang chạy <B>…", no impact line', () => {
    const h = body(orch({ modelPick: 'opus', model: 'claude-sonnet-5-5', modelName: 'Sonnet 5.5', modelMismatch: true }));
    expect(h).toContain('class="mrow running"');
    expect(text(h)).toContain('pm@ không có Opus 5.5 — đang chạy Sonnet 5.5. Lựa chọn vẫn giữ cho lần chuyển account sau.');
    expect(text(h)).not.toContain('Áp dụng từ lượt sau');
  });
  test('§4.1 MD13 offline: read only (every row dimmed, incl. older) with the v2.1 offline reason', () => {
    const h = body(orch(), { ro: 'Mất kết nối · số liệu lúc 14:02 · đang nối lại' });
    expect(text(h)).toContain('Mất kết nối · số liệu lúc 14:02 · đang nối lại');
    expect(text(h)).not.toContain('Áp dụng từ lượt sau'); // the reason takes the impact line's place, under the Effort row
    expect(h.indexOf('class="mro"')).toBeGreaterThan(h.indexOf('class="meff"'));
    expect((h.match(/<button[^>]*class="(mrow|lv)[^"]*"[^>]*>/g) ?? []).every(b => b.includes('disabled'))).toBe(true);
  });
});

describe('§4.1 chip in Đang xem', () => {
  const props = (o: OrchestratorView, over: Partial<InspectorProps> = {}): InspectorProps => {
    const s = snapshot({ orchestrators: [o], lanes: [lane('D2')] });
    return {
      sel: ORCH, target: composerFor(ORCH, 'p1', 's1', s.lanes, null), snap: s, project: s.projects[0]!, now: 0, offline: false, dataAt: null, subs: {},
      stream: undefined, live: undefined, subLive: undefined, hideTools: false, onHideTools() {}, subLines: [], subLoading: false, paused: false, draft: null,
      inputRef: createRef<HTMLTextAreaElement>(), onSel() {}, onClose() {}, onMenu() {}, onSend: () => Promise.resolve(), onInterrupt() {}, onLocal() {}, onStopAsk() {}, onOrchestrator() {},
      onOlder() {}, onJumpEnd() {}, onError() {}, onResume() {}, onProjectResume: () => Promise.resolve(), onPause() {}, onMoveAll() {}, onRelogin() {}, onEditCaps() {},
      sessions: [o], viewed: o, sessionsList: null, onHistory() {}, onView() {}, onSessionResume() {}, onOpenHandoff() {}, loadPreview: () => Promise.resolve(null),
      done: { total: null, cleanupDays: 30, load: () => Promise.resolve(null), onMerge() {}, onContinue() {}, onVscode() {}, onRetry() {} },
      modelSend: () => Promise.resolve(null), modelReq: { n: 0 }, modal: false, token: () => null, onFocusInput() {}, ...over,
    };
  };
  const chip = (h: string) => h.match(/<(button|span) [^>]*class="mchip[^"]*"[^>]*>.*?<\/(button|span)>/)?.[0] ?? '';
  test('§4.1 MD1 chip on its own line between the name row and the v2.1 meta line', () => {
    const h = html(<Inspector {...props(orch())} />);
    expect(text(chip(h))).toBe('Fable 5.2 · high ▾');
    expect(h.indexOf('class="mchip')).toBeGreaterThan(h.indexOf('class="row"'));
    expect(h.indexOf('class="mchip')).toBeLessThan(h.indexOf('class="meta mono"'));
    expect(chip(h)).toMatch(/^<button/);
  });
  test('§4.1 MD9 amber dot on the chip when the running model differs from the pick', () => {
    expect(chip(html(<Inspector {...props(orch({ modelMismatch: true, modelPick: 'opus' }))} />))).toContain('mis');
  });
  test('§4.1 MD13 offline: chip dimmed, still a button (opens read only); remote: plain text, no ▾', () => {
    expect(chip(html(<Inspector {...props(orch(), { offline: true })} />))).toContain('class="mchip off"');
    const s = snapshot({ channel: 'remote', orchestrators: [orch()] });
    const r = chip(html(<Inspector {...props(orch(), { snap: s })} />));
    expect(r).toMatch(/^<span/);
    expect(r).not.toContain('chev');
  });
  test('§4.5 D55 a lane selection shows the lane\'s chip, not Điều phối\'s; §4.2 MD4b the placeholder reads "Gửi khi lượt này xong…" while a change waits', () => {
    const o = orch();
    const l = html(<Inspector {...props(o, { sel: { k: 'lane', name: 'D2' }, target: { kind: 'lane', projectId: 'p1', name: 'D2' } })} />);
    expect(text(chip(l))).toBe('Theo mặc định ▾');
    const h = html(<Inspector {...props(orch({ state: 'running', pending: { effort: 'max' } }))} />);
    expect(h).toContain('placeholder="Gửi khi lượt này xong…"');
  });
});

describe('§6.6 `/` at the composer', () => {
  const lanes = ['D2'];
  test('§6.6 `/model`, `/effort` → open the picker (args ignored); never sent', () => {
    expect(parseInput(VI, '/model sonnet', lanes)).toEqual({ kind: 'local', cmd: 'model' });
    expect(parseInput(VI, '/EFFORT', lanes)).toEqual({ kind: 'local', cmd: 'model' });
  });
  test('§6.6 Y45 `/model` with an `@lane` prefix → that lane\'s picker (args ignored), never sent', () => {
    expect(parseInput(VI, '@D2 /effort high', lanes)).toEqual({ kind: 'local', cmd: 'model', lane: 'D2' });
    expect(parseInput(VI, '@d2 /MODEL', lanes)).toEqual({ kind: 'local', cmd: 'model', lane: 'D2' });
  });
  test('§6.6 Y34 blocked group: /clear, /login, /logout → red line, not sent', () => {
    expect(parseInput(VI, '/clear', lanes)).toEqual({ kind: 'error', text: '/clear không dùng được ở đây · dùng /new' });
    expect(parseInput(VI, '@D2 /Logout', lanes)).toEqual({ kind: 'error', text: 'Đăng nhập account làm ở bảng Account' });
    expect(parseInput(VI, '/login', lanes)).toEqual({ kind: 'error', text: 'Đăng nhập account làm ở bảng Account' });
  });
  test('§6.6 / §6.3 the shell puts `raw` and the chips (`attachments`, §5.5) on the `send` command (LeftColumn → engine)', () => {
    const left = readFileSync(new URL('../src/ui/LeftColumn.tsx', import.meta.url), 'utf8');
    expect(left).toMatch(/onSend=\{\(t, text, raw, attachments\) => \{[^}]*send\(\{ cmd: 'send', target: t, text, \.\.\.\(raw \? \{ raw \} : \{\}\), \.\.\.\(attachments\?\.length \? \{ attachments \} : \{\}\) \}\)/);
  });
  test('§6.6 other `/` lines go out `raw` (skill, built-in, MCP prompt, `/new-feature` is not `/new`); plain text has no flag', () => {
    expect(parseInput(VI, '/find-skills pdf', lanes)).toEqual({ kind: 'send', text: '/find-skills pdf', raw: true });
    expect(parseInput(VI, '/new-feature', lanes)).toEqual({ kind: 'send', text: '/new-feature', raw: true });
    expect(parseInput(VI, '@D2 /context', lanes)).toEqual({ kind: 'send', lane: 'D2', text: '/context', raw: true });
    expect(parseInput(VI, '/mcp__gh__pr', lanes)).toEqual({ kind: 'send', text: '/mcp__gh__pr', raw: true });
    expect(parseInput(VI, 'chạy test', lanes)).toEqual({ kind: 'send', text: 'chạy test' });
    expect(parseInput(VI, '/lanes', lanes)).toEqual({ kind: 'local', cmd: 'lanes' });
  });
});

describe('§6.2 D51 composer: one frame, fixed 28 px bar below the text', () => {
  test('§6.2 the bar keeps its place for 1 → 6 lines of text; the text grows upward to the 120 px cap', () => {
    const line = 20, pad = 16, border = 2; // #cmd line-height 1.4 × 14 px ≈ 20
    const frames = [1, 2, 3, 4, 5, 6].map(n => composerFrame(n * line + pad, border));
    expect(new Set(frames.map(f => f.barBottom)).size).toBe(1);
    expect(frames.every(f => f.barH === COMPOSER_BAR_H && COMPOSER_BAR_H === 28)).toBe(true);
    expect(frames.map(f => f.textH)).toEqual([38, 58, 78, 98, 118, 120]);
    for (let i = 1; i < 6; i++) expect(frames[i]!.height).toBeGreaterThanOrEqual(frames[i - 1]!.height);
    expect(frames[5]!.height).toBe(frames[4]!.height + 2); // capped: frame stops growing
  });
  test('§6.2 markup: frame = [chip slot] → textarea (full width) → bar (recipient left, send right); bar after the text', () => {
    const s = snapshot({ orchestrators: [orch()] });
    const h = html(<Inspector sel={ORCH} target={{ kind: 'orchestrator', projectId: 'p1', sessionId: 's1' }} snap={s} project={s.projects[0]!} now={0} offline={false} dataAt={null}
      subs={{}} stream={undefined} live={undefined} subLive={undefined} hideTools={false} onHideTools={() => {}} subLines={[]} subLoading={false} paused={false} draft={null}
      inputRef={createRef()} onSel={() => {}} onClose={() => {}} onMenu={() => {}} modal={false} token={() => null} onFocusInput={() => {}} onSend={() => Promise.resolve()} onInterrupt={() => {}} onLocal={() => {}} onStopAsk={() => {}} onOrchestrator={() => {}}
      onOlder={() => {}} onJumpEnd={() => {}} onError={() => {}} onResume={() => {}} onProjectResume={() => Promise.resolve()} onPause={() => {}} onMoveAll={() => {}} onRelogin={() => {}} onEditCaps={() => {}}
      sessions={s.orchestrators} viewed={s.orchestrators[0]!} sessionsList={null} onHistory={() => {}} onView={() => {}} onSessionResume={() => {}} onOpenHandoff={() => {}}
      loadPreview={() => Promise.resolve(null)} done={{ total: null, cleanupDays: 30, load: () => Promise.resolve(null), onMerge() {}, onContinue() {}, onVscode() {}, onRetry() {} }}
      modelSend={() => Promise.resolve(null)} modelReq={{ n: 0 }} />);
    const frame = h.slice(h.indexOf('class="inrow'));
    expect(frame.indexOf('<textarea')).toBeLessThan(frame.indexOf('class="cbar"'));
    expect(frame.indexOf('class="cbar"')).toBeLessThan(frame.indexOf('class="target"'));
    expect(frame.indexOf('class="target"')).toBeLessThan(frame.indexOf('class="send"'));
  });
  test('§6.2 CSS: frame is a column; bar 28 px, never shrinks; send 30 × 28; recipient tinted without border; neutral --fg-2 ring while the text has the caret (v26-fw M6: no accent border)', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.inrow\{[^}]*flex-direction:column/);
    expect(css).toMatch(/\.cbar\{[^}]*height:28px[^}]*flex:none/);
    expect(css).toMatch(/#inspector \.send\{[^}]*width:30px;height:28px/);
    expect(css).toMatch(/\.target\{[^}]*border:0/);
    expect(css).toMatch(/\.inrow:has\(#cmd:focus\)\{box-shadow:inset 0 0 0 1px var\(--fg-2\)\}/);
  });
});

describe('§4.4 session dialogs: Model · Effort row', () => {
  test('§4.4 MD10 defaults: "Theo mặc định (<tên>)" and "Theo mặc định"', () => {
    const h = html(<ModelPick models={MODELS} loading={false} model={null} effort={null} onChange={() => {}} onRetry={() => {}} />);
    expect(text(h)).toContain('Theo mặc định (Fable 5.2)');
    expect(text(h)).toContain('Model');
    expect(text(h)).toContain('Effort');
  });
  test('§4.4 MD10c list unavailable: both fields still usable + "Chưa lấy được danh sách model · Thử lại"; MD11 resume keeps the old pick', () => {
    const h = html(<ModelPick models={{ models: [], defaultModel: null, defaultModelName: null, unavailable: true }} loading={false} model="opus" effort="high" onChange={() => {}} onRetry={() => {}} />);
    expect(text(h)).toContain('Chưa lấy được danh sách model');
    expect(text(h)).toContain('opus');
    expect(text(h)).toContain('high');
    expect(h).not.toMatch(/<button[^>]*class="mpick[^"]*"[^>]*disabled/);
  });
  test('§4.4 IMPORTANT-1 one pick = model + effort together; the effort resets only when the new model lacks it', () => {
    const OH = { model: 'opus', effort: 'high' };
    expect(pickModel(MODELS, OH, 'haiku')).toEqual({ model: 'haiku', effort: null }); // review repro: was { Opus 5.5, '' }
    expect(pickModel(MODELS, OH, 'sonnet')).toEqual({ model: 'sonnet', effort: 'high' });
    expect(pickModel(MODELS, { model: 'opus', effort: 'xhigh' }, 'claude-opus-4-6')).toEqual({ model: 'claude-opus-4-6', effort: null });
    // "Theo mặc định" looks up defaultModel (fable has high): the effort stays (was: always reset)
    expect(pickModel(MODELS, OH, null)).toEqual({ model: null, effort: 'high' });
    expect(pickModel({ ...MODELS, defaultModel: 'haiku' }, OH, null)).toEqual({ model: null, effort: null });
    expect(pickModel(null, OH, 'haiku')).toEqual({ model: 'haiku', effort: 'high' }); // no list: nothing to check against
  });
  // the pick sequence of the review repro (Opus → high → Haiku, then "Theo mặc định") through each dialog's command
  const picked = (last: string | null) => pickModel(MODELS, pickModel(MODELS, { ...pickModel(MODELS, { model: null, effort: null }, 'opus'), effort: 'high' }, 'haiku'), last);
  test('§4.4 MD10 parallel dialog: session_open carries the last pick (Haiku, effort reset)', () => {
    expect(openCmd('p1', { title: '', first: '', account: null, ...picked('haiku') })).toEqual({ cmd: 'session_open', projectId: 'p1', model: 'haiku' });
  });
  test('§4.4 MD11 resume dialog: session_resume carries the last pick', () => {
    expect(resumeCmd('s9', { mode: 'parallel', replaceId: null, account: null, pvAccount: 'a@x', ...picked('haiku') }))
      .toEqual({ cmd: 'session_resume', sessionId: 's9', mode: 'parallel', model: 'haiku', effort: null });
    expect(resumeCmd('s9', { mode: 'replace', replaceId: 's1', account: 'b@x', pvAccount: 'a@x', ...picked('sonnet') }))
      .toEqual({ cmd: 'session_resume', sessionId: 's9', mode: 'replace', replaceId: 's1', account: 'b@x', model: 'sonnet', effort: null });
  });
  test('§4.4 new session from #n (handoff / tail): session_open from carries the last pick', () => {
    expect(freshCmd('p1', 's9', 'handoff', { mode: 'parallel', replaceId: null, account: null, ...picked('haiku') }))
      .toEqual({ cmd: 'session_open', projectId: 'p1', from: { sessionId: 's9', kind: 'handoff' }, model: 'haiku' });
    expect(freshCmd('p1', 's9', 'tail', { mode: 'replace', replaceId: 's1', account: 'b@x', ...pickModel(MODELS, { model: 'opus', effort: 'high' }, null) }))
      .toEqual({ cmd: 'session_open', projectId: 'p1', from: { sessionId: 's9', kind: 'tail' }, replaceId: 's1', account: 'b@x', effort: 'high' });
  });
  test('§4.4 every dialog row hands ModelPick one onChange straight to its state (no per-field callbacks)', () => {
    const src = readFileSync(new URL('../src/ui/SessionDialogs.tsx', import.meta.url), 'utf8');
    expect(src).toMatch(/<ModelPick [^>]*onChange=\{onPick\}/);
    const pick = readFileSync(new URL('../src/ui/ModelMenu.tsx', import.meta.url), 'utf8');
    expect(pick).toMatch(/const pick = \(v: string \| null\) => \{ p\.onChange\(pickModel\(m, \{ model: p\.model, effort: p\.effort \}, v\)\);/);
    expect(src.match(/<ModelRow [^>]*v=\{mp\} onPick=\{setMp\}[^>]*\/>/g)).toHaveLength(3); // + v2.7.1 the start dialog
    expect(src).toMatch(/resumeCmd\(p\.sessionId, \{ mode, replaceId: rep, account: acc, pvAccount: pv\.account, \.\.\.mp \}\)/);
    expect(src).toMatch(/freshCmd\(pv\.projectId, p\.sessionId, kind, \{ mode, replaceId: rep, account: acc, \.\.\.mp \}\)/);
  });
  test('§4.4 session_open carries model / effort only when picked', () => {
    expect(openCmd('p1', { title: '', first: '', account: null, model: 'sonnet', effort: 'max' })).toEqual({ cmd: 'session_open', projectId: 'p1', model: 'sonnet', effort: 'max' });
    expect(openCmd('p1', { title: '', first: '', account: null, model: null, effort: null })).toEqual({ cmd: 'session_open', projectId: 'p1' });
  });
});

describe('§4.2 picker placement', () => {
  test('§4.2 under the chip down to the composer when the room is ≥ MENU_MIN_H; above the chip when it is not', () => {
    const frame = { top: 820, bottom: 890, left: 12, right: 412 };
    expect(menuPlace(900, { top: 100, bottom: 900, left: 12, right: 412 }, { top: 150, bottom: 172, left: 27, right: 140 }, frame))
      .toEqual({ left: 20, width: 384, top: 176, maxH: 640 }); // MD7 a short list: the box ends with it (max, not fixed)
    const up = menuPlace(900, { top: 500, bottom: 900, left: 12, right: 412 }, { top: 640, bottom: 662, left: 27, right: 140 }, frame);
    expect(up.top).toBeUndefined();
    expect(up).toEqual({ left: 20, width: 384, bottom: 264, maxH: 632 });
    expect(MENU_MIN_H).toBe(172);
  });
  test('§4.2 a short room still opens under the chip (only the model list scrolls): dev DK5, chip 591–611, composer 807', () => {
    const p = menuPlace(900, { top: 470, bottom: 885, left: 12, right: 412 }, { top: 591, bottom: 611, left: 27, right: 140 }, { top: 807, bottom: 875, left: 12, right: 412 });
    expect(p).toEqual({ left: 20, width: 384, top: 615, maxH: 188 });
  });
});

describe('§4.1 node tooltip (v2.1 §4.4 N1-i)', () => {
  const tipOf = (o: Partial<OrchestratorView>) => {
    const s = snapshot({});
    Object.assign(s.orchestrators[0]!, o);
    const m = buildFlow({ snap: s, projectId: 'p1', subagents: {}, selected: null, now: 0, tr: VI, live: true });
    return (m.nodes.find(n => n.type === 'orchestrator')!.data as OrchData).tip;
  };
  test('§4.1 the Điều phối tip shows effort right after the model', () => {
    expect(tipOf({ model: 'claude-fable-5-2', effort: 'high' })).toContain('a@ · claude-fable-5-2 · high · ctx 41%');
  });
  test('§4.1 a model with no effort (Haiku) shows the model only', () => {
    expect(tipOf({ model: 'claude-haiku-4-5', effort: null })).toContain('a@ · claude-haiku-4-5 · ctx 41%');
  });
});

describe('§4.1 MD12 ended session', () => {
  const row: SessionRowView = { sessionId: 's1', projectId: 'p1', seq: 1, title: 'lot-2', state: 'ended', startedAt: 1, endedAt: 2, accountFirst: 'pm@x',
    accountLast: 'pm@x', lanes: 0, tokens: { input: 1, output: 0, cacheWrite: 0, cacheRead: 0 }, costUsd: 1, endReason: 'ended_by_po', handoffPath: null,
    ctxLast: 61_000, resumable: true, model: 'claude-opus-5-5', modelName: 'Opus 5.5', effort: 'xhigh' };
  const view = (r: SessionRowView) => html(<SessionView row={r} channel="mac" offline={false} stream={undefined} onResume={() => {}} onOpenHandoff={() => {}}
    loadPreview={() => Promise.resolve(null)} onOlder={() => {}} onJumpEnd={() => {}} hideTools={false} />);
  test('§4.1 MD12 the last model · effort heads the mono meta line, plain text (no chip, no ▾)', () => {
    const h = view(row);
    expect(text(h.match(/<div class="meta mono">.*?<\/div>/)![0])).toMatch(/^Opus 5\.5 · xhigh · /);
    expect(h).not.toContain('mchip');
    expect(view({ ...row, model: undefined, modelName: undefined, effort: undefined }).match(/<div class="meta mono">.*?<\/div>/)![0]).not.toContain('Opus');
  });
});

describe('§6.2 I1 + §6.7 R32 the Đang xem room (Chờ PO ≤ 30 % above it): the conversation keeps a floor, then the chip strip caps', () => {
  // DK2b at 1024 × 640 (probe P3): Đang xem 392 px (70 % of a 560 px column less the gap), Điều phối head + chip + stat line
  // 120 px, composer with 2 chip rows 210 px of which the strip is 86 (one row 42)
  const m = { room: 410, info: 120, composer: 210, tray: 86, one: 42, histPad: 16 };
  test('§6.2 roomy: the strip keeps its 2 rows while info + floor + padding + composer fit the room', () => {
    expect(columnFit({ ...m, room: 120 + HIST_FLOOR + 16 + 210 })).toEqual({ trayOne: false });
    expect(columnFit({ ...m, room: 900 })).toEqual({ trayOne: false });
  });
  test('§6.2 one px short of the conversation floor: the strip caps at one row (it scrolls)', () => {
    expect(columnFit({ ...m, room: 120 + HIST_FLOOR + 16 + 210 - 1 })).toEqual({ trayOne: true });
    expect(HIST_FLOOR).toBe(48); // styles.css `@container (height < 48px)` hides the rows under 48 px
  });
  test('v2.1 UX-I6 / m-2 N2-a a lane passes floor 0: only its facts + Subagent head + composer must fit', () => {
    const lane = { ...m, info: 190, composer: 160, floor: 0 };
    expect(columnFit({ ...lane, room: 190 + 16 + 160 })).toEqual({ trayOne: false });
    expect(columnFit({ ...lane, room: 190 + 16 + 160 - 1 })).toEqual({ trayOne: true });
  });
  test('§6.2 a strip of one measured row (or none) has nothing to give: never capped', () => {
    expect(columnFit({ ...m, room: 100, tray: 42 }).trayOne).toBe(false);
    expect(columnFit({ ...m, room: 100, tray: 0 }).trayOne).toBe(false);
    expect(columnFit({ ...m, room: 100, tray: 38, one: 36 }).trayOne).toBe(true); // D53: the row is measured, not a 42 px constant
  });
});

describe('§4.2 m4 the cache sentence holds while a model change since the last turn exists', () => {
  test('§4.2 model click sets it, an effort click keeps it, a turn clears it', () => {
    expect(cacheDirty(false, 'model')).toBe(true);
    expect(cacheDirty(true, 'effort')).toBe(true);
    expect(cacheDirty(false, 'effort')).toBe(false);
    expect(cacheDirty(true, 'turn')).toBe(false);
  });
});

describe('§6.2 m2 / m6 Đang xem markup', () => {
  test('m2 the stat line: "≈ $" and "5h N %" each one unbreakable item', () => {
    const s = snapshot({ orchestrators: [orch({ costUsd: 8.3, account: 'bo@example.com' })] });
    s.accounts = [{ ...s.accounts[0]!, email: 'bo@example.com', fivePct: 31 }];
    const h = html(<Inspector sel={ORCH} target={{ kind: 'orchestrator', projectId: 'p1', sessionId: 's1' }} snap={s} project={s.projects[0]!} now={0} offline={false} dataAt={null}
      subs={{}} stream={undefined} live={undefined} subLive={undefined} hideTools={false} onHideTools={() => {}} subLines={[]} subLoading={false} paused={false} draft={null}
      inputRef={createRef()} onSel={() => {}} onClose={() => {}} onMenu={() => {}} modal={false} token={() => null} onFocusInput={() => {}} onSend={() => Promise.resolve()} onInterrupt={() => {}} onLocal={() => {}} onStopAsk={() => {}} onOrchestrator={() => {}}
      onOlder={() => {}} onJumpEnd={() => {}} onError={() => {}} onResume={() => {}} onProjectResume={() => Promise.resolve()} onPause={() => {}} onMoveAll={() => {}} onRelogin={() => {}} onEditCaps={() => {}}
      sessions={s.orchestrators} viewed={s.orchestrators[0]!} sessionsList={null} onHistory={() => {}} onView={() => {}} onSessionResume={() => {}} onOpenHandoff={() => {}}
      loadPreview={() => Promise.resolve(null)} done={{ total: null, cleanupDays: 30, load: () => Promise.resolve(null), onMerge() {}, onContinue() {}, onVscode() {}, onRetry() {} }}
      modelSend={() => Promise.resolve(null)} modelReq={{ n: 0 }} />);
    expect(h).toContain('≈ $8,30 · 5h 31 %');
  });
});
