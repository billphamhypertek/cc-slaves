// spec v2.3 §6.2 the diff pane: one-line head (path cut in the middle · mark · "Xung đột khi merge" / "Merge sạch" · "Mở ở Code"
// · "VS Code"), the body as one column with old | new line numbers and 3 lines of context, the conflict block ("main cũng sửa chỗ
// này", the trial merge's marker hunks, "Xem cả file đã gộp thử" ↔ "Về diff"), and every empty / loading / error state.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode, type RefObject } from 'react';
import type { GitBlob, GitCommit, GitDiffResult } from '../../../shared/protocol.ts';
import { fmtAgo } from '../lib/format.ts';
import { useT } from '../lib/i18n.tsx';
import { midEllipsis } from '../lib/mid-ellipsis.ts';
import { Icon } from '../ui/icons.tsx';
import { monoFont } from '../lib/mono-font.ts';
import { canColour, conflictLines, diffWindow, lineDiff, paintSegs, segsOf, withContext, type Seg } from './diff.ts';

/** `.gcd` top padding (--s4, v2.4 §6.7 D53): the body's rows start this far below the scroll top. */
const BODY_PAD = 10; // hot fix 2026-11-16 --s4

export interface DiffPaneProps {
  /** null = nothing picked */
  path: string | null; mark: string | null;
  /** the list is empty (G10 "Không có thay đổi để xem") */
  none: boolean;
  diff: GitDiffResult | null; err: string | null;
  /** lane branch only: conflicted file → the red pill, a clean branch → the green one */
  pill: 'conflict' | 'clean' | null;
  base: string; branch: string | null;
  /** "Mở ở Code" / "VS Code": null = the file is not on disk (button dim + reason) */
  onOpenCode: (() => void) | null; onVscode: (() => void) | null;
  /** commits the graph loaded (the conflict block names the last base commit with its subject when known) */
  log: readonly GitCommit[]; now: number; narrow: boolean; width: number;
}

const text = (b: GitBlob): string | null => (b.kind === 'text' ? b.text : b.kind === 'absent' ? '' : null);
type Hl = Awaited<ReturnType<typeof import('./diff-hl.ts').highlightSides>>;

/** §5.2 / R15 the colours of both sides, loaded after the plain text shows (null = none yet, or not colourable). */
function useColours(path: string, a: string | null, b: string | null): Hl {
  const [hl, setHl] = useState<{ key: readonly unknown[]; v: Hl } | null>(null);
  useEffect(() => {
    if (a === null || b === null || !canColour(a) || !canColour(b)) return;
    let live = true;
    void import('./diff-hl.ts').then(m => m.highlightSides(path, [a, b], () => live)).then(v => { if (live) setHl({ key: [path, a, b], v }); }, () => {});
    return () => { live = false; };
  }, [path, a, b]);
  return hl && hl.key[0] === path && hl.key[1] === a && hl.key[2] === b ? hl.v : null;
}

function Tx({ t, segs, hl }: { t: string; segs: readonly Seg[] | undefined; hl: Hl }): ReactElement {
  if (!hl || !segs?.length) return <span className="tx">{t}</span>;
  return <span className="tx">{paintSegs(t, segs).map((p, i) => (p.c === null ? p.t : <span key={i} style={hl.styles[p.c]}>{p.t}</span>))}</span>;
}

function Body({ d, path, view }: { d: GitDiffResult; path: string; view: { top: number; h: number } }): ReactElement {
  const tr = useT();
  const a = text(d.old), b = text(d.new);
  const items = useMemo(() => (a === null || b === null ? null : withContext(lineDiff(a, b))), [a, b]);
  const hl = useColours(path, a, b);
  if (!items) return <div className="gemp mut">{tr(d.old.kind === 'large' || d.new.kind === 'large' ? 'git.large' : 'git.binary')}</div>;
  if (!items.length) return <div className="gemp mut">{tr('git.nothing')}</div>;
  const w = diffWindow(items.length, view.top - BODY_PAD, view.h); // §10.3 (M2) fixed rows, only the ones in view past 300
  return (
    <div className="gcd">
      {w.padTop ? <div style={{ height: w.padTop }} aria-hidden /> : null}
      {items.slice(w.start, w.end).map((r, j) => {
        const i = w.start + j;
        if ('gap' in r) return <div key={`g${i}`} className="gcl gap"><span className="no" /><span className="no" /><span className="sg" /><span className="tx">⋯ {tr('git.unchanged', { n: r.gap })}</span></div>;
        return <div key={i} className={`gcl ${r.k}`}><span className="no">{r.a ?? ''}</span><span className="no">{r.b ?? ''}</span><span className="sg">{r.k === 'a' ? '+' : r.k === 'd' ? '−' : ''}</span><Tx t={r.t} segs={segsOf(r, hl?.sides)} hl={hl} /></div>;
      })}
      {w.padBottom ? <div style={{ height: w.padBottom }} aria-hidden /> : null}
    </div>
  );
}

/** @internal the conflict block under the diff: lines around each conflict + "Xem cả file đã gộp thử" */
export function Conflict({ d, base, branch, log, now, onMerged }: { d: NonNullable<GitDiffResult['conflict']>; base: string; branch: string | null; log: readonly GitCommit[]; now: number; onMerged: () => void }): ReactElement {
  const tr = useT();
  const merged = d.merged.kind === 'text' ? d.merged.text : null;
  const c = d.lastBaseCommit ? log.find(x => x.hash === d.lastBaseCommit) : undefined;
  return (
    <div className="gcfb">
      <Icon n="gitMerge" s={13} />
      <div>
        <b>{tr('git.baseAlso', { base })}</b>
        {d.lastBaseCommit ? <> · <span className="mono">{d.lastBaseCommit.slice(0, 7)}</span>{c ? <> "{c.subject}" · {fmtAgo(c.at, now, tr)}</> : null}</> : null}
        {merged ? d.hunks.map(h => (
          <div key={h.start} className="gcfx" aria-label={branch ?? undefined}>{conflictLines(merged, h).map((l, i) => <div key={i} className={l.k}>{l.t}</div>)}</div>
        )) : null}
        {merged ? <button type="button" className="glink" onClick={onMerged}>{tr('git.viewMerged')}</button> : null}
      </div>
    </div>
  );
}

/** @internal the trial merge in place of the diff, with "Về diff" */
export function Merged({ textOf, onBack }: { textOf: string; onBack: () => void }): ReactElement {
  const tr = useT();
  return (
    <>
      <div className="gnote"><span className="mut">{tr('git.mergedHead')}</span><button type="button" className="glink" onClick={onBack}>{tr('git.backDiff')}</button></div>
      <div className="gcd">{textOf.replace(/\n$/, '').split('\n').map((t, i) => <div key={i} className={`gcl${/^(<<<<<<<|=======|>>>>>>>)/.test(t) ? ' mk' : ''}`}><span className="no">{i + 1}</span><span className="sg" /><span className="tx">{t}</span></div>)}</div>
    </>
  );
}

/** UX M1: the path's real free width in the head: its width minus padding, every other child and the gaps (never < 40). */
export function headRoom(width: number, others: readonly number[], gap: number, pad: number): number {
  return Math.max(40, Math.floor(width - pad - others.reduce((a, b) => a + b, 0) - gap * others.length));
}

/** Measures the head (ResizeObserver) so the path is cut in the middle by the space it really has, `.md` kept (§3.4). */
function useHeadRoom(estimate: number, dep: unknown): { ref: RefObject<HTMLDivElement>; room: number } {
  const ref = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      // the spacer (`.gsp`, flex 1) holds the leftover space: it counts as 0
      const kids = [...el.children].filter(k => !k.classList.contains('gpth')).map(k => (k.classList.contains('gsp') ? 0 : (k as HTMLElement).offsetWidth));
      setRoom(headRoom(el.clientWidth, kids, parseFloat(cs.columnGap) || 0, (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [dep]);
  return { ref, room: room ?? estimate };
}

function Head(p: DiffPaneProps): ReactElement {
  const tr = useT();
  const path = p.path!;
  const { ref, room } = useHeadRoom(Math.max(120, p.width - (p.narrow ? 330 : 420)), `${p.mark}|${p.pill}|${!p.onOpenCode}`);
  const btn = (on: (() => void) | null, icon: 'fileCode' | 'extLink', label: string, tip: string): ReactNode => (
    <button type="button" className="gbt gh" disabled={!on} onClick={on ?? undefined} title={on ? tip : tr('git.notOnDisk')}><Icon n={icon} s={12} />{label}</button>
  );
  return (
    <div className="gvh" ref={ref}>
      <span className="mono gpth" title={path}>{midEllipsis(path, room, monoFont('sm'))}</span>
      {p.mark ? <span className={`gs ${p.mark}`}>{p.mark}</span> : null}
      {p.pill === 'conflict' ? <span className="gcfl"><Icon n="alert" s={12} />{tr('git.conflictPill')}</span> : null}
      {p.pill === 'clean' ? <span className="gokp"><Icon n="circleCheck" s={12} />{tr('git.cleanPill')}</span> : null}
      <span className="gsp" />
      {btn(p.onOpenCode, 'fileCode', tr('git.openCode'), tr('git.openCode'))}
      {btn(p.onVscode, 'extLink', tr('git.vscode'), tr('git.vscodeTip'))}
    </div>
  );
}

/** §6.2 the trial merge text shown in place of the diff: only for the file it was asked on, and only a text merge. */
export function mergedShown(mergedOn: string | null, path: string, diff: GitDiffResult | null): string | null {
  return mergedOn === path && diff?.conflict?.merged.kind === 'text' ? diff.conflict.merged.text : null;
}

export function DiffPane(p: DiffPaneProps): ReactElement {
  const tr = useT();
  const [mergedOn, setMergedOn] = useState<string | null>(null); // the path whose trial merge replaces the body
  const [view, setView] = useState({ top: 0, h: 900 });
  if (!p.path) {
    return <section className="gvw"><div className="gemp mut">{p.none ? <><Icon n="gitCompare" s={22} /><span>{tr('git.nothing')}</span></> : tr('git.pickFile')}</div></section>;
  }
  const merged = mergedShown(mergedOn, p.path, p.diff);
  return (
    <section className="gvw">
      <Head {...p} />
      {!p.diff && !p.err ? <div className="gbar" aria-busy="true" /> : null}
      <div className="gbody" onScroll={e => setView({ top: e.currentTarget.scrollTop, h: e.currentTarget.clientHeight })}>
        {p.err && !p.diff ? <div className="gemp bad">{tr('git.loadFail', { reason: p.err })}</div> : null}
        {merged !== null ? <Merged textOf={merged} onBack={() => setMergedOn(null)} />
          : p.diff ? <><Body d={p.diff} path={p.path} view={view} />{p.diff.conflict ? <Conflict d={p.diff.conflict} base={p.base} branch={p.branch} log={p.log} now={p.now} onMerged={() => setMergedOn(p.path)} /> : null}</> : null}
      </div>
    </section>
  );
}
