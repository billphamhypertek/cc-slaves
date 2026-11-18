// v2.7 IS8 nothing yet, concept B (PO 18/11, .local/reports/tasks-empty-ux.md §4): one centred 400 px column — icon, the
// title, one line per pack, the split start, a hairline, then two labelled rows (Quy trình [chip] / Báo bug … D). A Giao
// thẳng pack has no start here (orchestrator ruling: its items come from the general session) and says so in its own line.
// While the pack rev is read the button's place holds a skeleton of its size and the line keeps its height (no jump);
// offline the start stays visible, disabled, with its LockTip reason. hf-sp: a project given Giao thẳng because the default
// pack's plugin was not on says why in one neutral line under the rows.
import type { ReactElement } from 'react';
import { useT } from '../lib/i18n.tsx';
import { Icon } from '../ui/icons.tsx';
import { SplitStart } from './SplitStart.tsx';
import type { TasksCtx } from './tasks-ctx.ts';
import { WfChip } from './WfChip.tsx';

export interface EmptyStartProps {
  /** null = no project data yet (no chip row) */
  c: TasksCtx | null;
  /** the pack rev is still being read: skeleton in the start's place */
  wait: boolean;
  /** why the start is locked (IS8c), null = it runs */
  off: string | null;
  /** main part = start now with the defaults; ▾ = the start dialog */
  onStart: () => void; onPick: () => void;
}

export function EmptyStart(p: EmptyStartProps): ReactElement {
  const tr = useT();
  const docless = !p.wait && (p.c?.wf.slots.docless ?? false);
  const name = tr('tasks.empty.newSpec');
  return (
    <div className="tstart"><div className="col">
      <Icon n="listChecks" s={30} />
      <h2>{tr('tasks.empty.title')}</h2>
      <p className="lede">{p.wait ? '\u00a0' : tr(docless ? 'tasks.empty.subDirect' : 'tasks.empty.sub')}</p>
      {p.wait ? <span className="sk skbtn" /> : docless ? null
        : <SplitStart cls="tbtn" label={<><Icon n="plus" s={14} />{name}</>} name={name} off={p.off} onStart={p.onStart} onPick={p.onPick} />}
      <hr />
      <dl>
        {p.c ? <><dt>{tr('tasks.empty.wf')}</dt><dd><WfChip c={p.c} /></dd></> : null}
        {docless ? <><dt>{tr('tasks.empty.deck')}</dt><dd><kbd>D</kbd></dd></>
          : <><dt>{tr('tasks.empty.bug')}</dt><dd>{tr('tasks.empty.bugHow')}<kbd>D</kbd></dd></>}
      </dl>
      {p.c?.wf.fallback ? <p className="wfwhy">{tr('tasks.wf.fallback', { plugin: p.c.wf.fallback })}</p> : null}
    </div></div>
  );
}
