// spec v2.9 §5.1 / §6.1 / §10.1 the workflow library: the built-ins + `<home>/workflows/<slug>/` (R5, the files are the
// source, R7), the pinned copies `<home>/workflow-revs/<rev>/` (+ `index.json` rev → pack id / name / time), the stat
// signature poll (no fs.watch, G0 2), save with a base rev (WF5c), copy (R9 / R13), import (§4.8), delete to the Trash (R12)
// and the project's workflow (§4.6). Every rev it reads valid is registered in runtime.ts (rulings 22:05).
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BLANK_TEMPLATE, type WorkflowDetail, type WorkflowEdit, type WorkflowEditResult, type WorkflowImportResult, type WorkflowRow, type WorkflowSaveResult } from '../../../shared/workflows.ts';
import type { Db } from '../db.ts';
import { KeyedError } from '../errors.ts';
import { ensureDir, writeFileSecure } from '../paths.ts';
import { moveToTrash } from '../skills/ops.ts';
import { blankFiles, BUILTIN_SLUGS, builtinFiles, type BuiltinSlug } from './builtin/index.ts';
import { compile, type Compiled } from './compile.ts';
import { applyEdits } from './edit.ts';
import { packRev, parsePack, readPackDir, type PackFiles, type PackIssue } from './pack.ts';
import { patchFrontmatter } from './patch.ts';
import { dropWorkflow, hasWorkflow, nameRev, registerWorkflow, repinChung, workflowOf, workflowRev } from './runtime.ts';
import { validatePack, type ValidateEnv } from './validate.ts';

/** A refused library command: `code` is the WS error code, the message a Vietnamese sentence. */
export class WorkflowLibError extends KeyedError {
  constructor(code: string, m: string) { super(code, m); this.name = 'WorkflowLibError'; }
}

export interface LibraryDeps {
  /** The engine home (`CC_SLAVES_HOME`): `workflows/` and `workflow-revs/` live under it. */
  home: string;
  /** The user's home: a deleted pack goes to `<trashHome>/.Trash` (R12). */
  trashHome: string;
  db: Db;
  now?: () => number;
  env?: () => ValidateEnv;
  /** After any change of the rows (a poll found a change, a command wrote): the engine broadcasts `workflows_changed`. */
  onChange?: () => void;
  log?: (line: string) => void;
}

interface IndexRow { id: string; name: string; at: number }
interface Entry {
  id: string; files: PackFiles; diskRev: string; errors: PackIssue[]; warnings: PackIssue[];
  name: string; description: string; basedOn: string | null; rev: string | null; validAt: number | null;
}

const REV_RE = /^[0-9a-f]{64}$/;
const BUILTIN = 'builtin:';
const isRevFile = (p: string) => p === 'WORKFLOW.md' || /^steps\/[^/]+\.md$/.test(p);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** R9 a folder name from a pack name (Vietnamese marks dropped). */
function slugify(name: string): string {
  const s = name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return s || 'quy-trinh';
}

/** Write a pack folder in one step: a dot temp folder beside it, then swapped in (the poll skips dot entries). */
function writePack(dir: string, files: PackFiles): void {
  const parent = join(dir, '..');
  const tmp = join(parent, `.tmp-${randomBytes(6).toString('hex')}`);
  for (const [p, text] of Object.entries(files)) writeFileSecure(join(tmp, p), text);
  const old = existsSync(dir) ? join(parent, `.old-${randomBytes(6).toString('hex')}`) : null;
  if (old) renameSync(dir, old);
  renameSync(tmp, dir);
  if (old) rmSync(old, { recursive: true, force: true });
}

/** §10.1 the stat signature of a pack folder: name + mtimeMs + size of every entry (lstat, never followed). */
export function signature(dir: string): string {
  const out: string[] = [];
  const walk = (rel: string) => {
    let names: string[];
    try { names = readdirSync(join(dir, rel)).sort(); } catch { return; }
    for (const n of names) {
      const p = rel === '' ? n : `${rel}/${n}`;
      const st = lstatSync(join(dir, p), { throwIfNoEntry: false });
      if (!st) continue;
      out.push(`${p}:${st.mtimeMs}:${st.size}:${st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : 'f'}`);
      if (rel === '' && n === 'steps' && st.isDirectory()) walk(p);
    }
  };
  walk('');
  return out.join('\n');
}

export class WorkflowLibrary {
  private readonly users = new Map<string, Entry>();
  private readonly sigs = new Map<string, string>();
  private index: Record<string, IndexRow> = {};
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly d: LibraryDeps) {}

  private get libDir(): string { return join(this.d.home, 'workflows'); }
  private get revsDir(): string { return join(this.d.home, 'workflow-revs'); }
  private get indexPath(): string { return join(this.revsDir, 'index.json'); }
  private now(): number { return (this.d.now ?? Date.now)(); }

  /** §6.1 at engine start, before any session spawns: drop the copies nobody pins, register every stored rev, copy the
   *  built-ins, read the library. */
  boot(): void {
    ensureDir(this.libDir);
    ensureDir(this.revsDir);
    try { this.index = JSON.parse(readFileSync(this.indexPath, 'utf8')) as Record<string, IndexRow>; } catch { this.index = {}; }
    this.gc();
    for (const [rev, r] of Object.entries(this.index)) nameRev(rev, r.name); // a pinned copy gone: its name still
    for (const rev of readdirSync(this.revsDir).filter((n) => REV_RE.test(n))) this.loadRev(rev);
    for (const slug of BUILTIN_SLUGS) this.pinCopy(builtinFiles(slug), `${BUILTIN}${slug}`, workflowOf(`${BUILTIN}${slug}`).name);
    this.scan();
  }

  /** §10.1 poll the library every `everyMs` (2 s); a changed signature re-reads + validates that pack. */
  start(everyMs = 2000): void {
    if (this.timer === null && everyMs > 0) this.timer = setInterval(() => { try { this.scan(); } catch (e) { this.d.log?.(`workflows scan: ${(e as Error).message}`); } }, everyMs);
  }
  stop(): void { if (this.timer !== null) clearInterval(this.timer); this.timer = null; }

  /** One poll pass; true (and `onChange`) when a pack appeared, changed or went away. */
  scan(): boolean {
    let changed = false;
    const seen = new Set<string>();
    for (const slug of readdirSync(this.libDir).sort()) {
      if (slug.startsWith('.') || !lstatSync(join(this.libDir, slug)).isDirectory()) continue;
      seen.add(slug);
      const sig = signature(join(this.libDir, slug));
      if (this.sigs.get(slug) === sig) continue;
      this.sigs.set(slug, sig);
      this.load(slug);
      changed = true;
    }
    for (const slug of [...this.sigs.keys()].filter((s) => !seen.has(s))) {
      this.sigs.delete(slug);
      this.users.delete(slug);
      if (this.lastRev(slug) === null) dropWorkflow(slug); // else a project using it keeps its last valid rev (§6.2 WF5b)
      changed = true;
    }
    if (changed) this.d.onChange?.();
    return changed;
  }

  list(): WorkflowRow[] {
    const builtins = BUILTIN_SLUGS.map((slug) => this.builtinRow(slug));
    const users = [...this.users.values()].sort((a, b) => a.name.localeCompare(b.name, 'vi')).map((e) => this.row(e));
    return [...builtins, ...users];
  }

  /** `workflow_get {id}` = the files on disk; `{rev}` = a pinned rev (Tasks tab, G5). */
  get(q: { id: string } | { rev: string }): WorkflowDetail {
    if ('rev' in q) {
      const c = workflowRev(q.rev);
      const dir = join(this.revsDir, q.rev);
      const files = REV_RE.test(q.rev) && existsSync(dir) ? readPackDir(dir).files : this.builtinOfRev(q.rev);
      return this.detail(c.rev, files, [], [], c);
    }
    if (q.id === BLANK_TEMPLATE) return this.detail(packRev(blankFiles()), blankFiles(), [], [], null);
    if (q.id.startsWith(BUILTIN)) {
      const c = workflowOf(q.id);
      return this.detail(c.rev, builtinFiles(this.slugOf(q.id)), [], [], c);
    }
    const e = this.entry(q.id);
    return this.detail(e.diskRev, e.files, e.errors, e.warnings, e.errors.length === 0 && e.rev !== null ? workflowRev(e.rev) : null);
  }

  /** §4.6 / WF5c write a library pack: refused when the disk changed since `baseRev`; files with errors are not written. */
  save(id: string, files: PackFiles, baseRev: string): WorkflowSaveResult {
    if (id.startsWith(BUILTIN)) throw new WorkflowLibError('read_only', 'Mẫu có sẵn chỉ xem: nhân bản để sửa');
    this.entry(id);
    const dir = join(this.libDir, id);
    if (packRev(readPackDir(dir).files) !== baseRev) {
      this.reload(id); // the row's diskRev is fresh at once: Ghi đè does not wait for the 2 s poll
      throw new WorkflowLibError('workflow_conflict', 'File quy trình vừa đổi ngoài app');
    }
    const checked = validatePack(files, this.d.env?.() ?? {});
    if (checked.errors.length) return { saved: false, row: null, errors: checked.errors, warnings: checked.warnings };
    writePack(dir, files);
    this.reload(id);
    return { saved: true, row: this.row(this.entry(id)), errors: [], warnings: checked.warnings };
  }

  /** §10.2 the canvas edits (no write), checked with the same env as `save`. */
  edit(files: PackFiles, edits: readonly WorkflowEdit[]): WorkflowEditResult { return applyEdits(files, edits, this.d.env?.() ?? {}); }

  /** R9 / R13 copy a pack (or the "Trống" template) under a new name; a copy of a built-in records `based_on: builtin:<slug>@<rev>`. */
  create(from: string, name: string): WorkflowRow {
    const want = name.trim();
    if (want === '') throw new WorkflowLibError('bad_name', 'Tên quy trình trống');
    const files = from === BLANK_TEMPLATE ? blankFiles() : from.startsWith(BUILTIN) ? builtinFiles(this.slugOf(from)) : { ...this.entry(from).files };
    const based = from.startsWith(BUILTIN) ? `${from}@${workflowOf(from).rev}` : undefined;
    return this.add(files, this.uniqueName(want), based);
  }

  /** §5.9 Lưu of a new pack's draft: checked first (errors → not saved), added under a unique name. */
  addDraft(files: PackFiles, name: string): WorkflowSaveResult {
    const want = name.trim();
    if (want === '') throw new WorkflowLibError('bad_name', 'Tên quy trình trống');
    const checked = validatePack(files, this.d.env?.() ?? {});
    if (checked.errors.length) return { saved: false, row: null, errors: checked.errors, warnings: checked.warnings };
    return { saved: true, row: this.add(files, this.uniqueName(want)), errors: [], warnings: checked.warnings };
  }

  /** §4.8 a picked folder → the preview; without `preview` (and with no error) it is copied into the library. */
  importDir(dir: string, preview: boolean): WorkflowImportResult {
    let root: string;
    try { root = realpathSync(dir); } catch { root = dir; } // a picked alias / symlink to a folder; the contents stay lstat-only
    if (!lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new WorkflowLibError('bad_dir', `\`${dir}\` không phải thư mục`);
    const read = readPackDir(root);
    const checked = validatePack(read.files, this.d.env?.() ?? {});
    const errors = [...read.errors, ...checked.errors];
    const fm = parsePack(read.files).pack.workflow?.fm ?? {};
    const name = this.uniqueName(str(fm.name)?.trim() || 'Quy trình nhập');
    const out: WorkflowImportResult = { name, description: str(fm.description) ?? '', files: read.files, errors, warnings: checked.warnings, row: null };
    if (preview) return out;
    if (errors.length) throw new WorkflowLibError('workflow_invalid', `Gói có ${errors.length} lỗi: ${errors[0]!.msg}`);
    return { ...out, row: this.add(read.files, name) };
  }

  /** R12 / WF10 the folder goes to the Trash; refused while a project uses it. Pinned copies stay (R6). */
  remove(id: string): { trashed: string } {
    if (id.startsWith(BUILTIN)) throw new WorkflowLibError('read_only', 'Mẫu có sẵn không xoá được');
    const e = this.entry(id);
    const used = this.usedBy(id);
    if (used.length) throw new WorkflowLibError('in_use', `"${e.name}" đang dùng ở ${used.map((p) => p.name).join(', ')}: đổi quy trình các project đó trước`);
    const trashed = moveToTrash(this.d.trashHome, join(this.libDir, id), new Date(this.now()));
    this.users.delete(id);
    this.sigs.delete(id);
    dropWorkflow(id);
    this.d.onChange?.();
    return { trashed };
  }

  /** §4.6 Áp dụng: the project's new docs + its live Chung session run `id` at once (§6.1). */
  setProject(projectId: string, id: string): void {
    if (!this.d.db.query('SELECT 1 FROM project WHERE id = ?').get(projectId)) throw new WorkflowLibError('no_item', `Không có project ${projectId}`);
    if (!hasWorkflow(id)) throw new WorkflowLibError('workflow_invalid', `Quy trình "${id}" chưa có bản hợp lệ: sửa lỗi trước khi áp`);
    this.d.db.query('UPDATE project SET workflow = ?, workflow_fallback = NULL WHERE id = ?').run(id, projectId);
    repinChung(this.d.db, projectId);
    this.d.onChange?.();
  }

  // ---------- internals ----------

  private usedBy(id: string): { id: string; name: string }[] {
    return this.d.db.query<{ id: string; name: string }, [string]>('SELECT id, name FROM project WHERE workflow = ? ORDER BY name').all(id);
  }

  private entry(id: string): Entry {
    const e = this.users.get(id);
    if (!e) throw new WorkflowLibError('no_item', `Không có quy trình "${id}"`);
    return e;
  }

  private slugOf(id: string): BuiltinSlug {
    const slug = id.slice(BUILTIN.length) as BuiltinSlug;
    if (!BUILTIN_SLUGS.includes(slug)) throw new WorkflowLibError('no_item', `Không có quy trình "${id}"`);
    return slug;
  }

  private builtinOfRev(rev: string): PackFiles {
    const slug = BUILTIN_SLUGS.find((s) => workflowOf(`${BUILTIN}${s}`).rev === rev);
    return slug ? builtinFiles(slug) : {};
  }

  private add(src: PackFiles, name: string, basedOn?: string): WorkflowRow {
    const files = { ...src };
    let wf = files['WORKFLOW.md'] ?? '';
    for (const [k, v] of [['name', name], ...(basedOn ? [['based_on', basedOn]] : [])] as const) {
      const r = patchFrontmatter(wf, k, v);
      if (!r.ok) throw new WorkflowLibError('workflow_invalid', r.reason);
      wf = r.text;
    }
    files['WORKFLOW.md'] = wf;
    let slug = slugify(name);
    for (let i = 2; existsSync(join(this.libDir, slug)); i++) slug = `${slugify(name)}-${i}`;
    writePack(join(this.libDir, slug), files);
    this.reload(slug);
    return this.row(this.entry(slug));
  }

  /** §4.8 "Đã có "X" — sẽ thêm thành "X (2)"". */
  private uniqueName(name: string): string {
    const taken = new Set(this.list().map((r) => r.name));
    let out = name;
    for (let i = 2; taken.has(out); i++) out = `${name} (${i})`;
    return out;
  }

  private reload(slug: string): void {
    this.sigs.set(slug, signature(join(this.libDir, slug)));
    this.load(slug);
    this.d.onChange?.();
  }

  /** Read + validate one library pack; a valid one becomes its id's current rev (copied to workflow-revs); a broken one
   *  keeps the last valid rev running (this run's, else the newest in index.json). */
  private load(slug: string): void {
    const before = hasWorkflow(slug) ? workflowOf(slug).rev : null;
    const read = readPackDir(join(this.libDir, slug));
    const checked = validatePack(read.files, this.d.env?.() ?? {});
    const errors = [...read.errors, ...checked.errors];
    const fm = parsePack(read.files).pack.workflow?.fm ?? {};
    const prev = this.users.get(slug);
    const e: Entry = {
      id: slug, files: read.files, diskRev: packRev(read.files), errors, warnings: checked.warnings,
      name: str(fm.name) ?? slug, description: str(fm.description) ?? '', basedOn: str(fm.based_on),
      rev: prev?.rev ?? null, validAt: prev?.validAt ?? null,
    };
    if (errors.length === 0 && checked.workflow) {
      const c = compile(checked.workflow);
      registerWorkflow(c, slug);
      if (e.rev !== c.rev) { e.rev = c.rev; e.validAt = this.now(); }
      this.pinCopy(read.files, slug, c.name);
    } else if (e.rev === null) {
      const last = this.lastRev(slug);
      if (last) { e.rev = last.rev; e.validAt = last.at; registerWorkflow(workflowRev(last.rev), slug); }
    }
    this.users.set(slug, e);
    if (hasWorkflow(slug) && workflowOf(slug).rev !== before) for (const p of this.usedBy(slug)) repinChung(this.d.db, p.id); // §6.1 a new rev
  }

  /** The newest index.json rev of a library id whose copy loaded. */
  private lastRev(id: string): { rev: string; at: number } | null {
    let best: { rev: string; at: number } | null = null;
    for (const [rev, r] of Object.entries(this.index)) {
      if (r.id !== id || (best && best.at >= r.at)) continue;
      try { workflowRev(rev); best = { rev, at: r.at }; } catch { /* not loaded: not a fallback */ }
    }
    return best;
  }

  /** §6.1 the pinned copy of a rev (written once) + its index row. */
  private pinCopy(files: PackFiles, id: string, name: string): void {
    const rev = packRev(files);
    const dir = join(this.revsDir, rev);
    if (!existsSync(dir)) writePack(dir, Object.fromEntries(Object.entries(files).filter(([p]) => isRevFile(p))));
    if (this.index[rev]?.id === id) return;
    this.index[rev] = { id, name, at: this.now() };
    writeFileSecure(this.indexPath, JSON.stringify(this.index));
  }

  /** §6.1 register a stored rev; one that no longer loads keeps only its name (a session pinned to it fails closed). */
  private loadRev(rev: string): void {
    const read = readPackDir(join(this.revsDir, rev));
    const w = read.errors.length ? null : validatePack(read.files).workflow;
    if (w && w.rev === rev) { registerWorkflow(compile(w)); return; }
    const name = this.index[rev]?.name ?? str(parsePack(read.files).pack.workflow?.fm.name);
    if (name !== null) nameRev(rev, name);
    this.d.log?.(`workflow rev ${rev.slice(0, 12)} không đọc được`);
  }

  /** §6.1 "hết ai ghim → xoá lúc khởi động": keep the revs a spec / session / lane row holds and each library id's newest. */
  private gc(): void {
    const keep = new Set(this.d.db.query<{ r: string }, []>(
      `SELECT workflow_rev AS r FROM spec WHERE workflow_rev IS NOT NULL UNION SELECT workflow_rev FROM session WHERE workflow_rev IS NOT NULL
       UNION SELECT workflow_rev FROM lane WHERE workflow_rev IS NOT NULL`,
    ).all().map((x) => x.r));
    const newest = new Map<string, IndexRow & { rev: string }>();
    for (const [rev, r] of Object.entries(this.index)) {
      if (!r.id.startsWith(BUILTIN) && existsSync(join(this.revsDir, rev)) && (newest.get(r.id)?.at ?? -1) < r.at) newest.set(r.id, { ...r, rev });
    }
    for (const n of newest.values()) keep.add(n.rev);
    for (const name of readdirSync(this.revsDir)) {
      if (name === 'index.json' || keep.has(name)) continue;
      rmSync(join(this.revsDir, name), { recursive: true, force: true });
    }
    this.index = Object.fromEntries(Object.entries(this.index).filter(([rev]) => keep.has(rev)));
    writeFileSecure(this.indexPath, JSON.stringify(this.index));
  }

  private detail(rev: string, files: PackFiles, errors: PackIssue[], warnings: PackIssue[], c: Compiled | null): WorkflowDetail {
    return {
      rev, files, errors, warnings, name: c?.name ?? str(parsePack(files).pack.workflow?.fm.name) ?? '', docLabel: c?.docLabel ?? '',
      steps: c ? c.steps.map((s) => ({ id: s.id, type: s.type, name: s.name, labels: s.labels, next: s.next, phases: s.phases })) : null,
    };
  }

  private builtinRow(slug: BuiltinSlug): WorkflowRow {
    const id = `${BUILTIN}${slug}`;
    const c = workflowOf(id);
    return {
      id, builtin: true, name: c.name, description: c.description, rev: c.rev, diskRev: c.rev, validAt: null,
      errors: [], warnings: [], basedOn: null, baseOutdated: false, usedBy: this.usedBy(id), dir: null,
    };
  }

  private row(e: Entry): WorkflowRow {
    const m = e.basedOn === null ? null : /^(builtin:[a-z0-9-]+)@([0-9a-f]{64})$/.exec(e.basedOn);
    const outdated = m !== null && hasWorkflow(m[1]!) && workflowOf(m[1]!).rev !== m[2];
    return {
      id: e.id, builtin: false, name: e.name, description: e.description, rev: e.rev, diskRev: e.diskRev, validAt: e.validAt,
      errors: e.errors, warnings: e.warnings, basedOn: e.basedOn, baseOutdated: outdated, usedBy: this.usedBy(e.id),
      dir: join(this.libDir, e.id),
    };
  }
}
