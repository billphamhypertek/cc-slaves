// spec v2.9 §4.2 / §4.6 / §6.2 the Quy trình screen's state: the open pack (the files as opened = `base`, the files on the canvas = `files`, each change applied by the engine through
// `workflow_edit` in order), dirty, save with its conflict (WF5c), and the silent reload when the files changed on disk while
// the canvas holds no change (§5.4 "khi file trên đĩa đổi").
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Command } from '../../../shared/protocol.ts';
import type { WorkflowDetail, WorkflowEdit, WorkflowEditResult, WorkflowRow, WorkflowSaveResult } from '../../../shared/workflows.ts';
import { sameFiles, wfModel, type WfModel } from '../lib/workflow.ts';
import { CommandError } from '../lib/ws.ts';

type Files = Record<string, string>;
export interface OpenPack {
  id: string;
  /** the files as opened / last saved (dirty = the canvas differs) and their disk rev (`baseRev` of the save) */
  base: Files; baseRev: string;
  files: Files; res: WorkflowEditResult; m: WfModel;
}
export type SaveOutcome = 'saved' | 'errors' | 'conflict' | 'failed';

export interface PackDeps {
  send: (c: Command) => Promise<unknown>;
  /** the library rows: the Mac snapshot's `workflows`, replaced by each `workflows_changed` (store); null = not read yet */
  rows: WorkflowRow[] | null;
  fail: (e: unknown) => void;
}

export function usePack(d: PackDeps) {
  const { send, rows, fail } = d;
  const [pack, setPack] = useState<OpenPack | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const cur = useRef<OpenPack | null>(null);
  cur.current = pack;
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const read = useCallback(async (id: string): Promise<OpenPack> => {
    const det = await send({ cmd: 'workflow_get', id }) as WorkflowDetail;
    const res = await send({ cmd: 'workflow_edit', files: det.files, edits: [] }) as WorkflowEditResult;
    return { id, base: det.files, baseRev: det.rev, files: res.files, res, m: wfModel(res.docs) };
  }, [send]);

  /** Open a pack (null = none); resolves false when it could not be read. */
  const open = useCallback(async (id: string | null): Promise<boolean> => {
    if (id === null) { setPack(null); return true; }
    setOpening(id);
    try { setPack(await read(id)); return true; } catch (e) { fail(e); return false; } finally { setOpening(o => (o === id ? null : o)); }
  }, [read, fail]);

  /** Apply canvas edits in order (each on the files the previous one left); the refused keys come back in `failed`. */
  const edit = useCallback((edits: WorkflowEdit[]): Promise<WorkflowEditResult | null> => {
    const run = async () => {
      const p = cur.current;
      if (!p) return null;
      const res = await send({ cmd: 'workflow_edit', files: p.files, edits }) as WorkflowEditResult;
      const next = { ...p, files: res.files, res, m: wfModel(res.docs) };
      cur.current = next;
      setPack(q => (q && q.id === p.id ? next : q));
      return res;
    };
    const r = queue.current.then(run, run).catch((e: unknown) => { fail(e); return null; });
    queue.current = r;
    return r;
  }, [send, fail]);

  /** Bỏ thay đổi: back to the files as opened. */
  const discard = useCallback(async () => {
    const p = cur.current;
    if (!p) return;
    const res = await send({ cmd: 'workflow_edit', files: p.base, edits: [] }) as WorkflowEditResult;
    setPack({ ...p, files: res.files, res, m: wfModel(res.docs) });
  }, [send]);

  /** Lưu; `force` = Ghi đè (WF5c) over the files now on disk (`row.diskRev`). */
  const save = useCallback(async (force?: string): Promise<SaveOutcome> => {
    await queue.current;
    const p = cur.current;
    if (!p) return 'failed';
    setSaving(true);
    try {
      const r = await send({ cmd: 'workflow_save', id: p.id, files: p.files, baseRev: force ?? p.baseRev }) as WorkflowSaveResult;
      if (!r.saved) return 'errors';
      const next = { ...p, base: p.files, baseRev: r.row?.diskRev ?? p.baseRev };
      cur.current = next;
      setPack(next);
      return 'saved';
    } catch (e) {
      if (e instanceof CommandError && e.code === 'workflow_conflict') return 'conflict';
      fail(e);
      return 'failed';
    } finally { setSaving(false); }
  }, [send, fail]);

  const row = useMemo(() => (pack && rows ? rows.find(r => r.id === pack.id) ?? null : null), [pack, rows]);
  const dirty = !!pack && !sameFiles(pack.files, pack.base);

  // §5.4 the files changed on disk (VS Code, git) while the canvas holds no change → read them again, no question asked
  useEffect(() => {
    if (!pack || !row || row.builtin || dirty || row.diskRev === pack.baseRev) return;
    read(pack.id).then(p => setPack(q => (q && q.id === p.id && sameFiles(q.files, q.base) ? p : q)), fail);
  }, [pack, row, dirty, read, fail]);
  // the open pack left the library (deleted outside the app) → nothing open
  useEffect(() => { if (pack && rows && !rows.some(r => r.id === pack.id)) setPack(null); }, [pack, rows]);

  return { rows, pack, row, dirty, opening, saving, open, edit, discard, save };
}
export type PackApi = ReturnType<typeof usePack>;
