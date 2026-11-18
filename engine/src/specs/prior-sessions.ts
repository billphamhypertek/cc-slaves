// spec v2.7 §5.2-10 / §4.9 IS17: the Claude sessions of the last 14 days (project root + its worktrees) whose user messages
// name the spec file — candidates for "Nhận phiên cũ". Read-only over the shared `<claudeHome>/projects` (v2 §5.2): files are
// streamed line by line (a session can be many MB) and never written. Pure (R-B3): `now` and `ps` are injected.
import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { encodeCwd } from '../orchestrator/resume.ts';
import type { PriorSession } from '../../../shared/issues.ts';

const WINDOW_MS = 14 * 86_400_000;
const MAX = 5;
const RECENT_MS = 120_000;
/** §16 a session longer than this resumes with an expensive, compacted context: IS17 defaults to "Build mới". */
const LONG_TURNS = 400;
const FIRST_TEXT_MAX = 160;

export interface PriorSessionQuery {
  claudeHome: string;
  projectRoot: string;
  worktrees: readonly string[];
  /** project-relative or absolute; matched by its file name. */
  specFile: string;
  now: number;
  /** command lines of the running processes (`ps -axo args`); a failure only drops that half of the check. */
  ps: () => Promise<readonly string[]>;
  /** R-B6 the Claude config dirs (`CLAUDE_HOME` + each account dir) whose `sessions/<pid>.json` name a live session. */
  configDirs: readonly string[];
  /** R-B6 is this pid alive (e.g. `process.kill(pid, 0)`). */
  alive: (pid: number) => boolean;
  /** R-B8 session ids cc-slaves already owns: dropped before the cap of 5. */
  exclude: ReadonlySet<string>;
}

interface Line { type?: unknown; cwd?: unknown; isSidechain?: unknown; isMeta?: unknown; effort?: unknown; message?: { content?: unknown; model?: unknown } }

/** The human text of a `user` line; null for tool results, sidechains and meta lines. */
function userText(j: Line): string | null {
  if (j.type !== 'user' || j.isSidechain === true || j.isMeta === true) return null;
  const c = j.message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return null;
  const parts = (c as { type?: unknown; text?: unknown }[]).filter((p) => p.type === 'text' && typeof p.text === 'string').map((p) => p.text as string);
  return parts.length > 0 ? parts.join('\n') : null;
}

const oneLine = (s: string) => {
  const l = s.trim().split('\n')[0]!.trim();
  return l.length > FIRST_TEXT_MAX ? `${l.slice(0, FIRST_TEXT_MAX - 1)}…` : l;
};

/** One streamed pass: null when no user message names `name`, or the file cannot be read (vanished, no permission). */
type SessionText = { firstText: string; turns: number; cwd: string | null; model: string | null; effort: string | null };
async function readSession(file: string, name: string): Promise<SessionText | null> {
  try { return await scanSession(file, name); } catch { return null; }
}

async function scanSession(file: string, name: string): Promise<SessionText | null> {
  let firstText: string | null = null, turns = 0, cwd: string | null = null, named = false, model: string | null = null, effort: string | null = null;
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const raw of rl) {
    const asst = raw.includes('"assistant"');
    if (!asst && !raw.includes('"user"')) continue;
    let j: Line;
    try { j = JSON.parse(raw) as Line; } catch { continue; }
    if (asst && j.type === 'assistant' && j.isSidechain !== true) { // v2.7.1 SA6b the session's latest model / effort
      const m = j.message?.model;
      if (typeof m === 'string' && m !== '<synthetic>') model = m;
      if (typeof j.effort === 'string') effort = j.effort;
      continue;
    }
    if (cwd === null && j.type === 'user' && typeof j.cwd === 'string') cwd = j.cwd;
    const text = userText(j);
    if (text === null) continue;
    turns++;
    firstText ??= oneLine(text);
    named ||= text.includes(name);
  }
  return named ? { firstText: firstText ?? '', turns, cwd, model, effort } : null;
}

/** `<claudeHome>/projects/<slug>*` of the root and each worktree → `*.jsonl` changed in the window, newest first. */
function candidates(q: PriorSessionQuery): { file: string; id: string; mtime: number }[] {
  const projects = join(q.claudeHome, 'projects');
  const slugs = [q.projectRoot, ...q.worktrees].map(encodeCwd);
  let dirs: string[];
  try { dirs = readdirSync(projects).filter((d) => slugs.some((s) => d.startsWith(s))); } catch { return []; }
  const out: { file: string; id: string; mtime: number }[] = [];
  for (const d of dirs) {
    let names: string[];
    try { names = readdirSync(join(projects, d)).filter((n) => n.endsWith('.jsonl')); } catch { continue; }
    for (const n of names) {
      const file = join(projects, d, n);
      try {
        const st = statSync(file);
        if (st.isFile() && q.now - st.mtimeMs <= WINDOW_MS) out.push({ file, id: basename(n, '.jsonl'), mtime: st.mtimeMs });
      } catch { /* vanished between readdir and stat */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** R-B6 the session ids of `<configDir>/sessions/<pid>.json` files whose pid is alive (Claude Code removes the file at exit). */
function liveSessionIds(q: PriorSessionQuery): Set<string> {
  const ids = new Set<string>();
  for (const dir of q.configDirs) {
    let names: string[];
    try { names = readdirSync(join(dir, 'sessions')).filter((n) => n.endsWith('.json')); } catch { continue; }
    for (const n of names) {
      try {
        const j = JSON.parse(readFileSync(join(dir, 'sessions', n), 'utf8')) as { pid?: unknown; sessionId?: unknown };
        if (typeof j.pid === 'number' && typeof j.sessionId === 'string' && q.alive(j.pid)) ids.add(j.sessionId);
      } catch { /* broken or vanished file: not a live session */ }
    }
  }
  return ids;
}

/**
 * §5.2-10 at most 5 candidates, newest first; R-B6 running elsewhere = a live `sessions/<pid>.json` naming the id, or a
 * `claude` process whose args carry the id, or the transcript written < 120 s ago.
 */
export async function findPriorSessions(q: PriorSessionQuery): Promise<PriorSession[]> {
  const name = basename(q.specFile);
  const found: PriorSession[] = [];
  let procs: readonly string[] | null = null;
  let live: Set<string> | null = null;
  for (const c of candidates(q).filter((x) => !q.exclude.has(x.id))) {
    if (found.length >= MAX) break;
    const s = await readSession(c.file, name);
    if (s === null) continue;
    procs ??= await q.ps().catch(() => []);
    live ??= liveSessionIds(q);
    const byProc = live.has(c.id) || procs.some((p) => p.includes('claude') && p.includes(c.id));
    found.push({ id: c.id, ...s, lastAt: c.mtime, runningElsewhere: byProc || q.now - c.mtime < RECENT_MS, long: s.turns > LONG_TURNS });
  }
  return found;
}
