// The dev mock frames feed the §11 screenshots (e2e/specs/v21-shots.spec.ts): their data must agree with itself and with the
// engine's shapes, or the shots show states the real app never reaches (v21-ux-review M1, M13, I9).
import { describe, expect, test } from 'bun:test';
import { deckOrchHistory, doneLanesPage, FRAMES, snapshotFor } from '../dev/scenarios.ts';
import { resumePreview, sessionsList } from '../dev/sessions.ts';
import { deckLines } from '../dev/deck-scene.ts';
import { openSession } from '../dev/issues-mock.ts';
import { fmtHm } from '../src/lib/format.ts';
import { issueBlocks, issuesOf, progressFor, specRail } from '../src/lib/issues.ts';
import { poSlots } from './fixtures.ts';

const unmergedOf = (f: Parameters<typeof snapshotFor>[0]) => {
  const s = snapshotFor(f, 'mac');
  return { header: s.projects[0]!.unmerged, lanes: s.lanes.filter(l => l.state === 'done' && l.branch?.state === 'unmerged').length };
};

describe('dev mock frames (v2.1 §11 shots)', () => {
  test('§5.3 I1 every lane time in every frame is epoch ms of the last 30 days (no "lượt cuối 20772 ngày")', () => {
    const now = Date.now(), ok = (t: number) => t > now - 30 * 24 * 3_600_000 && t <= now + 1000;
    for (const f of FRAMES) for (const l of snapshotFor(f, 'mac').lanes) {
      expect({ f, l: l.name, updatedAt: ok(l.updatedAt) }).toEqual({ f, l: l.name, updatedAt: true });
      if (l.turnStartedAt !== null) expect({ f, l: l.name, turn: ok(l.turnStartedAt) }).toEqual({ f, l: l.name, turn: true });
    }
  });
  test('§4.7 I1-mock every account in every deck frame has a fresh fetchedAt and real reset times (no "20772 ngày", no "reset chưa rõ")', () => {
    const now = Date.now();
    for (const f of FRAMES.filter(x => x.startsWith('DK'))) for (const a of snapshotFor(f, 'mac').accounts) {
      expect({ f, a: a.email, fetched: (a.fetchedAt ?? 0) > now - 60 * 60_000 && (a.fetchedAt ?? 0) <= now }).toEqual({ f, a: a.email, fetched: true });
      expect({ f, a: a.email, week: (a.weekResetsAt ?? 0) > now, five: (a.fiveResetsAt ?? 0) > now }).toEqual({ f, a: a.email, week: true, five: true });
    }
  });
  test('§5.3 N-e every lane and Điều phối that costs money also carries the tokens it spent (no "0 tok ≈ $1,00")', () => {
    const sum = (t: { input: number; output: number; cacheWrite: number; cacheRead: number } | null | undefined) => (t ? t.input + t.output + t.cacheWrite + t.cacheRead : 0);
    for (const f of FRAMES) {
      const s = snapshotFor(f, 'mac');
      for (const x of [...s.lanes, ...s.orchestrators]) if (x.costUsd > 0) {
        const who = 'name' in x ? x.name : 'orch';
        expect({ f, who, tok: sum(x.tokens) > 0 }).toEqual({ f, who, tok: true });
      }
    }
  });
  test('§4.11b DK5 / §4.14 N5-e: the deck Điều phối has a short transcript (mockup N1-a: 4 rows) and ended #2 its own', () => {
    expect(deckOrchHistory(null).length).toBe(4);
    expect(deckOrchHistory('s2').map(l => l.text).join(' ')).toContain('D9');
    expect(deckOrchHistory('s1')).toEqual([]);
  });
  test('§4.15 §2 N-c DKX: the #4 hotfix tree owns an H-lane (⌘K "h" in N6-d)', () => {
    const h = snapshotFor('DKX', 'mac').lanes.filter(l => l.name.startsWith('H'));
    expect(h.map(l => [l.name, l.ownerSeq])).toEqual([['H4', 4]]);
  });
  test('§4.14 M3 DKS / DKX: the resume preview never proposes an account a live Điều phối runs on', () => {
    for (const f of ['DKS', 'DKX'] as const) {
      const s = snapshotFor(f, 'mac'), pv = resumePreview(s, 's2');
      expect({ f, busy: s.orchestrators.some(o => o.account === pv.account) }).toEqual({ f, busy: false });
      expect(pv.account).not.toBeNull();
    }
  });
  test('§4.14 I7 DKS: the expired session #1 sends the engine\'s reason errors.noTranscript (row and preview), #2 none', () => {
    const s = snapshotFor('DKS', 'mac'), rows = sessionsList(s, 'p1').ended;
    expect(rows.find(r => r.sessionId === 's1')?.reason).toEqual({ key: 'errors.noTranscript', params: { days: 30 } });
    expect(resumePreview(s, 's1').reason).toEqual({ key: 'errors.noTranscript', params: { days: 30 } });
    expect(rows.find(r => r.sessionId === 's2')?.reason ?? null).toBeNull();
    expect(resumePreview(s, 's2').reason).toBeNull();
  });
  test('§4.15 §3 Rev 18/11 DKXN: only done lanes, one session, nothing asks the PO', () => {
    const s = snapshotFor('DKXN', 'mac');
    expect([s.lanes.length > 0, s.lanes.every(l => l.state === 'done'), s.orchestrators.length, s.cards.length]).toEqual([true, true, 1, 0]);
  });
  test('§4.15 M13 "n chưa merge" equals the unmerged done lanes the frame carries (DK5, DK5L, DKX)', () => {
    for (const f of ['DK5', 'DK5L', 'DKX'] as const) {
      const u = unmergedOf(f);
      expect({ f, n: u.header }).toEqual({ f, n: u.lanes });
    }
  });
  test('§4.2 M1 DK5 R5 Hỏng: the node line has its exit reason and the Chờ PO column has its broken card', () => {
    const s = snapshotFor('DK5', 'mac'), r5 = s.lanes.find(l => l.name === 'R5')!;
    expect(r5.state).toBe('broken');
    expect(r5.lastError).toContain('exit 1');
    const c = s.cards.find(x => x.kind === 'broken' && x.status === 'open');
    expect(c?.params).toEqual({ name: 'R5' });
    expect(c?.actions?.map(a => a.id)).toEqual(['lane_resume', 'view_log', 'hand_to_orchestrator']);
  });
  test('§4.2 m-4 DK5 card times share the lane clock: R5 card = R5 exit time ("exit 1 lúc HH:MM"), other cards ≈ now − 2 min', () => {
    for (const f of ['DK5', 'DK5L'] as const) {
      const now = Date.now(), s = snapshotFor(f, 'mac'), r5 = s.lanes.find(l => l.name === 'R5')!;
      const c = s.cards.find(x => x.key === 'lane:R5')!;
      expect(c.createdAt).toBe(r5.updatedAt);
      expect(r5.lastError).toBe(`exit 1 lúc ${fmtHm(r5.updatedAt)}`);
      for (const o of s.cards.filter(x => x !== c && x.status === 'open')) expect({ f, id: o.id, ago: Math.round((now - o.createdAt) / 60_000) }).toEqual({ f, id: o.id, ago: 2 });
    }
  });
  test('§4.14 I9 DKX (3 sessions): every open lane card carries the #n of its lane\'s owner session', () => {
    const s = snapshotFor('DKX', 'mac');
    const open = s.cards.filter(c => c.status === 'open' && c.source && c.source !== 'orchestrator');
    expect(open.length).toBeGreaterThan(0);
    for (const c of open) expect({ c: c.id, seq: c.seq }).toEqual({ c: c.id, seq: s.lanes.find(l => l.name === c.source)!.ownerSeq });
  });
});

describe('dev mock done_lanes_list (N6-k)', () => {
  test('§4.15 M4 total / unmerged count every done lane like the engine; only the rows follow the filter', () => {
    const lanes = snapshotFor('DKX', 'mac').lanes.filter(l => l.state === 'done');
    const all = doneLanesPage(lanes, { limit: 50 }), f = doneLanesPage(lanes, { unmerged: true, limit: 50 });
    expect(f.total).toBe(all.total);
    expect(f.unmerged).toBe(all.unmerged);
    expect(f.lanes.length).toBeLessThan(all.lanes.length);
    expect(f.lanes.every(l => l.branch?.state === 'unmerged' || l.branch?.state === 'unknown')).toBe(true);
  });
});

describe('v2.7 IS frames (web/dev/issues-scene.ts) carry every state the Tasks lanes screenshot', () => {
  const pi = () => snapshotFor('IS2', 'mac').issues!.find(p => p.projectId === 'hagenta')!;
  test('§4.3 every rail group and every list block; v2.5 = 8/13 with 2 extra scope (1 open), 1 cancelled; B-50 unseen', () => {
    const p = pi();
    expect(specRail(p, poSlots()).map(g => g.group)).toEqual(['designing', 'ready', 'building', 'outside', 'done']);
    expect(specRail(p, poSlots()).find(g => g.group === 'done')!.more).toBe(2);
    expect(progressFor(p, { spec: 4 })).toEqual({ done: 8, total: 13, scope: 1, cancelled: 1, amend: 0 });
    expect(issueBlocks(issuesOf(p, { spec: 4 })).map(b => `${b.block}:${b.issues.length}+${b.more}`)).toEqual(['doing:3+0', 'ready:1+0', 'blocked:1+0', 'done:5+3', 'cancelled:1+0']);
    expect(p.issues.filter(i => !i.poSeen).map(i => i.key)).toEqual(['B-50']);
    expect(specRail(p, poSlots()).find(g => g.group === 'outside')!.open).toBe(4);
    expect(progressFor(p, { spec: 5 })).toMatchObject({ done: 18, total: 18 });
  });
  test('§4.3 every issue key is unique in the project; every spec\'s progress matches its issues', () => {
    const p = pi(), keys = p.issues.map(i => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of p.specs) expect({ s: s.title, p: s.progress }).toEqual({ s: s.title, p: progressFor(p, { spec: s.id }) });
  });
  test('§6 IS8 empty project first · IS8b no data yet · IS16 imported "đang build dở" · remote has no issues', () => {
    const e = snapshotFor('IS8', 'mac');
    expect(e.projects[0]!.id).toBe('cc-slaves');
    expect(e.issues!.find(p => p.projectId === 'cc-slaves')!.issues).toEqual([]);
    expect(snapshotFor('IS8b', 'mac').issues).toEqual([]);
    const imp = snapshotFor('IS16', 'mac');
    expect(imp.issues![0]!.specs.find(s => s.id === 4)).toMatchObject({ state: 'approved', origin: 'imported', outsideBuild: true });
    expect(imp.projects[0]!.specsImported).toBe(4);
    expect(snapshotFor('IS2', 'remote').issues).toBeUndefined();
  });
  // R-B19 M9 every frame the UX review re-checks is reachable in dev
  const hag = (f: Parameters<typeof snapshotFor>[0]) => snapshotFor(f, 'mac').issues!.find(p => p.projectId === 'hagenta')!;
  test('M9 IS5b Deck: Chờ PO has the 4 cards of the mockup, the revert_conflict among them; the two v2.5 / Chung trees', () => {
    const s = snapshotFor('IS5b', 'mac');
    expect(s.cards.map(c => c.kind).sort()).toEqual(['ask', 'broken', 'issues_new', 'revert_conflict']);
    expect(s.orchestrators.map(o => o.orchKind)).toEqual(['build', 'general']);
  });
  test('M9 IS13b: Build v2.5 + Thiết kế v2.8 + "Sửa v2.9" (v2.9 đang sửa) = the R34 cap; no fresh 15:02 session', () => {
    const s = snapshotFor('IS13b', 'mac'), v29 = hag('IS13b').specs.find(x => x.id === 3)!;
    expect(s.orchestrators.map(o => [o.sessionId, o.orchKind])).toEqual([['s-v25', 'build'], ['s-gen', 'general'], ['s-v28', 'design'], ['s-edit29', 'design']]);
    expect(v29).toMatchObject({ editing: true, sessions: { design: null, build: null, edit: 's-edit29' } });
  });
  test('M9 IS19: v2.5 amended (rev 2, T-55…T-57 "bổ sung", T-49 waits on them), T-47 done → 9/16, the overview row, s-edit in both scenes', () => {
    const p = hag('IS19'), v = p.specs.find(x => x.id === 4)!;
    expect(p.issues.filter(i => i.source === 'amend').map(i => `${i.key}:${i.state}`)).toEqual(['T-55:todo', 'T-56:todo', 'T-57:todo']);
    expect(progressFor(p, { spec: 4 })).toMatchObject({ done: 9, total: 16, amend: 3 });
    expect(p.issues.find(i => i.key === 'T-49')!.waitingOn).toEqual(['T-44', 'T-48', 'T-55', 'T-56', 'T-57']);
    expect(v).toMatchObject({ editing: true, amendRev: 2, sessions: { edit: 's-edit' } });
    expect(v.overview!.lastAmend).toMatchObject({ rev: 2, issueCount: 3 });
    expect(snapshotFor('IS19', 'mac').orchestrators.some(o => o.sessionId === 's-edit' && o.orchKind === 'design')).toBe(true);
  });
  test('M9 imported specs carry no approvedAt ("trước khi nhập"); IS16 / IS17 = the first open: no outside issue, no done spec', () => {
    for (const f of ['IS13b', 'IS15', 'IS16', 'IS17', 'IS18'] as const) for (const sp of hag(f).specs.filter(x => x.origin === 'imported')) expect([f, sp.id, sp.approvedAt]).toEqual([f, sp.id, null]);
    for (const f of ['IS16', 'IS17'] as const) {
      const p = hag(f);
      expect(p.issues.filter(i => i.specId === null)).toEqual([]);
      expect(p.specs.filter(x => x.state === 'done')).toEqual([]);
    }
  });
  test('UX N6 spec_build / spec_edit in dev open a Build / Thiết kế session bound to that spec (IS19 Deck "Thiết kế · v2.5")', () => {
    const s = snapshotFor('IS13b', 'mac');
    const pi = s.issues!.find(p => p.projectId === 'hagenta')!;
    const v26 = pi.specs.find(x => x.title === 'v2.6 Updater')!, v25 = pi.specs.find(x => x.title === 'v2.5 Toolkit graph')!;
    const b = openSession(s, 'hagenta', 'build', v26.path);
    expect(b.o).toMatchObject({ orchKind: 'build', title: 'Build · v2.6 Updater' });
    expect(b.spec?.sessions.build).toBe(b.o.sessionId);
    const e = openSession(s, 'hagenta', 'design', v25.path);
    expect(e.o.orchKind).toBe('design');
    expect(e.spec).toMatchObject({ editing: true, sessions: { edit: e.o.sessionId } });
    expect(s.issues!.find(p => p.projectId === 'hagenta')!.specs.find(x => x.id === v25.id)?.sessions.edit).toBe(e.o.sessionId);
  });
  test('I11 "+ Spec mới" in dev opens a new Thiết kế session (next #n, "Thiết kế · HH:MM" VN, nothing said) — IS13 too', () => {
    const s = snapshotFor('IS1', 'mac'), n = s.orchestrators.length;
    const { o, spec } = openSession(s, 'hagenta', 'design', undefined, Date.UTC(2026, 10, 17, 8, 2));
    expect(spec).toBeNull();
    expect(s.orchestrators.length).toBe(n + 1);
    expect(o).toMatchObject({ projectId: 'hagenta', orchKind: 'design', title: 'Thiết kế · 15:02', seq: 3, costUsd: 0 });
    expect(deckLines('IS1', { kind: 'orchestrator', projectId: 'hagenta', sessionId: o.sessionId })).toEqual([]);
    expect(deckLines('IS13', { kind: 'orchestrator', projectId: 'hagenta', sessionId: 's-new' })).toEqual([]);
    expect(deckLines('IS1', { kind: 'orchestrator', projectId: 'hagenta', sessionId: 's-gen' })).toBeNull();
  });
});
