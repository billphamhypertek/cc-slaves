// v2.5 §6 the Graph code tab (GR1 and its states), GR-upd and GR-clean: pure logic over the engine's GraphView (shared/graph.ts).
// A param shown mono travels inside the text between two \u0001 marks, a command / name shown as a chip between two \u0002
// marks (`codeParts` splits it for the component).
import type { GraphImpact, GraphProjectView, GraphToolView, GraphView } from '../../../shared/graph.ts';
import { fmtNum, type Tr } from '../../../shared/i18n/core.ts';
import { fmtClock, fmtHmDay } from './format.ts';

const MB = 1024 ** 2, GB = 1024 ** 3;
const CODE = '\u0001', CHIP = '\u0002';
/** A param the component shows mono (a version, an error line). */
export const code = (s: string): string => `${CODE}${s}${CODE}`;
/** A command or a name the component shows as a code chip (§6.1 mockup `<code>`: `/plugin`, `sudo xcodebuild -license`). */
export const chip = (s: string): string => `${CHIP}${s}${CHIP}`;
/** `text` cut at the marks: plain text, mono code, chips. */
export function codeParts(text: string): { k: 'txt' | 'code' | 'chip'; s: string }[] {
  const out: { k: 'txt' | 'code' | 'chip'; s: string }[] = [];
  let k: 'txt' | 'code' | 'chip' = 'txt', s = '';
  for (const ch of text) {
    const mark = ch === CODE ? 'code' : ch === CHIP ? 'chip' : null;
    if (mark === null || (k !== 'txt' && k !== mark)) { s += ch; continue; }
    if (s) out.push({ k, s });
    k = k === 'txt' ? mark : 'txt'; s = '';
  }
  if (s) out.push({ k, s });
  return out;
}

/** §6 sizes as the mockup prints them: "10,0 GB", "101 MB", "7,5 MB" (binary units, the language decimal mark). */
export function fmtSize(tr: Pick<Tr, 'lang'>, bytes: number): string {
  if (bytes >= GB) return `${fmtNum(tr.lang, bytes / GB, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GB`;
  const mb = bytes / MB;
  return `${fmtNum(tr.lang, mb, { maximumFractionDigits: mb > 0 && mb < 10 ? 1 : 0 })} MB`;
}

/** What the tab shows: GR-run while a run is on, GR0 / GR0-old, else the project list (GR1, GR-err). */
export type GraphMode = 'run' | 'missing' | 'old' | 'list';
export const graphMode = (t: GraphToolView): GraphMode => t.run ? 'run' : t.state === 'missing' || t.state === 'installing' ? 'missing' : t.state === 'old' ? 'old' : 'list';

/** The tab's count: the projects, only where the tab lists them (none on GR0 / GR0-old / GR-run). */
export const tabCount = (v: GraphView | undefined): number | null => (v && graphMode(v.tool) === 'list' ? v.projects.length : null);

/** GR1 summary — the sum of every row and lane line below it; a stale or re-running index still counts as indexed. */
export function summary(rows: readonly GraphProjectView[]): { n: number; indexed: number; bytes: number } {
  let indexed = 0, bytes = 0;
  for (const p of rows) {
    if (p.nodes !== undefined && p.state !== 'failed') indexed++;
    if (p.state !== 'failed') bytes += p.bytes ?? 0;
    bytes += p.lanes.bytes;
  }
  return { n: rows.length, indexed, bytes };
}

export type RowAct = 'index' | 'reindex' | 'retry' | 'stop';
export interface RowStatus {
  cls: 'ok' | 'na' | 'old' | 'bad' | 'run' | 'q' | 'off';
  text: string;
  /** Shown after the status (ready / stale). */
  metrics: string | null;
  /** The previous numbers, muted on the second line (running, off). */
  old: string | null;
  act: RowAct | null;
}

const metricsOf = (tr: Tr, p: GraphProjectView): string | null => p.nodes === undefined ? null
  : tr('graph.metrics', { nodes: fmtNum(tr.lang, p.nodes), size: fmtSize(tr, p.bytes ?? 0), at: p.indexedAt ? fmtHmDay(p.indexedAt) : '—' });

/** §6.1 GR1 / GR1-run / -q / GR1-states / GR1-offp: one project row's status and its one button. */
export function rowStatus(tr: Tr, p: GraphProjectView, all: readonly GraphProjectView[], now: number): RowStatus {
  const m = metricsOf(tr, p);
  const s = (cls: RowStatus['cls'], text: string, act: RowAct | null, metrics: string | null = null, old: string | null = null): RowStatus => ({ cls, text, metrics, old, act });
  if (!p.on) return s('off', tr('graph.st.off'), null, null, m);
  switch (p.state) {
    case 'ready': return s('ok', tr('graph.st.ready'), 'reindex', m);
    case 'stale': return s('old', tr('graph.st.stale'), 'reindex', m);
    case 'none': return s('na', tr('graph.st.none'), 'index');
    case 'failed': return s('bad', tr('graph.st.failed', { line: p.error ?? '' }), 'retry');
    case 'queued': {
      const cur = all.find(x => x.state === 'running');
      return s('q', cur ? tr('graph.st.queued', { name: chip(cur.name) }) : tr('graph.st.queuedBare'), 'stop');
    }
    case 'running':
      if (p.stopping) return s('run', tr('graph.st.stopping'), null, null, m);
      if (p.overdue) return s('run', tr('graph.st.overdue'), p.byTool ? null : 'stop', null, m);
      return s('run', tr('graph.st.running', { t: fmtClock(p.startedAt === undefined ? 0 : now - p.startedAt) }), p.byTool ? null : 'stop', null, m);
  }
}

/** GR1 second line: lane dirs (when any) and the not-git note (GR1-nogit). */
export const subLine = (tr: Tr, p: GraphProjectView): string[] => [
  p.lanes.n ? tr('graph.sub.lanes', { n: p.lanes.n, size: fmtSize(tr, p.lanes.bytes) }) : '',
  p.git ? '' : tr('graph.sub.nogit'),
].filter(Boolean);

/** §6.1 GR1 last line / GR1-noorph / GR-clean-run / -done / -fail; null when the tool has not listed its indexes yet. */
export type LastLine = { k: 'orph' | 'none' | 'run' | 'done' | 'fail' | 'err'; text: string };
export function lastLine(tr: Tr, t: GraphToolView): LastLine | null {
  const c = t.clean;
  const total = t.indexes ? { total: fmtNum(tr.lang, t.indexes.n), tsize: fmtSize(tr, t.indexes.bytes) } : null;
  if (c?.state === 'running') return { k: 'run', text: tr('graph.last.run', { done: c.done, total: c.total }) };
  if (c?.state === 'done') {
    const n = c.done - c.failed, size = fmtSize(tr, c.freedBytes);
    if (c.failed) return { k: 'fail', text: c.error ? tr('graph.last.fail', { n, size, f: c.failed, line: c.error }) : tr('graph.last.failBare', { n, size, f: c.failed }) };
    if (c.error) return { k: 'err', text: tr('graph.last.err', { line: c.error }) };
    return { k: 'done', text: total ? tr('graph.last.done', { n, size, ...total }) : tr('graph.last.doneBare', { n, size }) };
  }
  if (!t.indexes) return null;
  const base = { n: fmtNum(tr.lang, t.indexes.n), size: fmtSize(tr, t.indexes.bytes) };
  return t.orphans?.n ? { k: 'orph', text: tr('graph.last.orph', { ...base, o: fmtNum(tr.lang, t.orphans.n), osize: fmtSize(tr, t.orphans.bytes) }) }
    : { k: 'none', text: tr('graph.last.total', base) };
}

export type ImpactIcon = 'db' | 'fork' | 'term' | 'cpu' | 'lock';
/** §6.1 GR-upd: one line per real number (zero lines dropped), worded by where the update starts (`old` / `ready`). */
export function impactLines(tr: Tr, i: GraphImpact, from: 'old' | 'ready', version: string): { i: ImpactIcon; text: string }[] {
  const old = from === 'old';
  const lines: { i: ImpactIcon; text: string }[] = [];
  if (i.indexes.n) lines.push({ i: 'db', text: tr('graph.upd.indexes', { n: fmtNum(tr.lang, i.indexes.n), size: fmtSize(tr, i.indexes.bytes) }) });
  if (i.lanesRunning) lines.push({ i: 'fork', text: tr(old ? 'graph.upd.lanesOld' : 'graph.upd.lanesReady', { n: i.lanesRunning, v: version }) });
  if (i.processes.sessions) lines.push({ i: 'term', text: tr(old ? 'graph.upd.sessionsOld' : 'graph.upd.sessionsReady', { n: i.processes.sessions, v: version }) });
  if (i.processes.other) lines.push({ i: 'cpu', text: tr(old ? 'graph.upd.otherOld' : 'graph.upd.otherReady', { n: i.processes.other }) });
  lines.push({ i: 'lock', text: tr(old ? 'graph.upd.keep' : 'graph.upd.keepReady', { path: code('~/.claude') }) });
  return lines;
}
