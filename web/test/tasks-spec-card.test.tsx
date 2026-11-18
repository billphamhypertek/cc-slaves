// v2.7 G4b: the spec card (§4.3 / §4.8, IS14 IS15 IS17 IS18, IS13b), the spec overview (§4.3 D99, IS22 / IS22b, R-B14),
// Tài liệu (§4.10, IS20), the Huỷ popover texts (§4.4, §5.7, R-B12) and the IS17 rules (§4.9, §5.2-10).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { makeT } from '../../shared/i18n/index.ts';
import type { IssueCancelPreview, PriorSession, SpecOutput } from '../../shared/issues.ts';
import type { OrchestratorView } from '../../shared/protocol.ts';
import { onCodeOpen } from '../src/lib/code-open.ts';
import { LangProvider } from '../src/lib/i18n.tsx';
import { issueCmds, type TasksUi } from '../src/lib/issues.ts';
import { askCancel, canCancel, CancelAction, cancelText, confirmLabel, onAskCancel, previewSig } from '../src/tasks/CancelPop.tsx';
import { docFailText, docLabel, docOpen, DocRow, DocsMenu, docWhere, rowClick, type DocEnv } from '../src/tasks/DocsList.tsx';
import { priorDefault, priorRows, priorWhere } from '../src/tasks/PriorSessions.tsx';
import { cardModel, MarkMenu, markPick, SpecCard } from '../src/tasks/SpecCard.tsx';
import { laneCluster } from '../src/tasks/IssueList.model.ts';
import { overviewCounts, overviewRows, SpecOverview } from '../src/tasks/SpecOverview.tsx';
import type { TasksCtx } from '../src/tasks/tasks-ctx.ts';
import { issueInfo, poWf, projIssues, specInfo } from './fixtures.ts';

const tr = makeT('vi');
const html = (el: ReactElement) => renderToStaticMarkup(<LangProvider lang="vi">{el}</LangProvider>);
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const UI0: TasksUi = { sel: null, issue: null, doneOpen: false, specDoneOpen: false, cancelledOpen: false, folded: [], arising: false };
const q = { tr, quotaAt: () => null };
const orch = (sessionId: string, title: string | null = null, orchKind: OrchestratorView['orchKind'] = 'design') =>
  ({ projectId: 'p1', sessionId, title, orchKind }) as OrchestratorView;
const ctx = (o: Partial<TasksCtx> = {}): TasksCtx => ({
  project: { id: 'p1', name: 'hagenta', path: '/w/hagenta' }, pi: projIssues([], []), ui: UI0, setUi: () => {},
  cmds: issueCmds(() => new Promise(() => {}), 'p1'), locked: false, capFull: false, sessions: [], narrow: false,
  toDeck: () => {}, toCode: () => {}, start: () => {}, ask: null, setPop: () => {},
  live: { lanes: [], accounts: [], cards: [], importNotice: null, wf: { id: null, rows: [], fallback: null }, quotaAt: () => null }, wf: poWf(), send: () => new Promise(() => {}), now: Date.now(), ...o,
});

describe('§4.8 spec card buttons by state + locks', () => {
  const acts = (m: ReturnType<typeof cardModel>) => m.btns.map(b => `${b.act}${b.off ? '!' : ''}`);
  test('§4.8 UX I7 Đang thiết kế: no footer button while the Thiết kế session runs (Tới phiên is on its row), else Mở phiên', () => {
    const s = specInfo(1, { state: 'draft', sessions: { design: 's1', build: null, edit: null } });
    const live = ctx({ sessions: [orch('s1')] });
    expect(acts(cardModel(s, live, tr))).toEqual([]);
    expect(cardModel(s, live, tr).note).toContain('ok duyệt');
    expect((text(html(<SpecCard c={live} spec={s} />)).match(/Tới phiên/g) ?? []).length).toBe(1);
    expect(acts(cardModel(s, ctx(), tr))).toEqual(['open']);
    expect(cardModel(s, ctx(), tr).note).toContain('ok duyệt');
  });
  test('§4.8 Chờ build: Bắt đầu build · Sửa spec; Tiếp tục build when imported mid-build (not yet resumed)', () => {
    expect(acts(cardModel(specInfo(1, { state: 'approved' }), ctx(), tr))).toEqual(['build', 'edit']);
    expect(acts(cardModel(specInfo(1, { state: 'approved', outsideBuild: true }), ctx(), tr))).toEqual(['resume', 'edit']);
    expect(acts(cardModel(specInfo(1, { state: 'approved', outsideBuild: true, resumed: true }), ctx(), tr))).toEqual(['build', 'edit']);
  });
  test('IS18 being edited: Bắt đầu build off "đang sửa spec", no Sửa spec, "đang sửa spec · Tới phiên" on the edit session', () => {
    const m = cardModel(specInfo(1, { state: 'approved', editing: true, sessions: { design: null, build: null, edit: 'e1' } }), ctx(), tr);
    expect(acts(m)).toEqual(['build!']);
    expect(m.btns[0]!.off).toBe('đang sửa spec');
    expect(m.editingGoto).toBe('e1');
  });
  test('IS13b 3 sessions: Mở phiên / Bắt đầu build / Sửa spec off with the R34 reason as the note; IS8c offline wins', () => {
    const cap = ctx({ capFull: true });
    const m = cardModel(specInfo(1, { state: 'approved' }), cap, tr);
    expect(acts(m)).toEqual(['build!', 'edit!']);
    expect(m.note).toBe('Đã đủ 3 phiên Thiết kế / Build — đóng bớt một phiên');
    expect(acts(cardModel(specInfo(1, { state: 'draft' }), cap, tr))).toEqual(['open!']);
    expect(cardModel(specInfo(1, { state: 'approved' }), ctx({ capFull: true, locked: true }), tr).btns[0]!.off).toBe('Mất kết nối engine — chờ nối lại');
    expect(acts(cardModel(specInfo(1, { state: 'draft', sessions: { design: 's1', build: null, edit: null } }), ctx({ capFull: true, sessions: [orch('s1')] }), tr))).toEqual([]);
  });
  test('IS15 `after` not done: the "sau v2.5" chip instead of Bắt đầu build, the note counts what is left; done `after` → free', () => {
    const v25 = specInfo(4, { title: 'v2.5 Toolkit graph', state: 'active', progress: { done: 8, total: 13, scope: 0, cancelled: 0, amend: 0 } });
    const after = { id: 4, path: v25.path, title: v25.title, state: 'active' as const };
    const m = cardModel(specInfo(3, { state: 'approved', after }), ctx({ pi: projIssues([v25], []) }), tr);
    expect(m.afterChip).toBe('sau v2.5');
    expect(acts(m)).toEqual(['edit']);
    expect(m.note).toBe('v2.5 Toolkit graph còn 5 mục — nút mở khi v2.5 xong.');
    expect(acts(cardModel(specInfo(3, { state: 'approved', after: { ...after, state: 'done' } }), ctx(), tr))).toEqual(['build', 'edit']);
  });
  test('§4.8 "⋯ Đánh dấu" only for an imported spec never built in cc-slaves', () => {
    expect(cardModel(specInfo(1, { state: 'approved', origin: 'imported' }), ctx(), tr).mark).toBe(true);
    expect(cardModel(specInfo(1, { state: 'approved', origin: 'app' }), ctx(), tr).mark).toBe(false);
    expect(cardModel(specInfo(1, { state: 'approved', origin: 'imported', resumed: true }), ctx(), tr).mark).toBe(false);
    expect(cardModel(specInfo(1, { state: 'approved', origin: 'imported', sessions: { design: null, build: 'b1', edit: null } }), ctx(), tr).mark).toBe(false);
  });
  test('IS15 / IS17 / IS18 card text: groups summary + note, imported Duyệt, yellow outside build, red mất file', () => {
    const h = html(<SpecCard c={ctx()} spec={specInfo(2, { title: 'v2.6 Updater', state: 'approved', origin: 'imported', groups: '7 nhóm · G0–G6', branch: 'v26', outsideBuild: true, missing: true })} />);
    const t = text(h);
    expect(t).toContain('Chờ build · nhập từ docs/specs · đang build dở ngoài cc-slaves · mất file');
    expect(h).toContain('<span class="warn">đang build dở ngoài cc-slaves</span>');
    expect(h).toContain('<span class="bad">mất file</span>');
    expect(t).toContain('Nhóm việc 7 nhóm · G0–G6 (mục được tạo khi tiếp tục build)');
    expect(t).toContain('Phiên Thiết kế chưa có — spec viết ngoài cc-slaves');
    expect(t).toContain('Duyệt trước khi nhập (theo dòng trạng thái)');
    expect(t).toContain('Làm sau — (build được ngay)');
    expect(t).toContain('Tiếp tục build');
    expect(h).toContain('aria-label="Đánh dấu trạng thái"');
  });
});

describe('§4.8 UX I8 the "⋯ → Đánh dấu" menu', () => {
  test('I8 the current state carries ✓ on a --sel row (not disabled), the other is plain; the note explains the scope', () => {
    const h = html(<MarkMenu state="approved" pick={() => {}} />);
    expect(h).not.toContain('disabled');
    expect(h).toMatch(/role="menuitemradio" aria-checked="true" class="on"><span class="ck">✓<\/span>Chờ build/);
    expect(h).toMatch(/role="menuitemradio" aria-checked="false"><span class="ck"><\/span>Đang thiết kế/);
    expect(text(h)).toContain('Sửa khi cc-slaves đoán sai. Chỉ đổi trong cc-slaves, không sửa file.');
    const css = readFileSync(new URL('../src/tasks/spec-card.css', import.meta.url), 'utf8');
    expect(css).toContain('.tsk .smenu button.on{background:var(--sel)}');
  });
  test('I8 picking the current state changes nothing; the other one is sent', () => {
    const got: string[] = [];
    const pick = markPick('approved', s => got.push(s));
    pick('approved');
    pick('draft');
    expect(got).toEqual(['draft']);
  });
});

describe('§4.3 D99 the spec overview (R-B14)', () => {
  const issues = [
    issueInfo(47, { state: 'doing' }), issueInfo(50, { state: 'doing', source: 'lane' }), issueInfo(44), issueInfo(49, { waitingOn: ['T-44'] }),
    issueInfo(53, { state: 'done', source: 'lane' }), issueInfo(46, { state: 'done' }), issueInfo(37, { state: 'cancelled', source: 'lane' }),
  ];
  test('D99 counts by block, only those > 0, then "phát sinh thêm" (not cancelled) and "bổ sung"', () => {
    expect(overviewCounts(issues, tr)).toBe('2 đang làm · 1 sẵn sàng · 1 bị chặn · 2 xong · 1 huỷ · 2 phát sinh thêm');
    expect(overviewCounts([issueInfo(1, { state: 'done' }), issueInfo(2, { source: 'amend' })], tr)).toBe('1 sẵn sàng · 1 xong · 1 bổ sung');
  });
  test('§4.3 lane cluster: "D2 · code", "D4 · hỏng" red, "R5 · chờ quota", "B3 · chờ PO" yellow', () => {
    expect(laneCluster({ name: 'D2', state: 'running', phase: 'code' }, q)).toEqual({ text: 'D2 · code', tone: null });
    expect(laneCluster({ name: 'D4', state: 'broken', phase: 'code' }, q)).toEqual({ text: 'D4 · hỏng', tone: 'bad' });
    expect(laneCluster({ name: 'R5', state: 'waiting_quota', phase: 'code' }, q)).toEqual({ text: 'R5 · chờ quota', tone: null });
    expect(laneCluster({ name: 'B3', state: 'waiting_po', phase: null }, q)).toEqual({ text: 'B3 · chờ PO', tone: 'warn' });
  });
  const ov = { buildSession: { id: 'b1', title: 'Build · v2.5', state: 'running' as const }, lanes: [], lastAmend: null, commits: 21, mergedInto: null };
  test('IS22 Đang build rows: Phiên Build · Bắt đầu build · Duyệt · Nhánh · Lane đang làm; Bổ sung / Làm sau only when there', () => {
    const keys = (s: Parameters<typeof overviewRows>[0]) => overviewRows(s, ctx(), tr).map(r => r.k);
    expect(keys(specInfo(4, { overview: ov }))).toEqual(['build', 'opened', 'approved', 'branch', 'lanes']);
    const am = specInfo(4, { overview: { ...ov, lastAmend: { rev: 2, issueCount: 3, at: 1 } }, after: { id: 9, path: 'x', title: 'v2.4', state: 'done' } });
    expect(keys(am)).toEqual(['build', 'opened', 'approved', 'branch', 'lanes', 'amend', 'after']);
  });
  test('IS22b Xong rows: Phiên Build (đã đóng, no Tới phiên) · Build from → to · Duyệt · Commit · Nhánh đã merge vào main', () => {
    const s = specInfo(5, { title: 'v2.4 Model + attach', state: 'done', overview: { ...ov, buildSession: { id: 'b2', title: 'Build · v2.4', state: 'closed' }, commits: 34, mergedInto: 'main' } });
    expect(overviewRows(s, ctx(), tr).map(r => r.k)).toEqual(['build', 'span', 'approved', 'commits', 'branch']);
    const t = text(html(<SpecOverview c={ctx()} spec={s} />));
    expect(t).toContain('Build · v2.4 · đã đóng');
    expect(t).not.toContain('Tới phiên');
    expect(t).toContain('Commit 34 commit');
    expect(t).toContain('đã merge vào main');
    expect(t).toContain('v2.4 Model + attach · Xong');
  });
  test('IS22 the running Build session has Tới phiên (to Deck on it); no other action button in the card', () => {
    let went: string | undefined;
    const r = overviewRows(specInfo(4, { overview: ov }), ctx({ toDeck: s => { went = s; } }), tr)[0]!;
    const h = html(<>{r.value}</>);
    expect(text(h)).toContain('Build · v2.5 · đang chạy');
    expect(h).toContain('Tới phiên');
    const btn = (r.value as ReactElement<{ children: ReactElement<{ onClick: () => void }>[] }>).props.children[1]!;
    btn.props.onClick();
    expect(went).toBe('b1');
    const card = html(<SpecOverview c={ctx()} spec={specInfo(4, { overview: ov })} />);
    expect(card.match(/<button/g)?.length).toBe(1);
  });
});

describe('§4.10 Tài liệu rows', () => {
  const out = (o: Partial<SpecOutput>): SpecOutput => ({ role: 'doc', kind: 'md', ref: 'docs/ref/r.md', label: null, display: 'docs/ref/r.md', addedBy: 'auto', state: 'ok', ...o });
  test('§4.10 labels: Spec · Mockup · "Ảnh mockup · 27" · a label, else the file name · a link label, else "Link"', () => {
    expect(docLabel(out({ role: 'spec' }), tr)).toBe('Spec');
    expect(docLabel(out({ role: 'mockup', kind: 'html' }), tr)).toBe('Mockup');
    expect(docLabel(out({ role: 'images', kind: 'image', count: 27 }), tr)).toBe('Ảnh mockup · 27');
    expect(docLabel(out({ label: 'Nghiên cứu' }), tr)).toBe('Nghiên cứu');
    expect(docLabel(out({}), tr)).toBe('r.md');
    expect(docLabel(out({ role: 'link', kind: 'link', ref: 'http://localhost:5173/' }), tr)).toBe('Link');
  });
  test('§4.10 R32 where: .html and links → "Trình duyệt", the rest → "Code"', () => {
    expect([out({}), out({ kind: 'image' }), out({ kind: 'html' }), out({ kind: 'link' }), out({ kind: 'other' })].map(docWhere)).toEqual(['code', 'code', 'browser', 'browser', 'code']);
  });
  const env = (refuse?: string) => {
    const log: string[] = [];
    const go = (s: string) => { log.push(s); return refuse ? Promise.reject(new Error(refuse)) : Promise.resolve(); };
    const e: DocEnv = { root: '/w/hagenta/', toCode: () => log.push('code'), openDoc: p => go(`doc ${p}`), openUrl: u => go(`url ${u}`), fail: (o, why) => log.push(`fail ${o.kind} ${why instanceof Error ? why.message : String(why)}`) };
    return { e, log };
  };
  test('§4.10 open: .md / image → Code (requestCodeOpen on the base); .html → open_doc absolute; http(s) → browser; mất file / mailto → nothing', () => {
    const { e, log } = env();
    expect(docOpen(out({}), e)).toBe(true);
    const sub = onCodeOpen(() => {});
    expect(sub.pending?.path).toBe('docs/ref/r.md');
    expect(sub.pending?.src).toEqual({ kind: 'base' });
    sub.off();
    expect(docOpen(out({ kind: 'html', ref: 'docs/specs/assets/m.html' }), e)).toBeInstanceOf(Promise);
    expect(docOpen(out({ kind: 'link', ref: 'http://localhost:5173/?token=abc' }), e)).toBeInstanceOf(Promise);
    expect(docOpen(out({ state: 'missing' }), e)).toBe(false);
    expect(docOpen(out({ kind: 'link', ref: 'mailto:a@b.c' }), e)).toBe(false);
    expect(docOpen(out({ kind: 'link', ref: 'javascript:alert(1)' }), e)).toBe(false);
    expect(log).toEqual(['code', 'doc /w/hagenta/docs/specs/assets/m.html', 'url http://localhost:5173/?token=abc']);
  });
  test('hf1117-docs a refused / failed open says why (never silent): .html and links → fail(row, reason); the text names the row and the reason in words', async () => {
    const { e, log } = env('outside_project');
    await docOpen(out({ kind: 'html', ref: 'docs/specs/assets/m.html' }), e);
    await docOpen(out({ kind: 'link', ref: 'https://x.test/p' }), e);
    expect(log).toEqual(['doc /w/hagenta/docs/specs/assets/m.html', 'fail html outside_project', 'url https://x.test/p', 'fail link outside_project']);
    const m = out({ role: 'mockup', kind: 'html', ref: 'docs/specs/assets/m.html' });
    expect(docFailText(tr, m, 'outside_project')).toBe('Không mở được Mockup: file nằm ngoài các project đang mở');
    expect(docFailText(tr, m, 'not_found')).toBe('Không mở được Mockup: không tìm thấy file');
    expect(docFailText(tr, m, 'mac_only')).toBe('Không mở được Mockup: file .html chỉ mở được trong app Mac');
    expect(docFailText(tr, m, new Error('open thoát với mã 1'))).toBe('Không mở được Mockup: open thoát với mã 1');
    expect(docFailText(tr, m, 'no_token')).toBe('Không mở được Mockup: app chưa kết nối được engine');
    expect(docFailText(tr, m, new Error('engine_unreachable'))).toBe('Không mở được Mockup: không kết nối được engine');
    expect(docFailText(tr, m, 'zap_unknown')).toBe('Không mở được Mockup: lỗi không rõ');
    expect(docFailText(makeT('en'), m, 'forbidden_origin')).toBe('Could not open Mockup: blocked, the request did not come from the app window');
  });
  test('hf1117-fb MINOR-2 a browser open marks the row busy until it settles; clicks while busy are ignored; done after', async () => {
    let settle = (): void => {};
    const log: string[] = [];
    const e: DocEnv = { root: '/w', toCode: () => log.push('code'), openUrl: () => new Promise<void>(r => { settle = r; }),
      openDoc: () => Promise.reject(new Error('not_found')), fail: () => log.push('fail') };
    const busy = { current: false };
    const set = (b: boolean) => log.push(`busy ${b}`);
    const link = out({ kind: 'link', ref: 'https://x.test/p' });
    const p = rowClick(link, e, busy, set, () => log.push('done'));
    expect(busy.current).toBe(true);
    expect(rowClick(link, e, busy, set, () => log.push('done'))).toBeNull();
    expect(log).toEqual(['busy true']);
    settle(); await p;
    expect(busy.current).toBe(false);
    expect(log).toEqual(['busy true', 'busy false', 'done']);
    log.length = 0;
    await rowClick(out({ kind: 'html', ref: 'm.html' }), e, busy, set);
    expect(log).toEqual(['busy true', 'fail', 'busy false']);
    log.length = 0;
    expect(rowClick(out({}), e, busy, set, () => log.push('done'))).toBeNull();
    expect(log).toEqual(['code', 'done']);
  });
  test('§4.10 R33 a row shows `display` (token masked), never the `ref`; "đã tắt" dims, "mất file" is red and disabled', () => {
    const { e } = env();
    const link = out({ role: 'link', kind: 'link', ref: 'http://localhost:5173/?token=SECRET', display: 'localhost:5173/?token=…', state: 'off', label: 'Prototype' });
    const h = html(<DocRow o={link} env={e} tr={tr} />);
    expect(h).not.toContain('SECRET');
    expect(h).toContain('localhost:5173/?token=…');
    expect(h).toContain('class="drow off"');
    expect(text(h)).toContain('đã tắt · Trình duyệt');
    const miss = html(<DocRow o={out({ state: 'missing', label: 'Đo G0' })} env={e} tr={tr} />);
    expect(miss).toContain('class="drow miss"');
    expect(miss).toContain('disabled=""');
    expect(text(miss)).toContain('mất file');
  });
});

describe('§4.4 / §5.7 the Huỷ popover (R-B12 numbers)', () => {
  const pv = (o: Partial<IssueCancelPreview>): IssueCancelPreview => ({ key: 'T-44', mode: 'cancel', lane: null, revert: null, dependants: { open: [], done: [] }, ...o });
  const plain = (s: string) => s.replace(/<\/?[bck]>/g, '');
  test('IS4a todo (R-B19 M2, the mockup copy): "Huỷ T-44? Chưa có code." · no lane stopped · T-49 "sẽ bị chặn" · "Huỷ mục"', () => {
    const t = cancelText(pv({ dependants: { open: ['T-49'], done: [] } }), 'todo', tr);
    expect(t.head).toBe('Huỷ T-44? Chưa có code.');
    expect(t.does).toEqual(['Mục chuyển sang Huỷ ngay; không lane nào bị dừng.']);
    expect(t.warns.map(plain)).toEqual(['T-49 đang chờ T-44 → T-49 sẽ bị chặn tới khi Điều phối gỡ phụ thuộc.']);
    expect(confirmLabel([pv({})], tr)).toBe('Huỷ mục');
  });
  test('§5.7-4 (review C MINOR-3) the preview is fetched again when the issue moves while IS4 is open', () => {
    const base = [issueInfo(44), issueInfo(49, { blockedBy: ['T-44'] })];
    const sig = previewSig(base, ['T-44']);
    expect(previewSig([issueInfo(44), issueInfo(50)], ['T-44'])).toBe(sig); // another issue moving changes nothing
    for (const o of [{ state: 'doing' as const }, { lane: { name: 'D2', state: 'running', phase: null } }, { revert: 'pending' as const },
      { commits: [{ sha: 'a1', branch: 'main', at: 1 }] }, { blocks: ['T-49'] }]) {
      expect(previewSig([issueInfo(44, o)], ['T-44'])).not.toBe(sig);
    }
    expect(previewSig(base, ['T-44', 'T-49'])).not.toBe(sig);
  });
  test('IS4b doing not merged: stop lane F1 now · drop branch fix-b52 (2 commit) — no revert · "Huỷ mục"', () => {
    const p = pv({ key: 'B-52', mode: 'stop', lane: { name: 'F1', branch: 'fix-b52', commits: 2 } });
    const t = cancelText(p, 'doing', tr);
    expect(t.head).toBe('Huỷ B-52 đang làm?');
    expect(t.does.map(plain)).toEqual(['Dừng lane F1 ngay (lượt đang chạy bị cắt)', 'Bỏ nhánh fix-b52 (2 commit chưa merge) — không cần hoàn tác']);
    expect(cancelText(pv({ mode: 'stop', lane: { name: 'F1', branch: null, commits: 0 } }), 'doing', tr).does.map(plain)[1]).toBe('Chưa có commit — không cần hoàn tác');
    expect(confirmLabel([p], tr)).toBe('Huỷ mục');
  });
  test('IS4c done: T-54 "Hoàn tác T-46" folds 3 commits on main (shas) · open + done dependants · "Huỷ và hoàn tác"', () => {
    const p = pv({ key: 'T-46', mode: 'revert', revert: { branch: 'main', shas: ['9c1e2fa', '41b7d03', 'd88a6e1'], key: 'T-54' }, dependants: { open: ['T-49'], done: ['T-53'] } });
    const t = cancelText(p, 'done', tr);
    expect(t.head).toBe('Huỷ T-46 đã xong?');
    expect(plain(t.does[0]!)).toBe('Tạo T-54 "Hoàn tác T-46": gộp 3 commit trên main (9c1e2fa, 41b7d03, d88a6e1) thành một commit hoàn tác · chạy lại test · merge');
    expect(t.warns.map(plain)).toEqual(['T-49 bị chặn tới khi Điều phối gỡ phụ thuộc.', 'T-53 (đã xong) xây trên T-46 → hoàn tác có thể vướng; vướng thì dừng và hỏi anh.']);
    expect(confirmLabel([p], tr)).toBe('Huỷ và hoàn tác');
    expect(cancelText(p, 'doing', tr).head).toBe('Huỷ T-46 đang làm?'); // §5.7-3 a doing merged in part reads as revert
  });
  test('§5.7-4 more than 3 commits: the first 3 shas then "…"; no git → the no-commit wording', () => {
    const p = pv({ key: 'T-46', mode: 'revert', revert: { branch: 'v25', shas: ['a', 'b', 'c', 'd'], key: 'T-54' } });
    expect(plain(cancelText(p, 'done', tr).does[0]!)).toContain('gộp 4 commit trên v25 (a, b, c, …)');
    expect(plain(cancelText(pv({ mode: 'revert', revert: { branch: null, shas: [], key: 'T-54' } }), 'done', tr).does[0]!)).toContain('không có git');
  });
  test('IS5b two keys → "Huỷ cả hai"', () => {
    expect(confirmLabel([pv({ mode: 'revert' }), pv({ mode: 'revert' })], tr)).toBe('Huỷ cả hai');
  });
  test('§5.7 Huỷ hidden: cancelled, revert pending / running / conflict, prior, a revert issue; done / revert done keep it', () => {
    const i = (o: Parameters<typeof issueInfo>[1]) => canCancel(issueInfo(1, o));
    expect(i({})).toBe(true);
    expect(i({ state: 'done' })).toBe(true);
    expect(i({ state: 'cancelled' })).toBe(false);
    for (const revert of ['pending', 'running', 'conflict'] as const) expect(i({ state: 'done', revert })).toBe(false);
    expect(i({ source: 'prior', state: 'done' })).toBe(false);
    expect(i({ reverts: 'T-46' })).toBe(false);
    expect(html(<CancelAction c={ctx()} issue={issueInfo(1, { state: 'cancelled' })} />)).toBe('');
    expect(html(<CancelAction c={ctx({ locked: true })} issue={issueInfo(1)} />)).toContain('disabled=""');
  });
});

describe('§4.9 IS17 prior sessions', () => {
  const ps = (id: string, lastAt: number, o: Partial<PriorSession> = {}): PriorSession => ({ id, firstText: id, lastAt, turns: 10, cwd: null, runningElsewhere: false, long: false, model: null, effort: null, ...o });
  test('§4.9 at most 5 rows, newest first', () => {
    expect(priorRows([1, 7, 3, 9, 5, 2, 8].map(n => ps(`s${n}`, n))).map(s => s.id)).toEqual(['s9', 's8', 's7', 's5', 's3']);
  });
  test('§4.9 preselect: the newest takeable; running elsewhere is skipped; > 400 turns (long) → Build mới; none → Build mới', () => {
    expect(priorDefault([ps('a', 3), ps('b', 2)])).toBe('a');
    expect(priorDefault([ps('a', 3, { runningElsewhere: true }), ps('b', 2)])).toBe('b');
    expect(priorDefault([ps('a', 3, { long: true }), ps('b', 2, { long: true })])).toBeNull();
    expect(priorDefault([ps('a', 3, { runningElsewhere: true })])).toBeNull();
    expect(priorDefault([])).toBeNull();
  });
  test('§4.9 folder: the project root → "thư mục gốc", a worktree → its folder name', () => {
    expect(priorWhere('/w/hagenta/', '/w/hagenta', tr)).toBe('thư mục gốc');
    expect(priorWhere(null, '/w/hagenta', tr)).toBe('thư mục gốc');
    expect(priorWhere('/w/hagenta-v25', '/w/hagenta', tr)).toBe('worktree hagenta-v25');
  });
});

describe('IS5b askCancel → the Tasks tab that listens', () => {
  test('"Huỷ cả hai…" reaches every listener with the keys; an unsubscribed one hears nothing', () => {
    const got: string[] = [];
    const off = onAskCancel((pid, keys) => got.push(`${pid}:${keys.join(',')}`));
    askCancel('p1', ['T-46', 'T-54']);
    off();
    askCancel('p1', ['T-1']);
    expect(got).toEqual(['p1:T-46,T-54']);
  });
});

describe('UX review part C: IS17 footer, IS10c Tài liệu item', () => {
  test('M10 IS17 the footer note sits left, right after "Esc" (no auto margin pushing it right)', () => {
    const css = readFileSync(new URL('../src/tasks/spec-card.css', import.meta.url), 'utf8');
    expect(css).toContain('.tsk .cfoot .kb{margin-right:auto;');
    expect(css).not.toMatch(/\.pfoot \.kb\{[^}]*margin-right:auto/);
  });
  test('M3 IS10c inside the "⋯" menu, Tài liệu is a menu item: doc icon + label + › (opens to the side)', () => {
    const h = html(<DocsMenu c={ctx()} spec={specInfo(1, { state: 'active' })} item />);
    expect(h).toMatch(/^<button type="button" role="menuitem" class="dmi" aria-expanded="false" aria-haspopup="true">/);
    expect(h).toContain(`<svg class="i"`);
    expect(text(h)).toContain('Tài liệu');
    expect(h).toContain('<span class="dmc">');
  });
});
