// Top bar (spec §6 intro, U4, U5): project tabs · list · remote · sound · settings. v2.1 §4.8: no account chips (accounts live
// in the account panel), no "kho" / "cần xem" chips, no cost today (the money is on the deck header bar, per project).
// v2.2 §6 K0: "Skills & MCP" + the two C25 numbers (Mac only: the view never reaches the remote channel, D32).
// Hot fix 2026-11-16 (docs/ref/hf1116-ux.md): many tabs scroll + "Tất cả project (N)"; right-click a tab → "Đóng project".
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactElement, type WheelEvent } from 'react';
import type { Snapshot } from '../../../shared/protocol.ts';
import { useT } from '../lib/i18n.tsx';
import { firstIssueTab, k0LevelTitle, k0Title, type SmTab } from '../lib/skills-mcp.ts';
import { isMenuKey } from '../lib/keys.ts';
import type { Rect } from '../lib/menu.ts';
import { Icon } from './icons.tsx';
import { ThemeButton } from './ThemeButton.tsx';
import { hasTauri } from '../lib/tauri.ts';

// the list-all popover loads on its first open (only a bar that overflows offers it)
const ProjectList = lazy(() => import('./ProjectList.tsx').then(m => ({ default: m.ProjectList })));
// v2.6 the update chip + its frames load only inside the Mac app (bundle budget, index.js)
const UpdateChip = lazy(() => import('./UpdateChip.tsx').then(m => ({ default: m.UpdateChip })));

export interface TopBarProps {
  snap: Snapshot;
  /** v2.6 UP6d the engine is gone: the update chip locks its Thử lại (R17 keeps the chip itself usable). */
  offline: boolean;
  projectId: string | null;
  pendingByProject: Record<string, number>;
  unread: Set<string>;
  muted: boolean;
  listOn: boolean;
  onProject: (id: string) => void;
  onAddProject: () => void;
  onList: () => void;
  onRemote: () => void;
  onMute: () => void;
  onSettings: () => void;
  /** v2.2 §6 K0: the label always opens MCP (C17); a number opens the tab of its first issue. */
  onSkillsMcp: (tab: SmTab) => void;
  /** hot fix 2026-11-16 a tab's menu ("Đóng project"); `at` = the pointer, null = the keyboard (opens at the tab). */
  onTabMenu: (id: string, tab: Element, at: Rect | null) => void;
}

export function TopBar(p: TopBarProps): ReactElement {
  const nav = useRef<HTMLElement>(null), allBtn = useRef<HTMLButtonElement>(null);
  const tr = useT();
  const { snap } = p;
  const mac = snap.channel === 'mac';
  // hot fix 2026-11-16: tabs keep a readable width and the strip scrolls; "Tất cả project (N)" only while it overflows,
  // a soft fade marks each clipped edge
  const [edge, setEdge] = useState({ over: false, l: false, r: false });
  const [all, setAll] = useState(false);
  const measure = () => {
    const n = nav.current;
    if (!n) return;
    const over = n.scrollWidth > n.clientWidth + 1, l = over && n.scrollLeft > 1, r = over && n.scrollLeft + n.clientWidth < n.scrollWidth - 1;
    setEdge(e => (e.over === over && e.l === l && e.r === r ? e : { over, l, r }));
  };
  useLayoutEffect(measure);
  useEffect(() => {
    const n = nav.current;
    if (!n || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(measure);
    ro.observe(n);
    void document.fonts?.ready.then(measure); // widths change once the web fonts arrive
    return () => ro.disconnect();
  }, []);
  useEffect(() => { nav.current?.querySelector('.tab.on')?.scrollIntoView({ inline: 'nearest', block: 'nearest' }); }, [p.projectId, snap.projects.length]);
  useEffect(() => { if (!edge.over) setAll(false); }, [edge.over]);
  // the vertical wheel scrolls the strip sideways
  const onWheel = (e: WheelEvent) => { const n = nav.current; if (n && Math.abs(e.deltaY) > Math.abs(e.deltaX)) n.scrollLeft += e.deltaY; };
  // right-click / ContextMenu / ⇧F10 on a tab: "Đóng project" (Mac only: the remote channel has no item)
  const tabMenu = (id: string) => mac ? {
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      const kb = e.clientX === 0 && e.clientY === 0; // the keyboard's synthetic contextmenu: at the tab
      p.onTabMenu(id, e.currentTarget, kb ? null : { x: e.clientX, y: e.clientY, w: 0, h: 0 });
    },
    onKeyDown: (e: KeyboardEvent) => { if (isMenuKey(e)) { e.preventDefault(); p.onTabMenu(id, e.currentTarget, null); } },
  } : {};
  // U12: the badge bounces once when its count goes up
  const prev = useRef<Record<string, number>>({});
  const bumped = new Set(Object.keys(p.pendingByProject).filter(id => (p.pendingByProject[id] ?? 0) > (prev.current[id] ?? Infinity)));
  useEffect(() => { prev.current = { ...p.pendingByProject }; });
  const remote = snap.engine.remote;
  const sm = snap.skillsMcp?.counts;
  return (
    <header id="top">
      <div className="brand" title="cc-slaves"><span className="logo" /><b>cc-slaves</b></div>
      <div className="tabw">
      <nav ref={nav} className={['tabs', edge.l ? 'fl' : '', edge.r ? 'fr' : ''].filter(Boolean).join(' ')} aria-label={tr('topbar.areas')} onScroll={measure} onWheel={onWheel}>
        {snap.projects.map((pr, i) => {
          const n = p.pendingByProject[pr.id] ?? 0;
          const unread = p.unread.has(pr.id) && pr.id !== p.projectId;
          return (
            <button key={pr.id} className={`tab ${pr.id === p.projectId ? 'on' : ''}`} onClick={() => p.onProject(pr.id)} {...tabMenu(pr.id)}
              title={`${pr.name}${i < 9 ? ` (⌘${i + 1})` : ''}${unread ? tr('topbar.unread') : ''}`}>
              <span className="pnm">{pr.name}</span>{n ? <span key={n} className={`bdg ${bumped.has(pr.id) ? 'bump' : ''}`}>{n}</span> : null}{unread ? <span className="unread" /> : null}
            </button>
          );
        })}
      </nav>
        {mac ? <button className="tab add" onClick={p.onAddProject} title={tr('topbar.addProject')}><Icon n="plus" /></button> : null}
        {edge.over ? <button ref={allBtn} type="button" className={`tab all ${all ? 'on' : ''}`} aria-haspopup="listbox" aria-expanded={all} onClick={() => setAll(o => !o)}
          title={tr('topbar.allProjects', { n: snap.projects.length })} aria-label={tr('topbar.allProjects', { n: snap.projects.length })}><Icon n="chev" s={14} />{snap.projects.length}</button> : null}
        {all ? <Suspense fallback={null}><ProjectList projects={snap.projects} projectId={p.projectId} pendingByProject={p.pendingByProject} unread={p.unread} anchor={allBtn}
          onPick={id => { setAll(false); p.onProject(id); }} onClose={refocus => { setAll(false); if (refocus) allBtn.current?.focus(); }} /></Suspense> : null}
      </div>
      {/* v2.6 §8 UP9 the remote channel while the Mac holds for an update: text only, no chip, no button (D32) */}
      {snap.channel === 'remote' && snap.engine.update?.hold ? <span className="pill warn uphold" role="status" title={tr('update.remoteHold')}><Icon n="hourglass" s={12} /><span>{tr('update.remoteHold')}</span></span> : null}
      <button className={`ib ${p.listOn ? 'on' : ''}`} onClick={p.onList} title={tr('topbar.listTitle')} aria-label={tr('topbar.listAria')}><Icon n="list" /></button>
      {/* M11 a remote viewer is told where it stands; text only, no control (remote = view + steer, D32) */}
      {snap.channel === 'remote' ? <span className="pill acc rmt" role="status" title={tr('topbar.remoteViewTitle')}><Icon n="globe" s={12} /><span>{tr('topbar.remoteView')}</span></span> : null}
      {/* G4 UX 5(a): remote access is deferred to v3 — no 🌐 while it is off */}
      {remote.enabled ? <button className="ib" onClick={p.onRemote} title={`${tr('topbar.remoteOn')}${remote.hostname ? ' · ' + remote.hostname : ''}`} aria-label={tr('topbar.remoteAria')}>
        <i className="rd" /><Icon n="globe" />
      </button> : null}
      <button className={`ib ${p.muted ? 'muted' : ''}`} onClick={p.onMute} title={tr('topbar.soundTitle')} aria-label={tr('topbar.soundAria')}><Icon n={p.muted ? 'mute' : 'vol'} /></button>
      {sm ? <div className="smk" role="group">
        <button className="smk-l" title={k0Title(tr, sm)} onClick={() => p.onSkillsMcp('mcp')}><Icon n="plug" /><span className="smk-t">{tr('topbar.sm.label')}</span></button>
        {(['red', 'yellow'] as const).map(l => (sm.total[l] ? <button key={l} className={`smk-n ${l}`} title={k0LevelTitle(tr, sm, l)} onClick={() => p.onSkillsMcp(firstIssueTab(sm, l))}
          aria-label={tr(`topbar.sm.${l}Aria`, { n: sm.total[l] })}><Icon n={l === 'red' ? 'bang' : 'alert'} s={14} />{sm.total[l]}</button> : null))}
      </div> : null}
      {/* v2.6 §4.1 R21 the update chip, only in the Mac app (the state lives in its Rust side), just before the theme button */}
      {mac && hasTauri() ? <Suspense fallback={null}><UpdateChip snap={snap} offline={p.offline} /></Suspense> : null}
      {/* v2.8 §4.8 the phone / a remote browser always follows its own device: no theme button there */}
      {mac ? <ThemeButton /> : null}
      <button className="ib" onClick={p.onSettings} title={tr('topbar.settingsTitle')} aria-label={tr('topbar.settingsAria')}><Icon n="gear" /></button>
    </header>
  );
}
