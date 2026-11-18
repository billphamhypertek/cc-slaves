// spec v2.3 §6 Git mode root: the Source Control column (360 px, 300 px < 1280: Nhánh · Thay đổi · Đồ thị, each folding,
// remembered per project) and the diff pane. Hidden like the Code root when another mode shows. Picking a
// branch / commit here never changes Đang xem (§4.2, V3); "Nhờ …" only sets the composer target + sentence (§4.3, V12).
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { loadLazyNs } from '../../../shared/i18n/lazy.ts';
import type { GitCommit, GitOf, LaneView, SetupStatus, Src } from '../../../shared/protocol.ts';
import { requestCodeOpen } from '../lib/code-open.ts';
import { fmtHm } from '../lib/format.ts';
import { useT } from '../lib/i18n.tsx';
import { selLane, type Selection } from '../lib/inspector.ts';
import type { CodeChanged } from '../lib/store.ts';
import { Icon } from '../ui/icons.tsx';
import { Block, Branches, laneColor } from './Branches.tsx';
import { Changes, statusMark, type FilePick } from './Changes.tsx';
import { DiffPane } from './DiffPane.tsx';
import { GraphRows, type GraphEntry } from './GraphRows.tsx';
import { asksFor, defaultPick, gitBlocked, firstFile, foldsOf, laneRows, logRefs, measureOf, orderRows, withFolds, type Ask, type AskWho, type Folds, type GitPick, type GraphFilter } from './model.ts';
import { gitShown, useBranches, useChanges, useDiff, useGitRev, useLog, type GitIo, type Send } from './useGit.ts';
import '../code/code.css';
import './git.css';

loadLazyNs(); // the `git` catalog namespace ships with this chunk only (bundle cap)
const GitSetup = lazy(() => import('../ui/GitSetup.tsx'));

const FOLD_KEY = 'ccs.gitFold';
const ls = (): Storage | null => (typeof localStorage === 'undefined' ? null : localStorage);

export interface GitHost {
  projectId: string; projectPath: string; send: Send; open: boolean; offline: boolean; dataAt: number | null;
  narrow: boolean; now: number; width: number;
  /** the window is hidden (`visibilitychange`, M3): reads and `git_watch` stop as if the tab hid */
  hidden: boolean;
  /** deck order of the lanes (keys 1–9), for the "Nhánh" order */
  order: readonly string[];
  onCodeChanged: (fn: (e: CodeChanged) => void) => () => void;
  /** §4.3 composer override + prefilled sentence + caret in the box */
  ask: (who: AskWho, text: string) => void;
  toCode: () => void;
  vscode: (src: Src, path: string) => void;
  /** hf1116 (b) git missing / blocked by Xcode's license → the Git setup block instead of git's raw error. */
  setup: SetupStatus | null;
  mac: boolean;
  toast: (t: string) => void;
}

/** @internal §7 G7 not a git repo: the reason + "Sang Code" */
export function NoGit({ toCode }: { toCode: () => void }): ReactElement {
  const tr = useT();
  return (
    <div className="gnogit"><Icon n="branch" s={28} /><b>{tr('git.noGit')}</b><span className="mut">{tr('git.noGitSub')}</span>
      <button type="button" className="gbt" onClick={toCode}><Icon n="fileCode" s={12} />{tr('git.toCode')}</button></div>
  );
}

/** @internal §6.1 the graph's "Tải thêm" (the next page of `git_log`), greyed while a page loads */
export function GraphMore({ log }: { log: { more: boolean; loading: boolean; loadMore: () => void } }): ReactElement | null {
  const tr = useT();
  return log.more ? <button type="button" className="glink gmore" disabled={log.loading} onClick={log.loadMore}>{tr('git.loadMore')}</button> : null;
}

const selKey = (s: Selection): string => `${s.k}:${selLane(s) ?? ''}`;

export function GitView({ shown, sel, lanes, host }: { shown: boolean; sel: Selection; lanes: readonly LaneView[]; host: GitHost }): ReactElement {
  const tr = useT();
  const io: GitIo = { shown: gitShown(shown, host.hidden), projectId: host.projectId, open: host.open, send: host.send, onCodeChanged: host.onCodeChanged };
  const { rev, bump } = useGitRev(io);
  const measureKey = lanes.map(l => `${l.name}:${l.branch?.measuredAt ?? ''}:${l.branch?.measuring ? 1 : 0}`).join(',');
  const { got: br, noGit } = useBranches(io, rev, measureKey);
  const res = noGit ? null : br.v; // G7: nothing below reads git
  const [pick, setPick] = useState<GitPick>(() => defaultPick(sel, lanes, null));
  const [commit, setCommit] = useState<GitCommit | null>(null);
  const [file, setFile] = useState<FilePick | null>(null);
  const [dirtyOpen, setDirtyOpen] = useState(false);
  const [filter, setFilter] = useState<GraphFilter>('sel');
  const [folds, setFolds] = useState<Folds>(() => foldsOf(ls()?.getItem(FOLD_KEY) ?? null, host.projectId));
  useEffect(() => setFolds(foldsOf(ls()?.getItem(FOLD_KEY) ?? null, host.projectId)), [host.projectId]);
  const fold = (k: keyof Folds) => setFolds(f => { const n = { ...f, [k]: !f[k] }; ls()?.setItem(FOLD_KEY, withFolds(ls()?.getItem(FOLD_KEY) ?? null, host.projectId, n)); return n; });
  // §4.2 Đang xem → the preselected branch (one way); again once the branch list first arrives
  useEffect(() => { setPick(defaultPick(sel, lanes, res)); setCommit(null); setFile(null); setDirtyOpen(false); }, [selKey(sel), host.projectId, !!res]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => (res ? laneRows(res, lanes, pick) : []), [res, lanes, pick]);
  const ordered = useMemo(() => orderRows(rows, host.order), [rows, host.order]);
  const row = pick.k === 'lane' ? rows.find(r => r.lane === pick.lane) ?? null : null;
  const base = res?.base?.name ?? null;
  const laneView = row ? lanes.find(l => l.name === row.lane) : undefined;
  const laneSrc: Src | null = row && laneView?.worktreeExists !== false ? { kind: 'lane', laneId: row.lane } : null;
  const of: GitOf | null = !res ? null : commit ? { commit: commit.hash } : row ? { branch: row.branch } : { dirty: { kind: 'base' } };
  const changes = useChanges(io, rev, of);
  const dirtyOf: GitOf | null = row && laneSrc && dirtyOpen && !commit ? { dirty: laneSrc } : null;
  const dirty = useChanges(io, rev, dirtyOf);
  const log = useLog(io, rev, res ? logRefs(filter, base, row?.branch ?? null) : null);
  const empty = !!res?.base && !log.loading && !log.err && log.commits.length === 0;
  const diffOf = file?.dirty ? dirtyOf : of;
  const diff = useDiff(io, rev, file?.path ?? null, file ? diffOf : null);

  // §6.2 the first conflicted file (else the first) is picked when a list arrives; an empty list picks nothing
  const filesKey = changes.v ? `${JSON.stringify(of)}|${changes.v.map(f => f.path).join('\n')}` : '';
  useEffect(() => {
    if (!changes.v) return;
    setFile(f => (f && (f.dirty || changes.v!.some(x => x.path === f.path)) ? f : (p => (p ? { path: p, dirty: false } : null))(firstFile(changes.v!))));
  }, [filesKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const width = host.narrow ? 300 : 360;
  const tool = host.setup?.git.state;
  // hf1116 (b): git works again (installed, license accepted) → read again (not on mount: the first read is running)
  const lastTool = useRef(tool);
  useEffect(() => { if (tool === 'ok' && lastTool.current !== 'ok') bump(); lastTool.current = tool; }, [tool]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!res && host.setup && gitBlocked(host.setup.git)) {
    return (
      <div id="gitview" className="ccg" style={{ visibility: shown ? undefined : 'hidden' }} aria-hidden={shown ? undefined : true}>
        <div className="gsetup-host"><Suspense fallback={null}><GitSetup setup={host.setup} send={host.send} mac={host.mac} toast={host.toast} /></Suspense></div>
      </div>
    );
  }
  if (noGit) {
    return (
      <div id="gitview" className="ccg" style={{ visibility: shown ? undefined : 'hidden' }} aria-hidden={shown ? undefined : true}>
        <NoGit toCode={host.toCode} />
      </div>
    );
  }
  const m = row ? measureOf(row.b) : null;
  const asks: Ask[] = res && !commit ? asksFor(tr, { base: base ?? '', row, dirty: row ? row.b?.dirty ?? 0 : res.base?.dirty ?? 0, conflictFiles: [], dir: row ? laneView?.cwd ?? '' : host.projectPath }) : [];
  const files = changes.v ?? null;
  const total = row && !commit && files ? files.reduce((t, f) => ({ add: t.add + (f.add ?? 0), del: t.del + (f.del ?? 0) }), { add: 0, del: 0 }) : null;
  const id = (s: string) => <span className="gid">{s}</span>;
  const title = commit ? <>{tr('git.commit')} {id(commit.hash.slice(0, 7))}</>
    : row ? <>{tr('git.changes')}{files ? ` · ${files.length}` : null} · {id(row.branch)}{host.narrow || !base ? null : <> {tr('git.vs')} {id(base)}</>}</>
    : empty ? tr('git.untracked', { n: files?.length ?? 0 }) : tr('git.baseDirtyHead');
  const fileRow = file ? (file.dirty ? dirty.v : files)?.find(f => f.path === file.path) : undefined;
  const codeSrc: Src | null = file?.dirty || (row && !commit) ? laneSrc : { kind: 'base' };
  const onDisk = !!file && !!codeSrc && fileRow?.status !== 'D';
  const graph: GraphEntry[] = log.commits.map(c => ({ hash: c.hash, parents: c.parents, branches: c.refs, subject: c.subject, author: c.author, time: c.at }));
  const color = (ref: string | null) => { if (ref && ref === base) return 'var(--accent)'; const r = rows.find(x => x.branch === ref); return r ? laneColor(r) : 'var(--fg-3)'; };
  return (
    <div id="gitview" className={`ccg${host.narrow ? ' gnarrow' : ''}`} style={{ visibility: shown ? undefined : 'hidden' }} aria-hidden={shown ? undefined : true}>
      {host.offline ? <div className="goff" role="status"><Icon n="wifi" s={12} />{tr('git.offline', { hm: host.dataAt ? fmtHm(host.dataAt) : '—' })}</div> : null}
      <aside className="gside" style={{ width }}>
        {!res ? (br.err ? <div className="gsubl bad">{tr('git.loadFail', { reason: br.err })} · <button type="button" className="glink" onClick={bump}>{tr('git.retry')}</button></div>
          : <div className="gskel" aria-busy="true">{[0, 1, 2, 3, 4, 5, 6, 7].map(i => <i key={i} />)}</div>) : (
          <>
            <Branches res={res} rows={ordered} pick={pick} onPick={p => { setPick(p); setCommit(null); setFile(null); setDirtyOpen(false); }} empty={empty}
              offline={host.offline} onRetry={() => { void host.send({ cmd: 'git_watch', projectId: host.projectId, on: true }).catch(() => {}); bump(); }}
              folded={folds.b} onFold={() => fold('b')} direct={laneDirect(sel, lanes)} />
            <Changes title={title} files={files} err={changes.err} total={total} commit={commit} onCloseCommit={() => { setCommit(null); setFile(null); }}
              dirty={row && !commit ? { n: row.b?.dirty ?? 0, files: dirty.v, err: dirty.err, open: dirtyOpen, onOpen: () => setDirtyOpen(o => !o) } : null}
              empty={row ? tr('git.laneEmpty', { base: base ?? '' }) : tr('git.nothing')} pick={file} onPick={setFile}
              asks={asks} onAsk={a => host.ask(a.who, a.text)} offline={host.offline} width={width} folded={folds.c} onFold={() => fold('c')} />
            <Block cls="b3" folded={folds.g} onFold={() => fold('g')} title={tr('git.graph')}
              right={<select className="gsel" value={filter} onChange={e => setFilter(e.target.value as GraphFilter)} aria-label={tr('git.graph')}>
                <option value="sel">{tr('git.graphSel')}</option><option value="lanes">{tr('git.graphLanes')}</option><option value="base">{tr('git.graphBase')}</option></select>}>
              {log.err ? <div className="gsubl bad">{tr('git.loadFail', { reason: log.err })}</div>
                : empty || (!log.loading && !graph.length) ? <div className="gsubl mut">{tr('git.noCommitsYet')}</div>
                : <GraphRows commits={graph} base={base} color={color} now={host.now} selected={commit?.hash ?? null} narrow={host.narrow}
                    onPick={h => { const c = log.commits.find(x => x.hash === h); if (c) { setCommit(c); setFile(null); } }} />}
              <GraphMore log={log} />
            </Block>
          </>
        )}
      </aside>
      <DiffPane path={file?.path ?? null} mark={fileRow ? statusMark(fileRow.status) : null} none={!!files && files.length === 0 && !(row?.b?.dirty)}
        diff={diff.v} err={diff.err} base={base ?? ''} branch={row?.branch ?? null}
        pill={row && !commit && !file?.dirty ? (m?.k === 'conflicts' && fileRow?.conflict ? 'conflict' : m?.k === 'clean' ? 'clean' : null) : null}
        onOpenCode={onDisk && file && codeSrc ? () => { requestCodeOpen(codeSrc, file.path); host.toCode(); } : null}
        onVscode={onDisk && file && codeSrc ? () => host.vscode(codeSrc, file.path) : null}
        log={log.commits} now={host.now} narrow={host.narrow} width={host.width} />
    </div>
  );
}

/** §4.2 Đang xem is a lane with no own branch (runs right in the repo): its name for "D7 chạy thẳng trong repo". */
function laneDirect(sel: Selection, lanes: readonly LaneView[]): string | null {
  const name = selLane(sel);
  const l = name === null ? undefined : lanes.find(x => x.name === name);
  return l?.branch?.state === 'none' ? l.name : null;
}
