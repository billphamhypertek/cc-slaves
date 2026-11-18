// v2.1 e2e helpers (spec §6): a real engine whose state.db is seeded before boot (e2e/v21-seed-db.ts) so 3 sessions ×
// 20 lanes and 41 done lanes exist in ~1 s, plus deck-reading helpers for the React Flow deck (web/src/deck/flow).
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { B2, E2eEngine, ORCH, PM, test, type EngineOpts } from './fixtures.ts';
import type { BranchState, SeedLane, V21Seed } from './v21-seed-db.ts';

export const PID = 'shop';
const SID = ['s1', 's2', 's3'] as const;

/** E2eEngine whose first start seeds state.db (the engine's own migrations, via bun) before the real boot. */
export class SeedEngine extends E2eEngine {
  private seeded = false;
  constructor(o: EngineOpts, private readonly build: (e: SeedEngine) => V21Seed) { super(o); }

  override async start(): Promise<void> {
    let resume: string | null = null;
    if (!this.seeded) {
      this.seeded = true;
      const s = this.build(this);
      resume = s.project.id;
      mkdirSync(s.project.path, { recursive: true });
      for (const l of s.lanes) if (!l.done) mkdirSync(l.cwd, { recursive: true });
      writeFileSync(this.file('v21-seed.json'), JSON.stringify(s));
      const r = spawnSync('bun', [resolve(import.meta.dirname, 'v21-seed-db.ts')], {
        env: { ...process.env, V21_SEED: this.file('v21-seed.json'), CC_SLAVES_HOME: join(this.dir, 'home'),
          CC_SLAVES_ACCOUNTS: join(this.dir, 'accts'), CLAUDE_HOME: join(this.dir, 'claude'), CLAUDE_JSON: join(this.dir, 'claude.json') },
        encoding: 'utf8',
      });
      if (r.status !== 0) throw new Error(`v21 seed failed: ${r.stderr}`);
    }
    await super.start();
    // hf1116: a boot holds the seeded sessions; the seed stands for a running app → "Tiếp tục" once, as the PO would
    if (resume !== null) await this.cmd({ cmd: 'project_resume', id: resume });
  }
}

export function useSeeded(o: EngineOpts, build: (e: SeedEngine) => V21Seed): SeedEngine {
  const e = new SeedEngine(o, build);
  test.beforeAll(async () => { test.setTimeout(90_000); await e.setup(); });
  test.afterAll(async () => { await e.teardown(); });
  return e;
}

const ACC = [ORCH, PM, B2] as const;
/** `perSession` live lanes in each of `sessions` running sessions (#seq0 A1…, then B1…, H1…), then `done` done lanes owned
 *  by the first session, newest first (D01 …): the first `unmerged` are unmerged, the next `unknown` unknown, the rest merged. */
export function scale(e: E2eEngine, o: { sessions: number; perSession: number; done: number; unmerged: number; unknown?: number; seq0?: number; titles?: (string | undefined)[] }): V21Seed {
  const letters = ['A', 'B', 'H'], seq0 = o.seq0 ?? 1, unknown = o.unknown ?? 0;
  const sessions = Array.from({ length: o.sessions }, (_, i) => ({ id: SID[i]!, seq: seq0 + i, account: ACC[i]!, ...(o.titles?.[i] ? { title: o.titles[i] } : {}) }));
  const lanes: SeedLane[] = [];
  sessions.forEach((s, i) => {
    for (let k = 1; k <= o.perSession; k++) {
      const name = `${letters[i]}${k}`;
      lanes.push({ name, owner: s.id, account: s.account, cwd: e.wt(name), task: `việc ${name}` });
    }
  });
  for (let k = 1; k <= o.done; k++) {
    const name = `D${String(k).padStart(2, '0')}`;
    const branch: BranchState = k <= o.unmerged ? 'unmerged' : k <= o.unmerged + unknown ? 'unknown' : 'merged';
    lanes.push({ name, owner: SID[0], account: ORCH, cwd: join(e.dir, 'done', name), task: `xong ${name}`, done: { agoMin: k * 30, branch } });
  }
  return { project: { id: PID, name: 'shop', path: e.repo('shop'), account: ORCH }, sessions, lanes };
}

/** §4.15 §4 a fake Tauri shell (before the app loads): records `invoke('notify', …)` like notify.rs and lets the test fire
 *  `open_latest_card` with the latest notification's target (the S5 focus fallback). */
export async function fakeTauri(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __TAURI__: unknown; __ccNotified: Record<string, unknown>[]; __ccOn: Record<string, (e: { payload: unknown }) => void> };
    w.__ccNotified = []; w.__ccOn = {};
    w.__TAURI__ = {
      core: { invoke: async (cmd: string, args?: Record<string, unknown>) => { if (cmd === 'notify' && args) w.__ccNotified.push(args); return null; } },
      event: { listen: async (name: string, cb: (e: { payload: unknown }) => void) => { w.__ccOn[name] = cb; return () => {}; } },
    };
  });
}
/** Notifications the app handed to the (fake) shell so far. */
export const notified = (page: Page) => page.evaluate(() => (window as unknown as { __ccNotified: { title: string; body: string; cardId: number | null; projectId?: string; lane?: string }[] }).__ccNotified);
/** The app regains focus after a notification: notify.rs emits `open_latest_card` with the latest target. */
export const focusAfterNotification = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __ccNotified: Record<string, unknown>[]; __ccOn: Record<string, (e: { payload: unknown }) => void> };
  const last = w.__ccNotified.at(-1) ?? null;
  w.__ccOn.open_latest_card?.({ payload: last ? { cardId: last.cardId ?? null, projectId: last.projectId ?? null, lane: last.lane ?? null } : null });
});

// ---------- deck readers ----------
/** A React Flow node by its id (`data-id`). */
export const node = (page: Page, id: string): Locator => page.locator(`.react-flow__node[data-id="${id}"]`);

/** Wait for the deck to draw and its fit to settle. */
export async function openApp(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.locator('.react-flow__node').first().waitFor({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
}

export interface Box { id: string; x: number; y: number; w: number; h: number }
/** Every drawn node's screen box (React Flow node wrappers). */
export function nodeBoxes(page: Page): Promise<Box[]> {
  return page.evaluate(() => [...document.querySelectorAll('.react-flow__node')].map(e => {
    const r = e.getBoundingClientRect();
    return { id: e.getAttribute('data-id') ?? '', x: r.x, y: r.y, w: r.width, h: r.height };
  }));
}
/** Pairs of overlapping boxes (0.5 px tolerance). */
export function overlaps(bs: Box[]): string[] {
  const E = 0.5, out: string[] = [];
  bs.forEach((a, i) => bs.forEach((b, j) => {
    if (j > i && a.x + E < b.x + b.w && b.x + E < a.x + a.w && a.y + E < b.y + b.h && b.y + E < a.y + a.h) out.push(`${a.id}×${b.id}`);
  }));
  return out;
}
