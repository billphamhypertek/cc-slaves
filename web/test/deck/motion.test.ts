// v1.1 idle policy (spec G4, §5.3; v1 §8.4), the single motion gate of the v2.1 deck (§5.2).
import { describe, expect, test } from 'bun:test';
import { deckAnimated, IDLE_MS, isLowBattery, motionPolicy, type MotionEnv } from '../../src/deck/motion.ts';
import { scene } from './scene.ts';

const ENV: MotionEnv = { focused: true, visible: true, idleMs: 0, animated: true, reducedOS: false, reducedSetting: false, lowBattery: false, connected: true };

describe('motionPolicy', () => {
  test('G4 all clear + a running lane → animate, transitions slide', () => {
    const m = motionPolicy(ENV);
    expect(m.paused).toBe(false);
    expect(m.transition).toBe('slide');
    expect(m.why).toEqual([]);
  });
  const cases: [string, Partial<MotionEnv>, string][] = [
    ['G4 window blurred', { focused: false }, 'blur'],
    ['G4 document hidden', { visible: false }, 'hidden'],
    ['G4 60 s without input', { idleMs: IDLE_MS }, 'idle'],
    ['G4 no lane / orchestrator animated', { animated: false }, 'nothing'],
    ['§4.3 OS prefers-reduced-motion', { reducedOS: true }, 'reduced'],
    ['§4.3 app reducedMotion toggle', { reducedSetting: true }, 'reduced'],
    ['§5.3 battery < 20 %', { lowBattery: true }, 'battery'],
    ['§4.6 disconnected', { connected: false }, 'offline'],
  ];
  for (const [name, patch, why] of cases) test(`${name} → paused`, () => {
    const m = motionPolicy({ ...ENV, ...patch });
    expect(m.paused).toBe(true);
    expect(m.why).toEqual([why as never]);
  });
  test('G4 59.9 s without input still animates', () => expect(motionPolicy({ ...ENV, idleMs: IDLE_MS - 100 }).paused).toBe(false));
  test('§4.3 reduced motion → no spin, state changes as 100 ms fades', () => {
    const m = motionPolicy({ ...ENV, reducedSetting: true });
    expect(m.reduced).toBe(true);
    expect(m.transition).toBe('fade');
  });
  test('§4.3 blurred / hidden / battery / offline → transitions instant; idle and nothing-animated keep them', () => {
    for (const p of [{ focused: false }, { visible: false }, { lowBattery: true }, { connected: false }]) expect(motionPolicy({ ...ENV, ...p }).transition).toBe('none');
    expect(motionPolicy({ ...ENV, idleMs: IDLE_MS }).transition).toBe('slide');
    expect(motionPolicy({ ...ENV, animated: false }).transition).toBe('slide');
  });
  test('§6 HUD loops (.still) pause whenever the deck pauses — a calm deck and offline included (v2.1 §6 over v1.1 G4)', () => {
    expect(motionPolicy({ ...ENV, animated: false }).still).toBe(true);
    expect(motionPolicy({ ...ENV, connected: false }).still).toBe(true);
    for (const p of [{ focused: false }, { visible: false }, { idleMs: IDLE_MS }, { lowBattery: true }, { reducedOS: true }]) expect(motionPolicy({ ...ENV, ...p }).still).toBe(true);
    expect(motionPolicy(ENV).still).toBe(false);
  });
  test('§5.3 battery < 20 % only when not charging', () => {
    expect(isLowBattery({ charging: false, level: 0.19 })).toBe(true);
    expect(isLowBattery({ charging: false, level: 0.2 })).toBe(false);
    expect(isLowBattery({ charging: true, level: 0.05 })).toBe(false);
  });
});

describe('deckAnimated', () => {
  test('G4 a running lane animates the deck', () => { const s = scene(5); expect(deckAnimated(s.lanes.map(l => l.state), s.orchestrators[0]!.state)).toBe(true); });
  test('G4 lanes stopped / Chờ anh / hỏng and the orchestrator idle → nothing running → calm', () => {
    const snap = scene(5);
    snap.lanes.forEach((l, i) => { l.state = (['stopped', 'waiting_po', 'broken', 'idle', 'done'] as const)[i % 5]!; });
    for (const o of snap.orchestrators) { o.state = 'idle'; o.talkingTo = null; }
    expect(deckAnimated(snap.lanes.map(l => l.state), snap.orchestrators[0]!.state)).toBe(false);
  });
  test('G4 only the orchestrator running → animated', () => {
    const snap = scene(5);
    for (const l of snap.lanes) l.state = 'stopped';
    for (const o of snap.orchestrators) o.state = 'running';
    expect(deckAnimated(snap.lanes.map(l => l.state), snap.orchestrators[0]!.state)).toBe(true);
  });
});

