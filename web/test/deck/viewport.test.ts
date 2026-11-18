// spec v2.1 §4.9 khung nhìn, §6 "Vật cản khi vừa màn hình", UX-I4: the pure viewport geometry on real layout output.
import { describe, expect, test } from 'bun:test';
import { layoutDeck, type LayoutInput, type LayoutLane } from '../../src/deck/layout.ts';
import {
  autoFitAllowed, shouldAutoFit, contentBox, edgeMarkers, fitViewport, glideInto, minimapVisible, obstacleRects,
  toScreen, FIT_FLOOR, USER_QUIET_MS, type Marked, type Rect, type Screen, type Vp,
} from '../../src/deck/flow/viewport.ts';

const lane = (i: number, o: Partial<LayoutLane> = {}): LayoutLane =>
  ({ name: `L${i}`, root: 'r1', order: i, state: 'running', done: false, unmerged: false, doneAt: null, changedAt: null, subs: [], subsOpen: true, ...o });
const tree = (n: number, subs = 0, o: (i: number) => Partial<LayoutLane> = () => ({})): LayoutInput => ({
  roots: [{ id: 'r1', collapsed: false }], selected: null, doneOpen: false, now: 0,
  lanes: Array.from({ length: n }, (_, i) => lane(i, { subs: Array.from({ length: i % 3 === 0 ? subs : 0 }, (_, k) => `s${k}`), ...o(i) })),
});
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** canvas frames for the two windows UX-I4 names: wide = window − 56 px top bar − 424 px left column; narrow (< 1280) =
 *  the left column is a drawer, the deck takes the full width. */
/** deck frame = window − 424 px left column (≥ 1280) − 56 px top bar. */
const W1280: Screen = { w: 1280 - 424, h: 800 - 56 }, W1024: Screen = { w: 1024, h: 640 - 56 };

describe('§4.9 fit', () => {
  test('§4.9 deck frame: 1280×800 → 856×744 (left column 424), 1024×640 → full width 1024×584 (drawer)', () => {
    expect(W1280).toEqual({ w: 856, h: 744 });
    expect(W1024).toEqual({ w: 1024, h: 584 });
  });

  test('§4.9 fit never below 0.9 with 33 lanes (UX-I4 text ≥ 10 px, targets ≥ 24 px)', () => {
    for (const s of [W1280, W1024]) {
      const vp = fitViewport(contentBox(layoutDeck(tree(33, 3)).nodes), s);
      expect(vp.zoom).toBe(FIT_FLOOR);
    }
  });

  test('§4.9 a small tree fits at zoom ≤ 1 (never blown up)', () => {
    const vp = fitViewport(contentBox(layoutDeck(tree(2)).nodes), W1280);
    expect(vp.zoom).toBeLessThanOrEqual(1);
    expect(vp.zoom).toBeGreaterThanOrEqual(FIT_FLOOR);
  });

  test('§6.7 D53 the header obstacle = the deck head bar --h-head 28; the account card sits --s5 under it (AccountPanel.css .accp.mini)', () => {
    const obs = Object.fromEntries(obstacleRects(W1280).map(o => [o.id, o.rect]));
    expect(obs.header!.h).toBe(28);
    expect(obs.account!.y).toBe(28 + 14); // hot fix 2026-11-16 --s5 14
  });

  test('§6 Vật cản: after fit no node overlaps the header bar, account card, zoom buttons, minimap or the 44 px strip (1280×800, 1024×640)', () => {
    let fitted = 0;
    for (const s of [W1280, W1024]) {
      const obs = obstacleRects(s);
      expect(obs.map(o => o.id).sort()).toEqual(['account', 'header', 'minimap', 'strip', 'zoom']);
      for (let n = 0; n <= 14; n++) for (const subs of [0, 3, 8]) {
        const lay = layoutDeck(tree(n, subs));
        const box = contentBox(lay.nodes, n === 0 ? { w: 300 } : undefined), vp = fitViewport(box, s);
        if (vp.zoom <= FIT_FLOOR) continue; // floor case: the tree scrolls, overlap below the fold is expected
        fitted++;
        for (const nd of lay.nodes) for (const o of obs) {
          const r = toScreen(nd, vp);
          if (overlap(r, o.rect)) throw new Error(`${s.w}×${s.h} n=${n} subs=${subs}: ${nd.id} under ${o.id}`);
          expect(r.x).toBeGreaterThanOrEqual(0);
          expect(r.x + r.w).toBeLessThanOrEqual(s.w);
        }
      }
    }
    expect(fitted).toBeGreaterThan(20); // the loop really checked fitted trees
  });

  test('§6 Vật cản: any content shape that fits is clear of every floating box (synthetic boxes, both frames)', () => {
    let fitted = 0;
    for (const s of [W1280, W1024]) for (let w = 100; w <= 1300; w += 40) for (let h = 40; h <= 900; h += 40) {
      const box = { x: 0, y: 0, w, h }, vp = fitViewport(box, s);
      if (vp.zoom <= FIT_FLOOR) continue; // floor: the tree scrolls (§4.9), some box may cover part of it
      fitted++;
      const r = toScreen(box, vp);
      for (const o of obstacleRects(s)) if (overlap(r, o.rect)) throw new Error(`${s.w}×${s.h} box ${w}×${h} under ${o.id}`);
    }
    expect(fitted).toBeGreaterThan(200);
  });

  test('§6 Vật cản at the floor (DKS 1280×800 / 1024×640): the tree runs past the frame, yet no node wholly on screen sits under the zoom buttons, the minimap or the ↓ edge marker', () => {
    let floors = 0, nudged = 0;
    for (const s of [W1280, W1024]) {
            for (let n = 9; n <= 40; n++) for (const subs of [0, 2, 3, 8]) {
        const lay = layoutDeck(tree(n, subs)), box = contentBox(lay.nodes); // every 4th lane waits on the PO: a ↓ marker shows
        const marked: Marked[] = lay.nodes.filter(nd => /^lane:L\d+$/.test(nd.id) && Number(nd.id.slice(6)) % 4 === 1).map(nd => ({ id: nd.id, rect: nd, kind: 'ask' }));
        const plain = fitViewport(box, s), vp = fitViewport(box, s, lay.nodes, marked), d = edgeMarkers(marked, vp, s).down, obs = [...obstacleRects(s).filter(o => o.id !== 'strip').map(o => o.rect),
          ...(d.ask + d.broken ? [{ x: s.w / 2 - 120, y: s.h - 36, w: 240, h: 28 }] : [])]; // flow.css .dm-down: bottom 8, 28 tall, centred
        if (plain.zoom > FIT_FLOOR) { expect(vp).toEqual(plain); continue; } // a tree that fits keeps its fit
        floors++;
        if (vp.x !== plain.x || vp.y !== plain.y) nudged++;
        expect(vp.zoom).toBe(FIT_FLOOR);
        expect(vp.y).toBeGreaterThanOrEqual(plain.y); // never above the toast band (UX-M9)
        for (const nd of lay.nodes) {
          const r = toScreen(nd, vp);
          if (r.x < -0.5 || r.y < -0.5 || r.x + r.w > s.w + 0.5 || r.y + r.h > s.h + 0.5) continue; // cut by the frame edge: scrolls
          for (const o of obs) if (overlap(r, o)) throw new Error(`${s.w}×${s.h} n=${n} subs=${subs}: ${nd.id} under ${JSON.stringify(o)}`);
        }
      }
    }
    expect(floors).toBeGreaterThan(40);
    expect(nudged).toBeGreaterThan(0); // the top-aligned pan alone is not clean for every tree
  });

  test('§4.10 N4-b no-lanes hint is part of the fitted box (extra width right of the root)', () => {
    const lay = layoutDeck(tree(0)), plain = contentBox(lay.nodes), hint = contentBox(lay.nodes, { w: 300 });
    expect(hint.w).toBe(plain.w + 300);
    const vp = fitViewport(hint, W1024), r = toScreen(hint, vp);
    for (const o of obstacleRects(W1024)) expect(overlap(r, o.rect)).toBe(false);
  });

  test('§4.9 floor case: the top of the tree (root) sits below the header bar and the account card column', () => {
    const lay = layoutDeck(tree(33)), box = contentBox(lay.nodes);
    for (const s of [W1280, W1024]) {
      const vp = fitViewport(box, s), top = toScreen(box, vp);
      const obs = obstacleRects(s), head = obs.find(o => o.id === 'header')!.rect, acc = obs.find(o => o.id === 'account')!.rect;
      expect(top.y).toBeGreaterThanOrEqual(head.y + head.h);
      const root = toScreen(lay.nodes.find(n => n.kind === 'orchestrator')!, vp);
      expect(overlap(root, acc)).toBe(false);
      for (const nd of lay.nodes.filter(n => n.y < 200)) expect(overlap(toScreen(nd, vp), acc)).toBe(false);
    }
  });
});

describe('§4.9 minimap', () => {
  test('§4.9 minimap visible iff the graph does not fit at the current zoom', () => {
    const small = contentBox(layoutDeck(tree(3)).nodes), big = contentBox(layoutDeck(tree(33)).nodes);
    expect(minimapVisible(small, fitViewport(small, W1280), W1280)).toBe(false);
    expect(minimapVisible(big, fitViewport(big, W1280), W1280)).toBe(true);
    // same small graph, PO zoomed in to 1.5 → no longer fits → minimap shows
    const vp = fitViewport(small, W1280);
    expect(minimapVisible(small, { ...vp, zoom: 1.5 }, W1280)).toBe(true);
    // PO panned the small graph half out of view → minimap shows
    expect(minimapVisible(small, { ...vp, x: vp.x + W1280.w / 2 }, W1280)).toBe(true);
    // top of the graph tucked under the 34 px header bar → part of it is not seen → minimap shows
    expect(minimapVisible(small, { ...vp, y: 20 - small.y * vp.zoom }, W1280)).toBe(true);
  });
});

describe('§4.9 edge markers', () => {
  const vp: Vp = { x: 0, y: 0, zoom: 1 };
  const s: Screen = { w: 800, h: 600 };
  const at = (id: string, x: number, y: number, kind: 'ask' | 'broken') => ({ id, rect: { x, y, w: 268, h: 64 }, kind });

  test('§4.9 counts per side ↑ ↓ ← → and first = first in tree order', () => {
    const m = edgeMarkers([
      at('lane:A', 100, -200, 'ask'), at('lane:B', 100, -100, 'broken'),
      at('lane:C', 100, 900, 'ask'), at('lane:D', 100, 1000, 'ask'), at('lane:E', 100, 1100, 'broken'),
      at('lane:F', -600, 200, 'broken'), at('lane:G', 900, 200, 'ask'),
      at('lane:H', 100, 200, 'ask'), // in view → no marker (v1.1 §4.5 kept: visible lane has no marker)
    ], vp, s);
    expect(m.up).toEqual({ ask: 1, broken: 1, first: 'lane:A' });
    expect(m.down).toEqual({ ask: 2, broken: 1, first: 'lane:C' });
    expect(m.left).toEqual({ ask: 0, broken: 1, first: 'lane:F' });
    expect(m.right).toEqual({ ask: 1, broken: 0, first: 'lane:G' });
  });

  test('§4.9 a node hidden under the header bar or the 44 px strip counts as off-screen', () => {
    const m = edgeMarkers([at('lane:A', 100, -10, 'ask'), at('lane:B', 100, 540, 'broken')], vp, s); // centres 22 (< 34, under the header) and 572 (> 556, in the strip)
    expect(m.up.ask).toBe(1);
    expect(m.down.broken).toBe(1);
  });

  test('§4.9 roots (orchestrator asking PO / stopped) count like lanes', () => {
    const m = edgeMarkers([{ id: 'orch:r2', rect: { x: 0, y: 2000, w: 216, h: 64 }, kind: 'broken' }], vp, s);
    expect(m.down).toEqual({ ask: 0, broken: 1, first: 'orch:r2' });
  });
});

describe('§4.9 glide + auto-fit', () => {
  test('§4.9 select lane → glide only as far as needed to bring it into view', () => {
    const s: Screen = { w: 800, h: 600 }, vp: Vp = { x: 0, y: 0, zoom: 1 };
    const inView = glideInto({ x: 100, y: 200, w: 268, h: 64 }, vp, s);
    expect(inView).toEqual(vp);
    const below = glideInto({ x: 100, y: 1000, w: 268, h: 64 }, vp, s), r = toScreen({ x: 100, y: 1000, w: 268, h: 64 }, below);
    expect(below.zoom).toBe(1);
    expect(r.y + r.h).toBeLessThanOrEqual(600 - 44);
    expect(r.y).toBeGreaterThan(300); // minimal move: the node lands near the bottom edge, not centred
    const above = toScreen({ x: 100, y: -500, w: 268, h: 64 }, glideInto({ x: 100, y: -500, w: 268, h: 64 }, vp, s));
    expect(above.y).toBeGreaterThanOrEqual(34);
    // taller than the seen area → its top edge comes into view (not its bottom)
    const tall = { x: 100, y: 2000, w: 268, h: 900 }, t = toScreen(tall, glideInto(tall, vp, s));
    expect(t.y).toBeGreaterThanOrEqual(34);
    expect(t.y).toBeLessThan(80);
  });

  test('§4.9 auto-fit suppressed within 30 s of a user pan / zoom (fake clock)', () => {
    let t = 1_000_000;
    expect(autoFitAllowed(null, t)).toBe(true);
    const moved = t;
    t += 1000;
    expect(autoFitAllowed(moved, t)).toBe(false);
    t = moved + USER_QUIET_MS - 1;
    expect(autoFitAllowed(moved, t)).toBe(false);
    t = moved + USER_QUIET_MS;
    expect(autoFitAllowed(moved, t)).toBe(true);
    expect(USER_QUIET_MS).toBe(30_000);
  });
  test('§4.9 shouldAutoFit: open always fits; a new lane / resize fits only outside the 30 s PO window', () => {
    const t = 1_000_000, s = { pid: 'p1', lanes: new Set(['lane:A']), w: 800, h: 600 };
    expect(shouldAutoFit(null, s, t - 1000, t)).toBe('open');
    expect(shouldAutoFit(s, { ...s, pid: 'p2' }, t - 1000, t)).toBe('open');
    expect(shouldAutoFit(s, { ...s }, null, t)).toBe(null);
    const grew = { ...s, lanes: new Set(['lane:A', 'lane:B']) }, resized = { ...s, w: 900 };
    for (const n of [grew, resized]) {
      expect(shouldAutoFit(s, n, null, t)).toBe('fit');
      expect(shouldAutoFit(s, n, t - 1000, t)).toBe(null);
      expect(shouldAutoFit(s, n, t - USER_QUIET_MS, t)).toBe('fit');
    }
    expect(shouldAutoFit(s, { ...s, lanes: new Set() }, null, t)).toBe(null);
  });
});

describe('§4.9 edge-marker inputs from the deck model', () => {
  test('§4.9 lanes Chờ PO / Hỏng are marked, done / running are not; a root asking the PO is marked', async () => {
    const { markedNodes } = await import('../../src/deck/flow/DeckViewport.tsx');
    const { buildFlow } = await import('../../src/deck/flow/model.ts');
    const { makeT } = await import('../../../shared/i18n/index.ts');
    const { lane: fl, snapshot, card } = await import('../fixtures.ts');
    const snap = snapshot({ lanes: [fl('A', { state: 'waiting_po' }), fl('B', { state: 'broken' }), fl('C'), fl('D', { state: 'done' })] });
    const m = buildFlow({ snap, projectId: 'p1', subagents: {}, selected: null, now: 0, tr: makeT('vi'), live: false, doneOpen: true });
    expect(markedNodes(m.nodes).map(x => [x.id, x.kind])).toEqual([['lane:A', 'ask'], ['lane:B', 'broken']]);
    const ask = snapshot({ cards: [card(1, { source: 'orchestrator' })], lanes: [] });
    const mo = buildFlow({ snap: ask, projectId: 'p1', subagents: {}, selected: null, now: 0, tr: makeT('vi'), live: false });
    expect(markedNodes(mo.nodes).map(x => [x.id, x.kind])).toEqual([['orch:p1', 'ask']]);
  });
});

describe('§4.15 §3 shelf "bấm để mở, khung lướt tới"', () => {
  test('12 lanes + 8 done, merged rows shown while the shelf is off-screen: the glide brings the whole open shelf into view', async () => {
    const { doneGlideBox } = await import('../../src/deck/flow/DeckViewport.tsx');
    const { buildFlow } = await import('../../src/deck/flow/model.ts');
    const { makeT } = await import('../../../shared/i18n/index.ts');
    const { lane: fl, snapshot } = await import('../fixtures.ts');
    const lanes = [...Array.from({ length: 12 }, (_, i) => fl(`L${i}`)), ...Array.from({ length: 8 }, (_, i) => fl(`D${i}`, { state: 'done' }))];
    const at = (doneOpen: boolean) => buildFlow({ snap: snapshot({ lanes }), projectId: 'p1', subagents: {}, selected: null, now: 0, tr: makeT('vi'), live: false, doneOpen });
    expect(doneGlideBox(at(false).nodes, false, false)).toBeNull(); // closed → no glide
    const closed = at(false), open = at(true), frame: Screen = { w: 1440 - 424, h: 900 - 56 };
    const vp = fitViewport(contentBox(closed.nodes), frame);
    const box = doneGlideBox(open.nodes, false, true)!;
    expect(doneGlideBox(open.nodes, true, true)).toBeNull(); // already open → no glide
    const shelf = open.nodes.find(n => n.id === 'done')!;
    expect(box).toEqual({ x: shelf.x, y: shelf.y, w: shelf.w, h: shelf.h });
    const g = toScreen(shelf, glideInto(box, { ...vp, y: vp.y - 600 }, frame)); // panned so the shelf is below the frame
    expect(g.y).toBeGreaterThanOrEqual(0);
    expect(g.y + g.h).toBeLessThanOrEqual(frame.h);
  });
  test('§4.9 selecting a done lane glides to the shelf when the lane is one of its rows; a hidden merged row → nothing', async () => {
    const { selectedBox } = await import('../../src/deck/flow/DeckViewport.tsx');
    const { buildFlow } = await import('../../src/deck/flow/model.ts');
    const { makeT } = await import('../../../shared/i18n/index.ts');
    const { lane: fl, snapshot } = await import('../fixtures.ts');
    const at = (doneOpen: boolean) => buildFlow({ snap: snapshot({ lanes: [fl('L0'), fl('D0', { state: 'done' })] }), projectId: 'p1', subagents: {}, selected: null, now: 0, tr: makeT('vi'), live: false, doneOpen });
    expect(selectedBox(at(true).nodes, 'D0')?.id).toBe('done');
    expect(selectedBox(at(true).nodes, 'L0')?.id).toBe('lane:L0');
    expect(selectedBox(at(false).nodes, 'D0')).toBeNull();
  });
});

describe('§4.9 / §4.14 edge markers across sessions', () => {
  test('§4.14 3 sessions: a root asking, a stopped root and a lane Chờ PO in another tree are all marked', async () => {
    const { markedNodes } = await import('../../src/deck/flow/DeckViewport.tsx');
    const { buildFlow } = await import('../../src/deck/flow/model.ts');
    const { makeT } = await import('../../../shared/i18n/index.ts');
    const { lane: fl, snapshot, card } = await import('../fixtures.ts');
    const o = (sessionId: string, seq: number, state: 'running' | 'stopped') => ({ projectId: 'p1', state, account: 'a@x', homeAccount: 'a@x', lastError: null,
      costUsd: 0, contextPct: 10, talkingTo: null, sessionId, seq });
    const snap = snapshot({ orchestrators: [o('s1', 1, 'running'), o('s2', 2, 'stopped'), o('s3', 3, 'running')],
      lanes: [fl('A', { ownerSession: 's1', ownerSeq: 1 }), fl('B', { state: 'waiting_po', ownerSession: 's2', ownerSeq: 2 })],
      cards: [card(1, { source: 'orchestrator', sessionId: 's3' })] });
    const m = buildFlow({ snap, projectId: 'p1', subagents: {}, selected: null, now: 0, tr: makeT('vi'), live: false });
    expect(markedNodes(m.nodes).map(x => [x.id, x.kind])).toEqual([['orch:s2', 'broken'], ['lane:B', 'ask'], ['orch:s3', 'ask']]);
  });
});
