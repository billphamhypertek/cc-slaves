// v2.7 §5.7 the PO's Huỷ (IS4) and the revert it may start (D75): `issue_cancel_preview` (R-B12, the numbers IS4 shows)
// and `issue_cancel`. `todo` → cancelled; `doing` → the lane is stopped and its process is gone (A4) BEFORE anything changes,
// then not on the target branch → cancelled + lane finished, else as `done`; `done` → `requestRevert` + the "Hoàn tác …"
// issue. Never half-way (A3): every check runs before the first write. The caller maps a `CancelRefused` to its channel.
import type { Db } from '../db.ts';
import { issueKey, type IssueCancelPreview, type IssueCancelResult, type IssueRow } from '../../../shared/issues.ts';
import { laneWork, revertTarget } from './commits.ts';
import type { IssueEvents } from './events.ts';
import type { Exec } from '../setup/setup.ts';
import { addDep, cancelIssue, createIssue, getIssue, getIssueByKey, getSpec, listCommits, openRevertOf, projectDeps, requestRevert } from './store.ts';

export interface CancelPorts {
  db: Db;
  exec: Exec;
  events: Pick<IssueEvents, 'poCancelled' | 'specSettled'>;
  /** The project's root (the repo the target branches live in). */
  root: (projectId: string) => string;
  /** `lane_stop now`; resolves only once the lane's process has exited (A4). */
  stopLane: (projectId: string, name: string) => Promise<void>;
  /** `lane_finish force` of a stopped lane. */
  finishLane: (projectId: string, name: string) => Promise<void>;
  /** A revert of `orig` was requested (its revert_conflict card, if any, is answered by this). */
  reverting: (orig: IssueRow) => void;
}

/** A Vietnamese refusal the PO reads (IS4 never opens / the confirm is refused). */
export class CancelRefused extends Error {}

/** §5.7-4 `done_when` of every revert issue, verbatim. */
export const REVERT_DONE_WHEN = ['một commit Revert, test xanh, đã merge'];

type Plan =
  | { mode: 'cancel' }
  | { mode: 'stop'; lane: LaneRow; branch: string | null; commits: number }
  | { mode: 'revert'; branch: string | null; shas: string[] };
interface LaneRow { name: string; cwd: string }

const short = (sha: string) => sha.slice(0, 7);

/** R31 / IS5 / §5.7: what IS4 never offers. */
function refusal(i: IssueRow): string | null {
  if (i.source === 'prior') return `${i.key} là phần làm trước khi nhập: không có trailer để tìm commit, không huỷ / hoàn tác được`;
  if (i.state === 'cancelled') return `${i.key} đã huỷ`;
  if (i.reverts !== null) return `${i.key} là mục hoàn tác: chờ nó xong, hoặc vướng thì engine hỏi anh`;
  if (i.revert === 'pending' || i.revert === 'running') return `${i.key} đang hoàn tác`;
  return null;
}

function mustIssue(db: Db, projectId: string, key: string): IssueRow {
  const i = getIssueByKey(db, projectId, key);
  if (!i) throw new CancelRefused(`Không có mục ${key} trong project này`);
  const why = refusal(i);
  if (why) throw new CancelRefused(why);
  return i;
}

function laneOf(db: Db, i: IssueRow): LaneRow {
  const l = i.laneId === null ? null : db.query<LaneRow, [number]>('SELECT name, cwd FROM lane WHERE id = ?').get(i.laneId);
  if (!l) throw new CancelRefused(`${i.key} đang làm nhưng không còn thấy lane của nó`);
  return l;
}

const gitFailed = (i: IssueRow, reason: string) => new CancelRefused(`Không đọc được git cho ${i.key}: ${reason} — sửa git rồi thử lại`);

/** §5.7-4 the target branch + its trailer commits for `shas` (the issue's own commits). */
async function target(p: CancelPorts, i: IssueRow, shas: readonly string[]): Promise<{ branch: string | null; shas: string[] }> {
  const spec = i.specId === null ? null : getSpec(p.db, i.specId);
  const t = await revertTarget({
    cwd: p.root(i.projectId), exec: p.exec, key: i.key, specBranch: spec?.branch ?? null, specDone: spec?.state === 'done', shas,
  });
  if (t.kind === 'skipped') return { branch: null, shas: [] };
  if (t.kind !== 'ok') throw gitFailed(i, t.reason);
  return { branch: t.branch, shas: t.shas };
}

/** §5.7-2 / -3 / -4 what confirming IS4 would do to `i`, read from git now. */
async function plan(p: CancelPorts, i: IssueRow): Promise<Plan> {
  if (i.state === 'todo') return { mode: 'cancel' };
  if (i.state === 'done') return { mode: 'revert', ...await target(p, i, listCommits(p.db, i.id).map((c) => c.sha)) };
  const lane = laneOf(p.db, i);
  const w = await laneWork({ cwd: lane.cwd, baseSha: i.baseSha, key: i.key, exec: p.exec });
  if (w.kind !== 'ok') throw gitFailed(i, w.reason);
  const t = await target(p, i, w.shas);
  // §5.7-3 `merge-base --is-ancestor` (inside revertTarget): any trailer commit already on the target → revert it like a done one
  if (t.shas.length > 0) return { mode: 'revert', ...t };
  return { mode: 'stop', lane, branch: w.branch, commits: w.shas.length };
}

function dependants(db: Db, i: IssueRow): { open: string[]; done: string[] } {
  const rows = projectDeps(db, i.projectId).filter((d) => d.blockedById === i.id).map((d) => getIssue(db, d.issueId)!).filter(Boolean);
  const of = (f: (r: IssueRow) => boolean) => rows.filter(f).map((r) => r.key);
  return { open: of((r) => r.state === 'todo' || r.state === 'doing'), done: of((r) => r.state === 'done') };
}

const nextNum = (db: Db, projectId: string) =>
  (db.query<{ m: number | null }, [string]>('SELECT MAX(num) AS m FROM issue WHERE project_id = ?').get(projectId)?.m ?? 0) + 1;

/** R-B12 the IS4 numbers. Throws `CancelRefused` for what IS4 never offers. */
export async function cancelPreview(p: CancelPorts, projectId: string, key: string): Promise<IssueCancelPreview> {
  const i = mustIssue(p.db, projectId, key);
  const pl = await plan(p, i);
  return {
    key: i.key, mode: pl.mode,
    lane: pl.mode === 'stop' ? { name: pl.lane.name, branch: pl.branch, commits: pl.commits } : null,
    revert: pl.mode === 'revert' ? { branch: pl.branch, shas: pl.shas, key: issueKey('task', nextNum(p.db, projectId)) } : null,
    dependants: dependants(p.db, i),
  };
}

/** §5.7-4 the lane's instructions in the revert issue (it names its own key in the trailer). */
function revertBody(orig: IssueRow, branch: string | null, shas: readonly string[], reason: string | null) {
  return (key: string) => [
    `Hoàn tác ${orig.key} "${orig.title}"${branch ? ` trên nhánh \`${branch}\`` : ' (project không có git)'}: ${shas.length} commit mang trailer `
      + `\`Issue: ${orig.key}\`${shas.length ? ` (${shas.map(short).join(', ')})` : ''}.`,
    '',
    `1. \`git log --grep "^Issue: ${orig.key}$" --no-merges ${branch ?? 'main'}\` — đúng các commit trên.`,
    '2. `git revert -n` từng commit, mới → cũ; **một** commit `Revert ' + orig.key + '` với trailer '
      + `\`Issue: ${key}\` và \`Reverts: <các hash>\`.`,
    `3. Chạy test, merge vào \`${branch ?? 'main'}\`, rồi issue_done {key: "${key}"}. Không \`reset --hard\`, không force-push.`,
    `4. Xung đột → \`git revert --abort\`, gọi issue_revert_conflict {key: "${key}", detail} rồi dừng (engine hỏi PO).`,
    ...(reason ? ['', `Lý do PO huỷ: ${reason}`] : []),
  ].join('\n');
}

/** §5.7-4 one transaction: `revert=pending` on the original + the revert issue, ordered against the other open reverts. */
function startRevert(p: CancelPorts, orig: IssueRow, pl: Extract<Plan, { mode: 'revert' }>, reason: string | null): IssueRow {
  const { db } = p;
  return db.transaction(() => {
    requestRevert(db, orig.id, { reason, commits: pl.shas.map((sha) => ({ sha, branch: pl.branch })) });
    const spec = orig.specId === null ? null : getSpec(db, orig.specId);
    const r = createIssue(db, {
      projectId: orig.projectId, kind: 'task', specId: spec?.state === 'active' ? spec.id : null, source: 'po', reverts: orig.id,
      title: `Hoàn tác ${orig.key}`, doneWhen: REVERT_DONE_WHEN, bodyFor: revertBody(orig, pl.branch, pl.shas, reason),
    });
    // "Huỷ cả hai…" (§5.7-5): what was built on the original is reverted first, whichever confirm came first
    for (const d of projectDeps(db, orig.projectId)) {
      const after = d.blockedById === orig.id ? openRevertOf(db, d.issueId) : null; // a dependant's revert → this one waits
      if (after && after.id !== r.id) addDep(db, r.id, after.id);
      const before = d.issueId === orig.id ? openRevertOf(db, d.blockedById) : null; // a blocker's revert → it waits for this one
      if (before && before.id !== r.id) addDep(db, before.id, r.id);
    }
    return r;
  })();
}

/** Issues being cancelled right now, per state.db: a double confirm (two windows, a double click) is refused, not run twice. */
const busy = new WeakMap<Db, Set<number>>();

/** §5.7 the PO confirmed IS4 on `key`. */
export async function cancelByPo(p: CancelPorts, projectId: string, key: string, reason: string | null): Promise<IssueCancelResult> {
  const i = mustIssue(p.db, projectId, key);
  let set = busy.get(p.db);
  if (!set) busy.set(p.db, (set = new Set()));
  if (set.has(i.id)) throw new CancelRefused(`${i.key} đang được huỷ`);
  set.add(i.id);
  try { return await run(p, i, reason); } finally { set.delete(i.id); }
}

async function run(p: CancelPorts, first: IssueRow, reason: string | null): Promise<IssueCancelResult> {
  const projectId = first.projectId;
  let i = first;
  let pl = await plan(p, i); // git read before the lane is touched: a broken repo refuses with the lane untouched
  const lane = i.state === 'doing' ? laneOf(p.db, i) : null;
  if (i.state === 'doing' && lane) {
    await p.stopLane(projectId, lane.name); // A4: the process is gone before the issue changes
    i = getIssue(p.db, i.id)!;
    if (i.state === 'cancelled') throw new CancelRefused(`${i.key} đã huỷ`);
    pl = i.state === 'todo' ? { mode: 'cancel' } : await plan(p, i); // the lane may have finished it on its last breath
  }
  const stopped = lane && i.laneId !== null ? { name: lane.name, branch: pl.mode === 'stop' ? pl.branch : null } : null;
  if (pl.mode === 'revert') {
    const r = startRevert(p, i, pl, reason);
    if (stopped) await p.finishLane(projectId, stopped.name);
    p.reverting(i);
    p.events.poCancelled(getIssue(p.db, i.id)!, { reason, lane: stopped, revert: { issue: r, branch: pl.branch, shas: pl.shas.length } });
    return { key: i.key, mode: 'revert', revertKey: r.key };
  }
  const done = cancelIssue(p.db, i.id, { reason, by: 'po' });
  if (lane) await p.finishLane(projectId, lane.name);
  p.events.poCancelled(done, { reason, lane: stopped, revert: null });
  if (done.specId !== null) p.events.specSettled(done.specId);
  return { key: i.key, mode: pl.mode, revertKey: null };
}
