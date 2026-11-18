// spec v2.3 §6 / §10.2 the Git view's data: `git_watch` on only while the tab shows (§10.2 "không gọi git khi tab Git đang
// ẩn"), `git_branches` / `git_changes` / `git_log` (200 a page, "Tải thêm") / `git_diff` for what is picked. Read again on
// `code_changed` of the project, on window focus and on showing the tab when the data is older than 60 s (V17); a change
// while hidden waits for the next show. A late answer to an older question is dropped.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Command, GitBranchesResult, GitCommit, GitDiffResult, GitFileChange, GitLogResult, GitOf } from '../../../shared/protocol.ts';
import { errText, useT } from '../lib/i18n.tsx';
import type { CodeChanged } from '../lib/store.ts';

export type Send = (c: Command) => Promise<unknown>;
/** §10.2 page size of `git_log`. */
const PAGE = 200;
/** V17 results older than this are read again on focus / show. */
const STALE_MS = 60_000;

/** A read: its answer, or the error text, or still loading (both null). */
export interface Got<T> { v: T | null; err: string | null }
const NONE = { v: null, err: null };

export interface GitIo {
  shown: boolean; projectId: string; open: boolean; send: Send;
  onCodeChanged: (fn: (e: CodeChanged) => void) => () => void;
}

/** §10.2 the Git view counts as shown only while its mode shows AND the window is not hidden (M3: `git_watch` off then). */
export const gitShown = (modeShown: boolean, tabHidden: boolean): boolean => modeShown && !tabHidden;

type SetGot<T> = (f: (g: Got<T>) => Got<T>) => void;
/** One read's state machine: `load` asks again; an answer (or failure) of an older question never lands (I1 / I2). `keep` =
 *  the same question asked again: the old answer stays on screen while it loads and under its error. */
export function reader<T>(set: SetGot<T>, errOf: (e: unknown) => string): (p: Promise<unknown> | null, keep?: boolean) => void {
  let seq = 0;
  return (p, keep = false) => {
    const n = ++seq;
    if (!p) { set(() => NONE); return; }
    if (!keep) set(() => NONE);
    p.then(v => { if (seq === n) set(() => ({ v: v as T, err: null })); },
      (e: unknown) => { if (seq === n) set(g => ({ v: keep ? g.v : null, err: errOf(e) })); });
  };
}

function useRead<T>(): [Got<T>, (p: Promise<unknown> | null, keep?: boolean) => void] {
  const tr = useT();
  const [got, setGot] = useState<Got<T>>(NONE);
  const load = useMemo(() => reader<T>(setGot, e => errText(tr, e)), [tr]);
  return [got, load];
}

/** M4 / V17 when the blocks read again: the first show reads at rev 0 (no bump); later shows / focus only past 60 s; a
 *  `code_changed` reads at once while shown, else on the next show. Pure (the hook keeps one per view). */
export class RevClock {
  private at = 0;
  private stale = false;
  constructor(private readonly now: () => number = Date.now) {}
  /** a bump reads everything now */
  read(): void { this.at = this.now(); }
  /** the tab shows: true = bump */
  show(): boolean {
    if (this.at === 0) { this.at = this.now(); this.stale = false; return false; } // the rev-0 read is this show's read
    if (!this.stale && this.now() - this.at <= STALE_MS) return false;
    this.stale = false;
    return true;
  }
  changed(shown: boolean): boolean { if (shown) return true; this.stale = true; return false; }
  focus(shown: boolean): boolean { return shown && this.at !== 0 && this.now() - this.at > STALE_MS; }
}

/** `rev` = a bump that makes every block read again (code_changed, focus after 60 s, "Thử lại", reconnect). */
export function useGitRev(io: GitIo): { rev: number; bump: () => void } {
  const [rev, setRev] = useState(0);
  const [c] = useState(() => new RevClock());
  const bump = useCallback(() => { c.read(); setRev(r => r + 1); }, [c]);
  const { shown, open, projectId, send, onCodeChanged } = io;
  useEffect(() => { // §10.2 the engine measures and logs only for a tab that shows
    if (!shown || !open) return;
    void send({ cmd: 'git_watch', projectId, on: true }).catch(() => {});
    if (c.show()) bump();
    return () => { void send({ cmd: 'git_watch', projectId, on: false }).catch(() => {}); };
  }, [shown, open, projectId, send, bump, c]);
  useEffect(() => onCodeChanged(e => { if (e.projectId === projectId && c.changed(shown)) bump(); }), [onCodeChanged, projectId, shown, bump, c]);
  useEffect(() => {
    const f = () => { if (c.focus(shown)) bump(); };
    window.addEventListener('focus', f);
    return () => window.removeEventListener('focus', f);
  }, [shown, bump, c]);
  return { rev, bump };
}

type Gate = (o: { shown: boolean; open: boolean; sig: string; key: string }) => { same: boolean } | null;
/** The gate of `useWhenShown`: once per new `sig` while shown; `same` = the question's key did not move (a re-read). */
export function shownGate(): Gate {
  let done = '', lastKey: string | null = null;
  return ({ shown, open, sig, key }) => {
    if (!shown || !open || done === sig) return null;
    done = sig;
    const same = lastKey === key;
    lastKey = key;
    return { same };
  };
}

/** Runs `fn` once per new `sig` while the tab shows (§10.2: no git while hidden; a change made meanwhile loads on the next show). */
function useWhenShown(io: GitIo, sig: string, fn: (sameKey: boolean) => void, key: string): void {
  const [gate] = useState(shownGate);
  useEffect(() => {
    const r = gate({ shown: io.shown, open: io.open, sig, key });
    if (r) fn(r.same);
  }); // every render: the gate makes it a no-op unless `sig` moved
}

/** §6.1 one `git_branches`; a new project never keeps the old one's list (I1), only a re-read of the same project does. */
export const askBranches = (io: Pick<GitIo, 'send' | 'projectId'>, load: (p: Promise<unknown>, keep: boolean) => void) =>
  (same: boolean): void => load(io.send({ cmd: 'git_branches', projectId: io.projectId }), same);

/** §7 G7 (R17) the engine's explicit marker, read through the seq-guarded `reader`: a late answer of another project never
 *  turns this one into G7 (I2). */
export const isNotRepo = (r: GitBranchesResult | null): boolean => r?.notRepo === true;

export function useBranches(io: GitIo, rev: number, measureKey: string): { got: Got<GitBranchesResult>; noGit: boolean } {
  const [got, load] = useRead<GitBranchesResult>();
  useWhenShown(io, `${rev}|${measureKey}|${io.projectId}`, askBranches(io, load), io.projectId);
  return { got, noGit: isNotRepo(got.v) };
}

/** `of` null = nothing to read (no base yet); a new `of` clears the old list at once, a re-read keeps it (§7 G5). */
export function useChanges(io: GitIo, rev: number, of: GitOf | null): Got<GitFileChange[]> {
  const [got, load] = useRead<{ files: GitFileChange[] }>();
  const key = `${io.projectId}\n${JSON.stringify(of)}`;
  useWhenShown(io, `${rev}|${key}`, same => load(of ? io.send({ cmd: 'git_changes', projectId: io.projectId, of }) : null, same), key);
  return { v: got.v?.files ?? null, err: got.err };
}

export function useDiff(io: GitIo, rev: number, path: string | null, of: GitOf | null): Got<GitDiffResult> {
  const [got, load] = useRead<GitDiffResult>();
  const key = `${io.projectId}\n${path}\n${JSON.stringify(of)}`;
  useWhenShown(io, `${rev}|${key}`, same => load(path && of ? io.send({ cmd: 'git_diff', projectId: io.projectId, path, of }) : null, same), key);
  return got;
}

export interface Log { commits: GitCommit[]; more: boolean; err: string | null; loading: boolean; loadMore: () => void }

/** §6.1 / §10.2 the graph: first page on a new ref set / rev, "Tải thêm" appends; `restart` (tips moved) starts over. */
export function useLog(io: GitIo, rev: number, refs: readonly string[] | null): Log {
  const tr = useT();
  const [s, setS] = useState<{ commits: GitCommit[]; more: boolean; err: string | null; loading: boolean }>({ commits: [], more: false, err: null, loading: true });
  const seq = useRef(0);
  const key = JSON.stringify(refs);
  const { projectId, send } = io;
  const page = useCallback((before: string | null) => {
    if (!refs) return;
    const n = ++seq.current;
    setS(x => ({ ...x, loading: true }));
    send({ cmd: 'git_log', projectId, refs: [...refs], limit: PAGE, ...(before ? { before } : {}) }).then(r => {
      if (seq.current !== n) return;
      const g = r as GitLogResult;
      setS(x => ({ commits: before && !g.restart ? [...x.commits, ...g.commits] : g.commits, more: g.more, err: null, loading: false }));
    }, (e: unknown) => { if (seq.current === n) setS(x => ({ ...x, err: errText(tr, e), loading: false })); });
  }, [key, projectId, send, tr]); // eslint-disable-line react-hooks/exhaustive-deps
  useWhenShown(io, `${rev}|${projectId}|${key}`, () => page(null), key);
  return { ...s, loadMore: () => page(s.commits.at(-1)?.hash ?? null) };
}
