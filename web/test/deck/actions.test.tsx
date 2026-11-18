// v1.1 clicks + keys (§4.7), HUD chips (§4.5 / W4), F9 filters (§4.6 "Khu tràn", §4.7 chips), card glow (§4.4, v1 U6).
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { flashCard, keyLane, FLASH_MS } from '../../src/deck/actions.ts';
import { buildFlow, type FlowInput } from '../../src/deck/flow/model.ts';
import { TopBar } from '../../src/ui/TopBar.tsx';
import { Banner, bannerShown, connLate } from '../../src/ui/Screens.tsx';
import { accounts, NOW, scene } from './scene.ts';
import { makeT } from '../../../shared/i18n/index.ts';
const VI = makeT('vi');

const inp = (over: Partial<FlowInput> = {}): FlowInput => ({ snap: scene(5), projectId: 'p1', subagents: {}, selected: null, now: NOW, tr: VI, live: true, ...over });

describe('§4.11 keys', () => {
  test('v2.1 §4.11 keys 1–9 follow the tree layout (creation order), not zones; done lanes excluded', () => {
    const m = buildFlow(inp());
    expect(m.keyOrder.length).toBeGreaterThan(1);
    for (let n = 1; n <= 9; n++) expect(keyLane(m.keyOrder, n)).toBe(m.keyOrder[n - 1] ?? null);
    const rev = scene(5); rev.lanes.reverse();
    const mr = buildFlow(inp({ snap: rev }));
    expect(rev.lanes[0]!.name).toBe('E4');
    expect(mr.keyOrder).toEqual(rev.lanes.filter(l => l.state !== 'done').map(l => l.name)); // snapshot = creation order
    expect(mr.keyOrder).not.toContain('E4');
    expect(keyLane([], 1)).toBeNull();
  });
});

describe('v2.1 §4.8 app top bar', () => {
  const bar = (n: number) => renderToStaticMarkup(<TopBar snap={scene(n)} offline={false} projectId="p1" pendingByProject={{}} unread={new Set()} muted={false} listOn={false}
    onProject={() => {}} onAddProject={() => {}} onList={() => {}} onRemote={() => {}} onMute={() => {}} onSettings={() => {}} onSkillsMcp={() => {}} onTabMenu={() => {}} />);
  test('§4.8 top bar no longer renders account chips (≤ 8 or > 8), "kho" / "cần xem", nor "chi phí ước tính hôm nay"', () => {
    for (const n of [3, 8, 9, 30]) {
      const h = bar(n);
      expect(h).not.toMatch(/class="chips?[ "]/);
      expect(h).not.toContain('chip agg');
      expect(h).not.toContain('class="cost"');
      expect(h).not.toContain('≈ $');
      expect(h).not.toContain('hôm nay');
      for (const a of accounts(n).slice(0, 3)) expect(h).not.toContain(a.email.split('@')[0]!);
    }
  });
  test('§4.8 the other top-bar items stay: project tabs, "+", list, sound, settings', () => {
    const h = bar(3);
    expect(h).toContain('class="tab on"');
    expect(h).toContain('title="Thêm project"');
    expect(h).toContain('aria-label="Chế độ danh sách"');
    expect(h).toContain('aria-label="Âm thanh"');
    expect(h).toContain('aria-label="Cài đặt"');
  });
  test('§4.11 M11 a remote viewer sees a read-only "từ xa" marker (no control); the Mac does not', () => {
    const html = (channel: 'mac' | 'remote') => renderToStaticMarkup(<TopBar snap={{ ...scene(3), channel }} offline={false} projectId="p1" pendingByProject={{}} unread={new Set()} muted={false}
      listOn={false} onProject={() => {}} onAddProject={() => {}} onList={() => {}} onRemote={() => {}} onMute={() => {}} onSettings={() => {}} onSkillsMcp={() => {}} onTabMenu={() => {}} />);
    const r = html('remote');
    expect(r).toMatch(/<span class="pill acc rmt" role="status" title="Đang xem từ xa: chỉ ra lệnh được, cài đặt chỉ trên Mac">.*từ xa<\/span>/);
    // only "+" and v2.8 "Giao diện" (§4.8: the phone follows its own scheme) are Mac-only; no new control
    expect(r.match(/<button/g)!.length).toBe(html('mac').match(/<button/g)!.length - 2);
    expect(html('mac')).toContain('aria-label="Giao diện"');
    expect(r).not.toContain('aria-label="Giao diện"');
    expect(html('mac')).not.toContain('rmt');
  });
});

describe('§4.4 card glow', () => {
  test('§4.4 / U6 the focused Chờ anh card glows for 1.2 s', () => {
    const cls = new Set<string>(), el = { classList: { add: (c: string) => cls.add(c), remove: (c: string) => cls.delete(c) } };
    let fire: (() => void) | null = null, ms = 0;
    const ok = flashCard({ querySelector: (s: string) => (s === '#inbox .card.focus' ? el : null) }, (f, t) => { fire = f; ms = t; });
    expect(ok).toBe(true);
    expect(cls.has('flash')).toBe(true);
    expect(ms).toBe(FLASH_MS);
    expect(FLASH_MS).toBe(1200);
    fire!();
    expect(cls.has('flash')).toBe(false);
  });
  test('no focused card → false', () => expect(flashCard({ querySelector: () => null }, () => {})).toBe(false));
});

describe('§4.6 offline: one message', () => {
  const conn = { status: 'reconnecting', attempt: 2, since: NOW - 5_000 } as never;
  test('N4-d deck shown → no v1 banner while reconnecting (the deck strip says it); list view / no project keep it', () => {
    expect(VI('deck.offlineAt', { hm: '14:32' })).toContain('Mất kết nối · số liệu lúc');
    const o = { offline: true, listOn: false, projectId: 'p1', late: false };
    expect(bannerShown(o)).toBe(false);
    expect(bannerShown({ ...o, listOn: true })).toBe(true);
    expect(bannerShown({ ...o, projectId: null })).toBe(true);
    expect(bannerShown({ ...o, offline: false, listOn: true, projectId: null })).toBe(false);
    expect(renderToStaticMarkup(<Banner conn={conn} dataAt={NOW} now={NOW} onRestart={() => {}} />)).toContain('Mất kết nối với engine');
  });
  test('§4.6 late (30 s) → the banner returns on the deck for the restart action, without the time (v1 F10)', () => {
    const late = { status: 'reconnecting', attempt: 9, since: NOW - 31_000 } as never;
    expect(connLate(late, NOW)).toBe(true);
    expect(connLate(conn, NOW)).toBe(false);
    expect(bannerShown({ offline: true, listOn: false, projectId: 'p1', late: true })).toBe(true);
    const b = renderToStaticMarkup(<Banner conn={late} dataAt={NOW} now={NOW} onRestart={() => {}} deckShown />);
    expect(b).toContain('Khởi động lại engine');
    expect(b.toLowerCase()).not.toContain('số liệu lúc');
  });
});
