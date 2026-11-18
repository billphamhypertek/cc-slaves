// v2.5 §5.8 the Graph code commands (Mac only: none is in REMOTE_ALLOWED, N7). Install / update / clean ack the view and
// go on in the background (progress and the result reach the Mac as `graph`); one install at a time for the Bộ công cụ
// and the graph tool (§5.6 last line).
import type { GraphView } from '../../../shared/graph.ts';
import type { Engine } from '../engine.ts';
import type { GraphModule } from '../graph/module.ts';
import { CommandError, type Handlers } from './router.ts';

type GraphCmd = 'graph_check' | 'graph_install' | 'graph_update' | 'graph_retry' | 'graph_impact' | 'graph_index' | 'graph_index_stop' | 'graph_orphans' | 'graph_clean' | 'graph_toggle';

export function graphHandlers(e: Engine): Pick<Handlers, GraphCmd> {
  const g = (): GraphModule => {
    if (!e.graphModule) throw new CommandError('graph_off', { key: 'errors.graphOff' });
    return e.graphModule;
  };
  const project = (id: unknown): string => {
    if (typeof id !== 'string' || !e.projectRows().some((p) => p.id === id)) throw new CommandError('bad_input', { key: 'errors.graphProject', params: { id: String(id) } });
    return id;
  };
  const run = (kind: 'install' | 'update', allowed: readonly string[]): GraphView => {
    const m = g();
    if (m.busy() || e.toolkit.view().busy !== undefined || e.toolkit.view().rows.some((r) => r.state === 'running')) throw new CommandError('busy', { key: 'errors.graphBusy' });
    const state = m.state();
    if (!allowed.includes(state)) throw new CommandError('bad_state', { key: 'errors.graphState', params: { state } });
    m.install(kind).catch((err: unknown) => e.log(`graph ${kind}: ${err instanceof Error ? err.message : String(err)}`));
    return m.view();
  };
  return {
    graph_check: (c) => g().check(c.force === true),
    graph_install: () => run('install', ['missing']),
    graph_update: () => run('update', ['old', 'ready', 'error']),
    graph_retry: () => { g().retry(); return g().view(); },
    graph_impact: () => g().impact(),
    graph_index: (c) => {
      if (!g().index(project(c.projectId))) throw new CommandError('bad_state', { key: 'errors.graphDown' });
      return g().view();
    },
    graph_index_stop: (c) => { g().stop(project(c.projectId)); return g().view(); },
    graph_orphans: () => {
      if (g().state() !== 'ready') throw new CommandError('bad_state', { key: 'errors.graphDown' });
      return g().orphans();
    },
    graph_clean: (c) => {
      if (!Array.isArray(c.roots) || !c.roots.every((r) => typeof r === 'string')) throw new CommandError('bad_input', { key: 'errors.graphRoots' });
      if (g().state() !== 'ready') throw new CommandError('bad_state', { key: 'errors.graphDown' });
      g().clean(c.roots);
      return g().view();
    },
    graph_toggle: (c) => {
      const id = project(c.projectId);
      if (typeof c.on !== 'boolean') throw new CommandError('bad_input', { key: 'errors.graphProject', params: { id } });
      const rest = e.config.graph.offProjects.filter((x) => x !== id);
      e.skillsMcp.setConfig({ ...e.config, graph: { offProjects: c.on ? rest : [...rest, id] } });
      if (c.on) e.graphProjectOn(id); // §5.5 "bật graph cho project": its root is indexed when it has none
      return g().view();
    },
  };
}
