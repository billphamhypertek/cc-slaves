// hf1117-p3 (perf audit C3): a reveal frame of the streaming text re-renders the conversation, never the App shell (nor the
// Deck), and a hidden left column (Tasks) does no per-frame work. Real DOM (happy-dom) + a render counter over the committed
// fiber tree (the perf kit's walk, scripts/perf/probe.ts; read from the container: another test file may load react-dom first).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Snapshot } from '../../shared/protocol.ts';
import type { RevealClock } from '../src/lib/stream-reveal.ts';
import type { EngineClient } from '../src/lib/ws.ts';
import { snapshot } from './fixtures.ts';

interface Fiber { tag: number; type: unknown; flags: number; alternate: Fiber | null; child: Fiber | null; sibling: Fiber | null }
const renders: Record<string, number> = {};
const NAMED = new Set([0, 1, 11, 14, 15]);
const nameOf = (f: Fiber): string => {
  const t = f.type as { displayName?: string; name?: string; type?: { name?: string } } | null;
  return t?.displayName ?? t?.name ?? t?.type?.name ?? '?';
};
/** the components the last commit rendered: a function fiber mounted or with PerformedWork; a bailed-out subtree is skipped.
 *  `all`: every component in the tree instead (is it mounted at all). */
function count(host: Element, all = false) {
  const k = Object.keys(host).find(x => x.startsWith('__reactContainer$'))!;
  const root = (host as unknown as Record<string, { stateNode: { current: Fiber } }>)[k]!.stateNode;
  const stack: [Fiber, boolean][] = [[root.current, false]];
  while (stack.length) {
    const [f, inMount] = stack.pop()!;
    const mount = all || inMount || f.alternate === null;
    if (NAMED.has(f.tag) && (mount || (f.flags & 1) === 1)) { const n = nameOf(f); renders[n] = (renders[n] ?? 0) + 1; }
    if (f.sibling) stack.push([f.sibling, inMount]);
    if (f.child && (mount || f.child !== f.alternate?.child)) stack.push([f.child, mount]);
  }
}

const G = globalThis as Record<string, unknown>;
const win = new Window({ url: 'http://localhost/', width: 1440, height: 900 });
const W = win as unknown as Record<string, unknown>;
/** the DOM names the app reads + every window name bun does not have (never bun's own timers / fetch) */
const KEYS = [...new Set(['window', 'document', 'navigator', 'location', 'localStorage', 'Event', 'CustomEvent',
  ...Object.getOwnPropertyNames(win).filter(k => !(k in globalThis) && !k.startsWith('_'))])];
const saved = new Map<string, unknown>();

beforeAll(() => {
  for (const k of [...KEYS, 'IS_REACT_ACT_ENVIRONMENT']) saved.set(k, G[k]);
  for (const k of KEYS) G[k] = k === 'window' ? win : W[k];
  G.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(async () => {
  for (const [k, v] of saved) { if (v === undefined) delete G[k]; else G[k] = v; }
  await win.happyDOM.close();
});

function fakeClock(): RevealClock & { tick(): void } {
  let t = 0, id = 0; const q = new Map<number, () => void>();
  return { now: () => t, raf: cb => { q.set(++id, cb); return id; }, caf: i => { q.delete(i); },
    tick() { t += 1000 / 60; const cbs = [...q.values()]; q.clear(); for (const cb of cbs) cb(); } };
}

async function mount(snap: Snapshot) {
  const { act, createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { App } = await import('../src/ui/App.tsx');
  const { Store } = await import('../src/lib/store.ts');
  const clock = fakeClock(), store = new Store(() => 0, null, { clock });
  store.apply({ type: 'snapshot', snapshot: snap });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const client = { send: () => new Promise(() => {}), token: () => '', retryNow() {} } as unknown as EngineClient;
  await act(async () => { root.render(createElement(App, { store, client })); });
  await act(async () => { await Promise.all([import('../src/ui/LeftColumn.tsx'), import('../src/deck/DeckView.tsx')]); await new Promise(r => setTimeout(r, 20)); });
  count(host, true);
  expect(renders.ConvList ?? 0).toBeGreaterThan(0); // the counter sees the tree: the conversation is mounted
  const target = { kind: 'orchestrator', projectId: 'p1' } as const;
  // six finished rows above the streaming block (C4: they never redraw on its frames)
  const lines = [1, 2, 3, 4, 5, 6].map(seq => ({ seq, ts: seq, kind: seq % 2 ? 'assistant' : 'system', text: `dòng ${seq}` }) as const);
  await act(async () => { store.apply({ type: 'event', event: { type: 'stream', target, lines: [...lines] } }); });
  /** one `partial` delta then `n` reveal frames; returns the renders they cost per component */
  const stream = async (text: string, n: number) => {
    for (const k of Object.keys(renders)) delete renders[k];
    await act(async () => { store.apply({ type: 'event', event: { type: 'partial', target, key: 'm:1', parent: null, delta: text } }); });
    for (let i = 0; i < n; i++) { await act(async () => { clock.tick(); }); count(host); } // one frame = one commit
    return { ...renders };
  };
  /** click a mode tab (`.wst`, by its key letter) */
  const tab = async (key: string) => {
    const b = [...host.querySelectorAll<HTMLButtonElement>('.wst')].find(x => x.querySelector('.kb')?.textContent === key)!;
    await act(async () => { b.click(); await new Promise(r => setTimeout(r, 20)); });
  };
  const ev = async (event: Record<string, unknown>) => { await act(async () => { store.apply({ type: 'event', event: { target, ...event } as never }); }); };
  const frames = async (n: number) => { for (let i = 0; i < n; i++) await act(async () => { clock.tick(); }); };
  return { host, stream, tab, ev, frames, unmount: () => act(async () => { root.unmount(); }) };
}

describe('hf1117-p3 C3 a reveal frame re-renders only the conversation', () => {
  test('Deck: frames re-render ConvList, never AppInner / DeckView / LeftColumn; the text still reveals', async () => {
    const m = await mount(snapshot({ channel: 'remote' })); // remote: Deck is the first screen, left column shown
    const r = await m.stream('Xin chào anh, đây là một câu trả lời đang hiện dần ra.', 10);
    expect(r.ConvList ?? 0).toBeGreaterThan(1); // the conversation still updates frame by frame
    expect(r.AppInner ?? 0).toBe(0);
    expect(r.DeckView ?? 0).toBe(0);
    expect(r.LeftColumn ?? 0).toBe(0);
    // C4: only the streaming row per frame, not all seven rows (a `memo` with a compare counts twice: its fiber + the inner one)
    expect(r.Item ?? 0).toBeLessThanOrEqual(2 * 11);
    expect(m.host.querySelector('#inspector')?.textContent).toContain('Xin chào');
    await m.unmount();
  });
  test('Tasks: the hidden left column does no per-frame work', async () => {
    const m = await mount(snapshot()); // mac: Tasks is the first screen, left column hidden
    expect(m.host.querySelector('#left')?.hasAttribute('hidden')).toBe(true);
    expect(m.host.querySelector('#left #inspector')).not.toBeNull(); // the conversation is mounted, only hidden
    const r = await m.stream('Một câu trả lời trong lúc anh xem Tasks.', 10);
    expect(r.ConvList ?? 0).toBe(0);
    expect(r.AppInner ?? 0).toBe(0);
    await m.unmount();
  });
  test('hf-fa IMPORTANT-1: Deck → Tasks → Deck in the middle of an answer still shows the full answer', async () => {
    const m = await mount(snapshot()); // mac: Tasks first
    await m.tab('D');
    const a = 'Câu đầu của câu trả lời. ', b = 'Câu giữa lúc anh đang xem Tasks. ', c = 'Câu cuối cùng hiện đủ.';
    await m.ev({ type: 'partial', key: 'm:1', parent: null, delta: a });
    await m.frames(4);
    await m.tab('T');
    await m.ev({ type: 'partial', key: 'm:1', parent: null, delta: b });
    await m.frames(40);
    await m.tab('D');
    await m.ev({ type: 'partial', key: 'm:1', parent: null, delta: c });
    await m.frames(40);
    await m.ev({ type: 'partial_end', key: 'm:1' });
    await m.ev({ type: 'stream', lines: [{ seq: 7, ts: 7, kind: 'assistant', text: a + b + c, key: 'm:1' }] });
    await m.frames(120);
    expect(m.host.querySelector('#inspector')?.textContent).toContain(c);
    await m.unmount();
  });
});
