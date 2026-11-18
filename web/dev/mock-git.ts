// Dev mock: the Git view's data (spec v2.3 §6, mockup G1–G16) — `?g=<scene>` on the page URL with the Git tab open.
// Scenes: G1 (default) · G5 measuring · G6 not measured · G7 not a git repo · G8 24 branches · G10 lane with no change ·
// G14 repo with no commit · G16 40 changed files. Lanes D15 / R5 / D2 / B3 / C1 / D7 join the hagenta snapshot.
import type { Command, GitBranchesResult, GitCommit, GitDiffResult, GitFileChange, GitOf, LaneBranch, LaneState, LaneView, Snapshot } from '../../shared/protocol.ts';

export type GitScene = 'G1' | 'G5' | 'G6' | 'G7' | 'G8' | 'G10' | 'G14' | 'G16';
export const GIT_SCENES: readonly GitScene[] = ['G1', 'G5', 'G6', 'G7', 'G8', 'G10', 'G14', 'G16'];
type Reply = { ok: unknown } | { code: string; message: string; key?: string; params?: Record<string, string> };

const H = 3_600_000, MIN = 60_000;
const br = (name: string, o: Partial<LaneBranch> = {}): LaneBranch =>
  ({ name, base: 'main', state: 'unmerged', ahead: 2, files: 4, add: 64, del: 12, measuredAt: Date.now() - 20_000, behind: 0, conflicts: [], ...o });
const LANES: [string, LaneState, Partial<LaneBranch>][] = [
  ['D15', 'waiting_po', { ahead: 3, behind: 1, files: 4, add: 18, del: 6, conflicts: ['engine/src/lanes.ts'], dirty: 1 }],
  ['R5', 'broken', { ahead: 1, behind: 1 }], ['D2', 'running', { ahead: 2, behind: 0 }], ['B3', 'running', { ahead: 4, behind: 0 }],
  ['C1', 'waiting_quota', { ahead: 0, behind: 1 }], ['D7', 'done', { ahead: 2, behind: 3 }], ['B2', 'done', { state: 'merged', ahead: 0 }],
];
const MANY: [string, LaneState][] = [['D16', 'running'], ['D17', 'running'], ['D19', 'broken'], ['R6', 'running'], ['R7', 'waiting_po'], ['B4', 'running'], ['B5', 'waiting_quota']];

function lanesFor(g: GitScene): [string, LaneState, Partial<LaneBranch>][] {
  const out = LANES.map(([n, s, o]): [string, LaneState, Partial<LaneBranch>] => [n, s, g === 'G6' && n === 'D15' ? { ...o, state: 'unknown', conflicts: undefined, reason: 'timeout' } : g === 'G5' ? { ...o, measuring: true } : o]);
  if (g === 'G10') out.splice(5, 0, ['D18', 'running', { ahead: 0, behind: 0 }]);
  if (g === 'G8') out.splice(5, 0, ...MANY.map(([n, s], i): [string, LaneState, Partial<LaneBranch>] => [n, s, { ahead: i + 1, behind: i % 3, conflicts: i === 2 ? ['a.ts', 'b.ts'] : [] }]));
  if (g === 'G8') for (let i = 0; i < 13; i++) out.push([`M${i}`, 'done', { state: 'merged', ahead: 0 }]);
  return out;
}

/** Puts the scene's lanes into the hagenta snapshot (Đang xem picks D15 by default in the shots). */
export function gitSnapshot(s: Snapshot, g: GitScene): void {
  if (g === 'G7' || g === 'G14') { s.lanes = s.lanes.filter(l => l.projectId !== 'hagenta'); return; }
  const tpl = s.lanes.find(l => l.projectId === 'hagenta')!;
  s.lanes = [...s.lanes.filter(l => l.projectId !== 'hagenta'), ...lanesFor(g).map(([name, state, o]): LaneView =>
    ({ ...tpl, name, state, cwd: `/Users/po/Works/Projects/hagenta-${name.toLowerCase()}`, branch: br(`lane/${name.toLowerCase()}`, o) }))];
}

const F_D15: GitFileChange[] = [{ path: 'engine/src/auth.ts', status: 'M', add: 9, del: 4 }, { path: 'engine/src/lanes.ts', status: 'M', add: 4, del: 1, conflict: true },
  { path: 'engine/src/legacy-keys.ts', status: 'D', add: 0, del: 1 }, { path: 'docs/specs/2026-11-16-auth-design.md', status: 'A', add: 5, del: 0 }];
const F_D2: GitFileChange[] = [{ path: 'engine/src/lot2/parser.ts', status: 'M', add: 30, del: 8 }, { path: 'engine/src/lot2/index.ts', status: 'M', add: 4, del: 4 },
  { path: 'engine/test/parser.test.ts', status: 'A', add: 28, del: 0 }, { path: 'fixtures/lot2.json', status: 'A', add: 2, del: 0 }];
const MANY_F = (): GitFileChange[] => Array.from({ length: 36 }, (_, i) => ({ path: `engine/src/${['api', 'api', 'db', 'web', 'queue', 'lib'][i % 6]}/${['handlers', 'routes', 'models', 'views', 'jobs', 'util'][i % 6]}-${String(i + 1).padStart(2, '0')}.ts`, status: i % 5 === 0 ? 'A' : 'M', add: 10, del: 2 }));

function log(g: GitScene, refs: string[]): GitCommit[] {
  if (g === 'G14') return [];
  const now = Date.now();
  const c = (h: string, p: string[], subject: string, ago: number, r: string[] = []): GitCommit => ({ hash: h.padEnd(40, '0'), parents: p.map(x => x.padEnd(40, '0')), subject, author: 'pm@', at: now - ago, refs: r });
  const main = [c('a41c09e', ['7be3f10'], 'Merge lane/b2 vào main · gate xanh', H, ['main']), c('7be3f10', ['6a1'], 'B2: sửa cookie thiết bị', 2 * H), c('6a1', ['5a1'], 'v2.2 G8 xong', 3 * H),
    c('5a1', ['4a1'], 'v2.2 G7: proxy MCP', 5 * H), c('4a1', ['3a1'], 'v2.2 G6: skills link', 6 * H), c('3a1', [], 'v2.2 G5: catalog skills', 7 * H)];
  const lane = refs.find(r => r.startsWith('lane/'));
  if (lane === 'lane/d15') return [c('d153', ['d152'], 'D15: verify rỗng trả false', 5 * MIN, ['lane/d15']), c('d152', ['d151'], 'D15: tách loadKeys', 20 * MIN), main[0]!,
    c('d151', ['7be3f10'], 'D15: bắt đầu từ main', H + MIN), ...main.slice(1)];
  if (lane === 'lane/d2') return [c('d22', ['d21'], 'D2: port parser lot-2', 12 * MIN, ['lane/d2']), c('d21', ['a41c09e'], 'D2: bắt đầu từ main', 40 * MIN), ...main];
  return main;
}

const LANES_TS_OLD = '/** Lane rảnh nhất, cũ nhất trước. */\n\nexport function pick(lanes: Lane[]) {\n  return lanes.sort(byAge)[0]\n}\n';
const LANES_TS_NEW = '/** Lane rảnh nhất, cũ nhất trước. */\n\nexport function pick(lanes: Lane[]) {\n  return lanes.filter(isReady).sort(byAge)[0]\n}\n';
const MERGED = '/** Lane rảnh nhất, cũ nhất trước. */\n\nexport function pick(lanes: Lane[]) {\n<<<<<<< main\n  return lanes.sort(byQuota)[0]\n=======\n  return lanes.filter(isReady).sort(byAge)[0]\n>>>>>>> lane/d15\n}\n';
const pad = (n: number, s: string) => Array.from({ length: n }, (_, i) => `// ${i + 1}`).join('\n') + '\n' + s;

const t = (text: string) => ({ kind: 'text' as const, text });

/** G3 a commit picked in the graph: that commit's own change (main moved `pick` to byQuota), never a conflict block. */
function commitDiff(path: string): GitDiffResult {
  if (path === 'engine/src/lanes.ts') return { old: t(pad(37, LANES_TS_OLD)), new: t(pad(37, LANES_TS_OLD.replace('byAge', 'byQuota'))) };
  return { old: t('export const a = 1\n'), new: t('export const a = 2\n') };
}

function diff(path: string, of: GitOf): GitDiffResult {
  if ('commit' in of) return commitDiff(path);
  if (path === 'engine/src/lanes.ts') return { old: t(pad(37, LANES_TS_OLD)), new: t(pad(37, LANES_TS_NEW)), conflict: { hunks: [{ start: 41, end: 45 }], lastBaseCommit: 'a41c09e'.padEnd(40, '0'), merged: t(pad(37, MERGED)) } };
  if (path === 'engine/src/lot2/parser.ts') return { old: t(pad(7, "export function parseLot(raw: string) {\n  return raw.split(',')\n}\n")), new: t(pad(7, "export function parseLot(raw: string) {\n  const rows = raw.split('\\n').filter(Boolean)\n  return rows.map(r => r.split(','))\n}\n")) };
  if (path === 'README.md') return { old: { kind: 'absent' }, new: t('# scratch\n\nThử nghiệm bản đồ lưới.\n') };
  if (path.endsWith('.md')) return { old: t(pad(13, '## 3. Giá\nGói 5x: 100 USD / tháng.\n')), new: t(pad(13, '## 3. Giá\nGói 5x: 100 USD / tháng (giá trước thuế).\n')) };
  return { old: t('export const a = 1\n'), new: t('export const a = 2\n') };
}

/** The scene's answer to a git_* / open_in_vscode command; null = not a Git command. */
export function gitReply(g: GitScene, s: Snapshot, c: Command): Reply | null {
  if (!c.cmd.startsWith('git_') || c.cmd === 'git_install' || c.cmd === 'git_identity_set') return null; // hf1116 (b) setup, not a Git read
  // §7 G7 (R17): git_branches carries the engine's marker, every other read fails with `git_not_repo`
  if (g === 'G7' && c.cmd === 'git_branches') return { ok: { base: null, lanes: [], notRepo: true } satisfies GitBranchesResult };
  if (g === 'G7' && c.cmd !== 'git_watch') return { code: 'git_not_repo', message: 'Thư mục project không phải repo git', key: 'errors.gitNotRepo' };
  switch (c.cmd) {
    case 'git_watch': return { ok: null };
    case 'git_branches': {
      const lanes = s.lanes.filter(l => l.projectId === c.projectId && l.branch).map(l => ({ lane: l.name, name: l.branch!.name!, branch: l.branch! }));
      const res: GitBranchesResult = g === 'G14' ? { base: { name: 'main', unpushed: null, dirty: 3 }, lanes: [] } : { base: { name: 'main', unpushed: 1, dirty: 1 }, lanes };
      return { ok: res };
    }
    case 'git_changes': {
      const of = c.of;
      if ('commit' in of) return { ok: { files: [{ path: 'engine/src/lanes.ts', status: 'M', add: 1, del: 1 }, { path: 'engine/src/server/cookie.ts', status: 'M', add: 3, del: 1 }, { path: 'engine/test/device.test.ts', status: 'A', add: 20, del: 0 }] } };
      if ('dirty' in of) return { ok: { files: of.dirty.kind === 'base' ? (g === 'G14' ? [{ path: 'README.md', status: '?' }, { path: 'index.html', status: '?' }, { path: 'src/main.ts', status: '?' }] : [{ path: 'docs/specs/2026-11-02-billing-quota-rollover-design.md', status: 'M' }]) : [{ path: 'engine/src/auth.test.ts', status: '?' }] } };
      const b = of.branch;
      return { ok: { files: b === 'lane/d15' ? (g === 'G16' ? [...F_D15, ...MANY_F()] : g === 'G6' ? F_D15.map(f => ({ ...f, conflict: false })) : F_D15) : b === 'lane/d2' ? F_D2 : b === 'lane/d18' ? [] : F_D2.slice(0, 2) } };
    }
    case 'git_diff': return { ok: diff(c.path, c.of) };
    case 'git_log': return { ok: { commits: log(g, c.refs), more: false } };
    default: return { ok: null };
  }
}
