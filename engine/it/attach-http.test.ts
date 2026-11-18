// v2.4 §10.2 / §13 IT rows on `/attach*`: the real Bun server with a real AttachStore on temp dirs.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'bun';
import { attachRoute } from '../src/attach/routes.ts';
import { AttachStore } from '../src/attach/store.ts';
import { startHttp } from '../src/server/http.ts';
import type { WsHub } from '../src/server/ws.ts';
import { attachEnv, PNG, type AttachEnv } from '../test/attach/_env.ts';

let env: AttachEnv;
let server: Server<unknown>;
let store: AttachStore;
let refs: Set<string>;
let base: string;
const hub = { open() {}, close() {}, message: async () => {} } as unknown as WsHub;

beforeAll(() => {
  env = attachEnv();
  refs = new Set();
  store = new AttachStore({ referenced: () => refs });
  server = startHttp({
    port: 0, token: () => 'tok', staticDir: null, mcp: async () => new Response('x'), mcpProxy: async () => new Response('p'),
    oauthCallback: async () => new Response('cb'), hub, attach: (r) => attachRoute(r, store),
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => { void server.stop(true); env.restore(); });
beforeEach(() => refs.clear());

const auth = { authorization: 'Bearer tok' };
const app = () => ({ ...auth, origin: base });
const upload = (name: string, body: Uint8Array, h: Record<string, string> = app()) =>
  fetch(`${base}/attach`, { method: 'POST', headers: { ...h, 'x-attach-name': encodeURIComponent(name) }, body });
async function rawRequest(text: string): Promise<string> {
  let out = '';
  const done = Promise.withResolvers<void>();
  const sock = await Bun.connect({ hostname: '127.0.0.1', port: server.port!, socket: { data: (_s, d) => { out += d.toString(); if (out.includes('\r\n\r\n')) done.resolve(); }, close: () => done.resolve(), error: () => done.resolve() } });
  sock.write(text);
  await Promise.race([done.promise, Bun.sleep(1000)]);
  await Bun.sleep(20);
  sock.end();
  return out;
}
const byPath = (path: unknown) => fetch(`${base}/attach/path`, { method: 'POST', headers: { ...app(), 'content-type': 'application/json' }, body: JSON.stringify({ path }) });

describe('§10.2 auth on /attach*', () => {
  test('no token → 401; `?token=` is not accepted; wrong token → 401', async () => {
    expect((await fetch(`${base}/attach`, { method: 'POST', headers: { origin: base }, body: PNG })).status).toBe(401);
    expect((await fetch(`${base}/attach?token=tok`, { method: 'POST', headers: { origin: base }, body: PNG })).status).toBe(401);
    expect((await fetch(`${base}/attach`, { method: 'POST', headers: { authorization: 'Bearer nope', origin: base }, body: PNG })).status).toBe(401);
    expect((await fetch(`${base}/attach/00000000-0000-4000-8000-000000000000`)).status).toBe(401);
  });

  test('POST / DELETE with a foreign Origin (or none) → 403; GET needs only the token', async () => {
    expect((await upload('a.png', PNG, { ...auth, origin: 'http://evil.test' })).status).toBe(403);
    expect((await upload('a.png', PNG, auth)).status).toBe(403);
    const ok = await (await upload('a.png', PNG)).json() as { id: string };
    expect((await fetch(`${base}/attach/${ok.id}`, { method: 'DELETE', headers: { ...auth, origin: 'http://evil.test' } })).status).toBe(403);
    expect((await fetch(`${base}/attach/${ok.id}`, { headers: auth })).status).toBe(200);
  });

  test('a foreign Host → 421 before any auth (DNS rebinding)', async () => {
    const out = await rawRequest('GET /attach/00000000-0000-4000-8000-000000000000 HTTP/1.1\r\nHost: evil.test\r\nAuthorization: Bearer tok\r\nConnection: close\r\n\r\n');
    expect(out).toStartWith('HTTP/1.1 421');
  });
});

describe('§10.2 POST /attach', () => {
  test('stores the bytes under a uuid with a cleaned name (`../x` → `x`); kind from the first bytes', async () => {
    const r = await upload('../x.png', PNG);
    expect(r.status).toBe(200);
    const j = await r.json() as { id: string; name: string; size: number; kind: string };
    expect(j).toMatchObject({ name: 'x.png', size: PNG.length, kind: 'image' });
    expect(readdirSync(join(env.attach, j.id))).toEqual(['x.png']);
    const f = await (await upload('fake.png', new TextEncoder().encode('<html>'))).json() as { kind: string };
    expect(f.kind).toBe('file');
  });

  test('Content-Length > 50 MB → 413 too_big before the body is read; an image > 20 MB → 413', async () => {
    // fetch rewrites Content-Length from the body: a raw socket declares 50 MB + 1 and sends 8 bytes; the answer comes anyway
    const raw = await rawRequest(`POST /attach HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nAuthorization: Bearer tok\r\nOrigin: ${base}\r\nX-Attach-Name: a.bin\r\nContent-Length: ${50 * 1024 * 1024 + 1}\r\n\r\n12345678`);
    expect(raw).toStartWith('HTTP/1.1 413');
    expect(raw).toContain('{"error":"too_big"}');
    const before = existsSync(env.attach) ? readdirSync(env.attach).length : 0;
    const img = new Uint8Array(20 * 1024 * 1024 + 1); img.set(PNG);
    const r2 = await upload('big.png', img);
    expect(r2.status).toBe(413);
    expect(await r2.json()).toEqual({ error: 'too_big' });
    expect(existsSync(env.attach) ? readdirSync(env.attach).length : 0).toBe(before);
  });

  test('a bad percent-encoded name → 400 bad_input', async () => {
    const r = await fetch(`${base}/attach`, { method: 'POST', headers: { ...app(), 'x-attach-name': '%E0%A4%A' }, body: PNG });
    expect(r.status).toBe(400);
  });
});

describe('§10.2 GET / DELETE /attach/<id>', () => {
  test('GET an image → its bytes, Content-Type by first bytes, nosniff; a file copy → 404', async () => {
    const img = await (await upload('a.dat', PNG)).json() as { id: string };
    const g = await fetch(`${base}/attach/${img.id}`, { headers: auth });
    expect(g.headers.get('content-type')).toBe('image/png');
    expect(g.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await g.arrayBuffer())).toEqual(PNG);
    const html = await (await upload('x.html', new TextEncoder().encode('<script>alert(1)</script>'))).json() as { id: string };
    expect((await fetch(`${base}/attach/${html.id}`, { headers: auth })).status).toBe(404);
  });

  test('a malformed id → 404 (checked before any path join)', async () => {
    for (const id of ['..%2F..%2Fhome', 'abc', '00000000-0000-4000-8000-00000000000Z']) {
      expect((await fetch(`${base}/attach/${id}`, { headers: auth })).status).toBe(404);
      expect((await fetch(`${base}/attach/${id}`, { method: 'DELETE', headers: app() })).status).toBe(404);
    }
  });

  test('DELETE an unattached copy → 204 and gone; one attached to a message → 409', async () => {
    const a = await (await upload('a.png', PNG)).json() as { id: string };
    expect((await fetch(`${base}/attach/${a.id}`, { method: 'DELETE', headers: app() })).status).toBe(204);
    expect(existsSync(join(env.attach, a.id))).toBe(false);
    const b = await (await upload('b.png', PNG)).json() as { id: string };
    refs.add(b.id);
    expect((await fetch(`${base}/attach/${b.id}`, { method: 'DELETE', headers: app() })).status).toBe(409);
  });
});

describe('§10.2 POST /attach/path', () => {
  test('a path inside a blocked root → 403 blocked; missing → 404 not_found; relative → blocked', async () => {
    writeFileSync(join(env.home, 'config.json'), '{}');
    const r = await byPath(join(env.home, 'config.json'));
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'blocked' });
    expect(await (await byPath(join(env.tmp, 'nope'))).json()).toEqual({ error: 'not_found' });
    expect(await (await byPath('config.json')).json()).toEqual({ error: 'blocked' });
    expect((await byPath(42)).status).toBe(400);
  });

  test('a directory → kind dir; a file → kind file (no copy); an image → copied like POST /attach', async () => {
    const desk = join(env.tmp, 'Desktop');
    mkdirSync(desk, { recursive: true });
    writeFileSync(join(desk, 'a.xlsx'), 'xx');
    writeFileSync(join(desk, 'shot.png'), PNG);
    expect(await (await byPath(desk)).json()).toEqual({ kind: 'dir', name: 'Desktop' });
    expect(await (await byPath(join(desk, 'a.xlsx'))).json()).toEqual({ kind: 'file', name: 'a.xlsx', size: 2 });
    const img = await (await byPath(join(desk, 'shot.png'))).json() as { id: string; kind: string; name: string; size: number };
    expect(img).toMatchObject({ kind: 'image', name: 'shot.png', size: PNG.length });
    expect(existsSync(join(env.attach, img.id, 'shot.png'))).toBe(true);
  });
});
