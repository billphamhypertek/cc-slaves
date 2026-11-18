import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AttachStore, cleanName, imageMime } from '../../src/attach/store.ts';
import { attachEnv, GIF, JPEG, PNG, WEBP, type AttachEnv } from './_env.ts';

let env: AttachEnv;
let refs: Set<string>;
let store: AttachStore;
beforeEach(() => { env = attachEnv(); refs = new Set(); store = new AttachStore({ referenced: () => refs }); });
afterEach(() => env.restore());

const MB = 1024 * 1024;
const big = (mb: number): Uint8Array => { const b = new Uint8Array(mb * MB); b.set(PNG); return b; };
const mode = (p: string) => statSync(p).mode & 0o777;

describe('§6.4 image type by first bytes, never the extension', () => {
  test('PNG / JPEG / GIF / WebP are images; a fake `.png` is a file', async () => {
    expect(imageMime(PNG)).toBe('image/png');
    expect(imageMime(JPEG)).toBe('image/jpeg');
    expect(imageMime(GIF)).toBe('image/gif');
    expect(imageMime(WEBP)).toBe('image/webp');
    expect(imageMime(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(imageMime(new TextEncoder().encode('RIFF\x10\x00\x00\x00WAVEfmt '))).toBeNull();
    expect(imageMime(PNG.slice(0, 4))).toBeNull();
    const s = store.put('anh.png', new TextEncoder().encode('not an image'));
    expect(s.kind).toBe('file');
    expect(store.put('x.bin', PNG).kind).toBe('image');
  });
});

describe('§10.2 names: basename, no separators / NUL / control chars, not . / .., ≤ 255 bytes', () => {
  test('`../x` → `x`; Windows separators; control chars and newlines dropped; dot names fall back', async () => {
    expect(cleanName('../x')).toBe('x');
    expect(cleanName('a\\..\\b.txt')).toBe('b.txt');
    expect(cleanName('ghi\nchú\u0000\u0007.md')).toBe('ghichú.md');
    expect(cleanName('..')).toBe('file');
    expect(cleanName('.')).toBe('file');
    expect(cleanName('')).toBe('file');
    expect(cleanName('.env')).toBe('.env');
  });

  test('a long name is cut to ≤ 255 bytes without splitting a character', async () => {
    const n = cleanName('ả'.repeat(200));
    expect(Buffer.byteLength(n)).toBeLessThanOrEqual(255);
    expect(n).toBe('ả'.repeat(Math.floor(255 / Buffer.byteLength('ả'))));
  });
});

describe('§6.5 the store: `<attachRoot>/<id>/<name>`, 0700 / 0600', () => {
  test('put writes one copy with a random uuid id; get reads it back with kind and size', async () => {
    const s = store.put('../ảnh chụp.png', PNG);
    expect(s.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(s.file).toBe(join(env.attach, s.id, 'ảnh chụp.png'));
    expect(mode(join(env.attach, s.id))).toBe(0o700);
    expect(mode(s.file)).toBe(0o600);
    expect(store.get(s.id)).toMatchObject({ id: s.id, name: 'ảnh chụp.png', size: PNG.length, kind: 'image', mime: 'image/png' });
    expect(store.put('a.png', PNG).id).not.toBe(s.id); // §6.1 the same image twice = two copies
  });

  test('get / remove reject a malformed id before any path join', async () => {
    expect(store.get('../home')).toBeNull();
    expect(store.remove('../../x')).toBe('not_found');
  });

  test('remove deletes an unattached copy; a copy attached to a message → attached', async () => {
    const a = store.put('a.txt', new TextEncoder().encode('a'));
    expect(store.remove(a.id)).toBe('ok');
    expect(existsSync(join(env.attach, a.id))).toBe(false);
    const b = store.put('b.txt', new TextEncoder().encode('b'));
    expect((await store.take([{ up: b.id }])).ok).toBe(true);
    expect(store.remove(b.id)).toBe('attached');
    const c = store.put('c.txt', new TextEncoder().encode('c'));
    refs.add(c.id); // an outbox row names it
    expect(store.remove(c.id)).toBe('attached');
  });
});

describe('§10.2 `send` attachments check (take)', () => {
  test('`up` used twice in one send → bad_input at the second index', async () => {
    const a = store.put('a.png', PNG);
    expect(await store.take([{ up: a.id }, { up: a.id }])).toEqual({ ok: false, index: 1 });
  });

  test('`up` already attached to an earlier message → bad_input', async () => {
    const a = store.put('a.png', PNG);
    expect((await store.take([{ up: a.id }])).ok).toBe(true);
    expect(await store.take([{ up: a.id }])).toEqual({ ok: false, index: 0 });
  });

  test('a failed check claims nothing (the good `up` stays usable)', async () => {
    const a = store.put('a.png', PNG);
    expect(await store.take([{ up: a.id }, { up: 'nope' }])).toEqual({ ok: false, index: 1 });
    expect((await store.take([{ up: a.id }])).ok).toBe(true);
  });

  test('total images > 40 MB → bad_input at the image that crosses it; files do not count', async () => {
    const f = store.put('big.bin', new Uint8Array(30 * MB));
    const i1 = store.put('1.png', big(15));
    const i2 = store.put('2.png', big(15));
    const i3 = store.put('3.png', big(11));
    expect(await store.take([{ up: f.id }, { up: i1.id }, { up: i2.id }, { up: i3.id }])).toEqual({ ok: false, index: 3 });
    const i4 = store.put('4.png', big(10));
    expect((await store.take([{ up: f.id }, { up: i1.id }, { up: i2.id }, { up: i4.id }])).ok).toBe(true); // exactly 40 MB
  });

  test('> 20 items → bad_input at index 20', async () => {
    const items = Array.from({ length: 21 }, (_, i) => ({ up: store.put(`${i}.txt`, new Uint8Array([i])).id }));
    expect(await store.take(items)).toEqual({ ok: false, index: 20 });
    expect((await store.take(items.slice(0, 20))).ok).toBe(true);
  });

  test('`path`: absolute existing file → metadata, no copy; a directory, a blocked path or a missing one → bad_input', async () => {
    const desk = join(env.tmp, 'Desktop');
    mkdirSync(desk);
    writeFileSync(join(desk, 'doanh thu.xlsx'), 'xx');
    writeFileSync(join(env.home, 'config.json'), '{}');
    const r = await store.take([{ path: join(desk, 'doanh thu.xlsx') }]);
    expect(r).toEqual({ ok: true, list: [{ kind: 'file', name: 'doanh thu.xlsx', size: 2, path: join(desk, 'doanh thu.xlsx'), copy: false }] });
    expect(await store.take([{ path: desk }])).toEqual({ ok: false, index: 0 });
    expect(await store.take([{ path: join(env.home, 'config.json') }])).toEqual({ ok: false, index: 0 });
    expect(await store.take([{ path: join(desk, 'nope') }])).toEqual({ ok: false, index: 0 });
    expect(await store.take([{ path: 'Desktop/doanh thu.xlsx' }])).toEqual({ ok: false, index: 0 });
    expect(await store.take([JSON.parse('{"up":"x","path":"/x"}')])).toEqual({ ok: false, index: 0 });
  });

  test('an uploaded image comes back with its copy path, mime and origPath (§6.4 path line)', async () => {
    const desk = join(env.tmp, 'Desktop');
    mkdirSync(desk);
    writeFileSync(join(desk, 'loi.png'), PNG);
    const s = await store.fromPath(join(desk, 'loi.png'));
    if (!('id' in s)) throw new Error('expected a copy');
    expect(await store.take([{ up: s.id }])).toEqual({ ok: true, list: [
      { kind: 'image', name: 'loi.png', size: PNG.length, mime: 'image/png', path: s.file, copy: true, up: s.id, origPath: join(desk, 'loi.png') },
    ] });
  });

  test('v2.7 §5.1 / §10.2 A9 a copy\'s path in the send is its realpath (attach root behind a symlink, like /var → /private/var)', async () => {
    mkdirSync(env.attach, { recursive: true });
    const link = join(env.tmp, 'attach-link');
    symlinkSync(env.attach, link);
    process.env.CC_SLAVES_ATTACH = link;
    const s = store.put('anh.png', PNG);
    const r = await store.take([{ up: s.id }]);
    if (!r.ok) throw new Error('expected ok');
    expect(r.list[0]!.path).toBe(join(env.attach, s.id, 'anh.png'));
  });
});

describe('§10.2 /attach/path behaviour (fromPath)', () => {
  test('a directory → dir (no copy); a non-image → file (no copy); an image → copied with origPath', async () => {
    const desk = join(env.tmp, 'Desktop');
    mkdirSync(desk);
    writeFileSync(join(desk, 'a.md'), '# a');
    writeFileSync(join(desk, 'b.webp'), WEBP);
    expect(await store.fromPath(desk)).toEqual({ kind: 'dir', name: 'Desktop' });
    expect(await store.fromPath(join(desk, 'a.md'))).toEqual({ kind: 'file', name: 'a.md', size: 3 });
    const img = await store.fromPath(join(desk, 'b.webp'));
    expect(img).toMatchObject({ kind: 'image', name: 'b.webp', size: WEBP.length, origPath: join(desk, 'b.webp') });
    expect(existsSync(join(env.attach))).toBe(true);
    expect(readdirSync(env.attach)).toHaveLength(1);
  });

  test('blocked / not_found / too_big (image > 20 MB)', async () => {
    writeFileSync(join(env.home, 'x.png'), PNG);
    expect(await store.fromPath(join(env.home, 'x.png'))).toEqual({ error: 'blocked' });
    expect(await store.fromPath(join(env.tmp, 'nope'))).toEqual({ error: 'not_found' });
    writeFileSync(join(env.tmp, 'huge.png'), big(21));
    expect(await store.fromPath(join(env.tmp, 'huge.png'))).toEqual({ error: 'too_big' });
    writeFileSync(join(env.tmp, 'huge.bin'), new Uint8Array(21 * MB));
    expect(await store.fromPath(join(env.tmp, 'huge.bin'))).toEqual({ kind: 'file', name: 'huge.bin', size: 21 * MB });
  });
});

describe('§10.2 sweep()', () => {
  const age = (id: string, hours: number) => { const t = (Date.now() - hours * 3600_000) / 1000; utimesSync(join(env.attach, id), t, t); };

  test('an unreferenced copy older than 24 h is deleted; a younger one stays', async () => {
    const old = store.put('old.png', PNG);
    const young = store.put('young.png', PNG);
    age(old.id, 25);
    age(young.id, 23);
    expect(store.sweep()).toBe(1);
    expect(existsSync(join(env.attach, old.id))).toBe(false);
    expect(existsSync(join(env.attach, young.id))).toBe(true);
  });

  test('a copy an outbox row names, or one taken by a send, survives 24 h; at startup > 14 days goes anyway', async () => {
    const named = store.put('named.png', PNG);
    const taken = store.put('taken.png', PNG);
    refs.add(named.id);
    expect((await store.take([{ up: taken.id }])).ok).toBe(true);
    age(named.id, 48);
    age(taken.id, 48);
    expect(store.sweep()).toBe(0);
    expect(store.sweep({ startup: true })).toBe(0);
    age(named.id, 15 * 24);
    age(taken.id, 13 * 24);
    expect(store.sweep()).toBe(0);
    expect(store.sweep({ startup: true })).toBe(1);
    expect(existsSync(join(env.attach, named.id))).toBe(false);
    expect(existsSync(join(env.attach, taken.id))).toBe(true);
  });

  test('entries that are not an engine id are never touched; a missing root is fine', async () => {
    expect(store.sweep({ startup: true })).toBe(0);
    mkdirSync(join(env.attach, 'keep-me'), { recursive: true });
    const t = (Date.now() - 30 * 24 * 3600_000) / 1000;
    utimesSync(join(env.attach, 'keep-me'), t, t);
    expect(store.sweep({ startup: true })).toBe(0);
    expect(existsSync(join(env.attach, 'keep-me'))).toBe(true);
  });
});
