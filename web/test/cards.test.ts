import { describe, expect, test } from 'bun:test';
import { ClickGuard, defaultFocus, isPending, keyAnswer, orderCards, orderedOptions, UndoQueue, visibleCards } from '../src/lib/cards.ts';
import { card } from './fixtures.ts';
import { makeT } from '../../shared/i18n/index.ts';
const VI = makeT('vi');

describe('G4 UX 5(b) the §5.2 new-entry card is not a Chờ PO item', () => {
  test('shared_cfg_new stays out of the inbox; the A9 shared_cfg card stays in', () => {
    const cards = [card(1, { kind: 'shared_cfg_new', projectId: null }), card(2, { kind: 'shared_cfg', projectId: null }), card(3, { projectId: 'p1' })];
    expect(visibleCards(cards, 'p1').map(c => c.id)).toEqual([2, 3]);
  });
});

describe('§6.0 U1 stable card order', () => {
  test('pending cards oldest first; new cards append to the bottom, never jump to the top', () => {
    const cards = [card(3, { createdAt: 300 }), card(1, { createdAt: 100 }), card(2, { createdAt: 200 })];
    expect(orderCards(cards).pending.map(c => c.id)).toEqual([1, 2, 3]);
    const more = [...cards, card(9, { createdAt: 900 })];
    expect(orderCards(more).pending.map(c => c.id)).toEqual([1, 2, 3, 9]);
  });

  test('§7.3 / §5.7-5 R-B19 superpowers_off + revert_conflict pinned on top (oldest first among them); the rest oldest-first', () => {
    const cards = [card(1, { createdAt: 100 }), card(2, { createdAt: 200, kind: 'revert_conflict' }), card(3, { createdAt: 300 }),
      card(4, { createdAt: 400, kind: 'superpowers_off' }), card(5, { createdAt: 150, kind: 'superpowers_off', status: 'answered', resolvedAt: 9 })];
    expect(orderCards(cards).pending.map(c => c.id)).toEqual([2, 4, 1, 3]);
    expect(orderCards(cards).resolved.map(c => c.id)).toEqual([5]);
  });

  test('resolved cards go below pending, most recently resolved first', () => {
    const cards = [
      card(1, { status: 'answered', resolvedAt: 10 }), card(2, { createdAt: 50 }), card(3, { status: 'expired', kind: 'permission', resolvedAt: 30 }),
    ];
    const o = orderCards(cards);
    expect(o.pending.map(c => c.id)).toEqual([2]);
    expect(o.resolved.map(c => c.id)).toEqual([3, 1]);
  });

  test('isPending: open cards of every kind except the new-entry question (it never sits in Chờ PO, so no badge counts it)', () => {
    expect(isPending(card(1, { kind: 'broken' }))).toBe(true);
    expect(isPending(card(1, { kind: 'shared_cfg_new', projectId: null }))).toBe(false);
    expect(isPending(card(1, { status: 'cancelled' }))).toBe(false);
  });

  test('visibleCards: current project + global system cards only', () => {
    const cards = [card(1), card(2, { projectId: 'p2' }), card(3, { projectId: null, kind: 'logged_out' })];
    expect(visibleCards(cards, 'p1').map(c => c.id)).toEqual([1, 3]);
  });

  test('default focus = top answerable pending card, skipping cards in undo and system cards', () => {
    const cards = [card(1, { kind: 'broken' }), card(2), card(3)];
    expect(defaultFocus(orderCards(cards).pending, new Set())).toBe(2);
    expect(defaultFocus(orderCards(cards).pending, new Set([2]))).toBe(3);
    expect(defaultFocus([], new Set())).toBeNull();
  });
});

describe('§6.4 F4 options and ⌥ keys', () => {
  test('recommended option is moved first', () => {
    const c = card(1, { options: [{ label: 'Gộp' }, { label: 'Tách' }, { label: 'Hoãn' }], recommended: 'Tách' });
    expect(orderedOptions(c).map(o => o.label)).toEqual(['Tách', 'Gộp', 'Hoãn']);
  });
  test('⌥n on an ask card picks the nth ordered option', () => {
    const c = card(1, { options: [{ label: 'Gộp' }, { label: 'Tách' }], recommended: 'Tách' });
    expect(keyAnswer(VI, c, 1)).toEqual({ label: 'Tách', answer: { option: 'Tách' } });
    expect(keyAnswer(VI, c, 2)).toEqual({ label: 'Gộp', answer: { option: 'Gộp' } });
    expect(keyAnswer(VI, c, 3)).toBeNull();
  });
  test('§6.15 U2 permission keys: ⌥1 allow, ⌥2 allow always (only if offered), ⌥3 deny', () => {
    const p = card(1, { kind: 'permission', options: undefined, canAllowAlways: false });
    expect(keyAnswer(VI, p, 1)).toEqual({ label: 'Cho phép', answer: { behavior: 'allow' } });
    expect(keyAnswer(VI, p, 2)).toBeNull();
    expect(keyAnswer(VI, { ...p, canAllowAlways: true }, 2)).toEqual({ label: 'Cho phép luôn trong phiên này', answer: { behavior: 'allow_always' } });
    expect(keyAnswer(VI, p, 3)).toEqual({ label: 'Từ chối', answer: { behavior: 'deny' } });
  });
});

function fakeClock() {
  let now = 0, nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id: unknown) => { timers.delete(id as number); },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (t.at <= now) { timers.delete(id); t.fn(); }
    },
  };
}

describe('§6.4 5 s undo window then card_answer', () => {
  test('answer is sent only after 5 s', () => {
    const clock = fakeClock();
    const sent: unknown[] = [];
    const q = new UndoQueue(a => { sent.push(a); }, clock);
    q.choose(7, 'Tách', { option: 'Tách' });
    expect(q.get(7)?.label).toBe('Tách');
    expect(q.remaining(7)).toBe(5);
    clock.advance(4999);
    expect(sent).toHaveLength(0);
    expect(q.remaining(7)).toBe(1);
    clock.advance(1);
    expect(sent).toEqual([{ id: 7, answer: { option: 'Tách' } }]);
    expect(q.get(7)).toBeUndefined();
  });

  test('undo inside the window cancels the send', () => {
    const clock = fakeClock();
    const sent: unknown[] = [];
    const q = new UndoQueue(a => { sent.push(a); }, clock);
    q.choose(7, 'Tách', { option: 'Tách' });
    clock.advance(3000);
    q.undo(7);
    clock.advance(5000);
    expect(sent).toHaveLength(0);
  });

  test('choosing again restarts the window with the new answer', () => {
    const clock = fakeClock();
    const sent: unknown[] = [];
    const q = new UndoQueue(a => { sent.push(a); }, clock);
    q.choose(7, 'Tách', { option: 'Tách' });
    clock.advance(3000);
    q.choose(7, 'Gộp', { option: 'Gộp' });
    clock.advance(3000);
    expect(sent).toHaveLength(0);
    clock.advance(2000);
    expect(sent).toEqual([{ id: 7, answer: { option: 'Gộp' } }]);
  });

  test('listeners are notified on choose / undo / send', () => {
    const clock = fakeClock();
    const q = new UndoQueue(() => {}, clock);
    let n = 0;
    q.subscribe(() => n++);
    q.choose(1, 'a', { option: 'a' });
    q.undo(1);
    q.choose(1, 'a', { option: 'a' });
    clock.advance(5000);
    expect(n).toBe(4);
  });
});

describe('§6.0 U1 1 s click guard after layout shift', () => {
  test('clicks within 1 s of a shift are ignored', () => {
    let now = 10_000;
    const g = new ClickGuard(() => now);
    expect(g.allow()).toBe(true);
    g.shifted();
    now += 999;
    expect(g.allow()).toBe(false);
    now += 1;
    expect(g.allow()).toBe(true);
  });
});
