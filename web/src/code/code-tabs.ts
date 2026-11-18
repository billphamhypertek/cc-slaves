// spec v2.3 §5.3 / §5.4 / §10.1 the state of the Code view's files, outside React (the view subscribes): one tab set per
// (project, source) (2a, remembered in localStorage), each open tab's read reply, Markdown mode, C15 band and edit buffer.
// Text being edited belongs to its tab (●, pinned): opening files, switching source / project / mode and `code_changed`
// never drop it. Only "Huỷ", Esc and closing the tab drop it, and all three ask first through `guardDirty` (C23 / C27).
// Save = `fs_write` with the open `baseHash` / eol / bom → C19, conflict → C7, gone → C22. Unsaved buffers are kept in
// IndexedDB (hot exit, C29) and come back in edit mode at the next start.
import type { EngineEvent, FsReadResult, FsWriteResult } from '../../../shared/protocol.ts';
import { fsApi, keySrc, srcKeyOf, type FsApi, type FsSend } from './fs.ts';
import type { HotBuf, HotExit } from './hot-exit.ts';
import { closeTab, EMPTY_SET, loadTabs, openTab, pinTab, saveTabs, selectTab, type TabSet } from './tabs.ts';

export type MdMode = 'read' | 'src';
/** the edit buffer; `free` = editing began with the source free, so "Lưu" stays on if a session starts meanwhile (§5.3) */
interface Edit { text: string; baseHash: string; eol: 'lf' | 'crlf'; bom: boolean; dirty: boolean; line: number; free: boolean }
export interface OpenFile {
  path: string;
  /** null while the first read is out, or after it failed (`err`) */
  res: FsReadResult | null;
  err: unknown;
  loading: boolean;
  md: MdMode;
  /** C15 changed on disk while the PO read further down; `by` = the lane of a lane source */
  stale: { by: string | null; at: number } | null;
  edit: Edit | null;
  /** C19 "Đã lưu 14:22" */
  savedAt: number | null;
  /** C29 the buffer came back from last time (its time) */
  restored: number | null;
  /** §5.3 a session changed the dir while editing (yellow footer); `who` = lane, null = the orchestrator / unknown */
  ran: { who: string | null } | null;
  /** the engine refused the save (`lane_running`, `forbidden`, offline …) */
  saveErr: unknown;
  /** new (unique across tabs) whenever the shown text is rebuilt from outside the editor: reload, discard, restore, save */
  v: number;
}
export type Dlg =
  | { k: 'dirty'; why: 'cancel' | 'close'; path: string; lines: number }
  | { k: 'conflict'; path: string; disk: FsReadResult; mine: string; at: number }
  | { k: 'gone'; path: string; at: number };
export type DlgChoice = 'keep' | 'discard' | 'save' | 'overwrite' | 'takeDisk' | 'recreate';
type KeyStore = Pick<Storage, 'getItem' | 'setItem'>;
export interface CodeTabsDeps { send: FsSend; hot: HotExit; ks?: KeyStore | null; now?: () => number }

const fk = (k: string, path: string) => `${k}\n${path}`;
let seq = 0;
/** a fresh `v`: the editor host never mistakes another text for a state it kept */
const nv = () => ++seq;
const newFile = (path: string): OpenFile => ({ path, res: null, err: null, loading: true, md: 'read', stale: null, edit: null, savedAt: null, restored: null, ran: null, saveErr: null, v: nv() });
/** lines of `b` that differ from `a`, by position (the C23 "có n dòng chưa lưu" count) */
const diffLines = (a: string, b: string) => { const x = a.split('\n'), y = b.split('\n'); let n = 0; for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) n++; return n; };

export class CodeTabs {
  /** the dialog over the view (C7 / C22 / C23 / C27) — of the shown set */
  dlg: Dlg | null = null;
  private sets = new Map<string, TabSet>();
  private files = new Map<string, OpenFile>();
  private loaded = new Set<string>();
  private tok = new Map<string, number>();
  private k = '';
  private pid = '';
  private src = 'base';
  private after: (() => void) | null = null;
  private ver = 0;
  private subs = new Set<() => void>();
  private ks: KeyStore | null | undefined;
  private now: () => number;
  constructor(private d: CodeTabsDeps) { this.ks = d.ks; this.now = d.now ?? Date.now; }

  subscribe = (fn: () => void) => { this.subs.add(fn); return () => { this.subs.delete(fn); }; };
  version = () => this.ver;
  private bump() { this.ver++; for (const f of this.subs) f(); }
  private fs(k = this.k): FsApi { const [pid, src] = k.split('\n') as [string, string]; return fsApi(this.d.send, pid, keySrc(src), false); }

  set(): TabSet { return this.sets.get(this.k) ?? EMPTY_SET; }
  /** §5.1 the open file of (pid, src) once that set shows; null in the render before `show` runs for a new project /
   *  source, so the tree never opens the previous source's path */
  activeOf(pid: string, src: string): string | null { return this.k === `${pid}\n${src}` ? this.set().active : null; }
  file(): OpenFile | null { const a = this.set().active; return a === null ? null : this.files.get(fk(this.k, a)) ?? null; }
  /** a tab of the shown set has unsaved text (●) */
  dirty(path: string): boolean { return !!this.files.get(fk(this.k, path))?.edit?.dirty; }

  /** Show the set of (project, source). The first time a project shows, its sets come back from localStorage; sources
   *  not in `live` are dropped with their hot-exit buffers (§5.4); buffers of kept sets reopen in edit mode (C29). */
  show(pid: string, src: string, live: ReadonlySet<string>): void {
    if (!this.loaded.has(pid)) {
      this.loaded.add(pid);
      const { sets, dropped } = loadTabs(pid, live, this.ks);
      for (const [s, set] of sets) this.sets.set(`${pid}\n${s}`, set);
      for (const s of dropped) void this.d.hot.dropSrc(pid, s);
      for (const s of sets.keys()) void this.restore(pid, s);
    }
    const k = `${pid}\n${src}`;
    if (k === this.k) return;
    this.k = k; this.pid = pid; this.src = src; this.dlg = null; this.after = null;
    this.ensure();
    this.bump();
  }

  private async restore(pid: string, src: string): Promise<void> {
    const bufs = await this.d.hot.load(pid, src), k = `${pid}\n${src}`, set = this.sets.get(k) ?? EMPTY_SET;
    for (const [path, b] of bufs) {
      if (!set.tabs.some(t => t.path === path)) { this.d.hot.drop(pid, src, path); continue; }
      const f = this.files.get(fk(k, path)) ?? newFile(path);
      this.files.set(fk(k, path), { ...f, md: 'src', restored: b.savedAt, v: nv(),
        edit: { text: b.text, baseHash: b.baseHash, eol: b.eol, bom: b.bom, dirty: true, line: b.line, free: false } });
    }
    if (bufs.size) this.bump();
  }

  /** read the selected tab when it has no reply yet */
  private ensure(): void {
    const a = this.set().active;
    if (a === null) return;
    const f = this.files.get(fk(this.k, a));
    if (!f || (!f.res && !f.loading && f.err === null)) this.read(this.k, a);
  }
  private read(k: string, path: string): void {
    const key = fk(k, path), n = (this.tok.get(key) ?? 0) + 1;
    this.tok.set(key, n);
    const f = this.files.get(key) ?? newFile(path);
    this.files.set(key, { ...f, loading: true });
    this.fs(k).read(path).then(res => {
      const cur = this.files.get(key);
      if (this.tok.get(key) !== n || !cur) return;
      this.files.set(key, { ...cur, res, err: null, loading: false, stale: null, v: cur.edit ? cur.v : nv() });
      this.bump();
    }, (err: unknown) => {
      const cur = this.files.get(key);
      if (this.tok.get(key) !== n || !cur) return;
      this.files.set(key, { ...cur, res: null, err, loading: false });
      this.bump();
    });
    this.bump();
  }
  private put(s: TabSet): void {
    this.sets.set(this.k, s);
    saveTabs(this.pid, this.src, s, this.ks);
  }
  private patch(path: string, p: Partial<OpenFile>, k = this.k): void {
    const f = this.files.get(fk(k, path));
    if (f) this.files.set(fk(k, path), { ...f, ...p });
  }

  /** tree click / ⌘P Enter / doc link / "Mở ở Code" (preview, 1a); tree double click (`pin`) */
  open(path: string, pin = false): void {
    const prev = this.set();
    const next = openTab(prev, path, pin);
    const replaced = prev.tabs.find(t => t.preview && !next.tabs.some(x => x.path === t.path));
    if (replaced) this.drop(replaced.path);
    if (!this.files.has(fk(this.k, path))) this.files.set(fk(this.k, path), { ...newFile(path), loading: false });
    this.put(next);
    this.ensure();
    this.bump();
  }
  pin(path: string): void { this.put(pinTab(this.set(), path)); this.bump(); }
  select(path: string): void { this.put(selectTab(this.set(), path)); this.ensure(); this.bump(); }
  private drop(path: string): void {
    this.files.delete(fk(this.k, path));
    this.d.hot.drop(this.pid, this.src, path);
  }

  /** §5.3 / §10.1 the one gate before text is dropped: changes → the dialog (C23 / C27), none → `next` now */
  private guardDirty(why: 'cancel' | 'close', path: string, next: () => void): void {
    const f = this.files.get(fk(this.k, path));
    if (!f?.edit?.dirty) { next(); return; }
    this.after = next;
    this.dlg = { k: 'dirty', why, path, lines: Math.max(1, diffLines(f.res?.text ?? '', f.edit.text)) };
    this.bump();
  }
  /** × / ⌘W / middle click */
  close(path: string): void {
    this.guardDirty('close', path, () => { this.drop(path); this.put(closeTab(this.set(), path)); this.ensure(); this.bump(); });
  }
  closeActive(): void { const a = this.set().active; if (a !== null) this.close(a); }
  /** "Huỷ" in the head */
  cancelEdit(): void {
    const f = this.file();
    if (f?.edit) this.guardDirty('cancel', f.path, () => this.leaveEdit(f.path));
  }
  private leaveEdit(path: string): void {
    this.d.hot.drop(this.pid, this.src, path);
    this.patch(path, { edit: null, restored: null, ran: null, saveErr: null, v: nv() });
    this.bump();
  }

  /** "Sửa": edit mode on the shown text (md → "Nguồn"), the tab pinned */
  startEdit(): void {
    const f = this.file();
    if (!f?.res || f.res.kind !== 'text' || f.edit) return;
    this.put(pinTab(this.set(), f.path));
    this.patch(f.path, { md: 'src', savedAt: null, saveErr: null,
      edit: { text: f.res.text ?? '', baseHash: f.res.hash, eol: f.res.eol ?? 'lf', bom: f.res.bom ?? false, dirty: false, line: 1, free: true } });
    this.bump();
  }
  /** the editor's text after a change; `line` = the cursor line (hot exit) */
  change(text: string, line: number): void {
    const f = this.file();
    if (!f?.edit) return;
    const dirty = !(f.res?.kind === 'text' && f.res.hash === f.edit.baseHash && f.res.text === text);
    const wasDirty = f.edit.dirty;
    this.patch(f.path, { edit: { ...f.edit, text, line, dirty } });
    const { baseHash, eol, bom } = f.edit;
    if (dirty) this.d.hot.queue(this.pid, this.src, f.path, { text, baseHash, eol, bom, line, savedAt: this.now() } satisfies HotBuf);
    else this.d.hot.drop(this.pid, this.src, f.path);
    if (dirty !== wasDirty) this.bump(); // the ● and the dialog care; typing itself does not re-render
  }
  setMd(m: MdMode): void { const f = this.file(); if (f) { this.patch(f.path, { md: m }); this.bump(); } }

  /** ⌘S / "Lưu" (`recreate` = C22 "Tạo lại"); `then` runs after a good save (C27 closes the tab) */
  save(then?: () => void, o: { baseHash?: string; recreate?: boolean } = {}): void {
    const f = this.file();
    if (!f?.edit || (!f.edit.dirty && !o.recreate && !o.baseHash)) { if (f?.edit && then) then(); return; }
    const { path } = f, k = this.k, e = f.edit;
    this.after = then ?? null;
    this.dlg = null;
    this.fs(k).write({ path, text: e.text, eol: e.eol, bom: e.bom, baseHash: o.baseHash ?? e.baseHash, ...(o.recreate ? { recreate: true } : {}) })
      .then(r => this.saved(k, path, e.text, r), (err: unknown) => { this.patch(path, { saveErr: err }, k); this.after = null; this.bump(); });
    this.bump();
  }
  private saved(k: string, path: string, text: string, r: FsWriteResult): void {
    const f = this.files.get(fk(k, path));
    if (!f) return;
    if (!r.ok) {
      if (k === this.k) this.dlg = r.code === 'conflict' ? { k: 'conflict', path, disk: r.disk, mine: text, at: this.now() } : { k: 'gone', path, at: this.now() };
      this.bump();
      return;
    }
    const [pid, src] = k.split('\n') as [string, string];
    this.d.hot.drop(pid, src, path);
    const res: FsReadResult = { ...(f.res ?? { kind: 'text', size: 0, eol: f.edit?.eol, bom: f.edit?.bom }), kind: 'text', text, hash: r.hash };
    this.files.set(fk(k, path), { ...f, res, err: null, edit: null, savedAt: this.now(), restored: null, ran: null, saveErr: null, stale: null, v: nv() });
    const next = this.after;
    this.after = null;
    this.bump();
    next?.();
  }

  choose(c: DlgChoice): void {
    const d = this.dlg;
    if (!d) return;
    const next = this.after;
    this.dlg = null;
    this.after = null;
    if (c === 'keep') { this.bump(); return; }
    if (d.k === 'dirty') {
      if (c === 'save') this.save(next ?? undefined);
      else { if (d.why === 'close') next?.(); else this.leaveEdit(d.path); }
    } else if (d.k === 'conflict') {
      if (c === 'overwrite') this.save(next ?? undefined, { baseHash: d.disk.hash });
      else if (c === 'takeDisk') {
        this.d.hot.drop(this.pid, this.src, d.path);
        this.patch(d.path, { res: d.disk, edit: null, restored: null, ran: null, saveErr: null, stale: null, v: nv() });
      }
    } else if (c === 'recreate') this.save(next ?? undefined, { recreate: true });
    else if (c === 'discard') { this.drop(d.path); this.put(closeTab(this.set(), d.path)); this.ensure(); }
    this.bump();
  }

  /** the Esc ladder (§4.1): the dialog first, then edit mode */
  escSteps(): { codeDlg: boolean; edit: boolean } { return { codeDlg: this.dlg !== null, edit: !!this.file()?.edit }; }
  escDlg(): void { this.choose('keep'); }
  escEdit(): void { this.cancelEdit(); }

  /** "Thử lại" / C15 "Tải lại" */
  reload(): void { const f = this.file(); if (f && !f.edit) this.read(this.k, f.path); }

  /** C15 the shown file read again (window focus, `code_changed`): another hash → quiet reload, or the band when the PO
   *  scrolled; a file being edited is never reloaded (§5.3: the yellow footer instead). */
  private recheck(k: string, path: string, scrolled: () => boolean, by: string | null): void {
    const f = this.files.get(fk(k, path));
    if (!f?.res || f.edit) return;
    const hash = f.res.hash;
    this.fs(k).read(path).then(res => {
      const cur = this.files.get(fk(k, path));
      if (!cur || cur.edit || res.hash === hash) return;
      this.files.set(fk(k, path), scrolled() ? { ...cur, stale: { by, at: this.now() } } : { ...cur, res, err: null, stale: null, v: nv() });
      this.bump();
    }, () => {});
  }
  refocus(scrolled: () => boolean): void { const f = this.file(); if (f) this.recheck(this.k, f.path, scrolled, null); }

  /** v2.3 §10.2 `code_changed`: open tabs it names (all when no `paths`) — the shown one is checked now, the others read
   *  again when selected; an edited one gets the "vừa chạy" footer. `who` = the session holding the dir, if known. */
  codeChanged(e: Extract<EngineEvent, { type: 'code_changed' }>, scrolled: () => boolean, who: string | null): void {
    const k = `${e.projectId}\n${srcKeyOf(e.src)}`, set = this.sets.get(k);
    if (!set) return;
    const by = e.src.kind === 'lane' ? e.src.laneId : who;
    for (const t of set.tabs) {
      if (e.paths && !e.paths.includes(t.path)) continue;
      const f = this.files.get(fk(k, t.path));
      if (!f) continue;
      if (f.edit) this.patch(t.path, { ran: { who: by } }, k);
      else if (k === this.k && t.path === set.active) this.recheck(k, t.path, scrolled, by);
      else this.files.set(fk(k, t.path), { ...f, res: null, err: null, loading: false });
    }
    this.bump();
  }

  /** `pagehide`: every pending buffer to IndexedDB now */
  flush(): void { this.d.hot.flush(); }
}
