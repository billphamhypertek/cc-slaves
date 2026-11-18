// v2.3 shots (e2e/specs/v23-shots.spec.ts): the page ↔ dev-mock socket wired through `page.routeWebSocket` so a frame can
// patch what the mock engine cannot hold still or does not carry — the snapshot (orchestrator idle as in the mockup,
// project names, D7 without its worktree), held replies (C13 loading), set replies (C7 conflict, C14 EACCES, C22 gone),
// the extra files of the mockup's mock set (D2's lot2/parser.ts, the city-game folder), injected events (C15
// `code_changed`) and a dropped connection that refuses to come back (C16 / G11 offline).
import type { Page } from '@playwright/test';
import type { Command, FsEntry, FsReadResult, ServerMsg, Snapshot } from '../shared/protocol.ts';

type Reply = { ok: unknown } | { err: string } | 'hold';
export interface Wire {
  /** edit the snapshot the page gets (after the orchestrators are set idle) */
  snap?: (s: Snapshot) => void;
  /** answer a command here instead of the mock (`undefined` = let the mock answer) */
  reply?: (c: Command) => Reply | undefined;
  /** edit the mock's answer to a command */
  patch?: (c: Command, result: unknown) => unknown;
}
export interface WireCtl { drop(): void; event(e: unknown): void }

const text = (t: string): FsReadResult => ({ kind: 'text', text: t, size: t.length, hash: `w${t.length}`, eol: 'lf', bom: false });
const ent = (name: string, type: 'file' | 'dir' = 'file'): FsEntry => ({ name, type, size: 40, ignored: false });

/** The mockup's orchestrator is idle ("Điều phối rảnh"): "Sửa" works in the project folder (C2, C6). Every wired page gets
 *  it, on the snapshot and on each `orchestrator` event (the mock streams the watched orchestrator as running). */
const orchIdle = (s: Snapshot): void => { for (const o of s.orchestrators) o.state = 'idle'; };

/** Files of the mock set the dev tree lacks: D2's `engine/src/lot2/parser.ts` + `engine/test/parser.test.ts` (C8). */
const LOT2 = "import type { Row } from './types'\n\n/** Đọc lô 2: mỗi dòng một bản ghi, cột cách bằng dấu phẩy. */\nexport function parseLot(raw: string): Row[] {\n  const rows = raw.split('\\n').filter(Boolean)\n  return rows.map(r => r.split(','))\n}\n";
export function lot2(c: Command, r: unknown): unknown {
  if (c.cmd === 'fs_list' && c.dir === 'engine/src') return { ...(r as object), entries: [ent('lot2', 'dir'), ...(r as { entries: FsEntry[] }).entries] };
  return r;
}
export function lot2Reply(c: Command): Reply | undefined {
  if (c.cmd === 'fs_list' && c.dir === 'engine/src/lot2') return { ok: { entries: [ent('index.ts'), ent('parser.ts')], more: 0 } };
  if (c.cmd === 'fs_read' && c.path === 'engine/src/lot2/parser.ts') return { ok: text(LOT2) };
  if (c.cmd === 'fs_read' && c.path === 'engine/test/parser.test.ts') return { ok: text("import { parseLot } from '../src/lot2/parser'\n") };
  return undefined;
}

/** C11 / G7 the city-game project (no git): its own small folder. */
const CITY: Record<string, FsEntry[]> = {
  '': [ent('assets', 'dir'), ent('drafts', 'dir'), ent('notes.txt'), ent('README.md')],
  assets: [ent('map-40x40.json')], drafts: [ent('brief.md'), ent('outline.md')],
};
const CITY_TEXT: Record<string, string> = {
  'drafts/brief.md': '# City game · brief\n\nBản đồ lưới 40 × 40, mỗi ô một loại đất.\n\n## Việc tuần này\n\n- Vẽ lưới\n- Đặt nhà đầu tiên\n',
  'notes.txt': 'ý tưởng: ô nước chặn đường\n', 'README.md': '# city-game\n', 'drafts/outline.md': '# Outline\n', 'assets/map-40x40.json': '{ "w": 40, "h": 40 }\n',
};
export function cityGame(s: Snapshot): void {
  s.projects = [...s.projects, { ...s.projects[0]!, id: 'city-game', name: 'city-game', path: '/Users/po/Works/Projects/city-game', gchatWebhookSet: false }];
  s.orchestrators = [...s.orchestrators, { ...s.orchestrators[0]!, projectId: 'city-game', state: 'idle' }];
}
export function cityReply(c: Command): Reply | undefined {
  if (!('projectId' in c) || c.projectId !== 'city-game') return undefined;
  if (c.cmd === 'fs_list') return { ok: { entries: CITY[c.dir] ?? [], more: 0 } };
  if (c.cmd === 'fs_read') return { ok: text(CITY_TEXT[c.path] ?? '') };
  if (c.cmd === 'fs_find') return { ok: { paths: Object.keys(CITY_TEXT).filter(p => p.includes(c.query)) } };
  // §7 G7 (R17): git_branches carries the engine's marker, every other git read fails with `git_not_repo`
  if (c.cmd === 'git_branches') return { ok: { base: null, lanes: [], notRepo: true } };
  if (c.cmd.startsWith('git_') && c.cmd !== 'git_watch') return { err: 'not_git' };
  return undefined;
}

/** Route the page's engine socket through `w`. */
export async function wire(page: Page, w: Wire): Promise<WireCtl> {
  let page2: { send(m: string): void; close(): void } | null = null;
  let down = false;
  await page.routeWebSocket(/\/ws\?/, (ws) => {
    if (down) { void ws.close(); return; }
    page2 = ws;
    const server = ws.connectToServer();
    const asked = new Map<string, Command>();
    ws.onMessage((m) => {
      const msg = JSON.parse(String(m)) as { type: string; id: string; command?: Command };
      const c = msg.type === 'command' ? msg.command : undefined;
      const r = c ? w.reply?.(c) : undefined;
      if (r === 'hold') return;
      if (r && 'ok' in r) { ws.send(JSON.stringify({ type: 'ack', id: msg.id, result: r.ok } satisfies ServerMsg)); return; }
      if (r && 'err' in r) {
        const ng = r.err === 'not_git';
        ws.send(JSON.stringify({ type: 'error', id: msg.id, code: ng ? 'git_not_repo' : 'fs', message: ng ? 'Thư mục project không phải repo git' : r.err,
          ...(ng ? { key: 'errors.gitNotRepo' } : {}) } satisfies ServerMsg));
        return;
      }
      if (c) asked.set(msg.id, c);
      server.send(String(m));
    });
    server.onMessage((m) => {
      const msg = JSON.parse(String(m)) as ServerMsg;
      if (msg.type === 'snapshot') { orchIdle(msg.snapshot); w.snap?.(msg.snapshot); }
      if (msg.type === 'event' && msg.event.type === 'orchestrator') msg.event.orchestrator.state = 'idle';
      if (msg.type === 'ack' && w.patch && asked.has(msg.id)) msg.result = w.patch(asked.get(msg.id)!, msg.result);
      ws.send(JSON.stringify(msg));
    });
  });
  return {
    drop: () => { down = true; page2?.close(); },
    event: (e) => page2?.send(JSON.stringify({ type: 'event', event: e })),
  };
}

