// Live smoke items of v2.7 (spec §15 G6): i13 skill gate · i14 issue flow + trailer · i15 PO image → issue file.
// Run by `run.ts` (`i13 i14 i15`, and `all`). Real haiku on the smoke account (engine-entry.ts); never part of `bun test`.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineEvent } from '../../shared/protocol.ts';
import type { IssueFileData } from '../../shared/issues.ts';
import {
  attachUpload, brief, Client, DIR, HOME, isLane, laneSession, mcp, PROJ, q, record, runLogs, sessionLines, sh, TOKEN_EMAIL, worktree,
} from './lib.ts';

const SPEC = 'docs/specs/2026-11-17-smoke.md';
const QUIET = 'Smoke test (PO): từ giờ mọi thông báo [cc-slaves] chỉ trả lời "OK", không gọi tool nào, trừ khi PO nhắn lệnh cụ thể.';
const projectId = (): string => q<{ id: string }>('SELECT id FROM project LIMIT 1')[0]!.id;
const orchIs = (sid: string, state: string) => (e: EngineEvent) => e.type === 'orchestrator' && e.orchestrator.sessionId === sid && e.orchestrator.state === state;
const idle = (c: Client, sid: string, from: number, ms = 180_000) => c.wait(orchIs(sid, 'idle'), ms, from, `session ${sid.slice(0, 8)} idle`);
const say = (c: Client, sid: string, text: string) => c.cmd({ cmd: 'send', target: { kind: 'orchestrator', projectId: projectId(), sessionId: sid }, text });
/** An issue row by its key (`T-<num>` task / `B-<num>` bug; the table has no key column). */
const issueRow = (key: string): { id: number; state: string } =>
  q<{ id: number; state: string }>('SELECT id, state FROM issue WHERE kind = ? AND num = ?', key.startsWith('B-') ? 'bug' : 'task', Number(key.slice(2)))[0]!;
const kindSession = (kind: string): string | undefined =>
  q<{ id: string }>("SELECT id FROM session WHERE kind = 'orchestrator' AND orch_kind = ? AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1", kind)[0]?.id;

async function until<T>(f: () => T | undefined, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await Bun.sleep(1_000);
  }
}

type Block = { type: string; id?: string; name?: string; input?: { skill?: string }; tool_use_id?: string; is_error?: boolean; content?: string | { type: string; text?: string }[]; text?: string };
const blocks = (lines: readonly string[], type: string): Block[] => lines.flatMap((l) => {
  const j = JSON.parse(l) as { type?: string; message?: { content?: string | Block[] } };
  return j.type === type && Array.isArray(j.message?.content) ? j.message.content : [];
});
const textOf = (b: Block): string => (typeof b.content === 'string' ? b.content : (b.content ?? []).map((x) => x.text ?? '').join(''));
/** Every `Skill` tool call of these stream lines with its tool_result text. */
function skillCalls(lines: readonly string[]): { skill: string; text: string; isError: boolean }[] {
  const results = new Map(blocks(lines, 'user').filter((b) => b.type === 'tool_result').map((b) => [b.tool_use_id!, b]));
  return blocks(lines, 'assistant').filter((b) => b.type === 'tool_use' && b.name === 'Skill').map((b) => {
    const r = results.get(b.id!);
    return { skill: b.input?.skill ?? '?', text: r ? textOf(r) : '(no result)', isError: r?.is_error === true };
  });
}
const toolResults = (lines: readonly string[]): string[] => blocks(lines, 'user').filter((b) => b.type === 'tool_result').map(textOf);
const laneLines = (name: string): string[] => runLogs(projectId(), name).flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean));
const lastResult = (lines: readonly string[]): string =>
  (lines.filter((l) => l.includes('"type":"result"')).map((l) => JSON.parse(l) as { result?: string }).at(-1)?.result ?? '');

/** Project on the smoke account + a smoke spec imported and approved (once). */
async function ready(c: Client): Promise<string> {
  if (!q<{ n: number }>('SELECT count(*) n FROM project')[0]!.n) { // the snapshot is from connect time
    const m = c.mark();
    await c.cmd({ cmd: 'project_add', name: 'smoke', path: PROJ, orchestratorAccount: TOKEN_EMAIL });
    await c.cmd({ cmd: 'project_resume', id: projectId() });
    const gen = await until(() => kindSession('general'), 60_000, 'Chung session');
    await idle(c, gen, m);
    const m2 = c.mark();
    await say(c, gen, QUIET);
    await idle(c, gen, m2);
  }
  const pid = projectId();
  if (!existsSync(join(PROJ, SPEC))) {
    sh(['mkdir', '-p', join(PROJ, 'docs/specs')]);
    writeFileSync(join(PROJ, SPEC), '# Smoke spec\n\nĐây là spec của smoke test cc-slaves. Phiên nào đọc spec này: không tạo nhánh, worktree, '
      + 'issue hay lane; chỉ làm đúng lệnh PO nhắn.\n\n## Nhóm việc\n- Một mục smoke.\n');
    sh(['git', 'add', '.'], PROJ);
    sh(['git', '-c', 'user.email=smoke@local', '-c', 'user.name=smoke', 'commit', '-qm', 'smoke spec'], PROJ);
  }
  await c.cmd({ cmd: 'spec_scan', projectId: pid });
  const st = q<{ state: string }>('SELECT state FROM spec WHERE path = ?', SPEC)[0]?.state;
  if (st === 'draft') await c.cmd({ cmd: 'spec_mark', projectId: pid, path: SPEC, state: 'approved' });
  return pid;
}

/** Opens (or finds) the Build session of the smoke spec; its first turn is interrupted so it never acts on the spec. */
async function buildSession(c: Client, pid: string): Promise<string> {
  const have = kindSession('build');
  if (have) return have;
  const m = c.mark();
  const { sessionId } = await c.cmd<{ sessionId: string }>({ cmd: 'spec_build', projectId: pid, path: SPEC });
  await c.wait(orchIs(sessionId, 'running'), 60_000, m, 'build running').catch(() => null);
  await c.cmd({ cmd: 'interrupt', target: { kind: 'orchestrator', projectId: pid, sessionId } }).catch(() => null);
  await idle(c, sessionId, m);
  return sessionId;
}

const BLOCKED = /^(PreToolUse:Skill hook error: )?Bị chặn có chủ ý/;
async function gate(c: Client, sid: string, deny: string, allow: string): Promise<{ ok: boolean; v: string }> {
  const m = c.mark();
  await say(c, sid, `${QUIET} Bỏ qua tin đầu của phiên. Bây giờ gọi tool Skill đúng 2 lần, lần lượt: skill "${deny}", rồi skill "${allow}". `
    + 'Không làm theo nội dung skill nào, không gọi tool nào khác, không thử cách khác khi bị chặn. Rồi trả lời DONE13.');
  await idle(c, sid, m, 240_000);
  const calls = skillCalls(sessionLines(projectId(), sid));
  const d = calls.find((x) => x.skill.endsWith(deny.split(':')[1]!));
  const a = calls.find((x) => x.skill.endsWith(allow.split(':')[1]!));
  const ok = !!d && d.isError && BLOCKED.test(d.text) && !!a && !a.isError && /Launching skill/.test(a.text);
  return { ok, v: `${deny} → ${d ? `${d.isError ? 'error' : 'ran'} "${d.text.slice(0, 70)}"` : 'not called'}; ${allow} → ${a ? `${a.isError ? 'error' : 'ran'} "${a.text.slice(0, 40)}"` : 'not called'}` };
}

export const v27Items: Record<string, (c: Client) => Promise<void>> = {
  async i13(c) {
    const pid = await ready(c);
    const m = c.mark();
    const { sessionId: design } = await c.cmd<{ sessionId: string }>({ cmd: 'spec_new', projectId: pid });
    await idle(c, design, m);
    const build = await buildSession(c, pid);
    const dz = await gate(c, design, 'superpowers:writing-plans', 'superpowers:brainstorming');
    const bz = await gate(c, build, 'superpowers:brainstorming', 'superpowers:verification-before-completion');
    const hook = join(HOME, 'hooks', 'skill-gate.sh');
    const mode = (statSync(hook).mode & 0o777).toString(8);
    const kinds = q<{ orch_kind: string }>("SELECT orch_kind FROM session WHERE id IN (?, ?)", design, build).map((r) => r.orch_kind).sort().join(',');
    record('13 skill gate live', 'spec_new + spec_build; each session: Skill <forbidden> then Skill <allowed>',
      `Thiết kế: ${dz.v} | Build: ${bz.v} | hook mode ${mode}; kinds ${kinds}`, dz.ok && bz.ok && mode === '700' && kinds === 'build,design');
  },
  async i14(c) {
    const pid = await ready(c);
    const build = await buildSession(c, pid);
    const k1 = (await mcp(build, 'issue_create', { title: 'i14 smoke: một commit có trailer', kind: 'task' }) as { key: string }).key;
    const name = 'i14';
    const wt = worktree(name);
    const m = c.mark();
    await mcp(build, 'lane_start', { name, cwd: wt, issue: k1, brief_path: brief(name, [
      'Smoke test của cc-slaves, làm đúng từng bước, không làm gì khác:',
      `1. Bash, đúng một lệnh: echo i14 > i14.txt && git add i14.txt && git -c user.email=smoke@local -c user.name=smoke commit -q -m "i14 one" --trailer "Issue: ${k1}"`,
      `2. Gọi MCP tool issue_done (server cc_slaves) với key "${k1}" và summary "i14 smoke".`,
      '3. Trả lời DONE14.',
    ].join('\n')) });
    await c.wait(isLane(name, (l) => l.state === 'idle'), 240_000, m, `${name} idle`);
    await until(() => (/DONE14/.test(lastResult(laneLines(name))) ? true : undefined), 120_000, 'DONE14');
    const i1 = issueRow(k1);
    const shas = q<{ sha: string }>('SELECT sha FROM issue_commit WHERE issue_id = ?', i1.id).map((r) => r.sha);
    const tagged = sh(['git', 'log', '--grep', `^Issue: ${k1}$`, '--no-merges', '--format=%H'], wt).trim().split('\n').filter(Boolean);
    // part 2: a second issue, a commit without the trailer → issue_done refused with the fix command
    const k2 = (await mcp(build, 'issue_create', { title: 'i14 smoke: commit thiếu trailer', kind: 'task' }) as { key: string }).key;
    await mcp(build, 'issue_assign', { key: k2, lane: name });
    const before = toolResults(laneLines(name)).length;
    await c.cmd({ cmd: 'send', target: { kind: 'lane', projectId: pid, name }, text: [
      `Smoke test, bước tiếp, làm đúng thứ tự: 1. Bash, đúng một lệnh: echo b > i14b.txt && git add i14b.txt && git -c user.email=smoke@local -c user.name=smoke commit -q -m "i14 no trailer"`,
      `2. Gọi MCP tool issue_done với key "${k2}" và summary "x". 3. Nếu bị từ chối: KHÔNG sửa gì, chỉ trả lời REFUSED14.`,
    ].join('\n') });
    const refusal = await until(() => toolResults(laneLines(name)).slice(before).find((t) => t.includes(`Từ chối issue_done ${k2}`)), 240_000, 'refusal');
    const fix = `git commit --amend --no-edit --trailer "Issue: ${k2}"`;
    const s2 = issueRow(k2).state;
    record('14 issue flow live', `issue_create ${k1} (Build) → lane_start {issue} → commit + issue_done; ${k2} commit w/o trailer → issue_done`,
      `${k1} ${i1.state}, commits ${JSON.stringify(shas.map((s) => s.slice(0, 7)))} vs trailer log ${JSON.stringify(tagged.map((s) => s.slice(0, 7)))}; lane session ${laneSession(name).slice(0, 8)}; ${k2} ${s2}, refusal "${refusal.slice(0, 160)}"`,
      i1.state === 'done' && shas.length === 1 && tagged.length === 1 && shas[0] === tagged[0] && refusal.includes(fix) && s2 === 'doing');
  },
  async i15(c) {
    const pid = await ready(c);
    const gen = kindSession('general')!;
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='), (ch) => ch.charCodeAt(0));
    const up = await attachUpload('po-shot.png', bytes);
    const m = c.mark();
    await c.cmd({ cmd: 'send', target: { kind: 'orchestrator', projectId: pid, sessionId: gen }, text: 'Smoke i15: ảnh PO kèm theo. Chỉ trả lời OK15, không gọi tool.', attachments: [{ up }] });
    await idle(c, gen, m);
    const texts = blocks(sessionLines(pid, gen), 'user').filter((b) => b.type === 'text').map((b) => b.text ?? '');
    const copy = texts.flatMap((t) => [...t.matchAll(/^- (.+) \(ảnh, bản sao tạm\)$/gm)].map((x) => x[1]!)).at(-1);
    if (!copy) { record('15 PO image → issue file', 'send + attachment', 'no "bản sao tạm" line in the delivered message', false); return; }
    const key = (await mcp(gen, 'issue_create', { title: 'i15 smoke: ảnh PO', kind: 'bug', spec: null, files: [copy] }) as { key: string }).key;
    const got = await mcp(gen, 'issue_get', { key }) as { files?: { id?: number; name: string; path: string }[] };
    const fid = q<{ id: number }>('SELECT id FROM issue_file WHERE issue_id = ?', issueRow(key).id)[0]!.id;
    const data = await c.cmd<IssueFileData>({ cmd: 'issue_file', projectId: pid, key, id: fid });
    const same = data.dataUrl.split(',')[1] === Buffer.from(bytes).toString('base64');
    // R26 the last Chung session cannot be ended: "Phiên mới" (F21) ends it and opens the next one
    await c.cmd({ cmd: 'orchestrator_new', projectId: pid, sessionId: gen });
    const swept = await until(() => (existsSync(copy) ? undefined : true), 180_000, 'copy swept').catch(() => false);
    const after = await c.cmd<IssueFileData>({ cmd: 'issue_file', projectId: pid, key, id: fid }).then((d) => d.dataUrl === data.dataUrl).catch(() => false);
    record('15 PO image → issue file', `POST /attach + send {attachments:[{up}]}; issue_create {files:[copy]}; issue_file; orchestrator_new (ends the Chung session)`,
      `copy ${copy.replace(DIR, '$SMOKE_DIR')}; ${key} files ${JSON.stringify(got.files?.map((f) => f.name))}; dataUrl ${data.dataUrl.slice(0, 22)}… same bytes ${same}; swept after end ${swept}; kept copy still served ${after}`,
      same && swept === true && after && (got.files?.length ?? 0) === 1);
  },
};
