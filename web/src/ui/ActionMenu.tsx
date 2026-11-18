// v2.1 §4.12 the one "⋯" menu component: deck node, Inspector, F9 row and account panel row all open this with items
// from lib/actions.ts. Fixed layer clamped inside the deck area; submenu flips left; ↑ ↓ Enter Esc → ← (lib/menu.ts);
// opens in 180 ms, closes in 140 ms (`leaving`, v1 U12); a click outside closes it; Esc returns focus to the opener.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement } from 'react';
import type { MenuAct, MenuItem } from '../lib/actions.ts';
import { INTERRUPT_KEY, menuKey, placeMenu, placeSub, withHints, type MenuNav, type Placed, type Rect } from '../lib/menu.ts';
import { Icon } from './icons.tsx';

export interface ActionMenuProps {
  items: MenuItem[]; label: string;
  /** v2.8 §4.1 a title over the items ("Giao diện"). */
  head?: string;
  /** opener rect (the "⋯" button or the focused node) and the area the menu must stay in (§4.12). */
  anchor: Rect; area: Rect;
  leaving: boolean;
  /** the host closes the menu itself (focus goes to what the action opens). */
  onRun: (a: MenuAct) => void;
  /** `refocus` = Esc / Tab (focus back to the opener); a click outside leaves focus where it landed. */
  onClose: (refocus: boolean) => void;
}

const ITEM = '[role=menuitem],[role=menuitemradio]';
const rectOf = (el: Element): Rect => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };

export function ActionMenu(p: ActionMenuProps): ReactElement {
  const items = useMemo(() => withHints(p.items), [p.items]);
  // v2.8 §4.1 a radio menu opens on its checked item
  const [nav, setNav] = useState<MenuNav>(() => ({ i: Math.max(0, p.items.findIndex(it => it.checked)), sub: null, si: 0 }));
  const [pos, setPos] = useState<Placed | null>(null);
  const [subPos, setSubPos] = useState<Placed | null>(null);
  const root = useRef<HTMLDivElement>(null), subRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (root.current) setPos(placeMenu(p.anchor, { w: root.current.offsetWidth, h: root.current.offsetHeight }, p.area)); },
    [p.anchor.x, p.anchor.y, p.items.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const row = nav.sub === null ? null : root.current?.querySelectorAll(ITEM)[nav.sub];
    if (!row || !subRef.current || !root.current) return setSubPos(null);
    setSubPos(placeSub(rectOf(root.current), rectOf(row).y - 6, { w: subRef.current.offsetWidth, h: subRef.current.offsetHeight }, p.area));
  }, [nav.sub, pos]); // eslint-disable-line react-hooks/exhaustive-deps
  // focus follows the active item (screen readers read the label + reason); a leaving menu leaves the focus where it went
  useEffect(() => {
    if (p.leaving) return;
    const box = nav.sub === null ? root.current : subRef.current;
    (box?.querySelectorAll<HTMLElement>(ITEM)[nav.sub === null ? nav.i : nav.si])?.focus();
  }, [nav, pos, subPos, p.leaving]); // after placement: a still-hidden (unplaced) item cannot take focus
  const closeRef = useRef(p.onClose);
  closeRef.current = p.onClose;
  useEffect(() => {
    const f = (e: MouseEvent) => { const t = e.target as Node; if (!root.current?.contains(t) && !subRef.current?.contains(t)) closeRef.current(false); };
    document.addEventListener('mousedown', f, true);
    return () => document.removeEventListener('mousedown', f, true);
  }, []);

  const run = (it: MenuItem) => { if (!it.disabled && it.act) p.onRun(it.act); };
  const onKey = (e: KeyboardEvent) => {
    const out = menuKey(items, nav, (e.metaKey || e.ctrlKey) && e.key === '.' ? INTERRUPT_KEY : e.key);
    if (!out) return;
    e.preventDefault(); e.stopPropagation();
    if (out.close) return p.onClose(true);
    setNav(out.nav);
    if (out.run) run(out.run);
  };
  const open = nav.sub !== null ? items[nav.sub] : undefined;
  // unplaced: measured hidden at 0,0 so a box near the right edge is not squeezed (its real width decides the flip);
  // placed: height capped to the deck area, the rest scrolls inside `.ams` (§4.12; §6.8 R36 I1: the animated box never scrolls)
  const style = (q: Placed | null): CSSProperties => (q ? { left: q.x, top: q.y, maxHeight: q.h } : { left: 0, top: 0, visibility: 'hidden' });
  return (
    <div className={`amenu-layer${p.leaving ? ' leaving' : ''}`} onKeyDown={onKey}>
      <div ref={root} className="amenu glass" role="menu" aria-label={p.label} style={style(pos)}><div className="ams">
        {p.head ? <h4>{p.head}</h4> : null}
        {items.map((it, n) => <Row key={it.id} it={it} rule={n > 0 && items[n - 1]!.g !== it.g} active={nav.sub === null && nav.i === n} open={nav.sub === n}
          onHover={() => setNav(it.submenu && !it.disabled ? { i: n, sub: n, si: 0 } : { i: n, sub: null, si: 0 })}
          onClick={() => (it.submenu ? !it.disabled && setNav({ i: n, sub: n, si: 0 }) : run(it))} />)}
      </div></div>
      {open?.submenu ? <div ref={subRef} className="amenu amsub glass" role="menu" aria-label={open.submenu.head} style={style(subPos)}><div className="ams">
        <h4>{open.submenu.head}</h4>
        {open.submenu.items.map((it, n) => <Row key={it.id} it={it} rule={false} active={nav.si === n} open={false}
          onHover={() => setNav(v => ({ ...v, si: n }))} onClick={() => run(it)} />)}
      </div></div> : null}
    </div>
  );
}

function Row({ it, rule, active, open, onHover, onClick }: { it: MenuItem; rule: boolean; active: boolean; open: boolean; onHover: () => void; onClick: () => void }): ReactElement {
  const radio = it.checked !== undefined;
  const cls = ['mi', radio ? 'rd' : '', active ? 'on' : '', it.danger ? 'bad' : '', it.disabled ? 'dis' : ''].filter(Boolean).join(' ');
  return <>
    {rule ? <hr /> : null}
    <button type="button" role={radio ? 'menuitemradio' : 'menuitem'} aria-checked={radio ? it.checked : undefined} tabIndex={-1} className={cls} aria-disabled={it.disabled ? true : undefined} title={it.tip}
      aria-haspopup={it.submenu ? 'menu' : undefined} aria-expanded={it.submenu ? open : undefined}
      onMouseEnter={onHover} onClick={onClick}>
      {radio ? it.checked ? <Icon n="check" s={14} /> : <span /> : null}
      {it.icon ? <Icon n={it.icon} s={14} /> : <span />}
      <span className="lb">{it.label}{it.disabled ? <small>{it.disabled}</small> : it.hint ? <small>{it.hint}</small> : null}</span>
      {it.submenu ? <span className="k">▸</span> : it.note ? <span className="k">{it.note}</span> : it.kbd ? <kbd className="k">{it.kbd}</kbd> : <span />}
    </button>
  </>;
}
