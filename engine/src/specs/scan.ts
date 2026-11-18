// spec v2.7 §5.2-7 (D92): auto import of `<docs>/*.md` (v2.9 §8: every doc step's `docs`, `docs/specs` in Quy trình PO) — a
// new file's state is guessed once from its status line; a known row is only followed by path (moved to `<docs>/<docs_done>/`,
// renamed with the same `# ` title, gone). §4.8 the group summary of a spec.
// Pure over fs (R-B3): the caller passes the rows it knows and writes the result to the DB.
import { closeSync, lstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { SpecGuess, SpecRow } from '../../../shared/issues.ts';

const MIN_BYTES = 200;
const HEAD_BYTES = 64 * 1024;
const STATUS_LINES = 20;

export type KnownSpec = Pick<SpecRow, 'id' | 'path' | 'title'>;
type SpecImport = Pick<SpecRow, 'path' | 'title'> & SpecGuess & { step: string };
/** v2.9 one doc step's folder; a file found there is imported at that step. */
export interface ScanDir { docs: string; step: string }
interface SpecMove { id: number; from: string; to: string }
export interface SpecScan { imports: SpecImport[]; moves: SpecMove[]; missing: number[] }

/** The first `HEAD_BYTES` of a file (title + status line live at the top; a spec is never read whole for the scan). */
function head(abs: string): string {
  const fd = openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    return buf.toString('utf8', 0, readSync(fd, buf, 0, HEAD_BYTES, 0));
  } finally { closeSync(fd); }
}

const titleOf = (text: string, rel: string) =>
  text.split('\n').find((l) => l.startsWith('# '))?.slice(2).trim() || basename(rel, '.md');

/** `.md` files ≥ 200 bytes directly in `dir` (root-relative paths), sorted; a missing dir is empty. A symlink is skipped
 * (`lstat`): it may point out of the project. */
function mdFiles(root: string, dir: string): string[] {
  let names: string[];
  try { names = readdirSync(join(root, dir)); } catch { return []; }
  return names.filter((n) => n.endsWith('.md')).sort().map((n) => `${dir}/${n}`).filter((rel) => {
    try { const st = lstatSync(join(root, rel)); return st.isFile() && st.size >= MIN_BYTES; } catch { return false; }
  });
}

const DONE_WORDS = /\bdone\b|xong|hoàn thành/;
// "chờ implement" is an approved word, so a bare "implement" counts as building only when "chờ " does not precede it.
const BUILD_WORDS = /đang build|(?<!chờ )implement|in progress|đang làm/;
const APPROVED_WORDS = /approved|đã duyệt|chờ build|chờ implement/;

/** §5.2-7 the guess, in this order; `null` = done → not imported. */
function guessState(text: string): SpecGuess | null {
  const line = text.split('\n').slice(0, STATUS_LINES).find((l) => /trạng thái|status/i.test(l))?.toLowerCase() ?? '';
  if (DONE_WORDS.test(line)) return null;
  if (BUILD_WORDS.test(line)) return { state: 'approved', outsideBuild: true };
  if (APPROVED_WORDS.test(line)) return { state: 'approved', outsideBuild: false };
  return { state: 'draft', outsideBuild: false };
}

const exists = (root: string, rel: string) => { try { return statSync(join(root, rel)).isFile(); } catch { return false; } };

/** §5.2-7 one scan of every `<root>/<docs>` (first dir wins a file) against the rows the DB knows. */
export function scanSpecs(root: string, known: readonly KnownSpec[], dirs: readonly ScanDir[], doneName: string): SpecScan {
  const stepOf = new Map<string, string>();
  for (const d of dirs) for (const rel of mdFiles(root, d.docs)) if (!stepOf.has(rel)) stepOf.set(rel, d.step);
  const top = [...stepOf.keys()];
  const doneDir = (rel: string) => `${rel.slice(0, rel.lastIndexOf('/'))}/${doneName}`;
  const owned = new Set(known.map((k) => k.path));
  const titles = new Map<string, string>();
  const title = (rel: string) => { let t = titles.get(rel); if (t === undefined) { t = titleOf(head(join(root, rel)), rel); titles.set(rel, t); } return t; };
  const doneFiles = [...new Set(dirs.map((d) => `${d.docs}/${doneName}`))].flatMap((dir) => mdFiles(root, dir));
  const free = [...top, ...doneFiles].filter((rel) => !owned.has(rel));
  const out: SpecScan = { imports: [], moves: [], missing: [] };
  for (const k of known) {
    if (exists(root, k.path)) continue;
    const done = `${doneDir(k.path)}/${basename(k.path)}`;
    const to = free.includes(done) ? done : free.find((rel) => title(rel) === k.title);
    if (to === undefined) { out.missing.push(k.id); continue; }
    out.moves.push({ id: k.id, from: k.path, to });
    free.splice(free.indexOf(to), 1);
  }
  for (const rel of top) {
    if (!free.includes(rel)) continue;
    const text = head(join(root, rel));
    const guess = guessState(text);
    if (guess) out.imports.push({ path: rel, title: title(rel), ...guess, step: stepOf.get(rel)! });
  }
  return out;
}

const GROUP_HEADING = /^(#{1,6})\s+(?:[\d.]+\s*)?Nhóm việc\b/;

/** §4.8 "7 nhóm · G0–G6" from the `- **G<n>` lines of §"Nhóm việc"; null when there is none. */
export function groupSummary(text: string): string | null {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => GROUP_HEADING.test(l));
  if (at < 0) return null;
  const level = GROUP_HEADING.exec(lines[at]!)![1]!.length;
  const groups: string[] = [];
  for (const l of lines.slice(at + 1)) {
    const h = /^(#{1,6})\s/.exec(l);
    if (h && h[1]!.length <= level) break;
    const g = /^- \*\*(G\d+)/.exec(l);
    if (g) groups.push(g[1]!);
  }
  if (groups.length === 0) return null;
  const range = groups.length === 1 ? groups[0]! : `${groups[0]!}–${groups[groups.length - 1]!}`;
  return `${groups.length} nhóm · ${range}`;
}
