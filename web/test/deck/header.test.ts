// spec v2.1 §4.8 deck header bar (one line: project · "n phiên" · "n lane · n subagent" · "n chưa merge" · "hôm nay N tok · ≈ $N").
import { describe, expect, test } from 'bun:test';
import { makeT } from '../../../shared/i18n/index.ts';
import type { TokenCounts, TokenStats } from '../../../shared/protocol.ts';
import { deckHeader, type HeadPart } from '../../src/lib/deckhead.ts';
import { lane, snapshot } from '../fixtures.ts';

const VI = makeT('vi'), EN = makeT('en');
const tok = (n: number): TokenCounts => ({ input: n, output: 0, cacheWrite: 0, cacheRead: 0 });
const stats: TokenStats = {
  at: 1, tokens5h: tok(0),
  projects: { p1: { tokensToday: tok(4_200_000), costTodayUsd: 38.1 }, p2: { tokensToday: tok(1_000_000), costTodayUsd: 2 } },
};
const snap = (o: Parameters<typeof snapshot>[0] = {}) => snapshot({
  projects: [
    { id: 'p1', name: 'hagenta', path: '/w/h', orchestratorAccount: 'a@x', gchatWebhookSet: false, gchatSendCommandText: false },
    { id: 'p2', name: 'cc-slaves', path: '/w/c', orchestratorAccount: 'a@x', gchatWebhookSet: false, gchatSendCommandText: false },
  ],
  lanes: [lane('D2'), lane('B2'), lane('K3', { state: 'done' }), lane('X1', { projectId: 'p2' })], stats, ...o,
});
const kinds = (ps: HeadPart[]) => ps.map(p => p.k);
const text = (ps: HeadPart[]) => ps.map(p => p.text).join(' · ');

describe('§4.8 header bar', () => {
  test('§4.8 project · n lane · n subagent · hôm nay N tok · ≈ $N (done lanes and other projects not counted)', () => {
    const h = deckHeader({ snap: snap(), projectId: 'p1', roots: 1, subagents: { D2: 3, B2: [], K3: 4 }, tr: VI });
    expect(kinds(h.parts)).toEqual(['name', 'counts', 'today']);
    expect(text(h.parts)).toBe('hagenta · 2 lane · 3 subagent · hôm nay 4,2M tok · ≈ $38,10');
  });

  test('§4.8 "n phiên" only when > 1 root', () => {
    expect(kinds(deckHeader({ snap: snap(), projectId: 'p1', roots: 1, subagents: {}, tr: VI }).parts)).not.toContain('sessions');
    const h = deckHeader({ snap: snap(), projectId: 'p1', roots: 2, subagents: {}, tr: VI });
    expect(h.parts[1]).toEqual({ k: 'sessions', text: '2 phiên' });
  });

  test('§4.8 "n chưa merge" (amber) only when > 0', () => {
    const p = (unmerged: number) => snap({ projects: [{ id: 'p1', name: 'hagenta', path: '/w/h', orchestratorAccount: 'a@x', gchatWebhookSet: false, gchatSendCommandText: false, unmerged }] });
    expect(kinds(deckHeader({ snap: p(0), projectId: 'p1', roots: 1, subagents: {}, tr: VI }).parts)).not.toContain('unmerged');
    const h = deckHeader({ snap: p(2), projectId: 'p1', roots: 1, subagents: {}, tr: VI });
    expect(h.parts.find(x => x.k === 'unmerged')).toEqual({ k: 'unmerged', text: '2 chưa merge', warn: true });
    expect(kinds(h.parts)).toEqual(['name', 'counts', 'unmerged', 'today']);
  });

  test('§4.8 hover = every project today + the total', () => {
    const h = deckHeader({ snap: snap(), projectId: 'p1', roots: 1, subagents: {}, tr: VI });
    expect(h.tip).toEqual(['hagenta · 4,2M tok · ≈ $38,10', 'cc-slaves · 1M tok · ≈ $2,00', 'Mọi project · 5,2M tok · ≈ $40,10']);
  });

  test('§4.8 no stats (pre-v2.1 engine) → no "hôm nay" part, no crash', () => {
    const h = deckHeader({ snap: snap({ stats: undefined }), projectId: 'p1', roots: 1, subagents: {}, tr: VI });
    expect(kinds(h.parts)).toEqual(['name', 'counts']);
  });

  test('§4.10 N4-c starting orchestrator → "Đang khởi động…" instead of the numbers', () => {
    const s = snap({ orchestrators: [{ projectId: 'p1', state: 'starting', account: null, homeAccount: null, lastError: null, costUsd: 0, contextPct: null, talkingTo: null }] });
    const h = deckHeader({ snap: s, projectId: 'p1', roots: 1, subagents: {}, tr: VI });
    expect(text(h.parts)).toBe('hagenta · Đang khởi động…');
  });

  test('§4.8 en catalog', () => {
    const h = deckHeader({ snap: snap(), projectId: 'p1', roots: 2, subagents: { D2: 1 }, tr: EN });
    expect(text(h.parts)).toBe('hagenta · 2 sessions · 2 lanes · 1 subagent · today 4.2M tok · ≈ $38.10');
  });

  test('§4.10 no project → empty', () => {
    expect(deckHeader({ snap: snap(), projectId: null, roots: 0, subagents: {}, tr: VI }).parts).toEqual([]);
  });
});
