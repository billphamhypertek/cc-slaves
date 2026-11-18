// spec v2.9 §4.10 / §5.9 author by prompt (D104 / D105): one `claude` session per draft, NOT an orchestrator session (no `session`
// row, no cc_slaves MCP, not on the Deck). It reuses SessionProcess + Outbox + the v2 account pick with its own whitelist argv
// (author-args.ts, R20). The engine polls `pack/` every 300 ms (G0 2), checks it (§5.4) and pushes `workflow_draft`; after a turn
// with errors it sends `[cc-slaves] Kiểm gói: …` (at most 3 turns in a row). `draft_save` (the session's one MCP tool) is taken
// only when the last line replayed in the turn is the user's. Lưu → hidden 30 s for Hoàn tác, then the folder goes.
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { UpdateBusy } from '../../../shared/update.ts';
import type { DraftLine, DraftState, DraftView, WorkflowEdit, WorkflowEditResult, WorkflowEngineEvent, WorkflowSaveResult } from '../../../shared/workflows.ts';
import type { Account } from '../accounts/registry.ts';
import { resolveCaps } from '../config.ts';
import type { Db } from '../db.ts';
import { orchAccount, type PickDeps } from '../orchestrator/session/account.ts';
import { PREFIX, type Outbox } from '../outbox.ts';
import type { Env } from '../session/env.ts';
import { SessionProcess, type SessionOptions } from '../session/process.ts';
import type { StreamEvent } from '../stream/parser.ts';
import type { UpdateGate } from '../update/commit.ts';
import { authorAppendix, buildAuthorArgs, DRAFT_SERVER } from './author-args.ts';
import { DraftDisk, diffFiles, type DraftMeta } from './drafts.ts';
import { WorkflowLibError, type WorkflowLibrary } from './library.ts';
import { parsePack, type PackFiles, type PackIssue } from './pack.ts';
import { validatePack } from './validate.ts';

const MAX_DRAFTS = 3;
const MAX_FIXES = 3;
const UNDO_MS = 30_000;
const POLL_MS = 300;
const MAX_LINES = 200;
const RESUME_TEXT = 'Phiên soạn mở lại: làm tiếp từ bản nháp trong thư mục.';

export interface AuthorDeps {
  home: string; db: Db; outbox: Outbox; library: WorkflowLibrary;
  /** The v2 pick (orchestrator role first, then a primary soft fallback) and the quota it reads. */
  pick: PickDeps;
  command: string[];
  env: (a: Account) => Env;
  /** The Mac port: `/mcp-draft` lives on it. */
  port: number;
  /** v2.6 §5.4 (orchestrator ruling 12:20) the update gate: writes and spawns wait like a lane's. */
  gate?: UpdateGate;
  session?: Partial<Pick<SessionOptions, 'initTimeoutMs' | 'interruptTimeoutMs' | 'minVersion' | 'authEmail' | 'beforeSpawn'>>;
  /** v2.4 the user's default model (null = Claude Code's own). */
  model?: () => string | null;
  /** §5.9 the installed skills / plugins written into the appendix. */
  installed?: () => { skills: string[]; plugins: string[] };
  emit: (e: WorkflowEngineEvent) => void;
  now?: () => number;
  pollMs?: number;
  undoMs?: number;
  log?: (line: string) => void;
}

/** §5.9 D105 "nói rõ là lưu": the line names saving and does not hold it off ("chưa / đừng / không lưu"). */
const asksSave = (t: string): boolean => /lưu|save/i.test(t) && !/(chưa|đừng|không)\s+lưu/i.test(t);

interface Undo { files: PackFiles | null; rev: string; timer: ReturnType<typeof setTimeout> }
interface Draft {
  meta: DraftMeta & { savedUntil?: number };
  files: PackFiles; errors: PackIssue[]; warnings: PackIssue[]; sig: string;
  state: DraftState; quota: DraftView['quota']; saved: DraftView['saved']; resumeFailed: boolean;
  proc: SessionProcess | null; token: string | null; closeAfterTurn: boolean;
  /** Kiểm gói messages sent since the user last spoke. */
  fixes: number;
  /** §5.9 D105 who the last line replayed in this turn came from; ours that we did not send (the resume note) = engine. */
  lastReplay: 'user' | 'engine' | null;
  /** §5.9 the user's last message: `draft_save` is taken only when it asks to save. */
  lastUserText: string;
  sent: Map<string, 'user' | 'engine'>;
  edited: Set<string>;
  undo: Undo | null;
}

export class AuthorSessions {
  private readonly drafts = new Map<string, Draft>();
  private readonly disk: DraftDisk;
  private readonly tokens = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: AuthorDeps) { this.disk = new DraftDisk(join(d.home, 'workflow-drafts')); }

  private now(): number { return (this.d.now ?? Date.now)(); }

  /** §4.10 drafts live across restarts: each comes back idle (its session resumes at the next message); a saved one goes. */
  boot(): void {
    for (const meta of this.disk.loadAll() as Draft['meta'][]) {
      if (meta.savedUntil !== undefined) { this.disk.remove(meta.id); continue; }
      const dr = this.blank(meta);
      this.drafts.set(meta.id, dr);
      this.scan(dr, true);
    }
    this.timer = setInterval(() => { for (const dr of this.drafts.values()) if (dr.state !== 'saved') this.scan(dr); }, this.d.pollMs ?? POLL_MS);
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const dr of this.drafts.values()) {
      if (dr.undo) clearTimeout(dr.undo.timer);
      if (dr.proc?.alive) await dr.proc.terminate(2000);
    }
  }

  list(): DraftView[] { return [...this.drafts.values()].map((dr) => this.view(dr)); }

  /** v2.6 §5.4-4 drafts mid-turn (`name` = the draft id). */
  busy(): UpdateBusy[] {
    return [...this.drafts.values()].flatMap((dr) => {
      const t = dr.proc?.turnStartedAt ?? null;
      return t === null ? [] : [{ projectId: '_workflow', kind: 'workflow' as const, name: dr.meta.id, turnStartedAt: t }];
    });
  }

  /** v2.6 §5.4 the update hold ended: live sessions write what waited. */
  writesOpened(): void { for (const dr of this.drafts.values()) if (dr.proc?.alive) dr.proc.flush(); }

  /** `/mcp-draft` bearer → draft id (null = unknown). */
  draftOfToken(token: string): string | null { return this.tokens.get(token) ?? null; }

  // ---------- commands ----------

  async start(fromId: string | null, text: string): Promise<DraftView> {
    if (fromId?.startsWith('builtin:')) throw new WorkflowLibError('read_only', 'Mẫu có sẵn: nhân bản trước rồi sửa bằng lời');
    const same = fromId === null ? undefined : [...this.drafts.values()].find((x) => x.meta.fromId === fromId && x.state !== 'saved');
    if (same) { await this.say(same.meta.id, text); return this.view(same); }
    if ([...this.drafts.values()].filter((x) => x.state !== 'saved').length >= MAX_DRAFTS) {
      throw new WorkflowLibError('draft_limit', `Đang có ${MAX_DRAFTS} bản nháp — lưu hoặc bỏ bớt`);
    }
    const det = fromId === null ? null : this.d.library.get({ id: fromId });
    const meta: Draft['meta'] = {
      id: randomUUID(), fromId, baseRev: det?.rev ?? null, base: det?.files ?? {}, sessionId: randomUUID(), started: false,
      account: null, model: null, lines: [],
    };
    this.disk.create(meta);
    const dr = this.blank(meta);
    this.drafts.set(meta.id, dr);
    this.scan(dr, true);
    await this.say(meta.id, text);
    return this.view(dr);
  }

  async say(id: string, text: string): Promise<void> {
    const dr = this.get(id);
    const t = text.trim();
    if (t === '') throw new WorkflowLibError('bad_text', 'Tin nhắn trống');
    if (dr.state === 'running') throw new WorkflowLibError('busy', 'Phiên soạn đang chạy: chờ lượt này xong hoặc bấm Dừng');
    if (dr.state === 'saved') throw new WorkflowLibError('saved', 'Bản nháp đã lưu: Hoàn tác để mở lại');
    dr.quota = null;
    dr.lastUserText = t;
    this.scan(dr);
    // §4.10 the hand edits since the last message, and §5.9 the check errors, ride with this message (never a Kiểm gói of their own)
    const notes: string[] = [];
    if (dr.edited.size) notes.push(`Người dùng đã sửa tay: ${[...dr.edited].join(', ')}`);
    if (dr.errors.length && Object.keys(dr.files).length) notes.push(`Kiểm gói: ${dr.errors.map((e) => e.msg).join(' · ')}`);
    dr.edited.clear();
    dr.fixes = 0;
    if (notes.length) this.enqueue(dr, notes.join('\n'), 'engine');
    this.enqueue(dr, t, 'user');
    this.line(dr, { kind: 'user', text: t });
    dr.state = 'running';
    this.push(dr);
    await this.ensureProc(dr);
  }

  async interrupt(id: string): Promise<void> {
    const dr = this.get(id);
    if (dr.proc?.alive && dr.state === 'running') await dr.proc.interrupt();
  }

  async discard(id: string): Promise<void> {
    const dr = this.get(id);
    this.drafts.delete(id);
    if (dr.undo) clearTimeout(dr.undo.timer);
    await this.closeProc(dr, true);
    this.disk.remove(id);
    this.d.emit({ type: 'workflow_draft_gone', draftId: id });
  }

  /** §4.10 a hand edit while the session waits; the keys ride with the next message. */
  patch(id: string, edits: readonly WorkflowEdit[]): WorkflowEditResult {
    const dr = this.get(id);
    if (dr.state === 'running') throw new WorkflowLibError('busy', 'Phiên soạn đang chạy: canvas chỉ xem');
    if (dr.state === 'saved') throw new WorkflowLibError('saved', 'Bản nháp đã lưu');
    const res = this.d.library.edit(dr.files, edits);
    this.disk.write(id, dr.files, res.files);
    for (const e of edits) {
      if (e.path === '.layout.json') continue;
      const failed = res.failed.some((f) => f.path === e.path && 'key' in e && f.key === e.key);
      if (!failed) dr.edited.add('key' in e ? `${e.path}:${e.key}` : 'body' in e ? `${e.path} (lời dặn)` : e.path);
    }
    this.scan(dr, true);
    return res;
  }

  /** Lưu (the button, or `draft_save` from the session): a library pack = `workflow_save` with the draft's base rev; a new
   *  pack = added under its name. Errors → not saved (system line); a conflict throws `workflow_conflict` (WF5c). */
  save(id: string, name?: string): WorkflowSaveResult {
    const dr = this.get(id);
    if (dr.state === 'saved') throw new WorkflowLibError('saved', 'Bản nháp đã lưu');
    if (dr.state === 'quota') throw new WorkflowLibError('busy', 'Chọn Tiếp tục hoặc Để sau trước khi lưu');
    this.scan(dr, true);
    if (dr.errors.length) {
      this.line(dr, { kind: 'system', text: '', key: 'workflow.author.saveErrors', params: { n: dr.errors.length } });
      this.push(dr);
      return { saved: false, row: null, errors: dr.errors, warnings: dr.warnings };
    }
    const prev = dr.meta.fromId === null ? null : this.d.library.list().find((r) => r.id === dr.meta.fromId) ?? null;
    let r: WorkflowSaveResult;
    try {
      r = dr.meta.fromId === null ? this.d.library.addDraft(dr.files, name?.trim() || this.nameOf(dr.files) || 'Quy trình mới')
        : this.d.library.save(dr.meta.fromId, dr.files, dr.meta.baseRev ?? '');
    } catch (e) {
      if (e instanceof WorkflowLibError && e.code === 'workflow_conflict') {
        this.line(dr, { kind: 'system', text: '', key: 'workflow.author.conflict' });
        this.push(dr);
      }
      throw e;
    }
    if (!r.saved || !r.row) return r;
    const row = r.row;
    const until = this.now() + (this.d.undoMs ?? UNDO_MS);
    const docs = prev?.rev ? this.d.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM spec WHERE workflow_rev = ? AND state <> 'done'").get(prev.rev)?.n ?? 0 : 0;
    dr.undo = { files: dr.meta.fromId === null ? null : dr.meta.base, rev: row.diskRev, timer: setTimeout(() => this.expire(id), this.d.undoMs ?? UNDO_MS) };
    dr.saved = { id: row.id, name: row.name, until, applied: null };
    dr.state = 'saved';
    dr.meta.savedUntil = until;
    this.line(dr, { kind: 'system', text: '', key: 'workflow.author.saved', params: { name: row.name, projects: row.usedBy.length, docs } });
    this.disk.saveMeta(dr.meta);
    if (dr.proc?.alive && dr.proc.turnStartedAt !== null) dr.closeAfterTurn = true; // `draft_save` mid-turn: its reply first
    else void this.closeProc(dr, false);
    this.push(dr);
    return r;
  }

  /** Hoàn tác (≤ 30 s): the previous files saved over the new rev, or the new pack to the Trash; the draft opens again. */
  undo(id: string): DraftView {
    const dr = this.get(id);
    if (dr.state !== 'saved' || !dr.undo || !dr.saved) throw new WorkflowLibError('no_undo', 'Hết thời gian hoàn tác');
    if (dr.undo.files === null) this.d.library.remove(dr.saved.id); // in_use → "đã áp cho …"
    else {
      const r = this.d.library.save(dr.meta.fromId!, dr.undo.files, dr.undo.rev);
      if (r.row) dr.meta.baseRev = r.row.diskRev;
    }
    clearTimeout(dr.undo.timer);
    dr.undo = null;
    dr.saved = null;
    dr.state = 'idle';
    delete dr.meta.savedUntil;
    this.line(dr, { kind: 'system', text: '', key: 'workflow.author.undone' });
    this.push(dr);
    return this.view(dr);
  }

  /** §5.9 the cap hit mid-turn: Tiếp tục resumes on the account the pick chose; Để sau ends the turn. */
  async quota(id: string, go: boolean): Promise<void> {
    const dr = this.get(id);
    if (dr.state !== 'quota' || !dr.quota) return;
    const to = dr.quota.to;
    dr.quota = null;
    if (!go || to === null) {
      dr.state = 'idle';
      this.line(dr, { kind: 'system', text: '', key: 'workflow.author.later' });
      this.push(dr);
      return;
    }
    dr.state = 'running';
    this.enqueue(dr, 'Đổi account vì hết quota: làm tiếp phần đang dở.', 'engine');
    this.push(dr);
    await this.ensureProc(dr, to);
  }

  /** `/mcp-draft` `draft_save {name?}`: the session's own save, taken only right after the user's line (D105). */
  callSave(id: string, name: string | undefined): string {
    const dr = this.drafts.get(id);
    if (!dr) return 'Không có bản nháp này.';
    if (dr.lastReplay !== 'user' || !asksSave(dr.lastUserText)) return 'Chưa lưu: chỉ lưu khi tin gần nhất của người dùng nói rõ là lưu.';
    try {
      const r = this.save(id, name);
      if (!r.saved) return `Chưa lưu: gói còn ${r.errors.length} lỗi — ${r.errors.map((e) => e.msg).join(' · ')}`;
      return `Đã lưu "${r.row!.name}".`;
    } catch (e) {
      return `Chưa lưu: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ---------- internals ----------

  private blank(meta: Draft['meta']): Draft {
    return {
      meta, files: {}, errors: [], warnings: [], sig: '', state: 'idle', quota: null, saved: null, resumeFailed: false,
      proc: null, token: null, closeAfterTurn: false, fixes: 0, lastReplay: null, lastUserText: '', sent: new Map(), edited: new Set(), undo: null,
    };
  }

  private get(id: string): Draft {
    const dr = this.drafts.get(id);
    if (!dr) throw new WorkflowLibError('no_item', 'Không có bản nháp này');
    return dr;
  }

  private nameOf(files: PackFiles): string {
    const n = parsePack(files).pack.workflow?.fm.name;
    return typeof n === 'string' ? n.trim() : '';
  }

  /** The poll (and every point that needs fresh files): a changed signature → read + check → `workflow_draft`. */
  private scan(dr: Draft, force = false): void {
    const sig = this.disk.signature(dr.meta.id);
    if (!force && sig === dr.sig) return;
    dr.sig = sig;
    const r = this.disk.read(dr.meta.id);
    const checked = validatePack(r.files);
    dr.files = r.files;
    dr.errors = [...r.errors, ...checked.errors];
    dr.warnings = checked.warnings;
    this.push(dr);
  }

  private view(dr: Draft): DraftView {
    const row = dr.saved ? this.d.library.list().find((r) => r.id === dr.saved!.id) : undefined;
    const saved = dr.saved && dr.meta.fromId === null && row?.usedBy.length ? { ...dr.saved, applied: row.usedBy[0]!.name } : dr.saved;
    return {
      id: dr.meta.id, fromId: dr.meta.fromId, state: dr.state, account: dr.meta.account, model: dr.meta.model,
      files: dr.files, base: dr.meta.base, errors: dr.errors, warnings: dr.warnings, changed: diffFiles(dr.meta.base, dr.files),
      lines: dr.meta.lines, quota: dr.quota, saved, resumeFailed: dr.resumeFailed,
    };
  }

  private push(dr: Draft): void { if (this.drafts.has(dr.meta.id)) this.d.emit({ type: 'workflow_draft', draft: this.view(dr) }); }

  private line(dr: Draft, l: DraftLine): void {
    dr.meta.lines = [...dr.meta.lines, l].slice(-MAX_LINES);
    if (l.kind !== 'activity') this.disk.saveMeta(dr.meta);
  }

  private enqueue(dr: Draft, text: string, who: 'user' | 'engine'): void {
    const m = this.d.outbox.enqueue(dr.meta.sessionId, text, who === 'user' ? null : PREFIX.engine);
    dr.sent.set(m.uuid, who);
  }

  private home(): string | null {
    const caps = this.d.pick.caps();
    return this.d.pick.accounts().find((a) => resolveCaps(caps, a.email).role === 'orchestrator')?.email ?? null;
  }

  private nowS(): number { return Math.floor(this.now() / 1000); }

  /** A live process writes the queued messages; none → spawn (resume when the conversation exists). */
  private async ensureProc(dr: Draft, account?: string): Promise<void> {
    if (dr.proc?.alive && account === undefined) { dr.proc.flush(); return; }
    const later = () => { if (this.drafts.get(dr.meta.id) === dr) void this.ensureProc(dr, account); }; // a discarded draft spawns nothing
    if (this.d.gate?.defer(dr.meta.sessionId, later)) return; // §5.4-3 spawn after the release
    await this.closeProc(dr, false);
    const email = account ?? orchAccount(this.d.pick, dr.meta.account ?? this.home(), [], this.nowS(), true);
    const acct = email === null ? undefined : this.d.pick.accounts().find((a) => a.email === email);
    if (!acct) {
      dr.state = 'idle';
      this.line(dr, { kind: 'system', text: '', key: 'workflow.author.noAccount' });
      this.push(dr);
      return;
    }
    let r = await this.spawn(dr, acct, dr.meta.started);
    if (!r && dr.meta.started) { // WF15c the old conversation does not resume: a new session, the draft stays
      const old = dr.meta.sessionId;
      dr.meta.sessionId = randomUUID();
      dr.meta.started = false;
      dr.resumeFailed = true;
      this.d.db.query('UPDATE outbox SET session_id = ? WHERE session_id = ? AND delivered_at IS NULL').run(dr.meta.sessionId, old);
      r = await this.spawn(dr, acct, false);
    }
    if (!r) {
      dr.state = 'idle';
      this.line(dr, { kind: 'system', text: '', key: 'workflow.author.startFailed' });
      this.push(dr);
    }
  }

  private async spawn(dr: Draft, acct: Account, resume: boolean): Promise<boolean> {
    const id = dr.meta.id;
    if (dr.token) this.tokens.delete(dr.token);
    const token = randomBytes(24).toString('hex');
    dr.token = token;
    this.tokens.set(token, id);
    this.disk.writeMcp(id, this.d.port, token);
    const model = this.d.model?.() ?? null;
    const appendix = authorAppendix(this.d.installed?.() ?? { skills: [], plugins: [] });
    const proc = new SessionProcess({
      ...this.d.session,
      sessionId: dr.meta.sessionId, resume, resumeText: RESUME_TEXT, projectId: '_workflow', lane: id, runN: 1,
      args: { argv: buildAuthorArgs({ draftDir: this.disk.dir(id), sessionId: dr.meta.sessionId, resume, appendix, model }), model },
      cwd: this.disk.packDir(id), account: { email: acct.email, configDir: acct.configDir, terminal: acct.terminal },
      outbox: this.d.outbox, command: this.d.command, env: () => this.d.env(acct), mcpServer: DRAFT_SERVER,
      ...(this.d.gate ? { update: { gate: this.d.gate, kind: 'workflow' as const } } : {}),
    });
    proc.on('event', (e) => { if (dr.proc === proc) this.onEvent(dr, e); });
    proc.on('exit', () => {
      if (dr.proc !== proc) return;
      dr.proc = null;
      if (dr.state === 'running') { dr.state = 'idle'; this.endTurn(dr); }
    });
    dr.proc = proc;
    dr.meta.account = acct.email;
    dr.meta.model = model;
    const r = await proc.start();
    if (!r.ok) { if (dr.proc === proc) dr.proc = null; return false; }
    dr.meta.started = true;
    this.disk.saveMeta(dr.meta);
    this.push(dr);
    proc.flush();
    return true;
  }

  private async closeProc(dr: Draft, kill: boolean): Promise<void> {
    const p = dr.proc;
    dr.proc = null;
    if (dr.token) { this.tokens.delete(dr.token); dr.token = null; }
    if (!p?.alive) return;
    if (kill) { await p.terminate(2000); return; }
    p.closeStdin();
    await Promise.race([new Promise<void>((r) => p.on('exit', () => r())), Bun.sleep(5000)]);
    if (p.alive) await p.terminate(2000);
  }

  private onEvent(dr: Draft, e: StreamEvent): void {
    if (e.kind === 'init' && e.model) dr.meta.model = e.model;
    if (e.kind === 'user' && e.isReplay && e.ours && e.uuid) {
      const who = dr.sent.get(e.uuid) ?? 'engine';
      dr.sent.delete(e.uuid);
      dr.lastReplay = who;
    }
    if (e.kind === 'assistant' && e.parentToolUseId === null) this.onAssistant(dr, e.message);
    if (e.kind === 'rate_limit_event' && dr.meta.account) this.onRateLimit(dr, dr.meta.account, e);
    if (e.kind === 'result') {
      dr.lastReplay = null;
      if (dr.state === 'running') dr.state = 'idle';
      this.endTurn(dr);
    }
  }

  private onAssistant(dr: Draft, message: unknown): void {
    const blocks = (message as { content?: unknown } | null)?.content;
    if (!Array.isArray(blocks)) return;
    let changed = false;
    for (const b of blocks as { type?: string; text?: string; name?: string; input?: { file_path?: string } }[]) {
      if (b.type === 'text' && b.text?.trim()) { this.line(dr, { kind: 'claude', text: b.text.trim() }); changed = true; }
      if (b.type === 'tool_use' && (b.name === 'Write' || b.name === 'Edit') && b.input?.file_path) {
        // §4.10 one activity line per turn: the newest write replaces the last one
        dr.meta.lines = dr.meta.lines.filter((l) => l.kind !== 'activity');
        this.line(dr, { kind: 'activity', text: '', key: 'workflow.author.writing', params: { file: this.disk.rel(dr.meta.id, b.input.file_path) } });
        changed = true;
      }
    }
    if (changed) this.push(dr);
  }

  /** §5.9 the account hit its cap mid-turn → the turn stops; Tiếp tục / Để sau. */
  private onRateLimit(dr: Draft, email: string, e: Extract<StreamEvent, { kind: 'rate_limit_event' }>): void {
    this.d.pick.quota.applyRateLimitEvent(email, e);
    if (dr.state !== 'running' || orchAccount(this.d.pick, email, [], this.nowS()) === email) return;
    const to = orchAccount(this.d.pick, this.home(), [email], this.nowS(), true);
    dr.state = 'quota';
    dr.quota = { from: email, to };
    // the turn stops here: its activity line goes; WF16f names the week left on the account it would move to
    dr.meta.lines = dr.meta.lines.filter((l) => l.kind !== 'activity');
    const left = to ? Math.max(0, Math.round(100 - (this.d.pick.quota.get(to)?.weekPct ?? 0))) : 0;
    this.line(dr, { kind: 'system', text: '', key: to ? 'workflow.author.quota' : 'workflow.author.quotaNone', params: { from: email, to: to ?? '', left } });
    this.push(dr);
    void this.closeProc(dr, true);
  }

  /** A turn ended: the activity lines go, the files are read, and §5.9 the check errors go back to the session (≤ 3 turns). */
  private endTurn(dr: Draft): void {
    dr.meta.lines = dr.meta.lines.filter((l) => l.kind !== 'activity');
    this.disk.saveMeta(dr.meta);
    this.scan(dr, true);
    if (dr.closeAfterTurn) { dr.closeAfterTurn = false; void this.closeProc(dr, false); this.push(dr); return; }
    const pendingUser = [...dr.sent.values()].includes('user');
    if (dr.state === 'idle' && dr.errors.length && !pendingUser && dr.proc?.alive) {
      if (dr.fixes < MAX_FIXES) {
        dr.fixes++;
        const msgs = dr.errors.map((x) => x.msg).join(' · ');
        this.enqueue(dr, `Kiểm gói: ${msgs}`, 'engine');
        // §4.9 the chat words each error itself (no file / key names): the codes + the engine text ride as JSON
        this.line(dr, { kind: 'system', text: '', key: 'workflow.author.check', params: { issues: JSON.stringify(dr.errors.map((x) => ({ code: x.code, msg: x.msg }))) } });
        dr.state = 'running';
        dr.proc.flush();
      } else if (dr.fixes === MAX_FIXES) {
        dr.fixes++;
        this.line(dr, { kind: 'system', text: '', key: 'workflow.author.fixStopped', params: { n: MAX_FIXES, e: dr.errors.length } });
      }
    }
    this.push(dr);
  }

  /** 30 s after Lưu: the session and the folder go. */
  private expire(id: string): void {
    const dr = this.drafts.get(id);
    if (!dr || dr.state !== 'saved') return;
    this.drafts.delete(id);
    void this.closeProc(dr, true).then(() => this.disk.remove(id));
    this.d.emit({ type: 'workflow_draft_gone', draftId: id });
  }
}
