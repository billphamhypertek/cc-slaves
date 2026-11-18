// v2.4 shots (e2e/specs/v24-shots.spec.ts): the page ↔ dev-mock socket wired through `page.routeWebSocket` so a frame can
// patch what the mock engine does not carry — the orchestrator's session number (MD10's "chạy cạnh #2"), and a dropped
// connection that refuses to come back (MD13 offline). The model data itself comes from the mock's `?md=<frame>` scene
// (web/dev/mock-model.ts). DK frames feed the composer through e2e/v24-attach-io.ts instead.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { ServerMsg, Snapshot } from '../shared/protocol.ts';

export interface Wire {
  /** edit the snapshot the page gets */
  snap?: (s: Snapshot) => void;
}
export interface WireCtl { drop(): void }

/** The deck Điều phối's session number: MD10 "chạy cạnh #2" (n = 2); MD11 / MD12 view the mock's ended "#2 · lot-2", so the
 *  live one is #3 there (the mock's "D9 → #3"). */
export const orchSeq = (n: number) => (s: Snapshot): void => { if (s.orchestrators[0]) s.orchestrators[0].seq = n; };

/** Route the page's engine socket through `w`. */
export async function wire(page: Page, w: Wire): Promise<WireCtl> {
  let live: { close(): void } | null = null;
  let down = false;
  await page.routeWebSocket(/\/ws\?/, (ws) => {
    if (down) { void ws.close(); return; }
    live = ws;
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      const msg = JSON.parse(String(m)) as ServerMsg;
      if (msg.type === 'snapshot') w.snap?.(msg.snapshot);
      ws.send(JSON.stringify(msg));
    });
  });
  return { drop: () => { down = true; live?.close(); } };
}

const DIR = join(import.meta.dirname, '../docs/specs/assets/screens');
/** The one path every v2.4 frame shot takes (v24-shots, v24-scrollbars): docs/specs/assets/screens/v24-<frame>.png, after the
 *  page settles `settle` ms (fades, tooltips; SB frames shoot at once, before the bar's 800 ms fade). */
export async function shotV24(page: Page, frame: string, settle = 400): Promise<void> {
  if (settle) await page.waitForTimeout(settle);
  mkdirSync(DIR, { recursive: true });
  await page.screenshot({ path: join(DIR, `v24-${frame}.png`) });
}
