// spec v2.3 §6.1 "Thay đổi · <nhánh> so với <gốc>" (or the base's uncommitted files, or a commit's files): file rows (name and
// folder cut in the middle, ⚠ conflict, M / A / D), "Chưa commit trong worktree · n file" folded, the pinned "Nhờ …" asks.
import { useState, type ReactElement, type ReactNode } from 'react';
import type { GitCommit, GitFileChange } from '../../../shared/protocol.ts';
import { fmtHm } from '../lib/format.ts';
import { useT } from '../lib/i18n.tsx';
import { midEllipsis, textWidth } from '../lib/mid-ellipsis.ts';
import { Icon } from '../ui/icons.tsx';
import { Block } from './Branches.tsx';
import { monoFont } from '../lib/mono-font.ts';
import { useFade } from '../lib/fade.ts';
import { onListKey } from './list-keys.ts';
import { conflictsFirst, type Ask } from './model.ts';

/** `.gfr` gap (--s2) */
const GAP = 4;
/** v2.4 §6.7 D53 the row's px outside name + folder and the status letter (measured C3 / G4): `.gside` border 1, `.gfr` pad
 *  --s5 14 left / --s4 10 right (hot fix 2026-11-16), icon 12, the gaps icon → name and folder → letter */
const ROW_PAD = 1 + 14 + 10 + 12 + 2 * GAP;

/** One picked file: its path and which list it came from (the dirty sub-list reads `{ dirty }`). */
export interface FilePick { path: string; dirty: boolean }

/** §6.1 the status letter shown: untracked counts as added (G14), the rest as git says. */
export const statusMark = (s: GitFileChange['status']): string => (s === '?' ? 'A' : s);

function FileRow({ f, sel, width, onPick }: { f: GitFileChange; sel: boolean; width: number; onPick: () => void }): ReactElement {
  const cut = f.path.lastIndexOf('/');
  const name = f.path.slice(cut + 1), dir = cut < 0 ? '' : f.path.slice(0, cut);
  const mark = statusMark(f.status);
  const nmFont = monoFont('sm'), dirFont = monoFont('xs');
  const room = Math.max(60, width - ROW_PAD - textWidth(mark, dirFont) - (f.conflict ? 12 + GAP : 0)); // the letter is --xs mono
  const nm = midEllipsis(name, dir ? room - Math.min(90, textWidth(dir, dirFont) + GAP) : room, nmFont); // the folder keeps ≤ 90 px
  return (
    <div className={`gfr${sel ? ' sel' : ''}${mark === 'D' ? ' del' : ''}`} role="option" aria-selected={sel} tabIndex={-1} onClick={onPick} title={f.path}>
      <Icon n={/\.md$/i.test(name) ? 'file' : 'fileCode'} s={12} />
      <span className="gfn">{nm}</span>
      {dir ? <span className="gdir">{midEllipsis(dir, Math.max(24, room - textWidth(nm, nmFont) - GAP), dirFont)}</span> : null}
      {f.conflict ? <span className="bad gcf"><Icon n="alert" s={12} /></span> : null}
      <span className={`gs ${mark}`}>{mark}</span>
    </div>
  );
}

export interface ChangesProps {
  title: ReactNode;
  /** null = loading (C13 skeleton) */
  files: GitFileChange[] | null; err: string | null;
  /** `+a −d` of the list (two commits only) */
  total: { add: number; del: number } | null;
  commit: GitCommit | null; onCloseCommit: () => void;
  /** the lane worktree's uncommitted files: count (0 = no line), the list once opened */
  dirty: { n: number; files: GitFileChange[] | null; err: string | null; open: boolean; onOpen: () => void } | null;
  /** text when the list is empty (lane: "Lane chưa đổi file nào so với main.") */
  empty: string;
  pick: FilePick | null; onPick: (f: FilePick) => void;
  asks: Ask[]; onAsk: (a: Ask) => void; offline: boolean;
  width: number; folded: boolean; onFold: () => void;
}

export function Changes(p: ChangesProps): ReactElement {
  const tr = useT();
  const files = p.files ? conflictsFirst(p.files) : null;
  const right = p.commit ? <button type="button" className="gx" aria-label={tr('git.backBranch')} title={tr('git.backBranch')} onClick={p.onCloseCommit}><Icon n="x" s={12} /></button>
    : p.total && files?.length ? <span className="mono"><span className="ok">+{p.total.add}</span> <span className="bad">−{p.total.del}</span></span> : null;
  const fade = useFade<HTMLDivElement>();
  // UX M6 (G9): the ask just pressed keeps the accent until the asks change (another branch / commit picked)
  const asksKey = p.asks.map(a => a.text).join('\n');
  const [pressed, setPressed] = useState<{ key: string; label: string } | null>(null);
  const on = pressed?.key === asksKey ? pressed.label : null;
  const sel = (f: GitFileChange, dirty: boolean) => !!p.pick && p.pick.path === f.path && p.pick.dirty === dirty;
  return (
    <Block cls="b2" folded={p.folded} onFold={p.onFold} title={p.title} right={right}>
      {p.commit ? (
        <div className="gcmh">
          <b>{p.commit.subject}</b>
          <div className="mut">{p.commit.author} · {fmtHm(p.commit.at)}{p.commit.parents[0] ? <> · {tr('git.parent')} <span className="mono">{p.commit.parents[0].slice(0, 7)}</span></> : null}</div>
        </div>
      ) : null}
      <div className="glst" role="listbox" tabIndex={0} aria-label={tr('git.changes')} onKeyDown={onListKey} ref={fade.ref} onScroll={fade.onScroll}>
        {p.err ? <div className="gsubl bad">{tr('git.loadFail', { reason: p.err })}</div>
          : !files ? <div className="gskel" aria-busy="true">{[0, 1, 2, 3].map(i => <i key={i} />)}</div>
          : files.length === 0 && !p.dirty?.n ? <div className="gsubl mut">{p.empty}</div>
          : files.map(f => <FileRow key={f.path} f={f} sel={sel(f, false)} width={p.width} onPick={() => p.onPick({ path: f.path, dirty: false })} />)}
        {p.dirty && p.dirty.n > 0 ? (
          <>
            <div className="gsubl gfoldl mut" role="button" aria-expanded={p.dirty.open} onClick={p.dirty.onOpen}>
              <Icon n={p.dirty.open ? 'chev' : 'chevR'} s={12} />{tr('git.wtDirty', { n: p.dirty.n })}
            </div>
            {p.dirty.open ? (p.dirty.err ? <div className="gsubl bad">{tr('git.loadFail', { reason: p.dirty.err })}</div>
              : (p.dirty.files ?? []).map(f => <FileRow key={`d:${f.path}`} f={f} sel={sel(f, true)} width={p.width} onPick={() => p.onPick({ path: f.path, dirty: true })} />)) : null}
          </>
        ) : null}
      </div>
      {p.asks.length ? (
        <div className="gacts">
          {p.asks.map(a => <button type="button" key={a.label} className={on === a.label ? 'gbt on' : 'gbt'} disabled={p.offline} onClick={() => { setPressed({ key: asksKey, label: a.label }); p.onAsk(a); }}><Icon n="msg" s={12} />{a.label}</button>)}
        </div>
      ) : null}
      {p.asks.map(a => (a.warn ? <div key={`w${a.label}`} className="gwl"><Icon n="alert" s={12} />{a.warn}</div> : null))}
    </Block>
  );
}
