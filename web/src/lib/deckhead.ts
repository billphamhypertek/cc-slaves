// spec v2.1 §4.8 deck header bar as pure data (no React): project · ("n phiên" > 1 root) · "n lane · n subagent" ·
// ("n chưa merge" amber > 0) · "hôm nay N tok · ≈ $N"; hover = every project's today + the total. The F9 list shows the
// same line (§4.8 "để tiền không biến mất khi bàn không hiện"). v2.7 §4.2-1 the issues strip ("v2.5 ▓▓░ 8/13 · ngoài spec 3").
import type { Progress, ProjectIssues } from '../../../shared/issues.ts';
import { displayTokens, type Snapshot, type SubagentView, type TokenCounts } from '../../../shared/protocol.ts';
import type { Tr } from '../../../shared/i18n/core.ts';
import { fmtCost, fmtTok } from './format.ts';
import { specShort } from './traces.ts';

type HeadKind = 'name' | 'sessions' | 'counts' | 'unmerged' | 'issues' | 'today' | 'starting';
/** §4.2-1 the earliest-opened active spec (`more` = the other active ones, "+1") and the open issues outside every spec. */
export interface HeadStrip { spec: { id: number; short: string; progress: Progress; tip: string } | null; more: number; outside: number }
export interface HeadPart { k: HeadKind; text: string; warn?: boolean; strip?: HeadStrip }
export interface DeckHead { parts: HeadPart[]; tip: string[] }
export interface HeadInput {
  snap: Snapshot | null; projectId: string | null;
  /** live orchestrator sessions drawn as roots (§4.14). */
  roots: number;
  /** subagents per lane name of this project (count = remote, list = local). */
  subagents: Record<string, number | SubagentView[]>;
  /** v2.7 the project's specs + issues (Mac channel only; null = no strip). */
  pi?: ProjectIssues | null;
  tr: Tr;
}

const ZERO: TokenCounts = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
const subN = (v: number | SubagentView[] | undefined) => (Array.isArray(v) ? v.length : v ?? 0);

export function deckHeader(h: HeadInput): DeckHead {
  const { snap, tr } = h;
  const p = snap && h.projectId ? snap.projects.find(x => x.id === h.projectId) ?? null : null;
  if (!snap || !p) return { parts: [], tip: [] };
  const parts: HeadPart[] = [{ k: 'name', text: p.name }];
  // §4.6 the project boots (its only session starts); a parallel session starting later is just its own root (§4.14)
  const os = snap.orchestrators.filter(o => o.projectId === p.id);
  if (os.length === 1 && os[0]!.state === 'starting') return { parts: [...parts, { k: 'starting', text: tr('deck.head.starting') }], tip: [] };
  if (h.roots > 1) parts.push({ k: 'sessions', text: tr('deck.head.sessions', { n: h.roots }) });
  const live = snap.lanes.filter(l => l.projectId === p.id && l.state !== 'done');
  const subs = live.reduce((a, l) => a + subN(h.subagents[l.name]), 0);
  parts.push({ k: 'counts', text: `${tr(live.length === 1 ? 'deck.head.lane' : 'deck.head.lanes', { n: live.length })} · ${tr(subs === 1 ? 'deck.head.sub' : 'deck.head.subs', { n: subs })}` });
  if ((p.unmerged ?? 0) > 0) parts.push({ k: 'unmerged', text: tr('deck.head.unmerged', { n: p.unmerged! }), warn: true });
  const strip = h.pi ? issuesStrip(h.pi, tr) : null;
  if (strip) parts.push(strip);
  const st = snap.stats;
  const mine = st?.projects[p.id];
  if (mine) parts.push({ k: 'today', text: tr('deck.head.today', { tok: fmtTok(displayTokens(mine.tokensToday), tr), cost: fmtCost(mine.costTodayUsd, tr) }) });
  const tip: string[] = [];
  if (st) {
    let tok = 0, usd = 0;
    for (const pr of snap.projects) {
      const s = st.projects[pr.id] ?? { tokensToday: ZERO, costTodayUsd: 0 }, n = displayTokens(s.tokensToday);
      tok += n; usd += s.costTodayUsd;
      tip.push(tr('deck.head.tipRow', { name: pr.name, tok: fmtTok(n, tr), cost: fmtCost(s.costTodayUsd, tr) }));
    }
    tip.push(tr('deck.head.tipRow', { name: tr('deck.head.all'), tok: fmtTok(tok, tr), cost: fmtCost(usd, tr) }));
  }
  return { parts, tip };
}

const openIssue = (s: string) => s === 'todo' || s === 'doing';
/** §4.2-1 no active spec and no open issue → no strip. The bar follows the one rule (`progressOf`, via `SpecInfo.progress`). */
export function issuesStrip(pi: ProjectIssues, tr: Tr): HeadPart | null {
  const active = pi.specs.filter(s => s.state === 'active').sort((a, b) => (a.openedAt ?? a.createdAt) - (b.openedAt ?? b.createdAt));
  const outside = pi.issues.filter(i => i.specId === null && openIssue(i.state)).length;
  const first = active[0];
  if (!first && !outside) return null;
  const pr = first?.progress;
  const spec = first && pr ? { id: first.id, short: specShort(first.title), progress: pr, tip: [tr('deck.strip.tip', { done: pr.done, total: pr.total }),
    ...(pr.scope ? [tr('deck.strip.tipScope', { n: pr.scope })] : []), ...(pr.cancelled ? [tr('deck.strip.tipCancelled', { n: pr.cancelled })] : [])].join(' · ') } : null;
  const more = Math.max(0, active.length - 1);
  const text = [spec ? `${spec.short} ${pr!.done}/${pr!.total}${more ? ` +${more}` : ''}` : null, outside ? tr('deck.strip.outside', { n: outside }) : null].filter(Boolean).join(' · ');
  return { k: 'issues', text, strip: { spec, more, outside } };
}
