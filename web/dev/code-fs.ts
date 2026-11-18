// Dev mock of the v2.3 §10.2 Code reads (fs_list / fs_find / fs_read) over a small fixed tree shaped like the mockup's
// (C1–C24): the hagenta project folder and each lane worktree get the same files; ignored entries for C24; a not-UTF-8
// CSV (C20), a 3.4 MB lock file (C10), an svg / png (C9), an icns (C21), one unreadable file (C14) and one that changes
// on every read (C15). `fs_write` (§5.3) keeps saved text in memory: the live file conflicts on its first save (C7), `legacy-keys.ts`
// is gone on disk until "Tạo lại" (C22).
import type { FsEntry, FsFindReq, FsListReq, FsReadReq, FsReadResult, FsWriteReq, FsWriteResult } from '../../shared/protocol.ts';

export type FsCmd = FsListReq | FsFindReq | FsReadReq | FsWriteReq;
type Node = { k: 'f'; text?: string; size?: number; ign?: boolean; live?: boolean; gone?: boolean; res?: Partial<FsReadResult>; err?: string } | { k: 'd'; ign?: boolean; kids: Record<string, Node> };

const AUTH = `import { jwt } from './jwt'
import { readKeys, type Key } from './keys'

/** Token rỗng hay sai chữ ký đều trả flase. */
export function verify(tok: string): boolean {
  if (!tok) return false
  return jwt.check(tok, KEYS)
}

export const KEYS = loadKeys(process.env.KEY_DIR)

function loadKeys(dir?: string): Key[] {
  if (!dir) throw new Error('KEY_DIR missing')
  return readKeys(dir)
}

export function rotate(keys: Key[]): Key[] {
  return keys.filter(k => !k.expired)
}
`;
const SPEC = `# Auth: token rỗng và khoá xoay vòng

Spec · lane D15 · 2026-11-16

## 1. Vì sao làm

Hôm nay \`verify('')\` ném lỗi thay vì trả \`false\`, nên route \`/remote\` trả 500 khi cookie trống. Spec này tách \`verify\` và đọc khoá từ \`KEY_DIR\`.

## 2. Mục tiêu

- Token rỗng hay sai chữ ký → \`false\`, không ném lỗi.
- Thiếu \`KEY_DIR\` → engine dừng lúc khởi động, báo rõ lý do.
- Xoay khoá không phải khởi động lại.

## 3. Câu hỏi cho PO

> Giữ API cũ \`verifyToken()\` thêm một bản (bọc lại), hay gộp hẳn vào \`verify()\`?

## 4. Kiểm thử

| Ca | Kỳ vọng |
|---|---|
| token rỗng | false |
| sai chữ ký | false |
| thiếu KEY_DIR | dừng lúc khởi động |
`;
const REPORT = `# D15 · báo cáo auth

.local/reports · lane D15 · 14:05

## ① Số đo

| Lệnh | Kết quả |
|---|---|
| \`bun test engine/test/auth\` | 12 pass · 0 fail |
| \`bun run typecheck\` | 0 lỗi |

## ② Commit

\`3f2a91c\` D15: verify rỗng trả false
`;
const LOCK = `{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "": {\n      "name": "cc-slaves",\n      "dependencies": {\n        "@xyflow/react": "12.12.0",\n        "react": "^18.3.1",\n`;
const SVG = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="86" height="56" viewBox="0 0 86 56"><path d="M24 8a20 20 0 1 0 0 40" fill="none" stroke="#5ad1ff" stroke-width="7"/><path d="M14 28h26m-8-8 8 8-8 8" fill="none" stroke="#5ad1ff" stroke-width="7"/><path d="M58 8a20 20 0 1 1 0 40" fill="none" stroke="#ffcf5a" stroke-width="7"/></svg>').toString('base64');
const f = (text: string, o: Partial<Extract<Node, { k: 'f' }>> = {}): Node => ({ k: 'f', text, ...o });
const d = (kids: Record<string, Node>, ign = false): Node => ({ k: 'd', kids, ign });
const ROOT = d({
  '.local': d({ reports: d({ 'd15-auth-report.md': f(REPORT, { ign: true }), 'gate-2026-11-15.md': f('# Gate\n', { ign: true }) }, true) }, true),
  docs: d({
    specs: d({
      '2026-10-28-quota-design.md': f('# Quota\n'), '2026-11-02-billing-usage-alerts-design.md': f('# Alerts\n'),
      '2026-11-02-billing-quota-rollover-design.md': f('# Rollover\n'), '2026-11-16-auth-design.md': f(SPEC),
      assets: d({ logo: d({ 'logo-d0.svg': f('', { res: { kind: 'image', dataUrl: SVG }, size: 2150 }), 'logo-d0-1024.png': f('', { res: { kind: 'image', dataUrl: SVG }, size: 48_000 }),
        'logo-d0.icns': f('', { res: { kind: 'binary' }, size: 186_000 }) }) }),
    }),
    ref: d({ 'operations.md': f('# Operations\n') }),
    'HANDOFF.md': f('# Handoff\n\nD2 port parser lot-2; B3 gate e2e.\n'),
  }),
  engine: d({
    src: d({ 'auth.ts': f(AUTH), 'config.ts': f("export const PORT = 4318\n"), 'lanes.ts': f('export function pick(lanes: Lane[]) {\n  return lanes.filter(isReady).sort(byAge)[0]\n}\n'),
      'legacy-keys.ts': f('export const LEGACY = true\n', { gone: true }), 'locked.ts': f('', { err: 'EACCES · không có quyền đọc' }), 'store.ts': f(Array.from({ length: 80 }, (_, i) => `export const k${i} = ${i}`).join('\n'), { live: true }) }),
    test: d({ 'auth.test.ts': f("import { verify } from '../src/auth'\n") }),
  }),
  fixtures: d({ 'lot2.json': f('{ "lot": 2 }\n'), 'menu-latin1.csv': f('ma;ten;gia\n1;caf� s�a;35000\n2;b�nh m�;20000\n3;tr� ��;15000\n', { res: { readOnly: 'not_utf8', eol: 'crlf' } }) }),
  node_modules: d({ react: d({ 'index.js': f('module.exports = {}\n', { ign: true }) }, true) }, true),
  web: d({ 'index.html': f('<!doctype html>\n') }),
  '.env': f('KEY_DIR=~/.keys\n', { ign: true }),
  'CLAUDE.md': f('# hagenta\n'), 'bun.lock': f(LOCK, { res: { kind: 'large' }, size: 3.4 * 1024 * 1024 }), 'package.json': f('{ "name": "hagenta" }\n'), 'README.md': f('# hagenta\n'),
});

let reads = 0;
const at = (path: string): Node | null => {
  let n: Node = ROOT;
  for (const seg of path.split('/').filter(Boolean)) { if (n.k !== 'd' || !n.kids[seg]) return null; n = n.kids[seg]; }
  return n;
};
const ign = (n: Node) => !!n.ign;
function all(n: Node, pre: string, show: boolean, out: string[]): string[] {
  if (n.k === 'd') for (const [k, c] of Object.entries(n.kids)) { if (show || !ign(c)) all(c, pre ? `${pre}/${k}` : k, show, out); }
  else out.push(pre);
  return out;
}

/** → [result] or [null, error message] */
export function codeFs(c: FsCmd): [unknown] | [null, string] {
  if (c.cmd === 'fs_list') {
    const n = at(c.dir);
    if (n?.k !== 'd') return [null, 'Không có thư mục này'];
    const entries: FsEntry[] = Object.entries(n.kids).filter(([, x]) => c.showIgnored || !ign(x))
      .map(([name, x]) => ({ name, type: x.k === 'd' ? 'dir' as const : 'file' as const, size: x.k === 'f' ? x.size ?? x.text?.length ?? 0 : 0, ignored: ign(x) }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return [{ entries, more: 0 }];
  }
  if (c.cmd === 'fs_find') {
    const q = c.query.toLowerCase();
    const hits = all(ROOT, '', c.showIgnored, []).filter(p => p.toLowerCase().includes(q));
    hits.sort((a, b) => Number(!a.split('/').pop()!.toLowerCase().includes(q)) - Number(!b.split('/').pop()!.toLowerCase().includes(q)) || a.length - b.length);
    return [{ paths: hits.slice(0, 50) }];
  }
  const n = at(c.path);
  if (n?.k !== 'f') return [null, 'Không có file này'];
  if (n.err) return [null, n.err];
  if (c.cmd === 'fs_write') return [write(c, n)];
  return [read(c.path, n)];
}

const saved = new Map<string, string>();
/** live files whose first save already met the session's write (C7 shows once; "Ghi đè" then passes) */
const raced = new Set<string>();
const hashOf = (text: string, live: number) => `h${text.length}-${live}-${text.slice(-12)}`;
function read(path: string, n: Extract<Node, { k: 'f' }>, bump = true): FsReadResult {
  const text = saved.get(path) ?? (n.text ?? '') + (n.live ? `\n// read ${bump ? ++reads : reads}\n` : ''); // C15: changes on every read
  return { kind: 'text', text, size: n.size ?? text.length, hash: hashOf(text, n.live ? reads : 0), eol: 'lf', bom: false, ...n.res };
}
function write(c: FsWriteReq, n: Extract<Node, { k: 'f' }>): FsWriteResult {
  if (n.gone && !c.recreate && !saved.has(c.path)) return { ok: false, code: 'gone' };
  if (!n.gone || saved.has(c.path)) {
    const disk = read(c.path, n, !!n.live && !raced.has(c.path)); // a session wrote it while the PO typed
    if (n.live) raced.add(c.path);
    if (disk.hash !== c.baseHash) return { ok: false, code: 'conflict', disk };
  }
  saved.set(c.path, c.text);
  return { ok: true, hash: hashOf(c.text, 0) };
}
