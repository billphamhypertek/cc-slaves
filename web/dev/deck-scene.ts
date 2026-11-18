// v2.7 G5 dev scene: the Deck side of the IS frames (mockup IS1, IS3b, IS5b, IS7, IS11, IS12, IS13, IS13b, IS19) on top of
// issues-scene.ts — two orchestrator sessions (Build · v2.5 owning D2 / R5 / D4, Chung owning B3 / F1 / C1), lanes without a
// note so line 2 is the issue title, the Chờ PO cards of the frame (issues_new one / many, superpowers_off, ask, broken), a
// Thiết kế session (IS13 / IS13b / IS19), the chat with issue keys (IS7) and the D2 log with a refused Skill (IS12).
import type { OrchKind } from '../../shared/issues.ts';
import { t, type Key, type Params } from '../../shared/i18n/index.ts';
import type { CardView, OrchestratorView, Snapshot, StreamLine, Target } from '../../shared/protocol.ts';
import type { IsFrame } from './issues-scene.ts';

const DECK = new Set<IsFrame>(['IS1', 'IS3b', 'IS5b', 'IS7', 'IS11', 'IS12', 'IS13', 'IS13b', 'IS19']);
const M = 60_000;
const OWN: Record<string, [string, number]> = { D2: ['s-v25', 1], R5: ['s-v25', 1], D4: ['s-v25', 1], B3: ['s-gen', 2], F1: ['s-gen', 2], C1: ['s-gen', 2] };

const keyed = (titleKey: Key, params?: Params) => ({ titleKey, ...(params ? { params } : {}), title: t('vi', titleKey, params) });
let seq = 80;
const card = (over: Partial<CardView>): CardView =>
  ({ id: ++seq, kind: 'ask', projectId: 'hagenta', source: null, status: 'open', createdAt: Date.now() - 10 * M, resolvedAt: null, title: '', ...over });

function cards(f: IsFrame, mac: boolean): CardView[] {
  const act = (id: string, label: string) => (mac ? [{ id, label }] : []);
  const arising = f === 'IS3b'
    ? card({ kind: 'issues_new', ...keyed('cards.issuesNewMany', { n: 2 }), actions: act('issues_view', 'Xem'), createdAt: Date.now() - 4 * M })
    : card({ kind: 'issues_new', ...keyed('cards.issuesNewOne', { key: 'B-50', title: 'Daemon CBM không tắt khi đóng app' }), actions: act('issues_view', 'Xem'), createdAt: Date.now() - 11 * M });
  const ask = card({ kind: 'ask', source: 'B3', title: 'B-12: tắt cả âm cảnh báo quota?', question: 'B-12: tắt cả âm cảnh báo quota?', options: [{ label: 'Tắt cả' }, { label: 'Chỉ âm lane' }], createdAt: Date.now() - 14 * M });
  const broken = card({ kind: 'broken', key: 'lane:D4', ...keyed('cards.laneBroken', { name: 'D4' }), context: 'API Error: 529 overloaded_error', createdAt: Date.now() - 30 * M });
  if (f === 'IS19') return [ask];
  const out = [arising, ask, broken];
  if (f === 'IS5b') out.unshift(card({ kind: 'revert_conflict', ...keyed('cards.revertConflict', { key: 'T-46', blocker: 'T-53' }), key: 'revert:T-46', createdAt: Date.now() - 60_000,
    actions: mac ? [{ id: 'revert_keep', label: 'Giữ T-46', labelKey: 'cardText.act.keepIssue', labelParams: { key: 'T-46' } }, { id: 'revert_cancel_both', label: 'Huỷ cả hai…', labelKey: 'cardText.act.cancelBoth' }] : [] }));
  if (f === 'IS11') out.unshift(card({ kind: 'superpowers_off', ...keyed('cards.superpowersOff'), bodyKey: 'cardText.body.superpowersOff', actions: act('open_skills', 'Mở Skills & MCP'), createdAt: Date.now() - 2 * M }));
  return out;
}

function sessions(f: IsFrame, base: OrchestratorView): OrchestratorView[] {
  const o = (sessionId: string, n: number, orchKind: OrchKind, over: Partial<OrchestratorView> = {}): OrchestratorView =>
    ({ ...base, sessionId, seq: n, orchKind, title: null, ...over });
  const out = [o('s-v25', 1, 'build', { contextPct: 41, costUsd: 8.3 }), o('s-gen', 2, 'general', { costUsd: 4.9 })];
  if (f === 'IS13') out.push(o('s-new', 3, 'design', { title: 'Thiết kế · 15:02', state: 'idle', costUsd: 0, contextPct: 2 }));
  if (f === 'IS13b') out.push(o('s-v28', 3, 'design', { title: 'Thiết kế · v2.8', state: 'idle', costUsd: 0.6 }), o('s-edit29', 4, 'design', { title: 'Sửa v2.9', state: 'idle', costUsd: 0.3 }));
  if (f === 'IS19') out.push(o('s-edit', 3, 'design', { state: 'idle', costUsd: 1.4, contextPct: 18 }));
  return out;
}

/** The frame's Deck: no-op outside the nine frames (Tasks frames keep issues-scene.ts as it is). */
export function deckTraces(s: Snapshot, f: IsFrame): Snapshot {
  if (!DECK.has(f) || !s.orchestrators[0]) return s;
  seq = 80;
  s.lanes = s.lanes.filter(l => OWN[l.name]).map(l => ({ ...l, note: null, ownerSession: OWN[l.name]![0], ownerSeq: OWN[l.name]![1] }));
  s.orchestrators = sessions(f, s.orchestrators[0]);
  s.cards = cards(f, s.channel === 'mac');
  return s;
}

type Line = Omit<StreamLine, 'seq' | 'ts'>;
const IS7: Line[] = [
  { kind: 'assistant', text: 'Đã giao `T-47` cho D2, `T-48` cho D4. `B-50` ưu tiên → R5.' },
  { kind: 'po', text: 'bug: kéo tab project bị giật, xem ảnh', att: [{ kind: 'image', name: 'tab-giat.png', copy: true }] },
  { kind: 'tool_use', tool: 'mcp__cc_slaves__issue_create', toolUseId: 'u1', text: 'issue_create', input: '{"title":"Kéo tab project bị giật","kind":"bug","spec":null}' },
  { kind: 'tool_result', toolUseId: 'u1', text: '{"key":"B-51"}', result: '{"key":"B-51","state":"todo"}' },
  { kind: 'assistant', text: 'Ghi B-51 (ngoài spec), phiên Chung sẽ mở lane sửa.' },
];
const HOOK = 'PreToolUse:Skill hook error: Bị chặn có chủ ý — Lane làm theo spec đã duyệt, không thiết kế lại. Thiếu gì thì hỏi anh qua thẻ Chờ PO.';
const IS12: Line[] = [
  { kind: 'tool_use', tool: 'mcp__cc_slaves__issue_get', toolUseId: 'g1', text: 'issue_get', input: '{"key":"T-47"}' },
  { kind: 'tool_result', toolUseId: 'g1', text: 'ok', result: '{"key":"T-47"}' },
  { kind: 'assistant', text: 'Đọc xong T-47. Màn Graph cần danh sách index và nút Dừng — thử phác bố cục trước.' },
  { kind: 'tool_use', tool: 'Skill', toolUseId: 'k1', text: 'Skill: superpowers:brainstorming', input: '{"skill":"superpowers:brainstorming"}' },
  { kind: 'tool_result', toolUseId: 'k1', text: HOOK, result: HOOK, isError: true },
  { kind: 'assistant', text: 'Rõ — làm theo spec v2.5 §4.3 và khung GR2–GR4.' },
  { kind: 'tool_use', tool: 'Read', toolUseId: 'r1', text: 'Read: docs/specs/2026-11-14-hagenta-v2.5-toolkit-graph.md' },
  { kind: 'tool_result', toolUseId: 'r1', text: 'ok' },
  { kind: 'tool_use', tool: 'Edit', toolUseId: 'e1', text: 'Edit: web/src/skills/GraphList.tsx', diff: { add: 42, del: 3 } },
  { kind: 'tool_result', toolUseId: 'e1', text: 'ok' },
];
const IS11: Line[] = [
  { kind: 'assistant', text: '`T-44` sẵn sàng — mở lane mới cho nó.' },
  { kind: 'tool_use', tool: 'mcp__cc_slaves__lane_start', toolUseId: 's1', text: 'lane_start', input: '{"name":"D6","issue":"T-44"}' },
  { kind: 'tool_result', toolUseId: 's1', text: 'bị từ chối: superpowers chưa bật cho project này.', result: 'bị từ chối: superpowers chưa bật cho project này.', isError: true },
  { kind: 'assistant', text: 'Lane mới phải chờ tới khi anh bật superpowers trong Bộ công cụ. Các lane đang chạy vẫn làm tiếp; em chờ.' },
];

/** The frame's conversation for `t` (null = the usual history). */
export function deckLines(f: string, t: Target): StreamLine[] | null {
  // §4.7 UX-I11 a new Thiết kế session (IS13's, or one "+ Spec mới" opened in dev) has said nothing yet: its empty state
  if (t.kind === 'orchestrator' && (t.sessionId === 's-new' || t.sessionId?.startsWith('s-design-'))) return [];
  const base = t.kind === 'lane' ? (f === 'IS12' && t.name === 'D2' ? IS12 : null)
    : t.projectId === 'hagenta' && (!t.sessionId || t.sessionId === 's-v25') ? (f === 'IS7' ? IS7 : f === 'IS11' ? IS11 : null) : null;
  return base ? base.map((l, i) => ({ ...l, seq: i + 1, ts: Date.now() - (base.length - i) * 60_000 })) : null;
}
