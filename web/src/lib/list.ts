// F9 list mode (spec §6.9): lanes grouped in R1 order, each row shows the question blocking it.
import type { Key, Tr } from '../../../shared/i18n/core.ts';
import type { CardView, LaneState, LaneView } from '../../../shared/protocol.ts';

const LANE_GROUPS: [label: Key, states: LaneState[]][] = [
  ['labels.group.waiting', ['waiting_po', 'broken']],
  ['labels.group.working', ['starting', 'running', 'switching', 'draining']],
  ['labels.group.quota', ['waiting_quota']],
  ['labels.group.idle', ['idle']],
  ['labels.group.paused', ['paused']], // hotfix 2026-11-16 held after an app restart
  ['labels.group.finished', ['done', 'stopped']],
];

export const groupLanes = (tr: Tr, lanes: LaneView[]) =>
  LANE_GROUPS.map(([key, states]) => ({ key, label: tr(key), lanes: lanes.filter(l => states.includes(l.state)) }));

export const blockingCard = (l: LaneView, cards: CardView[]): CardView | null =>
  cards.find(c => c.status === 'open' && (c.kind === 'ask' || c.kind === 'permission') && c.source === l.name && c.projectId === l.projectId) ?? null;
