// spec v2.7 §4.1 / §10.2 the Tasks root: the first screen, mounted at once (Mac channel only, §8). v2.3 §4.1 / §10.1 the Code
// and Git roots in the deck area: each its own lazy chunk (not first paint, §10.3), mounted the first time its mode shows
// (the Deck likewise, in App). Then only hidden (`visibility: hidden`), never unmounted: edit buffers and the tree state live
// across mode switches (§5.3), like the deck under the F9 list.
import { lazy, Suspense, useEffect, useState, type MutableRefObject, type ReactElement } from 'react';
import type { Command, EngineEvent, LaneView, OrchestratorView } from '../../../shared/protocol.ts';
import type { Selection } from '../lib/inspector.ts';
import type { CodeKey, Mode } from '../lib/keys.ts';
import type { CodeApi } from '../code/CodeView.tsx';
import type { GitHost } from '../git/GitView.tsx';
import { TasksRoot, type TasksRootProps } from '../tasks/TasksRoot.tsx';

const CodeView = lazy(() => import('../code/CodeView.tsx').then(m => ({ default: m.CodeView })));
const GitView = lazy(() => import('../git/GitView.tsx').then(m => ({ default: m.GitView })));

export interface ModeRootsProps {
  mode: Mode; sel: Selection; lanes: readonly LaneView[]; orchestrators: readonly OrchestratorView[]; project: { id: string; path: string }; narrow: boolean;
  /** the engine client's raw `send` (Code reads show their errors in place) and the toasting `send` (VS Code) */
  rawSend: (c: Command) => Promise<unknown>; send: (c: Command) => Promise<unknown>;
  codeReq: { k: CodeKey; n: number } | null; codeApi: MutableRefObject<CodeApi | null>;
  /** v2.3 §6 the Git view's reads and actions (null until a project is picked) */
  git: GitHost | null;
  /** v2.3 §10.2 the last `code_changed` */
  codeEv: { e: Extract<EngineEvent, { type: 'code_changed' }>; n: number } | null;
  /** v2.3 §7 C16 the engine is unreachable, and the time of the data shown */
  offline: boolean; dataAt: number | null;
  /** §5.3 C8 "Nhắn D15…" */
  askLane: (lane: string, text: string) => void;
  /** v2.7 the Tasks root's data (null = no Tasks tab: remote channel) */
  tasks: Omit<TasksRootProps, 'shown' | 'offline' | 'dataAt' | 'send' | 'sessions' | 'project'> & { project: { name: string } } | null;
}

export function ModeRoots(p: ModeRootsProps): ReactElement {
  const [seen, setSeen] = useState({ code: p.mode === 'code', git: p.mode === 'git' });
  const { rawSend, send } = p;
  useEffect(() => { if (p.mode === 'code' || p.mode === 'git') setSeen(s => (s[p.mode as 'code' | 'git'] ? s : { ...s, [p.mode]: true })); }, [p.mode]);
  return (<>
    {p.tasks ? <TasksRoot {...p.tasks} project={{ ...p.project, name: p.tasks.project.name }} sessions={p.orchestrators.filter(o => o.projectId === p.project.id)}
      shown={p.mode === 'tasks'} offline={p.offline} dataAt={p.dataAt} send={send} /> : null}
    <Suspense fallback={null}>
      {seen.code ? <CodeView shown={p.mode === 'code'} sel={p.sel} lanes={p.lanes} orchestrators={p.orchestrators} project={p.project} narrow={p.narrow} rawSend={rawSend}
        openVscode={(src, path) => void send({ cmd: 'open_in_vscode', projectId: p.project.id, src, path }).catch(() => {})} askLane={p.askLane} req={p.codeReq} codeEv={p.codeEv} api={p.codeApi}
        offline={p.offline} dataAt={p.dataAt} /> : null}
      {seen.git && p.git ? <GitView key={p.git.projectId} shown={p.mode === 'git'} sel={p.sel} lanes={p.lanes} host={p.git} /> : null}
    </Suspense>
  </>);
}
