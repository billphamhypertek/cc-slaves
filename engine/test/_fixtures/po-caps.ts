// The PO's v1 caps table (§3.4 D12). It used to be DEFAULT_CAPS in config.ts; v2 §7.1 (G5) removed the hard-coded emails
// from the engine, so tests that exercise the D12 thresholds use this fixture instead.
import type { Caps } from '../../src/config.ts';

export const PO_CAPS: Readonly<Caps> = Object.freeze({
  default: { week: 98, five: 95 },
  'bo@example.org': { role: 'orchestrator', week: 99, five: 97 },
  'pm@example.net': { role: 'primary', week: 99 },
  'bo24990@example.com': { role: 'primary', week: 99 },
  'dev2609@example.com': { role: 'primary', week: 60, hard: true },
  'ba@example.net': { role: 'backup', week: 70, five: 95, hard: true },
});
