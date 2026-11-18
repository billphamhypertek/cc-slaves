// spec v2.9 §5.9 / R20 the author session's whitelist argv (measured by G0 §4: `--restricted --tools`, no skip-permissions, the
// only MCP tool `cc_draft.draft_save`, files only inside the draft dir), its two draft files, and its appendix — the vocabulary
// table generated from vocab.ts, the one source `validate.ts` reads too.
import { modelOverride } from '../session/args.ts';
import {
  BOOL_RULES, DONE_ID, KICKOFF_KEYS, LABEL_KEYS, LIMITS, MAX_DOC_SESSIONS, NEXT_KEYS, OPTIONAL_SLOTS, REQUIRED_SLOTS, RULE_SLOTS,
  SKILL_DENY_KEYS, START_VALUES, STEP_KEYS, STEP_TYPES, TYPE_NAME, WORKFLOW_KEYS,
} from './vocab.ts';

export const DRAFT_SERVER = 'cc_draft';
const DRAFT_TOOL = 'draft_save';
const AUTHOR_TOOLS = 'Read,Write,Edit,Glob,Grep';

export interface AuthorArgsInput {
  /** `<home>/workflow-drafts/<draftId>`: `pack/` is the cwd, `examples/` the one extra read-only dir. */
  draftDir: string;
  sessionId: string;
  resume: boolean;
  appendix: string;
  model?: string | null;
}

/** §5.9 the exact G0 argv (never `--dangerously-skip-permissions`: `--restricted` refuses it, G0 4f). */
export function buildAuthorArgs(a: AuthorArgsInput, env: Record<string, string | undefined> = process.env): string[] {
  const out = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages',
    '--restricted', '--tools', AUTHOR_TOOLS, '--disable-slash-commands',
    '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
    // G0 4d: without --allowedTools the one MCP tool is auto-denied under `--permission-prompts none`
    '--mcp-config', `${a.draftDir}/mcp.json`, '--strict-mcp-config', '--allowedTools', `mcp__${DRAFT_SERVER}__${DRAFT_TOOL}`,
    '--add-dir', `${a.draftDir}/examples`, '--settings', `${a.draftDir}/settings.json`,
    '--system-prompt-snapshot', 'off', '--append-system-prompt', a.appendix,
    a.resume ? '--resume' : '--session-id', a.sessionId,
  ];
  const model = modelOverride(env) ?? a.model;
  if (model) out.push('--model', model);
  return out;
}

/** G0 4e only the `//<abs>` form blocks; a single `/` is read relative to the settings file and blocks nothing. */
export const draftSettings = (draftDir: string) => ({
  permissions: { deny: [`Edit(/${draftDir}/examples/**)`, `Write(/${draftDir}/examples/**)`] },
});

/** §10.1 the one server: `/mcp-draft`, bearer = the draft's own token (never the TokenRegistry of the sessions). */
export const draftMcpConfig = (port: number, token: string) => ({
  mcpServers: { [DRAFT_SERVER]: { type: 'http', url: `http://127.0.0.1:${port}/mcp-draft`, headers: { Authorization: `Bearer ${token}` } } },
});

const code = (xs: readonly string[]) => xs.map((x) => `\`${x}\``).join(', ');
const slots = (xs: readonly string[]) => xs.map((x) => `{{${x}}}`).join(' ');

/** §5.9 the author appendix: vocabulary (vocab.ts) + the installed skills / plugins + how to work. */
export function authorAppendix(env: { skills: readonly string[]; plugins: readonly string[] }): string {
  const types = STEP_TYPES.map((t) => `- \`${t}\` (${TYPE_NAME[t]}): khoá ${code(STEP_KEYS[t])}; ô bắt buộc ${slots(REQUIRED_SLOTS[t])}; ô tuỳ chọn ${slots(OPTIONAL_SLOTS[t])}`);
  return [
    'Bạn là phiên soạn quy trình của cc-slaves. Thư mục làm việc (cwd) là gói quy trình nháp; chỉ sửa file trong đó.',
    '',
    '## Gói',
    '- `WORKFLOW.md`: frontmatter YAML giữa hai dòng `---` + thân = lời dặn chung. Khoá: ' + `${code(WORKFLOW_KEYS)}.`,
    '- `steps/<id>.md`: một file mỗi bước; `id` = tên file, dạng `[a-z0-9-]{1,24}`. Thân = lời dặn của bước. Không tạo file nào khác.',
    `- \`rules\`: ${code(BOOL_RULES)} (true / false) và \`max_doc_sessions\` (${MAX_DOC_SESSIONS.min}–${MAX_DOC_SESSIONS.max}).`,
    `- \`labels\`: ${code(LABEL_KEYS)}. \`kickoff\` của design: ${code(KICKOFF_KEYS.design)}; của build: ${code(KICKOFF_KEYS.build)}.`,
    `- \`next\`: ${code(NEXT_KEYS)}; \`start\` là ${code(START_VALUES)}; \`to: ${DONE_ID}\` = Xong. \`skills_deny\`: danh sách ${code(SKILL_DENY_KEYS)}.`,
    '',
    '## Loại bước',
    ...types,
    `- Ô luật: ${RULE_SLOTS.map((r) => `{{rule:${r}}}`).join(' ')}. Khoá lạ, ô lạ đều là lỗi.`,
    '',
    '## Hình dạng',
    `Chuỗi thẳng design… → build → Xong (0–${LIMITS.maxDocs} bước design, 0–${LIMITS.maxBuild} build); đúng một \`general\` và một \`lane\`, ngoài chuỗi.`,
    `\`phases\` của lane: 1–${LIMITS.maxPhases} pha, kết thúc bằng \`done\`. Có bước design ⇔ \`doc_label\` khác trống. \`docs\` tương đối, không \`..\`.`,
    '',
    '## Skill / plugin đang cài (để viết đúng tên trong `skills_deny` / `require_plugins`)',
    `- Skill: ${env.skills.length ? env.skills.join(', ') : '(không có)'}`,
    `- Plugin: ${env.plugins.length ? env.plugins.join(', ') : '(không có)'}`,
    '',
    '## Cách làm',
    '- Đọc `examples/` (ba mẫu có sẵn, chỉ đọc) trước khi viết; gói mới thường bắt đầu từ bản sao một mẫu.',
    `- Lời dặn ngắn (mỗi thân ≤ ${LIMITS.longBodyLines} dòng).`,
    '- Mỗi lần trả lời: một câu tóm tắt đã đổi gì. Không hỏi lại khi yêu cầu đủ rõ; thiếu điều làm đổi kết quả thì hỏi một câu.',
    '- Gói mới: đề xuất tên trong khoá `name` của `WORKFLOW.md`.',
    '- Tin bắt đầu bằng `[cc-slaves]` là của engine (Kiểm gói, sửa tay của người dùng); sửa lỗi Kiểm gói báo.',
    `- Chỉ gọi công cụ \`${DRAFT_TOOL}\` khi người dùng nói rõ là lưu ("lưu đi", "ok lưu"); không tự lưu.`,
  ].join('\n');
}
