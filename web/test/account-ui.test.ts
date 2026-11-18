// v2 §6 A1–A9, F16 (spec v2 §4.3 / §4.4 / §6): the Account tab's state → view mapping.
import { describe, expect, test } from 'bun:test';
import type { AccountLoginView } from '../../shared/protocol.ts';
import {
  a3Block, a4Buttons, liveLoginToAdopt, a5Defaults, a5Payload, capsText, cfgHeader, cfgIssues, countdown, deleteBlock, f16Adopt, lanesText, loginChip, loginDialog,
  cancelsLogin, clashLine, loginLock, logoutImpact, logoutMoves, tildePath, parseA9Key,
} from '../src/lib/account-ui.ts';
import { account, lane, snapshot } from './fixtures.ts';
import { makeT } from '../../shared/i18n/index.ts';

const tv = makeT('vi');

const NOW = 1_000_000;
const login = (over: Partial<AccountLoginView> = {}): AccountLoginView => ({
  id: 'l1', mode: 'add', email: 'pm@x', state: 'waiting_browser', url: 'https://claude.ai/oauth/authorize?x', deadline: NOW + 600_000,
  error: null, realEmail: null, ...over,
});

describe('§6 A2 login chip', () => {
  test('§6 A2 ✓ · ⚠ · ✗ đăng xuất · ?; only ⚠ / ✗ open A6', () => {
    expect(loginChip(tv, account('a', { login: 'ok' }))).toEqual({ cls: 'ok', text: '✓', relogin: false, title: 'Đã đăng nhập' });
    expect(loginChip(tv, account('a', { login: 'expiring' }))).toMatchObject({ cls: 'warn', text: '⚠ sắp hết hạn', relogin: true });
    // hf1116 B-I2: the terminal's own login is renewed in the terminal while it still works
    expect(loginChip(tv, account('t', { login: 'expiring', terminal: true }))).toMatchObject({ cls: 'warn', relogin: false });
    expect(loginChip(tv, account('t', { login: 'out', terminal: true }))).toMatchObject({ cls: 'bad', relogin: true });
    expect(loginChip(tv, account('a', { login: 'out' }))).toMatchObject({ cls: 'bad', text: '✗ đăng xuất', relogin: true });
    expect(loginChip(tv, account('a', { login: 'unknown' }))).toMatchObject({ cls: 'warn', text: '?', relogin: false, title: 'Không kiểm được' });
  });
  test('§6 A2 a row flagged logged out (registry) reads ✗ even if login says ok', () => {
    expect(loginChip(tv, account('a', { login: 'ok', loggedOut: true })).cls).toBe('bad');
  });
});

describe('§6 A2 / A9 shared-config chip and header', () => {
  const bad = account('ba@x', { sharedCfg: { ok: false, issues: [{ kind: 'real-entry', name: 'plans', path: '/a/plans' }] } });
  const bad2 = account('pm@x', { sharedCfg: { ok: false, issues: [{ kind: 'missing-link', name: 'skills', path: '/a/skills' }] } });
  test('§6 A2 chip text lists the link issues (v2.2 §5.1: no MCP on an account)', () => {
    expect(cfgIssues(tv, bad)).toEqual(['plans chưa nối về ~/.claude']);
    expect(cfgIssues(tv, account('ok@x'))).toEqual([]);
  });
  test('§6 A2 header button: "Cấu hình chung ✓" or "⚠ n" (n = issues over all accounts)', () => {
    expect(cfgHeader(tv, [account('a'), account('b')])).toEqual({ n: 0, text: 'Cấu hình chung ✓' });
    expect(cfgHeader(tv, [bad, bad2, account('c')])).toEqual({ n: 2, text: 'Cấu hình chung ⚠ 2' });
  });
  test('G4 UX 5(b) a §5.2 new-entry question counts in the ⚠ n (its only place besides Cấu hình chung)', () => {
    expect(cfgHeader(tv, [account('a')], 1)).toEqual({ n: 1, text: 'Cấu hình chung ⚠ 1' });
    expect(cfgHeader(tv, [bad], 2)).toEqual({ n: 3, text: 'Cấu hình chung ⚠ 3' });
  });
  test('§6 A9 card key "<email>/<name>" → merge target', () => {
    expect(parseA9Key('ba@x-vn.test/plans')).toEqual({ email: 'ba@x-vn.test', name: 'plans' });
    expect(parseA9Key('ba@x-vn.test/')).toBeNull();
    expect(parseA9Key(null)).toBeNull();
  });
});

describe('§6 A2 row text', () => {
  test('§6 A2 caps: "99 mềm", "70 cứng · 5h 95"', () => {
    expect(capsText(tv, account('a', { week: 99, hard: false, five: null }))).toBe('99 mềm');
    expect(capsText(tv, account('a', { week: 70, hard: true, five: 95 }))).toBe('70 cứng · 5h 95');
  });
  test('§6 A2 lanes: running / max; orchestrator account counts its orchestrators', () => {
    const s = snapshot();
    expect(lanesText(tv, account('pm@x', { lanes: 2 }), { 'pm@x': 4 }, s.orchestrators)).toBe('2/4');
    expect(lanesText(tv, account('pm@x', { lanes: 1 }), {}, s.orchestrators)).toBe('1/3');
    expect(lanesText(tv, account('a@x', { role: 'orchestrator' }), {}, s.orchestrators)).toBe('1 điều phối');
    expect(lanesText(tv, account('a@x', { role: 'orchestrator' }), { 'a@x': 0 }, s.orchestrators)).toBe('1 điều phối');
  });
  test('D26 orchestrator row with max lanes > 0: "{n} điều phối · {lanes}/{max}" (vi + en)', () => {
    const s = snapshot();
    expect(lanesText(tv, account('a@x', { role: 'orchestrator', lanes: 1 }), { 'a@x': 2 }, s.orchestrators)).toBe('1 điều phối · 1/2');
    expect(lanesText(makeT('en'), account('a@x', { role: 'orchestrator', lanes: 1 }), { 'a@x': 2 }, s.orchestrators)).toBe('1 orch. · 1/2');
  });
});

describe('§6 A8 delete guard (§4.4 phòng lỗi) and A8L impact', () => {
  const s = snapshot({ lanes: [lane('D2', { account: 'pm@x' }), lane('D15', { account: 'pm@x', state: 'idle' }), lane('D9', { account: 'pm@x', state: 'broken' })] });
  test('§6 A8 lanes running → "Đang chạy D2, D15" (broken / stopped do not count)', () => {
    expect(deleteBlock(tv, account('pm@x'), s)).toBe('Đang chạy D2, D15');
  });
  test('§6 A8 orchestrator role, project home or live orchestrator → "Đang là Điều phối"', () => {
    expect(deleteBlock(tv, account('a@x', { role: 'orchestrator' }), s)).toBe('Đang là Điều phối');
    expect(deleteBlock(tv, account('z@x'), { ...s, projects: [{ ...s.projects[0]!, orchestratorAccount: 'z@x' }] })).toBe('Đang là Điều phối');
    expect(deleteBlock(tv, account('y@x'), { ...s, orchestrators: [{ ...s.orchestrators[0]!, account: 'y@x' }] })).toBe('Đang là Điều phối');
  });
  test('§6 A8 a live re-login of that account locks Xoá and Đăng xuất (engine remove.ts login_running)', () => {
    const live = login({ mode: 'relogin', email: 'free@x', state: 'waiting_browser' });
    expect(deleteBlock(tv, account('free@x'), { ...s, login: live })).toBe('Đang đăng nhập free@x');
    expect(loginLock(tv, account('free@x'), live)).toBe('Đang đăng nhập free@x');
    expect(loginLock(tv, account('other@x'), live)).toBeNull();
    expect(loginLock(tv, account('free@x'), { ...live, state: 'cancelled' })).toBeNull();
    expect(loginLock(tv, account('free@x'), { ...live, mode: 'add' })).toBeNull(); // an add runs in a new dir
  });
  test('§6 A8 free account → deletable', () => {
    expect(deleteBlock(tv, account('free@x'), s)).toBeNull();
  });
  test('§6 A8L lanes that move (no broken), and the orchestrator handover line only for the orchestrator account', () => {
    expect(logoutImpact(tv, account('pm@x'), s)).toEqual(['D2, D15 sẽ chuyển sang account khác.']);
    const o = logoutImpact(tv, account('a@x', { role: 'orchestrator' }), { ...s, accounts: [account('a@x', { role: 'orchestrator' }), account('pm@x'), account('bk@x', { role: 'backup' })] });
    expect(o).toEqual(['Điều phối sẽ chuyển sang pm@.']);
    expect(logoutImpact(tv, account('free@x'), s)).toEqual(['Không có lane nào phải chuyển.']);
    // G4 UX M4: only a real move gets the ⚠ box
    expect(logoutMoves(account('free@x'), s)).toBe(false);
    expect(logoutMoves(account('pm@x'), s)).toBe(true);
    expect(logoutMoves(account('a@x', { role: 'orchestrator' }), s)).toBe(true);
  });
});

describe('§6 F16 the relogin dialog adopts the login the card started (G4 IMPORTANT-1)', () => {
  const old = login({ id: 'row1', mode: 'relogin', email: 'o@x', state: 'cancelled', deadline: NOW });
  test('§6 F16 a new relogin with the same row id as the cancelled one is adopted', () => {
    expect(f16Adopt(old, { ...old, state: 'waiting_browser', deadline: NOW + 600_000 }, 'o@x')).toBe('row1');
    expect(f16Adopt(old, { ...old, state: 'starting', deadline: NOW + 600_000 }, 'o@x')).toBe('row1');
  });
  test('§6 F16 the old finished login (same data, re-sent snapshot) is not adopted', () => {
    expect(f16Adopt(old, { ...old }, 'o@x')).toBeNull();
  });
  test('§6 F16 a new login that already finished is adopted (fast done / failed)', () => {
    expect(f16Adopt(old, { ...old, state: 'done', deadline: NOW + 600_000 }, 'o@x')).toBe('row1');
    expect(f16Adopt(null, { ...old, state: 'failed' }, 'o@x')).toBe('row1');
  });
  test('§6 F16 another account\'s login is never adopted', () => {
    expect(f16Adopt(null, login({ mode: 'add', email: 'x@x' }), 'o@x')).toBeNull();
    expect(f16Adopt(old, null, 'o@x')).toBeNull();
  });
  test('§6 F16 Huỷ before adoption still cancels a live login of the requested account (never leaks 10 min)', () => {
    const live = login({ id: 'row1', mode: 'relogin', email: 'o@x', state: 'waiting_browser' });
    expect(cancelsLogin(null, { k: 'relogin', email: 'o@x' }, live)).toBe(true);
    expect(cancelsLogin(null, { k: 'relogin', email: 'o@x' }, { ...live, email: 'z@x' })).toBe(false); // someone else's
    expect(cancelsLogin(null, { k: 'add' }, live)).toBe(false);
    expect(cancelsLogin(null, { k: 'relogin', email: 'o@x' }, { ...live, state: 'cancelled' })).toBe(false);
    expect(cancelsLogin(live, { k: 'add' }, null)).toBe(true); // the adopted one
    expect(cancelsLogin({ ...live, state: 'email_mismatch' }, { k: 'add' }, null)).toBe(false); // A7f has its own buttons
  });
  test('§6 F16 a login of this account already live when the dialog opened is adopted', () => {
    const live = { ...old, state: 'waiting_browser' as const };
    expect(f16Adopt(live, live, 'o@x')).toBe('row1');
  });
});

describe('G4 UX I2 §6 A9C clash copies', () => {
  test('§6 A9C "<owner> dd/mm HH:MM · chung dd/mm HH:MM" (mockup), unknown mtime → "?"', () => {
    const t1 = new Date(2026, 10, 14, 17, 40).getTime(), t2 = new Date(2026, 10, 12, 9, 2).getTime();
    const c = { file: 'a.md', account: { dir: '/a', path: '/a/a.md', mtime: t1 }, shared: { dir: '/s', path: '/s/a.md', mtime: t2 } };
    expect(clashLine(tv, c, 'ba@x.test')).toBe('ba@ 14/11 17:40 · chung 12/11 09:02');
    expect(clashLine(tv, { ...c, shared: { ...c.shared, mtime: null } }, 'ba@x.test')).toBe('ba@ 14/11 17:40 · chung ?');
  });
  test('§6 A9C folders read with ~ for the home dir', () => {
    expect(tildePath('/Users/me/.claude/plans')).toBe('~/.claude/plans');
    expect(tildePath('/tmp/x')).toBe('/tmp/x');
  });
});

describe('§6 A3 single flight', () => {
  test('smoke 2026-11-15: a dialog opened while a login is live follows it (add: any; relogin: same account only)', () => {
    const live = login({ state: 'waiting_browser', email: 'pm@x', id: 'L1' });
    expect(liveLoginToAdopt({ k: 'add' }, live)).toBe('L1');
    expect(liveLoginToAdopt({ k: 'relogin', email: 'pm@x' }, live)).toBe('L1');
    expect(liveLoginToAdopt({ k: 'relogin', email: 'ba@x' }, live)).toBeNull();
    expect(liveLoginToAdopt({ k: 'add' }, null)).toBeNull();
    // review M-2: an add dialog never follows another account's relogin (its Huỷ would cancel a login it did not start)
    expect(liveLoginToAdopt({ k: 'add' }, { ...live, mode: 'relogin' })).toBeNull();
    for (const st of ['done', 'failed', 'cancelled', 'timed_out'] as const) expect(liveLoginToAdopt({ k: 'add' }, login({ state: st }))).toBeNull();
  });
  test('§6 A3 another login running → "Đăng nhập" disabled with "Đang đăng nhập <email>"', () => {
    expect(a3Block(tv, null)).toBeNull();
    expect(a3Block(tv, login({ state: 'waiting_browser', email: 'pm@x' }))).toBe('Đang đăng nhập pm@x');
    expect(a3Block(tv, login({ state: 'starting', email: null }))).toBe('Đang đăng nhập một account khác');
    expect(a3Block(tv, login({ state: 'email_mismatch' }))).not.toBeNull();
    for (const st of ['done', 'failed', 'cancelled', 'timed_out'] as const) expect(a3Block(tv, login({ state: st }))).toBeNull();
  });
});

describe('§6 A4 buttons (§3.2 SA6, §4.3 budget: the default button is the 1-click "nút mở")', () => {
  test('§6 A4 private window supported → it is primary; else "Sao chép link" primary; browser + copy always there', () => {
    expect(a4Buttons(tv, true)).toEqual([{ id: 'private', label: 'Mở cửa sổ riêng tư', pri: true }, { id: 'browser', label: 'Mở trình duyệt', pri: false }, { id: 'copy', label: 'Sao chép link', pri: false }]);
    expect(a4Buttons(tv, false)).toEqual([{ id: 'copy', label: 'Sao chép link', pri: true }, { id: 'browser', label: 'Mở trình duyệt', pri: false }]);
  });
  test('§6 A4 10:00 countdown, never negative', () => {
    expect(countdown(NOW + 600_000, NOW)).toBe('10:00');
    expect(countdown(NOW + 552_400, NOW)).toBe('09:13');
    expect(countdown(NOW - 5, NOW)).toBe('00:00');
    expect(countdown(NOW + 600_900, NOW)).toBe('10:00'); // engine / browser clock skew never shows 10:01
  });
});

describe('§6 A3–A7 login → dialog frame', () => {
  test('§6 A4 / A6 while waiting; A6 title names the account', () => {
    expect(loginDialog(tv, login())).toMatchObject({ frame: 'A4', title: 'Đang chờ đăng nhập', lead: 'Đăng nhập pm@x trong trình duyệt.' });
    expect(loginDialog(tv, login({ mode: 'relogin', email: 'ba@x' }))).toMatchObject({ frame: 'A6', title: 'Đăng nhập lại ba@x', lead: 'Đăng nhập đúng ba@x.' });
    expect(loginDialog(tv, login({ state: 'starting', email: null }))).toMatchObject({ frame: 'A4', lead: 'Đăng nhập trong trình duyệt.' });
  });
  test('§6 A5 after an add; a relogin closes itself', () => {
    expect(loginDialog(tv, login({ state: 'done', realEmail: 'pm@x' })).frame).toBe('A5');
    expect(loginDialog(tv, login({ mode: 'relogin', state: 'done', realEmail: 'ba@x' })).frame).toBe('close');
  });
  test('v2 §6 F1 step 2 skips A5: an add that is done closes and returns to the list (roles come at step 3)', () => {
    expect(loginDialog(tv, login({ state: 'done', realEmail: 'pm@x' }), { noA5: true }).frame).toBe('close');
    expect(loginDialog(tv, login({ state: 'waiting_browser' }), { noA5: true }).frame).toBe('A4');
    expect(loginDialog(tv, login({ state: 'failed', error: { reason: 'exit', detail: 'x' } }), { noA5: true }).frame).toBe('A7');
    expect(loginDialog(tv, login({ state: 'cancelled' })).frame).toBe('close');
  });
  test('§6 A7a timed out — relogin says the account stays signed out', () => {
    expect(loginDialog(tv, login({ state: 'timed_out' }))).toMatchObject({ frame: 'A7', title: 'Hết giờ', text: 'Chưa đăng nhập sau 10 phút.', primary: { id: 'retry', label: 'Thử lại' } });
    expect(loginDialog(tv, login({ mode: 'relogin', email: 'ba@x', state: 'timed_out' })).text).toBe('Chưa đăng nhập sau 10 phút. ba@ vẫn đăng xuất.');
  });
  test('§6 A7c exit ≠ 0 → last line + "Kiểm tra mạng / proxy."', () => {
    const v = loginDialog(tv, login({ state: 'failed', error: { reason: 'exit', detail: 'OAuth error: token exchange failed (403)' } }));
    expect(v).toMatchObject({ frame: 'A7', title: 'Đăng nhập lỗi', detail: 'OAuth error: token exchange failed (403)', text: 'Kiểm tra mạng / proxy.', primary: { id: 'retry' } });
  });
  test('§6 A7d wrong email on relogin', () => {
    const v = loginDialog(tv, login({ mode: 'relogin', email: 'ba@x', state: 'failed', realEmail: 'pm@x', error: { reason: 'wrong_email', detail: 'pm@x' } }));
    expect(v).toMatchObject({ frame: 'A7', title: 'Sai account', text: 'Đã đăng nhập pm@, cần ba@. Đã huỷ lần này.', primary: { id: 'retry', label: 'Thử lại' } });
  });
  test('hf1116 B-I2 wrong email on a terminal re-login: the terminal is now signed in as it; no "Thử lại"', () => {
    const v = loginDialog(tv, login({ mode: 'relogin', email: 'ba@x', state: 'failed', realEmail: 'pm@x', error: { reason: 'wrong_email', detail: 'pm@x' } }), { terminal: true });
    expect(v).toMatchObject({ frame: 'A7', title: 'Sai account', tone: 'bad', primary: null, secondary: { id: 'close' },
      text: 'Terminal giờ đăng nhập pm@, không còn là ba@. Muốn đổi lại thì dùng `/login` trong terminal.' });
  });
  test('§6 A7e duplicate on add → "pm@ đã có." + "Đăng nhập lại pm@"', () => {
    const v = loginDialog(tv, login({ state: 'failed', realEmail: 'pm@x', error: { reason: 'duplicate', detail: 'pm@x' } }));
    expect(v).toMatchObject({ frame: 'A7', title: 'Account đã có', text: 'pm@ đã có.', primary: { id: 'relogin', label: 'Đăng nhập lại pm@', email: 'pm@x' } });
  });
  test('§6 A7f typed email ≠ real → "Giữ x@" primary / "Huỷ đăng nhập x@" (G4 UX M10)', () => {
    const v = loginDialog(tv, login({ state: 'email_mismatch', email: 'pm@x', realEmail: 'ba@x' }));
    expect(v).toMatchObject({ frame: 'A7', title: 'Khác email đã nhập', text: 'Đã đăng nhập ba@, không phải pm@.', primary: { id: 'keep', label: 'Giữ ba@' }, secondary: { id: 'drop', label: 'Huỷ đăng nhập ba@' } });
  });
  test('v2 g23 no_account error has a Vietnamese text (account gone mid-login)', () => {
    const v = loginDialog(tv, login({ mode: 'relogin', email: 'ba@x', state: 'failed', error: { reason: 'no_account', detail: null } }));
    expect(v).toMatchObject({ frame: 'A7', title: 'Đăng nhập lỗi', text: 'Không còn account ba@ trong danh sách.' });
    expect(v.primary).toBeNull();
  });
});

describe('§6 A5 defaults (§4.4 mặc định hợp lý) and the save payload', () => {
  test('§4.4 new account: Chính · 99 % mềm · 3 lane, not restored', () => {
    expect(a5Defaults('new@x', { caps: { default: { week: 98 } } }, [])).toEqual({ role: 'primary', week: 99, five: '', hard: false, maxLanes: 3, restored: false });
  });
  test('§4.4 an email with a caps row gets its old role / caps back, "· thiết lập cũ"', () => {
    const d = a5Defaults('old@x', { caps: { 'old@x': { role: 'backup', week: 70, hard: true, five: 95 } }, laneCaps: { 'old@x': 2 } }, []);
    expect(d).toEqual({ role: 'backup', week: 70, five: '95', hard: true, maxLanes: 2, restored: true });
  });
  test('§6 A5 Lưu keeps every other caps row as is and merges laneCaps', () => {
    const cfg = { caps: { default: { week: 98 }, 'o@x': { role: 'orchestrator', week: 99 } }, laneCaps: { 'o@x': 0 } };
    const p = a5Payload('n@x', { role: 'primary', week: 90, five: '', hard: true, maxLanes: 2 }, cfg);
    expect(p.caps).toEqual({ 'o@x': { role: 'orchestrator', week: 99 }, 'n@x': { role: 'primary', week: 90, hard: true } });
    expect(p.laneCaps).toEqual({ 'o@x': 0, 'n@x': 2 });
  });
  test('§6 A5 picking Điều phối demotes the old orchestrator to Chính (exactly one)', () => {
    const cfg = { caps: { 'o@x': { role: 'orchestrator', week: 99 } } };
    const p = a5Payload('n@x', { role: 'orchestrator', week: 99, five: '', hard: false, maxLanes: 3 }, cfg);
    expect(p.caps['o@x']!.role).toBe('primary');
    expect(p.laneCaps['n@x']).toBe(3);
    expect(p.laneCaps['o@x']).toBe(3); // D26: the demoted orchestrator had 0 → a Chính with the default 3, not 0
  });
  test('D26 A5 Lưu keeps the orchestrator max lanes the PO typed (0 stays 0)', () => {
    const cfg = { caps: { 'o@x': { role: 'primary', week: 99 } }, laneCaps: { 'o@x': 4 } };
    expect(a5Payload('n@x', { role: 'orchestrator', week: 99, five: '', hard: false, maxLanes: 2 }, cfg).laneCaps).toEqual({ 'o@x': 4, 'n@x': 2 });
    expect(a5Payload('n@x', { role: 'orchestrator', week: 99, five: '', hard: false, maxLanes: 0 }, cfg).laneCaps['n@x']).toBe(0);
  });
  test('D26 A5 defaults: an orchestrator row without a stored max lanes starts at 0', () => {
    expect(a5Defaults('o@x', { caps: { 'o@x': { role: 'orchestrator', week: 99 } } }, []).maxLanes).toBe(0);
    expect(a5Defaults('o@x', { caps: { 'o@x': { role: 'orchestrator', week: 99 } }, laneCaps: { 'o@x': 2 } }, []).maxLanes).toBe(2);
  });
});

describe('§6A account helpers in English', () => {
  const te = makeT('en');
  test('§6A chip, header, A7 timeout of a relogin, A8L impact render from the en catalog', () => {
    expect(loginChip(te, account('a', { login: 'out' }))).toMatchObject({ text: '✗ signed out', title: 'Sign in again' });
    expect(cfgHeader(te, [account('a')], 2).text).toBe('Shared config ⚠ 2');
    expect(loginDialog(te, login({ mode: 'relogin', state: 'timed_out', email: 'pm@x-vn.test' }))).toMatchObject({
      title: 'Timed out', text: 'No sign-in after 10 minutes. pm@ is still signed out.', primary: { label: 'Retry' }, secondary: { label: 'Close' },
    });
    expect(logoutImpact(te, account('zz@x'), snapshot())).toEqual(['No lane has to move.']);
  });
});
