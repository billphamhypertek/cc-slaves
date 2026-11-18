// spec v2.3 §5.4 the tab bar over the viewer (C25, C26): icon + name (italic = preview), the parent dir dim when a name
// shows twice, full path on hover; the selected tab joins the pane with an accent line on top and is scrolled to the centre
// (C26), a clipped edge of the bar fades out so the hidden tabs show they are there;
// "×" only on the selected / hovered tab, ● instead of it on a tab with unsaved text. Click selects, double click pins,
// × / middle click closes (the controller asks first when there are changes).
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useT } from '../lib/i18n.tsx';
import { Icon } from '../ui/icons.tsx';
import { fileIcon } from './file-view.ts';
import { tabLabels, type TabSet } from './tabs.ts';

export interface TabBarProps {
  set: TabSet;
  dirty: (path: string) => boolean;
  onSelect: (path: string) => void;
  onPin: (path: string) => void;
  onClose: (path: string) => void;
}

/** C26 the edge-fade classes of a horizontal scroller: `fl` = tabs hidden on the left, `fr` = on the right */
export function edgeFade(left: number, width: number, full: number): string {
  return `${left > 1 ? ' fl' : ''}${left + width < full - 1 ? ' fr' : ''}`;
}

export function TabBar(p: TabBarProps): ReactElement | null {
  const tr = useT();
  const bar = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState('');
  const measure = useCallback(() => { const b = bar.current; if (b) setFade(edgeFade(b.scrollLeft, b.clientWidth, b.scrollWidth)); }, []);
  const { active } = p.set;
  useEffect(() => {
    const el = bar.current?.querySelector<HTMLElement>('.ftb.on');
    el?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
    measure();
  }, [active, p.set.tabs.length, measure]);
  const shown = p.set.tabs.length > 0; // the bar mounts with its first tab
  useEffect(() => {
    const b = bar.current;
    if (!b || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(b);
    return () => ro.disconnect();
  }, [measure, shown]);
  if (!p.set.tabs.length) return null;
  const labels = tabLabels(p.set.tabs);
  return (
    <div className={`ctabs${fade}`} role="tablist" aria-label={tr('code.tabs.aria')} ref={bar} onScroll={measure}>
      {p.set.tabs.map(t => {
        const l = labels.get(t.path)!, on = t.path === active, dirty = p.dirty(t.path);
        return (
          <div key={t.path} role="tab" aria-selected={on} tabIndex={on ? 0 : -1} title={t.path}
            className={`ftb${on ? ' on' : ''}${t.preview ? ' pv' : ''}`}
            onClick={() => p.onSelect(t.path)} onDoubleClick={() => p.onPin(t.path)}
            onMouseDown={e => { if (e.button === 1) e.preventDefault(); }}
            onAuxClick={e => { if (e.button === 1) { e.preventDefault(); p.onClose(t.path); } }}
            onKeyDown={e => { if (e.key === 'Enter') p.onSelect(t.path); }}>
            <Icon n={fileIcon(t.path)} s={13} />
            <span className="nm">{l.name}</span>
            {l.dir ? <span className="pd">{l.dir}</span> : null}
            <button type="button" className={`x${dirty ? ' dt' : ''}`} aria-label={tr(dirty ? 'code.tab.unsaved' : 'code.tab.close')} title={tr(dirty ? 'code.tab.unsaved' : 'code.tab.close')}
              onClick={e => { e.stopPropagation(); p.onClose(t.path); }}>
              {dirty ? <i /> : <Icon n="x" s={12} />}
            </button>
          </div>
        );
      })}
    </div>
  );
}
