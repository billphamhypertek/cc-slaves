// v2.1 deck nodes, wires, state objects, motion gate (spec §4.2–§4.6, §4.10, §4.12, §5.2). Pure model + static markup
// of the presentational cards (no React Flow store, no DOM). Motion gate: asserted on the markup — no animated class and
// no travelling dot when paused (the CSS loops only exist on those classes), plus the `.deck.paused` belt in flow.css.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { makeT } from '../../../shared/i18n/index.ts';
import type { LaneState, Snapshot, SubagentView } from '../../../shared/protocol.ts';
import { earliestReset, laneCard, laneLine2, CARD_CHARS } from '../../src/deck/cards.ts';
import { buildFlow, C, nextSubExpiry, phaseFits, SUB_KEEP_MS, visibleSubs, wireStyle, type FlowInput, type LaneData, type OrchData, type SubData } from '../../src/deck/flow/model.ts';
import { Glyph } from '../../src/deck/flow/Glyph.tsx';
import { DeckCtx, LaneCard, OrchCard, SepLine, SubCard, type DeckCtxValue } from '../../src/deck/flow/nodes.tsx';
import { edgeTypes, WireDots } from '../../src/deck/flow/WireEdge.tsx';
import { SparkRing } from '../../src/deck/flow/spark.ts';
import { MoveGuard, MOVE_GUARD_MS } from '../../src/deck/flow/guard.ts';
import { deckClass } from '../../src/deck/motion.ts';
import { account, card, lane, snapshot } from '../fixtures.ts';
import { rootIntent } from '../../src/deck/actions.ts';
import { composerTarget, ORCH } from '../../src/lib/inspector.ts';
import { sessionsOf, viewedSession } from '../../src/lib/sessions.ts';
import { targetKey } from '../../src/lib/store.ts';

const VI = makeT('vi'), EN = makeT('en');
const NOW = new Date(2026, 10, 16, 14, 0).getTime();
const sub = (taskId: string, over: Partial<SubagentView> = {}): SubagentView => ({
  taskId, toolUseId: `tu-${taskId}`, description: `desc ${taskId}`, subagentType: taskId, background: false, status: 'running',
  totalTokens: 42_000, toolUses: 3, lastTool: 'Read', endedAt: null, ...over,
});
const inp = (snap: Snapshot, over: Partial<FlowInput> = {}): FlowInput => ({ snap, projectId: 'p1', subagents: {}, selected: null, now: NOW, tr: VI, live: true, ...over });
const laneOf = (m: ReturnType<typeof buildFlow>, name: string) => m.nodes.find(n => n.id === `lane:${name}`)!.data as LaneData;
const orchOf = (m: ReturnType<typeof buildFlow>) => m.nodes.find(n => n.type === 'orchestrator')!.data as OrchData;
const edgeTo = (m: ReturnType<typeof buildFlow>, id: string) => m.edges.find(e => e.target === id)!.data;
const ANIM = /\b(a-spin|a-orb|a-wave|a-blink|a-swf)\b|class="pk/;
const ctx = (over: Partial<DeckCtxValue> = {}): DeckCtxValue => ({ tr: VI, live: true, act: () => {}, menu: () => {}, toggleSubs: () => {}, toggleDone: () => {}, tip: () => {}, ...over });
const render = (el: ReactElement, c: Partial<DeckCtxValue> = {}) => renderToStaticMarkup(<DeckCtx.Provider value={ctx(c)}>{el}</DeckCtx.Provider>);

describe('§4.2 line 2 priority (port of laneCard, v1.1 M3)', () => {
  test('§4.2 ask card → "Chờ PO:" + question cut at 28 chars, "Trả lời"', () => {
    const q = 'Tách module parser ra thành hai gói riêng hay gộp?';
    const f = laneCard(lane('D2', { state: 'waiting_po' }), [card(1, { question: q })], VI)!;
    expect(f.kind).toBe('ask');
    expect(f.text).toBe([...q].slice(0, CARD_CHARS).join('') + '…');
    expect([...f.text].length).toBe(29);
    expect(f.cardId).toBe(1);
  });
  test('§4.2 newest card wins, "+n" for > 1 open card', () => {
    const f = laneCard(lane('D2'), [card(1, { createdAt: 100 }), card(2, { createdAt: 300, question: 'mới nhất?' }), card(3, { createdAt: 200 })], VI)!;
    expect(f.cardId).toBe(2);
    expect(f.text).toBe('mới nhất?');
    expect(f.more).toBe(2);
    expect(laneCard(lane('D2'), [card(1)], VI)!.more).toBe(0);
  });
  test('§4.2 permission → "Xin chạy:" + tool + main input, never "Đề xuất"', () => {
    const f = laneCard(lane('D2'), [card(4, { kind: 'permission', titleKey: 'cards.permission', params: { source: 'D2', tool: 'Bash', main: 'rm -rf build/' }, question: undefined })], VI)!;
    expect(f.kind).toBe('perm');
    expect(f.text).toBe('Bash rm -rf build/');
    expect(f.text).not.toContain('Đề xuất');
  });
  test('§4.2 broken → "Hỏng" + last error line, button "Xem"; broken state without card → cardId null', () => {
    const l = lane('R5', { state: 'broken', lastError: 'npm run test:unit\nexit 1 lúc 14:02' });
    const f = laneCard(l, [], VI)!;
    expect(f).toMatchObject({ kind: 'broken', tone: 'bad', text: 'exit 1 lúc 14:02', cardId: null });
    const html = render(<LaneCard id="lane:R5" d={laneOf(buildFlow(inp(snapshot({ lanes: [l] }))), 'R5')} />);
    expect(html).toContain('>Hỏng<');
    expect(html).toContain('>Xem<');
  });
  test('§4.2 waiting_po without an open card → "Chờ PO" + "Xem" = select the lane (cardId null)', () => {
    const f = laneCard(lane('D2', { state: 'waiting_po' }), [], VI)!;
    expect(f).toMatchObject({ kind: 'waiting', cardId: null, text: '' });
    const html = render(<LaneCard id="lane:D2" d={laneOf(buildFlow(inp(snapshot({ lanes: [lane('D2', { state: 'waiting_po' })] }))), 'D2')} />);
    expect(html).toContain('>Chờ PO<');
    expect(html).toContain('>Xem<');
  });
  test('§4.2 card beats quota (N4-e): a waiting_quota lane with an open card keeps the card line', () => {
    const accs = [account('a@x', { full: true, headroomPct: 0, weekResetsAt: NOW + 3_600_000 })];
    expect(laneLine2(lane('D2', { state: 'waiting_quota' }), [card(1)], accs, VI).kind).toBe('card');
    const q = laneLine2(lane('D2', { state: 'waiting_quota' }), [], accs, VI);
    expect(q.kind).toBe('quota');
  });
  test('§4.2 Chờ quota shows the earliest reset as HH:MM dd/mm in every language (v2.7.1 L8: no weekday)', () => {
    const wed = new Date(2026, 10, 18, 8, 0).getTime(), later = wed + 86_400_000;
    const accs = [account('b@x', { full: true, headroomPct: 0, weekResetsAt: later }), account('a@x', { full: true, headroomPct: 0, weekResetsAt: wed })];
    expect(laneLine2(lane('C1', { state: 'waiting_quota' }), [], accs, VI)).toEqual({ kind: 'quota', at: '08:00 18/11' });
    expect(laneLine2(lane('C1', { state: 'waiting_quota' }), [], accs, EN)).toEqual({ kind: 'quota', at: '08:00 18/11' });
  });
  test('§4.2 N4-e Chờ quota: the node keeps only the time; the tooltip names the account that resets first', () => {
    const wed = new Date(2026, 10, 18, 8, 0).getTime();
    const accs = [account('b@x', { full: true, headroomPct: 0, weekResetsAt: wed + 86_400_000 }), account('acc07@x', { full: true, headroomPct: 0, weekResetsAt: wed })];
    expect(earliestReset(accs)).toEqual({ at: wed, email: 'acc07@x' });
    expect(earliestReset([account('a@x', { headroomPct: 50 })])).toBeNull();
    const d = laneOf(buildFlow(inp(snapshot({ accounts: accs, lanes: [lane('C1', { state: 'waiting_quota' })] }))), 'C1');
    expect(d.tip).toContain('reset sớm nhất: acc07@ · 08:00 18/11');
    expect(d.line2).toEqual({ kind: 'quota', at: '08:00 18/11' });
  });
  test('§4.2 note beats task; task when no note', () => {
    expect(laneLine2(lane('D2', { note: 'lot-2 xong', task: 'port parser' }), [], [], VI)).toEqual({ kind: 'text', text: 'lot-2 xong' });
    expect(laneLine2(lane('D2', { note: null, task: 'port parser' }), [], [], VI)).toEqual({ kind: 'text', text: 'port parser' });
  });
  test('§4.2 cards of another lane / project / closed do not count', () => {
    expect(laneCard(lane('D2'), [card(1, { source: 'D15' }), card(2, { projectId: 'p2' }), card(3, { status: 'answered' })], VI)).toBeNull();
  });
});

describe('§4.2 line 1 and line 3', () => {
  test('§4.2 / §5.3 tok shown = input + output + cacheWrite (cacheRead only in the tooltip)', () => {
    const s = snapshot({ lanes: [lane('D2', { tokens: { input: 38_000, output: 61_000, cacheWrite: 313_000, cacheRead: 2_400_000 }, costUsd: 3.18 })] });
    const d = laneOf(buildFlow(inp(s)), 'D2');
    expect(d.tok).toBe('412k tok');
    expect(d.cost).toBe('≈ $3,18');
    expect(d.tip.join('\n')).toContain('đọc cache 2,4M');
  });
  test('§4.2 missing tokens (pre-v2.1 engine) read as zero', () => {
    expect(laneOf(buildFlow(inp(snapshot({ lanes: [lane('D2')] }))), 'D2').tok).toBe('0 tok');
  });
  test('§4.2 the phase hides entirely when it does not fit (never cut to 1–2 letters)', () => {
    expect(phaseFits('D2', 'Code', '3 sub ▾', 'acc11@')).toBe(true);
    expect(phaseFits('D2', 'Đang review lần hai', '3 sub ▾', 'acc11@')).toBe(false);
  });
  test('§4.2 running lane → sparkline; waiting_quota → "đứng"; a done lane is a shelf row, never a lane node', () => {
    const s = snapshot({ lanes: [lane('D2'), lane('E4', { state: 'done', updatedAt: new Date(2026, 10, 16, 13, 40).getTime() }), lane('C1', { state: 'waiting_quota' })] });
    const m = buildFlow(inp(s, { spark: () => [1, 2, 3], doneOpen: true }));
    expect(laneOf(m, 'D2').tail).toEqual({ kind: 'spark', pts: [1, 2, 3] });
    expect(m.nodes.some(n => n.id === 'lane:E4')).toBe(false);
    expect((m.nodes.find(n => n.id === 'done')!.data as { merged: { name: string; when: string }[] }).merged.map(r => [r.name, r.when])).toEqual([['E4', '13:40']]);
    expect(laneOf(m, 'C1').tail).toEqual({ kind: 'text', text: 'đứng' });
  });
  test('§5.4 longest en node strings fit the 268 px card (short words "PO:", "Run?", "Quota ·")', () => {
    expect(EN('deck.node.ask')).toBe('PO:');
    expect(EN('deck.node.perm')).toBe('Run?');
    expect(EN('deck.node.quota')).toBe('Quota ·');
    // 268 − 46 cell − 20 padding − ~60 button − gaps: label + 29 chars of text at ≤ 6.4 px stays clipped by CSS ellipsis
    for (const k of ['deck.node.ask', 'deck.node.perm', 'deck.node.broken', 'deck.node.quota'] as const) expect(EN(k).length).toBeLessThanOrEqual(7);
  });
});

describe('§4.4 orchestrator node', () => {
  test('§4.4 N1-i the Điều phối tooltip row: account · model · ctx (model only when the engine knows it)', () => {
    const o = snapshot().orchestrators[0]!;
    expect(orchOf(buildFlow(inp(snapshot({ orchestrators: [{ ...o, model: 'claude-opus-5-5' }] })))).tip[1]).toBe('a@ · claude-opus-5-5 · ctx 41%');
    expect(orchOf(buildFlow(inp(snapshot()))).tip[1]).toBe('a@ · ctx 41%');
  });
  test('§4.4 "làm với" = running lanes, talkingTo first', () => {
    const s = snapshot({ lanes: [lane('D2'), lane('B2'), lane('C1', { state: 'idle' })], orchestrators: [{ ...snapshot().orchestrators[0]!, talkingTo: 'B2' }] });
    expect(orchOf(buildFlow(inp(s))).line2).toEqual({ kind: 'with', lanes: ['B2', 'D2'] });
  });
  test('v26-rv MINOR-7 a Điều phối mid-turn with no lane running says "Đang chạy", never "rảnh"; an idle one "rảnh"', () => {
    const o = snapshot().orchestrators[0]!, lanes = [lane('C1', { state: 'idle' })];
    const run = orchOf(buildFlow(inp(snapshot({ lanes, orchestrators: [{ ...o, state: 'running' }] }))));
    expect(run.line2).toEqual({ kind: 'with', lanes: [] });
    expect(render(<OrchCard id="orch:p1" d={run} />)).toContain('>Đang chạy<');
    expect(render(<OrchCard id="orch:p1" d={run} />)).not.toContain('rảnh');
    const idle = orchOf(buildFlow(inp(snapshot({ lanes, orchestrators: [{ ...o, state: 'idle' }] }))));
    expect(idle.line2).toEqual({ kind: 'idle' });
    expect(render(<OrchCard id="orch:p1" d={idle} />)).toContain('>rảnh<');
  });
  test('§4.4 orchestrator_down beats po_ask; remote → "chỉ trên Mac" (no restart button)', () => {
    const cards = [card(1, { kind: 'orchestrator_down', source: null }), card(2, { source: 'orchestrator' })];
    const mac = buildFlow(inp(snapshot({ cards })));
    expect(orchOf(mac).line2).toEqual({ kind: 'down', remote: false, cardId: 1 });
    expect(orchOf(mac).glyph).toBe('root_down');
    expect(render(<OrchCard id="orch:p1" d={orchOf(mac)} />)).toContain('>Khởi động lại<');
    const remote = buildFlow(inp(snapshot({ cards, channel: 'remote' })));
    const html = render(<OrchCard id="orch:p1" d={orchOf(remote)} />);
    expect(html).toContain('chỉ trên Mac');
    expect(html).not.toContain('>Khởi động lại<');
  });
  test('§4.4 own ask → "Chờ PO" + "Trả lời"; starting → "Đang khởi động…" and "—"', () => {
    expect(orchOf(buildFlow(inp(snapshot({ cards: [card(2, { source: 'orchestrator' })] })))).line2).toEqual({ kind: 'ask', cardId: 2 });
    const st = orchOf(buildFlow(inp(snapshot({ orchestrators: [{ ...snapshot().orchestrators[0]!, state: 'starting' }] }))));
    expect(st.line2.kind).toBe('starting');
    expect(st.tok).toBeNull();
    expect(render(<OrchCard id="orch:p1" d={st} />)).toContain('<span>—</span>');
  });
  test('§4.10 project without lanes → only the orchestrator + "Chưa có lane · nhắn Điều phối ở ô bên trái"', () => {
    const m = buildFlow(inp(snapshot({ lanes: [] })));
    expect(m.screen).toBe('no_lanes');
    expect(m.nodes.map(n => n.type)).toEqual(['orchestrator']);
    expect(render(<OrchCard id="orch:p1" d={orchOf(m)} />)).toContain('Chưa có lane · nhắn Điều phối ở ô bên trái');
  });
  test('§4.10 no project → no node', () => {
    expect(buildFlow(inp(snapshot({ projects: [] }), { projectId: null })).screen).toBe('no_project');
  });
});

describe('§4.5 subagent nodes', () => {
  test('§4.5 completed sub hidden after 60 s (fake clock via endedAt), failed kept', () => {
    const list = [sub('a', { status: 'completed', endedAt: NOW - 59_000 }), sub('b', { status: 'completed', endedAt: NOW - 60_000 }), sub('c', { status: 'failed', endedAt: NOW - 3_600_000 }), sub('d')];
    expect((visibleSubs(list, NOW) as SubagentView[]).map(s => s.taskId)).toEqual(['a', 'c', 'd']);
    expect((visibleSubs(list, NOW + 1_000) as SubagentView[]).map(s => s.taskId)).toEqual(['c', 'd']);
    const m = buildFlow(inp(snapshot({ lanes: [lane('D2')] }), { subagents: { D2: list } }));
    expect(m.nodes.filter(n => n.type === 'subagent').map(n => (n.data as SubData).taskId)).toEqual(['a', 'c', 'd']);
  });
  test('§4.5 ≤ 6 sub nodes per lane, then "+n"', () => {
    const list = Array.from({ length: 9 }, (_, i) => sub(`s${i}`));
    const m = buildFlow(inp(snapshot({ lanes: [lane('D2')] }), { subagents: { D2: list } }));
    expect(m.nodes.filter(n => n.type === 'subagent')).toHaveLength(6);
    const more = m.nodes.find(n => n.type === 'more')!;
    expect(more.data).toMatchObject({ count: 3, text: '+3 sub khác' });
  });
  test('§4.5 sub node: dot colour by status, type, token count; completed dimmed', () => {
    const m = buildFlow(inp(snapshot({ lanes: [lane('D2')] }), { subagents: { D2: [sub('tests', { status: 'failed' }), sub('rev', { status: 'completed', endedAt: NOW - 1000 })] } }));
    const [f, c] = m.nodes.filter(n => n.type === 'subagent').map(n => n.data as SubData);
    expect(render(<SubCard id="x" d={f!} />)).toContain(`background:${C.err}`);
    expect(render(<SubCard id="x" d={c!} />)).toContain('class="sub cmp"');
    expect(f!.tok).toBe('42k');
  });
  test('§4.5 "n sub ▾" closed → no sub node; running lane gets orbit dots on its disc (§4.3)', () => {
    const list = [sub('a'), sub('b')];
    const m = buildFlow(inp(snapshot({ lanes: [lane('D2')] }), { subagents: { D2: list }, closedSubs: new Set(['D2']) }));
    expect(m.nodes.some(n => n.type === 'subagent')).toBe(false);
    expect(laneOf(m, 'D2')).toMatchObject({ subs: { n: 2, open: false }, orbit: 2 });
  });
  test('§4.3 orbit dots only while the sub branch is closed: running lane with its branch open → orbit 0', () => {
    const m = buildFlow(inp(snapshot({ lanes: [lane('D2')] }), { subagents: { D2: [sub('a'), sub('b')] } }));
    expect(m.nodes.filter(n => n.type === 'subagent')).toHaveLength(2);
    expect(laneOf(m, 'D2')).toMatchObject({ subs: { n: 2, open: true }, orbit: 0 });
  });
  test('§4.5 nextSubExpiry: the earliest completed sub leaving its 60 s window; none → null', () => {
    const list = [sub('a', { status: 'completed', endedAt: NOW - 50_000 }), sub('b', { status: 'completed', endedAt: NOW - 20_000 }), sub('c', { status: 'failed', endedAt: NOW - 1_000 }), sub('d')];
    expect(nextSubExpiry({ D2: list, X: 3 }, NOW)).toBe(NOW - 50_000 + SUB_KEEP_MS);
    expect(nextSubExpiry({ D2: [sub('e', { status: 'completed', endedAt: NOW - SUB_KEEP_MS })], X: 2 }, NOW)).toBeNull();
    expect(nextSubExpiry({ D2: [sub('f'), sub('g', { status: 'completed', endedAt: null })] }, NOW)).toBeNull();
  });
});

describe('§4.6 wires', () => {
  test('§4.6 wire colour by child state: running cyan, waiting_po yellow, broken red, others dark', () => {
    expect(wireStyle('running').color).toBe(C.acc);
    expect(wireStyle('waiting_po').color).toBe(C.wait);
    expect(wireStyle('broken').color).toBe(C.err);
    for (const s of ['idle', 'waiting_quota', 'stopped', 'done', 'starting', 'draining', 'switching'] as LaneState[]) expect(wireStyle(s).color).toBe(C.dark);
    const m = buildFlow(inp(snapshot({ lanes: [lane('D2'), lane('D15', { state: 'waiting_po' }), lane('R5', { state: 'broken' }), lane('C1', { state: 'idle' })] })));
    expect(edgeTo(m, 'lane:D15').color).toBe(C.wait);
    expect(edgeTo(m, 'lane:R5').color).toBe(C.err);
    expect(edgeTo(m, 'lane:C1').color).toBe(C.dark);
    expect(edgeTo(m, 'lane:C1').glow).toBe(false);
  });
  test('§4.6 talkingTo wire is thick and its outgoing dot runs twice as fast', () => {
    const s = snapshot({ lanes: [lane('D2'), lane('B2')], orchestrators: [{ ...snapshot().orchestrators[0]!, talkingTo: 'D2' }] });
    const m = buildFlow(inp(s));
    expect(edgeTo(m, 'lane:D2').width).toBeGreaterThan(edgeTo(m, 'lane:B2').width);
    expect(edgeTo(m, 'lane:D2').width).toBe(2.2);
    const out = (id: string) => edgeTo(m, id).dots.find(d => !d.back)!.dur;
    expect(out('lane:D2') * 2).toBe(out('lane:B2'));
  });
  test('§4.6 dots: running = cyan out + green back 1.8 s; waiting_po = yellow back 2.4 s; idle = none; sub running 1.4 s', () => {
    const m = buildFlow(inp(snapshot({ lanes: [lane('D2'), lane('D15', { state: 'waiting_po' }), lane('C1', { state: 'idle' })] }), { subagents: { D2: [sub('t')] } }));
    expect(edgeTo(m, 'lane:D2').dots.map(d => [d.color, d.back, d.dur])).toEqual([[C.acc, false, 1.8], [C.run, true, 1.8]]);
    expect(edgeTo(m, 'lane:D15').dots.map(d => [d.color, d.back, d.dur])).toEqual([[C.wait, true, 2.4]]);
    expect(edgeTo(m, 'lane:C1').dots).toEqual([]);
    expect(edgeTo(m, 'sub:D2:t').dots.map(d => [d.color, d.back, d.dur])).toEqual([[C.white, false, 1.4], [C.run, true, 1.4]]);
  });
  test('§4.6 turn ended → 3 green dots run back once', () => {
    const m = buildFlow(inp(snapshot({ lanes: [lane('D2', { state: 'idle' })] }), { bursts: new Set(['D2']) }));
    const d = edgeTo(m, 'lane:D2').dots;
    expect(d).toHaveLength(3);
    expect(d.every(x => x.back && x.once && x.color === C.run)).toBe(true);
  });
});

describe('v2.8 §4.3 wires and state objects follow the theme', () => {
  const s = () => snapshot({ lanes: [lane('D2'), lane('B2'), lane('C1', { state: 'idle' })] });
  const wire = (d: object) => renderToStaticMarkup(<edgeTypes.wire {...({ data: d } as Parameters<typeof edgeTypes.wire>[0])} />);
  test('N2 a lit wire colours only its own last leg; a dark wire has none', () => {
    const m = buildFlow(inp(s(), { live: false })), w = edgeTo(m, 'lane:D2');
    const pts = w.d.split(/ (?=[ML])/);
    expect(w.branch).toBe(`M${pts.at(-2)!.slice(1)} ${pts.at(-1)}`);
    expect(edgeTo(m, 'lane:C1').branch).toBeNull();
  });
  test('N2 the trunk is drawn grey under the coloured leg; running = the 2 px "hot" wire of light', () => {
    const w = edgeTo(buildFlow(inp(s(), { live: false })), 'lane:D2'), h = wire(w);
    expect(h).toContain(`<path d="${w.d}" fill="none" stroke="${C.dark}" stroke-width="1" opacity="0.8" class="wire"></path>`);
    expect(h).toContain(`<path d="${w.branch}" fill="none" stroke="${C.acc}" stroke-width="1.4" opacity="1" class="wire hot"></path>`);
    expect(h).toContain(`<path d="${w.branch}" fill="none" stroke="${C.acc}" stroke-width="4" opacity=".12" class="wire-glow"></path>`);
    const dim = wire(edgeTo(buildFlow(inp(s(), { live: false })), 'lane:C1'));
    expect(dim.match(/<path/g)).toHaveLength(1);
    expect(dim).toContain('class="wire"');
  });
  test('glow parts carry `hl`, the status ring `rs` (light hides / thickens them in flow.css); colours are variables', () => {
    const h = renderToStaticMarkup(<Glyph state="running" live={false} />);
    expect(h.match(/class="hl"/g)).toHaveLength(2);
    expect(h).toContain('class="rs"');
    expect(h).toContain('stroke="var(--dk-ring)"');
    expect(renderToStaticMarkup(<Glyph state="done" live={false} />)).toContain('stroke="var(--dk-task)"');
    const css = readFileSync('web/src/deck/flow/flow.css', 'utf8');
    expect(css).toContain(':root[data-theme=light] .deck :is(.so .hl,.wire-glow){display:none}');
    expect(css).toContain(':root[data-theme=light] .deck .so .rs{stroke-width:2.6}');
    // v28-fx (ruling 21:20): no coloured border on a talking orchestrator in either theme, so no `lit` rule at all
    expect(css).not.toMatch(/\.nd\.orch\.lit/);
    expect(css).not.toContain('acc-hl');
  });
});

describe('§4.3 state object', () => {
  const ALL: LaneState[] = ['starting', 'running', 'idle', 'waiting_po', 'switching', 'waiting_quota', 'draining', 'stopped', 'broken', 'done'];
  test('§4.3 one class per LaneState (so-<state>) + orchestrator states', () => {
    for (const s of ALL) expect(renderToStaticMarkup(<Glyph state={s} live />)).toContain(`class="so so-${s}"`);
    for (const s of ['root', 'root_quota', 'root_down', 'root_ask', 'root_start'] as const) expect(renderToStaticMarkup(<Glyph state={s} live />)).toContain(`so-${s}`);
  });
  test('§4.3 moving parts per state: running spins, waiting_po waves (hf1117-p4: only running spins), broken blinks, quota / stopped / done still', () => {
    const h = (s: LaneState) => renderToStaticMarkup(<Glyph state={s} live />);
    expect(h('running')).toContain('a-spin');
    expect(h('waiting_po')).toContain('a-wave');
    expect(h('broken')).toContain('a-blink');
    expect(h('switching')).toContain('a-swf');
    for (const s of ['waiting_quota', 'stopped', 'done', 'draining'] as LaneState[]) expect(h(s)).not.toMatch(ANIM);
    expect(h('done')).toContain('<path'); // ✓ drawn with strokes, no emoji
  });
  test('§4.3 / §5.2 no filter on any state object', () => {
    for (const s of ALL) expect(renderToStaticMarkup(<Glyph state={s} live orbit={3} />)).not.toContain('filter');
  });
});

describe('§5.2 motion gate → zero animations when paused', () => {
  const s = snapshot({ lanes: [lane('D2'), lane('D15', { state: 'waiting_po' }), lane('R5', { state: 'broken' }), lane('S7', { state: 'starting' })] });
  const subs = { D2: [sub('t')] };
  test('§5.2 paused (live=false): no dot on any wire, no animated class on any node', () => {
    const m = buildFlow(inp(s, { live: false, subagents: subs, bursts: new Set(['D2']) }));
    expect(m.edges.every(e => e.data.dots.length === 0)).toBe(true);
    const html = m.nodes.map(n => n.type === 'lane' ? render(<LaneCard id={n.id} d={n.data as LaneData} />, { live: false })
      : n.type === 'orchestrator' ? render(<OrchCard id={n.id} d={n.data as OrchData} />, { live: false }) : '').join('')
      + m.edges.map(e => renderToStaticMarkup(<WireDots w={e.data} />)).join('');
    expect(html).not.toMatch(ANIM);
  });
  test('§5.2 live: the same deck has spinning objects and travelling dots (the gate is what removes them)', () => {
    const m = buildFlow(inp(s, { live: true, subagents: subs }));
    const html = m.nodes.filter(n => n.type === 'lane').map(n => render(<LaneCard id={n.id} d={n.data as LaneData} />)).join('')
      + m.edges.map(e => renderToStaticMarkup(<WireDots w={e.data} />)).join('');
    expect(html).toMatch(ANIM);
    expect(html).toContain('offset-path:path(');
  });
  test('§5.2 running dots use offset-path (no SMIL), the CSS removes every loop on .deck.paused / .reduced', () => {
    const css = readFileSync(new URL('../../src/deck/flow/flow.css', import.meta.url), 'utf8');
    expect(css).toContain('.deck.paused *{animation:none!important}');
    expect(css).toContain('.deck.reduced *{animation:none!important}');
    expect(css).not.toMatch(/animateMotion/);
    // §5.2 only transform / opacity / offset-distance animate — in every deck stylesheet (flow + account panel)
    const panel = readFileSync(new URL('../../src/deck/AccountPanel.css', import.meta.url), 'utf8');
    for (const kf of (css + panel).match(/@keyframes [^{]+\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g) ?? []) {
      for (const prop of kf.matchAll(/[{;]([a-z-]+):/g)) expect(['transform', 'opacity', 'offset-distance']).toContain(prop[1]!);
    }
  });
  test('§4.10 reduced motion: a state change is a 100 ms fade (the glyph remounts per state, the fade beats the loop kill)', () => {
    const css = readFileSync(new URL('../../src/deck/flow/flow.css', import.meta.url), 'utf8');
    expect(css).toContain('.deck.fade .so{animation:so-fade 100ms linear!important}');
    expect(css).toMatch(/@keyframes so-fade\{from\{opacity:0\}to\{opacity:1\}\}/);
    const m = (o: Partial<Parameters<typeof deckClass>[0]>) => deckClass({ paused: true, reduced: true, transition: 'fade', still: true, why: ['reduced'], ...o }, true);
    expect(m({}).split(' ')).toContain('fade');
    expect(m({ transition: 'none' }).split(' ')).not.toContain('fade');
    expect(m({ reduced: false, paused: false, transition: 'slide', why: [] })).toBe('map deck');
  });
  test('G4 animated = a lane / the orchestrator runs; a calm deck is not', () => {
    expect(buildFlow(inp(s)).animated).toBe(true);
    const calm = snapshot({ lanes: [lane('D15', { state: 'waiting_po' })], orchestrators: [{ ...snapshot().orchestrators[0]!, state: 'idle' }] });
    expect(buildFlow(inp(calm)).animated).toBe(false);
  });
});

describe('§4.11 node clicks + §4.12 "Chống bấm nhầm"', () => {
  test('§4.11 "Trả lời" selects the card + its lane; the node body selects the lane', () => {
    const got: unknown[] = [];
    const d = laneOf(buildFlow(inp(snapshot({ lanes: [lane('D15', { state: 'waiting_po' })], cards: [card(7, { source: 'D15' })] }))), 'D15');
    const html = render(<LaneCard id="lane:D15" d={d} />, { act: i => got.push(i) });
    expect(html).toContain('role="group"');
    expect(html).not.toMatch(/<button[^>]*>[^<]*<button/); // no nested buttons
    expect(d.line2).toMatchObject({ kind: 'card', face: { cardId: 7 } });
  });
  test('§4.12 a node that moved ignores clicks for 1 s (fake clock)', () => {
    const g = new MoveGuard();
    g.update([{ id: 'lane:D2', x: 272, y: 0 }], 0);
    expect(g.allow('lane:D2', 10)).toBe(true); // first layout is not a move
    g.update([{ id: 'lane:D2', x: 272, y: 74 }], 5_000);
    expect(g.allow('lane:D2', 5_000 + MOVE_GUARD_MS - 1)).toBe(false);
    expect(g.allow('lane:D2', 5_000 + MOVE_GUARD_MS)).toBe(true);
    g.update([{ id: 'lane:D2', x: 272, y: 74 }], 9_000); // same place again → not re-armed
    expect(g.allow('lane:D2', 9_001)).toBe(true);
  });
  test('§4.11 selection from the store: selected lane gets .sel, nothing selected → the orchestrator', () => {
    const s = snapshot({ lanes: [lane('D2')] });
    expect(laneOf(buildFlow(inp(s, { selected: 'D2' })), 'D2').selected).toBe(true);
    expect(orchOf(buildFlow(inp(s, { selected: 'D2' }))).selected).toBe(false);
    expect(orchOf(buildFlow(inp(s))).selected).toBe(true);
  });
});

describe('§4.2 / §5.2 sparkline ring', () => {
  test('§4.2 tokens / minute of the last 10 minutes; redraw ≤ 1 / 10 s', () => {
    const r = new SparkRing(), t0 = 1_000_000_000;
    r.push('D2', t0, 0);
    r.push('D2', t0 + 60_000, 6_000);
    const a = r.series('D2', t0 + 61_000)!;
    expect(a).toHaveLength(10);
    expect(a.reduce((x, y) => x + y, 0)).toBe(6_000);
    r.push('D2', t0 + 65_000, 12_000);
    expect(r.series('D2', t0 + 65_000)).toBe(a); // same 10 s window → cached, not redrawn
    expect(r.series('D2', t0 + 70_000)).not.toBe(a);
  });
});

describe('§4.14 parallel sessions: one root per running session', () => {
  const two = () => snapshot({
    orchestrators: [
      { projectId: 'p1', state: 'running', account: 'a@x', homeAccount: 'a@x', lastError: null, costUsd: 0, contextPct: 10, talkingTo: null, sessionId: 's3', seq: 3 },
      { projectId: 'p1', state: 'running', account: 'b@x', homeAccount: 'b@x', lastError: null, costUsd: 0, contextPct: 10, talkingTo: null, sessionId: 's4', seq: 4, title: 'hotfix' },
    ],
    lanes: [lane('D2', { ownerSession: 's3', ownerSeq: 3 }), lane('H2', { ownerSession: 's4', ownerSeq: 4 })],
  });
  const orchs = (m: ReturnType<typeof buildFlow>) => m.nodes.filter(n => n.type === 'orchestrator');
  test('§4.14 roots from N sessions, in open order; each lane hangs off its owner; "Điều phối #n" + title', () => {
    const m = buildFlow(inp(two()));
    expect(orchs(m).map(n => n.id)).toEqual(['orch:s3', 'orch:s4']);
    expect(orchs(m).map(n => (n.data as OrchData).name)).toEqual(['Điều phối #3', 'Điều phối #4']);
    expect((orchs(m)[1]!.data as OrchData).title).toBe('hotfix');
    expect(m.edges.find(e => e.target === 'lane:H2')!.source).toBe('orch:s4');
    expect(m.edges.find(e => e.target === 'lane:D2')!.source).toBe('orch:s3');
  });
  test('§4.14 N5-c "giữa hai cây có vạch ngang mờ": 2 roots → 1 separator between the trees, drawn as a dashed line', () => {
    const m = buildFlow(inp(two())), one = buildFlow(inp(snapshot({ lanes: [lane('D2')] })));
    expect(one.separators).toEqual([]);
    expect(m.separators).toHaveLength(1);
    const [s] = m.separators, top = orchs(m)[0]!, second = orchs(m)[1]!;
    expect(s!.y).toBeGreaterThan(top.y + top.h);
    expect(s!.y).toBeLessThan(second.y);
    expect(s!.x1 - s!.x0).toBe(m.width);
    const html = renderToStaticMarkup(<SepLine />);
    expect(html).toContain('class="tsep"');
    expect(html).toContain('aria-hidden="true"');
    expect(readFileSync(new URL('../../src/deck/flow/flow.css', import.meta.url), 'utf8')).toMatch(/\.tsep\{[^}]*dashed[^}]*var\(--line-2\)/);
  });
  test('§4.14 the viewed root is the selected one; none when an ended session is viewed (viewed = null)', () => {
    const sel = (m: ReturnType<typeof buildFlow>) => orchs(m).filter(n => (n.data as OrchData).selected).map(n => n.id);
    expect(sel(buildFlow(inp(two(), { viewed: 's4' })))).toEqual(['orch:s4']);
    expect(sel(buildFlow(inp(two())))).toEqual(['orch:s3']);
    const ended = buildFlow(inp(two(), { viewed: null }));
    expect(sel(ended)).toEqual([]);
    expect(ended.nodes.map(n => n.id)).toEqual(buildFlow(inp(two())).nodes.map(n => n.id)); // the graph does not change
  });
  test('§4.14 clicking a root = view that session: the composer / watch target carries its sessionId', () => {
    const i = rootIntent('orch:s4');
    expect(i).toEqual({ t: 'orch', root: 's4' });
    const os = sessionsOf(two(), 'p1'), v = viewedSession(os, i.t === 'orch' ? i.root ?? null : null);
    expect(composerTarget(ORCH, 'p1', v?.sessionId ?? null)).toEqual({ kind: 'orchestrator', projectId: 'p1', sessionId: 's4' });
    expect(targetKey(composerTarget(ORCH, 'p1', 's4'))).not.toBe(targetKey(composerTarget(ORCH, 'p1', 's3'))); // the switch re-watches
  });
});
