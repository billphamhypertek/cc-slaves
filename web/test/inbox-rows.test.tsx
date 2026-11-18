// v2.4 §6.7 D52 Chờ PO as a compact list: one row per card (rowActions / tone / text), the detail box (modal), keys,
// Esc order, ClickGuard + 5 s undo on the row buttons, remote 🔒, offline. Layout is measured in e2e (v21-leftcol, f15).
import { describe, expect, test } from 'bun:test';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { makeT } from '../../shared/i18n/index.ts';
import type { CardView } from '../../shared/protocol.ts';
import { boxCardOf, ClickGuard, keyPick, rowActions, rowText, rowTone, UndoQueue, visibleCards, type KeyPickCtx, type Timers } from '../src/lib/cards.ts';
import { cardActions } from '../src/lib/remote.ts';
import { LangProvider } from '../src/lib/i18n.tsx';
import { CardRow, type CardRowProps } from '../src/ui/Card.tsx';
import { CardDetail, type CardDetailProps } from '../src/ui/CardDetail.tsx';
import { Inbox } from '../src/ui/Inbox.tsx';
import { boxAction, deckIntent } from '../src/ui/appIntents.ts';
import { bootScreen, escapeStep, type EscState } from '../src/ui/shell.ts';
import type { ShellCtx } from '../src/ui/shellCtx.ts';
import { card } from './fixtures.ts';

const VI = makeT('vi');
const html = (el: ReactElement) => renderToStaticMarkup(<LangProvider lang="vi">{el}</LangProvider>);
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const LABEL: Record<string, string> = { view_log: 'Xem log', lane_resume: 'Chạy lại', mcp_login: 'Đăng nhập', mcp_snooze: 'Để sau' };
const act = (id: string) => ({ id, label: LABEL[id] ?? id });

const perm = card(1, { kind: 'permission', title: 'D2 xin chạy: Bash `rm -rf build/`', titleKey: 'cards.permission', params: { source: 'D2', tool: 'Bash', main: 'rm -rf build/' },
  question: undefined, options: undefined, context: 'rm -rf build/ && bun run build', canAllowAlways: true });
const ask = card(2, { context: 'Module billing đang export 14 hàm cũ.', options: [{ label: 'Tách', description: 'billing-v2' }, { label: 'Giữ' }], recommended: 'Tách' });
const sys = (id: number, kind: CardView['kind'], actions: string[], over: Partial<CardView> = {}) =>
  card(id, { kind, source: null, question: undefined, options: undefined, title: `${kind} title`, actions: actions.map(a => act(a)), ...over });
const broken = sys(3, 'broken', ['lane_resume', 'view_log', 'hand_to_orchestrator'], { key: 'lane:R5', titleKey: 'cards.laneBroken', params: { name: 'R5' },
  context: 'npm ERR!\nexit 1 · npm run test:unit\n\n' });
const down = sys(4, 'orchestrator_down', ['restart_orchestrator', 'new_orchestrator'], { context: 'exit 1 (đã tự khởi động lại 1 lần)' });
const out = sys(5, 'logged_out', ['account_relogin'], { key: 'acc07@x' });
const ccOk = sys(6, 'cc_updated', ['dismiss']);
const ccBad = sys(7, 'cc_updated', ['setup_check', 'dismiss']);
const cfg = sys(8, 'shared_cfg', ['shared_cfg_merge', 'dismiss'], { key: 'acc07@x/skills' });
const cfgBroken = sys(9, 'shared_cfg', ['dismiss']);
const orphan = sys(10, 'account_orphan', ['account_orphan_adopt', 'account_orphan_delete'], { key: '/a/old' });
const cutover = sys(11, 'cutover', ['account_add']);
const mcp = sys(12, 'mcp_login', ['mcp_login', 'mcp_snooze'], { key: 'github', titleKey: 'cards.mcpLogin', params: { name: 'github', lanes: 'D2, B3', scope: '' } });
const ALL = [perm, ask, broken, down, out, ccOk, ccBad, cfg, cfgBroken, orphan, cutover, mcp];
const brief = (c: CardView, ch: 'mac' | 'remote' = 'mac') => rowActions(c, ch).map(a => a.t === 'answer' ? a.b : a.t === 'open' ? 'open' : `${a.locked ? '🔒' : ''}${a.id}`);

describe('§6.7 rowActions: the row buttons of every kind', () => {
  test('§6.7 Mac: ✓ ✕ · › · 📄 ↻ · ↻ · ⇥ · ✓ / ↻ ✓ · ⑂ · › · › · 👤+ · ⇥', () => {
    expect(ALL.map(c => brief(c))).toEqual([
      ['allow', 'deny'], ['open'], ['view_log', 'lane_resume'], ['restart_orchestrator'], ['account_relogin'], ['dismiss'], ['setup_check', 'dismiss'],
      ['shared_cfg_merge'], ['open'], ['open'], ['account_add'], ['mcp_login'],
    ]);
  });
  test('§6.7 a resolved card has no row button', () => {
    expect(rowActions({ ...perm, status: 'answered' }, 'mac')).toEqual([]);
  });
  test('§6.7 remote (CARD_ACTION_CMD + canRun): a Mac-only button becomes 🔒 on the row; answers, › and Chạy lại stay', () => {
    expect(ALL.map(c => brief(c, 'remote'))).toEqual([
      ['allow', 'deny'], ['open'], ['view_log', 'lane_resume'], ['🔒restart_orchestrator'], ['🔒account_relogin'], ['dismiss'], ['🔒setup_check', 'dismiss'],
      ['🔒shared_cfg_merge'], ['open'], ['open'], ['🔒account_add'], ['🔒mcp_login'],
    ]);
  });
  test('§6.7 CP6 in the box cardActions still hides what remote cannot run (MCP: no Đăng nhập, no Để sau)', () => {
    expect(cardActions(mcp, 'remote')).toEqual([]);
    expect(cardActions(broken, 'remote').map(a => a.id)).toEqual(['lane_resume', 'view_log', 'hand_to_orchestrator']);
  });
  test('§6.7 I1 visibleCards still leaves shared_cfg_new out of Chờ PO (10 visible kinds)', () => {
    expect(visibleCards([...ALL, sys(13, 'shared_cfg_new', [])], 'p1').map(c => c.kind)).not.toContain('shared_cfg_new');
  });
});

describe('§6.7 glyph colour by kind', () => {
  test('§6.7 amber permission / ask; red broken, orchestrator_down, logged_out, cutover, mcp_login, failed cc_updated; grey the rest', () => {
    expect(ALL.map(rowTone)).toEqual(['warn', 'warn', 'bad', 'bad', 'bad', 'info', 'bad', 'info', 'info', 'info', 'bad', 'bad']);
  });
});

describe('§6.7 the row text', () => {
  test('§6.7 permission = params.tool + params.main (no source repeated)', () => {
    expect(rowText(VI, perm)).toEqual({ text: 'Bash', code: 'rm -rf build/' });
  });
  test('§6.7 broken = "Hỏng: " + the last non-empty line of cardBody()', () => {
    expect(rowText(VI, broken).text).toBe('Hỏng: exit 1 · npm run test:unit');
  });
  test('§6.7 ask = the question; orchestrator_down = its reason; no params (old card_v2) → title', () => {
    expect(rowText(VI, ask).text).toBe('Tách hay gộp?');
    expect(rowText(VI, down).text).toBe('Ngừng · exit 1 (đã tự khởi động lại 1 lần)');
    expect(rowText(VI, { ...perm, titleKey: undefined, params: undefined })).toEqual({ text: 'D2 xin chạy: Bash `rm -rf build/`' });
  });
});

/** Walks a rendered element tree (host elements + plain function components without hooks). */
function find(node: ReactNode, pred: (props: Record<string, unknown>, type: unknown) => boolean, acc: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(node)) { for (const n of node) find(n, pred, acc); return acc; }
  if (!isValidElement(node)) return acc;
  const props = node.props as Record<string, unknown>;
  if (pred(props, node.type)) acc.push(props);
  find(props.children as ReactNode, pred, acc);
  return acc;
}
const buttons = (el: ReactNode) => find(el, (_, t) => t === 'button');
const stop = { stopPropagation: () => {} };
const rowProps = (c: CardView, over: Partial<CardRowProps> = {}): CardRowProps => ({
  c, tr: VI, focused: false, isNew: false, channel: 'mac', offline: false, sessions: 1, undo: null,
  onChoose: () => {}, onUndo: () => {}, onAction: () => {}, onOpen: () => {}, ...over,
});

describe('§6.7 row buttons: undo, ClickGuard, aria', () => {
  test('§6.7 ✓ / ✕ → undo.choose with the v2.1 answer (nothing sent before 5 s)', () => {
    const sent: unknown[] = [];
    let now = 0; const q: (() => void)[] = [];
    const t: Timers = { now: () => now, setTimeout: f => { q.push(f); return q.length; }, clearTimeout: () => {} };
    const undo = new UndoQueue(a => sent.push(a), t);
    const el = CardRow(rowProps(perm, { onChoose: (label, answer) => undo.choose(perm.id, label, answer) }));
    const [ok, no] = buttons(el);
    (ok!.onClick as (e: unknown) => void)(stop);
    expect([undo.get(1)?.label, undo.remaining(1), sent.length]).toEqual(['Cho phép', 5, 0]);
    now = 5000; q.at(-1)!();
    expect(sent).toEqual([{ id: 1, answer: { behavior: 'allow' } }]);
    (no!.onClick as (e: unknown) => void)(stop);
    expect(undo.get(1)?.label).toBe('Từ chối');
    q.at(-1)!();
    expect(sent.at(-1)).toEqual({ id: 1, answer: { behavior: 'deny' } });
  });
  test('§6.7 in its undo the row says "Đã chọn “Cho phép” · gửi sau 4 s" + "Hoàn tác (4)" (v2.1 strings)', () => {
    const h = html(<CardRow {...rowProps(perm, { undo: { label: 'Cho phép', left: 4 } })} />);
    expect(text(h)).toContain('Đã chọn “Cho phép” · gửi sau 4 s');
    expect(h).toMatch(/<button[^>]*class="und"[^>]*>.*Hoàn tác \(4\)/);
  });
  test('§6.7 U1 ClickGuard: a click within 1 s of a list shift is ignored, then allowed', () => {
    let now = 0;
    const g = new ClickGuard(() => now);
    const hits: number[] = [];
    const f = g.wrap((n: number) => hits.push(n));
    g.shifted(); now = 999; f(1);
    now = 1000; f(2);
    expect(hits).toEqual([2]);
  });
  test('§6.7 every row button has an aria-label and the "<nhãn> ⌥n" tip (CP3); system buttons carry no key', () => {
    const p = buttons(CardRow(rowProps(perm)));
    expect(p.map(b => [b['aria-label'], b['data-tip']])).toEqual([['Cho phép', 'Cho phép ⌥1'], ['Từ chối', 'Từ chối ⌥3']]);
    const b = buttons(CardRow(rowProps(broken)));
    expect(b.map(x => x['aria-label'])).toEqual(['Xem log', 'Chạy lại']);
    expect(b.every(x => !String(x['data-tip']).includes('⌥'))).toBe(true);
    expect(buttons(CardRow(rowProps(ask)))[0]!['aria-label']).toBe('Xem chi tiết');
  });
  test('§6.7 remote: the 🔒 button keeps its place, is disabled and says "Chỉ làm trên Mac"', () => {
    const [b] = buttons(CardRow(rowProps(mcp, { channel: 'remote' })));
    expect(b!.disabled).toBe(true);
    expect(b!['data-tip']).toBe('Chỉ làm trên Mac');
  });
  test('§6.7 row click (outside a button) = onOpen (select + open the box); a button click does not open', () => {
    const opened: number[] = [], acts: string[] = [];
    const el = CardRow(rowProps(broken, { onOpen: () => opened.push(3), onAction: a => acts.push(a) }));
    (el.props as { onClick: () => void }).onClick();
    let stopped = false;
    (buttons(el)[1]!.onClick as (e: unknown) => void)({ stopPropagation: () => { stopped = true; } });
    expect([opened, acts, stopped]).toEqual([[3], ['lane_resume'], true]);
  });
  test('§6.7 offline: row buttons cannot be pressed', () => {
    expect(buttons(CardRow(rowProps(perm, { offline: true }))).every(b => b.disabled === true)).toBe(true);
  });
  test('§6.7 a resolved row shows the answer at the right; a handled system card "Đã xử lý"; cancelled / expired', () => {
    expect(text(html(<CardRow {...rowProps({ ...perm, status: 'answered', answer: { behavior: 'allow' } })} />))).toMatch(/Bash rm -rf build\/ Cho phép/);
    expect(text(html(<CardRow {...rowProps({ ...out, status: 'answered', answer: undefined })} />))).toContain('Đã xử lý');
    expect(text(html(<CardRow {...rowProps({ ...ask, status: 'cancelled' })} />))).toContain('Đã huỷ');
    expect(text(html(<CardRow {...rowProps({ ...ask, status: 'expired' })} />))).toContain('Đã hết hạn');
  });
  test('§6.7 the source chip: lane name, "Điều phối", "#2 · D2" with > 1 session; none on other system cards', () => {
    expect(html(<CardRow {...rowProps(perm)} />)).toMatch(/class="src">D2</);
    expect(html(<CardRow {...rowProps(down)} />)).toMatch(/class="src">Điều phối</);
    expect(html(<CardRow {...rowProps({ ...perm, seq: 2 }, { sessions: 2 })} />)).toMatch(/class="src">#2 · D2</);
    expect(html(<CardRow {...rowProps(out)} />)).not.toContain('class="src"');
  });
});

describe('§6.7 keys: ⌥1 / ⌥3 on a permission row; an ask only inside its box', () => {
  const pending = [perm, ask];
  const at = (focusId: number | null, boxId: number | null, n: number, over: Partial<KeyPickCtx> = {}) =>
    keyPick(VI, { pending, focusId, boxId, otherModal: false, offline: false, ...over }, n);
  test('§6.7 box closed: the selected permission row takes ⌥1 / ⌥3; a selected ask row takes nothing (no blind answer)', () => {
    expect(at(1, null, 1)).toMatchObject({ id: 1, answer: { behavior: 'allow' } });
    expect(at(1, null, 3)).toMatchObject({ id: 1, answer: { behavior: 'deny' } });
    expect(at(2, null, 1)).toBeNull();
  });
  test('§6.7 ⌥2 on a permission row → nothing; in its box → allow_always', () => {
    expect(at(1, null, 2)).toBeNull();
    expect(at(1, null, 4)).toBeNull();
    expect(at(null, 1, 2)).toMatchObject({ id: 1, label: 'Cho phép luôn trong phiên này', answer: { behavior: 'allow_always' } });
  });
  test('§6.7 I2 the ask box open → ⌥n goes to it even though a modal is open; another dialog over the box → nothing', () => {
    expect(at(1, 2, 2)).toMatchObject({ id: 2, answer: { option: 'Giữ' } });
    expect(at(1, 2, 1, { otherModal: true })).toBeNull();
    expect(at(1, null, 1, { otherModal: true })).toBeNull();
  });
  test('§6.7 offline: the box is read-only and rows cannot be answered → ⌥n does nothing', () => {
    expect(at(null, 2, 1, { offline: true })).toBeNull();
    expect(at(1, null, 1, { offline: true })).toBeNull();
  });
  test('§6.7 Esc order: accDlg → box → as today', () => {
    const none: EscState = { palette: false, stopLane: false, moveAll: false, addOpen: false, settings: false, wizard: false, up: false, drawer: false };
    expect(escapeStep({ ...none, accDlg: true, cardBox: true })).toBe('accDlg');
    expect(escapeStep({ ...none, cardBox: true, up: true, drawer: true })).toBe('cardBox');
    expect(escapeStep({ ...none, up: true })).toBe('up');
    expect(escapeStep({ ...none, cardBox: true, menu: true, sessList: true, accPanel: true })).toBe('cardBox'); // the box sits over a menu / list
  });
});

describe('§6.7 the detail box', () => {
  const box = (c: CardView, over: Partial<CardDetailProps> = {}) => html(<CardDetail c={c} channel="mac" offline={false} sessions={1}
    onChoose={() => {}} onAction={() => {}} onClose={() => {}} {...over} />);
  test('§6.7 CP2 ask: question, full context (no "Xem thêm"), every option with ⌥n + "Đề xuất", "Khác…"', () => {
    const t = text(box(ask));
    expect(t).toContain('Tách hay gộp?');
    expect(t).toContain('Module billing đang export 14 hàm cũ.');
    expect(t).toMatch(/⌥1 Tách billing-v2 Đề xuất ⌥2 Giữ/);
    expect(t).toContain('Khác…');
    expect(t).not.toContain('Xem thêm');
    expect(box(ask)).toMatch(/role="dialog"/);
  });
  test('§6.7 CP2b permission: full command (mono), Cho phép · Cho phép luôn (canAllowAlways) · Từ chối, reason field, 30 min', () => {
    const h = box(perm), t = text(h);
    expect(t).toMatch(/D2 xin chạy: Bash rm -rf build\/ &amp;&amp; bun run build/);
    expect(t).toMatch(/Cho phép ⌥1 Cho phép luôn trong phiên này ⌥2 Từ chối ⌥3/);
    expect(h).toContain('aria-label="Lý do từ chối"');
    expect(t).toContain('không trả lời trong 30 phút → tự từ chối');
    expect(text(box({ ...perm, canAllowAlways: false }))).not.toContain('Cho phép luôn');
  });
  test('§6.7 CP6 remote MCP box: why line, no Đăng nhập / Để sau, "Đăng nhập trên Mac"', () => {
    const h = box(mcp, { channel: 'remote' });
    expect(text(h)).toContain('chưa đăng nhập · lane báo lỗi cho server này');
    expect(text(h)).toContain('Đăng nhập trên Mac');
    expect(text(h)).not.toMatch(/Để sau|>Đăng nhập</);
    expect(text(box(mcp))).toContain('Đăng nhập Để sau');
  });
  test('§6.7 the box × has a name and the same tooltip as the row icons', () => {
    expect(box(perm)).toMatch(/<button[^>]*class="ia x"[^>]*aria-label="Đóng"[^>]*data-tip="Đóng"/);
  });
  test('§6.7 offline: every button in the box except × is disabled (read only)', () => {
    const h = box(broken, { offline: true });
    const btns = h.match(/<button[^>]*>/g)!;
    expect(btns.filter(b => !b.includes('class="ia x"')).every(b => b.includes('disabled'))).toBe(true);
    for (const c of [ask, perm]) { // the ask options, "Khác…", the permission buttons and the reason field too
      const hc = box(c, { offline: true });
      expect(hc.match(/<(button|input)[^>]*>/g)!.filter(b => !b.includes('class="ia x"')).every(b => b.includes('disabled'))).toBe(true);
    }
  });
  test('§6.7 the box follows the card: answered elsewhere / in undo → closed (boxCardOf null)', () => {
    expect(boxCardOf([ask], { id: 2, status: 'open' }, new Set())?.id).toBe(2);
    expect(boxCardOf([{ ...ask, status: 'answered' }], { id: 2, status: 'open' }, new Set())).toBeNull();
    expect(boxCardOf([ask], { id: 2, status: 'open' }, new Set([2]))).toBeNull();
    expect(boxCardOf([ask], null, new Set())).toBeNull();
  });
});

describe('§6.7 intents: box actions close the box first, deck badge opens it', () => {
  const ctx = () => {
    const log: string[] = [];
    const h = {
      pid: 'p1', lanes: [], send: () => Promise.resolve(null), flash: () => log.push('flash'), drawer: () => {},
      ui: { setAccDlg: (d: { k: string } | null) => log.push(`acc:${d?.k ?? 'null'}`), setCardBox: (b: { id: number } | null) => log.push(`box:${b ? b.id : 'null'}`),
        pick: () => {}, setFocusPick: (id: number) => log.push(`focus:${id}`), setFold: () => {}, setSm: () => {} },
    } as unknown as ShellCtx;
    return { h, log };
  };
  test('§6.7 "Xoá" in the orphan box closes the box, then the orphan_delete confirm opens (no two dialogs)', () => {
    const { h, log } = ctx();
    boxAction(orphan, 'account_orphan_delete', h);
    expect(log).toEqual(['box:null', 'acc:orphan_delete']);
  });
  test('§6.7 "Gộp" on the shared_cfg row opens the A9 dry-run dialog', () => {
    const { h, log } = ctx();
    boxAction(cfg, 'shared_cfg_merge', h);
    expect(log).toEqual(['box:null', 'acc:merge']);
  });
  test('§6.7 a deck card badge selects the card and opens its box', () => {
    const { h, log } = ctx();
    deckIntent({ t: 'card', cardId: 2, lane: 'D2' }, h);
    expect(log).toEqual(['focus:2', 'box:2', 'flash']);
  });
});

describe('§6.7 states', () => {
  const inbox = (cards: CardView[], undo = new UndoQueue(() => {})) => html(<Inbox cards={cards} focusId={1} channel="mac" offline={false} undo={undo}
    guard={new ClickGuard()} newIds={new Set()} onOpen={() => {}} onAction={() => {}} folded={false} resolvedOpen={false} onToggle={() => {}} onResolved={() => {}} />);
  test('§6.7 one row per card, the selected one marked; "Không cần anh làm gì" above resolved rows', () => {
    const h = inbox([perm, ask, { ...broken, status: 'answered', resolvedAt: 9 }]);
    expect(h.match(/<article class="card/g)!.length).toBe(3);
    expect(h).toMatch(/<article class="card focus[^"]*" data-id="1"/);
    expect(text(h)).toContain('Không cần anh làm gì');
  });
  test('§6.7 send refused by the engine → the undo item is gone, the row is back to its buttons', () => {
    const k: (() => void)[] = [];
    const undo = new UndoQueue(() => { /* App's send: the toast comes from its catch */ }, { now: () => 0, setTimeout: f => { k.push(f); return 1; }, clearTimeout: () => {} });
    undo.choose(1, 'Cho phép', { behavior: 'allow' });
    expect(inbox([perm], undo)).toContain('Hoàn tác');
    k[0]!();
    expect(inbox([perm], undo)).not.toContain('Hoàn tác');
    expect(inbox([perm], undo)).toContain('aria-label="Cho phép"');
  });
  test('§6.7 no snapshot yet → the boot screen (no Chờ PO rows at all)', () => {
    expect(bootScreen(null)).toBe(true);
  });
});
