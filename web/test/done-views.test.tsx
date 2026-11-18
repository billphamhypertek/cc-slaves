// v2.1 §4.15 §3 Đang xem bodies of done lanes: list chips / groups / empty / no-match, the done-lane block on Mac /
// remote / offline, the Inspector crumb "Xong · n" and the composer prefill under a draft.
import { describe, expect, test } from 'bun:test';
import { createRef, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LaneBranch, Snapshot } from '../../shared/protocol.ts';
import { LangProvider } from '../src/lib/i18n.tsx';
import type { Selection } from '../src/lib/inspector.ts';
import { DoneBody, type DoneProps } from '../src/ui/DoneViews.tsx';
import { lane, snapshot } from './fixtures.ts';

const NOW = new Date(2026, 10, 16, 14, 0).getTime(), H = 3_600_000;
const br = (state: LaneBranch['state'], over: Partial<LaneBranch> = {}): LaneBranch =>
  ({ name: 'lane/d11', base: 'main', state, ahead: 4, files: 12, add: 340, del: 58, measuredAt: NOW, ...over });
const html = (el: ReactElement) => renderToStaticMarkup(<LangProvider lang="vi">{el}</LangProvider>);
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const done: DoneProps = { total: 41, cleanupDays: 30, load: () => Promise.resolve(null), onMerge() {}, onContinue() {}, onVscode() {}, onRetry() {} };
const snapOf = (over: Partial<Snapshot> = {}) => snapshot({
  lanes: [
    lane('D11', { state: 'done', updatedAt: NOW - 2 * H, task: 'group C lot-2', branch: br('unmerged'), worktreeExists: true }),
    lane('A2', { state: 'done', updatedAt: NOW - 3 * H, branch: br('merged', { pr: { number: 415, state: 'merged' } }) }),
    lane('E1', { state: 'done', updatedAt: NOW - 4 * H, branch: br('unknown', { reason: 'repo đang khoá' }) }),
    lane('R1', { state: 'running' }),
  ], ...over,
});
const body = (sel: Extract<Selection, { k: 'doneList' } | { k: 'doneLane' }>, over: { snap?: Snapshot; offline?: boolean } = {}) => {
  const snap = over.snap ?? snapOf();
  return html(<DoneBody sel={sel} snap={snap} project={{ ...snap.projects[0]!, unmerged: 2 }} now={NOW} offline={!!over.offline} dataAt={NOW - H}
    sessions={snap.orchestrators} viewedSid={null} sessionsList={null} subs={[]} done={done} onSel={() => {}} onMenu={() => {}} />);
};

describe('§4.15 §3 done list (N6-e)', () => {
  test('§4.15 §3 chips carry the counts, rows are grouped by day, only done lanes listed', () => {
    const t = text(body({ k: 'doneList' }));
    expect(t).toContain('Tất cả 41');
    expect(t).toContain('Chưa merge 2');
    expect(t).toContain('Hôm nay · 3');
    expect(t).toMatch(/D11 .*A2 .*E1/);
    expect(t).not.toContain('R1');
    expect(t).toContain('repo đang khoá · không tính · Thử lại');
  });
  test('§4.15 Trạng thái no done lane → empty line; offline → "lúc hh:mm"', () => {
    const t = text(body({ k: 'doneList' }, { snap: snapshot({ lanes: [] }), offline: true }));
    expect(t).toContain('Chưa có lane xong');
    expect(t).toContain('lúc 13:00');
  });
});

describe('§4.15 §3 done-lane view (N6-f)', () => {
  test('§4.15 §3 Mac: merge, VS Code and continue; branch, merge line, worktree, transcript', () => {
    const t = text(body({ k: 'doneLane', name: 'D11' }));
    expect(t).toContain('Nhờ Điều phối merge…');
    expect(t).toContain('Mở VS Code');
    expect(t).toContain('Chạy tiếp lane…');
    expect(t).toContain('lane/d11 → main');
    expect(t).toMatch(/chưa merge · 4 commit/);
  });
  test('§4.5 Xong: no chip; the last model · effort leads the facts line (MD12, Y33); not known yet → nothing', () => {
    const withRun = snapOf({ lanes: [lane('D11', { state: 'done', updatedAt: NOW - 2 * H, phase: null, task: 'group C lot-2', branch: br('unmerged'),
      run: { model: 'claude-opus-5-5', modelName: 'Opus 5.5', effort: 'medium' } })] });
    const h = body({ k: 'doneLane', name: 'D11' }, { snap: withRun });
    expect(h).not.toContain('mchip');
    expect(text(h)).toContain('⋯ Opus 5.5 · medium · group C lot-2 · ');
    const bare = snapOf({ lanes: [lane('D11', { state: 'done', updatedAt: NOW - 2 * H, phase: null, task: 'group C lot-2', branch: br('unmerged'), run: undefined })] });
    expect(text(body({ k: 'doneLane', name: 'D11' }, { snap: bare }))).toContain('⋯ group C lot-2 · ');
  });
  test('§4.15 Trạng thái remote hides VS Code / continue, keeps "Nhờ … merge"', () => {
    const t = text(body({ k: 'doneLane', name: 'D11' }, { snap: snapOf({ channel: 'remote' }) }));
    expect(t).toContain('Nhờ Điều phối merge…');
    expect(t).not.toContain('Mở VS Code');
    expect(t).not.toContain('Chạy tiếp lane…');
  });
  test('§4.15 Trạng thái offline locks "Nhờ … merge"; a merged lane has no merge button', () => {
    expect(body({ k: 'doneLane', name: 'D11' }, { offline: true })).toMatch(/<button[^>]*disabled=""[^>]*>.*?Nhờ Điều phối merge/);
    expect(text(body({ k: 'doneLane', name: 'A2' }))).not.toContain('Nhờ Điều phối merge');
  });
});

describe('§4.14 N5-m "Không chạy tiếp được": dimmed button + reason band + the alternative', () => {
  const cont = /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Chạy tiếp lane…/;
  test('§4.14 merged branch → button dimmed, band "Không chạy tiếp được: Nhánh đã merge" + "nhắn Điều phối mở lane mới"', () => {
    const h = body({ k: 'doneLane', name: 'A2' });
    expect(h).toMatch(cont);
    expect(text(h)).toContain('Không chạy tiếp được: Nhánh đã merge');
    expect(text(h)).toContain('nhắn Điều phối mở lane mới');
  });
  test('§4.14 transcript expired (done 31 days ago, cleanup 30) → dimmed with the reason', () => {
    const snap = snapOf({ lanes: [lane('D11', { state: 'done', updatedAt: NOW - 31 * 24 * H, branch: br('unmerged') })] });
    const h = body({ k: 'doneLane', name: 'D11' }, { snap });
    expect(h).toMatch(cont);
    expect(text(h)).toContain('Không chạy tiếp được: Claude Code đã xoá bản ghi sau 30 ngày (cleanupPeriodDays)');
  });
  test('§4.14 a lane that can continue has no band', () => {
    const h = body({ k: 'doneLane', name: 'D11' });
    expect(h).not.toMatch(cont);
    expect(text(h)).not.toContain('Không chạy tiếp được');
  });
});

// §4.15 §3 the Inspector side: crumb "Xong · 41" and the composer prefill under the draft (≤ 120 px is composerHeight)
import { Inspector } from '../src/ui/Inspector.tsx';
test('§4.15 §3 Inspector crumb reads "Xong · n" from the engine total', () => {
  const snap = snapOf();
  const h = text(html(<Inspector sel={{ k: 'doneList' }} target={{ kind: 'orchestrator', projectId: snap.projects[0]!.id }} snap={snap} project={snap.projects[0]!} now={NOW} offline={false} dataAt={null} subs={{}}
    stream={undefined} live={undefined} subLines={[]} subLoading={false} subLive={undefined} hideTools={false} onHideTools={() => {}} paused={false} draft={null} inputRef={createRef<HTMLTextAreaElement>()}
    onSel={() => {}} onClose={() => {}} onMenu={() => {}} modal={false} token={() => null} onFocusInput={() => {}} onSend={() => Promise.resolve()} onInterrupt={() => {}} onLocal={() => {}} onStopAsk={() => {}}
    onOrchestrator={() => {}} onOlder={() => {}} onJumpEnd={() => {}} onError={() => {}} onResume={() => {}} onProjectResume={() => Promise.resolve()} sessions={snap.orchestrators}
    viewed={snap.orchestrators[0] ?? null} sessionsList={null} onHistory={() => {}} onView={() => {}} onSessionResume={() => {}} onOpenHandoff={() => {}}
    loadPreview={() => Promise.resolve(null)} onPause={() => {}} onMoveAll={() => {}} onRelogin={() => {}} onEditCaps={() => {}} done={done} modelSend={() => Promise.resolve(null)} modelReq={{ n: 0 }} />));
  expect(h).toContain('Xong · 41');
});
