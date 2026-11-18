// v2.1 §4.14 the shell side of parallel sessions: which running session Đang xem shows (deck root + composer / watch
// target), the "Lịch sử phiên" list (popover under the Inspector header), the session dialogs (open / end / rename /
// resume) and the 5 s "Hoàn tác" of "Đổi chủ lane".
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Command, OrchestratorView, ResumePreview, SessionRowView, SessionsList, Snapshot } from '../../../shared/protocol.ts';
import type { SessionDialog } from '../lib/actions.ts';
import type { Tr } from '../lib/i18n.tsx';
import { ORCH, type DrawerEvent } from '../lib/inspector.ts';
import { histRect, type Rect } from '../lib/menu.ts';
import { reassignBack, sessionsOf, UNDO_MS, viewedSession } from '../lib/sessions.ts';
import type { StartReq } from '../lib/start.ts';
import type { EngineClient } from '../lib/ws.ts';
import type { AppState } from './useAppState.ts';

export const rectOf = (el: Element): Rect => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };

interface SessionsDeps {
  ui: AppState; snap: Snapshot | null; pid: string | null; client: EngineClient; tr: Tr;
  send: (c: Command) => Promise<unknown>; drawer: (e: DrawerEvent) => void;
}

export function useSessions({ ui, snap, pid, client, tr, send, drawer }: SessionsDeps) {
  const { sel, pick: pickSel, viewSid, setViewSid, setHistAt, sessions, setSessions, setSessDlg, moved, setMoved, setFitReq, modelReq, setModelReq } = ui;
  const os = useMemo(() => (snap ? sessionsOf(snap, pid) : []), [snap, pid]);
  const viewed = viewedSession(os, viewSid), sid = viewed?.sessionId ?? null;
  // N5-h a new root (open / resume in parallel) may land outside the frame: fit the deck once it is drawn
  const roots = useRef(os.length);
  useEffect(() => { if (os.length > roots.current) setFitReq(n => n + 1); roots.current = os.length; }, [os.length, setFitReq]);
  const load = useCallback(() => {
    if (pid) client.send({ cmd: 'sessions_list', projectId: pid }).then(r => setSessions(r as SessionsList), () => {});
  }, [client, pid, setSessions]);
  /** the list drops under the Inspector header (inside the narrow drawer, which opens first and may still be sliding in) */
  const openHistory = (anchor?: Element | null) => {
    drawer('node');
    load();
    setTimeout(() => {
      const box = document.querySelector('#inspector'), a = anchor ?? document.querySelector('#inspector .oname') ?? document.querySelector('#inspector .ih');
      if (!box) return;
      const left = document.querySelector('#left'), tf = left ? getComputedStyle(left).transform : 'none';
      const b = rectOf(box);
      setHistAt(histRect(b, a ? rectOf(a) : b, tf && tf !== 'none' ? new DOMMatrixReadOnly(tf).m41 : 0));
    }, 0);
  };
  const view = (sessionId: string) => { setViewSid(sessionId); pickSel(ORCH); };
  const pick = (r: SessionRowView) => {
    setHistAt(null);
    if (r.state === 'ended') pickSel({ k: 'session', sessionId: r.sessionId });
    else view(r.sessionId);
  };
  const dialog = (kind: SessionDialog, sessionId: string | null) => {
    if (!pid) return;
    if (kind === 'history') return openHistory();
    if (kind === 'model') { if (sessionId && sessionId !== sid) view(sessionId); return setModelReq(r => ({ n: r.n + 1 })); } // v2.4 §4.2
    if (kind === 'parallel') { load(); return setSessDlg({ k: 'parallel', projectId: pid }); }
    const s2 = sessionId ?? sid;
    if (!s2) return;
    if (kind === 'new') { // F21 "Phiên mới (thay #n)…": confirm, then that session is replaced
      if (window.confirm(tr('session.newConfirm', { n: os.find(o => o.sessionId === s2)?.seq ?? 1 }))) void send({ cmd: 'orchestrator_new', projectId: pid, sessionId: s2 }).catch(() => {});
      return;
    }
    setSessDlg(kind === 'end' ? { k: 'end', sessionId: s2 } : { k: 'rename', sessionId: s2 });
  };
  /** open / resume answered with the new session's view: Đang xem moves to it (N5-h) */
  const started = (v: OrchestratorView) => { setSessDlg(null); if (v.sessionId) view(v.sessionId); };
  useEffect(() => { if (sel.k === 'session' && !sessions?.ended.some(r => r.sessionId === sel.sessionId)) load(); }, [sel, sessions, load]);
  useEffect(() => { if (!moved) return; const h = setTimeout(() => setMoved(null), UNDO_MS); return () => clearTimeout(h); }, [moved, setMoved]);
  const loadPreview = (sessionId: string) => client.send({ cmd: 'session_resume_preview', sessionId }).then(r => r as ResumePreview, () => null);
  const undoMove = () => { if (moved) void send(moved.back).catch(() => {}); setMoved(null); };
  const onMoved = (m: { projectId: string; name: string; from: string | null; toSession: string }) => {
    const back = reassignBack(m);
    if (back) setMoved({ text: tr('session.moved', { name: m.name, n: os.find(o => o.sessionId === m.toSession)?.seq ?? '?' }), back, at: Date.now() });
  };
  /** a project switch forgets the viewed session and the list */
  const reset = () => { setViewSid(null); setSessions(null); setHistAt(null); };
  /** the Inspector's §4.14 props: session head / list / read-only ended view */
  const inspector = {
    sessions: os, viewed, sessionsList: sessions, onHistory: (el: Element) => openHistory(el), onView: view,
    onSessionResume: (sessionId: string, from?: 'handoff' | 'tail') => setSessDlg({ k: 'resume', sessionId, ...(from ? { from } : {}) }),
    onOpenHandoff: (path: string) => void send({ cmd: 'open_in_vscode', path }).catch(() => {}), loadPreview, modelReq,
  };
  /** v2.7.1 §4.1 open the start dialog (G2b's "Bắt đầu ▾": kind, spec, defaults; `direct` = the main part). */
  const start = (req: StartReq) => setSessDlg({ k: 'start', req });
  return { os, viewed, sid, inspector, load, openHistory, view, pick, dialog, started, start, loadPreview, undoMove, onMoved, reset };
}
