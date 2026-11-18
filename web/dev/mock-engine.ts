// Dev mock engine: a Bun WS server speaking shared/protocol.ts with scripted frames, so the UI runs without the engine.
// Run: `bun run web:dev` (starts this + Vite). Pick a frame with ?f=F4 on the page URL; ?remote=1 simulates the phone channel.
import type { ServerWebSocket } from 'bun';
import { REMOTE_ALLOWED, type AccountView, type ClientMsg, type Command, type EngineEvent, type ServerMsg, type Snapshot, type StreamLine, type Target } from '../../shared/protocol.ts';
import { existsSync } from 'node:fs';
import { codeFs, type FsCmd } from './code-fs.ts';
import { GIT_SCENES, gitReply, gitSnapshot, type GitScene } from './mock-git.ts';
import { MD_SCENES, modelLines, modelReply, modelSnapshot, type MdScene } from './mock-model.ts';
import { deckLines } from './deck-scene.ts';
import { issuesAnswer, openSession } from './issues-mock.ts';
import { mockRows, wfReply } from './wf-mock.ts';
import { ENDED_ROWS, freeAccount, resumePreview, sessionsList } from './sessions.ts';
import { DECK_SUBS, deckOrchHistory, DONE_LANES, doneLanesPage, FRAMES, GIT_SETUP, INSTALL_LOG, laneHistory, ORCH_STREAM, orchHistory, snapshotFor, subHistory, SUBS, withGitSetup, type Frame, type GitSetupScene } from './scenarios.ts';

interface Conn { git: GitScene | null; md: MdScene | null; f: Frame; channel: 'mac' | 'remote'; snap: Snapshot; streams: Map<string, StreamLine[]>; watch: Target | null; timers: Timer[] }
const key = (t: Target) => (t.kind === 'orchestrator' ? `o:${t.projectId}${t.sessionId && t.sessionId !== 's3' ? `:${t.sessionId}` : ''}` : `l:${t.projectId}:${t.name}`);
/** F10 / IS8c: refuse reconnects of that frame until then */
const downUntil: Record<string, number> = {};

const out = (ws: ServerWebSocket<Conn>, m: ServerMsg) => ws.send(JSON.stringify(m));
const ev = (ws: ServerWebSocket<Conn>, e: EngineEvent) => out(ws, { type: 'event', event: e });
const later = (ws: ServerWebSocket<Conn>, ms: number, fn: () => void) => { ws.data.timers.push(setTimeout(fn, ms)); };

function lines(c: Conn, t: Target): StreamLine[] {
  const k = key(t);
  if (!c.streams.has(k)) {
    const h = deckLines(c.f, t) ?? (t.kind === 'orchestrator' ? (t.projectId === 'hagenta' ? orchHistory() : t.projectId === 'p1' ? deckOrchHistory(t.sessionId ?? null) : []) : laneHistory(t.name));
    const extra = t.kind === 'orchestrator' ? modelLines(c.md) : [], at = h.at(-1)?.ts ?? Date.now();
    c.streams.set(k, [...h, ...extra.map((l, i) => ({ ...l, seq: (h.at(-1)?.seq ?? 0) + i + 1, ts: at + (i + 1) * 20_000 }))]);
  }
  return c.streams.get(k)!;
}

function push(ws: ServerWebSocket<Conn>, t: Target, l: Omit<StreamLine, 'seq' | 'ts'>) {
  const ls = lines(ws.data, t);
  const line = { ...l, seq: (ls.at(-1)?.seq ?? 0) + 1, ts: Date.now() };
  ls.push(line);
  if (ws.data.watch && key(ws.data.watch) === key(t)) ev(ws, { type: 'stream', target: t, lines: [line] });
}

/** Stream `text` as partial deltas (M16), then the final assistant line. */
function streamReply(ws: ServerWebSocket<Conn>, t: Target, text: string, start = 0) {
  let i = start;
  const tick = () => {
    i = Math.min(text.length, i + 6);
    if (ws.data.watch && key(ws.data.watch) === key(t)) ev(ws, { type: 'partial', target: t, key: `mock:${start}`, parent: null, full: text.slice(0, i) });
    if (i < text.length) later(ws, 60, tick);
    else later(ws, 300, () => push(ws, t, { kind: 'assistant', text }));
  };
  later(ws, 400, tick);
}

function handle(ws: ServerWebSocket<Conn>, id: string, c: Command) {
  const s = ws.data.snap;
  const ack = (result?: unknown) => out(ws, { type: 'ack', id, result });
  if (ws.data.channel === 'remote' && !REMOTE_ALLOWED.has(c.cmd)) return out(ws, { type: 'error', id, code: 'forbidden_remote', message: 'Lệnh này chỉ chạy trên Mac.' });
  if ((c as { cmd: string }).cmd.startsWith('fs_')) { // v2.3 §10.2 Code reads (dev fixture tree)
    const [r, err] = codeFs(c as unknown as FsCmd);
    return err === undefined ? ack(r) : out(ws, { type: 'error', id, code: 'fs', message: err });
  }
  const g = gitReply(ws.data.git ?? 'G1', s, c); // v2.3 §6 Git view data (`?g=<scene>`, web/dev/mock-git.ts)
  if (g) return 'ok' in g ? ack(g.ok) : out(ws, { type: 'error', id, ...g });
  const m = modelReply(ws.data.md ?? 'MD2', c);
  if (m) return 'ok' in m ? ack(m.ok) : 'wait' in m ? undefined : out(ws, { type: 'error', id, ...m });
  const w = wfReply(s, c); // v2.9 G5 the library the Tasks chip / rail read (web/dev/wf-mock.ts)
  if (w) {
    ack(w.result);
    if (c.cmd === 'project_set_workflow') { ev(ws, { type: 'project', project: s.projects.find(p => p.id === c.projectId)! }); ev(ws, { type: 'workflows_changed', rows: s.workflows! }); }
    return;
  }
  switch (c.cmd) {
    case 'watch':
      ws.data.watch = c.target; ack();
      if (c.target?.kind === 'lane' && c.target.name === 'D2') ev(ws, { type: 'subagents', target: c.target, subagents: SUBS });
      if (ws.data.f.startsWith('DK')) for (const [name, subagents] of Object.entries(DECK_SUBS)) ev(ws, { type: 'subagents', target: { kind: 'lane', projectId: 'p1', name }, subagents });
      if (c.target?.kind === 'orchestrator' && c.target.projectId === 'hagenta' && ws.data.f === 'F3') streamReply(ws, c.target, ORCH_STREAM, Math.floor(ORCH_STREAM.length * 0.55));
      return;
    case 'history': {
      const ls = lines(ws.data, c.target), before = c.beforeSeq ?? Infinity, limit = c.limit ?? 100;
      return ack(ls.filter(l => l.seq < before).slice(-limit));
    }
    case 'send': {
      const lane = c.target.kind === 'lane' ? s.lanes.find(l => l.name === (c.target as { name: string }).name) : null;
      const running = lane ? lane.state === 'running' : s.orchestrators.find(o => o.projectId === c.target.projectId)?.state === 'running';
      ack();
      push(ws, c.target, { kind: 'po', text: c.text, inTurn: running });
      streamReply(ws, c.target, `Đã nhận: “${c.text}”. Em xử lý ngay.`);
      return;
    }
    case 'interrupt': ack(); return push(ws, c.target, { kind: 'engine', text: '[cc-slaves] đã ngắt lượt — phiên vẫn sống' });
    case 'card_answer': {
      const card = s.cards.find(x => x.id === c.id);
      if (!card || card.status !== 'open') return out(ws, { type: 'error', id, code: 'card_closed', message: 'Thẻ đã đóng — session đã nhận câu trả lời khác.' });
      Object.assign(card, { status: 'answered', resolvedAt: Date.now(), answer: c.answer });
      ack(); ev(ws, { type: 'card', card });
      const lane = s.lanes.find(l => l.name === card.source && l.state === 'waiting_po');
      if (lane) { lane.state = 'running'; lane.updatedAt = Date.now(); ev(ws, { type: 'lane', lane }); }
      return;
    }
    case 'card_action': {
      const card = s.cards.find(x => x.id === c.id);
      if (!card) return out(ws, { type: 'error', id, code: 'not_found', message: 'Không thấy thẻ.' });
      ack();
      if (c.action === 'lane_resume' || c.action === 'restart_orchestrator' || c.action === 'new_orchestrator' || c.action === 'hand_to_orchestrator') {
        Object.assign(card, { status: 'answered', resolvedAt: Date.now(), answer: { option: c.action === 'lane_resume' ? 'Chạy lại' : c.action === 'hand_to_orchestrator' ? 'Giao điều phối xử lý' : 'Khởi động lại' } });
        ev(ws, { type: 'card', card });
      }
      if (c.action === 'lane_resume') { const l = s.lanes.find(x => x.name === card.source); if (l) { Object.assign(l, { state: 'running', failCount: 0 }); ev(ws, { type: 'lane', lane: l }); } }
      if (c.action === 'restart_orchestrator') { const o = s.orchestrators[0]!; o.state = 'running'; ev(ws, { type: 'orchestrator', orchestrator: o }); }
      ev(ws, { type: 'toast', level: 'info', text: `Đã gửi: ${c.action}` });
      return;
    }
    case 'subagent_history': return ack(subHistory(c.taskId));
    case 'setup_check': ack(); if (s.setup) ev(ws, { type: 'setup', setup: s.setup }); return;
    case 'setup_install': { ack(); install(ws, c.what); return; }
    case 'git_install': return ack({ opened: true }); // hf1116 (b): stays "Đang cài…" (Apple's dialog never answers here)
    case 'git_identity_set': {
      if (s.setup) { s.setup = { ...s.setup, git: { ...s.setup.git, identity: { name: c.name.trim(), email: c.email.trim() } } }; ev(ws, { type: 'setup', setup: s.setup }); }
      return ack(s.setup);
    }
    case 'gh_login': case 'gh_login_cancel': {
      const ghLogin = c.cmd === 'gh_login' ? GIT_SETUP.ghwait.ghLogin : null;
      if (s.setup) { s.setup = { ...s.setup, git: { ...s.setup.git, ghLogin } }; ev(ws, { type: 'setup', setup: s.setup }); }
      return ack(ghLogin ?? undefined);
    }
    case 'caps_update': {
      for (const [email, cap] of Object.entries(c.caps)) {
        const a = s.accounts.find(x => x.email === email);
        if (!a) continue;
        Object.assign(a, { role: cap.role ?? a.role, week: cap.week, five: cap.five ?? null, hard: cap.hard ?? a.hard });
        a.headroomPct = a.weekPct === null ? null : Math.max(0, a.week - a.weekPct); a.full = a.weekPct !== null && (a.hard ? a.weekPct >= a.week - 1 : a.weekPct >= a.week);
        ev(ws, { type: 'account', account: a });
      }
      if (s.setup && c.poEmail) { s.setup.poEmail = c.poEmail; ev(ws, { type: 'setup', setup: s.setup }); }
      return ack();
    }
    case 'config_update': Object.assign(s.config, c.patch); return ack();
    case 'quota_refresh': { // v2.7.1 §4.4: queue (front for one row), one ask every 3 s here (20 s in the engine), new numbers on the way out
      const now = Date.now(), live = s.accounts.filter(a => !a.loggedOut && a.status !== 'needs_probe' && (!c.account || a.email === c.account));
      const queued = live.filter(a => a.refresh.state === 'idle' && (a.fetchedAt === null || now - a.fetchedAt >= 60_000 || c.account)).map(a => a.email);
      ack({ queued, skipped: live.filter(a => !queued.includes(a.email)).map(a => ({ email: a.email, reason: 'recent', until: (a.fetchedAt ?? now) + 60_000 })), cooldownUntil: null });
      const push = (email: string, refresh: AccountView['refresh'], fetchedAt?: number) => {
        const a = s.accounts.find(x => x.email === email)!;
        Object.assign(a, { refresh }, fetchedAt ? { fetchedAt, fresh: true } : {});
        ev(ws, { type: 'account', account: a });
      };
      queued.forEach((e, i) => push(e, { state: 'queued', at: now + i * 3000 }));
      s.quota = { ...s.quota, queueEndsAt: Math.ceil((now + queued.length * 3000) / 60_000) * 60_000 };
      ev(ws, { type: 'quota', quota: s.quota });
      queued.forEach((e, i) => {
        later(ws, i * 3000 + 50, () => push(e, { state: 'fetching', at: null }));
        later(ws, i * 3000 + 1500, () => push(e, { state: 'idle', at: null }, Date.now()));
      });
      later(ws, queued.length * 3000, () => { s.quota = { ...s.quota, queueEndsAt: null }; ev(ws, { type: 'quota', quota: s.quota }); });
      return;
    }
    case 'project_add': {
      const p = c.path.replace(/^~/, process.env.HOME ?? '~');
      if (!existsSync(p + '/.git')) return out(ws, { type: 'error', id, code: 'not_git', message: 'Thư mục này không phải git repo — chưa thêm. Chọn thư mục có .git.' });
      const project = { id: p, name: c.name, path: p, orchestratorAccount: c.orchestratorAccount ?? s.accounts[0]?.email ?? null, gchatWebhookSet: false, gchatSendCommandText: false } as const;
      s.projects.push({ ...project }); ack(); ev(ws, { type: 'project', project: { ...project } });
      const orchestrator = { projectId: p, state: 'starting' as const, account: project.orchestratorAccount, homeAccount: project.orchestratorAccount, lastError: null, costUsd: 0, contextPct: 0, talkingTo: null };
      s.orchestrators.push(orchestrator); ev(ws, { type: 'orchestrator', orchestrator });
      later(ws, 2000, () => { orchestrator.state = 'idle' as never; ev(ws, { type: 'orchestrator', orchestrator }); });
      return;
    }
    case 'project_update': {
      const p = s.projects.find(x => x.id === c.id);
      if (!p) return out(ws, { type: 'error', id, code: 'not_found', message: 'Không thấy project.' });
      const { gchatWebhook, ...rest } = c.patch;
      Object.assign(p, rest, gchatWebhook !== undefined ? { gchatWebhookSet: !!gchatWebhook } : {}); ack(); return ev(ws, { type: 'project', project: p });
    }
    case 'project_remove': s.projects = s.projects.filter(x => x.id !== c.id); ack(); return ev(ws, { type: 'project_removed', id: c.id });
    case 'lane_switch_account': {
      const l = s.lanes.find(x => x.projectId === c.projectId && x.name === c.name);
      if (!l) return out(ws, { type: 'error', id, code: 'not_found', message: 'Không thấy lane.' });
      ack(); l.state = 'switching'; ev(ws, { type: 'lane', lane: l });
      later(ws, 1500, () => { l.account = c.account ?? 'bo24990@example.com'; l.state = 'running'; l.switches++; ev(ws, { type: 'lane', lane: l }); });
      return;
    }
    case 'lane_stop': case 'lane_resume': {
      const l = s.lanes.find(x => x.projectId === c.projectId && x.name === c.name);
      if (!l) return out(ws, { type: 'error', id, code: 'not_found', message: 'Không thấy lane.' });
      ack(); l.state = c.cmd === 'lane_resume' ? 'running' : c.mode === 'now' ? 'stopped' : 'draining'; return ev(ws, { type: 'lane', lane: l });
    }
    case 'orchestrator_restart': { ack(); const o = s.orchestrators.find(x => x.projectId === c.projectId)!; o.state = 'running'; return ev(ws, { type: 'orchestrator', orchestrator: o }); }
    // v2.1 §4.14 sessions (frame DKS)
    case 'done_lanes_list': // v2.1 §4.15 §3 (DKX): every done lane, newest first, filtered like the engine
      return ack(doneLanesPage(DONE_LANES.length ? DONE_LANES : s.lanes.filter(l => l.state === 'done'), c));
    case 'lane_continue_preview': return ack({ projectId: c.projectId, name: c.name, resumable: true, reason: null, ctxLast: 84_000,
      estimate: { tokens: 84_000, pct: 6, samples: 5 }, account: freeAccount(s), accountLast: null, worktreeExists: false, branch: `lane/${c.name.toLowerCase()}`, ahead: 4 });
    case 'sessions_list': return ack(sessionsList(s, c.projectId));
    case 'session_resume_preview': return ack(resumePreview(s, c.sessionId));
    case 'session_resume': case 'session_open': {
      const row = c.cmd === 'session_resume' ? ENDED_ROWS.find(r => r.sessionId === c.sessionId) : null;
      const base = s.orchestrators[0]!, seq = row?.seq ?? Math.max(...s.orchestrators.map(o => o.seq ?? 1)) + 1;
      const o = { ...base, sessionId: row?.sessionId ?? `s${seq}`, seq, title: row?.title ?? null, talkingTo: null, contextPct: 71, state: row ? 'starting' as const : 'running' as const };
      if (row) { // m-5 N5-h like the engine: the resume divider, then its first "[cc-slaves] …" line; the session is still starting
        o.account = c.cmd === 'session_resume' ? c.account ?? freeAccount(s) ?? o.account : o.account;
        const replaced = c.replaceId ? s.orchestrators.find(x => x.sessionId === c.replaceId)?.seq ?? null : null, t = { kind: 'orchestrator' as const, projectId: row.projectId, sessionId: row.sessionId };
        push(ws, t, { kind: 'engine', text: '', boundary: { type: 'resume', seq, at: Date.now(), account: o.account, mode: c.replaceId ? 'replace' : 'parallel', replaced } });
        const since = resumePreview(s, row.sessionId).sinceStop.map(l => (l.kind === 'done' ? `${l.name} xong` : `${l.name} → #${l.seq ?? '?'}`)).join(', ');
        push(ws, t, { kind: 'engine', text: `[cc-slaves] Phiên này được nối lại sau ${Math.max(1, Math.round((Date.now() - (row.endedAt ?? Date.now())) / 86_400_000))} ngày. Từ lúc dừng: ${since}. Gọi \`lanes_list\` trước khi ra lệnh.` });
      }
      if (c.replaceId) s.orchestrators = s.orchestrators.filter(x => x.sessionId !== c.replaceId);
      s.orchestrators.push(o); ack(o);
      return ev(ws, { type: 'orchestrator', orchestrator: o });
    }
    case 'presence': return ack(); // M5 sent by the app itself on focus / blur: no "mock:" toast in the shots
    // v2.7 R-B12 the Tasks tab scans on open; IS8b = still loading (never answered)
    case 'spec_scan': return ws.data.f === 'IS8b' ? undefined : ack({ imported: 0, moved: 0 });
    case 'spec_outputs': case 'spec_prior_sessions': case 'issue_cancel_preview': case 'issue_cancel': case 'issue_file':
      return ack(issuesAnswer(c, s, ws.data.f));
    case 'spec_new': case 'spec_build': case 'spec_edit': { // UX I11 / N6: the new session (bound to its spec) is selected on the Deck
      const { o, spec } = openSession(s, c.projectId, c.cmd === 'spec_build' ? 'build' : 'design', c.cmd === 'spec_new' ? undefined : c.path);
      ack({ sessionId: o.sessionId });
      if (spec) ev(ws, { type: 'spec_changed', spec });
      return ev(ws, { type: 'orchestrator', orchestrator: o });
    }
    default:
      ack();
      return ev(ws, { type: 'toast', level: 'info', text: `mock: ${c.cmd}` });
  }
}

/** F1b: stream an install log, then mark the dependency installed. */
function install(ws: ServerWebSocket<Conn>, what: string) {
  const lines = INSTALL_LOG[what] ?? ['?'];
  lines.forEach((line, i) => later(ws, 400 * (i + 1), () => {
    const done = i === lines.length - 1;
    ev(ws, { type: 'install_log', job: what, line, ...(done ? { done: true, ok: true } : {}) });
    const st = ws.data.snap.setup;
    if (done && st) {
      st.claude = { found: true, path: '~/.local/bin/claude', version: what === 'claude' ? '2.1.325' : '2.1.330', ok: true };
    }
  }));
}

const port = Number(process.env.MOCK_PORT ?? 4318);
Bun.serve<Conn, never>({
  port,
  fetch(req, server) {
    const u = new URL(req.url);
    if (u.pathname !== '/ws') return new Response('cc-slaves mock engine — connect to /ws', { status: 404 });
    const f = (FRAMES as readonly string[]).includes(u.searchParams.get('f') ?? '') ? (u.searchParams.get('f') as Frame) : 'F3';
    if (Date.now() < (downUntil[f] ?? 0)) return new Response(`engine down (mock ${f})`, { status: 503 });
    const channel = u.searchParams.get('remote') ? 'remote' : 'mac';
    const snap = snapshotFor(f, channel);
    for (const p of snap.projects) p.workflow ??= 'builtin:po'; // v2.9 §4.6 NOT NULL on the engine (default Quy trình PO)
    if (channel === 'mac') snap.workflows = mockRows(snap); // v2.9 §10.1 Mac only
    if (u.searchParams.get('lang') === 'en') snap.config = { ...snap.config, ui: { lang: 'en' } }; // §6A dev frames in en
    const nCards = u.searchParams.get('cards'); // m-2 e2e: the deck frame with exactly n Chờ PO cards (copies of its first card)
    if (nCards !== null) snap.cards = Array.from({ length: Number(nCards) }, (_, i) => snap.cards[i] ?? { ...snap.cards[0]!, id: 9_000 + i });
    const gs = u.searchParams.get('gs') as GitSetupScene | null; // hf1116 (b) Git block state
    if (gs && gs in GIT_SETUP) withGitSetup(snap, gs);
    const gq = u.searchParams.get('g') as GitScene | null, git = gq && GIT_SCENES.includes(gq) ? gq : null;
    if (git) gitSnapshot(snap, git);
    const mq = u.searchParams.get('md') as MdScene | null, md = mq && MD_SCENES.includes(mq) ? mq : null;
    modelSnapshot(snap, md);
    const ok = server.upgrade(req, { data: { git, md, f, channel, snap, streams: new Map(), watch: null, timers: [] } });
    return ok ? undefined : new Response('upgrade failed', { status: 400 });
  },
  websocket: {
    open(ws) {
      out(ws, { type: 'snapshot', snapshot: ws.data.snap });
      const s = ws.data.snap;
      if (ws.data.f === 'F1b') install(ws, 'claude');
      if (ws.data.f === 'F13') later(ws, 3000, () => {
        s.orchestrators[0]!.state = 'running'; ev(ws, { type: 'orchestrator', orchestrator: s.orchestrators[0]! });
        s.lanes.forEach(l => { l.state = 'running'; ev(ws, { type: 'lane', lane: l }); });
      });
      // F10: drop the socket after 3 s and refuse reconnects for 40 s (→ "lần N", then the 30 s banner).
      if (ws.data.f === 'F10') later(ws, 3000, () => { downUntil.F10 = Date.now() + 40_000; ws.close(); });
      // v2.7 IS8c: the engine goes away after the data is in, and stays away (the Tasks band + dimmed last data)
      if (ws.data.f === 'IS8c') later(ws, 1500, () => { downUntil.IS8c = Date.now() + 10 * 60_000; ws.close(); });
      if (ws.data.f === 'F4') later(ws, 6000, () => {
        const card = { ...s.cards[1]!, id: 99, createdAt: Date.now(), source: 'D15', question: 'D15: giữ API cũ song song 1 release hay bỏ luôn?', options: [{ label: 'Giữ song song' }, { label: 'Bỏ luôn' }], recommended: 'Giữ song song', status: 'open' as const, resolvedAt: null };
        s.cards.push(card); ev(ws, { type: 'card', card });
      });
    },
    message(ws, raw) {
      let m: ClientMsg;
      try { m = JSON.parse(String(raw)) as ClientMsg; } catch { return; }
      if (m.type === 'command') handle(ws, m.id, m.command);
    },
    close(ws) { ws.data.timers.forEach(clearTimeout); },
  },
});
console.log(`mock engine on ws://127.0.0.1:${port}/ws — frames: ${FRAMES.join(' ')}`);
