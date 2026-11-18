// v2.7 §4.2 / §4.5 / §5.0 the traces of issues and specs on the Deck, as pure data: what a Deck click asks the Tasks tab to
// show (`TasksGo`), the issue a lane holds (chip + line 2), the short spec name ("v2.5"), the orchestrator session kind
// label ("Build · v2.5" / "Thiết kế" / "Chung"), and issue keys inside chat text (IS7). No React, no DOM.
import { parseIssueKey, type IssueInfo, type OrchKind, type ProjectIssues } from '../../../shared/issues.ts';
import type { OrchestratorView } from '../../../shared/protocol.ts';
import type { Tr } from './i18n.tsx';
import { isArising, type SpecSel, type TasksUi } from './issues.ts';

/** Deck → Tasks (§4.2 head strip / lane chip / Chờ PO card, §4.5 chat link): what the tab shows. `n` changes on every
 *  request (the same target twice still applies); `arising` = the list filtered to Phát sinh (≥ 2 unseen, IS3b). */
export interface TasksGo { n: number; sel?: SpecSel; issue?: string | null; arising?: boolean }
export type TasksAsk = Omit<TasksGo, 'n'>;

/** What a Deck request changes in the tab's remembered choice: its spec / issue when given; the Phát sinh filter only when
 *  asked (IS3b), any other trace clears it. */
export const goPatch = (g: TasksAsk): Partial<TasksUi> =>
  ({ ...(g.sel ? { sel: g.sel } : {}), ...(g.issue !== undefined ? { issue: g.issue } : {}), arising: !!g.arising });

/** The issue's spec (or Ngoài spec) with the issue open; an unknown key → the tab as it was. */
export function goIssue(pi: ProjectIssues | null, key: string): TasksAsk {
  const i = pi?.issues.find(x => x.key === key);
  return i ? { sel: i.specId === null ? 'outside' : { spec: i.specId }, issue: i.key } : {};
}

/** §4.2-4 Xem of the issues_new card: one unseen → open it; ≥ 2 → the newest unseen's spec, filtered to Phát sinh. */
export function goArising(pi: ProjectIssues | null, key: string | null): TasksAsk {
  if (key) return goIssue(pi, key);
  const newest = (pi?.issues ?? []).filter(isArising).sort((a, b) => b.createdAt - a.createdAt)[0];
  return newest ? { sel: newest.specId === null ? 'outside' : { spec: newest.specId }, issue: null, arising: true } : { arising: true };
}

/** §4.2-3 the issue a lane works on: the `doing` one it holds. */
export const laneIssue = (pi: ProjectIssues | null, lane: string): IssueInfo | null =>
  pi?.issues.find(i => i.state === 'doing' && i.lane?.name === lane) ?? null;

/** §4.2-1 "v2.5" from "v2.5 Toolkit graph"; a title without a version keeps its first 16 characters. */
export function specShort(title: string): string {
  const v = /^v\d+(?:\.\d+)*/i.exec(title.trim());
  if (v) return v[0];
  const c = [...title.trim()];
  return c.length > 16 ? `${c.slice(0, 15).join('')}…` : title.trim();
}

/** §5.0 the session kind label: "Build · v2.5" (its spec), "Thiết kế" / "Thiết kế · v2.5" (editing a spec), "Chung" — Chung
 *  only beside another kind (a project with only its one Chung session shows no label, as before v2.7). v2.9 §4.7 a doc /
 *  build session is named by the step of its rev ("Plan"); no rev on the wire = the catalog word. */
export function orchKindLabel(tr: Tr, o: Pick<OrchestratorView, 'sessionId' | 'orchKind' | 'wf'>, all: readonly Pick<OrchestratorView, 'orchKind'>[], pi: ProjectIssues | null): string | null {
  const kind: OrchKind = o.orchKind ?? 'general';
  if (kind === 'general') return all.some(x => (x.orchKind ?? 'general') !== 'general') ? tr('deck.kind.general') : null;
  const sid = o.sessionId;
  const spec = sid ? pi?.specs.find(s => (kind === 'build' ? s.sessions.build === sid : s.sessions.edit === sid || (s.state === 'draft' && s.sessions.design === sid))) : undefined;
  return (o.wf?.stepName ?? tr(kind === 'build' ? 'deck.kind.build' : 'deck.kind.design')) + (spec ? ` · ${specShort(spec.title)}` : '');
}

const KEY_IN_TEXT = /\b[TB]-[1-9]\d{0,8}\b/g;
/** §4.5 IS7 issue keys of this project inside chat text: the plain parts and the keys, in order (a key the project does not
 *  have stays text). */
export function splitKeys(text: string, known: (key: string) => boolean): (string | { key: string })[] {
  const out: (string | { key: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(KEY_IN_TEXT)) {
    if (!parseIssueKey(m[0]) || !known(m[0])) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push({ key: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
