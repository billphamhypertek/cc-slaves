// v2.9 §4.7 / §10.2 the revs the Tasks tab reads (`workflow_get {rev}`): the project's workflow now and the rev each open
// spec is pinned to. A rev never changes, so a read is kept for the page's life; `null` = no steps (an invalid / lost rev,
// the tab falls back to the catalog words). `loading` while a rev it needs has not answered (the rail skeleton).
import { useEffect, useState } from 'react';
import type { Command } from '../../../shared/protocol.ts';
import type { WorkflowDetail } from '../../../shared/workflows.ts';
import type { WfDoc } from '../lib/wf-tasks.ts';

const docs = new Map<string, WfDoc | null>();
const pending = new Map<string, Promise<void>>();
/** Reads that failed (engine down): the tab shows the catalog words and asks again on the next connection. */
const failed = new Set<string>();

/** One `workflow_get` per rev for the page's life (a refused / unknown rev = null; a failed send asks again later). */
function ask(send: (c: Command) => Promise<unknown>, rev: string): Promise<void> {
  const p = send({ cmd: 'workflow_get', rev }).then(
    r => { const d = r as WorkflowDetail | null; docs.set(rev, d?.steps ? { rev, name: d.name, docLabel: d.docLabel, steps: d.steps } : null); failed.delete(rev); },
    () => { failed.add(rev); },
  ).finally(() => pending.delete(rev));
  pending.set(rev, p);
  return p;
}

/** `online` false → nothing is asked (IS8c); going back online asks again what failed. */
export function useWfDocs(send: (c: Command) => Promise<unknown>, revs: readonly string[], online: boolean): { docs: ReadonlyMap<string, WfDoc>; loading: boolean } {
  const [, bump] = useState(0);
  const key = [...new Set(revs)].sort().join(',');
  useEffect(() => {
    if (!online || !key) return;
    let live = true;
    const want = key.split(',').filter(r => !docs.has(r));
    if (want.length) void Promise.all(want.map(r => pending.get(r) ?? ask(send, r))).then(() => { if (live) bump(n => n + 1); });
    return () => { live = false; };
  }, [key, send, online]);
  const out = new Map<string, WfDoc>();
  for (const r of revs) { const d = docs.get(r); if (d) out.set(r, d); }
  return { docs: out, loading: online && revs.some(r => !docs.has(r) && !failed.has(r)) };
}
