// v2.7 G4b dev answers of the Mac-only Tasks commands (mockup docs/specs/assets/2026-11-16-cc-slaves-v2.7-tasks.html): Tài liệu
// rows (IS14 IS15 IS18 IS20 IS22 IS22b), the IS17 prior sessions, the IS4a/b/c cancel previews, and the session a spec_* command
// opens (`openSession`; the web goes to Deck on it). `undefined` = not one of these commands.
import type { IssueCancelPreview, IssueFileData, OrchKind, PriorSession, SpecInfo, SpecOutput } from '../../shared/issues.ts';
import type { Command, OrchestratorView, Snapshot } from '../../shared/protocol.ts';

const M = 60_000;
const slug = (path: string) => (/\d{4}-\d{2}-\d{2}-(.+?)(?:-design)?\.md$/.exec(path)?.[1] ?? 'spec');
const row = (o: Partial<SpecOutput> & Pick<SpecOutput, 'role' | 'kind' | 'ref'>): SpecOutput =>
  ({ label: null, display: o.ref, addedBy: 'auto', state: 'ok', ...o });

/** §4.10 the rows of one spec (IS20 adds the missing "Đo G0" and the stopped prototype). */
function outputs(path: string, f: string): SpecOutput[] {
  const s = slug(path), v = s.split('-')[0];
  const cut = (p: string) => `…-${p.split('-').slice(1).join('-')}`;
  if (f === 'IS18' && path.includes('-v2.9')) return [row({ role: 'spec', kind: 'md', ref: path, display: cut(path), state: 'missing' }), row({ role: 'mockup', kind: 'html', ref: `docs/specs/assets/${s}.html`, display: cut(`x-${s}.html`) })];
  const rows = [
    row({ role: 'spec', kind: 'md', ref: path, display: cut(path.split('/').pop()!) }),
    row({ role: 'mockup', kind: 'html', ref: `docs/specs/assets/${s}.html`, display: cut(`x-${s}.html`) }),
    row({ role: 'images', kind: 'image', ref: `docs/specs/assets/screens/${v}/IS1.png`, display: `docs/specs/assets/screens/${v}/`, count: 14 }),
    row({ role: 'doc', kind: 'md', ref: `docs/ref/${s}-research.md`, label: 'Nghiên cứu', addedBy: 'session' }),
  ];
  if (f === 'IS20' || f === 'IS22') {
    if (f === 'IS20') rows.push(row({ role: 'doc', kind: 'md', ref: `docs/ref/${v}-g0-measure.md`, label: 'Đo G0', addedBy: 'session', state: 'missing' }));
    rows.push(row({ role: 'link', kind: 'link', ref: 'http://localhost:5173/?token=d3v', display: 'localhost:5173/?token=…', label: 'Prototype', addedBy: 'session', state: f === 'IS20' ? 'off' : 'ok' }));
  }
  return rows;
}

const PRIOR: PriorSession[] = [
  { id: 'p-1', firstText: 'implement spec docs/specs/2026-11-14-hagenta-v2.5-toolkit-graph-design.md', lastAt: Date.now() - 5 * 60 * M, turns: 212, cwd: null, runningElsewhere: false, long: false, model: 'claude-opus-4-8', effort: 'high' },
  { id: 'p-2', firstText: 'làm tiếp G3 của spec v2.5 toolkit graph, đọc HANDOFF trước', lastAt: Date.now() - 4.9 * 60 * M, turns: 48, cwd: '/Users/po/Works/Projects/hagenta-v25', runningElsewhere: true, long: false, model: null, effort: null },
  { id: 'p-3', firstText: 'review nhóm G1–G2 theo docs/specs/2026-11-14-hagenta-v2.5-toolkit-graph-design.md', lastAt: Date.now() - 16 * 60 * M, turns: 96, cwd: '/Users/po/Works/Projects/hagenta-v25', runningElsewhere: false, long: false, model: null, effort: null },
];

const none = { open: [], done: [] };
const PREVIEW: Record<string, IssueCancelPreview> = {
  'T-44': { key: 'T-44', mode: 'cancel', lane: null, revert: null, dependants: { open: ['T-49'], done: [] } },
  'B-52': { key: 'B-52', mode: 'stop', lane: { name: 'F1', branch: 'fix-b52', commits: 2 }, revert: null, dependants: none },
  'T-46': { key: 'T-46', mode: 'revert', lane: null, revert: { branch: 'main', shas: ['9c1e2fa', '41b7d03', 'd88a6e1'], key: 'T-54' }, dependants: { open: ['T-49'], done: ['T-53'] } },
  'T-53': { key: 'T-53', mode: 'revert', lane: null, revert: { branch: 'main', shas: ['5d0e7a1', 'b21c9f4'], key: 'T-55' }, dependants: none },
};

/** B-51's `tab-giat.png` (IS7): a drawn stand-in for the PO's screenshot. */
const SHOT: IssueFileData = { name: 'tab-giat.png', size: 184_220, dataUrl: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="224"><rect width="400" height="224" fill="#1d2126"/><rect x="16" y="16" width="120" height="22" rx="4" fill="#2c323a"/><rect x="144" y="16" width="120" height="22" rx="4" fill="#3a424c"/></svg>')}` };

export function issuesAnswer(c: Command, s: Snapshot, f: string): unknown {
  switch (c.cmd) {
    case 'spec_outputs': return outputs(c.path, f);
    case 'spec_prior_sessions': return PRIOR;
    case 'issue_cancel_preview': return PREVIEW[c.key] ?? { key: c.key, mode: 'cancel', lane: null, revert: null, dependants: none };
    case 'issue_cancel': { const p = PREVIEW[c.key]; return { key: c.key, mode: p?.mode ?? 'cancel', revertKey: p?.revert?.key ?? null }; }
    case 'issue_file': return SHOT;
    default: return undefined;
  }
}

/** §4.7 UX-I11 / N6 the session `spec_new` / `spec_build` / `spec_edit` opens, like the engine's `openKind`: next #n, a
 *  Thiết kế one "Thiết kế · HH:MM" (VN time), a Build one "Build · <spec>", nothing said yet; the spec at `path` binds it (build
 *  → `sessions.build`, a draft's design → `sessions.design`, else `sessions.edit` + "đang sửa"). Returns the session and the
 *  bound spec (the mock sends both events); the web selects the session on the Deck. */
export function openSession(s: Snapshot, projectId: string, kind: Exclude<OrchKind, 'general'>, path?: string, now = Date.now()): { o: OrchestratorView; spec: SpecInfo | null } {
  const base = s.orchestrators.find(o => o.projectId === projectId) ?? s.orchestrators[0]!;
  const seq = Math.max(0, ...s.orchestrators.filter(o => o.projectId === projectId).map(o => o.seq ?? 1)) + 1;
  const pi = s.issues?.find(p => p.projectId === projectId);
  const found = path ? pi?.specs.find(x => x.path === path) : undefined;
  const sid = `s-${kind}-${seq}`;
  const hm = new Date(now + 7 * 3_600_000).toISOString().slice(11, 16);
  const o: OrchestratorView = { ...base, projectId, sessionId: sid, seq, orchKind: kind, title: kind === 'build' ? `Build · ${found?.title ?? ''}` : `Thiết kế · ${hm}`,
    state: 'idle', talkingTo: null, costUsd: 0, contextPct: 2, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  s.orchestrators.push(o);
  if (!found || !pi) return { o, spec: null };
  const sessions = kind === 'build' ? { ...found.sessions, build: sid } : found.state === 'draft' ? { ...found.sessions, design: sid } : { ...found.sessions, edit: sid };
  const spec: SpecInfo = { ...found, sessions, editing: sessions.edit !== null };
  pi.specs = pi.specs.map(x => (x.id === spec.id ? spec : x));
  return { o, spec };
}
