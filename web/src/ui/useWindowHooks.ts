// The shell's window / document wiring: the §8.5 keyboard map, body classes + layout vars (§4 layout C), toast auto-hide
// and the external `ccs:select` / `ccs:open-card` events (dev tools, tests, S5 §8.3); v2.4 §6.1 paste / drop for the composer.
import type { DropHandlers, NotifyTarget } from '../lib/native.ts';
import { useEffect, useRef } from 'react';
import type { CardView, LaneView, Snapshot, Target } from '../../../shared/protocol.ts';
import { keyAct, keyPick, type UndoQueue } from '../lib/cards.ts';
import { inEditor, isControl, isTyping, keyAction, type CodeKey, type Mode } from '../lib/keys.ts';
import { ORCH, selUp, type DrawerEvent } from '../lib/inspector.ts';
import type { Tr } from '../lib/i18n.tsx';
import type { Store, UiState } from '../lib/store.ts';
import { keyLane } from '../deck/actions.ts';
import { useReducedOS } from '../lib/reduced-motion.ts';
import { bodyClasses, editorEsc, escapeStep, modeEsc, shellVars } from './shell.ts';
import type { AppState } from './useAppState.ts';

export interface KeyCtx {
  snap: Snapshot | null; showWizard: boolean; modalOpen: boolean;
  /** v2.4 §6.7 a modal other than the Chờ PO detail box is open; `boxId` = that box's card (⌥n still reaches it). */
  otherModal: boolean; boxId: number | null;
  /** §6.7 offline: the box is read-only, rows cannot be answered. */
  offline: boolean;
  list: boolean; narrow: boolean; pid: string | null;
  lanes: LaneView[]; pending: CardView[]; focusId: number | null; tr: Tr; undo: UndoQueue;
  focusInput: () => void; setTarget: (t: Target) => void; pickProject: (id: string) => void; interrupt: () => void;
  toggleList: () => void; toggleInbox: () => void; toggleMute: () => void; closeMenu: (refocus: boolean) => void;
  drawer: (e: DrawerEvent) => void;
  /** v2.1 §4.14 H: the session list. */
  openHistory: () => void;
  /** v2.3 §4.1 the current project's Deck · Code · Git mode. */
  mode: Mode; setMode: (m: Mode) => void;
  /** v2.3 §4.1 ⌘P (opens Code first) / ⌘S / ⌘W (Code only) → the Code view. */
  codeKey: (k: CodeKey) => void;
  /** v2.7 §5.7-5 ⌥1 "Giữ T-46" of a revert_conflict card: its action, as the button runs it. */
  cardAct: (id: number, action: string) => void;
}

/** §8.5 keyboard map. */
export function useKeyMap(ui: AppState, k: KeyCtx) {
  const { deckKeys, accDlg, setAccDlg, accEsc, addEsc, palette, setPalette, stopLane, setStopLane, moveAll, setMoveAll, addOpen, setAddOpen,
    settingsTab, setSettingsTab, sm, setSm, smEsc, menu, accOpen, setAccOpen, setFitReq, sel, pick, drawerOpen, sessDlg, setSessDlg, histAt, setHistAt, codeApi, setCardBox } = ui;
  const { snap, showWizard, modalOpen, otherModal, boxId, offline, list, narrow, pid, lanes, pending, focusId, tr, undo, focusInput, setTarget, pickProject, interrupt,
    toggleList, toggleInbox, toggleMute, closeMenu, drawer, openHistory, mode, setMode, codeKey, cardAct } = k;
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    const typing = isTyping(el);
    const a = keyAction(e, typing, isControl(el), inEditor(el));
    if (!a || !snap) return;
    // v2.3 §4.1 ⌘P / ⌘S / ⌘W never reach the webview (print / save page / close window); ⌘P from Deck / Git opens Code first
    if (a.t === 'code') { e.preventDefault(); if (!modalOpen) codeKey(a.k); return; }
    // v2.3 §4.1 Esc in the viewer: CodeMirror's first (it prevents what it handled); editing → leave edit (asks when dirty);
    // nothing left → leave the viewer
    if (a.t === 'editorEsc') {
      const s = editorEsc(e.defaultPrevented, mode, mode === 'code' ? codeApi.current?.esc() ?? null : null);
      if (s === 'edit') codeApi.current?.close('edit'); else if (s === 'blur') el?.blur();
      return;
    }
    if (a.t === 'palette') { e.preventDefault(); if (!showWizard && !accDlg) setPalette(o => !o); return; }
    if (a.t === 'settings') { e.preventDefault(); if (!showWizard) setSettingsTab(t => (t ? null : 'proj')); return; }
    if (modalOpen && a.t !== 'escape' && !(a.t === 'cardKey' && boxId !== null)) return; // §6.7 I2 ⌥n inside the box
    switch (a.t) {
      // v2.7 G4-0 ⑥ the composer lives on the Deck: in Tasks ⌘L goes there first; a bare Enter does nothing
      case 'focusConsole': if (mode === 'tasks') { if (!e.metaKey && !e.ctrlKey) break; setMode('deck'); } e.preventDefault(); focusInput(); break;
      case 'selectLane': {
        const n = keyLane(deckKeys.current, a.n) ?? (deckKeys.current.length ? null : lanes[a.n - 1]?.name ?? null);
        if (n && pid) { if (mode === 'tasks') setMode('deck'); setTarget({ kind: 'lane', projectId: pid, name: n }); }
        break;
      }
      case 'cardKey': {
        e.preventDefault();
        const k = keyPick(tr, { pending, focusId, boxId, otherModal, offline }, a.n); // §6.7 I3 a row: permission ⌥1 / ⌥3; an ask only in its box
        if (k) { if (boxId !== null) setCardBox(null); undo.choose(k.id, k.label, k.answer); break; }
        const act = keyAct({ pending, focusId, boxId, otherModal, offline }, a.n);
        if (act) cardAct(act.id, act.action);
        break;
      }
      case 'project': { e.preventDefault(); const p = snap.projects[a.n - 1]; if (p) pickProject(p.id); break; }
      case 'interrupt': e.preventDefault(); interrupt(); break;
      case 'toggleList': toggleList(); break;
      case 'mode': if (pid) setMode(a.m); break;
      case 'fit': if (!list && mode === 'deck') setFitReq(n => n + 1); break; // §4.1 A / F are Deck's
      case 'toggleAccounts': if (!list && mode === 'deck') setAccOpen(o => !o); break;
      case 'history': if (!list && pid) openHistory(); break;
      case 'escape': {
        if (typing) el?.blur();
        // §4.1 at Code / Git: no account panel step, no "up" (modeEsc); Code's own steps (dialog, ⌘P, edit)
        const step = escapeStep({ accDlg: !!accDlg, palette, stopLane: !!stopLane, moveAll: !!moveAll, addOpen, settings: !!settingsTab, skillsMcp: !!sm, wizard: showWizard, sessDlg: !!sessDlg, cardBox: boxId !== null, menu: !!menu && !menu.leaving, sessList: !!histAt,
          ...modeEsc(mode, { accPanel: accOpen && !list, up: selUp(sel) !== null }), ...(mode === 'code' ? codeApi.current?.esc() : null), drawer: narrow && drawerOpen });
        switch (step) {
          case 'accDlg': if (accEsc.current) accEsc.current(); else setAccDlg(null); break;
          case 'palette': setPalette(false); break;
          case 'stopLane': setStopLane(null); break;
          case 'moveAll': setMoveAll(null); break;
          case 'addOpen': if (addEsc.current) addEsc.current(); else setAddOpen(false); break;
          case 'settings': setSettingsTab(null); break;
          case 'skillsMcp': if (!smEsc.current?.()) setSm(null); break;
          case 'sessDlg': setSessDlg(null); break;
          case 'cardBox': setCardBox(null); break;
          case 'menu': closeMenu(true); break;
          case 'sessList': setHistAt(null); break;
          case 'accPanel': setAccOpen(false); break;
          case 'codeDlg': case 'quickOpen': case 'edit': codeApi.current?.close(step); break;
          case 'up': pick(s => selUp(s) ?? ORCH); break;
          case 'drawer': drawer('esc'); break;
        }
        break;
      }
      case 'toggleInbox': toggleInbox(); break;
      case 'toggleSound': toggleMute(); break;
    }
  };
  useEffect(() => { const f = (e: KeyboardEvent) => keyRef.current(e); document.addEventListener('keydown', f); return () => document.removeEventListener('keydown', f); }, []);
}

/** Body classes + layout vars (§4 layout C): the deck area depends on the window width only; toasts auto-hide (2.6 s). */
/** `leftCol` = the left column is on screen (v2.7 §4.1 D88: not in Tasks; the toast centres on the full width there). */
export function useShellEffects(s: { narrow: boolean; drawerOpen: boolean; offline: boolean; banner: boolean; width: number; accShown: boolean; leftCol: boolean }, toasts: UiState['toasts'], store: Store) {
  const { narrow, drawerOpen, offline, banner, width, accShown, leftCol } = s;
  const reduced = useReducedOS();
  useEffect(() => { store.setReducedOS(reduced); }, [store, reduced]); // §14.5 the stream reveal follows the OS too
  useEffect(() => {
    document.body.className = bodyClasses({ narrow, drawer: drawerOpen, offline, reduced });
    const root = document.documentElement.style;
    for (const [k, v] of Object.entries(shellVars({ width, narrow, drawerOpen, banner, leftCol }))) root.setProperty(k, v);
    root.setProperty('--accw', accShown ? '324px' : '0px'); // §4.13 toast centred on the graph part left visible
  }, [narrow, drawerOpen, offline, banner, width, accShown, leftCol, reduced]);

  // toasts auto-hide (2.6 s like the mockup)
  useEffect(() => {
    const t = toasts[0];
    if (!t) return;
    const h = setTimeout(() => store.dismissToast(t.id), 2600);
    return () => clearTimeout(h);
  }, [toasts, store]);
}

/**
 * External selectors (dev tools, tests) select lanes / accounts through `ccs:select`: { lane: name } | { account: email }.
 * S5 (§8.3): the app regained focus right after a macOS notification → `ccs:open-card` carries its target (§4.15 §4:
 * card, project, lane); a bare / unknown card opens the newest open one.
 */
export function useWindowEvents(onSelect: (d: { lane?: string; account?: string }) => void, onOpenCard: (t: NotifyTarget) => void) {
  const selRef = useRef<(d: { lane?: string; account?: string }) => void>(() => {});
  selRef.current = onSelect;
  useEffect(() => { const f = (e: Event) => selRef.current((e as CustomEvent<{ lane?: string; account?: string } | null>).detail ?? {}); window.addEventListener('ccs:select', f); return () => window.removeEventListener('ccs:select', f); }, []);
  const openCardRef = useRef<(t: NotifyTarget) => void>(() => {});
  openCardRef.current = onOpenCard;
  useEffect(() => {
    const f = (e: Event) => { const d = (e as CustomEvent<Partial<NotifyTarget> | null>).detail; openCardRef.current({ cardId: d?.cardId ?? null, projectId: d?.projectId ?? null, lane: d?.lane ?? null }); };
    window.addEventListener('ccs:open-card', f);
    return () => window.removeEventListener('ccs:open-card', f);
  }, []);
}


// ---------------------------------------------------------------- v2.4 §6.1 paste / drop anywhere in the window
type DataLike = { getData(type: string): string; readonly files: ArrayLike<File> };
/** §6.1 what a ⌘V does: clipboard text always wins (cc#71793: an Excel cell also carries an image), a text field other than
 *  the composer keeps its own paste, no paste lands while a dialog is open. */
export function pasteAction(dt: DataLike | null, at: 'composer' | 'other' | 'none', modal: boolean): 'files' | 'pass' {
  if (!dt || at === 'other' || (modal && at === 'none')) return 'pass';
  if (dt.getData('text/plain')) return 'pass';
  return dt.files.length ? 'files' : 'pass';
}

type ItemLike = { kind: string; getAsFile(): File | null; webkitGetAsEntry?(): { isDirectory: boolean; name: string } | null };
/** §6.1 a browser drop: `File`s, folders (`webkitGetAsEntry().isDirectory`) refused by name. */
export function dropEntries(items: ArrayLike<ItemLike>): { files: File[]; dirs: string[] } {
  const files: File[] = [], dirs: string[] = [];
  for (const it of Array.from(items)) {
    if (it.kind !== 'file') continue;
    const e = it.webkitGetAsEntry?.();
    if (e?.isDirectory) { dirs.push(e.name); continue; }
    const f = it.getAsFile();
    if (f) files.push(f);
  }
  return { files, dirs };
}
const hasFiles = (dt: DataTransfer | null) => !!dt && Array.from(dt.types).includes('Files');

export interface AttachInput {
  /** `on` false = no attaching here at all (remote channel, §8); `locked` = the composer's lock reason (DK11 toast). */
  on: boolean; locked: string | null; modal: boolean;
  files: (f: File[], pasted: boolean) => void; paths: (p: string[]) => void; dirs: (names: string[]) => void;
  toast: (text: string) => void; hover: (on: boolean) => void; focus: () => void;
}

type DocLike = Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & { readonly activeElement: Element | null };

/** §6.1 ⌘V and drag-and-drop for the whole window, at Deck · Code · Git alike; in the Mac app the native drop gives real
 *  paths (`tauriDrop`, the page then gets no DOM drop). A locked composer takes nothing and says why (DK11); otherwise the
 *  composer takes the caret (T1 / T2 / T3). Returns the unbind. */
export function bindAttachInput(doc: DocLike, get: () => AttachInput, tauriDrop: ((h: DropHandlers) => () => void) | null): () => void {
  const take = (go: () => void) => { const c = get(); if (c.locked) c.toast(c.locked); else { go(); c.focus(); } };
  const onPaste = (ev: Event) => {
    const e = ev as ClipboardEvent, c = get(), el = doc.activeElement as HTMLElement | null;
    const at = el?.id === 'cmd' ? 'composer' : isTyping(el) ? 'other' : 'none';
    if (pasteAction(e.clipboardData, at, c.modal) !== 'files') return;
    e.preventDefault();
    const files = Array.from(e.clipboardData!.files);
    take(() => c.files(files, true));
  };
  let depth = 0;
  const onEnter = (ev: Event) => { const e = ev as DragEvent; if (!hasFiles(e.dataTransfer)) return; e.preventDefault(); if (depth++ === 0 && !get().modal) get().hover(true); };
  const onOver = (ev: Event) => { const e = ev as DragEvent; if (hasFiles(e.dataTransfer)) e.preventDefault(); };
  const onLeave = () => { if (depth > 0 && --depth === 0) get().hover(false); };
  const onDrop = (ev: Event) => {
    const e = ev as DragEvent;
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    depth = 0;
    const c = get();
    c.hover(false);
    if (c.modal) return;
    const { files, dirs } = dropEntries(e.dataTransfer!.items);
    take(() => { if (files.length) c.files(files, false); if (dirs.length) c.dirs(dirs); });
  };
  const on: [string, (e: Event) => void][] = [['paste', onPaste], ['dragenter', onEnter], ['dragover', onOver], ['dragleave', onLeave], ['drop', onDrop]];
  for (const [n, f] of on) doc.addEventListener(n, f);
  const off = tauriDrop?.({
    enter: () => { if (!get().modal) get().hover(true); },
    leave: () => get().hover(false),
    drop: paths => { const c = get(); c.hover(false); if (!c.modal) take(() => c.paths(paths)); },
  });
  return () => { for (const [n, f] of on) doc.removeEventListener(n, f); off?.(); };
}

/** React wrapper of `bindAttachInput` on `document`; `a.on` false (remote channel, §8) binds nothing. */
export function useAttachInput(a: AttachInput, tauriDrop: ((h: DropHandlers) => () => void) | null) {
  const ref = useRef(a);
  ref.current = a;
  useEffect(() => (a.on ? bindAttachInput(document, () => ref.current, tauriDrop) : undefined), [a.on, tauriDrop]);
}
