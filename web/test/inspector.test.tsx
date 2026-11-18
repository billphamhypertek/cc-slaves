// v2.1 T8 layout C left column (spec §4 opening, §4.10, §4.11, §4.11b, §5.1 "Cột trái", §6 "Cột trái"):
// selection model, Esc ladder, Inspector bodies + composer target, Chờ PO one-line form, narrow drawer, deck area rect.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Glob } from 'bun';
import { createRef, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CardView, StreamLine, SubagentView } from '../../shared/protocol.ts';
import { makeT } from '../../shared/i18n/index.ts';
import { LangProvider } from '../src/lib/i18n.tsx';
import { ClickGuard, UndoQueue, type Timers } from '../src/lib/cards.ts';
import { cardSel, composerFor, composerTarget, crumbs, drawerNext, factsFolded, inboxMode, inboxToggle, ORCH, selUp, SHORT_Q, shortSubs, type Selection } from '../src/lib/inspector.ts';
import { keyAction } from '../src/lib/keys.ts';
import { escapeStep, layoutVars, type EscState } from '../src/ui/shell.ts';
import { Inspector, type InspectorProps } from '../src/ui/Inspector.tsx';
import { Inbox } from '../src/ui/Inbox.tsx';
import { accCardShown, loadingRows } from '../src/deck/accounts.ts';
import { account, card, lane, snapshot } from './fixtures.ts';

const VI = makeT('vi');
const NOW = 1_800_000_000_000;
const html = (el: ReactElement, lang: 'vi' | 'en' = 'vi') => renderToStaticMarkup(<LangProvider lang={lang}>{el}</LangProvider>);
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
const sub = (taskId: string, over: Partial<SubagentView> = {}): SubagentView => ({ taskId, toolUseId: 'u' + taskId, subagentType: 'tests', description: 'chạy unit lot-2',
  status: 'running', background: false, lastTool: null, toolUses: 14, totalTokens: 42000, ...over });

// ---------------------------------------------------------------- selection model
describe('§4.11b Đang xem selection: up one level, crumbs, composer target', () => {
  const lane2: Selection = { k: 'lane', name: 'D2' };
  const sub2: Selection = { k: 'sub', lane: 'D2', taskId: 't1' };
  const acc: Selection = { k: 'account', email: 'acc11@x-io.test' };
  test('§4.11 Esc "lên một cấp": sub → lane → Điều phối; account → Điều phối; Điều phối → nothing', () => {
    expect(selUp(sub2)).toEqual(lane2);
    expect(selUp(lane2)).toEqual(ORCH);
    expect(selUp({ k: 'lane', name: 'D2', subsFirst: true })).toEqual(ORCH);
    expect(selUp(acc)).toEqual(ORCH);
    expect(selUp(ORCH)).toBeNull();
  });
  test('§4.11b composer target follows the selection: orch → orch, lane → lane, sub → parent lane, account → orch', () => {
    expect(composerTarget(ORCH, 'p1', null)).toEqual({ kind: 'orchestrator', projectId: 'p1' });
    expect(composerTarget(lane2, 'p1', null)).toEqual({ kind: 'lane', projectId: 'p1', name: 'D2' });
    expect(composerTarget(sub2, 'p1', null)).toEqual({ kind: 'lane', projectId: 'p1', name: 'D2' });
    expect(composerTarget(acc, 'p1', null)).toEqual({ kind: 'orchestrator', projectId: 'p1' });
  });
  test('§4.11b breadcrumb: "Điều phối › D2 › tests", "Account › acc11@"', () => {
    const subs = { D2: [sub('t1')] };
    expect(crumbs(ORCH, VI, subs)).toEqual(['Điều phối']);
    expect(crumbs(lane2, VI, subs)).toEqual(['Điều phối', 'D2']);
    expect(crumbs(sub2, VI, subs)).toEqual(['Điều phối', 'D2', 'tests']);
    expect(crumbs(acc, VI, subs)).toEqual(['Account', 'acc11@']);
  });
});

describe('§4.11 a card in Chờ PO selects its lane / Điều phối', () => {
  test('§4.11 lane card → that lane; orchestrator card → Điều phối; system card → selection unchanged (null)', () => {
    expect(cardSel(card(1, { source: 'D2' }), ['D2', 'B2'])).toEqual({ k: 'lane', name: 'D2' });
    expect(cardSel(card(2, { source: 'orchestrator' }), ['D2'])).toEqual(ORCH);
    expect(cardSel(card(3, { kind: 'orchestrator_down', source: null }), ['D2'])).toEqual(ORCH);
    expect(cardSel(card(4, { kind: 'logged_out', source: 'engine' }), ['D2'])).toBeNull();
    expect(cardSel(card(5, { source: 'Z9' }), ['D2'])).toBeNull();
  });
});

// ---------------------------------------------------------------- Esc ladder
describe('§4.11 Esc ladder for layout C', () => {
  const none: EscState = { palette: false, stopLane: false, moveAll: false, addOpen: false, settings: false, wizard: false, up: false, drawer: false };
  test('§4.11 Esc ladder: an open "⋯" menu closes before the account panel and before Đang xem goes up; dialogs first', () => {
    expect(escapeStep({ ...none, menu: true, accPanel: true, up: true, drawer: true })).toBe('menu');
    expect(escapeStep({ ...none, menu: true, palette: true })).toBe('palette');
    expect(escapeStep({ ...none, menu: false, accPanel: true })).toBe('accPanel');
  });
  test('v2.2 §6 Esc closes the Skills & MCP sheet (after the dialogs above it, before menus)', () => {
    expect(escapeStep({ ...none, skillsMcp: true, menu: true, up: true })).toBe('skillsMcp');
    expect(escapeStep({ ...none, skillsMcp: true, palette: true })).toBe('palette');
  });
  test('§4.11 example: viewing tests of D2 + account panel open → Esc 1 closes the panel, Esc 2 back to D2, Esc 3 to Điều phối', () => {
    let sel = { k: 'sub', lane: 'D2', taskId: 't1' } as Selection;
    let accPanel = true;
    const press = () => {
      const s = escapeStep({ ...none, accPanel, up: selUp(sel) !== null });
      if (s === 'accPanel') accPanel = false;
      else if (s === 'up') sel = selUp(sel)!;
      return s;
    };
    expect(press()).toBe('accPanel');
    expect(accPanel).toBe(false);
    expect(press()).toBe('up');
    expect(sel).toEqual({ k: 'lane', name: 'D2' });
    expect(press()).toBe('up');
    expect(sel).toEqual(ORCH);
    expect(press()).toBeNull();
  });
  test('§4.11 dialogs → "⋯" menu / session list → account panel → up one level → narrow drawer', () => {
    expect(escapeStep({ ...none, accDlg: true, palette: true, menu: true })).toBe('accDlg');
    expect(escapeStep({ ...none, settings: true, menu: true })).toBe('settings');
    expect(escapeStep({ ...none, wizard: true, up: true })).toBe('wizard');
    expect(escapeStep({ ...none, menu: true, accPanel: true, up: true })).toBe('menu');
    expect(escapeStep({ ...none, accPanel: true, up: true, drawer: true })).toBe('accPanel');
    expect(escapeStep({ ...none, up: true, drawer: true })).toBe('up');
    expect(escapeStep({ ...none, drawer: true })).toBe('drawer');
    expect(escapeStep(none)).toBeNull();
  });
});

// ---------------------------------------------------------------- Inspector
const lines = (texts: string[]): StreamLine[] => texts.map((t, i) => ({ seq: i + 1, ts: NOW, kind: 'assistant', text: t }));
function props(sel: Selection, over: Partial<InspectorProps> = {}): InspectorProps {
  const s = snapshot({ lanes: [lane('D2', { account: 'acc11@x-io.test', tokens: { input: 38_000, output: 61_000, cacheRead: 0, cacheWrite: 313_000 } }), lane('B2', { state: 'broken' })],
    accounts: [account('a@x', { role: 'orchestrator' }), account('acc11@x-io.test')] });
  s.orchestrators[0]!.talkingTo = 'D2';
  const sn = over.snap ?? s;
  return {
    sel, target: composerFor(sel, sn.projects[0]!.id, sn.orchestrators[0]?.sessionId ?? null, sn.lanes, null), snap: s, project: s.projects[0]!, now: NOW, offline: false, dataAt: null,
    subs: { D2: [sub('t1'), sub('t2', { subagentType: 'review', description: 'soát contract' })] },
    stream: { lines: lines(['Đã giao D2 port parser lot-2']), hasOlder: false, newer: false } as never, live: undefined, subLive: undefined, hideTools: false, onHideTools: () => {},
    subLines: lines(['Viết test cho 3 endpoint']), subLoading: false, paused: false, draft: null,
    inputRef: createRef<HTMLTextAreaElement>(),
    onSel() {}, onClose() {}, onMenu() {}, onSend: () => Promise.resolve(), onInterrupt() {}, onLocal() {}, onStopAsk() {}, onOrchestrator() {},
    onOlder() {}, onJumpEnd() {}, onError() {}, onResume() {}, onProjectResume: () => Promise.resolve(),
    onPause() {}, onMoveAll() {}, onRelogin() {}, onEditCaps() {},
    sessions: (over.snap ?? s).orchestrators, viewed: (over.snap ?? s).orchestrators[0] ?? null, sessionsList: null,
    onHistory() {}, onView() {}, onSessionResume() {}, onOpenHandoff() {}, loadPreview: () => Promise.resolve(null),
    done: { total: null, cleanupDays: 30, load: () => Promise.resolve(null), onMerge() {}, onContinue() {}, onVscode() {}, onRetry() {} }, modelSend: () => Promise.resolve(null), modelReq: { n: 0 }, modal: false, token: () => null, onFocusInput() {},
    ...over,
  };
}
const crumbOf = (h: string) => text(h.match(/<nav class="crumb"[^>]*>(.*?)<\/nav>/)?.[1] ?? '').trim();
const targetBtn = (h: string) => text(h.match(/<button class="target"[^>]*>(.*?)<\/button>/)?.[1] ?? '').trim();
const ph = (h: string) => h.match(/<textarea[^>]*placeholder="([^"]*)"/)?.[1] ?? '';

describe('§4.7 UX-I11 a Thiết kế session in the Inspector', () => {
  test('§4.7 new: title "Thiết kế · 15:02" in the crumb, the empty state, "Kể ý tưởng cho spec mới…"; after a PO line "Nói tiếp…"', () => {
    const p0 = props(ORCH), d = { ...p0.snap.orchestrators[0]!, orchKind: 'design' as const, title: 'Thiết kế · 15:02', state: 'idle' as const };
    const g = { ...d, sessionId: 's-g', orchKind: 'general' as const, title: 'hotfix' };
    const h = html(<Inspector {...props(ORCH, { viewed: d, sessions: [g, d], stream: { lines: [], hasOlder: false, newer: false } as never })} />);
    expect(crumbOf(h)).toBe('Thiết kế · 15:02');
    expect(text(h)).not.toContain('· Thiết kế · 15:02'); // UX-I1 the title is the name: never repeated as "· title"
    expect(text(html(<Inspector {...props(ORCH, { viewed: g, sessions: [g, d] })} />))).toContain('· hotfix');
    expect(text(h)).toContain('Phiên Thiết kế mới.');
    expect(ph(h)).toBe('Kể ý tưởng cho spec mới…');
    const po: StreamLine = { seq: 1, ts: NOW, kind: 'po', text: 'ý tưởng' };
    const h2 = html(<Inspector {...props(ORCH, { viewed: d, stream: { lines: [po], hasOlder: false, newer: false } as never })} />);
    expect(text(h2)).not.toContain('Phiên Thiết kế mới.');
    expect(ph(h2)).toBe('Nói tiếp với phiên Thiết kế…');
  });
});

describe('§4.11b Inspector: one block, body by selection kind', () => {
  test('v2.3 §4.3 Inspector takes the composer target from its prop ("Nhờ D2 …" while Đang xem = Điều phối), not from sel', () => {
    const h = html(<Inspector {...props(ORCH, { target: { kind: 'lane', projectId: 'p1', name: 'D2' } })} />);
    expect(crumbOf(h)).toBe('Điều phối');
    expect(targetBtn(h)).toBe('D2'); // v2.4 §6.2 D51: "↳" is drawn by CSS
  });
  test('§4.11b Điều phối (default): status "làm với D2", Ngắt lượt, orchestrator conversation, composer → Điều phối', () => {
    const h = html(<Inspector {...props(ORCH)} />);
    expect(h).toContain('id="inspector"');
    expect(crumbOf(h)).toBe('Điều phối');
    expect(text(h)).toContain('làm với D2');
    expect(text(h)).toContain('Ngắt lượt');
    expect(text(h)).toContain('Đã giao D2 port parser lot-2');
    expect(targetBtn(h)).toBe('Điều phối');
    expect(h).not.toContain('class="x"'); // nothing to deselect at the root
  });
  test('§4.11b Lane: crumb "Điều phối › D2", v1 F8 fields, Subagent section, "⋯", composer → D2', () => {
    const h = html(<Inspector {...props({ k: 'lane', name: 'D2' })} />), t = text(h);
    expect(crumbOf(h)).toBe('Điều phối › D2');
    for (const s of ['Đang chạy', 'Ngắt lượt', 'Dừng', 'Worktree', 'Lỗi liên tiếp', 'acc11@', '412k tok', '≈ $1,00', 'Subagent · 2 đang chạy', 'soát contract'])
      expect(t).toContain(s);
    expect(h).toContain('aria-label="Menu D2"');
    expect(targetBtn(h)).toBe('D2'); // v2.4 §6.2 D51: "↳" is drawn by CSS
    expect(h).toContain('class="x"');
  });
  test('§4.11b lane head keeps only Ngắt lượt / Dừng / Chạy lại + "⋯" (Chuyển account, VS Code, Terminal live in the §4.12 menu)', () => {
    const t = text(html(<Inspector {...props({ k: 'lane', name: 'D2' })} />));
    for (const s of ['Chuyển account', 'VS Code', 'Terminal']) expect(t).not.toContain(s);
  });
  test('§2 anti-goal W5: the Điều phối composer chip is neutral (no purple --orch accent)', () => {
    const h = html(<Inspector {...props(ORCH)} />);
    const chip = /<button class="target"[^>]*style="([^"]*)"/.exec(h)![1]!;
    expect(chip).toContain('--c:var(--fg-3)');
    expect(h).not.toContain('var(--orch)');
  });
  test('§2 anti-goal W5: no purple anywhere in the web CSS (status dot neutral, ĐIỀU PHỐI tag cyan, --orch = accent)', () => {
    const hue = (hex: string): [number, number] => {
      const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      if (!d) return [0, 0];
      const h = (mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
      return [h, d / (1 - Math.abs(mx + mn - 1))];
    };
    const files = [...new Glob('src/**/*.css').scanSync(new URL('..', import.meta.url).pathname)];
    expect(files.length).toBeGreaterThanOrEqual(3);
    // v2.8: the account colours (`--pal-1…8`, purple first since v1) moved from labels.ts into the variable blocks: not deck chrome
    const purple = files.flatMap(f => [...readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/--pal-\d:#[0-9a-f]+/gi, '').matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)]
      .map(m => (m[1]!.length === 3 ? [...m[1]!].map(c => c + c).join('') : m[1]!))
      .filter(x => { const [h, sat] = hue(x); return h >= 250 && h <= 320 && sat > 0.25; }).map(x => `${f} #${x}`));
    expect(purple).toEqual([]);
    const CSS = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    expect(/#inspector \.st::before\{[^}]*\}/.exec(CSS)![0]).toContain('background:var(--fg-3)');
    const ACC = readFileSync(new URL('../src/deck/AccountPanel.css', import.meta.url), 'utf8');
    expect(/\.atag\.orch\{[^}]*\}/.exec(ACC)![0]).toContain('color:var(--accent)');
  });
  test('§4.11b broken lane: "Chạy lại" instead of Ngắt lượt / Dừng', () => {
    const t = text(html(<Inspector {...props({ k: 'lane', name: 'B2' })} />));
    expect(t).toContain('Chạy lại');
    expect(t).not.toContain('Ngắt lượt');
  });
  test('§4.11b N2-l "+n": the Subagent section comes first (before Worktree)', () => {
    const t = text(html(<Inspector {...props({ k: 'lane', name: 'D2', subsFirst: true })} />));
    expect(t.indexOf('Subagent · 2')).toBeGreaterThan(-1);
    expect(t.indexOf('Subagent · 2')).toBeLessThan(t.indexOf('Worktree'));
    const t2 = text(html(<Inspector {...props({ k: 'lane', name: 'D2' })} />));
    expect(t2.indexOf('Subagent · 2')).toBeGreaterThan(t2.indexOf('Worktree'));
  });
  test('§4.11b Subagent: crumb "Điều phối › D2 › tests", read-only note, sub conversation, composer → parent lane', () => {
    const h = html(<Inspector {...props({ k: 'sub', lane: 'D2', taskId: 't1' })} />), t = text(h);
    expect(crumbOf(h)).toBe('Điều phối › D2 › tests');
    expect(t).toContain('Chỉ xem');
    expect(t).toContain('Viết test cho 3 endpoint');
    expect(t).not.toContain('Đã giao D2 port parser'); // the lane / orch conversation is not shown
    expect(targetBtn(h)).toBe('D2'); // v2.4 §6.2 D51: "↳" is drawn by CSS
    expect(ph(h)).toBe('Nhắn lane cha D2…');
  });
  test('§4.11b Subagent meta ends with its time: running → since start, done → start to end, unknown start → none', () => {
    const meta = (sv: SubagentView) => text(html(<Inspector {...props({ k: 'sub', lane: 'D2', taskId: 't1' }, { subs: { D2: [sv] } })} />))
      .match(/chạy unit lot-2[^<]*?(?=Viết test|$)/)?.[0] ?? '';
    expect(meta(sub('t1', { startedAt: NOW - 3 * 60_000 }))).toContain('42k tok · 3 p');
    expect(meta(sub('t1', { status: 'completed', startedAt: NOW - 600_000, endedAt: NOW - 600_000 + 125_000 }))).toContain('42k tok · 2 p');
    expect(meta(sub('t1'))).not.toMatch(/tok · \d+ p/);
  });
  test('§4.11b Account crumb: "Account" is a label, not a dead button; lane crumbs stay buttons', () => {
    const acc = html(<Inspector {...props({ k: 'account', email: 'acc11@x-io.test' })} />);
    expect(crumbOf(acc)).toBe('Account › acc11@');
    expect(acc).not.toMatch(/<nav class="crumb"[^>]*>.*<button[^>]*class="cr"/);
    expect(html(<Inspector {...props({ k: 'lane', name: 'D2' })} />)).toMatch(/<nav class="crumb"[^>]*><span class="cr-w"><button[^>]*class="cr"/);
  });
  test('§4.11b Account: crumb "Account › acc11@", v1 F24 + v2 buttons, composer → Điều phối', () => {
    const h = html(<Inspector {...props({ k: 'account', email: 'acc11@x-io.test' })} />), t = text(h);
    expect(crumbOf(h)).toBe('Account › acc11@');
    for (const s of ['Tuần', '5 giờ', 'Không giao lane mới', 'Chuyển hết lane đi', 'Sửa ngưỡng', 'Đang chạy trên account này']) expect(t).toContain(s);
    expect(targetBtn(h)).toBe('Điều phối');
  });
  test('§4.11b m-1 N3-l Account order: identity line → action row → Tuần / 5 giờ rows → "Đang chạy trên account này"', () => {
    const t = text(html(<Inspector {...props({ k: 'account', email: 'acc11@x-io.test' })} />));
    const at = (s: string) => t.indexOf(s);
    expect(at('acc11@x-io.test')).toBeGreaterThan(-1);
    expect(at('Không giao lane mới')).toBeGreaterThan(at('acc11@x-io.test'));
    expect(at('Sửa ngưỡng')).toBeLessThan(at('Tuần'));
    expect(at('Tuần')).toBeLessThan(at('Đang chạy trên account này'));
  });
  test('§4.11b Account (m6): "Hôm nay" row + "Đã chạy hôm nay" lists only lanes finished since local midnight', () => {
    const p = props({ k: 'account', email: 'acc11@x-io.test' });
    const mid = new Date(NOW); mid.setHours(0, 0, 0, 0);
    p.snap.lanes = [...p.snap.lanes, lane('T1', { account: 'acc11@x-io.test', state: 'done', updatedAt: mid.getTime() + 60_000 }),
      lane('Y1', { account: 'acc11@x-io.test', state: 'done', updatedAt: mid.getTime() - 60_000 })];
    const t = text(html(<Inspector {...p} />));
    expect(t).toContain('Hôm nay');
    expect(t).toMatch(/Đã chạy hôm nay T1 /);
    expect(t).not.toContain('Y1');
  });
  test('§9.3 R8 Account: only "Hôm nay" + "Đã chạy hôm nay" — no "Tuần theo loại" / by-kind row (vi + en)', () => {
    const p = props({ k: 'account', email: 'acc11@x-io.test' });
    const vi = text(html(<Inspector {...p} />)), en = text(html(<Inspector {...p} />, 'en'));
    expect(vi).toContain('Hôm nay');
    expect(vi).not.toMatch(/theo loại/i);
    expect(en).not.toMatch(/by kind|per kind/i);
    expect([...html(<Inspector {...p} />).matchAll(/<dt>([^<]*)<\/dt>/g)].map(m => m[1])).toEqual(['Tuần', '5 giờ', 'Hôm nay', 'Số liệu']);
  });
  test('v2.7.1 D103 / L8 Account: Max shows the 5-hour row with "HH:MM dd/mm"; Ultra shows nothing about the 5-hour window', () => {
    const wk = NOW + 21 * 3_600_000, five = NOW + 5 * 3_600_000, d = (t: number) => { const x = new Date(t); return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')} ${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}`; };
    const on = (over: Parameters<typeof account>[1]) => { const p = props({ k: 'account', email: 'acc11@x-io.test' }); p.snap.accounts[1] = account('acc11@x-io.test', over); return html(<Inspector {...p} />); };
    const max = on({ five: 95, fivePct: 8, fiveResetsAt: five, weekPct: 40, weekResetsAt: wk });
    expect([...max.matchAll(/<dt>([^<]*)<\/dt>/g)].map(m => m[1])).toEqual(['Tuần', '5 giờ', 'Hôm nay', 'Số liệu']);
    expect(text(max)).toContain(`reset ${d(five)}`);
    expect(text(max)).toContain(`reset ${d(wk)}`);
    expect(text(max)).toContain('5h 95 %');
    expect(text(on({ full: true, headroomPct: 0, weekPct: 99, weekResetsAt: wk }))).toContain(`ĐẦY — mở lại khi reset ${d(wk)}.`);
    for (const ultra of [on({ fiveWindow: false, five: 95, fivePct: null, fiveResetsAt: null, weekPct: 40, weekResetsAt: wk }),
      on({ fiveWindow: false, five: null, fivePct: null, fiveResetsAt: null, weekPct: null, weekResetsAt: null })]) {
      expect([...ultra.matchAll(/<dt>([^<]*)<\/dt>/g)].map(m => m[1])).toEqual(['Tuần', 'Hôm nay', 'Số liệu']);
      expect(text(ultra)).not.toMatch(/5 giờ|5h/);
      expect(text(ultra).match(/reset chưa rõ/g)?.length ?? 0).toBeLessThanOrEqual(1); // the weekly row only, never a 5-hour one
    }
    expect(text(on({ fiveWindow: false, five: null, fivePct: null, fiveResetsAt: null, weekPct: null, weekResetsAt: null }))).toContain('reset chưa rõ'); // the weekly row only
    expect(text(on({ fiveWindow: false, fivePct: null, fiveResetsAt: null, weekPct: 40, weekResetsAt: wk }))).not.toContain('reset chưa rõ');
  });
  test('review-b IMPORTANT-2 session header: a Max account ends the stat line with "5h n %"; an Ultra one has no 5-hour text', () => {
    const head = (over: Parameters<typeof account>[1]) => { const p = props(ORCH); p.snap.accounts[0] = account('a@x', { role: 'orchestrator', ...over }); return text(html(<Inspector {...p} />)); };
    expect(head({ fivePct: 31 })).toContain('5h 31 %');
    for (const ultra of [head({ fiveWindow: false, five: null, fivePct: null, fiveResetsAt: null, weekPct: 40 }), head({ fiveWindow: false, five: 95, fivePct: null, fiveResetsAt: null, weekPct: 40 })]) {
      expect(ultra).not.toMatch(/5h|5 giờ/);
      expect(ultra).toContain('ctx ');
    }
  });
  test('R22 M7 orchestrator running: the composer reads "Nhắn Điều phối…" as in the v2.3 mockup, no @lane hint', () => {
    const p = props(ORCH);
    p.snap.orchestrators[0]!.state = 'running';
    expect(ph(html(<Inspector {...p} />))).toBe('Nhắn Điều phối…');
    expect(ph(html(<Inspector {...p} />, 'en'))).toBe('Message the orchestrator…');
  });
  test('§4.4 orchestrator stopped: restart in Đang xem, composer still types (outbox placeholder)', () => {
    const p = props(ORCH);
    p.snap.orchestrators[0]!.state = 'stopped';
    const h = html(<Inspector {...p} />);
    expect(text(h)).toContain('Khởi động lại');
    expect(ph(h)).toBe('Vào hộp thư đi, gửi khi chạy lại…'); // m3 the mockup's short line (the head already says "đang dừng")
    expect(h).not.toMatch(/<textarea[^>]*disabled/);
  });
  test('§4.10 N4-c starting: composer locked "Chờ Điều phối khởi động…", body skeleton', () => {
    const p = props(ORCH);
    p.snap.orchestrators[0]!.state = 'starting';
    const h = html(<Inspector {...p} />);
    expect(ph(h)).toBe('Chờ Điều phối khởi động…');
    expect(h).toMatch(/<textarea[^>]*disabled/);
    expect(h).toContain('class="skel');
    expect(text(h)).not.toContain('Đã giao D2 port parser lot-2'); // UX-M6 never the old transcript under the skeleton
  });
  test('§4.14 m-5 N5-h resumed #2 starting: "Đang khởi động…", the resume divider + the engine\'s first line, then the skeleton; no old rows', () => {
    const p = props(ORCH);
    p.snap.orchestrators[0]!.state = 'starting';
    const at = NOW - 60_000;
    p.stream = { lines: [...lines(['D7 xong phần parser; còn merge.']),
      { seq: 5, ts: at, kind: 'engine', text: 'vi', boundary: { type: 'resume', seq: 2, at, account: 'acc33@x-io.test', mode: 'parallel', replaced: null } },
      { seq: 6, ts: at, kind: 'engine', text: '[cc-slaves] Phiên này được nối lại sau 2 ngày. Từ lúc dừng: D7 xong.' }], atTail: true, hasOlder: false, newer: false };
    const h = html(<Inspector {...p} />), t = text(h);
    expect(t).toContain('Đang khởi động…');
    expect(t).toMatch(/Chạy tiếp \d\d[/-]\d\d \d\d:\d\d · acc33@ · song song/);
    expect(t).toContain('[cc-slaves] Phiên này được nối lại sau 2 ngày');
    expect(t).not.toContain('D7 xong phần parser');
    expect(h.indexOf('class="skel')).toBeGreaterThan(h.indexOf('[cc-slaves] Phiên này'));
    expect(ph(h)).toBe('Chờ Điều phối khởi động…');
  });
  test('§4.10 N3-h no account: "Chờ account" and the composer still types', () => {
    const p = props(ORCH, { snap: { ...props(ORCH).snap, accounts: [] } });
    p.snap.orchestrators[0]!.account = null;
    p.snap.orchestrators[0]!.state = 'waiting_quota';
    const h = html(<Inspector {...p} />);
    expect(text(h)).toContain('Chờ account');
    expect(h).not.toMatch(/<textarea[^>]*disabled/);
  });
  test('§4.10 N4-e orchestrator Chờ quota: Đang xem names the account that resets first', () => {
    const p = props(ORCH);
    const at = p.now + 2 * 3_600_000;
    p.snap.accounts = p.snap.accounts.map((a, i) => ({ ...a, full: true, headroomPct: 0, weekResetsAt: at + i * 3_600_000 }));
    p.snap.orchestrators[0]!.state = 'waiting_quota';
    const d = new Date(at), hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
    expect(text(html(<Inspector {...p} />))).toContain(`Chờ quota · ${p.snap.accounts[0]!.email.split('@')[0]}@ reset ${hm}`); // v2.7.1 L8
  });
  test('§4.11b offline: read only — composer locked "Mất kết nối · chưa gửi được", action buttons disabled', () => {
    for (const sel of [ORCH, { k: 'lane', name: 'D2' } as Selection, { k: 'account', email: 'acc11@x-io.test' } as Selection]) {
      const h = html(<Inspector {...props(sel, { offline: true })} />);
      expect(ph(h)).toBe('Mất kết nối · chưa gửi được');
      expect(h).toMatch(/<textarea[^>]*disabled/);
      const acts = h.match(/<button[^>]*class="btn sm[^"]*"[^>]*>/g) ?? [];
      expect(acts.length).toBeGreaterThan(0);
      for (const b of acts) expect(b).toContain('disabled');
    }
  });
  test('§4.11b remote channel: buttons the engine would refuse are hidden (canRun)', () => {
    const p = props({ k: 'account', email: 'acc11@x-io.test' });
    p.snap.channel = 'remote';
    const t = text(html(<Inspector {...p} />));
    expect(t).not.toContain('Không giao lane mới');
    expect(t).not.toContain('Sửa ngưỡng');
  });
  test('§4.11b en: crumbs and composer in English', () => {
    const h = html(<Inspector {...props({ k: 'sub', lane: 'D2', taskId: 't1' })} />, 'en');
    expect(crumbOf(h)).toBe('Orchestrator › D2 › tests');
    expect(text(h)).toContain('View only');
  });
});

// ---------------------------------------------------------------- Chờ PO
const timers = () => {
  let now = 0; const q: { at: number; f: () => void; id: number }[] = []; let n = 0;
  const t: Timers = { now: () => now, setTimeout: (f, ms) => { q.push({ at: now + ms, f, id: ++n }); return n; }, clearTimeout: id => { const i = q.findIndex(x => x.id === id); if (i >= 0) q.splice(i, 1); } };
  return { t, advance(ms: number) { now += ms; for (const x of q.filter(x => x.at <= now)) { q.splice(q.indexOf(x), 1); x.f(); } } };
};
const inboxHtml = (cards: CardView[], over: Record<string, unknown> = {}) => html(<Inbox cards={cards} focusId={null} channel="mac" offline={false} undo={new UndoQueue(() => {})}
  guard={new ClickGuard()} newIds={new Set()} onOpen={() => {}} onAction={() => {}} folded={false} resolvedOpen={false} onToggle={() => {}} onResolved={() => {}} {...over} />);

describe('§4.11b Chờ PO block', () => {
  test('§4.11b N1-j 0 cards → one line "Chờ PO 0 · ✓ Không có việc chờ PO" + "Đã xử lý n ▸"', () => {
    const h = inboxHtml([card(1, { status: 'answered', resolvedAt: 5 }), card(2, { status: 'answered', resolvedAt: 6 })]);
    expect(h).toMatch(/<aside id="inbox" class="glass line"/);
    expect(text(h)).toContain('Chờ PO 0');
    expect(text(h)).toContain('Không có việc chờ PO');
    expect(text(h)).toContain('Đã xử lý 2 ▸');
    expect(h).not.toContain('<article class="card');
  });
  test('§4.11b cards → full block, collapse button "˄" titled "Thu gọn (Q)", no "×"', () => {
    const h = inboxHtml([card(1)]);
    expect(h).toMatch(/<aside id="inbox" class="glass"/);
    expect(h).toContain('title="Thu gọn (Q)"');
    expect(h).toContain('˄');
    expect(h).not.toContain('class="x"');
  });
  test('§4.11b N1-k last card answered → full for the whole 5 s undo, one line only once it is sent', () => {
    const k = timers();
    let c = card(1);
    const undo = new UndoQueue(a => { c = { ...c, status: 'answered', resolvedAt: k.t.now() }; void a; }, k.t);
    undo.choose(1, 'Tách', { kind: 'option', label: 'Tách' } as never);
    const mode = () => inboxMode({ cards: [c], folded: false, resolvedOpen: false });
    expect(mode()).toBe('full');
    k.advance(4_900);
    expect(mode()).toBe('full');
    k.advance(200);
    expect(mode()).toBe('line');
  });
  test('§4.11 Q folds / unfolds to one line at any time; with 0 pending Q opens the answered cards', () => {
    const one = [card(1)];
    let s = { folded: false, resolvedOpen: false };
    expect(inboxMode({ cards: one, ...s })).toBe('full');
    s = inboxToggle(s, one);
    expect(inboxMode({ cards: one, ...s })).toBe('line');
    s = inboxToggle(s, one);
    expect(inboxMode({ cards: one, ...s })).toBe('full');
    const done = [card(2, { status: 'answered', resolvedAt: 1 })];
    let z = { folded: false, resolvedOpen: false };
    expect(inboxMode({ cards: done, ...z })).toBe('line');
    z = inboxToggle(z, done);
    expect(inboxMode({ cards: done, ...z })).toBe('full');
    z = inboxToggle(z, done);
    expect(inboxMode({ cards: done, ...z })).toBe('line');
    expect(keyAction({ key: 'q', code: 'KeyQ', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }, false)).toEqual({ t: 'toggleInbox' });
  });
  test('§4.11b folded with pending cards still shows the count', () => {
    const h = inboxHtml([card(1), card(2)], { folded: true });
    expect(h).toMatch(/class="glass line"/);
    expect(text(h)).toContain('Chờ PO 2');
  });
});

// ---------------------------------------------------------------- narrow drawer + deck rect
describe('§4.10 window < 1280 px: one 424 px drawer', () => {
  const K = (key: string, meta = false) => ({ key, code: `Key${key.toUpperCase()}`, metaKey: meta, ctrlKey: false, altKey: false, shiftKey: false });
  test('§4.10 drawer opens on node click, new card, ⌘L and the "Chờ PO n" button; the button closes it when open', () => {
    expect(drawerNext(false, 'node', true)).toBe(true);
    expect(drawerNext(false, 'card', true)).toBe(true);
    expect(drawerNext(false, 'focus', true)).toBe(true);
    expect(drawerNext(false, 'button', true)).toBe(true);
    expect(drawerNext(true, 'button', true)).toBe(false);
    expect(drawerNext(true, 'esc', true)).toBe(false);
    expect(drawerNext(false, 'node', false)).toBe(false); // wide window: no drawer
    expect(keyAction(K('l', true), false)).toEqual({ t: 'focusConsole' });
    expect(keyAction(K('l', true), true)).toEqual({ t: 'focusConsole' });
  });
  test('§4.10 Esc closes the drawer after going up (orchestrator selected → drawer step)', () => {
    expect(escapeStep({ palette: false, stopLane: false, moveAll: false, addOpen: false, settings: false, wizard: false, up: selUp(ORCH) !== null, drawer: true })).toBe('drawer');
  });
  test('§4.10 drawer CSS: 424 px column over the deck, closed unless body.drawer', () => {
    const CSS = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    expect(CSS).toMatch(/body\.narrow #left\{[^}]*transform:translateX\(-100%\)/);
    expect(CSS).toMatch(/body\.narrow\.drawer #left\{[^}]*transform:none/);
  });
});

describe('§4 / §6 deck area never resizes when selecting or opening anything', () => {
  // Measured from the layout vars, not the DOM: --deck-left is a function of the window width only (signature has no
  // selection), the left column is position:fixed (out of flow), and .dframe reads only --bn / --deck-left.
  test('§4 --deck-left = 424 px at ≥ 1280 (400 px column + 2 × 12 px), 0 below', () => {
    expect(layoutVars(1440)).toEqual({ '--deck-left': '424px' });
    expect(layoutVars(1280)).toEqual({ '--deck-left': '424px' });
    expect(layoutVars(1279)).toEqual({ '--deck-left': '0px' });
    expect(layoutVars.length).toBe(1);
  });
  test('§4 deck rect is the same for every selection kind (left column fixed, 400 px, x 12 under the top bar + head bar, R24 / §6.7 D53)', () => {
    const CSS = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    expect(CSS).toContain('#left{position:fixed;left:12px;top:calc(var(--bn) + var(--h-bar) + var(--h-head) + var(--s4));bottom:var(--s4);width:400px');
    expect(CSS).not.toMatch(/has-panel|no-console/);
    const FLOW = readFileSync(new URL('../src/deck/flow/flow.css', import.meta.url), 'utf8');
    expect(FLOW).toContain('.deck .dframe{position:absolute;top:calc(var(--bn,0px) + var(--h-bar));left:var(--deck-left,0px);right:0;bottom:0}');
    const SHELL = readFileSync(new URL('../src/ui/shell.ts', import.meta.url), 'utf8');
    expect(SHELL).not.toMatch(/panel:|has-panel|no-console/);
  });
});

describe('T7 notes: N4-c no account card while starting; skeleton → "?" after 5 s without a live tick', () => {
  test('§4.10 N4-c the collapsed account card is hidden while the orchestrator is starting', () => {
    expect(accCardShown('starting')).toBe(false);
    expect(accCardShown('running')).toBe(true);
    expect(accCardShown(null)).toBe(true);
  });
  test('v2 "Đang tải": a row with no data is loading for 5 s after first seen, then "?" (uses the wall clock, not the deck tick)', () => {
    const seen = new Map<string, number>();
    const accs = [account('n@x', { fetchedAt: null })];
    expect([...loadingRows(accs, seen, 1000)]).toEqual(['n@x']);
    expect([...loadingRows(accs, seen, 5999)]).toEqual(['n@x']);
    expect([...loadingRows(accs, seen, 6000)]).toEqual([]);
  });
});

describe('§4.14 Lịch sử phiên: an ended session in Đang xem', () => {
  const ended = { sessionId: 's2', projectId: 'p1', seq: 2, title: 'lot-2', state: 'ended' as const, startedAt: NOW - 3_600_000, endedAt: NOW - 60_000,
    accountFirst: 'pm@x', accountLast: 'acc07@x', lanes: 2, tokens: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 }, costUsd: 19.8,
    endReason: 'replaced' as const, handoffPath: '/h.md', ctxLast: 142_000, resumable: true };
  const list = { running: [], ended: [ended], max: 3 };
  const sess: Selection = { k: 'session', sessionId: 's2' };
  test('§4.14 N5-e read-only view: breadcrumb "Lịch sử phiên › #2 · lot-2", Chạy tiếp… / Mở handoff, no composer', () => {
    const h = html(<Inspector {...props(sess, { sessionsList: list })} />);
    expect(text(h)).toContain('Lịch sử phiên');
    expect(text(h)).toContain('#2 · lot-2');
    expect(text(h)).toContain('Chạy tiếp…');
    expect(text(h)).toContain('Mở handoff');
    expect(text(h)).toContain('thay bằng phiên mới');
    expect(h).not.toContain('<textarea');
  });
  test('§4.14 remote: the ended view hides Chạy tiếp… (spawn), the list stays readable', () => {
    const p = props(sess, { sessionsList: list });
    const h = text(html(<Inspector {...{ ...p, snap: { ...p.snap, channel: 'remote' } }} />));
    expect(h).toContain('#2 · lot-2');
    expect(h).not.toContain('Chạy tiếp…');
  });
  test('§4.14 Esc from an ended session returns to Điều phối (the previously viewed running session is kept), list / dialog close first', () => {
    expect(selUp(sess)).toEqual(ORCH);
    expect(composerTarget(sess, 'p1', 's3')).toEqual({ kind: 'orchestrator', projectId: 'p1', sessionId: 's2' });
    expect(composerTarget(ORCH, 'p1', 's3')).toEqual({ kind: 'orchestrator', projectId: 'p1', sessionId: 's3' });
    const none: EscState = { accDlg: false, palette: false, stopLane: false, moveAll: false, addOpen: false, settings: false, wizard: false, menu: false, accPanel: false, up: false, drawer: false };
    expect(escapeStep({ ...none, sessList: true, up: true })).toBe('sessList');
    expect(escapeStep({ ...none, sessDlg: true, sessList: true })).toBe('sessDlg');
  });
  test('§4.14 key H opens Lịch sử phiên', () => {
    expect(keyAction({ key: 'h', code: 'KeyH', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }, false)).toEqual({ t: 'history' });
  });
  test('§4.14 > 1 session: the Inspector head is "Điều phối #n ▾"; a lane says "Phiên #3 · <tên>"', () => {
    const p = props(ORCH);
    const s3 = { ...p.snap.orchestrators[0]!, sessionId: 's3', seq: 3 }, s4 = { ...s3, sessionId: 's4', seq: 4, title: 'hotfix' };
    const snap = { ...p.snap, orchestrators: [s3, s4], lanes: [{ ...p.snap.lanes[0]!, ownerSession: 's4', ownerSeq: 4 }] };
    expect(text(html(<Inspector {...{ ...p, snap, sessions: [s3, s4], viewed: s4 }} />))).toContain('Điều phối #4');
    expect(text(html(<Inspector {...{ ...p, sel: { k: 'lane', name: 'D2' }, snap, sessions: [s3, s4], viewed: s3 }} />))).toContain('Phiên #4 · hotfix');
  });
  test('§4.14 N-d a titled session ("#4 · hotfix") puts its status on the meta line, not squeezed into the head row', () => {
    const p = props(ORCH);
    const s3 = { ...p.snap.orchestrators[0]!, sessionId: 's3', seq: 3 }, s4 = { ...s3, sessionId: 's4', seq: 4, title: 'hotfix' };
    const snap = { ...p.snap, orchestrators: [s3, s4] };
    const row = (h: string) => /<div class="row">([\s\S]*?)<\/div>/.exec(h)![1]!, meta = (h: string) => /<div class="meta mono"[^>]*>([\s\S]*?)<\/div>/.exec(h)![1]!;
    const titled = html(<Inspector {...{ ...p, snap, sessions: [s3, s4], viewed: s4 }} />);
    expect(row(titled)).not.toContain('class="st');
    expect(meta(titled)).toContain('class="st');
    const plain = html(<Inspector {...{ ...p, snap, sessions: [s3, s4], viewed: s3 }} />);
    expect(row(plain)).toContain('class="st');
  });
});

describe('v2.2 UX review fixes: Đang xem heads (F-I7, F-I8, F-M10)', () => {
  const ohRow = (h: string) => /<div class="ohead"><div class="row">([\s\S]*?)<\/div>/.exec(h)![1]!;
  test('F-I7 S1 the Điều phối head row keeps title + status + Ngắt lượt; R43 I1 "Ẩn công cụ" at the chip row\'s end, not on the meta line', () => {
    const h = html(<Inspector {...props(ORCH)} />);
    expect(ohRow(h)).toContain('class="st ok"');
    expect(ohRow(h)).toContain('Ngắt lượt');
    expect(ohRow(h)).not.toContain('hidetools');
    expect(/<div class="crow">([\s\S]*?)<\/div>/.exec(h)![1]).toContain('class="hidetools"');
    expect(/<div class="meta mono"[^>]*>([\s\S]*?)<\/div>/.exec(h)![1]).not.toContain('hidetools');
  });
  test('R43 I3 a short column shows one subagent row (failed / running first) + "+n subagent"; open or wide = the list', () => {
    const s = [sub('a', { status: 'completed' }), sub('b', { status: 'running' }), sub('c', { status: 'failed' })];
    expect(shortSubs(s, true, false)).toEqual({ shown: [s[2]!], more: 2 });
    expect(shortSubs(s, true, true)).toEqual({ shown: s, more: 0 });
    expect(shortSubs(s, false, false)).toEqual({ shown: s, more: 0 });
    expect(shortSubs(s.slice(0, 1), true, false)).toEqual({ shown: s.slice(0, 1), more: 0 });
    expect(SHORT_Q).toBe('(max-height: 715px)'); // #left = window − 44 − 28 − 2 × 12 < 620 px (the 1024 drawer counts as short too)
  });
  test('F-I7 CSS: the Điều phối title box never shrinks below its name', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    expect(css).toMatch(/#inspector \.oname\{[^}]*flex:none/);
  });
  test('F-I8 the lane facts fold in a narrow window or while the lane runs; wide + idle shows them open', () => {
    expect(factsFolded(true, 'stopped')).toBe(true);
    expect(factsFolded(false, 'running')).toBe(true);
    expect(factsFolded(false, 'switching')).toBe(true);
    expect(factsFolded(false, 'stopped')).toBe(false);
    expect(factsFolded(false, 'broken')).toBe(false);
  });
  test('F-I8 S4-narrow folded facts = one summary button (Worktree · Lỗi liên tiếp · Hoạt động), nothing removed, the list hidden', () => {
    const h = html(<Inspector {...props({ k: 'lane', name: 'D2' })} />);
    const sum = /<button type="button" class="kvsum" aria-expanded="false"[^>]*>([\s\S]*?)<\/button>/.exec(h);
    expect(sum).not.toBeNull();
    for (const w of ['Worktree /w/D2', 'Lỗi liên tiếp 0 / 3', 'lượt cuối']) expect(text(sum![1]!)).toContain(w);
    expect(text(sum![1]!)).toMatch(/^\s*Lỗi liên tiếp 0 \/ 3 · [^·]*lượt cuối[^·]* · Worktree \/w\/D2/); // R-M2 short facts first, the long path last
    expect(h).not.toContain('<dl class="kv"');
    const idle = props({ k: 'lane', name: 'D2' });
    idle.snap.lanes[0]!.state = 'stopped';
    const open = html(<Inspector {...idle} />);
    expect(open).toContain('<dl class="kv"');
    expect(open).not.toContain('class="kvsum"');
    expect(html(<Inspector {...idle} narrow />)).toContain('class="kvsum"');
  });
  test('F-M10 S8 the sub badge is sentence case like every other state badge ("Đang chạy", "Xong", "Lỗi")', () => {
    const h = html(<Inspector {...props({ k: 'sub', lane: 'D2', taskId: 't1' })} />);
    expect(h).toMatch(/<span class="pill ok">Đang chạy<\/span>/);
    const done = props({ k: 'sub', lane: 'D2', taskId: 't1' }, { subs: { D2: [sub('t1', { status: 'failed' })] } });
    expect(html(<Inspector {...done} />)).toMatch(/<span class="pill bad">Lỗi<\/span>/);
  });
});

describe('hot fix 2026-11-16 held project: the band in the Điều phối box', () => {
  const held = (kind: 'start' | 'resume') => {
    const p = props(ORCH);
    const project = { ...p.project, held: { kind, sessions: 2, lanes: 3 } };
    return { ...p, project, snap: { ...p.snap, projects: [project] } };
  };
  test('hf1116 W3 resume: why it waits (sessions + lanes, no token) + "Tiếp tục"; placeholder "Gửi để tiếp tục…"', () => {
    const h = html(<Inspector {...held('resume')} />);
    expect(h).toContain('class="m-sys info held"');
    expect(text(h)).toContain('Đang tạm dừng từ lần mở app trước · 2 phiên Điều phối, 3 lane đang chờ. Không tốn token cho tới khi bạn tiếp tục.');
    expect(h).toMatch(/<button type="button" class="btn sm pri"[^>]*>Tiếp tục<\/button>/);
    expect(ph(h)).toBe('Gửi để tiếp tục…');
    expect(h.indexOf('m-sys info held')).toBeLessThan(h.indexOf('class="inrow')); // above the composer, which stays usable
    expect(h).not.toMatch(/<textarea[^>]*disabled/);
  });
  test('hf1116 W3 start: "Điều phối chưa chạy…" + "Bắt đầu"; placeholder "Gửi để bắt đầu…"; en text', () => {
    const h = html(<Inspector {...held('start')} />);
    expect(text(h)).toContain('Điều phối chưa chạy. Gửi tin nhắn đầu tiên hoặc bấm Bắt đầu.');
    expect(h).toMatch(/>Bắt đầu<\/button>/);
    expect(ph(h)).toBe('Gửi để bắt đầu…');
    expect(text(html(<Inspector {...held('resume')} />, 'en'))).toContain('2 orchestrator sessions, 3 lanes waiting');
  });
  test('hf1116 W3 no band when the project is not held, nor on a lane selection; offline dims the button', () => {
    expect(html(<Inspector {...props(ORCH)} />)).not.toContain('m-sys info held');
    expect(html(<Inspector {...{ ...held('resume'), sel: { k: 'lane', name: 'D2' } }} />)).not.toContain('m-sys info held');
    expect(html(<Inspector {...{ ...held('resume'), offline: true }} />)).toMatch(/<button type="button" class="btn sm pri" disabled="">Tiếp tục/);
  });
  test('hf1116 W3 a paused Điều phối reads "Điều phối tạm dừng" in the head, muted (no red, no "Ngắt lượt")', () => {
    const p = props(ORCH), o = { ...p.snap.orchestrators[0]!, state: 'paused' as const };
    const h = html(<Inspector {...p} sessions={[o]} viewed={o} />);
    expect(h).toMatch(/<span class="st mute" title="Điều phối tạm dừng">/);
    expect(h).not.toContain('class="down"');
  });
});
