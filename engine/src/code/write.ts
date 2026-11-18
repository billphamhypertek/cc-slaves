// v2.3 §10.2 fs_write / §5.3 Lưu: lock check (realpath, right before the write), lstat symlink → forbidden, sha1 of the
// disk bytes vs `baseHash` → `conflict` (with the disk file), missing → `gone` unless `recreate`, the text rejoined with the
// `eol` / `bom` of when it was opened (an existing file: they must equal the disk's, else `forbidden`), then an atomic temp file in the same dir + rename that keeps the file mode.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { FsWriteReq, FsWriteResult } from '../../../shared/protocol.ts';
import { checkPath, forbidden } from './path.ts';
import { classify, editable, readBytes, sameParent, TEXT_MAX } from './read.ts';
import { checkLock, type LockState, type Root } from './src.ts';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** LF text from the editor → the bytes of the file as opened (a lone CR stays, `\n` becomes the file's line end). */
function encodeText(text: string, eol: FsWriteReq['eol'], bom: boolean): Buffer {
  const body = Buffer.from(eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text, 'utf8');
  return bom ? Buffer.concat([BOM, body]) : body;
}

export function writeFile(r: Root, q: FsWriteReq, lock: () => LockState): FsWriteResult {
  checkLock(r, lock());
  const p = checkPath(r.root, q.path, { allowMissing: true });
  const lst = lstatOrNull(p.joined);
  if (lst?.isSymbolicLink()) throw forbidden();
  let mode = 0o644;
  if (lst === null || !p.exists) {
    if (!q.recreate) return { ok: false, code: 'gone' };
  } else {
    if (!lst.isFile()) throw forbidden();
    const disk = classify(p.real, readBytes(p.real));
    if (disk.hash !== q.baseHash) return { ok: false, code: 'conflict', disk };
    if (!editable(disk) || disk.eol !== q.eol || disk.bom !== q.bom) throw forbidden();
    mode = lst.mode & 0o7777;
  }
  const bytes = encodeText(q.text, q.eol, q.bom);
  if (bytes.length > TEXT_MAX) throw forbidden();
  checkLock(r, lock());
  const tmp = join(dirname(p.real), `.${basename(p.real)}.cc-slaves-${randomBytes(6).toString('hex')}.tmp`);
  sameParent(p.real); // a parent swapped for a symlink since checkPath (residual µs window accepted: no openat in Bun)
  try {
    writeFileSync(tmp, bytes, { flag: 'wx', mode });
    chmodSync(tmp, mode);
    sameParent(p.real);
    renameSync(tmp, p.real);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return { ok: true, hash: createHash('sha1').update(bytes).digest('hex') };
}

function lstatOrNull(p: string) {
  try { return lstatSync(p); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}
