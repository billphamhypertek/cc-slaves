// v2.4 §6.2 the chip strip on top of the D51 composer frame (DK1 DK2 DK4 DK5 DK5b DK6 DK8 DK13): an image is a 40 × 40
// thumbnail (a `blob:` URL) with "×"; a file is icon + name (middle cut, tail kept) + size; an error chip is red with its
// reason (the image one keeps its thumbnail); a failed upload has "Thử lại", an expired copy "đính lại" (R21). Every "×" is one 24 × 24 button named
// "<name>, bỏ" (Tab walks the chips). Wraps, 2 rows max, scrolls to the newest chip.
import { useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import enAttachChip from '../../../shared/i18n/en/attachChip.json';
import viAttachChip from '../../../shared/i18n/vi/attachChip.json';
import { extendCatalog } from '../../../shared/i18n/core.ts';
import { syncFade } from '../lib/fade.ts';
import { fmtBytes } from '../lib/format.ts';
import { useT } from '../lib/i18n.tsx';
import { midEllipsis } from '../lib/mid-ellipsis.ts';
import { monoFont } from '../lib/mono-font.ts';
import { Icon } from './icons.tsx';
import type { Att } from '../lib/attach-store.ts';
import './attach.css';

// §6A the `attachChip` namespace ships with this chunk only (§10.3 first paint; also in lazy.ts LAZY_NS for engine / tests)
extendCatalog('vi', { attachChip: viAttachChip });
extendCatalog('en', { attachChip: enAttachChip });

/** §6.2 a chip is ≤ 200 px: the name gets what the icon, size column and "×" leave, measured in
 *  `.fch .n`'s own step (`var(--xs)` mono). */
const NAME_PX = 128, NAME_BAD_PX = 150, COPY_TAG_PX = 48;
const NAME_FONT = 'xs';

function X({ a, onRemove }: { a: Att; onRemove: (key: number) => void }): ReactElement {
  const tr = useT();
  return <button type="button" className="ax" aria-label={tr('attachChip.remove', { name: a.name })} title={tr('attachChip.remove', { name: a.name })} onClick={() => onRemove(a.key)}><Icon n="x" s={12} /></button>;
}

function Thumb({ a, onDims }: { a: Att; onDims?: (d: string) => void }): ReactElement {
  return a.thumb ? <img className="th" src={a.thumb} alt="" draggable={false} onLoad={e => onDims?.(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)} />
    : <span className="th"><Icon n="image" s={16} /></span>;
}

function Chip({ a, onRemove, onRetry }: { a: Att; onRemove: (key: number) => void; onRetry: (key: number) => void }): ReactElement {
  const tr = useT();
  const [dims, setDims] = useState('');
  const size = a.size ? fmtBytes(a.size, tr) : '';
  const font = monoFont(NAME_FONT);
  const bad = a.st === 'bad' || a.st === 'fail';
  if (a.kind === 'image' && !bad) {
    const tip = [a.name, dims, size].filter(Boolean).join(' · ');
    return <span className="ich" title={tip}><Thumb a={a} onDims={setDims} />
      {a.st === 'busy' ? <span className="sp" role="status" aria-label={tr('attach.lock.busy')}><span className="spin" /></span> : null}<X a={a} onRemove={onRemove} /></span>;
  }
  const copy = a.copy && a.kind === 'file' && a.why !== 'dir';
  const copyTag = copy ? <span className="tag q">{tr('attachChip.copy')}</span> : null;
  // §6.2 A7 / DK8 hovering (or tabbing into) a copy chip shows the note above the strip
  const tipProps = copy ? { 'data-tip': tr('attachChip.copyTip') } : {};
  const name = midEllipsis(a.name, (bad ? NAME_BAD_PX : NAME_PX) - (bad && copyTag ? COPY_TAG_PX : 0), font);
  const icon = <Icon n={a.why === 'dir' ? 'folder' : a.kind === 'image' ? 'image' : 'file'} s={bad ? 12 : 16} />;
  if (bad) {
    return <span className={`fch bad${a.kind === 'image' ? ' pic' : ''}`} title={a.name} {...tipProps}>
      {a.kind === 'image' ? <span className="ich"><Thumb a={a} /></span> : null}
      <span className="tx"><span className="n">{a.kind === 'image' ? null : icon}<span className="nm">{name}</span>{copyTag}<X a={a} onRemove={onRemove} /></span>
        <span className="s">{tr(a.st === 'fail' ? 'attachChip.why.fail' : `attachChip.why.${a.why!}`)}
          {a.st === 'fail' || a.why === 'expired' ? <button type="button" className="lnk" onClick={() => onRetry(a.key)}>{tr(a.st === 'fail' ? 'attachChip.retry' : 'attachChip.reattach')}</button> : null}</span></span>
    </span>;
  }
  return <span className="fch" title={a.name} {...tipProps}>{icon}
    <span className="tx"><span className="n"><span className="nm">{name}</span></span><span className="s">{size}{copyTag}</span></span><X a={a} onRemove={onRemove} /></span>;
}

/** `one`: §6.2 I1 a short column caps the strip at 1 row (it scrolls). */
export default function AttachChips({ items, one, onRemove, onRetry }: { items: readonly Att[]; one: boolean; onRemove: (key: number) => void; onRetry: (key: number) => void }): ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const [sc, setSc] = useState(false);
  const n = items.length;
  // §6.2 past 2 rows (1 when `one`) the strip scrolls (only then: a scroll box would clip the DK8 note) and shows the newest chip
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const over = el.scrollHeight > el.clientHeight + 1;
    if (over !== sc) setSc(over); // the scroll below runs again once `.sc` makes it a scroll box
    else if (over) el.scrollTop = el.scrollHeight;
    syncFade(el, true); // m7 the edge past which chips hide fades: the "there is more" cue (§6.8 D54 bars stay dark at rest)
  }, [n, sc, one]);
  return <div className={`tray${sc ? ' sc' : ''}${one ? ' one' : ''}`} ref={box} onScroll={e => syncFade(e.currentTarget, true)}>{items.map(a => <Chip key={a.key} a={a} onRemove={onRemove} onRetry={onRetry} />)}</div>;
}
