// v2.2 §6 Skills tab (K8, K8-plugin, K11, K11-ack), K9 / K10 dialogs, Thư mục chung (K12) and the Account table after the
// §7 move, rendered statically in vi and en.
import { describe, expect, test } from 'bun:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '../../shared/i18n/index.ts';
import { loadLazyNs } from '../../shared/i18n/lazy.ts';
import type { AccountsInfo, SkillIssueView, SkillRowView, SkillsMcpView } from '../../shared/protocol.ts';
import { LangProvider, type Lang } from '../src/lib/i18n.tsx';
import { AccountsTab } from '../src/ui/Accounts.tsx';
import { SharedTab } from '../src/ui/SkillsMcpShared.tsx';
import { SkillsTab } from '../src/ui/SkillsMcpSkills.tsx';
import { SkillAddDialog, SkillRemoveDialog } from '../src/ui/SkillsMcpSkillsDialogs.tsx';
import { account, card, snapshot } from './fixtures.ts';

loadLazyNs();
const html = (el: ReactElement, lang: Lang = 'vi') => renderToStaticMarkup(<LangProvider lang={lang}>{el}</LangProvider>);
const sk = (name: string, over: Partial<SkillRowView> = {}): SkillRowView => ({
  id: `user:${name}`, scope: 'user', owner: null, dir: name, path: `/Users/po/.claude/skills/${name}`, name, description: `about ${name}`, shadowed: false, link: null, forLanes: true, ...over,
});
const iss = (code: SkillIssueView['code'], dir: string, over: Partial<SkillIssueView> = {}): SkillIssueView => ({
  id: `${code}:${dir}`, code, level: 'warn', ackable: true, acked: false, path: `/Users/po/.claude/skills/${dir}`, dir, project: null, ...over,
});
const view = (skills: Partial<SkillsMcpView['skills']> = {}): SkillsMcpView => ({
  mcp: { rows: [], servers: 0, forLanes: 0, tools: 0 },
  skills: {
    rows: [sk('h-ops', { link: '/Users/po/Works/h-ops-skill' }), sk('learned-x'), sk('find-skills', { link: '/Users/po/.cc-switch/skills/find-skills' }),
      sk('banner', { id: 'plugin:ui@m:banner', scope: 'plugin', owner: 'ui@m' })],
    issues: [iss('appLink', 'find-skills', { level: 'error', ackable: false, app: 'cc-switch' }), iss('brokenLink', 'gone', { level: 'error', ackable: false }),
      iss('missingSkillMd', 'learned'), iss('duplicate', 'tauri', { level: 'info', project: 'p1' }), iss('missingSkillMd', 'synced', { acked: true })],
    plugins: [{ key: 'ui@m', skills: 1, servers: 0, forLanes: true }], descTokens: 9100, ...skills,
  },
  counts: { mcp: { red: 0, yellow: 0 }, skills: { red: 0, yellow: 3 }, shared: { red: 0, yellow: 0 }, total: { red: 0, yellow: 3 } },
  claudeJson: { ok: true, line: null, rev: 'r1', path: '/Users/po/.claude.json' }, claude: { found: true, install: '' }, lost: [],
});
const projects = [{ id: 'p1', name: 'hagenta', path: '/w/hagenta' }] as never;
const tab = (v: SkillsMcpView, lang: Lang = 'vi') => html(<SkillsTab view={v} projects={projects} act={() => {}} connected />, lang);

describe('§6 K8 Skills tab', () => {
  test('§6 K8 summary, filter, "+ Thêm skill", groups; flagged user rows only in Cần xem', () => {
    const h = tab(view());
    expect(h).toContain('4 skill · 3 của bạn · 1 từ 1 plugin · ~9,1k token mô tả mỗi lane');
    expect(h).toContain('placeholder="Lọc skill…"');
    expect(h).toContain('Thêm skill');
    expect(h).toMatch(/Cần xem <span>3<\/span><em>· 1 thông tin<\/em>/); // 3 counted + 1 info (C25: info not counted)
    expect(h).toMatch(/Của bạn <span>2<\/span>/); // h-ops, learned-x (find-skills sits in Cần xem)
    expect(h).toContain('link → ~/Works/h-ops-skill');
    expect(h).toContain('hagenta: không có .claude/skills');
  });
  test('§6 K8-plugin one folded row with its own Lane switch; its skills are hidden until unfolded', () => {
    const h = tab(view());
    expect(h).toContain('aria-label="Dùng plugin ui cho lane"');
    expect(h).toContain('plugin · m');
    expect(h).toContain('aria-expanded="false"');
    expect(h).not.toContain('Tắt cả plugin để tắt skill này');
    expect(h).not.toContain('aria-label="Dùng skill banner cho lane"');
  });
  test('§6 K11 issue rows: copy / unlink + relink / trash + open + Đã biết; lane-breaking ones have no Đã biết', () => {
    const h = tab(view());
    const row = (code: string) => { const at = h.indexOf(`data-code="${code}"`); return h.slice(at, h.indexOf('data-code=', at + 10) >>> 0); };
    expect(row('appLink')).toContain('find-skills trỏ vào ~/.cc-switch/skills/find-skills (CC Switch) — gỡ CC Switch là mất');
    expect(row('appLink')).toContain('Chép vào ~/.claude'); expect(row('appLink')).not.toContain('Đã biết');
    expect(row('brokenLink')).toContain('Gỡ link'); expect(row('brokenLink')).toContain('Trỏ lại…'); expect(row('brokenLink')).not.toContain('Đã biết');
    expect(row('missingSkillMd')).toContain('Vào Thùng rác'); expect(row('missingSkillMd')).toContain('Mở thư mục'); expect(row('missingSkillMd')).toContain('Đã biết');
    expect(row('duplicate')).toContain('tauri trùng tên với project hagenta');
  });
  test('§6 K11-ack the folded "Đã biết · n" group, out of the review count', () => {
    const h = tab(view());
    expect(h).toContain('Đã biết · 1');
    expect(h).toContain('không tính vào số trên thanh trên');
    expect(h).not.toContain('Bỏ đã biết'); // folded
  });
  test('§6 K1-load skeleton while the view builds; K15 English', () => {
    expect(html(<SkillsTab view={undefined} projects={[]} act={() => {}} connected />)).toContain('aria-busy="true"');
    const en = tab(view(), 'en');
    expect(en).toContain('4 skills · 3 yours · 1 from 1 plugins · ~9.1k description tokens per lane');
    expect(en).toContain('Copy into ~/.claude');
  });
});

describe('§6 K9 / K10', () => {
  const v = view();
  test('§6 K9 opens on Git (URL field, fetch hint); "Thêm 0 skill" disabled until a fetch', () => {
    const h = html(<SkillAddDialog view={v} send={() => Promise.resolve(null)} onClose={() => {}} />);
    expect(h).toContain('aria-label="Thêm skill"');
    expect(h).toMatch(/role="tab" aria-selected="true"[^>]*>.*Git/);
    expect(h).toContain('Tải ngay khi dán / Enter (git clone --depth 1)');
    expect(h).toMatch(/<button class="btn pri" disabled="">Thêm 0 skill<\/button>/);
  });
  test('§6 K10 link: unlink, the target stays; real folder: Trash', () => {
    const link = html(<SkillRemoveDialog row={v.skills.rows[0]!} send={() => Promise.resolve(null)} onClose={() => {}} />);
    expect(link).toContain('Gỡ link h-ops. Thư mục gốc ~/Works/h-ops-skill giữ nguyên.');
    expect(link).toContain('Lane đang chạy dùng tới lần chạy sau.');
    expect(link).toContain('>Gỡ link</button>');
    const dir = html(<SkillRemoveDialog row={v.skills.rows[1]!} send={() => Promise.resolve(null)} onClose={() => {}} />);
    expect(dir).toContain('Chuyển learned-x vào Thùng rác.');
    expect(dir).toContain('>Vào Thùng rác</button>');
  });
});

describe('§6 K12 Thư mục chung + §7 Account', () => {
  const info: AccountsInfo = {
    privateWindow: false,
    entries: [{ name: '.claude.json', cls: 'never', shared: false }, { name: 'hooks', cls: 'unknown', shared: false }, { name: 'plans', cls: 'shared', shared: true }, { name: 'projects', cls: 'shared', shared: true }],
  };
  const bad = account('acc51@x.test', { sharedCfg: { ok: false, issues: [{ kind: 'real-entry', name: 'plans', path: '/a/plans' }] } });
  const snap = snapshot({ accounts: [account('ok@x.test'), bad], cards: [card(7, { kind: 'shared_cfg_new', status: 'open', title: 'Mục mới `hooks` trong ~/.claude', actions: [{ id: 'shared_cfg_share', label: 'Dùng chung' }] })] });
  const k12 = (lang: Lang = 'vi') => html(<SharedTab snap={snap} info={info} connected send={() => Promise.resolve(null)} toast={() => {}} onMerge={() => {}} />, lang);
  test('§6 K12 the v2 §5.2 columns + the switch of an unknown entry + the new-entry question', () => {
    const h = k12();
    expect(h).toContain('Dùng chung <span>2</span>'); expect(h).toContain('Chép <span>3</span>'); expect(h).toContain('Riêng <span>1</span>'); expect(h).toContain('Lạ <span>1</span>');
    expect(h).toContain('projects<span class="foot"> (lịch sử, memory)</span>');
    expect(h).toContain('.claude.json<span class="foot"> (đăng nhập)</span>');
    expect(h).toContain('aria-label="Dùng chung hooks"');
    expect(h).toContain('Mục mới');
    expect(h).not.toContain('MCP'); // §7 the two MCP lines of v2 are gone
  });
  test('§6 K12 account × link state: bad first with "Gộp vào ~/.claude" (v2 A9), ok rows "n / n link"', () => {
    const h = k12();
    expect(h.indexOf('acc51@')).toBeLessThan(h.indexOf('ok@'));
    expect(h).toContain('1 / 2 link');
    expect(h).toContain('plans: thư mục thật ở chỗ phải là link · không nhận lane mới');
    expect(h).toContain('Gộp vào ~/.claude');
    expect(h).toContain('2 / 2 link');
    expect(k12('en')).toContain('Merge into ~/.claude');
  });
  test('§7 Account: no "Cấu hình chung" button or list; the ⚠ chip is a button that opens K12 and says why (F-I6, §4.2 no lone mark)', () => {
    const h = html(<AccountsTab snap={snap} onDlg={() => {}} editor={null} onMenu={() => {}} onCfg={() => {}} />);
    expect(h).not.toContain('Cấu hình chung ✓');
    expect(h).not.toContain('Dùng chung');
    expect(h).toMatch(/<button class="pill warn"[^>]*aria-label="Cấu hình chung lỗi: [^"]*"[^>]*>⚠ cấu hình chung lỗi<\/button>/);
    const wizard = html(<AccountsTab snap={snap} onDlg={() => {}} editor={null} onMenu={() => {}} />);
    expect(wizard).toMatch(/<span class="pill warn"[^>]*>⚠ cấu hình chung lỗi<\/span>/);
  });
});
