// v2.4 G4a web part B (spec §6.1 L341–357, §6.2 L358–387, §6.3 L388–402, §10.1, §13 "Unit web"): the chip store, its limits,
// upload at attach time, the send lock, paste / drop decisions, the Tauri drop bridge, `/attach*` HTTP and the chip markup.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LangProvider } from '../src/lib/i18n.tsx';
import { makeT } from '../../shared/i18n/index.ts';
import { DROP_DEDUPE_MS, tauriDrop } from '../src/lib/native.ts';
import type { TauriGlobal } from '../src/lib/tauri.ts';
import { CommandError, EngineClient } from '../src/lib/ws.ts';
import { Store } from '../src/lib/store.ts';
import AttachChips from '../src/ui/AttachChips.tsx';
import { ATTACH, AttachHttpError, attachHttp, Attachments, type Att, type AttachApi } from '../src/lib/attach-store.ts';
import { attachBadIndex, attachLoader, sendGate } from '../src/ui/useAttachments.ts';
import { bindAttachInput, dropEntries, pasteAction, type AttachInput } from '../src/ui/useWindowHooks.ts';

const MB = 1024 * 1024;
const VI_T = makeT('vi');
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const file = (name: string, size: number, type = '') => ({ name, size, type }) as unknown as File;
type Defer<T> = { p: Promise<T>; ok: (v: T) => void; no: (e: unknown) => void };
const defer = <T,>(): Defer<T> => { let ok!: (v: T) => void, no!: (e: unknown) => void; const p = new Promise<T>((a, b) => { ok = a; no = b; }); return { p, ok, no }; };

function env(over: Partial<AttachApi> = {}) {
  const calls: string[] = [], created: string[] = [], revoked: string[] = [];
  const timers: (() => void)[] = [];
  let n = 0;
  const api: AttachApi = {
    upload: async (_b, name) => { calls.push(`up:${name}`); return { id: `id${++n}`, name, size: 1, kind: 'file' }; },
    byPath: async p => { calls.push(`path:${p}`); return { kind: 'file', name: p.split('/').pop()!, size: 7 }; },
    image: async id => { calls.push(`img:${id}`); return new Blob(['x']); },
    remove: async id => { calls.push(`del:${id}`); },
    ...over,
  };
  const att = new Attachments({
    api, token: () => null, now: () => new Date(2026, 10, 16, 14, 22, 33), pasteName: t => `ảnh-${t}.png`,
    url: { create: () => { const u = `blob:${created.length + 1}`; created.push(u); return u; }, revoke: u => { revoked.push(u); } },
    timers: { set: f => { timers.push(f); return timers.length; }, clear: () => {} },
  });
  return { att, calls, created, revoked, timers, items: () => att.get().items };
}

describe('§6.1 / §6.2 chips: add, limits, upload at attach', () => {
  test('§6.2 a file from a paste / browser drop is a copy chip, uploaded now; the send waits for it', async () => {
    const e = env();
    e.att.addFiles([file('ghi-chú.md', 900, 'text/markdown')]);
    expect(e.items()[0]).toMatchObject({ kind: 'file', name: 'ghi-chú.md', copy: true, st: 'busy' });
    expect(sendGate('', e.items())).toEqual({ ok: false, why: 'attach.lock.busy' });
    await flush();
    expect(e.items()[0]).toMatchObject({ st: 'ok', up: 'id1' });
    expect(e.calls).toEqual(['up:ghi-chú.md']);
  });
  test('§6.1 cc#58776 the same image pasted twice → two chips, two uploads', async () => {
    const e = env(), img = file('image.png', 2 * MB, 'image/png');
    e.att.addFiles([img], true);
    e.att.addFiles([img], true);
    await flush();
    expect(e.items().map(a => a.up)).toEqual(['id1', 'id2']);
    expect(new Set(e.items().map(a => a.key)).size).toBe(2);
  });
  test('§6.3 a pasted image with no name of its own is ảnh-HHMMSS.png; a named file keeps its name; its thumbnail is a blob: URL', () => {
    const e = env();
    e.att.addFiles([file('image.png', 10, 'image/png'), file('a shot.png', 10, 'image/png')], true);
    expect(e.items().map(a => a.name)).toEqual(['ảnh-142233.png', 'a shot.png']);
    expect(e.items().map(a => a.thumb)).toEqual(['blob:1', 'blob:2']);
  });
  test('§6.2 limits: image > 20 MB, images > 40 MB in total, copy > 50 MB → error chips, never uploaded', async () => {
    const e = env();
    e.att.addFiles([file('a.png', ATTACH.image + 1, 'image/png'), file('b.png', 19 * MB, 'image/png'), file('c.png', 19 * MB, 'image/png'),
      file('d.png', 3 * MB, 'image/png'), file('big.zip', ATTACH.copy + 1)]);
    await flush();
    expect(e.items().map(a => a.why ?? a.st)).toEqual(['tooBig', 'ok', 'ok', 'imagesTotal', 'copyTooBig']);
    expect(e.calls).toEqual(['up:b.png', 'up:c.png']);
    expect(sendGate('x', e.items())).toEqual({ ok: false, why: 'attach.lock.bad' });
  });
  test('MINOR-2 "×" brings the images back under 40 MB: an imagesTotal chip is checked again (pasted → uploaded, dropped → path check)', async () => {
    const e = env();
    e.att.addFiles([file('a.png', 15 * MB, 'image/png'), file('b.png', 15 * MB, 'image/png'), file('c.png', 15 * MB, 'image/png')], true);
    await flush();
    expect(e.items().map(a => a.why ?? a.st)).toEqual(['ok', 'ok', 'imagesTotal']);
    e.att.remove(e.items()[0]!.key);
    expect(e.items()[1]).toMatchObject({ st: 'busy' });
    await flush();
    expect(e.items().map(a => a.st)).toEqual(['ok', 'ok']);
    expect(e.items()[1]!.why).toBeUndefined();
    expect(sendGate('', e.items()).ok).toBe(true);
    // still over after the "×": stays red, no upload
    const f = env();
    f.att.addFiles([file('a.png', 5 * MB, 'image/png'), file('b.png', 20 * MB, 'image/png'), file('c.png', 20 * MB, 'image/png'), file('d.png', 20 * MB, 'image/png')]);
    await flush();
    expect(f.items().map(a => a.why ?? a.st)).toEqual(['ok', 'ok', 'imagesTotal', 'imagesTotal']);
    f.att.remove(f.items()[0]!.key);
    await flush();
    expect(f.items().map(a => a.why ?? a.st)).toEqual(['ok', 'ok', 'imagesTotal']); // c fits (40 MB), d still over
    expect(f.calls.filter(c => c === 'up:d.png')).toEqual([]);
    // a dropped image (path) refused on the total is checked again by path
    let big = true;
    const d = env({ byPath: async p => ({ id: `p${p.length}`, name: p.split('/').pop()!, size: big ? 30 * MB : 15 * MB, kind: 'image' as const }) });
    d.att.addPaths(['/x/a.png']);
    await flush();
    d.att.addPaths(['/x/bb.png']);
    await flush();
    expect(d.items()[1]).toMatchObject({ st: 'bad', why: 'imagesTotal' });
    big = false;
    d.att.remove(d.items()[0]!.key);
    await flush();
    expect(d.items()[0]).toMatchObject({ st: 'ok', up: 'p9', name: 'bb.png' });
  });
  test('§6.2 DK6 21+ items: 20 chips, the line counts the rest, gone after 6 s or when a chip is removed', () => {
    const e = env();
    e.att.addFiles(Array.from({ length: 25 }, (_, i) => file(`f${i}.txt`, 1)));
    expect(e.items()).toHaveLength(20);
    expect(e.att.get().dropped).toBe(5);
    e.timers.at(-1)!();
    expect(e.att.get().dropped).toBe(0);
    e.att.addFiles([file('x.txt', 1)]);
    expect(e.att.get().dropped).toBe(1);
    e.att.remove(e.items()[0]!.key);
    expect(e.att.get().dropped).toBe(0);
    expect(e.items()).toHaveLength(19);
  });
  test('§6.3 DK5b a failed upload: fail chip (send locked), "Thử lại" uploads again; 413 → the size reason', async () => {
    let fail = true;
    const e = env({ upload: async (_b, name) => { if (fail) throw new AttachHttpError(500); return { id: 'r1', name, size: 1, kind: 'file' }; } });
    e.att.addFiles([file('a.txt', 1)]);
    await flush();
    expect(e.items()[0]!.st).toBe('fail');
    expect(sendGate('hi', e.items())).toEqual({ ok: false, why: 'attach.lock.fail' });
    fail = false;
    e.att.retry(e.items()[0]!.key);
    expect(e.items()[0]!.st).toBe('busy');
    await flush();
    expect(e.items()[0]).toMatchObject({ st: 'ok', up: 'r1' });
    const big = env({ upload: async () => { throw new AttachHttpError(413); } });
    big.att.addFiles([file('a.png', 5, 'image/png')]);
    await flush();
    expect(big.items()[0]).toMatchObject({ st: 'bad', why: 'tooBig' });
  });
});

describe('§6.1 Tauri drop paths → POST /attach/path', () => {
  test('a file stays a path (sent as { path }), an image becomes a copy + a blob: thumbnail fetched with GET /attach/<id>', async () => {
    const e = env({ byPath: async p => (p.endsWith('.png') ? { id: 'im1', name: 'a.png', size: 3, kind: 'image' as const } : { kind: 'file' as const, name: 'doanh-thu.xlsx', size: 48 }) });
    e.att.addPaths(['/Users/u/Desktop/doanh-thu.xlsx', '/Users/u/Desktop/a.png']);
    expect(e.items().map(a => a.kind)).toEqual(['file', 'image']);
    await flush();
    expect(e.items()[0]).toMatchObject({ st: 'ok', copy: false, size: 48 });
    expect(e.items()[1]).toMatchObject({ st: 'ok', up: 'im1', thumb: 'blob:1' });
    expect(e.calls).toEqual(['img:im1']);
    expect(sendGate('', e.items())).toEqual({ ok: true, items: [{ path: '/Users/u/Desktop/doanh-thu.xlsx' }, { up: 'im1' }] });
  });
  test('§6.2 dir / blocked root / unreadable → error chips with their reason', async () => {
    const e = env({ byPath: async p => { if (p.endsWith('db')) throw new AttachHttpError(403); if (p.endsWith('gone')) throw new AttachHttpError(404); return { kind: 'dir', name: 'bao-cao-t10' }; } });
    e.att.addPaths(['/x/bao-cao-t10', '/Users/u/.cc-slaves/state.db', '/x/gone']);
    await flush();
    expect(e.items().map(a => a.why)).toEqual(['dir', 'blocked', 'unreadable']);
    e.att.addPaths([], ['folder2']);
    expect(e.items().at(-1)).toMatchObject({ name: 'folder2', st: 'bad', why: 'dir' });
  });
});

describe('§6.2 / §6.3 remove, Backspace, send, unmount: blob URLs and engine copies', () => {
  test('"×" revokes the thumbnail and deletes the unsent copy; "×" while uploading deletes the copy when it lands', async () => {
    const d = defer<{ id: string; name: string; size: number; kind: 'image' }>();
    const e = env({ upload: () => d.p });
    e.att.addFiles([file('a.png', 5, 'image/png')]);
    e.att.remove(e.items()[0]!.key);
    expect(e.revoked).toEqual(['blob:1']);
    d.ok({ id: 'late', name: 'a.png', size: 5, kind: 'image' });
    await flush();
    expect(e.calls).toEqual(['del:late']);
    expect(e.items()).toHaveLength(0);
    const e2 = env();
    e2.att.addFiles([file('a.png', 5, 'image/png')]);
    await flush();
    e2.att.remove(e2.items()[0]!.key);
    expect(e2.calls).toEqual(['up:a.png', 'del:id1']);
  });
  test('§6.2 T4 Backspace on an empty composer removes the last chip only', () => {
    const e = env();
    e.att.addFiles([file('a.txt', 1), file('b.txt', 1)]);
    expect(e.att.removeLast()).toBe(true);
    expect(e.items().map(a => a.name)).toEqual(['a.txt']);
    e.att.removeLast();
    expect(e.att.removeLast()).toBe(false);
  });
  test('§6.3 sent: no chip left, every blob URL revoked, no DELETE (the copies belong to the message now)', async () => {
    const e = env();
    e.att.addFiles([file('a.png', 5, 'image/png'), file('b.png', 5, 'image/png')]);
    await flush();
    e.att.sent();
    expect(e.items()).toEqual([]);
    expect(e.revoked).toEqual(['blob:1', 'blob:2']);
    expect(e.calls.filter(c => c.startsWith('del:'))).toEqual([]);
  });
  test('unmount (dispose) revokes every blob URL and deletes the unsent copies', async () => {
    const e = env();
    e.att.addFiles([file('a.png', 5, 'image/png'), file('n.txt', 5)]);
    await flush();
    e.att.dispose();
    expect(e.revoked).toEqual(['blob:1']);
    expect(e.calls.filter(c => c.startsWith('del:')).sort()).toEqual(['del:id1', 'del:id2']);
  });
});

describe('MINOR-3 leak / race guards and the limit boundaries', () => {
  const img = (id: string, size = 3) => ({ id, name: 'a.png', size, kind: 'image' as const });
  test('"×" while a dropped image\'s thumbnail is fetched: no blob: URL is made (nothing to leak)', async () => {
    const d = defer<Blob>();
    const e = env({ byPath: async () => img('im1'), image: () => d.p });
    e.att.addPaths(['/x/a.png']);
    await flush();
    e.att.remove(e.items()[0]!.key);
    d.ok(new Blob(['x']));
    await flush();
    expect(e.created).toEqual([]);
  });
  test('"×" while a dropped image is checked: the engine copy made by the late answer is deleted', async () => {
    const d = defer<ReturnType<typeof img>>();
    const e = env({ byPath: () => d.p });
    e.att.addPaths(['/x/a.png']);
    e.att.remove(e.items()[0]!.key);
    d.ok(img('late'));
    await flush();
    expect(e.calls).toEqual(['del:late']);
    expect(e.created).toEqual([]);
  });
  test('a dropped image over the 40 MB total: error chip, its engine copy deleted, no thumbnail', async () => {
    const e = env({ byPath: async p => img(p.slice(-5), 25 * MB) });
    e.att.addPaths(['/x/a.png', '/x/b.png']);
    await flush();
    expect(e.items().map(a => a.why ?? a.st)).toEqual(['ok', 'imagesTotal']);
    expect(e.calls).toEqual(['img:a.png', 'del:b.png']);
  });
  test('boundaries match the engine (`>`): exactly 20 MB an image, 40 MB of images, 50 MB a copy are accepted', async () => {
    const e = env();
    e.att.addFiles([file('a.png', ATTACH.image, 'image/png'), file('b.png', ATTACH.image, 'image/png'), file('big.zip', ATTACH.copy)]);
    await flush();
    expect(e.items().map(a => a.st)).toEqual(['ok', 'ok', 'ok']);
    e.att.addFiles([file('c.png', 1, 'image/png')]);
    expect(e.items().at(-1)).toMatchObject({ st: 'bad', why: 'imagesTotal' });
  });
  test('unmount disposes the store, also when the store chunk lands after the unmount', async () => {
    const d = defer<{ Attachments: new (env: never) => { dispose(): void } }>(), log: string[] = [];
    const l = attachLoader(() => d.p as never, () => ({}) as never, () => log.push('loaded'));
    l.run(() => log.push('run'));
    l.dispose();
    d.ok({ Attachments: class { dispose() { log.push('dispose'); } } });
    await flush();
    expect(log).toEqual(['loaded', 'run', 'dispose']);
    const src = readFileSync(new URL('../src/ui/useAttachments.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/useEffect\(\(\) => \(\) => ld\.dispose\(\), \[ld\]\);/);
  });
});

describe('§6.3 / §6.6 send gate', () => {
  const ok = (over: Partial<Att>): Att => ({ key: 1, kind: 'file', name: 'a', size: 1, copy: true, st: 'ok', up: 'u1', ...over });
  test('§6.3 DK15 chips only, no text: sendable, items in chip order', () => {
    expect(sendGate('', [ok({}), ok({ key: 2, up: undefined, path: '/p/b.md', copy: false })])).toEqual({ ok: true, items: [{ up: 'u1' }, { path: '/p/b.md' }] });
  });
  test('§6.6 DK14 a / line with chips: locked with "Lệnh /compact không nhận file đính kèm"; without chips: no lock', () => {
    expect(sendGate('/compact', [ok({})])).toEqual({ ok: false, why: 'attach.lock.slash', line: 'attach.slashNo', params: { cmd: '/compact' } });
    // MINOR-4 §6.6 L463 the red line names the command; the send tip says what to do
    expect(VI_T('attach.slashNo', { cmd: '/compact' })).toBe('Lệnh /compact không nhận file đính kèm');
    expect(VI_T('attach.lock.slash')).toBe('Bỏ file hoặc bỏ lệnh / để gửi');
    expect(sendGate('/compact', [])).toEqual({ ok: true, items: [] });
  });
});

describe('§6.1 paste and browser drop decisions', () => {
  const dt = (text: string, n: number) => ({ getData: (t: string) => (t === 'text/plain' ? text : ''), files: Array.from({ length: n }, () => file('x.png', 1, 'image/png')) });
  test('cc#71793 clipboard with text and an image → the text only (default paste)', () => {
    expect(pasteAction(dt('A1', 1), 'composer', false)).toBe('pass');
    expect(pasteAction(dt('', 1), 'composer', false)).toBe('files');
  });
  test('§6.1 window-wide ⌘V: no field focused → chips; another text field keeps its paste; a dialog open → nothing', () => {
    expect(pasteAction(dt('', 1), 'none', false)).toBe('files');
    expect(pasteAction(dt('', 1), 'other', false)).toBe('pass');
    expect(pasteAction(dt('', 1), 'none', true)).toBe('pass');
    expect(pasteAction(dt('', 0), 'none', false)).toBe('pass');
  });
  test('§6.1 a dropped folder (webkitGetAsEntry().isDirectory) is refused by name, files pass', () => {
    const f = file('a.txt', 1);
    const r = dropEntries([{ kind: 'file', getAsFile: () => f, webkitGetAsEntry: () => ({ isDirectory: false, name: 'a.txt' }) },
      { kind: 'file', getAsFile: () => null, webkitGetAsEntry: () => ({ isDirectory: true, name: 'bao-cao-t10' }) }, { kind: 'string', getAsFile: () => null }]);
    expect(r).toEqual({ files: [f], dirs: ['bao-cao-t10'] });
  });
});

describe('§10.1 Tauri native drop (tauri#14134, R6)', () => {
  function fake() {
    const ls: Record<string, (e: { payload: unknown }) => void> = {};
    let focus = 0, unlisten = 0;
    const tauri: TauriGlobal = { event: { listen: async (n, cb) => { ls[n] = cb as (e: { payload: unknown }) => void; return () => { unlisten++; }; } },
      window: { getCurrentWindow: () => ({ setFocus: async () => { focus++; }, setTheme: async () => {}, onThemeChanged: async () => () => {} }) } };
    return { tauri, ls, focus: () => focus, unlisten: () => unlisten };
  }
  test('the drop fired twice within 300 ms → one set of chips; the window is activated (setFocus) on the drop', async () => {
    const f = fake();
    let t = 1000;
    const drops: string[][] = [], hov: string[] = [];
    const off = tauriDrop(f.tauri, () => t)!({ enter: () => hov.push('in'), leave: () => hov.push('out'), drop: p => drops.push(p) });
    await flush();
    f.ls['tauri://drag-enter']!({ payload: { paths: ['/a.png'] } });
    f.ls['tauri://drag-drop']!({ payload: { paths: ['/a.png', '/b.md'] } });
    t += DROP_DEDUPE_MS - 1;
    f.ls['tauri://drag-drop']!({ payload: { paths: ['/a.png', '/b.md'] } });
    expect(drops).toEqual([['/a.png', '/b.md']]);
    expect(f.focus()).toBe(1);
    t += 2;
    f.ls['tauri://drag-drop']!({ payload: { paths: ['/a.png', '/b.md'] } });
    f.ls['tauri://drag-drop']!({ payload: { paths: ['/c.txt'] } });
    expect(drops).toHaveLength(3);
    f.ls['tauri://drag-leave']!({ payload: null });
    expect(hov).toEqual(['in', 'out']);
    off();
    await flush();
    expect(f.unlisten()).toBe(3);
  });
  test('a plain browser has no native drop', () => { expect(tauriDrop(null)).toBeNull(); });
});

describe('§10.1 /attach* HTTP: Bearer header, never ?token=', () => {
  test('upload / path / image / delete carry the Bearer token; the name is URI-encoded; a non-2xx throws its status', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const api = attachHttp(() => 'tok', async (url, init) => { seen.push({ url, init }); return url.endsWith('/bad') ? new Response('', { status: 404 }) : Response.json({ id: 'a', name: 'n', size: 1, kind: 'file' }); });
    await api.upload(new Blob(['x']), 'ghi chú.md');
    await api.byPath('/Users/u/a.png');
    await api.image('i1');
    await api.remove('i1');
    expect(seen.map(s => `${s.init?.method ?? 'GET'} ${s.url}`)).toEqual(['POST /attach', 'POST /attach/path', 'GET /attach/i1', 'DELETE /attach/i1']);
    for (const s of seen) { expect((s.init?.headers as Record<string, string>).authorization).toBe('Bearer tok'); expect(s.url).not.toContain('token'); }
    expect((seen[0]!.init!.headers as Record<string, string>)['x-attach-name']).toBe('ghi%20ch%C3%BA.md');
    expect(await api.image('bad').catch((e: unknown) => (e as AttachHttpError).status)).toBe(404);
  });
  test('EngineClient.token() reads the token of the current WS URL (an engine restart swaps it)', () => {
    const c = new EngineClient({ url: 'ws://127.0.0.1:47800/ws?token=t1', onMessage() {}, onStatus() {} });
    expect(c.token()).toBe('t1');
    c.setUrl('ws://127.0.0.1:47800/ws?token=t2');
    expect(c.token()).toBe('t2');
    c.setUrl('wss://x.example/ws');
    expect(c.token()).toBeNull();
  });
});

describe('§6.2 chip markup (DK1 DK2 DK4 DK5 DK5b DK8)', () => {
  const html = (el: ReactElement) => renderToStaticMarkup(<LangProvider lang="vi">{el}</LangProvider>);
  const chips = (items: Att[], one = false) => html(<AttachChips items={items} one={one} onRemove={() => {}} onRetry={() => {}} />);
  const a = (over: Partial<Att>): Att => ({ key: 1, kind: 'file', name: 'doanh-thu.xlsx', size: 48 * 1024, copy: false, st: 'ok', ...over });
  test('every "×" is a button named "<name>, bỏ"; a file shows its size; a copy has the "bản sao" tag with the A7 note', () => {
    const h = chips([a({}), a({ key: 2, name: 'ghi-chú.md', copy: true })]);
    expect(h).toContain('aria-label="doanh-thu.xlsx, bỏ"');
    expect(h).toContain('48 KB');
    expect(h.match(/>bản sao</g)).toHaveLength(1);
    expect(h).toContain('Claude đọc được nhưng không sửa vào file gốc');
  });
  test('§6.2 a long name is cut in the middle, tail kept, full name in title', () => {
    const name = '2026-11-15-cc-slaves-v2.4-model-attach-design.md';
    const h = chips([a({ name })]);
    expect(h).toContain(`title="${name}"`);
    expect(h).toMatch(/>2026-[^<]*…[^<]*design\.md</);
  });
  test('DK4 an uploading image has a spinner and "×"; a Finder file being checked has no spinner', () => {
    const h = chips([a({ kind: 'image', name: 'ảnh-1.png', st: 'busy', thumb: 'blob:1' }), a({ key: 2, st: 'busy', path: '/x' })]);
    expect(h.match(/class="spin"/g)).toHaveLength(1);
    expect(h).toContain('src="blob:1"');
    expect(h.match(/class="ax"/g)).toHaveLength(2);
  });
  test('DK5 / DK5b error chips show the reason; a failed upload has "Thử lại"; a bad image keeps its thumbnail', () => {
    const h = chips([a({ kind: 'image', name: 'ảnh-143015.png', st: 'bad', why: 'tooBig', thumb: 'blob:9' }), a({ key: 2, name: 'bao-cao-t10', st: 'bad', why: 'dir' }),
      a({ key: 3, st: 'fail' })]);
    expect(h).toContain('Quá 20 MB');
    expect(h).toContain('Không nhận thư mục');
    expect(h).toContain('Không tải lên được');
    expect(h.match(/Thử lại/g)).toHaveLength(1);
    expect(h).toContain('src="blob:9"');
    expect(h).not.toContain('>bản sao<'); // a folder is never a copy
  });
  test('R21 §6.4 an expired copy: "Đã hết hạn · đính lại" (the link re-attaches)', () => {
    const h = chips([a({ key: 4, name: 'ghi-chú.md', copy: true, st: 'bad', why: 'expired' })]);
    expect(h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).toContain('Đã hết hạn · đính lại');
    expect(h).toMatch(/<button type="button" class="lnk">đính lại<\/button>/);
    expect(h).not.toContain('Thử lại');
  });
});

describe('R21 §6.4 a copy expired at send ("Đã hết hạn · đính lại")', () => {
  test('the send error names the item: errors.attachBad + params.index (bad_input or not_found), anything else → null', () => {
    expect(attachBadIndex(new CommandError('bad_input', 'x', 'errors.attachBad', { index: 1, n: 2 }))).toBe(1);
    expect(attachBadIndex(new CommandError('not_found', 'x', 'errors.attachBad', { index: 0, n: 1 }))).toBe(0);
    expect(attachBadIndex(new CommandError('bad_input', 'x', 'errors.badTargetOrEmpty'))).toBeNull();
    expect(attachBadIndex(new CommandError('bad_input', 'x', 'errors.cardNoAction', { index: 1 }))).toBeNull(); // only the attach error names an item
    expect(attachBadIndex(new Error('timeout'))).toBeNull();
  });
  test('the chip named by the error turns "expired" (send locked, the text stays); a path file the engine refused → unreadable', async () => {
    const e = env({ byPath: async () => ({ kind: 'file' as const, name: 'a.xlsx', size: 5 }) });
    e.att.addFiles([file('ghi-chú.md', 9)]);
    e.att.addPaths(['/x/a.xlsx']);
    await flush();
    const [c, f] = e.items();
    e.att.expire(c!.key);
    e.att.expire(f!.key);
    expect(e.items()[0]).toMatchObject({ st: 'bad', why: 'expired', name: 'ghi-chú.md' });
    expect(e.items()[0]!.up).toBeUndefined();
    expect(e.items()[1]).toMatchObject({ st: 'bad', why: 'unreadable', path: '/x/a.xlsx' });
    expect(sendGate('x', e.items())).toEqual({ ok: false, why: 'attach.lock.bad' });
  });
  test('"đính lại" uploads the kept File again (pasted) or re-checks the path (dropped image); no source → the chip goes', async () => {
    const e = env({ byPath: async () => ({ id: 'im9', name: 'a.png', size: 3, kind: 'image' as const }) });
    e.att.addFiles([file('ghi-chú.md', 9)]);
    e.att.addPaths(['/x/a.png']);
    await flush();
    for (const a of e.items()) e.att.expire(a.key);
    for (const a of e.items()) e.att.retry(a.key);
    expect(e.items().map(a => a.st)).toEqual(['busy', 'busy']);
    await flush();
    expect(e.items()).toMatchObject([{ st: 'ok', up: 'id2' }, { st: 'ok', up: 'im9' }]);
    expect(e.calls.filter(c => !c.startsWith('del:'))).toEqual(['up:ghi-chú.md', 'img:im9', 'up:ghi-chú.md', 'img:im9']);
    const g = env();
    g.att.addFiles([file('n.txt', 1)]);
    await flush();
    (g.att as unknown as { sources: Map<number, unknown> }).sources.clear(); // the web no longer has the file
    g.att.expire(g.items()[0]!.key);
    g.att.retry(g.items()[0]!.key);
    expect(g.items()).toEqual([]);
  });
  test('the composer keeps chips + text until the send is acked; a send error naming an item expires that chip (source pin)', () => {
    const src = readFileSync(new URL('../src/ui/Inspector.tsx', import.meta.url), 'utf8');
    expect(src).toMatch(/const i = attachBadIndex\(e\); if \(i !== null && keys\[i\] !== undefined\) run\(a => a\.expire\(keys\[i\]!\)\);/);
    expect(src).toMatch(/sent\.then\(\(\) => \{ setValue\(''\); run\(a => a\.sent\(\)\); \}/);
  });
});

describe('§6.1 window-wide paste / drop wiring (bindAttachInput)', () => {
  function rig(over: Partial<AttachInput> = {}, active: { id?: string; matches?: (s: string) => boolean } | null = null) {
    const doc = Object.assign(new EventTarget(), { activeElement: active as Element | null });
    const log: string[] = [];
    const a: AttachInput = { on: true, locked: null, modal: false, files: (f, p) => log.push(`files:${f.length}:${p}`), paths: p => log.push(`paths:${p.join(',')}`),
      dirs: n => log.push(`dirs:${n.join(',')}`), toast: t => log.push(`toast:${t}`), hover: h => log.push(`hover:${h}`), focus: () => log.push('focus'), ...over };
    return { doc, log, a };
  }
  const paste = (text: string, n: number) => Object.assign(new Event('paste', { cancelable: true }), { clipboardData: { getData: (t: string) => (t === 'text/plain' ? text : ''), files: Array.from({ length: n }, () => file('x.png', 1, 'image/png')) } });
  const dt = (items: unknown[]) => ({ types: ['Files'], items });
  test('§6.1 T1 ⌘V with an image and no field focused → a chip, then the composer takes the caret', () => {
    const r = rig();
    const off = bindAttachInput(r.doc, () => r.a, null);
    const e = paste('', 1);
    r.doc.dispatchEvent(e);
    expect(r.log).toEqual(['files:1:true', 'focus']);
    expect(e.defaultPrevented).toBe(true);
    off();
    r.doc.dispatchEvent(paste('', 1));
    expect(r.log).toHaveLength(2); // unbound
  });
  test('§6.1 ⌘V in another text field (filter, Code editor) keeps that field\'s paste', () => {
    const r = rig({}, { id: 'flt', matches: s => s.includes('input') });
    bindAttachInput(r.doc, () => r.a, null);
    const e = paste('', 1);
    r.doc.dispatchEvent(e);
    expect(r.log).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });
  test('§6.1 DK11 a locked composer takes nothing: toast "<reason> · chưa đính kèm được", no chip, no focus', () => {
    const r = rig({ locked: 'Mất kết nối · chưa đính kèm được' });
    bindAttachInput(r.doc, () => r.a, null);
    r.doc.dispatchEvent(paste('', 1));
    expect(r.log).toEqual(['toast:Mất kết nối · chưa đính kèm được']);
  });
  test('§6.1 T3 browser drag: overlay on enter (once for nested enters), drop → chips + folders refused + caret; a dialog open → nothing', () => {
    const r = rig();
    bindAttachInput(r.doc, () => r.a, null);
    const f = file('a.txt', 1);
    const ev = (t: string, items: unknown[] = []) => Object.assign(new Event(t, { cancelable: true }), { dataTransfer: dt(items) });
    r.doc.dispatchEvent(ev('dragenter'));
    r.doc.dispatchEvent(ev('dragenter'));
    r.doc.dispatchEvent(ev('dragleave'));
    r.doc.dispatchEvent(ev('drop', [{ kind: 'file', getAsFile: () => f }, { kind: 'file', getAsFile: () => null, webkitGetAsEntry: () => ({ isDirectory: true, name: 'd' }) }]));
    expect(r.log).toEqual(['hover:true', 'hover:false', 'files:1:false', 'dirs:d', 'focus']);
    const m = rig({ modal: true });
    bindAttachInput(m.doc, () => m.a, null);
    m.doc.dispatchEvent(ev('dragenter'));
    m.doc.dispatchEvent(ev('drop', [{ kind: 'file', getAsFile: () => f }]));
    expect(m.log).toEqual(['hover:false']);
  });
  test('§6.1 T2 / T3 the native (Tauri) drop gives paths, then the composer takes the caret', () => {
    const r = rig();
    let h: { enter(): void; leave(): void; drop(p: string[]): void } | null = null;
    const off = bindAttachInput(r.doc, () => r.a, x => { h = x; return () => r.log.push('unlisten'); });
    h!.enter();
    h!.drop(['/Users/u/Desktop/a.png']);
    expect(r.log).toEqual(['hover:true', 'hover:false', 'paths:/Users/u/Desktop/a.png', 'focus']);
    off();
    expect(r.log.at(-1)).toBe('unlisten');
  });
  test('MINOR-3 §6.1 a dialog open: the native (Tauri) drop lands nothing (no overlay, no chip, no caret)', () => {
    const r = rig({ modal: true });
    let h: { enter(): void; leave(): void; drop(p: string[]): void } | null = null;
    bindAttachInput(r.doc, () => r.a, x => { h = x; return () => {}; });
    h!.enter();
    h!.drop(['/Users/u/Desktop/a.png']);
    expect(r.log).toEqual(['hover:false']);
  });
});

describe('§6.3 DK4 / DK5 the send-lock tip', () => {
  test('IMPORTANT-2 the locked send button dims its parts, never the box: the tip (its own ::after) stays opaque', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    const rule = /#inspector \.send\.dis\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('background:color-mix(in srgb,var(--accent) 50%,transparent)');
    expect(rule).not.toMatch(/opacity|filter/);
    expect(css).toMatch(/#inspector \.send\.dis>svg\{opacity:\.5\}/);
  });
});

describe('§6.2 DK2b with chips the text box stops at 3 whole lines', () => {
  test('§6.2 max-height = 3 × the #cmd line height (one home), not a px literal', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    const lh = /#cmd\{[^}]*--lh:([\d.]+)[^}]*font:var\(--md\)\/var\(--lh\)/.exec(css)?.[1];
    expect(lh).toBe('1.4');
    expect(css).toContain('.inrow.att #cmd{max-height:calc(3 * var(--lh) * var(--md))}');
  });
});

describe('R21 DK11 drawn as the mockup: a red toast with the wifi-off icon, not the plain warn toast', () => {
  test('the store keeps the toast icon; the shell draws an icon toast with its level (DK11: error + wifi)', () => {
    const st = new Store();
    st.toast('error', 'Mất kết nối · chưa đính kèm được', 'wifi');
    expect(st.get().toasts[0]).toMatchObject({ level: 'error', text: 'Mất kết nối · chưa đính kèm được', icon: 'wifi' });
    const app = readFileSync(new URL('../src/ui/App.tsx', import.meta.url), 'utf8');
    expect(app).toMatch(/className=\{`toast\$\{t\.icon \? ` ic \$\{t\.level\}` : ''\}`\}>\{t\.icon \? <Icon n=\{t\.icon\} s=\{14\} \/>/);
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    expect(css).toContain('#toasts .toast.ic{padding:var(--s3) var(--s5)}');
    expect(css).toMatch(/#toasts \.toast\.ic\.error\{border-color:color-mix\(in srgb,var\(--bad\) 40%,transparent\)\}/);
    expect(css).toMatch(/#toasts \.toast\.ic\.error svg\{color:var\(--bad\)\}/);
    expect(css).toContain('body.offline #toasts{top:calc(var(--bn) + var(--h-bar) + var(--h-head) + var(--h-ctl) + var(--s5))}'); // DK11 under the 28 px offline band
  });
  test('the locked composer says why with the icon of its lock: offline → wifi (DK11), starting → clock', () => {
    const src = readFileSync(new URL('../src/ui/Inspector.tsx', import.meta.url), 'utf8');
    expect(src).toMatch(/toast: t => p\.onError\(t, p\.offline \? 'wifi' : 'clock'\)/);
    const left = readFileSync(new URL('../src/ui/LeftColumn.tsx', import.meta.url), 'utf8');
    expect(left).toMatch(/onError=\{\(t, icon\) => store\.toast\(icon === 'wifi' \? 'error' : 'warn', t, icon\)\}/);
  });
});

describe('§8 / §6.3 composer wiring (source pins, like the LeftColumn onSend pin)', () => {
  const src = readFileSync(new URL('../src/ui/Inspector.tsx', import.meta.url), 'utf8');
  test('§8 paste / drop is bound on the Mac channel only (remote: no attach affordance at all)', () => {
    expect(src).toMatch(/useAttachInput\(\{\s*on: p\.snap\.channel === 'mac',/);
  });

});

describe('§6.2 I1 a short column caps the strip at one row', () => {
  test('§6.2 `one` marks the strip (`.tray.one`, 1 row, scrolls); without it no cap', () => {
    const html = (one: boolean) => renderToStaticMarkup(<LangProvider lang="vi"><AttachChips items={[{ key: 1, kind: 'file', name: 'a.md', size: 1, copy: false, st: 'ok' }]} one={one} onRemove={() => {}} onRetry={() => {}} /></LangProvider>);
    expect(html(true)).toContain('class="tray one"');
    expect(html(false)).toContain('class="tray"');
  });
});

