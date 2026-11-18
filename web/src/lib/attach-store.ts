// v2.4 §6.1–§6.3 the composer's chip store (lazy chunk, loaded by ui/useAttachments.ts with the first paste / drop): one
// chip per paste / file (§6.1), the limits 20 items / 20 MB an image / 40 MB of images / 50 MB a copy (§6.2), the upload at
// attach time (§6.3). The engine side is `/attach*` (engine/src/attach/routes.ts); a thumbnail is always a `blob:` URL (a
// `File`, or `GET /attach/<id>` fetched with the Bearer header), never an `<img src>` on the engine. Every blob URL is
// revoked on remove / send / dispose.

const MB = 1024 * 1024;
/** §6.2 limits (the engine's `LIMITS` in attach/store.ts are the same numbers; it checks again at `send`). */
export const ATTACH = { items: 20, image: 20 * MB, images: 40 * MB, copy: 50 * MB, tooManyMs: 6000 } as const;
/** §6.2 the error-chip reasons (`attach.why.*`). */
export type AttWhy = 'tooBig' | 'imagesTotal' | 'copyTooBig' | 'unreadable' | 'dir' | 'blocked' | 'expired';

export interface Att {
  key: number;
  kind: 'image' | 'file';
  name: string;
  size: number;
  /** §6.2 a file with no original path (pasted, or any file in a plain browser): the "bản sao" tag. */
  copy: boolean;
  /** an absolute path from a Tauri drop: a file goes as `{ path }` (no copy, no spinner). */
  path?: string;
  /** the engine copy id (`POST /attach` or an image through `POST /attach/path`): goes as `{ up }`. */
  up?: string;
  thumb?: string;
  /** busy = upload / path check running (send locked; a spinner on images only), bad = §6.2 error chip, fail = DK5b. */
  st: 'busy' | 'ok' | 'bad' | 'fail';
  why?: AttWhy;
}
export type SendItem = { up: string } | { path: string };

interface Meta { id: string; name: string; size: number; kind: 'image' | 'file' }
type PathMeta = Meta | { kind: 'file' | 'dir'; name: string; size?: number };
export class AttachHttpError extends Error { constructor(readonly status: number) { super(`attach ${status}`); } }
export interface AttachApi {
  upload(body: Blob, name: string): Promise<Meta>;
  byPath(path: string): Promise<PathMeta>;
  image(id: string): Promise<Blob>;
  remove(id: string): Promise<void>;
}

/** §10.1 `/attach*` on the engine's own origin, Bearer only (http.ts refuses `?token=` there). */
export function attachHttp(token: () => string | null, f: (url: string, init?: RequestInit) => Promise<Response> = (u, i) => fetch(u, i)): AttachApi {
  const auth = (): Record<string, string> => { const t = token(); return t ? { authorization: `Bearer ${t}` } : {}; };
  const ok = async (r: Promise<Response>): Promise<Response> => { const res = await r; if (!res.ok) throw new AttachHttpError(res.status); return res; };
  return {
    upload: async (body, name) => (await ok(f('/attach', { method: 'POST', body, headers: { ...auth(), 'x-attach-name': encodeURIComponent(name) } }))).json() as Promise<Meta>,
    byPath: async path => (await ok(f('/attach/path', { method: 'POST', body: JSON.stringify({ path }), headers: { ...auth(), 'content-type': 'application/json' } }))).json() as Promise<PathMeta>,
    image: async id => (await ok(f(`/attach/${encodeURIComponent(id)}`, { headers: auth() }))).blob(),
    remove: async id => { await f(`/attach/${encodeURIComponent(id)}`, { method: 'DELETE', headers: auth() }); },
  };
}

/** what the engine reads as an image (attach/store.ts `imageMime`: PNG / JPEG / GIF / WebP by bytes; HEIC, SVG = file). */
const IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const baseName = (p: string) => p.slice(p.replace(/\/+$/, '').lastIndexOf('/') + 1).replace(/\/+$/, '');
/** §6.3 a pasted image has no name of its own (WebKit / Chromium call it `image.png`). */
const UNNAMED = /^(image\.(png|jpe?g|gif|webp|tiff?))?$/i;
const hhmmss = (d: Date) => [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join('');

/** a chip taken again (busy, no reason, no engine copy yet): what it was attached as, its thumbnail kept. */
const fresh = (a: Att): Att => ({ key: a.key, kind: a.kind, name: a.name, size: a.size, copy: a.copy, st: 'busy', ...(a.path ? { path: a.path } : {}), ...(a.thumb ? { thumb: a.thumb } : {}) });

export interface AttachEnv {
  /** the `/attach*` Bearer token; `api` replaces the HTTP client (tests). */
  token: () => string | null; api?: AttachApi;
  url: { create(b: Blob): string; revoke(u: string): void };
  now: () => Date;
  timers: { set(fn: () => void, ms: number): unknown; clear(h: unknown): void };
  /** `attach.pasteName` with the HH MM SS of the paste. */
  pasteName: (hms: string) => string;
}

export interface AttachState { items: readonly Att[]; dropped: number }

/** The chip list of one composer (§6.1: chips follow the composer like the draft — a target change keeps them). */
export class Attachments {
  private items: Att[] = [];
  private dropped = 0;
  private seq = 0;
  private tooManyT: unknown = null;
  /** what "Thử lại" sends again: the `File`, or the dropped path. */
  private sources = new Map<number, File | string>();
  private snap: AttachState = { items: [], dropped: 0 };
  private subs = new Set<() => void>();
  private api: AttachApi;
  constructor(private env: AttachEnv) { this.api = env.api ?? attachHttp(env.token); }

  subscribe = (f: () => void) => { this.subs.add(f); return () => { this.subs.delete(f); }; };
  get = (): AttachState => this.snap;
  private emit() { this.snap = { items: this.items.slice(), dropped: this.dropped }; for (const f of this.subs) f(); }
  private patch(key: number, p: Partial<Att>): void {
    const i = this.items.findIndex(a => a.key === key);
    if (i < 0) return;
    this.items[i] = { ...this.items[i]!, ...p };
    this.emit();
  }
  private imageBytes(except: number) { return this.items.reduce((s, a) => s + (a.kind === 'image' && a.st !== 'bad' && a.key !== except ? a.size : 0), 0); }

  /** §6.2 DK6: the 21st item on is not a chip; the line says how many went (6 s, or until a chip is removed). */
  private room(n: number): number {
    const fit = Math.max(0, Math.min(n, ATTACH.items - this.items.length));
    if (fit < n) {
      this.dropped = n - fit;
      this.env.timers.clear(this.tooManyT);
      this.tooManyT = this.env.timers.set(() => { this.dropped = 0; this.emit(); }, ATTACH.tooManyMs);
    }
    return fit;
  }

  /** §6.1 `File`s (paste, browser drop): copies, uploaded now. `pasted` names an unnamed image `ảnh-HHMMSS.png`. */
  addFiles(files: readonly File[], pasted = false): void {
    const list = files.slice(0, this.room(files.length));
    for (const f of list) {
      const kind = IMAGE_MIME.test(f.type) ? 'image' : 'file';
      const name = pasted && kind === 'image' && UNNAMED.test(f.name) ? this.env.pasteName(hhmmss(this.env.now())) : f.name;
      const a: Att = { key: ++this.seq, kind, name, size: f.size, copy: true, st: 'busy' };
      if (kind === 'image') a.thumb = this.env.url.create(f);
      const why: AttWhy | null = kind === 'image' ? (f.size > ATTACH.image ? 'tooBig' : this.imageBytes(-1) + f.size > ATTACH.images ? 'imagesTotal' : null)
        : f.size > ATTACH.copy ? 'copyTooBig' : null;
      if (why) { a.st = 'bad'; a.why = why; }
      this.items.push(a);
      this.sources.set(a.key, f);
      if (!why) void this.upload(a.key, f);
    }
    this.emit();
  }

  /** §6.1 / NC §8-20 absolute paths from the Tauri drop: a file stays a path (no spinner); `POST /attach/path` says what it
   *  is (image → a copy + its thumbnail, dir / blocked / unreadable → error chip). */
  addPaths(paths: readonly string[], dirs: readonly string[] = []): void {
    const list = paths.slice(0, this.room(paths.length + dirs.length));
    for (const p of list) {
      const a: Att = { key: ++this.seq, kind: IMAGE_EXT.test(p) ? 'image' : 'file', name: baseName(p), size: 0, copy: false, path: p, st: 'busy' };
      this.items.push(a);
      this.sources.set(a.key, p);
      void this.check(a.key, p);
    }
    for (const n of dirs.slice(0, Math.max(0, ATTACH.items - this.items.length))) this.items.push({ key: ++this.seq, kind: 'file', name: n, size: 0, copy: true, st: 'bad', why: 'dir' });
    this.emit();
  }

  private alive = (key: number) => this.items.some(a => a.key === key);

  private async upload(key: number, f: File) {
    try {
      const m = await this.api.upload(f, this.items.find(a => a.key === key)?.name ?? f.name);
      if (!this.alive(key)) { void this.api.remove(m.id).catch(() => {}); return; } // "×" while it ran: drop the copy
      this.patch(key, { st: 'ok', up: m.id });
    } catch (e) {
      const a = this.items.find(x => x.key === key);
      if (!a) return;
      if (e instanceof AttachHttpError && e.status === 413) this.patch(key, { st: 'bad', why: a.kind === 'image' ? 'tooBig' : 'copyTooBig' });
      else this.patch(key, { st: 'fail' });
    }
  }

  private async check(key: number, path: string) {
    try {
      const m = await this.api.byPath(path);
      if (!this.alive(key)) { if ('id' in m) void this.api.remove(m.id).catch(() => {}); return; }
      if (m.kind === 'dir') { this.patch(key, { st: 'bad', why: 'dir', kind: 'file', name: m.name }); return; }
      if (!('id' in m)) { this.patch(key, { st: 'ok', kind: 'file', name: m.name, size: m.size ?? 0 }); return; }
      if (this.imageBytes(key) + m.size > ATTACH.images) { void this.api.remove(m.id).catch(() => {}); this.patch(key, { st: 'bad', why: 'imagesTotal', kind: 'image', name: m.name, size: m.size }); return; }
      this.patch(key, { kind: 'image', name: m.name, size: m.size, up: m.id });
      const blob = await this.api.image(m.id).catch(() => null);
      if (!this.alive(key)) return;
      this.patch(key, { st: 'ok', ...(blob ? { thumb: this.env.url.create(blob) } : {}) });
    } catch (e) {
      if (!this.alive(key)) return;
      const s = e instanceof AttachHttpError ? e.status : 0;
      if (s === 403) this.patch(key, { st: 'bad', why: 'blocked' });
      else if (s === 404) this.patch(key, { st: 'bad', why: 'unreadable' });
      else if (s === 413) this.patch(key, { st: 'bad', why: 'tooBig', kind: 'image' });
      else this.patch(key, { st: 'fail' });
    }
  }

  /** DK5b "Thử lại"; R21 "đính lại" on an expired copy (no source left → the chip goes). */
  retry(key: number): void {
    const a = this.items.find(x => x.key === key), src = this.sources.get(key);
    if (!a || (a.st !== 'fail' && a.why !== 'expired')) return;
    if (src === undefined) return this.remove(key);
    this.items = this.items.map(x => (x.key === key ? fresh(x) : x));
    this.emit();
    void (typeof src === 'string' ? this.check(key, src) : this.upload(key, src));
  }

  /** R21 §6.4 the engine refused this item at `send`: a copy has expired ("Đã hết hạn · đính lại"), a path is unreadable. */
  expire(key: number): void {
    const a = this.items.find(x => x.key === key);
    if (!a) return;
    const { up: _gone, ...rest } = a;
    this.items = this.items.map(x => (x.key === key ? { ...rest, st: 'bad', why: a.up ? 'expired' : 'unreadable' } : x));
    this.emit();
  }

  /** "×" / T4: the chip goes now, with its blob URL and its unsent engine copy (§6.5 "PO bỏ chip (ngay)"). */
  remove(key: number): void {
    const a = this.items.find(x => x.key === key);
    if (!a) return;
    this.items = this.items.filter(x => x.key !== key);
    this.sources.delete(key);
    if (a.thumb) this.env.url.revoke(a.thumb);
    if (a.up) void this.api.remove(a.up).catch(() => {});
    if (this.dropped) { this.dropped = 0; this.env.timers.clear(this.tooManyT); }
    this.recheckTotal();
    this.emit();
  }
  /** §6.2 a chip refused on the 40 MB total is taken again once the images left leave it room (in chip order). */
  private recheckTotal(): void {
    for (const a of this.items) {
      const src = this.sources.get(a.key);
      if (a.why !== 'imagesTotal' || src === undefined || this.imageBytes(a.key) + a.size > ATTACH.images) continue;
      this.items[this.items.indexOf(a)] = fresh(a);
      void (typeof src === 'string' ? this.check(a.key, src) : this.upload(a.key, src));
    }
  }
  /** §6.2 Backspace in an empty composer: the last chip. */
  removeLast(): boolean { const a = this.items.at(-1); if (a) this.remove(a.key); return !!a; }

  /** §6.3 sent: the chips go, their copies now belong to the message (no DELETE). */
  sent(): void {
    for (const a of this.items) if (a.thumb) this.env.url.revoke(a.thumb);
    this.items = [];
    this.sources.clear();
    this.dropped = 0;
    this.env.timers.clear(this.tooManyT);
    this.emit();
  }
  /** unmount: as "×" on every chip. */
  dispose(): void { for (const a of this.items.slice()) this.remove(a.key); this.env.timers.clear(this.tooManyT); }
}

