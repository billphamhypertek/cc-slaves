// v1.1 idle policy (spec G4, §5.3; v1 §8.4), kept as the single motion gate of the v2.1 deck (§5.2).
// `motionPolicy` is pure: paused = no running animation on the deck. `useMotion` feeds it from the window.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LaneState, OrchestratorState } from '../../../shared/protocol.ts';
import { laneRunning, orchRunning } from '../lib/labels.ts';
import { useReducedOS } from '../lib/reduced-motion.ts';

export const IDLE_MS = 60_000;
/** §4.1 node move on relayout; §4.10 reduced motion → state change by a 100 ms fade. */

export interface MotionEnv {
  focused: boolean; visible: boolean; idleMs: number;
  /** a lane or the orchestrator is in an animated state (deckAnimated). */
  animated: boolean;
  reducedOS: boolean; reducedSetting: boolean; lowBattery: boolean; connected: boolean;
}
type PauseWhy = 'blur' | 'hidden' | 'idle' | 'nothing' | 'reduced' | 'battery' | 'offline';
/** slide = 300 ms node move; fade = reduced motion, 100 ms opacity; none = instant. */
type Transition = 'slide' | 'fade' | 'none';
export interface Motion {
  paused: boolean; reduced: boolean; transition: Transition;
  /** v1 §8.4 HUD loops (`.still`). v2.1 §6 wins over v1.1 G4: every pause reason counts, a calm deck and offline included. */
  still: boolean;
  why: PauseWhy[];
}

export function motionPolicy(e: MotionEnv): Motion {
  const reduced = e.reducedOS || e.reducedSetting;
  const why: PauseWhy[] = [];
  if (!e.focused) why.push('blur');
  if (!e.visible) why.push('hidden');
  if (e.idleMs >= IDLE_MS) why.push('idle');
  if (!e.animated) why.push('nothing');
  if (reduced) why.push('reduced');
  if (e.lowBattery) why.push('battery');
  if (!e.connected) why.push('offline');
  const transition: Transition = !e.focused || !e.visible || e.lowBattery || !e.connected ? 'none' : reduced ? 'fade' : 'slide';
  const paused = why.length > 0;
  return { paused, reduced, transition, still: paused, why };
}

/** The deck root classes: `paused` / `reduced` kill the loops, `fade` = §4.10 reduced motion state change (100 ms opacity),
 *  `instant` = no node move, `offline`. `paused` may be forced (F9 overlay) on top of the motion gate. */
export const deckClass = (m: Motion, connected: boolean, paused = m.paused): string =>
  ['map', 'deck', paused ? 'paused' : '', m.reduced ? 'reduced' : '', m.transition === 'fade' ? 'fade' : '', m.transition === 'none' ? 'instant' : '',
    !connected ? 'offline' : ''].filter(Boolean).join(' ');

export const isLowBattery = (b: { charging: boolean; level: number }) => !b.charging && b.level < 0.2;

/** G4: "để yên" when no lane / orchestrator is running (v1 laneRunning / orchRunning, + switching). An idle orchestrator
 *  and a Chờ PO lane stand still (hf1117-p4: only running states spin; Chờ PO pulses), neither keeps the deck awake. */
export function deckAnimated(lanes: readonly LaneState[], orch: OrchestratorState | null): boolean {
  return lanes.some(laneRunning) || (!!orch && (orchRunning(orch) || orch === 'switching'));
}

// ---------- the hooks ----------

type Battery = EventTarget & { charging: boolean; level: number };
/** Window → MotionEnv: focus, visibility (+ the Tauri window-hidden / window-shown events), 60 s input timer,
 *  OS reduced motion (`useReducedOS`), battery (navigator.getBattery, where it exists). */
export function useMotion(o: { animated: boolean; reducedSetting: boolean; connected: boolean }): Motion {
  const reducedOS = useReducedOS();
  const [env, setEnv] = useState(() => ({
    focused: typeof document === 'undefined' || document.hasFocus(), visible: typeof document === 'undefined' || document.visibilityState !== 'hidden',
    idle: false, lowBattery: false, appHidden: false,
  }));
  const idleRef = useRef(false);
  useEffect(() => {
    const set = (p: Partial<typeof env>) => setEnv(e => (Object.entries(p).every(([k, v]) => e[k as keyof typeof e] === v) ? e : { ...e, ...p }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => { idleRef.current = true; set({ idle: true }); }, IDLE_MS); };
    const input = () => { if (idleRef.current) { idleRef.current = false; set({ idle: false }); } arm(); };
    const focus = (e?: Event) => set({ focused: e ? e.type === 'focus' : document.hasFocus() }), vis = () => set({ visible: document.visibilityState !== 'hidden' });
    const hid = () => set({ appHidden: true }), shown = () => set({ appHidden: false });
    const evs = ['pointermove', 'pointerdown', 'keydown', 'wheel'] as const;
    for (const ev of evs) window.addEventListener(ev, input, { passive: true, capture: true });
    window.addEventListener('focus', focus); window.addEventListener('blur', focus);
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('window-hidden', hid); window.addEventListener('window-shown', shown);
    let bt: Battery | null = null, live = true;
    const bf = () => { if (bt) set({ lowBattery: isLowBattery(bt) }); };
    (navigator as Navigator & { getBattery?: () => Promise<Battery> }).getBattery?.().then(b => {
      if (!live) return;
      bt = b; b.addEventListener('levelchange', bf); b.addEventListener('chargingchange', bf); bf();
    }).catch(() => {});
    arm(); focus(); vis();
    return () => {
      live = false; clearTimeout(timer);
      for (const ev of evs) window.removeEventListener(ev, input, { capture: true });
      window.removeEventListener('focus', focus); window.removeEventListener('blur', focus);
      document.removeEventListener('visibilitychange', vis);
      window.removeEventListener('window-hidden', hid); window.removeEventListener('window-shown', shown);
      if (bt) { bt.removeEventListener('levelchange', bf); bt.removeEventListener('chargingchange', bf); }
    };
  }, []);
  return useMemo(() => motionPolicy({
    focused: env.focused, visible: env.visible && !env.appHidden, idleMs: env.idle ? IDLE_MS : 0, animated: o.animated,
    reducedOS, reducedSetting: o.reducedSetting, lowBattery: env.lowBattery, connected: o.connected,
  }), [env, reducedOS, o.animated, o.reducedSetting, o.connected]);
}
