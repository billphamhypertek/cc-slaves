// spec v2.9 §4.10 the open author draft on the canvas: its files (pushed by `workflow_draft`) read back through `workflow_edit`
// (the same model the pack canvas draws), the files it opened with (for the struck removed nodes), and a hand edit = `workflow_draft_patch`.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Command } from '../../../shared/protocol.ts';
import type { DraftView, WorkflowEdit, WorkflowEditResult } from '../../../shared/workflows.ts';
import { wfModel, type WfModel } from '../lib/workflow.ts';

export interface DraftPack { id: string; files: Record<string, string>; res: WorkflowEditResult; m: WfModel; baseM: WfModel | null }

const read = async (send: (c: Command) => Promise<unknown>, files: Record<string, string>): Promise<WorkflowEditResult> =>
  await send({ cmd: 'workflow_edit', files, edits: [] }) as WorkflowEditResult;

export function useDraft(send: (c: Command) => Promise<unknown>, draft: DraftView | null, fail: (e: unknown) => void) {
  const [pack, setPack] = useState<DraftPack | null>(null);
  const files = draft?.files;
  const base = draft?.base;
  const id = draft?.id ?? null;
  // the base model only changes with the draft (or an undo of a save)
  const baseM = useRef<{ id: string; m: WfModel | null } | null>(null);
  useEffect(() => {
    if (!id || !files || !base) { setPack(null); return; }
    let live = true;
    void (async () => {
      const res = await read(send, files);
      if (baseM.current?.id !== id) baseM.current = { id, m: Object.keys(base).length ? wfModel((await read(send, base)).docs) : null };
      if (live) setPack({ id, files, res, m: wfModel(res.docs), baseM: baseM.current.m });
    })().catch(fail);
    return () => { live = false; };
  }, [id, files, base, send, fail]);

  const patch = useCallback(async (edits: WorkflowEdit[]): Promise<WorkflowEditResult | null> => {
    if (!id) return null;
    try { return await send({ cmd: 'workflow_draft_patch', draftId: id, edits }) as WorkflowEditResult; } catch (e) { fail(e); return null; }
  }, [id, send, fail]);

  return { pack: pack && pack.id === id ? pack : null, patch };
}
