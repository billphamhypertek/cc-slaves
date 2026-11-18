// AppInner's own UI state (spec §4, §4.11b): every useState / useRef of the shell, in their original order.
import { useCallback, useMemo, useRef, useState } from 'react';
import type { AccountsInfo, SessionsList, StreamLine, Target } from '../../../shared/protocol.ts';
import type { MovedToast, SessionDlg } from '../lib/sessions.ts';
import { ClickGuard, type CardBox } from '../lib/cards.ts';
import { applyPick, askFor, ORCH, type InboxFold, type Selection, type SelState } from '../lib/inspector.ts';
import type { CodeKey, Mode } from '../lib/keys.ts';
import type { CodeApi } from '../code/CodeView.tsx';
import type { Rect } from '../lib/menu.ts';
import type { SettingsTab } from '../lib/settings.ts';
import type { SmOpen } from '../lib/skills-mcp.ts';
import type { AccDlg } from './Accounts.tsx';
import type { MenuSrc } from './menuRun.ts';
import { ACC0, DEV, F0, ls } from './appEnv.ts';
import { modeOf } from './shell.ts';

export interface MenuOpen { src: MenuSrc; anchor: Rect; area: Rect; opener: HTMLElement | null; leaving: boolean }

export function useAppState() {
  const [projectId, setProjectId] = useState<string | null>(ls('ccs.project'));
  // §4.11b what Đang xem shows (Điều phối by default); the composer target follows it unless a v2.3 §4.3 "Nhờ …" set the
  // override. `pick` is the only way a PO choice changes `sel` (it drops the override); `ask` sets / clears the override.
  const [so, setSo] = useState<SelState>({ sel: F0 === 'F24' ? { k: 'account', email: DEV?.get('v') === 'full' ? 'dev2609@example.com' : 'pm@example.net' } : ORCH, override: null });
  const pick = useCallback((a: Selection | ((cur: Selection) => Selection)) => setSo(s => applyPick(s, a)), []);
  const ask = useCallback((t: Target | null) => setSo(s => askFor(s, t)), []);
  // v2.7 §4.1 Tasks · Deck · Code · Git per project, in memory for this app run (every project opens in Tasks)
  const [modes, setModes] = useState<Readonly<Record<string, Mode>>>({});
  const setModeOf = useCallback((pid: string, m: Mode) => setModes(x => (x[pid] === m ? x : { ...x, [pid]: m })), []);
  const [codeReq, setCodeReq] = useState<{ k: CodeKey; n: number } | null>(null); // §4.1 ⌘P / ⌘S / ⌘W → the Code view
  const codeApi = useRef<CodeApi | null>(null); // §4.1 the Code view's Esc steps (dialog, ⌘P, edit)
  const [fold, setFold] = useState<InboxFold>({ folded: false, resolvedOpen: false });
  const [drawerOpen, setDrawerOpen] = useState(false); // §4.10 narrow window: the left column drawer, closed by default
  const [listOn, setListOn] = useState(F0 === 'F9' || ls('ccs.list') === '1'); // F9, remembered
  const [accOpen, setAccOpen] = useState(ACC0 === 'open' || ACC0 === 'ready');
  // §4.7 hover both ways: a lane node lights its account row; an account row lights its lanes and dims the rest (v1.1 §4.5 inverse)
  const [hoverAcc, setHoverAcc] = useState<{ email: string; from: 'row' | 'lane' } | null>(null);
  const [fitReq, setFitReq] = useState(0); // v2.1 §4.11 F = "Vừa màn hình" (DeckView fits on every bump)
  const deckKeys = useRef<string[]>([]); // v1.1 §4.7 keys 1–9 follow the deck order
  const deckHidden = useRef<string[]>([]); // v2.1 §4.15 §2 lanes folded into a collapsed row (⌘K "ẩn")
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(F0 === 'F12' ? ((DEV?.get('tab') as SettingsTab) ?? 'proj') : null);
  const [palette, setPalette] = useState(F0 === 'F22');
  const [sm, setSm] = useState<SmOpen | null>(null); // v2.2 §6 the Skills & MCP sheet
  const [wf, setWf] = useState<{ id?: string } | null>(null); // v2.9 §4.2 the Quy trình screen (the pack to open first)
  const smEsc = useRef<(() => boolean) | null>(null); // the sheet's own Esc (closes its dialog first; false = nothing open)
  const [subHist, setSubHist] = useState<Record<string, StreamLine[] | null>>({});
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardDismissed, setWizardDismissed] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [stopLane, setStopLane] = useState<{ projectId: string; name: string } | null>(null);
  const [moveAll, setMoveAll] = useState<string | null>(null);
  // composer prefill; `append` (§4.15 §3 "Nhờ … merge") goes under a draft instead of replacing it
  const [draft, setDraft] = useState<{ text: string; n: number; append?: boolean } | null>(null);
  const [menu, setMenu] = useState<MenuOpen | null>(null);
  const [muted, setMuted] = useState(ls('ccs.muted') === '1');
  const [focusPick, setFocusPick] = useState<number | null>(null);
  const [cardBox, setCardBox] = useState<CardBox | null>(null); // v2.4 §6.7 the Chờ PO detail box
  const [width, setWidth] = useState(window.innerWidth);
  const [now, setNow] = useState(Date.now());
  const [newIds, setNewIds] = useState<Set<number>>(new Set());
  const [seenAt, setSeenAt] = useState<Record<string, number>>({});
  const [accDlg, setAccDlg] = useState<AccDlg | null>(null); // v2 §6 A3–A9 dialogs (on top of Settings)
  const [accInfo, setAccInfo] = useState<AccountsInfo | null>(null);
  const accEsc = useRef<(() => void) | null>(null);
  const addEsc = useRef<(() => void) | null>(null); // "Thêm project" progress: Esc closes a failure, never a running step
  // v2.1 §4.14 the running session Đang xem shows (null = the first one), the session list (open at a rect), its data,
  // the session dialogs and the reassign undo toast
  const [viewSid, setViewSid] = useState<string | null>(null);
  const [histAt, setHistAt] = useState<Rect | null>(null);
  const [sessions, setSessions] = useState<SessionsList | null>(null);
  const [sessDlg, setSessDlg] = useState<SessionDlg | null>(null);
  const [moved, setMoved] = useState<MovedToast | null>(null);
  // v2.4 §4.2 / §4.5 "⋯" / ⌘K → open the model picker (of Điều phối, or of `lane`)
  const [modelReq, setModelReq] = useState<{ n: number; lane?: string }>({ n: 0 });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const guard = useMemo(() => new ClickGuard(), []);
  const seenCards = useRef<Set<number> | null>(null);
  const loadingOlder = useRef(false);
  return {
    projectId, setProjectId, sel: so.sel, composerOverride: so.override, pick, ask, modeOf: (pid: string | null, tasksOn: boolean) => modeOf(modes, pid, tasksOn), setModeOf,
    codeReq, setCodeReq, codeApi, fold, setFold, drawerOpen, setDrawerOpen, listOn, setListOn, accOpen, setAccOpen,
    hoverAcc, setHoverAcc, fitReq, setFitReq, deckKeys, deckHidden, settingsTab, setSettingsTab, palette, setPalette, sm, setSm, smEsc, wf, setWf,
    subHist, setSubHist, wizardOpen, setWizardOpen, wizardDismissed, setWizardDismissed, addOpen, setAddOpen, stopLane, setStopLane,
    moveAll, setMoveAll, draft, setDraft, menu, setMenu, muted, setMuted, focusPick, setFocusPick, cardBox, setCardBox, width, setWidth, now, setNow,
    newIds, setNewIds, seenAt, setSeenAt, accDlg, setAccDlg, accInfo, setAccInfo, accEsc, addEsc, inputRef, guard, seenCards, loadingOlder,
    viewSid, setViewSid, histAt, setHistAt, sessions, setSessions, sessDlg, setSessDlg, moved, setMoved, modelReq, setModelReq,
  };
}
export type AppState = ReturnType<typeof useAppState>;
