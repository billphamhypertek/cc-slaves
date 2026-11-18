// spec v2.9 §5.1 a workflow pack on disk / on the wire = a map `path → text` (WORKFLOW.md, steps/<id>.md, .layout.json).
// Here: read a folder (lstat, never a symlink, §10.3), split each md into frontmatter + body, parse the YAML (`Bun.YAML`;
// it has no error position and keeps the last of a duplicate key, G0 1b / 1c → prefix scan + a line scan), hash the rev.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DONE_ID, LIMITS, STEP_ID_RE } from './vocab.ts';

export type PackFiles = Record<string, string>;
/** `V1`–`V15` errors (§5.4), `W` a warning. */
type IssueCode = `V${number}` | 'W';
/** One validation finding, a Vietnamese sentence tied to a file / step (and a line when known). */
export interface PackIssue { code: IssueCode; msg: string; file?: string; step?: string; line?: number }
export interface PackDoc { file: string; fm: Record<string, unknown>; body: string; yamlLine: number }
export interface PackStep extends PackDoc { id: string }
export interface Pack { workflow: PackDoc | null; steps: PackStep[] }

const WORKFLOW_FILE = 'WORKFLOW.md';
const LAYOUT_FILE = '.layout.json';
const STEP_FILE = /^steps\/([^/]+)\.md$/;

const isRevFile = (p: string) => p === WORKFLOW_FILE || STEP_FILE.test(p);

/** §6.1 rev = sha256 over WORKFLOW.md + steps/*.md sorted by path (`.layout.json` and strays not counted). */
export function packRev(files: PackFiles): string {
  const h = createHash('sha256');
  for (const p of Object.keys(files).filter(isRevFile).sort()) h.update(`${p}\0${files[p]}\0`);
  return h.digest('hex');
}

/** §5.1 the YAML between the opening `---` line and the next `---` line; the body without its blank edge lines. A file
 * with no opening `---` is all body; `null` = an opening `---` that never closes. */
export function splitFrontmatter(text: string): { yaml: string; yamlLine: number; body: string } | null {
  const trim = (s: string) => s.replace(/^(?:[ \t]*\n)+/, '').trimEnd();
  if (!/^---[ \t]*\n/.test(text)) return { yaml: '', yamlLine: 1, body: trim(text) };
  const lines = text.split('\n');
  const close = lines.findIndex((l, i) => i > 0 && /^---[ \t]*$/.test(l));
  if (close < 0) return null;
  return { yaml: lines.slice(1, close).join('\n'), yamlLine: 2, body: trim(lines.slice(close + 1).join('\n')) };
}

/** G0 1b: after a failed full parse, the first line prefix that fails is the line (1-based within `yaml`). */
function errorLine(yaml: string): number {
  const lines = yaml.split('\n');
  for (let i = 1; i <= lines.length; i++) {
    try { Bun.YAML.parse(lines.slice(0, i).join('\n')); } catch { return i; }
  }
  return lines.length;
}

const KEY_LINE = /^( *)([A-Za-z0-9_-]+)[ \t]*:(?:[ \t]|$)/;

/** G0 1c a key repeated at the top level or one level down inside the same block parent (1-based lines within `yaml`). */
function duplicateKeys(yaml: string): { key: string; line: number }[] {
  const out: { key: string; line: number }[] = [];
  const top = new Set<string>();
  let child = new Set<string>();
  let childIndent: number | null = null;
  yaml.split('\n').forEach((l, i) => {
    const m = KEY_LINE.exec(l);
    if (!m) return;
    const indent = m[1]!.length;
    const key = m[2]!;
    if (indent === 0) {
      if (top.has(key)) out.push({ key, line: i + 1 });
      top.add(key);
      child = new Set();
      childIndent = null;
      return;
    }
    childIndent ??= indent;
    if (indent !== childIndent) return;
    if (child.has(key)) out.push({ key, line: i + 1 });
    child.add(key);
  });
  return out;
}

/** One md file → frontmatter table + body, or its V1 findings. */
function parseDoc(file: string, text: string, step: string | undefined, errors: PackIssue[]): PackDoc | null {
  const at = step === undefined ? { file } : { file, step };
  const s = splitFrontmatter(text);
  if (!s) { errors.push({ code: 'V1', ...at, msg: 'Frontmatter thiếu dòng `---` đóng' }); return null; }
  let fm: unknown;
  try { fm = s.yaml.trim() === '' ? {} : Bun.YAML.parse(s.yaml); } catch {
    const line = s.yamlLine + errorLine(s.yaml) - 1;
    errors.push({ code: 'V1', ...at, line, msg: `YAML hỏng ở dòng ${line}` });
    return null;
  }
  const dups = duplicateKeys(s.yaml);
  for (const d of dups) {
    const line = s.yamlLine + d.line - 1;
    errors.push({ code: 'V1', ...at, line, msg: `khoá \`${d.key}\` lặp ở dòng ${line}` });
  }
  if (fm === null || fm === undefined) fm = {};
  if (typeof fm !== 'object' || Array.isArray(fm)) {
    errors.push({ code: 'V1', ...at, msg: 'Frontmatter phải là bảng khoá (`khoá: giá trị`)' });
    return null;
  }
  return dups.length ? null : { file, fm: fm as Record<string, unknown>, body: s.body, yamlLine: s.yamlLine };
}

/** §5.1 / §5.4 V1 V2 V3 V11: the files map → WORKFLOW.md + steps (sorted by id), plus the findings of this layer. */
export function parsePack(files: PackFiles): { pack: Pack; errors: PackIssue[] } {
  const errors: PackIssue[] = [];
  const steps: PackStep[] = [];
  for (const path of Object.keys(files).sort()) {
    if (path === WORKFLOW_FILE || path === LAYOUT_FILE) continue;
    const m = STEP_FILE.exec(path);
    if (!m) { errors.push({ code: 'V11', file: path, msg: `File \`${path}\` không thuộc gói (chỉ WORKFLOW.md, steps/<id>.md, .layout.json)` }); continue; }
    const id = m[1]!;
    if (id === DONE_ID) { errors.push({ code: 'V3', file: path, msg: '`done` là tên dành cho Xong: đặt tên bước khác' }); continue; }
    if (!STEP_ID_RE.test(id)) {
      errors.push({ code: 'V3', file: path, msg: `Tên bước \`${id}\` sai dạng: chỉ a-z, 0-9, dấu - (tối đa 24 ký tự)` });
      continue;
    }
    const doc = parseDoc(path, files[path]!, id, errors);
    if (!doc) continue;
    if (doc.fm.id !== undefined && doc.fm.id !== id) errors.push({ code: 'V3', file: path, step: id, msg: `\`id\` ${typeof doc.fm.id === 'string' ? doc.fm.id : JSON.stringify(doc.fm.id)} không khớp tên file ${id}` });
    steps.push({ ...doc, id });
  }
  const wf = files[WORKFLOW_FILE];
  if (wf === undefined) errors.unshift({ code: 'V2', file: WORKFLOW_FILE, msg: 'Thiếu file WORKFLOW.md' });
  return { pack: { workflow: wf === undefined ? null : parseDoc(WORKFLOW_FILE, wf, undefined, errors), steps }, errors };
}

/** §5.1 / §10.3 read a pack folder: lstat only (a symlink is a V11 finding, never read), dot entries skipped except
 * `.layout.json`, a stray file listed by name with no content (parsePack reports it), a stray folder reported here. The
 * §5.1 files are read up to 256 KB in total: the file that passes it is one V11 and reading stops (a wrong pick never
 * ships a whole folder). CRLF and a leading BOM are normalised, so the frontmatter split and the key patch see `\n`. */
export function readPackDir(dir: string): { files: PackFiles; errors: PackIssue[] } {
  const files: PackFiles = {};
  const errors: PackIssue[] = [];
  let total = 0;
  const walk = (rel: string, depth: number): boolean => {
    let names: string[];
    try { names = readdirSync(join(dir, rel)).sort(); } catch { return true; }
    for (const name of names) {
      if (name.startsWith('.') && !(depth === 0 && name === LAYOUT_FILE)) continue;
      const path = rel === '' ? name : `${rel}/${name}`;
      const st = lstatSync(join(dir, path));
      if (st.isSymbolicLink()) { errors.push({ code: 'V11', file: path, msg: `\`${path}\` là symlink: gói không nhận symlink` }); continue; }
      if (st.isDirectory()) {
        if (depth === 0 && name === 'steps') { if (!walk(path, 1)) return false; } else errors.push({ code: 'V11', file: path, msg: `Thư mục \`${path}\` không thuộc gói (chỉ steps/)` });
        continue;
      }
      if (!st.isFile()) continue;
      if (!(isRevFile(path) || path === LAYOUT_FILE)) { files[path] = ''; continue; }
      total += st.size;
      if (total > LIMITS.totalBytes) { errors.push({ code: 'V11', file: path, msg: `Gói quá ${LIMITS.totalBytes / 1024} KB` }); return false; }
      files[path] = readFileSync(join(dir, path), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    }
    return true;
  };
  walk('', 0);
  return { files, errors };
}
