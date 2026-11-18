// spec v2.9 §5.9 the author drafts on disk: `<home>/workflow-drafts/<draftId>/` = `pack/` (the draft, the session's cwd),
// `examples/<slug>/` (read-only copies of the three built-ins), `settings.json` + `mcp.json` (author-args.ts) and `meta.json`
// (the pack it edits + `baseRev`, the Claude session id to resume, the account, the chat). The engine reads nothing but
// `pack/`, and of it only the §5.1 files (a stray file is a V11 finding, never saved).
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DraftLine, DraftView } from '../../../shared/workflows.ts';
import { ensureDir, writeFileSecure } from '../paths.ts';
import { BUILTIN_SLUGS, builtinFiles } from './builtin/index.ts';
import { draftMcpConfig, draftSettings } from './author-args.ts';
import { signature } from './library.ts';
import { readPackDir, type PackFiles, type PackIssue } from './pack.ts';

/** What survives an engine restart (§4.10 "Nháp sống qua khởi động lại app"). */
export interface DraftMeta {
  id: string;
  fromId: string | null;
  baseRev: string | null;
  base: PackFiles;
  sessionId: string;
  /** The Claude conversation exists (next spawn = `--resume`). */
  started: boolean;
  account: string | null;
  model: string | null;
  lines: DraftLine[];
}

const ID_RE = /^[a-z0-9-]{8,64}$/;
/** §5.1 the files a pack holds: `WORKFLOW.md`, `steps/<id>.md`, `.layout.json`. */
const isPackFile = (p: string): boolean => p === 'WORKFLOW.md' || p === '.layout.json' || /^steps\/[^/]+\.md$/.test(p);

/** §4.10 the paths added / changed / removed against the files the draft opened with. */
export function diffFiles(base: PackFiles, files: PackFiles): DraftView['changed'] {
  const real = (f: PackFiles) => Object.keys(f).filter((p) => p !== '.layout.json');
  return {
    added: real(files).filter((p) => !(p in base)).sort(),
    changed: real(files).filter((p) => p in base && base[p] !== files[p]).sort(),
    removed: real(base).filter((p) => !(p in files)).sort(),
  };
}

export class DraftDisk {
  constructor(private readonly root: string) {}

  dir(id: string): string {
    if (!ID_RE.test(id)) throw new Error(`bad draft id ${id}`);
    return join(this.root, id);
  }
  packDir(id: string): string { return join(this.dir(id), 'pack'); }
  /** A tool's file path as the pack path: the session sees the real path (macOS `/private/var/…` for `/var/…`), so cut at `<id>/pack/`. */
  rel(id: string, path: string): string {
    const mark = `/${id}/pack/`;
    const i = path.lastIndexOf(mark);
    return i >= 0 ? path.slice(i + mark.length) : path.split('/').pop() ?? path;
  }

  /** A new draft folder: `pack/` = the base files, the examples, the deny settings, `meta.json`. */
  create(meta: DraftMeta): void {
    const d = this.dir(meta.id);
    ensureDir(join(d, 'pack'));
    for (const [p, text] of Object.entries(meta.base)) writeFileSecure(join(d, 'pack', p), text);
    for (const slug of BUILTIN_SLUGS) for (const [p, text] of Object.entries(builtinFiles(slug))) writeFileSecure(join(d, 'examples', slug, p), text);
    writeFileSecure(join(d, 'settings.json'), JSON.stringify(draftSettings(d), null, 2));
    this.saveMeta(meta);
  }

  /** Each spawn: a fresh token for `/mcp-draft`. */
  writeMcp(id: string, port: number, token: string): void {
    writeFileSecure(join(this.dir(id), 'mcp.json'), JSON.stringify(draftMcpConfig(port, token), null, 2));
  }

  saveMeta(meta: DraftMeta): void { writeFileSecure(join(this.dir(meta.id), 'meta.json'), JSON.stringify(meta)); }

  /** Every draft folder with a readable meta (boot); a folder without one is left over and goes. */
  loadAll(): DraftMeta[] {
    let names: string[];
    try { names = readdirSync(this.root); } catch { return []; }
    const out: DraftMeta[] = [];
    for (const n of names.sort()) {
      if (!ID_RE.test(n)) continue;
      try { out.push(JSON.parse(readFileSync(join(this.root, n, 'meta.json'), 'utf8')) as DraftMeta); } catch { this.remove(n); }
    }
    return out;
  }

  /** `pack/` now: the §5.1 files only; a stray file / folder / symlink is a V11 finding. */
  read(id: string): { files: PackFiles; errors: PackIssue[] } {
    const r = readPackDir(this.packDir(id));
    const files: PackFiles = {};
    const errors = [...r.errors];
    for (const [p, text] of Object.entries(r.files)) {
      if (isPackFile(p)) files[p] = text;
      else errors.push({ code: 'V11', file: p, msg: `\`${p}\` không thuộc gói (chỉ WORKFLOW.md, steps/<id>.md)` });
    }
    return { files, errors };
  }

  signature(id: string): string { return signature(this.packDir(id)); }

  /** A hand edit (§4.10): the §5.1 files of `next` written, the ones gone from it removed. */
  write(id: string, prev: PackFiles, next: PackFiles): void {
    const d = this.packDir(id);
    for (const [p, text] of Object.entries(next)) if (isPackFile(p) && prev[p] !== text) writeFileSecure(join(d, p), text);
    for (const p of Object.keys(prev)) if (!(p in next) && isPackFile(p)) rmSync(join(d, p), { force: true });
  }

  remove(id: string): void { if (existsSync(join(this.root, id))) rmSync(join(this.root, id), { recursive: true, force: true }); }
}
