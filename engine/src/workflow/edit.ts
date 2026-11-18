// spec v2.9 §10.2 the canvas edits a pack by key: the web sends the files it holds + the changes (a frontmatter key, a body,
// a whole file); the engine applies each through `patch.ts` (only that key's line / block changes, A6), then answers the
// new files, each md file read back (frontmatter table, body, the keys the canvas may not rewrite, §4.3 "sửa trong file")
// and the §5.4 findings. Nothing is written to disk here: `workflow_save` writes.
import type { WorkflowDocView, WorkflowEdit, WorkflowEditResult } from '../../../shared/workflows.ts';
import { splitFrontmatter, type PackFiles } from './pack.ts';
import { patchBody, patchFrontmatter, readOnlyKeys } from './patch.ts';
import { validatePack, type ValidateEnv } from './validate.ts';

/** One md file read back for the canvas; `fm` null = its YAML does not parse (the panel shows it read-only). */
function docView(text: string): WorkflowDocView {
  const s = splitFrontmatter(text);
  if (!s) return { fm: null, body: text, readOnly: [] };
  let fm: Record<string, unknown> | null = null;
  try {
    const v: unknown = s.yaml.trim() === '' ? {} : Bun.YAML.parse(s.yaml);
    fm = typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : v == null ? {} : null;
  } catch { fm = null; }
  return { fm, body: s.body, readOnly: fm ? readOnlyKeys(text) : [] };
}

/** Apply the edits in order; a key `patch.ts` refuses is reported in `failed` and leaves its file unchanged. */
export function applyEdits(files: PackFiles, edits: readonly WorkflowEdit[], env: ValidateEnv = {}): WorkflowEditResult {
  const out: PackFiles = { ...files };
  const failed: WorkflowEditResult['failed'] = [];
  for (const e of edits) {
    if ('text' in e) {
      if (e.text === null) delete out[e.path]; else out[e.path] = e.text;
      continue;
    }
    const cur = out[e.path] ?? '';
    if ('body' in e) { out[e.path] = patchBody(cur, e.body); continue; }
    const r = patchFrontmatter(cur, e.key, e.value ?? undefined);
    if (r.ok) out[e.path] = r.text; else failed.push({ path: e.path, key: e.key, reason: r.reason });
  }
  const checked = validatePack(out, env);
  const docs: Record<string, WorkflowDocView> = {};
  for (const [p, text] of Object.entries(out)) if (p.endsWith('.md')) docs[p] = docView(text);
  return { files: out, docs, errors: checked.errors, warnings: checked.warnings, failed };
}
