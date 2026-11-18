// v2.4 §6.5 / §10.2 the attachment store: copies under `<attachRoot>/<id>/<name>` (0700 / 0600), the `send` check, sweep().
// Only metadata leaves this module; bytes are never logged. R4: a path the PO gave is only touched async (a TCC prompt must
// not freeze the engine); the copies under our own `attachRoot` are read sync.
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readdirSync, readSync, realpathSync, rmSync, statSync } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { paths, writeFileSecure } from '../paths.ts';
import { checkPath } from './blocked.ts';

const MB = 1024 * 1024;
/** §10.2: an upload ≤ 50 MB, an image ≤ 20 MB; a send ≤ 20 items and ≤ 40 MB of images. */
export const LIMITS = { upload: 50 * MB, image: 20 * MB, sendImages: 40 * MB, sendItems: 20 } as const;
const HOUR = 3600_000;
const STALE_MS = 24 * HOUR;
const STARTUP_MS = 14 * 24 * HOUR;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** `writeFileSecure`'s in-flight temp file next to the copy. */
const TMP_RE = /^\.[0-9a-f]{12}\.tmp$/;

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
export type AttachError = 'blocked' | 'not_found' | 'too_big';

const ascii = (b: Uint8Array, at: number, s: string): boolean => [...s].every((c, i) => b[at + i] === c.charCodeAt(0));

/** §6.4 the four image types, by first bytes only (an extension proves nothing). */
export function imageMime(b: Uint8Array): ImageMime | null {
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x)) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a'))) return 'image/gif';
  if (b.length >= 12 && ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return 'image/webp';
  return null;
}

/** First 16 bytes of one of our copies. */
function head(file: string): Uint8Array {
  const fd = openSync(file, 'r');
  try {
    const b = new Uint8Array(16);
    return b.subarray(0, readSync(fd, b, 0, 16, 0));
  } finally { closeSync(fd); }
}

/** First 16 bytes of a file the PO named (R4: async). */
async function userHead(file: string): Promise<Uint8Array> {
  const fh = await open(file, 'r');
  try {
    const { bytesRead, buffer } = await fh.read(new Uint8Array(16), 0, 16, 0);
    return buffer.subarray(0, bytesRead);
  } finally { await fh.close(); }
}

/** §10.2 basename; no `/ \ NUL`, control chars or newlines; never `.` / `..`; ≤ 255 bytes on a character boundary. */
export function cleanName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  let n = (raw.split(/[/\\]/).pop() ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '');
  while (Buffer.byteLength(n) > 255) n = [...n].slice(0, -1).join('');
  return n === '' || n === '.' || n === '..' ? 'file' : n;
}

export interface Stored {
  id: string; name: string; size: number; kind: 'image' | 'file'; mime?: ImageMime;
  /** The copy on disk. */
  file: string;
  /** The Finder file an image was copied from (§6.4 path line). */
  origPath?: string;
}

/** One `send` attachment as metadata for the outbox row (§10.2 column `attachments`). */
export interface SendAttachment {
  kind: 'image' | 'file'; name: string; size: number; mime?: ImageMime;
  /** What Claude reads: the copy for `up`, the real path for `path`. */
  path: string;
  copy: boolean; up?: string; origPath?: string;
}

export type SendItem = { up: string } | { path: string };
export type FromPath = Stored | { kind: 'dir'; name: string } | { kind: 'file'; name: string; size: number } | { error: AttachError };

export interface AttachStoreDeps {
  /** Ids an outbox row still names (they survive the 24 h sweep and cannot be removed). */
  referenced: () => ReadonlySet<string>;
}

export class AttachStore {
  /** `up` ids a `send` took (one use each, §10.2); the outbox row keeps them referenced after a restart. */
  private readonly taken = new Set<string>();
  private readonly orig = new Map<string, string>();

  constructor(private readonly d: AttachStoreDeps) {}

  private attached(id: string): boolean { return this.taken.has(id) || this.d.referenced().has(id); }

  /** Writes one new copy (a paste, an upload, a Finder image). */
  put(rawName: string, bytes: Uint8Array, origPath?: string): Stored {
    const id = randomUUID();
    const name = cleanName(rawName);
    const file = join(paths().attachRoot, id, name);
    writeFileSecure(file, bytes);
    if (origPath) this.orig.set(id, origPath);
    const mime = imageMime(bytes.subarray(0, 16));
    return { id, name, size: bytes.length, kind: mime ? 'image' : 'file', ...(mime ? { mime } : {}), file, ...(origPath ? { origPath } : {}) };
  }

  get(id: string): Stored | null {
    if (!ID_RE.test(id)) return null;
    const dir = join(paths().attachRoot, id);
    let name: string | undefined;
    try { name = readdirSync(dir).find((n) => !TMP_RE.test(n)); } catch { return null; }
    if (!name) return null;
    const file = join(dir, name);
    let size: number;
    let mime: ImageMime | null;
    try { size = statSync(file).size; mime = imageMime(head(file)); } catch { return null; }
    const origPath = this.orig.get(id);
    return { id, name, size, kind: mime ? 'image' : 'file', ...(mime ? { mime } : {}), file, ...(origPath ? { origPath } : {}) };
  }

  /** §10.2 DELETE: only a copy no message holds. */
  remove(id: string): 'ok' | 'not_found' | 'attached' {
    if (!this.get(id)) return 'not_found';
    if (this.attached(id)) return 'attached';
    this.drop(id);
    return 'ok';
  }

  /** v2.4 §6.5 the message holding these copies is delivered (images) or its session ended (file copies). */
  discard(ids: readonly string[]): void {
    for (const id of ids) {
      if (!ID_RE.test(id)) continue;
      this.drop(id);
      this.taken.delete(id);
    }
  }

  private drop(id: string): void {
    rmSync(join(paths().attachRoot, id), { recursive: true, force: true });
    this.orig.delete(id);
  }

  /** §10.2 POST /attach/path: a dir or a file is only described; an image is copied now (its source may vanish, §6.5). */
  async fromPath(p: string): Promise<FromPath> {
    const c = await checkPath(p);
    if (!c.ok) return { error: c.reason };
    let st;
    try { st = await stat(c.real); } catch { return { error: 'not_found' }; }
    const name = cleanName(basename(c.real));
    if (st.isDirectory()) return { kind: 'dir', name };
    if (!st.isFile()) return { error: 'not_found' };
    let bytes: Uint8Array;
    try {
      if (!imageMime(await userHead(c.real))) return { kind: 'file', name, size: st.size };
      if (st.size > LIMITS.image) return { error: 'too_big' };
      bytes = await readFile(c.real);
    } catch { return { error: 'not_found' }; }
    if (bytes.length > LIMITS.image) return { error: 'too_big' }; // grew between stat and read
    return this.put(name, bytes, c.real);
  }

  /** §10.2 the `send` check: ≤ 20 items, images ≤ 40 MB in total, each `up` existing and unused, each `path` an allowed
   * file. All or nothing: a failure names the first bad index and takes nothing. The claim re-checks every `up` after the
   * last await, so two sends racing over a pending `path` read never both take one copy. */
  async take(items: readonly SendItem[]): Promise<{ ok: true; list: SendAttachment[] } | { ok: false; index: number }> {
    if (items.length > LIMITS.sendItems) return { ok: false, index: LIMITS.sendItems };
    const list: SendAttachment[] = [];
    const ups = new Set<string>();
    let images = 0;
    for (const [index, item] of items.entries()) {
      const a = await this.item(item, ups);
      if (!a) return { ok: false, index };
      if (a.kind === 'image') images += a.size;
      if (images > LIMITS.sendImages) return { ok: false, index };
      list.push(a);
    }
    const lost = list.findIndex((a) => a.up !== undefined && this.attached(a.up));
    if (lost >= 0) return { ok: false, index: lost };
    for (const id of ups) this.taken.add(id);
    return { ok: true, list };
  }

  private async item(item: SendItem, ups: Set<string>): Promise<SendAttachment | null> {
    const keys = Object.keys(item);
    if (keys.length !== 1) return null;
    if ('up' in item && typeof item.up === 'string') {
      if (ups.has(item.up) || this.attached(item.up)) return null;
      const s = this.get(item.up);
      if (!s) return null;
      let real: string; // v2.7 §5.1 / A9 the line names the copy by its realpath, like a dropped file (/var → /private/var)
      try { real = realpathSync(s.file); } catch { return null; }
      ups.add(s.id);
      return { kind: s.kind, name: s.name, size: s.size, ...(s.mime ? { mime: s.mime } : {}), path: real, copy: true, up: s.id, ...(s.origPath ? { origPath: s.origPath } : {}) };
    }
    if ('path' in item && typeof item.path === 'string') {
      const c = await checkPath(item.path);
      if (!c.ok) return null;
      let st;
      try { st = await stat(c.real); } catch { return null; }
      if (!st.isFile()) return null;
      return { kind: 'file', name: cleanName(basename(c.real)), size: st.size, path: c.real, copy: false };
    }
    return null;
  }

  /** §10.2 hourly: an unreferenced copy older than 24 h (dir mtime) goes; at startup anything older than 14 days goes too.
   * Entries that are not an engine id are never touched. Returns how many were deleted. */
  sweep(o: { startup?: boolean } = {}): number {
    const root = paths().attachRoot;
    let names: string[];
    try { names = readdirSync(root); } catch { return 0; }
    const now = Date.now();
    let n = 0;
    for (const id of names) {
      if (!ID_RE.test(id)) continue;
      let age: number;
      try { age = now - statSync(join(root, id)).mtimeMs; } catch { continue; }
      if ((o.startup && age > STARTUP_MS) || (age > STALE_MS && !this.attached(id))) {
        this.drop(id);
        this.taken.delete(id);
        n++;
      }
    }
    return n;
  }
}
