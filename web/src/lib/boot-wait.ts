// v2.7.1 §4.1 / §5 how long a session may stay `starting` before the UI says "vẫn đang chờ": step 2 of a start (SA3) and
// G2c a command (end, model change) sent to a session still booting. A leaf: the ModelMenu chunk reads it without lib/start.
import type { Tr } from '../../../shared/i18n/core.ts';

export const SLOW_BOOT_MS = 30_000;
/** §5 G2c the busy text of "Kết thúc phiên" / a model change sent to a session still `starting` (the ack waits the boot). */
export const bootWaitText = (tr: Tr, since: number, now: number): string =>
  tr(now - since > SLOW_BOOT_MS ? 'session.stStepBootSlow' : 'session.bootWait');
