// E2E fixture (spec §10): one real engine process per spec file (`useEngine` → beforeAll/afterAll), temp CC_SLAVES_HOME /
// CC_SLAVES_ACCOUNTS / CLAUDE_HOME / CLAUDE_JSON, accounts seeded into the v2 registry by e2e/engine-entry.ts
// (accounts-seed.json), fake-claude as `claude`, fake Keychain + usage source (e2e/engine-entry.ts),
// random free port. Runs under Node (Playwright): never imports engine code that needs bun:sqlite.
import { test as base, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Command, ServerMsg, Snapshot } from '../shared/protocol.ts';

export { expect };
/** The Deck mode tab (v2.7 §4.1: Tasks `T` · Deck `D` · Code `C` · Git `G`). */
export const deckTab = (page: Page) => page.locator('.dhead [role=tab]', { hasText: 'Deck' });
/** v2.7 §4.1 D91 every project opens in Tasks. Specs written for the Deck get it back through a locator handler (the Deck tab
 *  is clicked whenever the Tasks root shows before a locator action); `test.use({ tasksStart: true })` keeps Tasks.
 *  v2.8 §5.1 the app opens light when `ccs.theme` is empty (PO 17/11 21:55); the specs and their shots were written dark, so
 *  `theme` seeds the stored mode when the page has none (`test.use({ theme: 'light' })`; `null` = leave the store empty). */
export const test = base.extend<{ tasksStart: boolean; theme: 'light' | 'dark' | 'system' | null }>({
  tasksStart: [false, { option: true }],
  theme: ['dark', { option: true }],
  page: async ({ page, tasksStart, theme }, use) => {
    if (theme) await page.addInitScript(m => { if (localStorage.getItem('ccs.theme') === null) localStorage.setItem('ccs.theme', m); }, theme);
    if (!tasksStart) {
      await page.addLocatorHandler(page.locator('#tasks'), async () => {
        await deckTab(page).click();
      });
    }
    await use(page);
  },
});
const ROOT = resolve(import.meta.dirname, '..');

type Step = Record<string, unknown>;
/** `control`: v2.4 fake-claude control replies (fake-claude/src/control.ts: models, sources, startModel, fail, delayMs …). */
export interface Scenario { replay?: 'immediate' | 'manual'; init?: false | Record<string, unknown>; control?: Record<string, unknown>; steps: Step[] }
export type Usage = Record<string, { fivePct: number | null; weekPct: number | null; fiveResetsAt?: number; weekResetsAt?: number }>;

// ---------- scenario helpers (stream-json lines fake-claude emits) ----------
export const S = {
  assistant: (text: string): Step => ({ emit: { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', model: 'claude-fake', content: [{ type: 'text', text }] } } }),
  /** v2.2 §3-15 a reply still streaming: real-shape stream_events of one open text block (fake-claude `stream`). */
  partial: (text: string): Step => ({ stream: { blocks: [{ text }], open: true } }),
  result: (text = 'ok', cost = 0.01): Step => ({ emit: { type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, total_cost_usd: cost, permission_denials: [] } }),
  wait: { waitUser: true } as Step,
  sleep: (ms: number): Step => ({ sleep: ms }),
  mcp: (tool: string, args: Record<string, unknown>): Step => ({ mcp: { tool, args } }),
  /** waitUser → assistant text → result */
  turn: (text: string): Step[] => [{ waitUser: true }, { emit: { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', model: 'claude-fake', content: [{ type: 'text', text }] } } }, { emit: { type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, total_cost_usd: 0.01, permission_denials: [] } }],
  /** n quiet turns (answers any message) */
  idle: (n = 20): Step[] => Array.from({ length: n }, (_, i) => S.turn(`ok ${i + 1}`)).flat(),
  /** Orchestrator turn: on the PO message "mở <name>" (openLane) call lane_start; other messages get a quick result. */
  startLane: (e: { wt(n: string): string }, name: string): Step[] => [
    { waitUser: `mở ${name}` }, { mcp: { tool: 'lane_start', args: { name, cwd: e.wt(name), brief_path: `/briefs/${name}.md` } } },
    { emit: { type: 'result', subtype: 'success', is_error: false, result: `đã mở ${name}`, num_turns: 1, total_cost_usd: 0.01, permission_denials: [] } },
  ],
  /** rate_limit_event (§3.3) with per-window utilization 0–1. */
  rateLimit: (window: 'five_hour' | 'seven_day', utilization: number): Step => {
    const r = Math.floor(Date.now() / 1000);
    return { emit: { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: r + 3 * 3600, unifiedWindows: {
      five_hour: { utilization: window === 'five_hour' ? utilization : 0.1, resetsAt: r + 3 * 3600 },
      seven_day: { utilization: window === 'seven_day' ? utilization : 0.1, resetsAt: r + 3 * 86_400 },
    } } } };
  },
};

export const ORCH = 'orch@x.test';
/** v2.7 §7.3: lane_start is refused unless `<CLAUDE_HOME>/settings.json` enables a `superpowers@…` plugin; every e2e home has it
 * (enabled, not installed: the Skills & MCP catalog lists installed plugins only). A spec that rewrites settings.json spreads it. */
export const SUPERPOWERS = { 'superpowers@claude-plugins-official': true } as const;
export const PM = 'pm@x.test';
export const B2 = 'b2@x.test';

export interface EngineOpts {
  /** Registry accounts (default: ORCH orchestrator, PM primary, B2 backup). */
  accounts?: string[];
  caps?: Record<string, unknown>;
  /** Scenario per account email, or 'default' (a function gets the engine: paths like `e.wt('D2')`). */
  scenarios?: Record<string, Scenario> | ((e: E2eEngine) => Record<string, Scenario>);
  usage?: Usage;
  /** Fresh quota rows at boot (default: every account at 10 %). */
  seed?: Usage;
  /** Git repos to create under the temp dir (name → path in `repo(name)`). */
  repos?: string[];
  /** Engine config.json overrides. */
  config?: Record<string, unknown>;
  poEmail?: boolean;
  /** Extra env for the engine process (e.g. E2E_PERMISSION_TTL_MS). */
  env?: Record<string, string>;
}

const freePort = () => new Promise<number>((res, rej) => {
  const s = createServer();
  s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
});

export class E2eEngine {
  dir = '';
  port = 0;
  proc: ChildProcess | null = null;
  /** resolves on the process `close` (exited AND its stderr drained: no `stderr.log` write can follow) */
  private closed: Promise<unknown> = Promise.resolve();
  constructor(readonly o: EngineOpts) {}

  get token(): string { return readFileSync(join(this.dir, 'token'), 'utf8'); }
  url(path = '/'): string { return `http://127.0.0.1:${this.port}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(this.token)}`; }
  repo(name: string): string { return join(this.dir, 'repos', name); }
  /** A lane worktree path (created by `openLane`). */
  wt(lane: string): string { return join(this.dir, 'wt', lane); }
  file(name: string): string { return join(this.dir, name); }
  read(name: string): string { try { return readFileSync(this.file(name), 'utf8'); } catch { return ''; } }
  /** hf1117-perf every later `claude` spawn boots this slowly (a real one runs the PO's SessionStart hooks); 0 = instant. */
  slowBoot(ms: number): void { if (ms > 0) writeFileSync(this.file('boot-ms'), String(ms)); else rmSync(this.file('boot-ms'), { force: true }); }

  async setup(): Promise<void> {
    this.dir = mkdtempSync(join(tmpdir(), 'ccs-e2e-'));
    this.port = await freePort();
    const accounts = this.o.accounts ?? [ORCH, PM, B2];
    // v2 §7: engine-entry.ts seeds these into the account registry (Node here cannot open state.db)
    writeFileSync(join(this.dir, 'accounts-seed.json'), JSON.stringify({ emails: accounts, tier: 'default_claude_max_20x' }));
    const home = join(this.dir, 'home');
    mkdirSync(home, { recursive: true });
    mkdirSync(join(this.dir, 'claude'), { recursive: true });
    writeFileSync(join(this.dir, 'claude', 'settings.json'), JSON.stringify({ enabledPlugins: SUPERPOWERS }));
    const caps = this.o.caps ?? {
      default: { week: 98, five: 95 }, [ORCH]: { role: 'orchestrator', week: 99, five: 97 }, [PM]: { role: 'primary', week: 99 }, [B2]: { role: 'backup', week: 98 },
    };
    writeFileSync(join(home, 'caps.json'), JSON.stringify(caps));
    if (this.o.config) writeFileSync(join(home, 'config.json'), JSON.stringify(this.o.config));
    mkdirSync(join(this.dir, 'scn'), { recursive: true });
    this.scenario('default', { steps: S.idle() });
    const scn = typeof this.o.scenarios === 'function' ? this.o.scenarios(this) : this.o.scenarios ?? {};
    for (const [k, s] of Object.entries(scn)) this.scenario(k, s);
    const seed = this.o.seed ?? Object.fromEntries(accounts.map((a) => [a, { fivePct: 10, weekPct: 10 }]));
    writeFileSync(join(this.dir, 'quota-seed.json'), JSON.stringify(seed));
    if (this.o.usage) this.usage(this.o.usage);
    for (const r of this.o.repos ?? []) mkdirSync(join(this.repo(r), '.git'), { recursive: true });
    await this.start();
    if (this.o.poEmail !== false) await this.cmd({ cmd: 'caps_update', caps: caps as never, poEmail: PM });
  }

  scenario(key: string, s: Scenario): void { writeFileSync(join(this.dir, 'scn', `${key}.json`), JSON.stringify(s)); }
  usage(u: Usage): void { writeFileSync(join(this.dir, 'usage.json'), JSON.stringify(u)); }

  async start(): Promise<void> {
    rmSync(join(this.dir, 'token'), { force: true });
    const env = {
      ...process.env, E2E_DIR: this.dir, CC_SLAVES_PORT: String(this.port),
      CC_SLAVES_HOME: join(this.dir, 'home'), CC_SLAVES_ACCOUNTS: join(this.dir, 'accts'), CLAUDE_HOME: join(this.dir, 'claude'),
      CC_SLAVES_ATTACH: join(this.dir, 'attach'), // v2.4 §10.2 A11: outside home; the boot sweep never sees the real folder
      CLAUDE_JSON: join(this.dir, 'claude.json'), CC_SLAVES_LAUNCHD_LABEL: '', ...(this.o.env ?? {}),
    };
    const p = spawn('bun', [join(ROOT, 'e2e/engine-entry.ts')], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr?.on('data', (d: Buffer) => { err += d.toString(); writeFileSync(join(this.dir, 'stderr.log'), d, { flag: 'a' }); });
    p.on('exit', (code, sig) => writeFileSync(join(this.dir, 'stderr.log'), `[exit ${code} ${sig}]\n`, { flag: 'a' }));
    this.proc = p;
    this.closed = new Promise((r) => p.once('close', r));
    const end = Date.now() + 20_000;
    for (;;) {
      if (p.exitCode !== null) throw new Error(`engine exited ${p.exitCode}: ${err}`);
      if (existsSync(join(this.dir, 'token'))) {
        const ok = await fetch(`http://127.0.0.1:${this.port}/healthz`).then((r) => r.ok).catch(() => false);
        if (ok) return;
      }
      if (Date.now() > end) throw new Error(`engine did not come up: ${err}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** F10: the engine process dies (SIGKILL — no graceful stop). */
  async kill(): Promise<void> {
    const p = this.proc;
    if (!p) return;
    if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
    await this.closed;
    this.proc = null;
  }

  /** SIGTERM, SIGKILL after 5 s; always waits for `close`, so teardown never removes the dir under a late write. */
  async stop(): Promise<void> {
    const p = this.proc;
    if (p && p.exitCode === null && p.signalCode === null) {
      p.kill('SIGTERM');
      await Promise.race([this.closed, new Promise((r) => setTimeout(r, 5000))]);
      if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
    }
    await this.closed;
    this.proc = null;
  }

  async health(): Promise<{ lanes: { name: string; state: string; phase: string | null }[]; openCards: number; version: string }> {
    return (await fetch(`http://127.0.0.1:${this.port}/healthz`)).json() as never;
  }

  /** One command over a fresh WS (same Origin as the page). Rejects on `error`. */
  async cmd(command: Command): Promise<unknown> {
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws?token=${encodeURIComponent(this.token)}`, { headers: { origin: `http://127.0.0.1:${this.port}` } } as never);
    try {
      return await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error(`timeout: ${command.cmd}`)), 15_000);
        ws.onerror = () => { clearTimeout(t); rej(new Error('ws error')); };
        ws.onmessage = (m) => {
          const msg = JSON.parse(String(m.data)) as ServerMsg;
          if (msg.type === 'snapshot') ws.send(JSON.stringify({ type: 'command', id: 'e2e', command }));
          else if ((msg.type === 'ack' || msg.type === 'error') && msg.id === 'e2e') {
            clearTimeout(t);
            if (msg.type === 'ack') res(msg.result); else rej(new Error(`${msg.code}: ${msg.message}`));
          }
        };
      });
    } finally { ws.close(); }
  }

  async snapshot(): Promise<Snapshot> {
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws?token=${encodeURIComponent(this.token)}`, { headers: { origin: `http://127.0.0.1:${this.port}` } } as never);
    try {
      return await new Promise((res, rej) => {
        ws.onerror = () => rej(new Error('ws error'));
        ws.onmessage = (m) => { const msg = JSON.parse(String(m.data)) as ServerMsg; if (msg.type === 'snapshot') res(msg.snapshot); };
      });
    } finally { ws.close(); }
  }

  /** Add a project over WS, start it ("Bắt đầu": hf1116 H2 an added project waits) and wait for its orchestrator idle. */
  async addProject(name: string): Promise<string> {
    if (!existsSync(this.repo(name))) mkdirSync(join(this.repo(name), '.git'), { recursive: true });
    const r = (await this.cmd({ cmd: 'project_add', name, path: this.repo(name) })) as { id: string };
    await this.cmd({ cmd: 'project_resume', id: r.id });
    await expect.poll(async () => (await this.snapshot()).orchestrators.find((o) => o.projectId === r.id)?.state, { timeout: 20_000 }).toBe('idle');
    return r.id;
  }

  /** Ask the orchestrator to open a lane (its scenario must answer with `S.startLane`); waits until the lane exists. */
  async openLane(projectId: string, name: string, state = 'idle'): Promise<void> {
    mkdirSync(this.wt(name), { recursive: true });
    await this.cmd({ cmd: 'send', target: { kind: 'orchestrator', projectId }, text: `mở ${name}` });
    await expect.poll(async () => (await this.health()).lanes.find((l) => l.name === name)?.state, { timeout: 20_000 }).toBe(state);
  }

  async teardown(): Promise<void> {
    await this.stop();
    if (process.env.E2E_KEEP !== '1') rmSync(this.dir, { recursive: true, force: true });
  }
}

/** One engine for the whole spec file. */
export function useEngine(o: EngineOpts = {}): E2eEngine {
  const e = new E2eEngine(o);
  test.beforeAll(async () => { await e.setup(); });
  test.afterAll(async () => { await e.teardown(); });
  return e;
}

/** The inbox ignores clicks for 1 s after its list shifts (ClickGuard, misclick protection): wait it out. */
export const settle = (page: Page) => page.waitForTimeout(1100);

/**
 * hf1117-perf ms from `act` (its click's pointerdown, else its start) until each condition (a page JS expression) first
 * holds, polled every frame; a condition that never holds rejects after 10 s.
 */
export async function msUntil(page: Page, act: () => Promise<unknown>, conds: Record<string, string>): Promise<Record<string, number>> {
  await page.evaluate(() => { // from the click's pointerdown when `act` clicks (Playwright's own wait for the target is not counted)
    const w = window as unknown as { __t0: number };
    w.__t0 = performance.now();
    document.addEventListener('pointerdown', () => { w.__t0 = performance.now(); }, { capture: true, once: true });
  });
  const waits = Object.entries(conds).map(([k, js]) => page.waitForFunction(`(${js}) ? Math.max(0.1, performance.now() - window.__t0) : false`,
    undefined, { polling: 'raf', timeout: 10_000 }).then(async (h) => [k, (await h.jsonValue()) as number] as const));
  await act();
  return Object.fromEntries(await Promise.all(waits));
}

/** Counts real clicks for the §4.3 step budgets (page.click through this helper). */
export class Clicks {
  n = 0;
  constructor(private readonly page: Page) {}
  async on(selector: string | ReturnType<Page['locator']>): Promise<void> {
    this.n++;
    await (typeof selector === 'string' ? this.page.locator(selector) : selector).click();
  }
}

/** Record a measured click budget to .e2e-results/budgets.jsonl (report ①). */
export function recordBudget(task: string, clicks: number, target: number): void {
  mkdirSync(join(ROOT, '.e2e-results'), { recursive: true });
  writeFileSync(join(ROOT, '.e2e-results', 'budgets.jsonl'), `${JSON.stringify({ task, clicks, target })}\n`, { flag: 'a' });
}
