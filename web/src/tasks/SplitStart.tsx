// v2.7.1 §4.1 SA0 / SA6 / SA8 (D102) the split button of every Tasks control that opens a session: the main part starts at
// once with the defaults (account Tự chọn, the account's model / effort → the step list SA3), the neutral ▾ opens the start
// dialog (SA1). The ▾ is never coloured, even beside an accent main part (BANNED look); hover / open = `--sel`. Keys: Tab
// reaches ▾, Enter / Space / ↓ open the dialog. In a menu (narrow window, IS10) there is no ▾: the item is the main part and an
// indented item right under it is the ▾ path. A lock (offline, 3 sessions) dims both parts; its reason is the styled LockTip
// (WKWebView may not show a disabled button's native title, R-B19 M7).
import type { KeyboardEvent, ReactElement, ReactNode } from 'react';
import { useT } from '../lib/i18n.tsx';
import { Icon } from '../ui/icons.tsx';
import { LockTip } from './LockTip.tsx';
import './split.css';

export interface SplitStartProps {
  /** the main part's label (may hold an icon) and its plain name (the ▾ `aria-label`) */
  label: ReactNode; name: string;
  /** the main part's class (the v2.7 button kept as is: `tbtn`, `tbtn2`, `sbtn`, `snew`, `lbtn`) */
  cls: string;
  /** why both parts are locked (null = they run); `disabled` = off with nothing to say (IS17: no session picked yet) */
  off: string | null; disabled?: boolean;
  /** main part = start now with the defaults; ▾ = the start dialog */
  onStart: () => void; onPick: () => void;
  /** narrow menu form (SA8): `item` = two `menuitem`s (the "⋯" menu), `rail` = the main button over the indented
   *  "… chọn account, model, effort…" (the rail as a spec menu) */
  menu?: 'item' | 'rail';
}

export function SplitStart(p: SplitStartProps): ReactElement {
  const tr = useT();
  const off = !!p.off || !!p.disabled;
  if (p.menu) {
    const role = p.menu === 'item' ? 'menuitem' : undefined;
    const both = <>
      <button type="button" role={role} className={p.menu === 'rail' ? p.cls : undefined} disabled={off} title={off ? undefined : tr('tasks.split.tip')} onClick={p.onStart}>{p.label}</button>
      <button type="button" role={role} className="mpick2" disabled={off} aria-haspopup="dialog"
        aria-label={tr('tasks.split.ddAria', { name: p.name })} onClick={p.onPick}>{tr('tasks.split.menuPick')}</button></>;
    return <LockTip tip={p.off}>{p.menu === 'item' ? both : <span className="splitm">{both}</span>}</LockTip>;
  }
  const down = (e: KeyboardEvent) => { if (e.key === 'ArrowDown') { e.preventDefault(); p.onPick(); } };
  return (
    <LockTip tip={p.off}><span className="split">
      <button type="button" className={p.cls} disabled={off} title={off ? undefined : tr('tasks.split.tip')} onClick={p.onStart}>{p.label}</button>
      <button type="button" className="sdd" disabled={off} title={off ? undefined : tr('tasks.split.ddTip')} aria-haspopup="dialog"
        aria-label={tr('tasks.split.ddAria', { name: p.name })} onClick={p.onPick} onKeyDown={down}><Icon n="chev" s={12} /></button>
    </span></LockTip>
  );
}
