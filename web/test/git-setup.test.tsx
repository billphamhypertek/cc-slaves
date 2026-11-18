// hotfix 2026-11-16 (b) the optional Git block (brief hf1116-git G4–G6, docs/ref/hf1116-ux.md "every state"): static render
// per state in vi / en, the fold when all three rows are ✓, the install poll window, the prefill, "Tiếp" never gated by git.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { makeT } from '../../shared/i18n/index.ts';
import { LAZY_NS } from '../../shared/i18n/lazy.ts';
import viSettings from '../../shared/i18n/vi/settings.json';
import type { Command, GitSetup as Git, SetupStatus } from '../../shared/protocol.ts';
import { GitView, type GitHost } from '../src/git/GitView.tsx';
import { gitBlocked } from '../src/git/model.ts';
import { gitAllOk, gitRow, identityPrefill, INSTALL_MAX_MS, polling, readyLine } from '../src/lib/git-setup.ts';
import { gitRecheck, INSTANT_TABS, settingsTabs } from '../src/lib/settings.ts';
import { canAdvance } from '../src/lib/wizard.ts';
import { LangProvider, type Lang } from '../src/lib/i18n.tsx';
import GitSetup from '../src/ui/GitSetup.tsx';
import { Settings } from '../src/ui/Settings.tsx';
import { snapshot } from './fixtures.ts';

const ID = { name: 'Bill Pham', email: 'bill@x-dev.test' };
const NO_ID = { name: null, email: null };
const git = (over: Partial<Git> = {}): Git => ({ state: 'ok', version: '2.54.0', detail: null, identity: ID, gh: 'ok', ghUser: 'octo', ghLogin: null, ...over });
const setup = (g: Git, over: Partial<SetupStatus> = {}): SetupStatus => ({
  claude: { found: true, path: '/c', version: '2.1.330', ok: true }, accounts: [{ email: 'acc@x-dev.test', loggedIn: true }], poEmail: null, done: true, git: g, ...over,
});
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const render = (g: Git, o: { mac?: boolean; lang?: Lang; installAt?: number | null; now?: number; s?: Partial<SetupStatus> } = {}) =>
  renderToStaticMarkup(<LangProvider lang={o.lang ?? 'vi'}><GitSetup setup={setup(g, o.s)} send={async () => undefined} mac={o.mac ?? true} installAt={o.installAt ?? null} now={o.now ?? 1_000} /></LangProvider>);
const buttons = (h: string) => [...h.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map(m => text(m[1]!)).filter(Boolean);

describe('hf1116 (b) G4 the Git block, every state', () => {
  test('all ✓ → one line "Git sẵn sàng · version · name · GitHub user" + Chi tiết; no rows', () => {
    const h = render(git());
    expect(text(h)).toContain('Git sẵn sàng · 2.54.0 · Bill Pham · GitHub octo');
    expect(buttons(h)).toEqual(['Chi tiết']);
    expect(h).not.toContain('Danh tính commit');
    expect(text(h)).not.toContain('Cài đặt › Git'); // "thiết lập sau ở Cài đặt › Git" only in the wizard (`later`)
    expect(text(render(git(), { lang: 'en' }))).toContain('Git ready · 2.54.0 · Bill Pham · GitHub octo');
  });
  test('git ok, no identity, gh logged out → three rows: ✓ Git, identity form prefilled, Đăng nhập GitHub', () => {
    const h = render(git({ identity: NO_ID, gh: 'logged_out', ghUser: null }), { s: { poEmail: 'po@x-dev.test' } });
    expect(text(h)).toContain('Git 2.54.0');
    expect(text(h)).toContain('Danh tính commit');
    expect(h).toContain('value="po@x-dev.test"'); // prefilled: no git email → the PO email
    expect(buttons(h)).toEqual(['Lưu', 'Đăng nhập GitHub']);
    expect(h).toMatch(/<button type="submit" class="btn pri" disabled="">/); // empty name: Lưu blocked (error prevention)
  });
  test('missing → "Cài Command Line Tools"; installing (poll window) → "Đang cài…"; after 30 min → missing again', () => {
    const g = git({ state: 'missing', version: null, identity: NO_ID, gh: 'missing', ghUser: null });
    expect(buttons(render(g))).toEqual(['Cài Command Line Tools']);
    expect(text(render(g))).toContain('Cần có git trước.');
    expect(text(render(g, { installAt: 0, now: 5_000 }))).toContain('Đang cài Command Line Tools…');
    expect(text(render(g, { installAt: 0, now: INSTALL_MAX_MS + 1 }))).toContain('Chưa có git');
  });
  test('license → the sudo command to copy + one line why; cc-slaves never runs it', () => {
    const h = render(git({ state: 'license', version: null, identity: NO_ID, gh: 'logged_out', ghUser: null }));
    expect(text(h)).toContain('Git bị chặn: chưa đồng ý giấy phép Xcode');
    expect(text(h)).toContain('sudo xcodebuild -license accept');
    expect(buttons(h)).toEqual(['Kiểm tra lại', 'Sao chép', 'Đăng nhập GitHub']);
  });
  test('error → git\'s last line + Kiểm tra lại', () => {
    const h = render(git({ state: 'error', version: null, detail: 'fatal: odd', identity: NO_ID }));
    expect(text(h)).toContain('Không chạy được git');
    expect(text(h)).toContain('fatal: odd');
  });
  test('gh missing → the SSH / Keychain note, no install button', () => {
    const h = render(git({ gh: 'missing', ghUser: null }));
    expect(text(h)).toContain('Chưa có gh — push vẫn dùng SSH / Keychain sẵn có.');
    expect(buttons(h)).toEqual(['Sửa']);
  });
  test('gh login waiting → the one-time code, Sao chép, Mở trang GitHub, Huỷ; starting → spinner + Huỷ; failed → detail + Thử lại', () => {
    const wait = render(git({ gh: 'logged_out', ghUser: null, ghLogin: { state: 'waiting', code: '3E86-1480', url: 'https://github.com/login/device', detail: null } }));
    expect(text(wait)).toContain('3E86-1480');
    expect(buttons(wait)).toEqual(['Sửa', 'Huỷ', 'Sao chép', 'Mở trang GitHub']);
    const start = render(git({ gh: 'logged_out', ghUser: null, ghLogin: { state: 'starting', code: null, url: null, detail: null } }));
    expect(text(start)).toContain('Đang mở gh…');
    const fail = render(git({ gh: 'logged_out', ghUser: null, ghLogin: { state: 'failed', code: null, url: null, detail: 'error: expired' } }));
    expect(text(fail)).toContain('Đăng nhập GitHub chưa xong: error: expired');
    expect(buttons(fail)).toContain('Thử lại');
  });
  test('remote channel → rows read-only (no button, no form) + "Chỉ thiết lập được trên Mac."', () => {
    const h = render(git({ state: 'license', version: null, identity: NO_ID, gh: 'logged_out', ghUser: null }), { mac: false });
    expect(buttons(h)).toEqual([]);
    expect(h).not.toContain('<input');
    expect(text(h)).toContain('Chỉ thiết lập được trên Mac.');
  });
  test('en catalog: every state has its words', () => {
    expect(text(render(git({ state: 'missing', version: null, identity: NO_ID, gh: 'missing', ghUser: null }), { lang: 'en' }))).toContain('Install Command Line Tools');
    expect(text(render(git({ gh: 'missing', ghUser: null }), { lang: 'en' }))).toContain('No gh — push still uses your SSH key / Keychain.');
  });
});

describe('hf1116 (b) G4 model', () => {
  test('gitAllOk needs git ok + name + email + gh ok', () => {
    expect(gitAllOk(git())).toBe(true);
    expect(gitAllOk(git({ gh: 'missing' }))).toBe(false);
    expect(gitAllOk(git({ identity: { name: 'x', email: null } }))).toBe(false);
    expect(gitAllOk(git({ state: 'license' }))).toBe(false);
  });
  test('gitRow / polling: installing only while git is still missing and < 30 min', () => {
    const m = git({ state: 'missing' });
    expect(gitRow(m, null, 10)).toBe('missing');
    expect(gitRow(m, 0, INSTALL_MAX_MS - 1)).toBe('installing');
    expect(polling(m, 0, INSTALL_MAX_MS)).toBe(false);
    expect(polling(git(), 0, 10)).toBe(false); // git ok → the poll stops
    expect(gitRow(git({ state: 'license' }), 0, 10)).toBe('license');
  });
  test('prefill: the git identity, else the PO email, else the first logged-in account', () => {
    const s = (g: Git, po: string | null) => ({ git: g, poEmail: po, accounts: [{ email: 'off@x-dev.test', loggedIn: false }, { email: 'on@x-dev.test', loggedIn: true }] });
    expect(identityPrefill(s(git(), 'po@x-dev.test'))).toEqual({ name: 'Bill Pham', email: 'bill@x-dev.test' });
    expect(identityPrefill(s(git({ identity: NO_ID }), 'po@x-dev.test'))).toEqual({ name: '', email: 'po@x-dev.test' });
    expect(identityPrefill(s(git({ identity: NO_ID }), null))).toEqual({ name: '', email: 'on@x-dev.test' });
  });
  test('G5 the Git tab swaps git\'s raw error for the block only when git is missing / license-blocked', () => {
    expect(gitBlocked(git({ state: 'missing' }))).toBe(true);
    expect(gitBlocked(git({ state: 'license' }))).toBe(true);
    expect(gitBlocked(git({ state: 'error' }))).toBe(false);
    expect(gitBlocked(git())).toBe(false);
    expect(gitBlocked(undefined)).toBe(false);
  });
  test('readyLine without a gh user drops "GitHub …"', () => {
    expect(readyLine(makeT('vi'), git({ ghUser: null }))).toBe('Git sẵn sàng · 2.54.0 · Bill Pham');
  });
  test('"Tiếp" (step 1) is gated by Claude Code only, never by git', () => {
    const bad = git({ state: 'missing', version: null, identity: NO_ID, gh: 'missing', ghUser: null });
    expect(canAdvance(1, setup(bad), [])).toBe(true);
    expect(canAdvance(1, setup(git(), { claude: { found: false, path: null, version: null, ok: false } }), [])).toBe(false);
  });
  test('G5 Cài đặt › Git: a Mac tab after Model, instant (no Save); never on the remote channel', () => {
    expect(settingsTabs('mac', false).map(t => t.id)).toEqual(['proj', 'acc', 'noti', 'model', 'git', 'wf', 'engine']);
    expect(INSTANT_TABS.has('git')).toBe(true);
    expect(settingsTabs('remote', true).map(t => t.id)).toEqual(['remote']);
  });
});

describe('hf1116 (b) G5 wiring (review F2 / F4)', () => {
  const host = (g: Git): GitHost => ({
    projectId: 'p1', projectPath: '/p', send: async () => undefined, open: true, offline: false, dataAt: null, narrow: false, now: 1_000, width: 1440,
    hidden: false, order: [], onCodeChanged: () => () => {}, ask: () => {}, toCode: () => {}, vscode: () => {}, setup: setup(g), mac: true, toast: () => {},
  });
  const view = (g: Git) => renderToStaticMarkup(<LangProvider lang="vi"><GitView shown sel={{ k: 'orch' }} lanes={[]} host={host(g)} /></LangProvider>);
  test('F2 Git tab, git license-blocked → the setup block, never "no git" nor a raw error; git ok → no block', () => {
    const blocked = view(git({ state: 'license', version: null, identity: NO_ID, gh: 'logged_out', ghUser: null }));
    expect(blocked).toContain('class="gsetup-host"');
    expect(text(blocked)).not.toContain('Project này không dùng git');
    expect(view(git({ state: 'missing', version: null })).includes('class="gsetup-host"')).toBe(true);
    expect(view(git())).not.toContain('gsetup-host');
  });
  test('F2 opening Cài đặt › Git re-checks (`setup_check`) on the Mac only; other tabs never', () => {
    const sent = (tab: string, mac: boolean) => { const cs: Command[] = []; gitRecheck(tab, mac, async (c) => { cs.push(c); }); return cs; };
    expect(sent('git', true)).toEqual([{ cmd: 'setup_check' }]);
    expect(sent('git', false)).toEqual([]);
    expect(sent('engine', true)).toEqual([]);
    const src = readFileSync(new URL('../src/ui/Settings.tsx', import.meta.url), 'utf8');
    expect(src).toMatch(/useEffect\(\(\) => gitRecheck\(tab, mac, p\.send\), \[tab\]\);/);
  });
  test('F4 Cài đặt › Git before the first check → "Đang kiểm tra git…" (vi) / "Checking git…" (en), from the first-paint catalog', () => {
    expect('git.checking' in viSettings).toBe(true); // not the lazy gitSetup namespace: Settings shows it before that chunk loads
    expect('checking' in LAZY_NS.vi.gitSetup).toBe(false);
    const props = { snap: snapshot({ setup: null }), tab: 'git', onTab: () => {}, onClose: () => {}, send: async () => undefined, onAddProject: () => {}, onSetup: () => {},
      accInfo: null, onAccDlg: () => {}, toast: () => {} } as unknown as Parameters<typeof Settings>[0];
    const h = (lang: Lang) => text(renderToStaticMarkup(<LangProvider lang={lang}><Settings {...props} /></LangProvider>));
    expect(h('vi')).toContain('Đang kiểm tra git…');
    expect(h('en')).toContain('Checking git…');
  });
});
