// The in-app chime (spec §8.3): the engine decides which notifications sound (route × Cài đặt › Thông báo "Trong app" ×
// `config.sound`) and sends `notify.sound`; this plays it at `config.volume` unless the top-bar mute is on.
import type { ServerMsg } from '../../../shared/protocol.ts';
import { chimeGain } from '../../../shared/notify-prefs.ts';

/** Gain for this message, or null when it should not sound. */
export function chimeFor(m: ServerMsg, config: Record<string, unknown> | undefined, muted: boolean): number | null {
  if (muted || m.type !== 'event' || m.event.type !== 'notify' || !m.event.sound) return null;
  const g = chimeGain(config?.volume);
  return g > 0 ? g : null;
}

export function beep(gain: number): void {
  try {
    const ctx = new AudioContext(), o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 880; g.gain.setValueAtTime(gain, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.25);
  } catch { /* no audio */ }
}
