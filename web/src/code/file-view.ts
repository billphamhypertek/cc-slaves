// spec v2.3 §5.2 what the viewer shows for one `fs_read` reply: the syntax language by extension (ts … sql; any other →
// plain text), the Markdown "Đọc" | "Nguồn" switch, the "Ngắt dòng" default, why "Sửa" is off (V20 encoding, large,
// binary) and the large-file numbers. Pure; the components render it.
import type { FsReadResult } from '../../../shared/protocol.ts';

/** §5.2 the highlighted extensions (lazy language chunks, `lang.ts`) */
export type LangId = 'js' | 'ts' | 'jsx' | 'tsx' | 'json' | 'md' | 'css' | 'html' | 'py' | 'rs' | 'go' | 'yaml' | 'toml' | 'sh' | 'sql';
const EXT: Readonly<Record<string, LangId>> = {
  ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx', js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx', json: 'json', md: 'md', mdx: 'md',
  css: 'css', html: 'html', htm: 'html', py: 'py', rs: 'rs', go: 'go', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  sh: 'sh', bash: 'sh', zsh: 'sh', sql: 'sql',
};
const extOf = (path: string): string => {
  const base = path.slice(path.lastIndexOf('/') + 1), dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
};
export const langOf = (path: string): LangId | null => EXT[extOf(path)] ?? null;
/** §5.2 `.md` / `.mdx` get the "Đọc" | "Nguồn" switch */
export const isMd = (path: string): boolean => /^mdx?$/.test(extOf(path));
/** §5.2 "Ngắt dòng": off for code, on for Markdown source */
export const wrapFor = (path: string): boolean => isMd(path);

/** the tree / tab icon of a file */
export function fileIcon(path: string): 'file' | 'fileCode' | 'image' | 'binary' {
  const e = extOf(path);
  if (e === 'md' || e === 'mdx' || e === 'txt') return 'file';
  if (/^(png|jpe?g|gif|webp|svg|ico|icns)$/.test(e)) return e === 'icns' || e === 'ico' ? 'binary' : 'image';
  return 'fileCode';
}

/** §5.2 / §7 C20 why "Sửa" is off for this reply (catalog key under `code.ro.*`), null = no file-side reason */
export type RoReason = 'notUtf8' | 'mixedEol' | 'binary' | 'large' | 'image';
export function roReason(r: FsReadResult): RoReason | null {
  if (r.kind === 'binary') return 'binary';
  if (r.kind === 'large') return 'large';
  if (r.kind === 'image') return 'image';
  if (r.readOnly === 'not_utf8') return 'notUtf8';
  if (r.readOnly === 'mixed_eol') return 'mixedEol';
  return null;
}

/** §5.2 "Lớn": the shown head is 2 MB; the bytes left out (0 when the file is large for its long lines only) */
const LARGE_HEAD = 2 * 1024 * 1024;
export const largeRest = (r: Pick<FsReadResult, 'size'>): number => Math.max(0, r.size - LARGE_HEAD);
