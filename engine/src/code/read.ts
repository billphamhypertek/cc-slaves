// v2.3 §10.2 fs_read + §5.2 Mã hoá (V20) / Lớn / Nhị phân / ảnh. Engine limits (the web sends no `max`): text 2 MB,
// image 5 MB. `hash` = sha1 of every byte on disk up to 5 MB; above that (never editable) only the head is read and
// `hash` = sha1(`size:mtimeMs:` + head), so a 3 GB asset does not block the event loop (review MINOR-4). Text comes back with LF line ends; `eol` / `bom` let fs_write rejoin
// byte-exact. Only valid UTF-8 with one line-end style is editable; the rest is `readOnly`.
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, readSync, realpathSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import type { Eol, FsReadResult } from '../../../shared/protocol.ts';
import { forbidden, openChecked } from './path.ts';

export const TEXT_MAX = 2 * 1024 * 1024;
const IMAGE_MAX = 5 * 1024 * 1024;
const BINARY_SNIFF = 8 * 1024;
const LONG_LINE = 20_000;
const BOM = [0xef, 0xbb, 0xbf];
const IMAGE_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};

export interface Bytes { head: Uint8Array; size: number; hash: string }

/** The parent of a checked realpath must still be itself (no component swapped for a symlink since `checkPath`). */
export function sameParent(real: string): void {
  const d = dirname(real);
  let now: string;
  try { now = realpathSync.native(d); } catch { throw forbidden(); }
  if (now !== d) throw forbidden();
}

/** Reads a regular file through `openChecked`, keeps the first `keep` bytes; sha1 of all bytes up to IMAGE_MAX, else of size + mtime + head. */
export function readBytes(real: string, keep = IMAGE_MAX): Bytes {
  sameParent(real);
  const lst = lstatSync(real);
  if (!lst.isFile()) throw forbidden();
  const fd = openChecked(real, lst);
  try {
    const h = createHash('sha1');
    const whole = lst.size <= IMAGE_MAX;
    if (!whole) h.update(`${lst.size}:${lst.mtimeMs}:`);
    const head = new Uint8Array(Math.min(lst.size, keep));
    const chunk = new Uint8Array(1 << 20);
    let size = 0;
    for (let n: number; (whole || size < head.length) && (n = readSync(fd, chunk, 0, chunk.length, null)) > 0;) {
      if (whole) h.update(chunk.subarray(0, n));
      if (size < head.length) head.set(chunk.subarray(0, Math.min(n, head.length - size)), size);
      size += n;
    }
    if (!whole) { h.update(head); size = lst.size; }
    return { head: size < head.length ? head.subarray(0, size) : head, size, hash: h.digest('hex') };
  } finally {
    closeSync(fd);
  }
}

const hasBom = (b: Uint8Array) => b.length >= 3 && BOM.every((x, i) => b[i] === x);

/** Line-end style of decoded text: CRLF pairs vs lone LF. */
function eolOf(s: string): { eol: Eol; mixed: boolean } {
  const crlf = s.split('\r\n').length - 1;
  const lf = s.split('\n').length - 1 - crlf;
  return { eol: crlf > 0 && lf === 0 ? 'crlf' : 'lf', mixed: crlf > 0 && lf > 0 };
}

const longestLine = (s: string) => s.split('\n').reduce((m, l) => Math.max(m, l.length), 0);

export function classify(path: string, b: Bytes): FsReadResult {
  const { head, size, hash } = b;
  const mime = IMAGE_MIME[extname(path).toLowerCase()];
  if (mime && size <= IMAGE_MAX) return { kind: 'image', dataUrl: `data:${mime};base64,${Buffer.from(head).toString('base64')}`, size, hash };
  if (head.subarray(0, BINARY_SNIFF).includes(0)) return { kind: 'binary', size, hash };
  if (size > TEXT_MAX) {
    return { kind: 'large', text: new TextDecoder('utf-8').decode(head.subarray(0, TEXT_MAX)).replace(/\r\n/g, '\n'), size, hash };
  }
  const bom = hasBom(head);
  const body = bom ? head.subarray(3) : head;
  let raw: string;
  let notUtf8 = false;
  try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body); } catch {
    raw = new TextDecoder('utf-8', { ignoreBOM: true }).decode(body);
    notUtf8 = true;
  }
  const { eol, mixed } = eolOf(raw);
  const text = raw.replace(/\r\n/g, '\n');
  if (longestLine(text) > LONG_LINE) return { kind: 'large', text, size, hash };
  const readOnly = notUtf8 ? 'not_utf8' : mixed ? 'mixed_eol' : undefined;
  return { kind: 'text', text, size, hash, eol, bom, ...(readOnly ? { readOnly } : {}) };
}

/** §5.3 ①: a file the PO may edit = UTF-8 text ≤ 2 MB, one line-end style. */
export const editable = (r: FsReadResult) => r.kind === 'text' && r.readOnly === undefined;
