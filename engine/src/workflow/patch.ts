// spec v2.9 §10.2 / §15 A6 write one frontmatter key back into a hand-written md file: only that key's line (or block) is
// replaced; key order, every other line, comments and the body stay byte-identical. A key written in a YAML form this file
// does not read for sure (block scalar, anchor / alias, tag, multi-line flow or plain scalar, a comment inside the block or
// on one of its items)
// is read-only: the canvas shows it but cannot change it (§4.3).
import { splitFrontmatter } from './pack.ts';

export type PatchResult = { ok: true; text: string } | { ok: false; reason: string };

const KEY = /^([A-Za-z0-9_-]+)[ \t]*:(.*)$/;
const RESERVED = /^(?:true|false|null|yes|no|on|off|y|n|~|\.inf|-\.inf|\.nan)$/i;

/** `[value, comment]` of one line: the comment starts at a ` #` outside quotes (the whitespace before it stays in value). */
function splitComment(s: string): [string, string] {
  let q: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === '"' && c === '\\') { i++; continue; }
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t')) return [s.slice(0, i), s.slice(i)];
  }
  return [s, ''];
}

/** One line of YAML this file can replace: quotes closed, brackets balanced, no anchor / alias / tag / block scalar. */
function simpleLine(v: string): boolean {
  let q: '"' | "'" | null = null;
  let depth = 0;
  let bare = '';
  for (let i = 0; i < v.length; i++) {
    const c = v[i]!;
    if (q === '"' && c === '\\') { i++; continue; }
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    bare += c;
  }
  if (q || depth !== 0) return false;
  return !/^\s*[|>]/.test(bare) && !/(^|[\s[{,])[&*!]/.test(bare);
}

interface Block { key: string; start: number; end: number; value: string; comment: string; cont: string[]; readOnly: boolean }

/** The top-level keys of the YAML lines, each with its line span (trailing blank / comment lines belong to the next key). */
function blocks(yaml: readonly string[]): Block[] {
  const starts = yaml.flatMap((l, i) => (KEY.test(l) ? [i] : []));
  return starts.map((start, n) => {
    const stop = starts[n + 1] ?? yaml.length;
    let end = start + 1;
    for (let i = start + 1; i < stop; i++) if (yaml[i]!.trim() !== '' && !yaml[i]!.trim().startsWith('#')) end = i + 1;
    const m = KEY.exec(yaml[start]!)!;
    const [value, comment] = splitComment(m[2]!);
    const cont = yaml.slice(start + 1, end);
    return { key: m[1]!, start, end, value, comment, cont, readOnly: !recognised(value, cont) };
  });
}

function recognised(value: string, cont: readonly string[]): boolean {
  if (cont.length === 0) return simpleLine(value);
  if (value.trim() !== '') return false;
  const indent = /^ */.exec(cont[0]!)![0].length;
  const list = cont[0]!.slice(indent).startsWith('- ');
  return cont.every((l) => {
    if (/^ */.exec(l)![0].length !== indent) return false;
    const body = l.slice(indent);
    const one = (v: string) => { const [x, c] = splitComment(v); return c === '' && simpleLine(x); };
    if (list) return body.startsWith('- ') && one(body.slice(2));
    const m = KEY.exec(body);
    return m !== null && m[2]!.trim() !== '' && one(m[2]!);
  });
}

const plainOk = (s: string) => s !== '' && s === s.trim() && !RESERVED.test(s) && !/^[-+.]?\d/.test(s)
  && !/[,[\]{}#]|: |:$|^[-?:!&*|>'"%@`]/.test(s);

/** A value in YAML flow style (strings plain when YAML reads them back unchanged, else JSON-quoted). */
function flow(v: unknown): string {
  if (typeof v === 'string') return plainOk(v) ? v : JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(flow).join(', ')}]`;
  const e = Object.entries(v as Record<string, unknown>);
  return e.length ? `{ ${e.map(([k, x]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)}: ${flow(x)}`).join(', ')} }` : '{}';
}

function render(key: string, value: unknown, old: Block | undefined): string[] {
  const isList = Array.isArray(value);
  const isMap = typeof value === 'object' && value !== null && !isList;
  const entries = isList ? value : isMap ? Object.entries(value) : [];
  const block = entries.length > 0 && (old ? old.cont.length > 0 : isList && value.some((x) => typeof x === 'object' && x !== null));
  if (!block) {
    const lead = old ? (/^\s*/.exec(old.value)![0] || ' ') : ' ';
    const trail = old && old.comment ? /\s*$/.exec(old.value)![0] : '';
    return [`${key}:${lead}${flow(value)}${trail}${old?.comment ?? ''}`];
  }
  const pad = ' '.repeat(old ? /^ */.exec(old.cont[0]!)![0].length : 2);
  const head = `${key}:${old?.comment ? ` ${old.comment}` : ''}`;
  if (isList) return [head, ...(value as unknown[]).map((x) => `${pad}- ${flow(x)}`)];
  return [head, ...Object.entries(value as Record<string, unknown>).map(([k, x]) => `${pad}${k}: ${flow(x)}`)];
}

function parse(yaml: string): Record<string, unknown> | null {
  try { return (Bun.YAML.parse(yaml) as Record<string, unknown> | null) ?? {}; } catch { return null; }
}

/** The top-level keys of a md file's frontmatter that `patchFrontmatter` refuses to rewrite. */
export function readOnlyKeys(text: string): string[] {
  const s = splitFrontmatter(text);
  return s ? blocks(s.yaml.split('\n')).filter((b) => b.readOnly).map((b) => b.key) : [];
}

/** Set (`undefined` = delete) one top-level frontmatter key; verified by parsing the result back. */
export function patchFrontmatter(text: string, key: string, value: unknown): PatchResult {
  const s = splitFrontmatter(text);
  if (!s) return { ok: false, reason: 'Frontmatter thiếu dòng `---` đóng' };
  const had = /^---[ \t]*\n/.test(text);
  const yaml = had ? s.yaml.split('\n') : [];
  const before = had ? parse(s.yaml) : {};
  if (before === null) return { ok: false, reason: 'YAML của file đang hỏng: sửa trong file' };
  const old = blocks(yaml).find((b) => b.key === key);
  if (old?.readOnly) return { ok: false, reason: `Khoá \`${key}\` viết kiểu không sửa được trên canvas: sửa trong file` };
  const lines = value === undefined ? [] : render(key, value, old);
  const next = old ? [...yaml.slice(0, old.start), ...lines, ...yaml.slice(old.end)] : [...yaml.filter((l, i) => l !== '' || i < yaml.length - 1), ...lines];
  const after = parse(next.join('\n'));
  const want: Record<string, unknown> = { ...before };
  if (value === undefined) delete want[key]; else want[key] = value;
  if (after === null || !Bun.deepEquals(after, want)) return { ok: false, reason: `Không ghi được khoá \`${key}\` an toàn: sửa trong file` };
  if (!had) return { ok: true, text: `---\n${next.join('\n')}\n---\n${text}` };
  const all = text.split('\n');
  return { ok: true, text: [all[0]!, ...next, ...all.slice(1 + yaml.length)].join('\n') };
}

/** Write a md file's body verbatim, keeping its frontmatter bytes. */
export function patchBody(text: string, body: string): string {
  if (!/^---[ \t]*\n/.test(text) || !splitFrontmatter(text)) return `${body}\n`;
  const all = text.split('\n');
  const close = all.findIndex((l, i) => i > 0 && /^---[ \t]*$/.test(l));
  return `${all.slice(0, close + 1).join('\n')}\n${body}\n`;
}
