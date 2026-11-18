// The composer's local commands (/lanes, /quota, /handoff, /new): answered in the stream by the shell itself.
import type { Command, LaneView, ProjectView, Snapshot, Target } from '../../../shared/protocol.ts';
import { chipLine, fmtResetTime, resetAt, shortEmail } from '../lib/format.ts';
import type { Tr } from '../lib/i18n.tsx';
import { laneState, phaseName } from '../lib/labels.ts';
import type { Store } from '../lib/store.ts';

export type LocalCmd = 'lanes' | 'quota' | 'handoff' | 'new';
interface LocalCtx {
  target: Target | null; pid: string | null; snap: Snapshot | null; project: ProjectView | null; lanes: LaneView[];
  store: Store; tr: Tr; send: (c: Command) => Promise<unknown>;
}

export function runLocal(cmd: LocalCmd, c: LocalCtx): void {
  const { target, pid, snap, project, lanes, store, tr, send } = c;
  if (!target || !pid || !snap) return;
  const out = (text: string) => store.localLine(target, { kind: 'engine', text });
  if (cmd === 'lanes') {
    out(tr('app.local.lanes', { n: lanes.length, project: project!.name }));
    lanes.forEach(l => out(`${l.name} · ${laneState(tr, l.state)}${l.phase ? ' · ' + phaseName(tr, l.phase) : ''}${l.task ? ' · ' + l.task : ''}${l.account ? ' · ' + shortEmail(l.account) : ''}`));
  } else if (cmd === 'quota') {
    snap.accounts.forEach(a => { const r = fmtResetTime(resetAt(a)), c = chipLine(a, Date.now(), tr); out(`${shortEmail(a.email)} · ${c.main} ${c.rest}${r ? ' · ' + tr('unit.resetAt', { when: r }) : ''}`); });
  } else if (cmd === 'handoff') {
    void send({ cmd: 'stop_all', projectId: pid }).then(() => out(tr('app.local.handoff', { n: lanes.length }))).catch(() => {});
  } else {
    void send({ cmd: 'orchestrator_new', projectId: pid }).then(() => out(tr('app.local.new'))).catch(() => {});
  }
}
