// v2.7 spec MCP tools (spec §5.2, §10.1): spec_draft / spec_approve (the design step), spec_amend (design, bound to an active
// spec), spec_set_branch / spec_close (the build step), spec_output_add (the session bound to that spec). §5.5-8 by session kind
// already ran (`gateTool`); each tool adds its rules.ts lifecycle check before it writes.
import { readFileSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import type { Db } from '../db.ts';
import type { SpecRow } from '../../../shared/issues.ts';
import { checkPath } from '../code/path.ts';
import { headSha } from '../issues/commits.ts';
import { checkSpecAmend, checkSpecApprove, checkSpecClose, checkSpecDraft } from '../issues/rules.ts';
import { addSpecOutput, bumpAmend, getSpec, getSpecByPath, insertSpec, listIssues, moveSpec, updateSpec } from '../issues/store.ts';
import { validateOutputRef } from '../specs/outputs.ts';
import { nextStep, sessionStep, stepOf, workflowRev } from '../workflow/runtime.ts';
import { callerOf, projectRoot, refuse, specRel, type Orch } from './issue-tools.ts';
import { fixed, O, obj, str, ToolError, type Args, type Identity, type ToolDef, type ToolDeps } from './tool-kit.ts';

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const pathArg = { path: str('đường dẫn {doc} trong project, vd {docs}/2026-11-16-x.md') };

/** §5.1 `title` = the file's first `# ` line (the file name when it has none). */
function titleOf(text: string, rel: string): string {
  const h = /^# +(.+?)\s*$/m.exec(text);
  return h ? h[1]! : basename(rel, '.md');
}

function mustSpec(db: Db, who: Identity, raw: string): SpecRow {
  const s = getSpecByPath(db, who.projectId, specRel(projectRoot(db, who.projectId), raw));
  if (!s) throw new ToolError(`Chưa có spec ${raw}: phiên ${callerOf(db, who).wf.names.design} gọi spec_draft {path} sau khi viết file`);
  return s;
}

const orch = (db: Db, who: Identity) => callerOf(db, who) as Orch;

function draftTool(d: ToolDeps, who: Identity, a: Args): unknown {
  const { db, rename } = d.issues;
  const root = projectRoot(db, who.projectId);
  const rel = specRel(root, a.path as string);
  if (!rel.endsWith('.md')) throw new ToolError(`spec_draft cần file .md (vd docs/specs/<ngày>-<tên>.md), không phải ${rel}`);
  let text: string;
  try { text = readFileSync(checkPath(realpathSync.native(root), rel).real, 'utf8'); } catch {
    throw new ToolError(`Không đọc được ${rel} trong project: viết file spec trước rồi gọi spec_draft`);
  }
  const title = titleOf(text, rel);
  const c = orch(db, who);
  const spec = getSpecByPath(db, who.projectId, rel);
  if (c.spec && c.spec.id !== spec?.id) throw new ToolError(`phiên này đã gắn spec ${c.spec.path}: một phiên ${c.wf.names.design} viết một spec — spec khác dùng "+ ${c.wf.Doc} mới"`);
  refuse(checkSpecDraft(c, spec));
  const row = spec
    ? (spec.state === 'approved' ? moveSpec(db, spec.id, 'draft') : spec)
    : newSpec(db, who, rel, title);
  updateSpec(db, row.id, { title });
  rename(who.sessionId, title);
  return { path: rel, state: 'draft', title };
}

/** v2.9 §6.1 a new spec runs the rev of the session that wrote it, at that session's doc step. */
function newSpec(db: Db, who: Identity, path: string, title: string): SpecRow {
  const { workflow, step } = sessionStep(db, who.sessionId);
  return insertSpec(db, { projectId: who.projectId, path, title, origin: 'app', designSession: who.sessionId, workflowRev: workflow.rev, step: step.id });
}

/** v2.9 §5.3 approved at doc step S: an edge to Xong → done; `start: button` → approved (Bắt đầu opens the next step);
 *  `start: auto` → approved, then the next step opens at once (a failure leaves it approved, for the button). */
async function approveTool(d: ToolDeps, who: Identity, a: Args): Promise<unknown> {
  const { db } = d.issues;
  const spec = mustSpec(db, who, a.path as string);
  refuse(checkSpecApprove(orch(db, who), spec));
  let after: SpecRow | null = null;
  if (typeof a.after === 'string') {
    after = mustSpec(db, who, a.after);
    for (let s: SpecRow | null = after; s; s = s.afterId === null ? null : getSpec(db, s.afterId)) {
      if (s.id === spec.id) throw new ToolError(`after ${after.path} tạo vòng với ${spec.path}: chọn spec phải xong trước khác`);
    }
    updateSpec(db, spec.id, { afterId: after.id });
  }
  const w = workflowRev(spec.workflowRev);
  const next = nextStep(w, spec.step ?? stepOf(w, 'design')?.id ?? '');
  if (next.step === null) { moveSpec(db, spec.id, 'done'); return { path: spec.path, state: 'done', after: after?.path ?? null }; }
  moveSpec(db, spec.id, 'approved');
  if (next.start === 'auto') {
    try { await d.issues.startNext(who.projectId, spec.path); } catch (err) {
      return { path: spec.path, state: 'approved', after: after?.path ?? null, text: `Chưa tự mở ${next.step.name} được (${err instanceof Error ? err.message : String(err)}): PO bấm ${w.steps.find((x) => x.id === spec.step)?.labels.start ?? 'Bắt đầu'}` };
    }
    return { path: spec.path, state: getSpec(db, spec.id)!.state, after: after?.path ?? null, next: next.step.id };
  }
  return { path: spec.path, state: 'approved', after: after?.path ?? null };
}

async function amendTool(d: ToolDeps, who: Identity, a: Args): Promise<unknown> {
  const { db, events, exec } = d.issues;
  const spec = mustSpec(db, who, a.path as string);
  refuse(checkSpecAmend(orch(db, who), spec));
  const summary = (a.summary as string).trim();
  if (!summary) throw new ToolError('spec_amend cần summary: một dòng phần bổ sung');
  const n = bumpAmend(db, spec.id);
  events.amended(getSpec(db, spec.id)!, n, summary, await headSha({ cwd: projectRoot(db, who.projectId), exec }));
  return { path: spec.path, amend_rev: n };
}

function branchTool(d: ToolDeps, who: Identity, a: Args): unknown {
  const { db } = d.issues;
  const spec = mustSpec(db, who, a.path as string);
  const branch = (a.branch as string).trim();
  if (!BRANCH.test(branch) || branch.includes('..') || branch.endsWith('.lock') || branch.endsWith('/')) {
    throw new ToolError(`"${branch}" không phải tên nhánh git hợp lệ (vd v25)`);
  }
  updateSpec(db, spec.id, { branch });
  return { path: spec.path, branch };
}

function closeTool(d: ToolDeps, who: Identity, a: Args): unknown {
  const { db, closeWhenIdle } = d.issues;
  const spec = mustSpec(db, who, a.path as string);
  refuse(checkSpecClose(orch(db, who), spec, listIssues(db, who.projectId, { specId: spec.id })));
  moveSpec(db, spec.id, 'done');
  closeWhenIdle(who.sessionId);
  return {
    path: spec.path, state: 'done',
    text: `Spec ${spec.path} đã đóng. Viết handoff (docs/HANDOFF.md: dừng ở đâu, việc tiếp theo) trong lượt này rồi dừng — phiên tự đóng khi rảnh.`,
  };
}

function outputTool(d: ToolDeps, who: Identity, a: Args): unknown {
  const { db } = d.issues;
  const spec = mustSpec(db, who, a.path as string);
  const v = validateOutputRef(projectRoot(db, who.projectId), a.ref as string);
  if (!v.ok) throw new ToolError(v.error);
  const label = typeof a.label === 'string' && a.label.trim() ? a.label.trim() : null;
  addSpecOutput(db, spec.id, { kind: v.kind, ref: v.ref, label });
  return { ok: true, path: spec.path, ref: v.ref };
}

export const SPEC_TOOLS: readonly ToolDef[] = [
  {
    name: 'spec_draft', roles: O, schema: fixed(obj(pathArg, ['path'])), run: draftTool,
    description: 'Phiên {design}: ghi {doc} vừa viết / sửa là bản nháp (draft). Gọi lại sau mỗi lần sửa lớn; tên phiên theo dòng # đầu.',
  },
  {
    name: 'spec_approve', roles: O, run: approveTool,
    description: 'Chỉ khi PO nói rõ là duyệt: sửa dòng trạng thái, commit, rồi gọi. after = {doc} phải xong trước.',
    schema: fixed(obj({ ...pathArg, after: str('đường dẫn {doc} phải xong trước') }, ['path'])),
  },
  {
    name: 'spec_amend', roles: O, run: amendTool,
    description: 'Phiên {design} đang bổ sung {doc} đang build: PO duyệt → commit phần sửa → gọi; phiên {build} nhận tin.',
    schema: fixed(obj({ ...pathArg, summary: str('một dòng phần bổ sung') }, ['path', 'summary'])),
  },
  {
    name: 'spec_set_branch', roles: O, run: branchTool, description: 'Phiên {build}: nhánh tích hợp của {doc} (vd v25).',
    schema: fixed(obj({ ...pathArg, branch: str() }, ['path', 'branch'])),
  },
  {
    name: 'spec_close', roles: O, schema: fixed(obj(pathArg, ['path'])), run: closeTool,
    description: 'Phiên {build}: đóng {doc} khi mọi mục xong / huỷ (bảng mục cuối đã ghi, file đã chuyển done/, đã merge).',
  },
  {
    name: 'spec_output_add', roles: O, run: outputTool,
    description: 'Ghi tài liệu của {doc} (mockup, ảnh, nghiên cứu, link prototype) mỗi khi tạo: file trong project hoặc link http(s).',
    schema: fixed(obj({ ...pathArg, ref: str('đường dẫn trong project hoặc URL http(s)'), label: str() }, ['path', 'ref'])),
  },
];
