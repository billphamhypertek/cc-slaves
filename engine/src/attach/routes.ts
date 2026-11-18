// v2.4 §10.2 `/attach*` on the Mac listener only. `server/http.ts` has already checked the loopback Host, the Bearer token
// and (POST / DELETE) the app Origin. Bodies never reach a log.
import { imageMime, LIMITS, type AttachError, type AttachStore, type Stored } from './store.ts';

const NO_STORE = { 'cache-control': 'no-store' };
const STATUS: Record<AttachError | 'bad_input', number> = { bad_input: 400, blocked: 403, not_found: 404, too_big: 413 };
const PATH_BODY_MAX = 64 * 1024;

const fail = (error: AttachError | 'bad_input'): Response => Response.json({ error }, { status: STATUS[error], headers: NO_STORE });
const meta = (s: Stored) => ({ id: s.id, name: s.name, size: s.size, kind: s.kind });

/** Declared length, or null when missing / not a number (the size is decided before the body is read). */
function declared(req: Request): number | null {
  const v = req.headers.get('content-length');
  return v !== null && /^\d+$/.test(v) ? Number(v) : null;
}

async function upload(req: Request, store: AttachStore): Promise<Response> {
  const len = declared(req);
  if (len === null) return new Response('length required', { status: 411, headers: NO_STORE });
  if (len > LIMITS.upload) return fail('too_big');
  let name: string;
  try { name = decodeURIComponent(req.headers.get('x-attach-name') ?? ''); } catch { return fail('bad_input'); }
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length > LIMITS.upload) return fail('too_big');
  if (bytes.length > LIMITS.image && imageMime(bytes.subarray(0, 16))) return fail('too_big');
  const s = store.put(name, bytes);
  return Response.json(meta(s), { headers: NO_STORE });
}

async function byPath(req: Request, store: AttachStore): Promise<Response> {
  const len = declared(req);
  if (len === null || len > PATH_BODY_MAX) return fail('bad_input');
  let body: unknown;
  try { body = await req.json(); } catch { return fail('bad_input'); }
  const p = (body as { path?: unknown } | null)?.path;
  if (typeof p !== 'string') return fail('bad_input');
  const r = await store.fromPath(p);
  if ('error' in r) return fail(r.error);
  return Response.json('id' in r ? meta(r) : r, { headers: NO_STORE });
}

/** `POST /attach`, `POST /attach/path`, `GET /attach/<id>`, `DELETE /attach/<id>`. */
export async function attachRoute(req: Request, store: AttachStore): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (pathname === '/attach') return req.method === 'POST' ? upload(req, store) : new Response('method not allowed', { status: 405 });
  if (pathname === '/attach/path') return req.method === 'POST' ? byPath(req, store) : new Response('method not allowed', { status: 405 });
  const id = pathname.slice('/attach/'.length);
  if (req.method === 'DELETE') {
    const r = store.remove(id);
    if (r === 'attached') return new Response('attached to a message', { status: 409, headers: NO_STORE });
    return new Response(null, { status: r === 'ok' ? 204 : 404, headers: NO_STORE });
  }
  if (req.method !== 'GET') return new Response('method not allowed', { status: 405 });
  const s = store.get(id); // validates the id before any path join
  // A file copy is never served: an uploaded `.html` / `.svg` must not run on the app's origin.
  if (!s || s.kind !== 'image' || !s.mime) return new Response('not found', { status: 404, headers: NO_STORE });
  return new Response(Bun.file(s.file), { headers: { 'content-type': s.mime, 'x-content-type-options': 'nosniff', ...NO_STORE } });
}
