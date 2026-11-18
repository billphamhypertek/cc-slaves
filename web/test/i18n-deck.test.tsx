// v2 §6A (D19) T9c: deck HUD + lib labels render in `ui.lang`; system-card body / buttons by key with the vi fallback.
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { makeT } from '../../shared/i18n/index.ts';
import { buildFlow, type FlowInput, type LaneData, type OrchData } from '../src/deck/flow/model.ts';
import { DeckCtx, LaneCard } from '../src/deck/flow/nodes.tsx';
import { cardButton, cardLabel, laneCard, orchCard } from '../src/deck/cards.ts';
import { actionLabel, cardBody, LangProvider } from '../src/lib/i18n.tsx';
import { cardSource, laneState, orchState, phaseName, stopSub } from '../src/lib/labels.ts';
import { groupLanes } from '../src/lib/list.ts';
import { keyAnswer, permLabel } from '../src/lib/cards.ts';
import { switchOptions } from '../src/lib/accounts.ts';
import { buildItems } from '../src/lib/palette.ts';
import { parseInput } from '../src/lib/console.ts';
import { CommandError } from '../src/lib/ws.ts';
import { errText } from '../src/lib/i18n.tsx';
import { account, card, lane, snapshot } from './fixtures.ts';
import { NOW, scene } from './deck/scene.ts';

const EN = makeT('en'), VI = makeT('vi');
const VIET = /[À-ỹ]/;
const inp = (over: Partial<FlowInput> = {}): FlowInput => ({ snap: scene(5), projectId: 'p1', subagents: {}, selected: null, now: NOW, tr: EN, live: true, ...over });

describe('§6A deck in en (v2.1 nodes)', () => {
  test('§6A node texts, tooltips and aria carry no Vietnamese in en (lane tasks / questions excepted)', () => {
    const snap = scene(5, undefined, { lanes: scene(5).lanes.map(l => ({ ...l, task: null })), cards: [card(7, { source: 'D15', question: 'keep the old API?' })] });
    const m = buildFlow(inp({ snap, doneOpen: true }));
    const texts = m.nodes.flatMap(n => {
      const d = n.data as unknown as Record<string, unknown>;
      return [...((d.tip as string[] | undefined) ?? []), String(d.aria ?? ''), String(d.text ?? ''), String(d.tok ?? ''), String(d.phase ?? '')];
    });
    expect(texts.filter(t => VIET.test(t))).toEqual([]);
    const c1 = m.nodes.find(n => n.id === 'lane:C1')!.data as LaneData;
    expect(c1.tip[0]).toMatch(/^C1 · Waiting for quota/);
    expect((m.nodes.find(n => n.type === 'orchestrator')!.data as OrchData).tip[0]).toBe('Orchestrator · Running');
  });

  test('§6A node words in vi / en (§5.4: short English words)', () => {
    const d15 = (tr: typeof EN) => renderToStaticMarkup(<LangProvider lang={tr.lang}><DeckCtx.Provider value={{ tr, live: false, act: () => {}, menu: () => {}, toggleSubs: () => {}, toggleDone: () => {}, tip: () => {} }}>
      <LaneCard id="lane:D15" d={buildFlow(inp({ tr })).nodes.find(n => n.id === 'lane:D15')!.data as LaneData} /></DeckCtx.Provider></LangProvider>);
    expect(d15(EN)).toContain('>PO:<');
    expect(d15(EN)).toContain('>Answer<');
    expect(d15(VI)).toContain('>Chờ PO:<');
    expect(d15(VI)).toContain('>Trả lời<');
  });

  test('§6A lane / orch cards in en', () => {
    expect(cardLabel(EN, laneCard(lane('D2'), [card(1, { kind: 'permission', source: 'D2' })], EN)!.kind)).toBe('Run?');
    expect(cardButton(EN, laneCard(lane('D2', { state: 'waiting_po' }), [], EN)!.kind)).toBe('View');
    expect(orchCard({ state: 'stopped' } as never, [], 'p1')).toEqual({ kind: 'down', cardId: null });
    // a system ask without a question shows its title in the UI language
    expect(laneCard(lane('D2'), [card(2, { source: 'D2', question: undefined, title: 'D2 hỏi', titleKey: 'cards.laneBroken', params: { name: 'D2' } })], EN)!.text).toBe('Lane D2 broken');
  });
});

describe('§6A T9c lib labels in en', () => {
  test('§6A lane / orch states, phases, card source', () => {
    expect(laneState(EN, 'waiting_quota')).toBe('Waiting for quota');
    expect(laneState(VI, 'waiting_quota')).toBe('Chờ quota');
    expect(orchState(EN, 'running')).toBe('Orchestrator replying…');
    expect(phaseName(EN, 'gate')).toBe('Gate');
    expect(cardSource(EN, card(1, { kind: 'permission', source: 'D2' }))).toBe('Lane D2 · permission');
    expect(cardSource(EN, card(1, { kind: 'orchestrator_down', source: null }), 'Shop')).toBe('The Shop orchestrator');
    expect(cardSource(VI, card(1, { kind: 'logged_out', source: null }))).toBe('Engine · account');
    // §4.11b N1-a M1: the engine's broken card has no source, only `key` lane:<name> → it reads as that lane's card
    expect(cardSource(VI, card(1, { kind: 'broken', source: null, key: 'lane:R5' }))).toBe('Lane R5');
  });
  test('§4.12 N2-e stop dialog subtitle: task · note · n subagents running (none → no part)', () => {
    expect(stopSub(VI, lane('D2', { task: 'group A lot-2', note: 'port parser' }), 3)).toBe('group A lot-2 · port parser · đang chạy 3 subagent');
    expect(stopSub(EN, lane('D2', { task: 'lot-2', note: null }), 1)).toBe('lot-2 · 1 subagent running');
    expect(stopSub(VI, lane('D2', { task: null, note: null }), 0)).toBeNull();
  });

  test('§6A list groups in en, vi unchanged', () => {
    expect(groupLanes(EN, [lane('D2')]).map(g => g.label)).toEqual(['Waiting on PO', 'Working', 'Waiting for quota', 'Idle', 'Paused', 'Done & stopped']);
    expect(groupLanes(VI, []).map(g => g.label)[5]).toBe('Đã xong & đã dừng');
  });

  test('§6A permission buttons + ⌥ answers in en', () => {
    const c = card(1, { kind: 'permission', canAllowAlways: true });
    expect([1, 2, 3].map(n => keyAnswer(EN, c, n)!.label)).toEqual(['Allow', 'Always allow this session', 'Deny']);
    expect(permLabel(VI, 'deny')).toBe('Từ chối');
  });

  test('§6A switch options in en', () => {
    const o = switchOptions(EN, lane('D2', { account: 'a@x' }), [account('a@x', { headroomPct: 40 }), account('b@x', { loggedOut: true }), account('c@x', { role: 'backup', headroomPct: 20, hard: true, week: 80 })]);
    expect(o.map(x => x.reason)).toEqual(['engine picks the account with the most room', 'running here', 'signed out', 'Backup · 20% left (hard 80)']);
    expect(o[0]!.label).toBe('Auto');
  });

  test('§6A palette in en: groups by id, labels translated', () => {
    const items = buildItems(EN, snapshot(), { projectId: 'p1', selectedLane: 'D2', keys: ['D2'], offline: false, tauri: true });
    expect([...new Set(items.map(i => i.group))]).toEqual(['lane', 'action', 'project', 'account']);
    expect(items.find(i => i.id === 'm:lane:p1:D2:stop')!.label).toBe('D2 · Stop…');
    expect(items.find(i => i.id === 'settings')!.label).toBe('Settings');
    expect(items.filter(i => VIET.test(i.label))).toEqual([]);
  });

  test('§6A console /stop usage + ws errors render in en', () => {
    expect(parseInput(EN, '/stop', [])).toEqual({ kind: 'error', text: 'Type /stop <lane>, e.g. /stop D2' });
    expect(errText(EN, new CommandError('offline', 'x', 'labels.wsOffline'))).toBe('Lost the engine connection — retry once it reconnects.');
  });
});

describe('§6A T9c system card body + buttons by key', () => {
  const sys = card(9, {
    kind: 'cc_updated', source: null, question: undefined, context: 'Khởi động thử đạt: system/init, phiên bản, MCP cc_slaves.', bodyKey: 'cardText.body.ccUpdatedOk',
    actions: [{ id: 'dismiss', label: 'Đã xem', labelKey: 'cardText.act.seen' }],
  });
  test('§6A en renders the key, vi the stored text, unknown key → stored text', () => {
    expect(cardBody(EN, sys)).toBe('Start check passed: system/init, version, MCP cc_slaves.');
    expect(cardBody(VI, sys)).toBe(sys.context!);
    expect(actionLabel(EN, sys.actions![0]!)).toBe('Got it');
    expect(cardBody(EN, { ...sys, bodyKey: 'cardText.nope' })).toBe(sys.context!);
    expect(actionLabel(EN, { id: 'x', label: 'Gộp', labelKey: 'cardText.nope' })).toBe('Gộp');
    expect(cardBody(EN, { ...sys, bodyKey: undefined, context: 'claude exit 1' })).toBe('claude exit 1');
  });
});
