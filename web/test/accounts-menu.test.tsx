// v2.1 §4.12 one source per kind: the Settings › Account (and F1 step 2) row "⋯" opens the shared account menu
// (lib/actions.ts accountActions via the App's ActionMenu), never a private menu of its own.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountsTab, ConfirmDialog } from '../src/ui/Accounts.tsx';
import { account, snapshot } from './fixtures.ts';

const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const zOf = (css: string, sel: string) => Number(new RegExp(`(?:^|\\n|\\})${sel.replace(/[.#]/g, m => `\\${m}`)}\\{[^}]*z-index:(\\d+)`).exec(css)![1]);

describe('§4.12 Settings › Account row "⋯" = the shared account menu', () => {
  const snap = snapshot({ accounts: [account('pm@x'), account('a@x', { role: 'orchestrator' })] });
  const html = renderToStaticMarkup(<AccountsTab snap={snap} onDlg={() => {}} editor={null} onMenu={() => {}} />);
  test('§4.12 each row has one "⋯" that opens a menu (aria-haspopup), no inline private menu', () => {
    expect((html.match(/<button[^>]*aria-haspopup="menu"[^>]*>⋯<\/button>/g) ?? []).length).toBe(2);
    expect(html).not.toContain('rmenu');
    expect(src('../src/ui/Accounts.tsx')).not.toMatch(/rmenu|role="menuitem"/);
  });
  test('§4.12 the menu layer stacks over the Settings modal (below the account dialogs it opens)', () => {
    const css = src('../src/styles.css');
    expect(zOf(css, '.amenu-layer')).toBeGreaterThan(zOf(css, '#modal'));
    expect(zOf(css, '.amenu-layer')).toBeGreaterThan(zOf(css, '#screen'));
    expect(zOf(css, '.amenu-layer')).toBeLessThan(zOf(css, '#accmodal'));
  });
});

describe('hf1116 T4 the terminal login is a normal row', () => {
  const snap = snapshot({ accounts: [account('pm@x'), account('term@x', { terminal: true, role: 'orchestrator' })] });
  const html = renderToStaticMarkup(<AccountsTab snap={snap} onDlg={() => {}} editor={null} onMenu={() => {}} />);
  test('hf1116 T4 Settings › Account: the terminal row carries the neutral "Terminal" tag + tooltip; a cc-slaves row does not', () => {
    const term = /<tr[^>]*data-email="term@x"[^>]*>.*?<\/tr>/.exec(html)![0];
    const pm = /<tr[^>]*data-email="pm@x"[^>]*>.*?<\/tr>/.exec(html)![0];
    expect(term).toContain('<span class="pill" title="Đăng nhập Claude Code có sẵn trên máy · dùng chung với terminal / VS Code">Terminal</span>');
    expect(term).toContain('Điều phối'); // role picker / role like any row
    expect(pm).not.toContain('>Terminal<');
    expect(html).not.toContain('không dùng cho lane');
  });
  test('hf1116 T3 "Xoá" on the terminal account says it only leaves cc-slaves (login, ~/.claude, Keychain kept)', () => {
    const del = (email: string) => renderToStaticMarkup(<ConfirmDialog req={{ k: 'delete', email }} snap={snap} send={async () => null} onClose={() => {}} />);
    const t = del('term@x');
    expect(t).toContain('Khỏi danh sách cc-slaves');
    expect(t).toContain('Đăng nhập trong terminal / VS Code');
    expect(t).toContain('Chỉ bỏ account này khỏi cc-slaves. Đăng nhập trong terminal vẫn giữ nguyên.');
    expect(t).not.toContain('Mục keychain');
    expect(del('pm@x')).toContain('Mục keychain');
  });
});
