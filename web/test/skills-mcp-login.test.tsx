// v2.2 §5.3 / §6 K3 MCP login dialog (K3-find, K3, K3-done, K3e-*), K13 Chờ PO card (C24 remote, C26 badge), ⌘K
// "Đăng nhập MCP…": the pure stage logic and the static render in vi / en.
import { describe, expect, test } from 'bun:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { makeT } from '../../shared/i18n/index.ts'; // both catalogs + the lazy namespaces
import type { CardView, McpLoginError, McpOAuthView, McpRowView } from '../../shared/protocol.ts';
import { countsOn } from '../src/lib/cards.ts';
import { fmtClock } from '../src/lib/format.ts';
import { LangProvider, type Lang } from '../src/lib/i18n.tsx';
import { k3Live, k3Stage, redirectUri, type K3Stage } from '../src/lib/skills-mcp-login.ts';
import { firstLoginId } from '../src/lib/skills-mcp.ts';
import { CardRow } from '../src/ui/Card.tsx';
import { CardDetail } from '../src/ui/CardDetail.tsx';
import { LoginBody } from '../src/ui/SkillsMcpLogin.tsx';
import { card } from './fixtures.ts';

const base: McpOAuthView = { loggedIn: false, expiresAt: null, refreshedAt: null, needsLogin: { reason: 'no_token', scope: null }, keychainFailed: false, login: null, error: null };
const row = (over: Partial<McpRowView> = {}): McpRowView => ({
  id: 'plugin:vercel@x:vercel', name: 'plugin_vercel_vercel', source: 'plugin', kind: 'http', projectId: null, plugin: 'vercel@x', config: { type: 'http', url: 'https://mcp.vercel.com' },
  forLanes: true, pending: false, unused: null, editable: false, status: 'needs_login', tools: null, error: null, lastInit: null,
  canCheck: true, checking: false, probe: null, log: [], oauth: base, ...over,
});
const html = (el: ReactElement, lang: Lang = 'vi') => renderToStaticMarkup(<LangProvider lang={lang}>{el}</LangProvider>);
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const NOW = 1_000_000;
const body = (stage: K3Stage, r: McpRowView = row(), lang: Lang = 'vi', sourcePath: string | null = null) =>
  html(<LoginBody row={r} stage={stage} now={NOW} redirect="http://127.0.0.1:47800/oauth/mcp/callback" sourcePath={sourcePath} act={() => {}} />, lang);
const buttons = (h: string) => [...h.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map(m => text(m[1]!).trim()).filter(Boolean);

describe('§5.3 K3 stage from the engine OAuth view', () => {
  test('§5.3 discovering → find; waiting → wait (url, until); error → K3e; logged in → done; nothing → idle', () => {
    expect(k3Stage({ ...base, login: { phase: 'discovering', url: null, until: null } })).toEqual({ s: 'find' });
    expect(k3Stage({ ...base, login: { phase: 'waiting', url: 'https://as/authorize?x', until: 5 } })).toEqual({ s: 'wait', url: 'https://as/authorize?x', until: 5 });
    expect(k3Stage({ ...base, error: 'denied' })).toEqual({ s: 'error', err: 'denied' });
    expect(k3Stage({ ...base, loggedIn: true, needsLogin: null })).toEqual({ s: 'done' });
    expect(k3Stage({ ...base, needsLogin: null })).toEqual({ s: 'idle' });
    expect(k3Stage(undefined)).toEqual({ s: 'idle' });
  });
  test('§5.3 a login in flight wins over the last error (the next login clears it)', () => {
    expect(k3Stage({ ...base, error: 'timeout', login: { phase: 'discovering', url: null, until: null } })).toEqual({ s: 'find' });
  });
  test('§6 K3 before the ack → find; until a view pushed after the ack → the ack\'s state, never the stale snapshot', () => {
    const stale = { ...base, loggedIn: true, needsLogin: null }; // a "Đăng nhập lại": the snapshot still says logged in
    const acked = { ...base, login: { phase: 'discovering' as const, url: null, until: null } };
    const v0 = { n: 0 }, v1 = { n: 1 };
    expect(k3Live(null, v0, stale)).toEqual({ s: 'find' });
    expect(k3Live({ ref: v0, o: acked }, v0, stale)).toEqual({ s: 'find' });
    expect(k3Live({ ref: v0, o: { ...base, error: null, loggedIn: true } }, v0, { ...base, error: 'denied' })).toEqual({ s: 'done' });
    expect(k3Live({ ref: v0, o: acked }, v1, { ...base, error: 'network' })).toEqual({ s: 'error', err: 'network' });
    expect(k3Live({ ref: v0, o: acked }, v1, stale)).toEqual({ s: 'done' });
    expect(k3Live({ ref: v0, o: undefined }, v0, stale)).toEqual({ s: 'find' });
  });
  test('§5.3 the redirect: the Mac origin callback, or the entry\'s pre-registered oauth.callbackPort (C10)', () => {
    expect(redirectUri(row(), 'http://127.0.0.1:47800')).toBe('http://127.0.0.1:47800/oauth/mcp/callback');
    expect(redirectUri(row({ config: { type: 'http', url: 'https://x', oauth: { callbackPort: 33418 } } }), 'http://127.0.0.1:47800')).toBe('http://localhost:33418/callback');
  });
  test('§6 K3 countdown "9:42", never negative', () => {
    expect(fmtClock(582_000)).toBe('9:42');
    expect(fmtClock(600_000)).toBe('10:00');
    expect(fmtClock(-5)).toBe('0:00');
  });
});

describe('§6 K3 dialog', () => {
  test('§6 K3-find: title + one-login line, three steps, only "Huỷ"', () => {
    const h = body({ s: 'find' });
    expect(text(h)).toMatch(/Đăng nhập vercel .*Một lần cho mọi account\. Token nằm trong Keychain của cc-slaves, lane không bao giờ thấy nó\./);
    expect(text(h)).toMatch(/Đang tìm máy chủ đăng nhập… .*Đăng ký cc-slaves với máy chủ .*Chờ bạn đồng ý trên trình duyệt/);
    expect(buttons(h)).toEqual(['Huỷ']);
  });
  test('§6 K3 waiting: steps done, countdown, Huỷ · Sao chép link · Mở lại trình duyệt', () => {
    const h = body({ s: 'wait', url: 'https://as/authorize', until: NOW + 582_000 });
    expect(text(h)).toMatch(/Đã tìm thấy máy chủ đăng nhập .*Đã đăng ký cc-slaves với máy chủ .*Đang chờ trình duyệt — đã mở trang đăng nhập/);
    expect(text(h)).toContain('còn 9:42');
    expect(buttons(h)).toEqual(['Huỷ', 'Sao chép link', 'Mở lại trình duyệt']);
  });
  const ALL: McpLoginError[] = ['no_metadata', 'no_s256', 'client_registration', 'denied', 'issuer_mismatch', 'timeout', 'network'];
  test('§6 K3e every named error: one cause line + one fix line', () => {
    const cause: Record<McpLoginError, string> = {
      no_metadata: 'Không tìm thấy thông tin đăng nhập của máy chủ', no_s256: 'Máy chủ không hỗ trợ PKCE S256 — dừng để an toàn',
      client_registration: 'Máy chủ không cho đăng ký tự động — nhập Client ID', denied: 'Bạn đã từ chối trên trình duyệt',
      issuer_mismatch: 'Máy chủ trả issuer khác — dừng để an toàn', timeout: 'Hết giờ (10 phút)', network: 'Lỗi mạng — kiểm tra kết nối / VPN',
    };
    for (const e of ALL) {
      const t = text(body({ s: 'error', err: e }));
      expect(t).toContain(cause[e]);
      expect(t).toMatch(new RegExp(`${cause[e].replace(/[()/]/g, '.')} \\S`)); // the fix line follows
    }
  });
  test('§6 K3e-iss / K3e-net detail lines (expected / received issuer, host: error) between cause and fix; the stage carries them', () => {
    const iss = { kind: 'issuer', expected: 'https://vercel.com', received: 'https://auth.example.net' } as const;
    expect(k3Stage({ ...base, needsLogin: null, error: 'issuer_mismatch', errorDetail: iss })).toEqual({ s: 'error', err: 'issuer_mismatch', detail: iss });
    expect(text(body({ s: 'error', err: 'issuer_mismatch', detail: iss })))
      .toMatch(/Máy chủ trả issuer khác — dừng để an toàn Mong đợi https:\/\/vercel\.com, nhận https:\/\/auth\.example\.net\. Issuer không khớp/);
    expect(text(body({ s: 'error', err: 'issuer_mismatch', detail: { ...iss, received: null } }))).toContain('Mong đợi https://vercel.com, máy chủ không gửi issuer.');
    expect(text(body({ s: 'error', err: 'network', detail: { kind: 'network', host: 'mcp.vercel.com', text: 'ETIMEDOUT' } })))
      .toMatch(/Lỗi mạng — kiểm tra kết nối \/ VPN mcp\.vercel\.com: ETIMEDOUT\. Không tới được/);
    expect(text(body({ s: 'error', err: 'network', detail: { kind: 'network', host: 'mcp.vercel.com', text: 'ETIMEDOUT' } }, row(), 'en'))).toContain('mcp.vercel.com: ETIMEDOUT.');
  });
  test('§5.3 retry cannot help (iss / S256 / metadata) → primary "Đóng", no "Thử lại"; the rest → "Thử lại"', () => {
    for (const e of ['issuer_mismatch', 'no_s256', 'no_metadata'] as const) {
      const b = buttons(body({ s: 'error', err: e }));
      expect(b).not.toContain('Thử lại');
      expect(body({ s: 'error', err: e })).toMatch(/class="btn pri"[^>]*>Đóng/);
    }
    for (const e of ['denied', 'timeout', 'network', 'client_registration'] as const) expect(body({ s: 'error', err: e })).toMatch(/class="btn pri"[^>]*>.*Thử lại/);
  });
  test('§5.3 the fix follows the source: plugin / local / project → "Mở file nguồn" + tell the provider; user → "Sửa…"', () => {
    const plugin = body({ s: 'error', err: 'issuer_mismatch' });
    expect(buttons(plugin)).not.toContain('Sửa…');
    expect(buttons(plugin)).not.toContain('Mở file nguồn'); // the plugin's file is unknown to the web: the text says it
    expect(text(plugin)).toContain('Server thuộc plugin vercel: mở file nguồn để xem URL, báo nhà cung cấp nếu URL đúng.');
    const local = body({ s: 'error', err: 'no_s256' }, row({ id: 'local:p1:vercel', name: 'vercel', source: 'local', plugin: null, projectId: 'p1' }), 'vi', '/Users/me/.claude.json');
    expect(buttons(local)).toContain('Mở file nguồn');
    expect(text(local)).toContain('Server thuộc local');
    const user = body({ s: 'error', err: 'issuer_mismatch' }, row({ id: 'user:vercel', name: 'vercel', source: 'user', plugin: null, editable: true }));
    expect(buttons(user)).toContain('Sửa…');
    expect(buttons(user)).not.toContain('Mở file nguồn');
    expect(text(user)).not.toContain('nhà cung cấp');
    for (const e of ['denied', 'timeout', 'network'] as const) { // a retry helps: no source fix (K3e-net)
      const b = buttons(body({ s: 'error', err: e }, row({ editable: true }), 'vi', '/x/.claude.json'));
      expect(b).not.toContain('Sửa…');
      expect(b).not.toContain('Mở file nguồn');
    }
  });
  test('§6 K3e-client: Client ID + optional secret, the redirect to register, stored in cc-slaves Keychain only (C18)', () => {
    const h = body({ s: 'error', err: 'client_registration' });
    const t = text(h);
    expect(t).toMatch(/Đã tìm thấy máy chủ đăng nhập .*Đăng ký tự động bị từ chối/);
    expect(t).toMatch(/Client ID .*Client secret .*tuỳ chọn/);
    expect(h).toContain('value="http://127.0.0.1:47800/oauth/mcp/callback"');
    expect(t).toContain('Lưu trong Keychain của cc-slaves');
    expect(t).toContain('không ghi vào ~/.claude.json');
    expect(h).toMatch(/type="password"/);
    expect(h).toMatch(/class="btn pri"[^>]*disabled=""[^>]*>.*Thử lại/); // no Client ID typed yet
  });
  test('§6 K15 K3 in English, every error has its text', () => {
    expect(text(body({ s: 'wait', url: 'u', until: NOW + 60_000 }, row(), 'en'))).toMatch(/Log in vercel .*left 1:00/);
    for (const e of ALL) expect(text(body({ s: 'error', err: e }, row(), 'en'))).not.toMatch(/mcpLogin\./);
  });
});

describe('§6 K13 card in Chờ PO', () => {
  const k13 = (over: Partial<CardView> = {}) => card(5, {
    kind: 'mcp_login', projectId: null, key: 'plugin:vercel@x:vercel', titleKey: 'cards.mcpRelogin', params: { name: 'vercel', lanes: 'D2, B3', scope: '' },
    title: 'MCP vercel cần đăng nhập lại · D2, B3 đang thiếu công cụ này', projectIds: ['p1'], createdAt: new Date(2026, 10, 16, 14, 11).getTime(),
    actions: [{ id: 'mcp_login', label: 'Đăng nhập', labelKey: 'cardText.act.login' }, { id: 'mcp_snooze', label: 'Để sau', labelKey: 'cardText.act.later' }], ...over,
  });
  // v2.4 §6.7 D52: the row (title + ⇥ / 🔒) and the detail box (why line, buttons; remote C24: none, "Đăng nhập trên Mac")
  const row = (c: CardView, channel: 'mac' | 'remote') => html(<CardRow c={c} tr={makeT('vi')} focused={false} isNew={false} channel={channel} offline={false} sessions={1}
    undo={null} onChoose={() => {}} onUndo={() => {}} onAction={() => {}} onOpen={() => {}} />);
  const render = (c: CardView, channel: 'mac' | 'remote', lang: Lang = 'vi') => html(<CardDetail c={c} channel={channel} offline={false} sessions={1}
    onChoose={() => {}} onAction={() => {}} onClose={() => {}} />, lang);
  test('§6 K13 / §6.7 row: red glyph, the title, one "Đăng nhập" icon button (🔒 "Chỉ làm trên Mac" remotely)', () => {
    const h = row(k13(), 'mac');
    expect(h).toMatch(/<article class="card bad"/);
    expect(text(h)).toContain('MCP vercel cần đăng nhập lại · D2, B3 đang thiếu công cụ này');
    expect([...h.matchAll(/aria-label="([^"]+)"/g)].map(m => m[1])).toEqual(['Đăng nhập']);
    expect(row(k13(), 'remote')).toMatch(/<button[^>]*class="ia lock"[^>]*data-tip="Chỉ làm trên Mac" disabled=""/);
  });
  test('§6 K13 Mac box: source "MCP vercel", title, why line with the time, "Đăng nhập" (primary) + "Để sau"', () => {
    const h = render(k13(), 'mac');
    expect(h).toMatch(/class="src">MCP vercel</);
    expect(text(h)).toMatch(/MCP vercel cần đăng nhập lại · D2, B3 đang thiếu công cụ này .*làm mới token bị từ chối \(invalid_grant\) lúc 14:11/);
    expect(buttons(h)).toEqual(['Đăng nhập', 'Để sau']);
    expect(h).toMatch(/class="btn sm pri"[^>]*>Đăng nhập/);
  });
  test('§6 K13 never logged in → "chưa đăng nhập" why line; step-up → the scope line', () => {
    expect(text(render(k13({ titleKey: 'cards.mcpLogin' }), 'mac'))).toContain('chưa đăng nhập · lane báo lỗi cho server này');
    expect(text(render(k13({ titleKey: 'cards.mcpReloginScope', params: { name: 'vercel', lanes: 'D2', scope: 'files:write' } }), 'mac'))).toContain('máy chủ trả 403 insufficient_scope lúc 14:11');
  });
  test('§6 K13-remote / C24 / §6.7 CP6: no button in the box (not even "Để sau"), only "Đăng nhập trên Mac"', () => {
    const h = render(k13(), 'remote');
    expect(buttons(h)).toEqual([]);
    expect(text(h)).toContain('Đăng nhập trên Mac — kênh từ xa chỉ xem; cài đặt Skills & MCP làm trong app trên Mac.');
    expect(text(render(k13(), 'mac'))).not.toContain('Đăng nhập trên Mac');
  });
  test('§6 K15 K13 card in English', () => {
    expect(text(render(k13(), 'remote', 'en'))).toMatch(/MCP vercel .*Log in on the Mac/);
  });
  test('C26 a K13 card counts on the tabs of its projects only; other system cards on every tab', () => {
    expect(countsOn(k13(), 'p1')).toBe(true);
    expect(countsOn(k13(), 'p2')).toBe(false);
    expect(countsOn(k13({ projectIds: [] }), 'p1')).toBe(false);
    expect(countsOn(card(6, { kind: 'logged_out', projectId: null }), 'p2')).toBe(true);
    expect(countsOn(card(7, { projectId: 'p2' }), 'p2')).toBe(true);
    expect(countsOn(card(7, { projectId: 'p2' }), 'p1')).toBe(false);
  });
});

describe('§6 ⌘K "Đăng nhập MCP…"', () => {
  test('§6 the first server that needs a login (needs_login / needs_relogin), else none', () => {
    const rows = [row({ id: 'user:a', status: 'connected', oauth: { ...base, loggedIn: true, needsLogin: null } }), row({ id: 'user:b', status: 'needs_relogin' }), row({ id: 'user:c' })];
    expect(firstLoginId(rows)).toBe('user:b');
    expect(firstLoginId([rows[0]!])).toBeUndefined();
    expect(firstLoginId([row({ id: 'user:s', kind: 'stdio', oauth: undefined, status: 'needs_login' })])).toBeUndefined();
  });
});
