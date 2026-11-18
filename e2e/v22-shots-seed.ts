// v22-shots fixtures (e2e/specs/v22-shots.spec.ts): the mockup's default machine (spec v2.2 §6 "Ví dụ máy PO": MCP red 2
// context7 + vercel, Skills yellow 4, Thư mục chung yellow 1) under a temp home, the K11 extra issue sources, the stream
// scripts of S1–S11, and a page-side snapshot patch for the few states the engine cannot hold still (K1-load, K3-find,
// K3e-timeout, K4e-cli; listed in the lane report ⑤). Never the real home: every path is under the engine's temp dir.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { SkillsMcpView } from '../shared/protocol.ts';
import { B2, S, type E2eEngine, type Scenario } from './fixtures.ts';

type Step = Record<string, unknown>;

/** A stdio MCP server answering `initialize` + `tools/list` with argv[2] tools (the §5.4b check spawns it). */
const STDIO_MCP = `const n = Number(process.argv[2] || 0), pre = process.argv[3] || 'tool';
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  for (let i = buf.indexOf('\\n'); i >= 0; i = buf.indexOf('\\n')) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    const result = m.method === 'initialize' ? { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: pre, version: '1' } }
      : m.method === 'tools/list' ? { tools: Array.from({ length: n }, (_, k) => ({ name: pre + '_' + (k + 1), inputSchema: { type: 'object' } })) } : {};
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
  }
});
`;

/** `{ command, args }` of a fake stdio MCP server with `n` tools (node = the Playwright worker's own binary). */
export function stdioServer(e: E2eEngine, n: number, prefix: string): { command: string; args: string[] } {
  const file = join(e.dir, 'mcp-bin', 'stdio-mcp.mjs');
  mkdirSync(join(e.dir, 'mcp-bin'), { recursive: true });
  writeFileSync(file, STDIO_MCP);
  return { command: process.execPath, args: [file, String(n), prefix] };
}

const md = (dir: string, name: string, desc: string) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\nbody\n`); };

const USER_DIRS: [string, string][] = [
  ['1devtool-orchestrator', 'Orchestrate agents in 1DevTool from a chart'],
  ['1devtool-tasks', 'Create, assign and track 1DevTool tasks'],
  ['codebase-memory', 'Use the codebase knowledge graph for structural code queries'],
];
const USER_LINKS: [string, string][] = [
  ['brandkit', 'Premium brand-kit image generation for brand-guideline boards'],
  ['full-output-enforcement', 'Overrides default LLM truncation behavior; complete code output'],
  ['gpt-taste', 'Elite UX/UI & advanced GSAP motion engineer'],
  ['high-end-visual-design', 'Design like a high-end agency: fonts, spacing, shadows'],
  ['image-to-code', 'Website image-to-code: generate the reference, then build it'],
  ['industrial-brutalist-ui', 'Raw mechanical interfaces fusing Swiss print and terminal UI'],
  ['minimalist-ui', 'Clean editorial-style interfaces with warm monochrome palettes'],
  ['redesign-existing-projects', 'Upgrades existing websites and apps to premium quality'],
  ['stitch-design-taste', 'Semantic design system skill for Google Stitch'],
  ['emil-design-eng', 'Design engineering philosophy: polish, animation, invisible details'],
  ['full-page-screenshot', 'Capture a full-page screenshot of a web page'],
];
const PLUGINS: { key: string; skills: string[]; mcp?: Record<string, unknown> }[] = [
  { key: 'ui-ux-pro-max@ui-ux-pro-max-skill', skills: ['ui-ux-pro-max', 'banner-design', 'brand', 'design', 'design-system', 'slides', 'ui-styling'] },
  { key: 'superpowers@superpowers-marketplace', skills: ['brainstorming', 'writing-plans', 'test-driven-development', 'systematic-debugging', 'subagent-driven-development', 'verification-before-completion'] },
  { key: 'engineering-skills@claude-code-skills', skills: ['senior-frontend', 'senior-backend', 'code-reviewer', 'tdd-guide', 'senior-qa'] },
  { key: 'anthropic-skills@anthropic-agent-skills', skills: ['pdf', 'docx', 'xlsx', 'pptx', 'skill-creator'] },
  { key: 'vercel@claude-plugins-official', skills: ['nextjs', 'ai-sdk', 'vercel-cli', 'deployments-cicd'], mcp: { vercel: { type: 'http', url: 'https://mcp.vercel.com' } } },
  { key: 'context7@claude-plugins-official', skills: [], mcp: { context7: { type: 'http', url: 'https://mcp.context7.com/mcp' } } },
];

/** The lane `system/init` of the default machine: what each server reported in D2 / B3 (§6 K1 statuses + tool counts). */
export const MACHINE_INIT: Scenario = {
  init: {
    tools: ['Bash', 'Read', 'mcp__cc_slaves__ask', ...Array.from({ length: 38 }, (_, i) => `mcp__onedevtool__t${i + 1}`), ...Array.from({ length: 14 }, (_, i) => `mcp__miro__t${i + 1}`)],
    mcp_servers: [{ name: 'cc_slaves', status: 'connected' }, { name: 'onedevtool', status: 'connected' }, { name: 'miro', status: 'connected' },
      { name: 'plugin_context7_context7', status: 'needs-auth' }, { name: 'plugin_vercel_vercel', status: 'needs-auth' }],
  },
  steps: S.idle(),
};

/** Before the engine boots (the `scenarios` hook): skills, plugins, ~/.claude.json with user + local servers. */
export function seedMachine(e: E2eEngine): void {
  const home = join(e.dir, 'user'), skills = join(e.dir, 'claude', 'skills');
  mkdirSync(skills, { recursive: true });
  for (const [n, d] of USER_DIRS) md(join(skills, n), n, d);
  for (const [n, d] of USER_LINKS) { md(join(home, '.agents', 'skills', n), n, d); symlinkSync(join(home, '.agents', 'skills', n), join(skills, n)); }
  md(join(home, 'Works', 'Projects', 'h-ops-skill'), 'h-ops', 'Unified DevOps toolkit for a self-managed server fleet');
  symlinkSync(join(home, 'Works', 'Projects', 'h-ops-skill'), join(skills, 'h-ops'));
  for (const n of ['find-skills', 'design-taste-frontend']) {
    md(join(home, '.cc-switch', 'skills', n), n, `${n} from CC Switch`);
    symlinkSync(join(home, '.cc-switch', 'skills', n), join(skills, n));
  }
  for (const n of ['learned', 'synced']) mkdirSync(join(skills, n, 'notes'), { recursive: true }); // no SKILL.md
  const installed: Record<string, unknown[]> = {}, enabled: Record<string, boolean> = {};
  for (const p of PLUGINS) {
    const dir = join(e.dir, 'claude', 'plugins', 'cache', p.key.split('@')[1]!, p.key.split('@')[0]!, '1.0.0');
    mkdirSync(dir, { recursive: true });
    for (const s of p.skills) md(join(dir, 'skills', s), s, `${s} — part of ${p.key.split('@')[0]}`);
    if (p.mcp) writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: p.mcp }));
    installed[p.key] = [{ scope: 'user', installPath: dir }];
    enabled[p.key] = true;
  }
  writeFileSync(join(e.dir, 'claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: installed }));
  writeFileSync(join(e.dir, 'claude', 'settings.json'), JSON.stringify({ enabledPlugins: enabled }));
  mkdirSync(join(e.repo('hagenta'), '.git'), { recursive: true });
  writeFileSync(e.file('claude.json'), JSON.stringify(machineJson(e), null, 2));
  // K9: a git repo of skills (4 valid, one taken name, one bad name) and a folder whose name is taken
  const repo = join(e.dir, 'gitrepo');
  for (const n of ['pdf-tools', 'docx-tools', 'csv-tools', 'slides-kit']) md(join(repo, 'skills', n), n, `${n} from git`);
  md(join(repo, 'skills', 'gpt-taste'), 'gpt-taste', 'taken name'); md(join(repo, 'skills', 'Template Skill'), 'template', 'bad chars');
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=e2e@x.test', '-c', 'user.name=e2e', ...a], { cwd: repo, stdio: 'ignore' });
  git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'skills');
  md(join(e.dir, 'src', 'h-ops'), 'h-ops', 'a second h-ops');
}

/** `~/.claude.json` of the default machine (user: onedevtool, codebase-memory-mcp; local hagenta: miro; local ~: hcm). */
export function machineJson(e: E2eEngine, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mcpServers: { onedevtool: stdioServer(e, 38, 'onedev'), 'codebase-memory-mcp': stdioServer(e, 14, 'cbm'), ...extra },
    projects: {
      [e.repo('hagenta')]: { mcpServers: { miro: { type: 'http', url: 'https://mcp.miro.com/' } } },
      [homedir()]: { mcpServers: { hcm: { type: 'http', url: 'https://hcm.example.test/mcp', headers: { 'X-API-Key': 'hcm-secret-key' } } } },
    },
  };
}

/** Thư mục chung yellow 1: B2's `skills` link replaced by a real folder ("thư mục thật ở chỗ phải là link"). */
export function breakSharedLink(e: E2eEngine): void {
  const root = join(e.dir, 'accts');
  for (const id of readdirSync(root)) {
    let email = '';
    try { email = (JSON.parse(readFileSync(join(root, id, '.claude.json'), 'utf8')) as { oauthAccount?: { emailAddress?: string } }).oauthAccount?.emailAddress ?? ''; } catch { continue; }
    if (email !== B2) continue;
    rmSync(join(root, id, 'skills'), { recursive: true, force: true });
    mkdirSync(join(root, id, 'skills', 'old-skill'), { recursive: true });
  }
}

/** K11 every issue kind: a broken link, a project skill shadowed by a user one, a project whose root holds ~/.claude/skills. */
export function seedSkillIssues(e: E2eEngine): void {
  const skills = join(e.dir, 'claude', 'skills');
  symlinkSync(join(e.dir, 'user', 'gone', 'old-helper'), join(skills, 'old-helper'));
  md(join(e.repo('hagenta'), '.claude', 'skills', 'gpt-taste'), 'gpt-taste', 'project copy of gpt-taste');
}

// ---------- page-side snapshot patch (states the engine cannot hold still) ----------

type Msg = { type: string; snapshot?: { skillsMcp?: SkillsMcpView; channel?: string }; event?: { type: string; view?: SkillsMcpView } };

/** Rewrites the Skills & MCP view of every snapshot / `skills_mcp` event this page receives; `null` = "not built yet". */
export async function patchView(page: Page, fn: (v: SkillsMcpView) => SkillsMcpView | null): Promise<void> {
  await page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => {
      const msg = JSON.parse(String(m)) as Msg;
      if (msg.snapshot?.skillsMcp) {
        const v = fn(msg.snapshot.skillsMcp);
        if (v) msg.snapshot.skillsMcp = v; else delete msg.snapshot.skillsMcp;
      }
      if (msg.event?.type === 'skills_mcp' && msg.event.view) {
        const v = fn(msg.event.view);
        if (!v) return;
        msg.event.view = v;
      }
      ws.send(JSON.stringify(msg));
    });
  });
}

/** K2 as in the mockup: `name` logged in (refreshed 20 min ago, expires in 40). The fake Keychain starts empty at every
 *  boot, so the login is seeded on the view the page receives. */
export const loggedIn = (name: string, now = Date.now()) => (v: SkillsMcpView): SkillsMcpView => ({
  ...v, mcp: { ...v.mcp, rows: v.mcp.rows.map((r) => (r.name === name && r.oauth
    ? { ...r, oauth: { ...r.oauth, loggedIn: true, refreshedAt: now - 20 * 60_000, expiresAt: now + 40 * 60_000, needsLogin: null } } : r)) },
});

// ---------- S1–S11 stream scripts ----------

let seq = 0;
const tool = (name: string, input: Record<string, unknown>, result?: { text: string; error?: boolean }): Step[] => {
  const id = `toolu_s${++seq}`;
  const use: Step = { emit: { type: 'assistant', parent_tool_use_id: null, message: { id: `msg_t${seq}`, role: 'assistant', model: 'claude-fake', content: [{ type: 'tool_use', id, name, input }] } } };
  if (!result) return [use];
  return [use, { emit: { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result.text, ...(result.error ? { is_error: true } : {}) }] } } }];
};
const say = (id: string, text: string): Step => ({ stream: { id, chunk: 400, blocks: [{ text }] } });
const hold = (id: string, text: string, extra: Record<string, unknown> = {}): Step => ({ stream: { id, chunk: 400, open: true, blocks: [{ text }], ...extra } });
const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n');

const S1_TEXT = '## Kế hoạch đợt này\n\nĐã giao **D2** port parser lot-2 và **D3** chạy lại cổng e2e:\n\n'
  + '- D2: sửa `parsePartial()` trong `web/src/lib/store.ts`\n  - giữ khoá theo `msgId:index`\n  - thêm kiểm thử cho hai khoá song song\n'
  + '- D3: chạy `bun run test:e2e` trên nhánh `v22`\n\nTiếp theo mình theo dõi hai lane và báo lại khi có kết quả của';
const S2_TEXT = 'Đây là chỗ sửa trong store:\n\n```ts\nexport function applyDelta(s: Store, key: string, delta: string): Store {\n'
  + '  const prev = s.partials[key] ?? { text: \'\', at: Date.now() };\n  // one key per message + block index: two blocks never overwrite each other\n'
  + '  return { ...s, partials: { ...s.partials, [key]: { text: prev.text + delta, at: Date.now() } } };\n}\n\nexport function endPartial(s: Store, key: string';
const TABLE_HEAD = '| Lane | Account | Pha | Thời gian | Chi phí | Ghi chú |\n|---|---|---|---|---|---|\n';
const TABLE_ROWS = [
  '| D2 | pm@x.test | sửa parser | 12 phút | ≈ $0.42 | đang chạy test web |', '| D3 | b2@x.test | e2e | 31 phút | ≈ $1.10 | chờ cổng e2e xong |',
  '| B3 | pm@x.test | review | 8 phút | ≈ $0.18 | không có phát hiện mới |', '| D4 | b2@x.test | tài liệu | 4 phút | ≈ $0.05 | cập nhật HANDOFF.md và docs/ref |',
];
const S3A = `Bảng tiến độ:\n\n${TABLE_HEAD}${TABLE_ROWS.slice(0, 3).join('\n')}\n| D4 | b2@x.test | tài`;
const S3B = `Bảng tiến độ:\n\n${TABLE_HEAD}${TABLE_ROWS.join('\n')}\n\nCả bốn lane đều ổn.`;
const LONG = Array.from({ length: 24 }, (_, i) => `Đoạn ${i + 1}: chữ tiếp tục tới trong lúc anh đang đọc phần trên của cuộc trò chuyện này.`).join('\n\n');
const EDIT = { file_path: '/Users/po/Works/Projects/hagenta/web/src/lib/store.ts', old_string: 'old 1\nold 2\nold 3', new_string: lines(12, (i) => `new ${i}`) };

/** S4 / S5 / S10 / S11 / S4-narrow: text, five read-only tools, an Edit, a failed Bash, then a Bash still running. */
const S4_LANE: Step[] = [
  S.wait, say('msg_d2a', 'Mình đọc store và các test liên quan trước khi sửa.'),
  ...tool('Read', { file_path: '/Users/po/Works/Projects/hagenta/web/src/lib/store.ts' }, { text: lines(40, (i) => `${i}\tline`) }),
  ...tool('Read', { file_path: '/Users/po/Works/Projects/hagenta/web/src/lib/ws.ts' }, { text: lines(20, (i) => `${i}\tline`) }),
  ...tool('Grep', { pattern: 'partials\\[', path: 'web/src' }, { text: 'web/src/lib/store.ts:88' }),
  ...tool('Read', { file_path: '/Users/po/Works/Projects/hagenta/web/test/store.test.ts' }, { text: lines(30, (i) => `${i}\tline`) }),
  ...tool('Grep', { pattern: 'applyDelta', path: 'web' }, { text: 'web/src/lib/store.ts:91\nweb/test/store.test.ts:12' }),
  say('msg_d2b', 'Khoá hiện chỉ theo tin, nên hai khối song song đè nhau. Sửa thành khoá theo tin + thứ tự khối.'),
  ...tool('Edit', EDIT, { text: 'ok' }),
  ...tool('Bash', { command: 'bun test web/test/store.test.ts' }, { text: `Exit code 1\n${lines(48, (i) => (i === 1 ? 'error: expect(received).toBe(expected)' : `  at store.test.ts:${40 + i}`))}`, error: true }),
  say('msg_d2c', 'Một test cũ còn giả định khoá theo tin — sửa test đó rồi chạy lại cả bộ.'),
  ...tool('Bash', { command: 'bun test web/test 2>&1 | tail -n 5' }), S.wait,
];

/** Lane scenarios by name (`lane-<name>.json`) for the S frames; D2 carries S4. */
export function streamLanes(): Record<string, Scenario> {
  const task = [
    ...tool('Task', { description: 'chạy test web', subagent_type: 'general-purpose', prompt: 'chạy' }),
    { emit: { type: 'system', subtype: 'task_started', task_id: 'sa_tests', tool_use_id: `toolu_s${seq}`, description: 'chạy test web', subagent_type: 'general-purpose', prompt: 'chạy', is_backgrounded: false } },
  ];
  const parent = `toolu_s${seq}`;
  return {
    'lane-D2': { steps: S4_LANE },
    'lane-D3': { steps: [S.wait, hold('msg_s2', S2_TEXT), S.wait] },
    'lane-D4': { steps: [S.wait, hold('msg_s3a', S3A), S.wait] },
    'lane-D5': { steps: [S.wait, say('msg_s3b', S3B), S.result(), ...S.idle()] },
    'lane-D6': { steps: [S.wait, say('msg_s6a', LONG), { stream: { id: 'msg_s6b', chunk: 2, everyMs: 120, blocks: [{ text: LONG }] } }, S.result(), ...S.idle()] },
    'lane-D7': { steps: [S.wait, { stream: { id: 'msg_s7', chunk: 400, open: true, blocks: [{ thinking: 'đang nghĩ về cách sửa khoá' }] } }, S.wait] },
    'lane-D8': { steps: [S.wait, say('msg_s8a', 'Giao subagent chạy test web, mình đọc tiếp phần store.'), ...task,
      hold('msg_s8sub', 'Subagent: đang chạy 412 test web, đã qua 380, chưa thấy lỗi nào', { parent }), S.wait] },
    'lane-D9': { steps: [S.wait, hold('msg_s9', 'Mình đang tóm tắt kết quả cổng e2e: 61 spec qua, 0 hỏng. Phần tiếp theo là danh sách các khung đã chụp và'), S.wait] },
  };
}

/** The orchestrator: opens D2–D9, then S1 (two MCP rows standing alone + a markdown reply still streaming). */
export function streamOrch(e: E2eEngine): Scenario {
  const lanes = ['D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9'].flatMap((n) => S.startLane(e, n));
  return { steps: [...lanes, { waitUser: 'S1' }, S.mcp('lane_tail', { name: 'D2', n: 3 }), S.mcp('lane_tail', { name: 'D3', n: 3 }), hold('msg_s1', S1_TEXT), S.wait] };
}
