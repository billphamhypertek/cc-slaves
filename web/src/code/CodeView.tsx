// spec v2.3 §5 Code mode root (follows the app theme, v2.8), hidden with
// `visibility: hidden` when another mode shows (never unmounted: tabs and edit buffers live across mode switches, §5.3).
// The source follows Đang xem (§4.2, `srcFor`) until the PO picks another on the chip (one way, V3: Đang xem never moves);
// a new Đang xem source drops that pick. Tree (§5.1) + tab bar (§5.4) + viewer / editor (§5.2 / §5.3) + ⌘P; the files,
// tabs, dialogs and hot exit live in one `CodeTabs` for every project and source (`code-tabs.ts`).
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MutableRefObject, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { loadLazyNs } from '../../../shared/i18n/lazy.ts';
import type { EngineEvent, LaneView, OrchestratorView, Src } from '../../../shared/protocol.ts';
import { onCodeOpen, type CodeOpen } from '../lib/code-open.ts';
import { isImagePath } from '../lib/doc-links.ts';
import { useT } from '../lib/i18n.tsx';
import { idbKv } from '../lib/idb.ts';
import type { Selection } from '../lib/inspector.ts';
import type { CodeKey } from '../lib/keys.ts';
import { laneState } from '../lib/labels.ts';
import type { EscState } from '../ui/shell.ts';
import { Icon } from '../ui/icons.tsx';
import { CodeDialog } from './CodeDialog.tsx';
import { CodeTabs } from './code-tabs.ts';
import { editLock } from './edit.ts';
import { fsApi, setShowIgnored, showIgnoredOf, srcKey, wireSrc, type FsSend } from './fs.ts';
import { HotExit } from './hot-exit.ts';
import { QuickOpen } from './QuickOpen.tsx';
import { srcLanes, SrcChip } from './SrcChip.tsx';
import { pickedSrc, srcFor } from './src.ts';
import { TabBar } from './TabBar.tsx';
import { Tree } from './Tree.tsx';
import { stepImage } from './tree-model.ts';
import { useTree } from './useTree.ts';
import { Viewer, type EditActs } from './Viewer.tsx';
import { OffBand, type EditGate } from './ViewerBits.tsx';
import './code.css';

loadLazyNs(); // §6A the `code` catalog namespace ships with this chunk only (bundle cap)

/** v2.3 §4.1 what the shell's Esc ladder asks the Code view (C7 / C22 / C23 dialog, ⌘P list, edit mode) and closes. */
export type CodeEscStep = 'codeDlg' | 'quickOpen' | 'edit';
export interface CodeApi { esc(): Pick<EscState, CodeEscStep>; close(step: CodeEscStep): void }

export interface CodeViewProps {
  shown: boolean; sel: Selection; lanes: readonly LaneView[]; orchestrators: readonly OrchestratorView[];
  project: { id: string; path: string };
  /** §4.10 window < 1280 px: the tree column is 240 px */
  narrow: boolean;
  /** the engine client's raw `send` for fs requests (errors shown in place, no toast) */
  rawSend: FsSend;
  /** "Mở trong VS Code": the source + the root-relative path (the engine resolves the root, §10.2) */
  openVscode: (src: Src, path: string) => void;
  /** §5.3 C8 "Nhắn D15…": Đang xem's composer aimed at that lane (§4.3) with the sentence filled in, not sent */
  askLane: (lane: string, text: string) => void;
  /** ⌘P / ⌘S / ⌘W from the shell's key map (§4.1), bumped like the deck's `fitReq`; ⌘P from Deck / Git arrives with the switch. */
  req: { k: CodeKey; n: number } | null;
  /** v2.3 §10.2 the last `code_changed` (numbered) */
  codeEv: { e: Extract<EngineEvent, { type: 'code_changed' }>; n: number } | null;
  api: MutableRefObject<CodeApi | null>;
  /** §7 C16 the engine is unreachable (the band, "Sửa" / "Lưu" / "Nhắn …" locked) and the time of the data shown */
  offline: boolean; dataAt: number | null;
}

export function CodeView(p: CodeViewProps): ReactElement {
  const tr = useT();
  const { api, project, lanes } = p;
  const follow = srcFor(p.sel, lanes); // §4.2 a lane running in the repo shows the project folder with no band (Git's line)
  const followK = srcKey(follow);
  const [picked, setPicked] = useState<{ from: string; lane: string | null } | null>(null);
  const followRef = useRef(followK);
  followRef.current = followK;
  const wts = srcLanes(lanes);
  const { lane, note } = pickedSrc(follow, followK, picked, new Set(wts.map(l => l.name)));
  const [ign, setIgn] = useState(() => showIgnoredOf(project.id));
  useEffect(() => setIgn(showIgnoredOf(project.id)), [project.id]);
  const fs = useMemo(() => fsApi(p.rawSend, project.id, wireSrc({ lane }), ign), [p.rawSend, project.id, lane, ign]);
  const sk = srcKey({ lane }), key = `${project.id}:${sk}`;
  const ctl = useMemo(() => new CodeTabs({ send: p.rawSend, hot: new HotExit(idbKv()) }), []); // eslint-disable-line react-hooks/exhaustive-deps -- one for the app's life
  useSyncExternalStore(ctl.subscribe, ctl.version, ctl.version);
  const live = useMemo(() => new Set(['base', ...wts.map(l => `lane:${l.name}`)]), [wts.map(l => l.name).join('\n')]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { ctl.show(project.id, sk, live); }, [ctl, project.id, sk, live]);
  const set = ctl.set(), file = ctl.file();
  const body = useRef<HTMLDivElement>(null);
  const scrolled = useCallback(() => (body.current?.querySelector('.cm-scroller, .mdw-scroll')?.scrollTop ?? 0) > 0, []);
  const tree = useTree(fs, key, ctl.activeOf(project.id, sk));
  const [qo, setQo] = useState(false);
  const qoRef = useRef(qo);
  qoRef.current = qo;
  useEffect(() => {
    api.current = {
      esc: () => ({ quickOpen: qoRef.current, ...ctl.escSteps() }),
      close: step => { if (step === 'quickOpen') setQo(false); else if (step === 'codeDlg') ctl.escDlg(); else ctl.escEdit(); },
    };
    return () => { api.current = null; };
  }, [api, ctl]);
  const offRef = useRef(p.offline);
  offRef.current = p.offline;
  const reqN = p.req?.n;
  useEffect(() => {
    const k = p.req?.k;
    if (k === 'quickOpen') setQo(true); else if (k === 'save') { if (!offRef.current) ctl.save(); } else if (k === 'closeTab') ctl.closeActive();
  }, [reqN]); // eslint-disable-line react-hooks/exhaustive-deps -- a bump, read once
  // §4.2 roots: the project dir, or the lane's worktree (from the engine)
  const root = lane === null ? project.path : lanes.find(l => l.name === lane)?.cwd ?? project.path;
  const lk = editLock(root, lane === null, lanes, p.orchestrators.filter(o => o.projectId === project.id));
  const lock: EditGate = !lk ? { reason: null, lane: null }
    : lk.k === 'orch' ? { reason: tr('code.lock.orch'), lane: '' } : { reason: tr('code.lock.lane', { lane: lk.lane, state: laneState(tr, lk.state) }), lane: lk.lane };
  const holder = lock.reason ? lock.lane : null;
  const evN = p.codeEv?.n;
  useEffect(() => { if (p.codeEv) ctl.codeChanged(p.codeEv.e, scrolled, holder || null); }, [evN]); // eslint-disable-line react-hooks/exhaustive-deps -- each event once
  useEffect(() => {
    const focus = () => { if (document.visibilityState !== 'hidden') ctl.refocus(scrolled); };
    const hide = () => ctl.flush(); // §5.4 hot exit: quitting / reloading writes the buffers, never asks
    window.addEventListener('focus', focus);
    window.addEventListener('pagehide', hide);
    return () => { window.removeEventListener('focus', focus); window.removeEventListener('pagehide', hide); };
  }, [ctl, scrolled]);
  const { reveal } = tree;
  const openAt = useCallback((path: string) => { reveal(path); ctl.open(path); }, [reveal, ctl]);
  // §6.2 Git "Mở ở Code": take the asked source on the chip (V3, Đang xem unchanged), then open the file as the preview
  // tab once that source shows (the `ctl.show` effect above runs first); a pick refused (worktree gone) drops it.
  const [go, setGo] = useState<{ lane: string | null; path: string } | null>(null);
  useEffect(() => {
    const take = (r: CodeOpen) => {
      const l = r.src.kind === 'lane' ? r.src.laneId : null;
      setPicked({ from: followRef.current, lane: l });
      setGo({ lane: l, path: r.path });
    };
    const sub = onCodeOpen(take);
    if (sub.pending) take(sub.pending);
    return sub.off;
  }, []);
  useEffect(() => {
    if (!go) return;
    setGo(null);
    if (go.lane === lane) openAt(go.path);
  }, [go, lane, openAt]);
  // v2.7 §4.10 an image open here (Tasks "Ảnh mockup · n" opens the first): ← / → step through the images of its folder
  const imgRef = useRef<string | null>(null);
  imgRef.current = file && isImagePath(file.path) ? file.path : null;
  useEffect(() => {
    if (!p.shown) return;
    const key = (e: KeyboardEvent) => {
      const cur = imgRef.current, t = e.target as HTMLElement | null;
      if (!cur || e.defaultPrevented || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return;
      if (t?.closest?.('input, textarea, [contenteditable="true"]')) return;
      e.preventDefault();
      const dir = cur.includes('/') ? cur.slice(0, cur.lastIndexOf('/')) : '';
      fs.list(dir).then(l => { const next = stepImage(dir, l.entries, cur, e.key === 'ArrowRight' ? 1 : -1); if (next) openAt(next); }, () => {});
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [p.shown, fs, openAt]);
  const resolveLink = useCallback((rel: string) => fs.read(rel).then(() => ({ ok: true as const, path: rel }), () => ({ ok: false as const })), [fs]);
  const loadImage = useCallback((rel: string) => fs.read(rel).then(r => (r.kind === 'image' ? r.dataUrl ?? null : null), () => null), [fs]);
  const toggleIgn = () => { setShowIgnored(project.id, !ign); setIgn(!ign); };
  const ed: EditActs = useMemo(() => ({
    onEdit: () => ctl.startEdit(), onCancel: () => ctl.cancelEdit(), onSave: () => ctl.save(),
    onChange: (text, line) => ctl.change(text, line), onAsk: l => { const f = ctl.file(); p.askLane(l, tr('code.askEdit', { path: f?.path ?? '' })); },
  }), [ctl, p.askLane, tr]); // eslint-disable-line react-hooks/exhaustive-deps
  const docKey = `${project.id}\n${sk}\n${set.active ?? ''}`;
  const keep = useMemo(() => new Set(set.tabs.map(t => `${project.id}\n${sk}\n${t.path}`)), [set.tabs, project.id, sk]);
  const saveOff = file?.edit && !file.edit.free && lock.reason ? lock.reason : null;
  const srcName = lane === null ? tr('code.find.inBase') : tr('code.find.inLane', { lane });
  const dlgBy = file?.ran ? (file.ran.who ? tr('code.cf.byLane', { lane: file.ran.who }) : tr('code.cf.byOrch')) : null;
  return (
    <div id="codeview" className="ccg" style={{ visibility: p.shown ? undefined : 'hidden' }} aria-hidden={p.shown ? undefined : true}>
      {p.offline ? <OffBand dataAt={p.dataAt} /> : null}
      <aside className="cside" style={{ width: p.narrow ? 240 : 280 }}>
        <div className="csh">
          <SrcChip lane={lane} lanes={lanes} onPick={l => setPicked({ from: followK, lane: l })} />
          <button type="button" className={`cign${ign ? ' on' : ''}`} aria-pressed={ign} title={tr(ign ? 'code.ign.hide' : 'code.ign.show')} onClick={toggleIgn}>
            <Icon n={ign ? 'eye' : 'eyeOff'} s={14} />
          </button>
        </div>
        <button type="button" className="cfz" onClick={() => setQo(true)}><Icon n="search" s={13} /><span>{tr('code.find')}</span><kbd>⌘P</kbd></button>
        <Tree model={tree.model} selected={set.active} width={p.narrow ? 240 : 280}
          onToggle={tree.toggle} onOpen={path => ctl.open(path)} onPin={path => ctl.open(path, true)} onRetry={tree.retry} onFind={() => setQo(true)} />
      </aside>
      <section className="cview">
        <TabBar set={set} dirty={path => ctl.dirty(path)} onSelect={path => ctl.select(path)} onPin={path => ctl.pin(path)} onClose={path => ctl.close(path)} />
        {note?.k === 'noWorktree' ? <div className="cnote" role="status"><Icon n="folder" s={13} />{tr('code.noWorktree', { lane: note.lane })}</div> : null}
        <Viewer file={file} docKey={docKey} keep={keep} lock={lock} saveOff={saveOff} offline={p.offline} ed={ed} onRetry={() => ctl.reload()} onMd={m => ctl.setMd(m)}
          onVscode={rel => p.openVscode(wireSrc({ lane }), rel)} resolveLink={resolveLink} loadImage={loadImage} openInCode={openAt} body={body} narrow={p.narrow} />
      </section>
      {qo ? <QuickOpen fs={fs} src={srcName} onOpen={openAt} onClose={() => setQo(false)} /> : null}
      {ctl.dlg && p.shown ? createPortal(<CodeDialog dlg={ctl.dlg} src={srcName} by={dlgBy} onChoose={c => ctl.choose(c)} />, document.body) : null}
    </div>
  );
}
