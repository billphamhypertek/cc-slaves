// v2.8 §4.1 LT8 the theme button on the top bar, just before Cài đặt: a sun while the page is light, a moon while it is dark
// (also under "Theo macOS"). It opens the shared ActionMenu titled "Giao diện" with three radio items; picking one applies at
// once and closes the menu. The only place to switch (L3: no shortcut, no Settings tab, no palette command).
import { lazy, Suspense, useEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../lib/i18n.tsx';
import { MENU_CLOSE_MS, type Rect } from '../lib/menu.ts';
import { themeItems, useTheme } from '../lib/theme.ts';
import { Icon } from './icons.tsx';

// the shared menu lives in the AppModals chunk; the first paint only carries the button (bundle budget, index.js)
const ActionMenu = lazy(() => import('./ActionMenu.tsx').then(m => ({ default: m.ActionMenu })));

export function ThemeButton(): ReactElement {
  const tr = useT();
  const { state, set } = useTheme();
  const btn = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [menu, setMenu] = useState<{ anchor: Rect; leaving: boolean } | null>(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const close = (refocus: boolean) => {
    setMenu(m => m && { ...m, leaving: true });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMenu(null), MENU_CLOSE_MS);
    if (refocus) btn.current?.focus();
  };
  const toggle = () => {
    // the menu's own outside-mousedown already started closing it: this click must not reopen it
    if (menu) return menu.leaving ? undefined : close(false);
    const r = btn.current?.getBoundingClientRect();
    if (r) setMenu({ anchor: { x: r.x, y: r.y, w: r.width, h: r.height }, leaving: false });
  };
  const name = tr('topbar.theme');
  return <>
    <button ref={btn} className="ib" onClick={toggle} title={name} aria-label={name} aria-haspopup="menu" aria-expanded={!!menu && !menu.leaving}>
      <Icon n={state.look === 'dark' ? 'moon' : 'sun'} />
    </button>
    {/* on <body>, like ProjectList: inside #hud the Code / Git view (its own stacking layer) would cover it */}
    {menu ? createPortal(<Suspense fallback={null}><ActionMenu items={themeItems(tr, state)} head={name} label={name} anchor={menu.anchor} area={{ x: 0, y: 0, w: innerWidth, h: innerHeight }}
      leaving={menu.leaving} onRun={a => { if (a.t === 'theme') set(a.mode); close(false); }} onClose={close} /></Suspense>, document.body) : null}
  </>;
}
