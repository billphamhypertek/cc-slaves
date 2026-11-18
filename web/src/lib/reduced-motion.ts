// The single source of the OS reduced-motion preference (coding-standard §4 "Animate or not"): the deck's `useMotion`
// (deck/motion.ts) and the shell (body class, the §14.5 stream reveal via `Store.setReducedOS`) both read this hook.
// In lib/ because first-paint code never imports a deck value (L3).
import { useEffect, useState } from 'react';

const REDUCED_Q = '(prefers-reduced-motion: reduce)';

/** A media query, live (also R43 I3 the short left column, lib/inspector.ts SHORT_Q). */
export function useMedia(q: string): boolean {
  const [on, setOn] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(q).matches);
  useEffect(() => {
    const mq = matchMedia(q), rm = () => setOn(mq.matches);
    rm();
    mq.addEventListener('change', rm);
    return () => mq.removeEventListener('change', rm);
  }, [q]);
  return on;
}

/** macOS "Reduce motion", live. */
export const useReducedOS = (): boolean => useMedia(REDUCED_Q);
