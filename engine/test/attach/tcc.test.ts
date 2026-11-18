// Ruling R4 (NC §8-23): a read in ~/Desktop / ~/Documents / ~/Downloads waits until the PO answers the macOS TCC prompt (up to
// 32 s measured). `node:fs` is wrapped so any call on a `TCC-Desktop` path stalls: the sync form blocks the thread, the async
// form only its own promise. Every other path passes straight through, so the wrap is harmless to other files.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { attachEnv, PNG, type AttachEnv } from './_env.ts';

const STALL_MS = 300;
// Kept once per process: a re-run of this file must wrap the real module, not the previous run's wrapper.
const keep = globalThis as { __r4Fs?: { real: typeof fs; realP: typeof fsp } };
keep.__r4Fs ??= { real: { ...fs }, realP: { ...fsp } };
const { real, realP } = keep.__r4Fs;
const tcc = (p: unknown): boolean => String(p).includes('/TCC-Desktop');
const block = (p: unknown): void => { if (tcc(p)) { const end = Date.now() + STALL_MS; while (Date.now() < end) { /* the prompt is up */ } } };
const stall = async (p: unknown): Promise<void> => { if (tcc(p)) await Bun.sleep(STALL_MS); };
type Fn = (...a: never[]) => unknown;
const sync = <F extends Fn>(f: F): F => ((...a: Parameters<F>) => { block(a[0]); return f(...a); }) as F;
const async_ = <F extends Fn>(f: F): F => (async (...a: Parameters<F>) => { await stall(a[0]); return f(...a); }) as F;
const realpathSync = Object.assign(sync(real.realpathSync), { native: sync(real.realpathSync.native) });

void mock.module('node:fs', () => ({
  ...real, realpathSync, statSync: sync(real.statSync), openSync: sync(real.openSync), readFileSync: sync(real.readFileSync),
}));
void mock.module('node:fs/promises', () => ({
  ...realP, realpath: async_(realP.realpath), stat: async_(realP.stat), open: async_(realP.open), readFile: async_(realP.readFile),
}));

const { AttachStore } = await import('../../src/attach/store.ts');
const { attachRoute } = await import('../../src/attach/routes.ts');

let env: AttachEnv;
beforeEach(() => { env = attachEnv(); });
afterEach(() => env.restore());

/** Largest event-loop gap (ms) while `work` runs: the engine answers nothing for that long. */
async function maxGap<T>(work: () => Promise<T>): Promise<{ gap: number; out: T }> {
  let last = performance.now();
  let gap = 0;
  const beat = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - last); last = now; }, 5);
  try {
    const out = await work();
    gap = Math.max(gap, performance.now() - last);
    return { gap, out };
  } finally { clearInterval(beat); }
}

const byPath = (path: string): Request => {
  const body = JSON.stringify({ path });
  return new Request('http://127.0.0.1/attach/path', { method: 'POST', body, headers: { 'content-length': String(Buffer.byteLength(body)) } });
};

describe('§R4 TCC prompt', () => {
  test('§R4 a pending TCC prompt does not freeze the engine', async () => {
    const desk = join(env.tmp, 'TCC-Desktop');
    const other = join(env.tmp, 'Other');
    for (const d of [desk, other]) real.mkdirSync(d);
    real.writeFileSync(join(desk, 'loi.png'), PNG);
    real.writeFileSync(join(desk, 'bao cao.pdf'), 'pdf');
    real.writeFileSync(join(other, 'a.md'), '# a');
    const store = new AttachStore({ referenced: () => new Set() });

    const { gap, out } = await maxGap(async () => {
      const t0 = performance.now();
      const pendingImage = attachRoute(byPath(join(desk, 'loi.png')), store);
      const pendingSend = store.take([{ path: join(desk, 'bao cao.pdf') }]);
      const second = await attachRoute(byPath(join(other, 'a.md')), store);
      const secondMs = performance.now() - t0;
      return { secondMs, second: await second.json(), image: await (await pendingImage).json(), send: await pendingSend };
    });
    expect(out.secondMs).toBeLessThan(200); // a second file answers while the first waits on the prompt
    expect(gap).toBeLessThan(200); // ... and nothing blocks the loop at any later stage (stat, head, read) either
    expect(out.second).toEqual({ kind: 'file', name: 'a.md', size: 3 });
    expect(out.image).toMatchObject({ kind: 'image', name: 'loi.png', size: PNG.length });
    expect(out.send).toMatchObject({ ok: true, list: [{ kind: 'file', name: 'bao cao.pdf', size: 3, copy: false }] });
  });

  test('§R4 two sends racing for one `up` across an await: only one takes it', async () => {
    const desk = join(env.tmp, 'TCC-Desktop');
    real.mkdirSync(desk);
    real.writeFileSync(join(desk, 'x.txt'), 'x');
    const store = new AttachStore({ referenced: () => new Set() });
    const up = store.put('a.png', PNG).id;
    const [a, b] = await Promise.all([
      store.take([{ up }, { path: join(desk, 'x.txt') }]), // checks `up`, waits on the prompt, then claims
      store.take([{ up }]),
    ]);
    expect(b.ok).toBe(true);
    expect(a).toEqual({ ok: false, index: 0 });
  });
});
