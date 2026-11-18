// PO 2026-11-16 "làm như VS Code": "Thêm project" = the macOS folder panel at once, the chosen folder is added under its
// folder name and selected; a folder that already is a project is simply selected. No dialog to fill, nothing to type.
// Hot fix 2026-11-17: the panel is the app's own (`pickFolder`, instant), and a progress dialog shows each step — a spinner
// at the start of the running row, a green tick when done — so the deck is never left looking idle while work runs.
// `addOpen` = this flow is running (or its failure is on screen), so the deck keys stay off meanwhile.
import { useEffect, useState, type MutableRefObject } from 'react';
import type { Command, ProjectView, Snapshot } from '../../../shared/protocol.ts';
import { projectName } from '../lib/accounts.ts';
import { errText, useT } from '../lib/i18n.tsx';
import { pickFolder } from '../lib/pick-folder.ts';
import type { Store } from '../lib/store.ts';

export type StepState = 'wait' | 'run' | 'ok' | 'bad';
export interface AddStep { key: 'pick' | 'add' | 'open'; st: StepState; label: string; note: string | null }

/** The three rows: `pick` (the panel), `add` (`project_add`, or "đã có sẵn"), `open` (the project is in the deck). */
export const addSteps = (s: { pick: StepState; add: StepState; open: StepState; path: string | null; name: string | null; known: boolean; err: string | null },
  tr: ReturnType<typeof useT>): AddStep[] => {
  const failed = (st: StepState) => (st === 'bad' ? s.err : null);
  return [
    { key: 'pick', st: s.pick, label: tr('addProject.pick'), note: s.pick === 'run' ? tr('addProject.picking') : failed(s.pick) ?? s.path },
    { key: 'add', st: s.add, label: s.name ? tr(s.known ? 'addProject.known' : 'addProject.add', { name: s.name }) : tr('addProject.title'), note: failed(s.add) },
    { key: 'open', st: s.open, label: tr('addProject.open'), note: failed(s.open) },
  ];
};

type Run = Parameters<typeof addSteps>[0];
const START: Run = { pick: 'run', add: 'wait', open: 'wait', path: null, name: null, known: false, err: null };
const busy = (r: Run) => [r.pick, r.add, r.open].includes('run');
/** How long the all-ticked dialog stays before it closes itself (the PO sees every step finish). */
const DONE_HOLD_MS = 450;

/** The `project` event lands before the command's reply; past this the open step fails instead of spinning forever. */
const SHOWN_MS = 10_000;

/** Resolves once the store's snapshot shows the project; rejects after SHOWN_MS. */
function shown(store: Store, id: string, slow: string): Promise<void> {
  return new Promise((res, rej) => {
    const has = () => !!store.get().snap?.projects.some(p => p.id === id);
    if (has()) return res();
    const off = store.subscribe(() => { if (has()) { clearTimeout(t); off(); res(); } });
    const t = setTimeout(() => { off(); rej(new Error(slow)); }, SHOWN_MS);
  });
}

/**
 * `esc` = the window Esc while this flow owns it (like Skills & MCP's `smEsc`): ignored while a step runs (the flow closes
 * itself), closes a failure.
 */
export function useAddProject(o: {
  open: boolean; done: () => void; select: (id: string) => void; snap: Snapshot; send: (c: Command) => Promise<unknown>; store: Store;
  esc: MutableRefObject<(() => void) | null>;
}): { run: Run | null; close: () => void } {
  const tr = useT();
  const { open } = o;
  const [run, setRun] = useState<Run | null>(null);
  const close = () => { o.esc.current = null; setRun(null); o.done(); };
  useEffect(() => {
    if (!open) return;
    let cur = START;
    const set = (p: Partial<Run>) => { cur = { ...cur, ...p }; setRun(cur); };
    setRun(cur);
    o.esc.current = () => { if (!busy(cur)) close(); };
    void (async () => {
      let step: 'pick' | 'add' | 'open' = 'pick';
      try {
        const path = await pickFolder(o.send, tr('labels.pickRepo'));
        if (!path) return close();
        const live = o.store.get().snap ?? o.snap; // a project closed / added while the panel was open counts
        const known = live.projects.find(x => x.path === path);
        const name = known?.name ?? projectName(path, live.projects.map(x => x.name));
        step = 'add';
        set({ pick: 'ok', path, name, known: !!known, add: 'run' });
        const id = known ? known.id : ((await o.send({ cmd: 'project_add', name, path })) as ProjectView).id;
        step = 'open';
        set({ add: 'ok', open: 'run' });
        await shown(o.store, id, tr('addProject.openSlow'));
        o.select(id);
        set({ open: 'ok' });
        setTimeout(close, DONE_HOLD_MS);
      } catch (e) {
        set({ [step]: 'bad', err: errText(tr, e) || tr('addProject.failed') }); // stays on screen with "Đóng" / Esc
      }
    })();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- one run per click; the latest snapshot is read inside
  return { run, close };
}
