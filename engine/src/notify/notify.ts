// Notifications (spec §8.3): one routing table for in-app / macOS / Google Chat.
// - In-app: cards and lanes already reach the UI as events; this adds the `notify` event (sound, macOS flag) and toasts.
// - macOS: the Tauri app shows them from the `notify` event; with no app connected the engine falls back to osascript.
//   R10: no macOS notification while the PO is viewing that lane / orchestrator.
// - Cài đặt › Thông báo: `config.notify` (event × Trong app / macOS / Google Chat) and `config.sound` are read at send
//   time and override the default routes below for the kinds the matrix lists.
// - Google Chat (N6): per-project webhook; never tool input or `context` unless the project opts in; question ≤ 200
//   chars; link `https://<hostname>/c/<id>` only when remote access is on.
import type { EngineEvent, NotifyKind, Target } from '../../../shared/protocol.ts';
import { hasKey, t, type Key, type Lang, type Params } from '../../../shared/i18n/index.ts';
import { notifyMatrix, notifyOn, type NotifyMatrix } from '../../../shared/notify-prefs.ts';
import { permissionTitleKey, sourceText, withSource, type AskPayload, type Card, type PermissionPayload, type SystemPayload } from '../cards/store.ts';

export interface Route { sound: boolean; mac: boolean; gchat: boolean }

/** §8.3 table. "Lane Xong → Google Chat: — (bật được)" is off by default. */
export const ROUTES: Readonly<Record<NotifyKind, Route>> = Object.freeze({
  ask: { sound: true, mac: true, gchat: true },
  permission: { sound: true, mac: true, gchat: true },
  broken: { sound: false, mac: true, gchat: true },
  orchestrator_down: { sound: false, mac: true, gchat: true },
  logged_out: { sound: false, mac: true, gchat: true },
  all_full: { sound: false, mac: true, gchat: true },
  lane_done: { sound: true, mac: true, gchat: false },
  account_switch: { sound: false, mac: false, gchat: false },
  cc_updated: { sound: false, mac: false, gchat: false },
  shared_cfg: { sound: false, mac: true, gchat: false }, // v2 A9: the account stopped taking lanes
  shared_cfg_new: { sound: false, mac: false, gchat: false },
  account_orphan: { sound: false, mac: true, gchat: false }, // v2 §6: a logged-in dir lost its row
  cutover: { sound: false, mac: true, gchat: false }, // v2 §7.1-3: no v2 account yet, lanes wait
  mcp_login: { sound: false, mac: true, gchat: false }, // v2.2 K13: lanes miss a remote MCP server's tools
  issues_new: { sound: false, mac: false, gchat: false }, // v2.7 §5.6 information only: the orange dot + card
  superpowers_off: { sound: false, mac: true, gchat: true }, // v2.7 §7.3 new lanes wait for the PO
  revert_conflict: { sound: false, mac: true, gchat: true }, // v2.7 §5.7-5 the revert stopped, the PO decides
  orchestrator_note: { sound: false, mac: true, gchat: false },
});

/** §6A card kind label per language (`notify.kind_<kind>`). */
const kindText = (lang: Lang, k: Card['kind']) => t(lang, `notify.kind_${k}`);
/** §6A a card's title in `lang`: its catalog key when it has one (ask / permission / new system rows), else the stored text. */
function titleIn(lang: Lang, c: Card): string {
  if (c.kind === 'ask') { const a = c.payload as AskPayload; return t(lang, 'cards.ask', { source: sourceText(lang, a.source), question: a.question }); }
  if (c.kind === 'permission') { const a = c.payload as PermissionPayload; const k = permissionTitleKey(a.source, a.toolName, a.input, a.description); return t(lang, k.titleKey, withSource(lang, k.params)); }
  const p = c.payload as SystemPayload;
  return p.titleKey && hasKey(lang, p.titleKey) ? t(lang, p.titleKey, p.params) : p.title;
}
const QUESTION_MAX = 200;
const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export interface ProjectNotify { name: string; gchatWebhook: string | null; gchatSendCommandText: boolean }
export interface RemoteInfo { enabled: boolean; hostname: string | null }

/** §8.3 N6 message text for one card. */
export function gchatText(c: Card, p: Pick<ProjectNotify, 'name' | 'gchatSendCommandText'>, remote: RemoteInfo, lang: Lang = 'vi', seq: number | null = null): string {
  const parts: string[] = [p.name, ...(seq !== null ? [`#${seq}`] : [])]; // §4.15 §4 same pattern as the macOS title
  if (c.kind === 'ask') {
    const a = c.payload as AskPayload;
    parts.push(sourceText(lang, a.source), kindText(lang, 'ask'), clip(a.question, QUESTION_MAX));
    if (a.options.length) parts.push(a.options.map((o) => clip(o.label, 60)).join(' / '));
  } else if (c.kind === 'permission') {
    const a = c.payload as PermissionPayload;
    parts.push(sourceText(lang, a.source), kindText(lang, 'permission'),
      clip(p.gchatSendCommandText ? titleIn(lang, c) : t(lang, 'notify.wantsToRun', { source: sourceText(lang, a.source), tool: a.toolName }), QUESTION_MAX));
  } else {
    parts.push(kindText(lang, c.kind), clip(titleIn(lang, c), QUESTION_MAX));
  }
  if (remote.enabled && remote.hostname) parts.push(`https://${remote.hostname}/c/${c.id}`);
  return parts.join(' · ');
}

export interface NotifierDeps {
  project: (id: string) => ProjectNotify | null;
  projectIds: () => string[];
  /** The lane / orchestrator a card belongs to (R10), null for account-level cards. */
  targetOf: (c: Card) => Target | null;
  emit: (e: EngineEvent) => void;
  /** A Mac app WebSocket is connected (it shows macOS notifications itself). */
  appConnected: () => boolean;
  /** R10: the PO is looking at this target right now (per node: an orchestrator target names its session). */
  viewing: (t: Target) => boolean;
  /** v2.1 §4.15 §4 "#n" of the target's session when the project has > 1 running session; null otherwise. */
  seqOf?: (t: Target) => number | null;
  osascript: (title: string, body: string) => void;
  postGchat: (url: string, text: string) => Promise<void>;
  remote: () => RemoteInfo;
  /** Cài đặt › Thông báo: `config.notify` + `config.sound`, read at send time (absent = defaults). */
  prefs?: () => { notify: unknown; sound: unknown };
  /** §6A `config.ui.lang`, read at send time (default `vi`). */
  lang?: () => Lang;
  log?: (line: string) => void;
}

/** `osascript -e 'display notification …'` with the text passed as argv (no AppleScript string injection). */
export function osascriptNotify(title: string, body: string): void {
  try {
    Bun.spawn(['osascript', '-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body],
      { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  } catch { /* no notification is better than a crash */ }
}

export async function postGchat(url: string, text: string): Promise<void> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ text }) });
  if (!r.ok) throw new Error(`Google Chat trả ${r.status}`);
}

/** §4.15 §4 "project · #n · lane" (#n only when > 1 session is running). */
export const notifyTitle = (project: string | null | undefined, seq: number | null, label: string | null): string =>
  [project, seq !== null ? `#${seq}` : null, label].filter(Boolean).join(' · ') || 'cc-slaves';

const targetLabel = (lang: Lang, x: Target | null) => (x === null ? null : x.kind === 'lane' ? x.name : t(lang, 'notify.orchestrator'));

export class Notifier {
  private allFull = false;

  constructor(private readonly d: NotifierDeps) {}

  private get lang(): Lang { return this.d.lang?.() ?? 'vi'; }
  private get matrix(): NotifyMatrix { return notifyMatrix(this.d.prefs?.().notify); }
  /** Matrix cell for `kind` on `ch`, else the kind's fixed route. */
  private on(kind: NotifyKind, ch: 'app' | 'macos' | 'gchat'): boolean {
    const r = ROUTES[kind];
    return notifyOn(this.matrix, kind, ch, ch === 'app' ? true : ch === 'macos' ? r.mac : r.gchat);
  }
  private toast(kind: NotifyKind, level: 'info' | 'warn' | 'error', text: string): void {
    if (this.on(kind, 'app')) this.d.emit({ type: 'toast', level, text });
  }
  /** Every project's room (account-level events). */
  private async postAll(text: (p: ProjectNotify) => string): Promise<void> {
    await Promise.all(this.d.projectIds().map((id) => { const pr = this.d.project(id); return pr ? this.post(pr, text(pr)) : Promise.resolve(); }));
  }

  /** A new card (ask / permission / system). */
  async card(c: Card): Promise<void> {
    const p = c.projectId ? this.d.project(c.projectId) : null;
    const lang = this.lang;
    const tg = this.d.targetOf(c);
    const label = targetLabel(lang, tg);
    const seq = tg ? this.d.seqOf?.(tg) ?? null : null;
    const title = notifyTitle(p?.name, seq, label);
    const body = c.kind === 'ask' ? clip((c.payload as AskPayload).question, QUESTION_MAX) : titleIn(lang, c);
    this.local(c.kind, title, body, tg, c.id, c.projectId);
    if (!this.on(c.kind, 'gchat')) return;
    const ids = p ? [c.projectId!] : this.d.projectIds(); // account-level cards go to every project's room
    await Promise.all(ids.map((id) => {
      const pr = this.d.project(id);
      return pr ? this.post(pr, gchatText(c, pr, this.d.remote(), lang, id === c.projectId ? seq : null)) : Promise.resolve();
    }));
  }

  async laneDone(projectId: string, name: string): Promise<void> {
    const p = this.d.project(projectId);
    const text = t(this.lang, 'notify.laneDone', { name });
    this.toast('lane_done', 'info', `${p?.name ?? projectId} · ${text}`);
    const tg: Target = { kind: 'lane', projectId, name };
    const seq = this.d.seqOf?.(tg) ?? null;
    this.local('lane_done', notifyTitle(p?.name ?? projectId, seq, name), text, tg);
    if (p && this.on('lane_done', 'gchat')) await this.post(p, `${p.name} · ${text}`);
  }

  async accountSwitch(projectId: string, name: string, account: string): Promise<void> {
    const p = this.d.project(projectId);
    const text = t(this.lang, 'notify.switched', { name, account });
    this.toast('account_switch', 'info', `${p?.name ?? projectId} · ${text}`);
    if (this.on('account_switch', 'macos')) this.local('account_switch', notifyTitle(p?.name ?? projectId, null, name), text, { kind: 'lane', projectId, name });
    if (p && this.on('account_switch', 'gchat')) await this.post(p, `${p.name} · ${text}`);
  }

  /** A lane reminder toast (§7.4 message to a stopped lane): keyed → rendered in `ui.lang`, else its own text. */
  async remind(r: { text: string; key?: Key; params?: Params }): Promise<void> {
    this.d.emit({ type: 'toast', level: 'info', text: r.key && hasKey(this.lang, r.key) ? t(this.lang, r.key, r.params) : r.text });
  }

  /** MCP `notify` from an orchestrator. */
  async orchestratorNote(projectId: string, level: 'info' | 'warn' | 'error', text: string): Promise<void> {
    const p = this.d.project(projectId);
    this.d.emit({ type: 'toast', level, text: `${p?.name ?? projectId} · ${text}` });
    this.local('orchestrator_note', `${p?.name ?? projectId} · ${t(this.lang, 'notify.orchestrator')}`, clip(text, QUESTION_MAX), { kind: 'orchestrator', projectId });
  }

  /** §8.3 "Mọi account đầy": one notification per episode; the episode ends when any account has room again. */
  async accountsFull(full: boolean): Promise<void> {
    if (!full) { this.allFull = false; return; }
    if (this.allFull) return;
    this.allFull = true;
    const text = t(this.lang, 'notify.allFull');
    this.toast('all_full', 'warn', text);
    this.local('all_full', 'cc-slaves', text, null);
    if (!this.on('all_full', 'gchat')) return;
    const remote = this.d.remote();
    await this.postAll((pr) => `${pr.name} · ${text}${remote.enabled && remote.hostname ? ` · https://${remote.hostname}/` : ''}`);
  }

  private local(kind: NotifyKind, title: string, body: string, t: Target | null, cardId?: number, projectId?: string | null): void {
    const r = ROUTES[kind];
    const mac = this.on(kind, 'macos') && !(t !== null && this.d.viewing(t));
    const sound = r.sound && this.on(kind, 'app') && this.d.prefs?.().sound !== false;
    if (this.d.appConnected()) {
      const pid = t?.projectId ?? projectId ?? null; // §4.15 §4 click target (notify.rs)
      this.d.emit({
        type: 'notify', kind, title, body, sound, mac, ...(cardId !== undefined ? { cardId } : {}),
        ...(pid ? { projectId: pid } : {}), ...(t?.kind === 'lane' ? { lane: t.name } : {}),
      });
    } else if (mac) {
      this.d.osascript(title, body);
    }
  }

  private async post(p: ProjectNotify, text: string): Promise<void> {
    if (!p.gchatWebhook) return;
    try { await this.d.postGchat(p.gchatWebhook, text); } catch (e) { this.d.log?.(`Google Chat lỗi: ${(e as Error).message}`); }
  }
}
