// spec v2.3 §5.1 / §5.2 / §7 the Code components as rendered: tree rows (C1, C2, C24, C13), source chip (C1, C12),
// ⌘P rows (C5), viewer head and every read state (C12 empty, C14 error, C9 image, C10 large, C20 encoding, C21 binary, C3 md).
import { describe, expect, test } from 'bun:test';
import { createRef, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '../../../shared/i18n/index.ts';
import type { FsReadResult, LaneView } from '../../../shared/protocol.ts';
import { markHit, splitPath } from '../../src/code/QuickOpen.tsx';
import { FILTER_FROM, SrcChip, srcLanes } from '../../src/code/SrcChip.tsx';
import { nameRoom, Tree } from '../../src/code/Tree.tsx';
import type { DirState, TreeModel } from '../../src/code/tree-model.ts';
import type { Dlg, OpenFile } from '../../src/code/code-tabs.ts';
import { CodeDialog } from '../../src/code/CodeDialog.tsx';
import { edgeFade, TabBar } from '../../src/code/TabBar.tsx';
import { tocShown } from '../../src/code/DocView.tsx';
import { Viewer, type ViewerProps } from '../../src/code/Viewer.tsx';
import { OffBand, ViewerFoot } from '../../src/code/ViewerBits.tsx';
import { LangProvider } from '../../src/lib/i18n.tsx';
import { textWidth } from '../../src/lib/mid-ellipsis.ts';
import { monoFont } from '../../src/lib/mono-font.ts';

const html = (el: ReactElement, lang: 'vi' | 'en' = 'vi') => renderToStaticMarkup(<LangProvider lang={lang}>{el}</LangProvider>);
const nop = () => {};

describe('§5.1 Tree', () => {
  const ok = (names: [string, 'f' | 'd', boolean?][], more = 0): DirState =>
    ({ k: 'ok', list: { entries: names.map(([name, k, ign]) => ({ name, type: k === 'd' ? 'dir' : 'file', size: 1, ignored: !!ign })), more } });
  const tree = (dirs: Record<string, DirState>, open: string[] = [], selected: string | null = null) => html(
    <Tree model={{ dirs: new Map(Object.entries(dirs)), open: new Set(open) } satisfies TreeModel} selected={selected} width={280}
      onToggle={nop} onOpen={nop} onPin={nop} onRetry={nop} onFind={nop} />);
  test('§7 C13 root still loading → the 8+ line skeleton, no rows', () => {
    const h = tree({ '': { k: 'loading' } });
    expect(h).toContain('class="cskel"');
    expect(h).not.toContain('role="tree"');
  });
  test('§5.1 rows: treeitem buttons, full path on hover, the open file highlighted, open dirs expanded', () => {
    const h = tree({ '': ok([['engine', 'd'], ['README.md', 'f']]), engine: ok([['auth.ts', 'f']]) }, ['engine'], 'engine/auth.ts');
    expect(h).toContain('role="tree"');
    expect(h).toMatch(/aria-expanded="true"[^>]*class="tr"[^>]*title="engine"/);
    expect(h).toMatch(/aria-selected="true" class="tr sel"[^>]*title="engine\/auth.ts"/);
    expect(h).toContain('padding-left:calc(var(--s4) + 1 * var(--s5))'); // one level = --s5 (v2.4 §6.7 D53)
  });
  test('§5.1 a long name is cut in the middle to the column, its full path in title', () => {
    const name = '2026-11-02-billing-usage-alerts-and-quota-rollover-design.md';
    const h = tree({ '': ok([[name, 'f']]) });
    expect(h).toContain(`title="${name}"`);
    const shown = /class="fnm">([^<]+)</.exec(h)![1]!;
    expect(shown).toContain('…');
    expect(shown.endsWith('design.md')).toBe(true);
    expect(textWidth(shown, monoFont('xs'))).toBeLessThanOrEqual(nameRoom(280, 0));
  });
  test('§6.7 D53 rows indent by tokens (--s4 + depth × --s5), no px in the style', () => {
    const h = tree({ '': ok([['src', 'd']]), src: ok([['a.ts', 'f']]) }, ['src']);
    expect(h).toContain('padding-left:calc(var(--s4) + 0 * var(--s5))');
    expect(h).toContain('padding-left:calc(var(--s4) + 1 * var(--s5))');
    expect(h).not.toMatch(/(padding|margin)-left:[0-9]/);
  });
  test('§6.7 D53 the root skeleton indents in --s5 steps', () => {
    const h = tree({ '': { k: 'loading' } });
    expect(h).toContain('margin-left:calc(2 * var(--s5))');
    expect(h).not.toMatch(/margin-left:[0-9]/);
  });
  test('§6.7 D53 nameRoom = width − border 1 − (--s4 + depth × --s5) − chevron + icon 26 − gap --s2 − right pad --s4', () => {
    expect(nameRoom(280, 0)).toBe(280 - 1 - 10 - 26 - 4 - 10); // hot fix 2026-11-16 --s4 10, --s5 14
    expect(nameRoom(280, 2)).toBe(nameRoom(280, 0) - 2 * 14);
  });
  test('§5.1 / C24 ignored entries carry the dim class', () => {
    expect(tree({ '': ok([['.env', 'f', true], ['a.ts', 'f']]) })).toMatch(/class="tr ign"[^>]*title="\.env"/);
  });
  test('§5.1 over 2 000 entries → "Còn n mục · dùng ⌘P"; a failed dir → "Thử lại"', () => {
    expect(tree({ '': ok([['a', 'f']], 1234) })).toContain('Còn 1234 mục · dùng ⌘P');
    expect(tree({ '': ok([['x', 'd']]), x: { k: 'error' } }, ['x'])).toContain('Không đọc được thư mục · Thử lại');
  });
});

describe('§5.1 source chip', () => {
  const lane = (name: string, o: Partial<LaneView> = {}) => ({ name, state: 'running', cwd: `/w/p-${name}`, worktreeExists: true, branch: null, ...o }) as Pick<LaneView, 'name' | 'state' | 'cwd' | 'worktreeExists' | 'branch'>;
  test('§5.1 project folder in accent; a lane worktree in its state colour; no branch on the chip', () => {
    expect(html(<SrcChip lane={null} lanes={[]} onPick={nop} />)).toMatch(/class="csrc acc"[^>]*>.*thư mục project/);
    const h = html(<SrcChip lane="D15" lanes={[lane('D15', { state: 'waiting_po' })]} onPick={nop} />);
    expect(h).toMatch(/class="csrc warn"[^>]*>.*D15 · worktree/);
    expect(h).not.toContain('lane/');
  });
  test('§5.1 the list = lanes with a worktree of their own (not a gone worktree, not a lane running in the repo)', () => {
    const none = { name: null, base: null, state: 'none' as const, ahead: 0, files: 0, add: 0, del: 0, measuredAt: 0 };
    const ls = [lane('D15'), lane('D7', { worktreeExists: false }), lane('D9', { branch: none })];
    expect(srcLanes(ls).map(l => l.name)).toEqual(['D15']);
    expect(FILTER_FROM).toBe(8);
  });
});

describe('§5.1 ⌘P rows', () => {
  test('§5.1 name / dir split; the typed part bright', () => {
    expect(splitPath('docs/specs/a.md')).toEqual(['a.md', 'docs/specs']);
    expect(splitPath('README.md')).toEqual(['README.md', '']);
    expect(renderToStaticMarkup(<>{markHit('2026-11-16-auth-design.md', 'AUTH')}</>)).toBe('2026-11-16-<b>auth</b>-design.md');
    expect(markHit('a.ts', 'zz')).toBe('a.ts');
  });
});

const file = (path: string, res: Partial<FsReadResult> | null, o: Partial<OpenFile> = {}): OpenFile =>
  ({ path, res: res ? { kind: 'text', size: 2150, hash: 'h', text: 'x', ...res } : null, err: res ? null : new Error('EACCES · không có quyền đọc'), loading: false,
    md: 'read', stale: null, edit: null, savedAt: null, restored: null, ran: null, saveErr: null, v: 1, ...o });
const ed = { onEdit: nop, onCancel: nop, onSave: nop, onChange: nop, onAsk: nop };
const free = { reason: null, lane: null };
const view = (f: OpenFile | null, o: Partial<ViewerProps> = {}, lang: 'vi' | 'en' = 'vi') => html(<Viewer file={f} docKey="k" keep={new Set()} lock={free} saveOff={null} offline={false} ed={ed}
  onRetry={nop} onMd={nop} onVscode={nop} resolveLink={() => Promise.resolve({ ok: false })} loadImage={() => Promise.resolve(null)} openInCode={nop} body={createRef()} narrow={false} {...o} />, lang);

describe('§5.2 viewer', () => {
  test('§7 C12 no file → "Chọn một file trong cây hoặc ⌘P", no head; loading → the thin bar', () => {
    const h = view(null);
    expect(h).toContain('Chọn một file trong cây hoặc ⌘P');
    expect(h).not.toContain('class="cvh"');
    expect(view(file('a.ts', null, { loading: true, err: null }))).toContain('class="cbar"');
    expect(view(null, {}, 'en')).toContain('Pick a file in the tree or press ⌘P');
  });
  test('§7 C17 the md outline: ≥ 3 headings and a pane ≥ 720 px, hidden in a window < 1280 px', () => {
    expect(tocShown(3, 784, false)).toBe(true);
    expect(tocShown(3, 784, true)).toBe(false);
    expect(tocShown(2, 1200, false)).toBe(false);
  });
  test('§7 C13 a file still loading: the bar + a skeleton body, never the read error ("Không đọc được … null")', () => {
    const h = view(file('engine/src/auth.ts', null, { loading: true, err: null }));
    expect(h).toContain('class="cbar"');
    expect(h).toContain('class="cskel"');
    expect(h).not.toContain('Không đọc được');
  });
  test('§5.2 text: head = path, "Sửa" on with the ⌘S hint, VS Code; no footer, no md switch', () => {
    const h = view(file('engine/src/auth.ts', {}));
    expect(h).toMatch(/class="pth" title="engine\/src\/auth.ts"/);
    expect(h).toMatch(/class="hb" title="Sửa chỗ nhỏ, lưu bằng ⌘S"/);
    expect(h).not.toContain('class="vf');
    expect(h).toContain('VS Code');
    expect(h).not.toContain('seg2');
    expect(h).not.toContain('cfoot');
  });
  test('§5.2 .md: "Đọc" | "Nguồn" with "Đọc" pressed by default', () => {
    const h = view(file('docs/a.md', { text: '# A' }));
    expect(h).toMatch(/class="on" aria-pressed="true">Đọc/);
    expect(h).toMatch(/aria-pressed="false">Nguồn/);
    expect(h).toContain('class="mdw"');
    expect(view(file('docs/a.md', { text: '# A' }, { md: 'src' }))).not.toContain('class="mdw"');
  });
  test('§7 C14 failed read: "Không đọc được <path>" + reason + "Thử lại", no Sửa / VS Code', () => {
    const h = view(file('engine/src/auth.ts', null));
    expect(h).toContain('Không đọc được engine/src/auth.ts');
    expect(h).toContain('EACCES · không có quyền đọc');
    expect(h).toContain('Thử lại');
    expect(h).not.toContain('class="hb');
  });
  test('§7 C20 not UTF-8: meta + CRLF, "Sửa" reason', () => {
    const h = view(file('fixtures/menu.csv', { readOnly: 'not_utf8', eol: 'crlf' }));
    expect(h).toContain('Không phải UTF-8 · CRLF');
    expect(h).toContain('title="Không phải UTF-8 — sửa trong VS Code"');
    expect(view(file('a.txt', { readOnly: 'mixed_eol' }))).toContain('title="Xuống dòng lẫn LF / CRLF — sửa trong VS Code"');
  });
  test('§5.2 / C10 large: yellow band with the size, "Sửa" off, VS Code kept in the head', () => {
    const h = view(file('bun.lock', { kind: 'large', size: 3.4 * 1024 * 1024 }));
    expect(h).toContain('Tệp lớn (3,4 MB) · chỉ hiện 2 MB đầu, không tô màu');
    expect(h).toContain('title="Tệp lớn — sửa trong VS Code"');
    expect(h.match(/class="hb" title="Mở trong VS Code"/g)?.length).toBe(1); // one VS Code button, in the head
  });
  test('§5.2 / C21 binary: centre note with the size + one VS Code button there, head has only the dim "Sửa"', () => {
    const h = view(file('logo.icns', { kind: 'binary', size: 186_000 }));
    expect(h).toContain('Tệp nhị phân · 182 KB');
    expect(h).toContain('class="hb dis"');
    expect(h).not.toMatch(/class="hb" title/);
    expect(h).toContain('Mở trong VS Code');
  });
  test('§5.2 / C9 image: checkerboard + <img> of the engine data URL (svg too, never inline), no "Sửa"', () => {
    const h = view(file('logo.svg', { kind: 'image', dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+', size: 2150 }));
    expect(h).toContain('class="cimg"><img class="vec" src="data:image/svg+xml;base64,PHN2Zy8+"');
    expect(view(file('logo.png', { kind: 'image', dataUrl: 'data:image/png;base64,AA', size: 9 }))).toContain('class="cimg"><img src="data:image/png;base64,AA"');
    expect(h).not.toContain('<svg/>');
    expect(h).not.toContain('class="hb dis"');
    expect(h).toContain('2,1 KB');
  });
  test('§7 C15 changed on disk while scrolled → "File vừa đổi trên đĩa · Tải lại" band', () => {
    expect(view(file('a.ts', {}, { stale: { by: null, at: 0 } }))).toMatch(/File vừa đổi trên đĩa.*Tải lại/);
    expect(view(file('a.ts', {}))).not.toContain('File vừa đổi');
  });
  test('§10.2 C15 from `code_changed` of a lane source: the lane and the time on the band', () => {
    const at = new Date(2026, 10, 16, 14, 24).getTime();
    expect(view(file('a.ts', {}, { stale: { by: 'D15', at } }))).toContain('File vừa đổi (D15 sửa lúc 14:24)');
  });
});

describe('§5.3 edit in the viewer', () => {
  const edit = { text: 'x2', baseHash: 'h', eol: 'lf' as const, bom: false, dirty: true, line: 1, free: true };
  const lockD15 = { reason: 'D15 còn phiên sống trong thư mục này (Chờ PO) — nhắn D15 sửa, hoặc đợi lane xong / dừng', lane: 'D15' };
  test('§5.3 C6 editing: "Đang sửa" chip, "Huỷ" · "Lưu ⌘S", yellow footer "Đang sửa · chưa lưu · Esc để thoát", no md switch', () => {
    const h = view(file('docs/a.md', { text: '# A' }, { edit, md: 'src' }));
    expect(h).toContain('class="edp"');
    expect(h).toMatch(/>Huỷ<\/button><button type="button" class="btn sm pri"[^>]*>Lưu <kbd>⌘S<\/kbd>/);
    expect(h).toContain('class="vf wv"');
    expect(h).toContain('Đang sửa · chưa lưu · Esc để thoát');
    expect(h).not.toContain('seg2');
    expect(h).not.toContain('VS Code'); // C6: the head's right side is "Huỷ" · "Lưu" only
  });
  test('§5.3 C1 / C8 a live session in the dir: "Sửa" greyed with the lane, its state and what to do', () => {
    const h = view(file('a.ts', {}), { lock: lockD15 });
    expect(h).toContain(`class="hb dis" aria-disabled="true" title="${lockD15.reason}"`);
    expect(h).not.toContain('class="vf'); // the footer line only after a click (C8)
  });
  test('§5.3 the file-side reason wins over the session one (binary / not UTF-8 are not the lane\'s)', () => {
    expect(view(file('a.csv', { readOnly: 'not_utf8' }), { lock: lockD15 })).toContain('title="Không phải UTF-8 — sửa trong VS Code"');
  });
  test('§5.3 a session started while editing → "D7 vừa chạy trong thư mục này — lưu có thể đè việc của lane"; Lưu stays on', () => {
    const h = view(file('a.ts', {}, { edit }), { lock: { reason: 'x', lane: 'D7' } });
    expect(h).toContain('D7 vừa chạy trong thư mục này — lưu có thể đè việc của lane');
    expect(h).not.toContain('aria-disabled');
    expect(view(file('a.ts', {}, { edit, ran: { who: null } }))).toContain('Điều phối vừa chạy trong thư mục project — lưu có thể đè việc của Điều phối');
  });
  test('§5.4 C29 restored buffer: band "Thay đổi chưa lưu từ lần trước · 14:22"; locked source → "Lưu" greyed with the reason', () => {
    const at = new Date(2026, 10, 16, 14, 22).getTime();
    const h = view(file('a.ts', {}, { edit: { ...edit, free: false }, restored: at }), { saveOff: lockD15.reason, lock: lockD15 });
    expect(h).toContain('Thay đổi chưa lưu từ lần trước · 14:22');
    expect(h).toContain(`class="btn sm pri" aria-disabled="true" title="${lockD15.reason}"`);
    expect(h).toMatch(/class="vf wv"><svg[^]*?<span>D15 còn phiên sống/);
  });
  test('§5.3 C19 "Đã lưu 14:22" after a save; a refused save shows its reason in red', () => {
    const at = new Date(2026, 10, 16, 14, 22).getTime();
    expect(view(file('a.ts', {}, { savedAt: at }))).toContain('Đã lưu 14:22');
    expect(view(file('a.ts', {}, { edit, saveErr: new Error('Điều phối đang chạy') }))).toMatch(/class="vf bv".*Chưa lưu được · Điều phối đang chạy/);
  });
});

describe('§7 C16 Mất kết nối', () => {
  const edit = { text: 'x2', baseHash: 'h', eol: 'lf' as const, bom: false, dirty: true, line: 1, free: true };
  test('§7 C16 offline, not editing: the file stays readable; "Sửa" locked with the reason, a click shows no "Nhắn …"', () => {
    const h = view(file('a.ts', { text: 'const a = 1' }), { offline: true, lock: { reason: 'x', lane: 'D15' } });
    expect(h).toContain('class="pth" title="a.ts"');
    expect(h).toContain('class="hb dis" aria-disabled="true" title="Mất kết nối · sửa được khi nối lại"');
    expect(h).not.toContain('class="cemp"');
    expect(view(file('a.ts', {}), { offline: false })).toMatch(/class="hb" title="Sửa chỗ nhỏ/);
  });
  test('§7 C16 offline while editing: "Lưu" locked + red footer "Mất kết nối · chưa lưu được"; "Huỷ" stays; back online → "Lưu" opens', () => {
    const h = view(file('a.ts', {}, { edit, saveErr: new Error('offline') }), { offline: true });
    expect(h).toMatch(/>Huỷ<\/button><button type="button" class="btn sm pri" aria-disabled="true" title="Mất kết nối · chưa lưu được · thay đổi vẫn giữ ở đây"/);
    expect(h).toMatch(/class="vf bv"><svg[^]*?<span>Mất kết nối · chưa lưu được · thay đổi vẫn giữ ở đây<\/span>/);
    expect(h).not.toContain('Chưa lưu được ·');
    const on = view(file('a.ts', {}, { edit }), { offline: false });
    expect(on).not.toContain('aria-disabled');
    expect(on).toContain('Đang sửa · chưa lưu · Esc để thoát');
    expect(view(file('a.ts', {}, { edit }), { offline: true }, 'en')).toContain('Disconnected · cannot save yet · your change is kept here');
  });
  test('§7 C16 "Nhắn D15…" in the C8 footer is locked while offline', () => {
    const lk = { reason: 'D15 còn phiên sống', lane: 'D15' };
    expect(html(<ViewerFoot f={file('a.ts', {})} lock={lk} lockShown={lk} offline onAsk={nop} />)).toMatch(/class="btn sm" aria-disabled="true"[^>]*>.*Nhắn D15…/);
    expect(html(<ViewerFoot f={file('a.ts', {})} lock={lk} lockShown={lk} offline={false} onAsk={nop} />)).not.toContain('aria-disabled');
  });
  test('§7 C16 the band over the Code view: "Mất kết nối · số liệu lúc hh:mm · đang nối lại"', () => {
    const at = new Date(2026, 10, 16, 14, 32).getTime();
    expect(html(<OffBand dataAt={at} />)).toMatch(/class="coff" role="status"><svg[^]*?Mất kết nối · số liệu lúc 14:32 · đang nối lại/);
    expect(html(<OffBand dataAt={null} />)).toContain('số liệu lúc —');
  });
});

describe('§5.4 tab bar', () => {
  test('§5.4 C26 M3 a clipped edge fades: tabs hidden left → fl, right → fr, both, none when it all fits', () => {
    expect(edgeFade(0, 500, 500)).toBe('');
    expect(edgeFade(0, 500, 900)).toBe(' fr');
    expect(edgeFade(200, 500, 900)).toBe(' fl fr');
    expect(edgeFade(400, 500, 900)).toBe(' fl');
  });
  const tabs = (active: string, list: [string, boolean?][], dirty: string[] = []) => html(<TabBar set={{ tabs: list.map(([path, preview]) => ({ path, preview: !!preview })), active }}
    dirty={p => dirty.includes(p)} onSelect={nop} onPin={nop} onClose={nop} />);
  test('§5.4 C25 the preview tab is italic (class pv); the selected tab is "on"; full path on hover', () => {
    const h = tabs('engine/src/store.ts', [['engine/src/store.ts', true], ['engine/src/auth.ts']]);
    expect(h).toMatch(/aria-selected="true" tabindex="0" title="engine\/src\/store.ts" class="ftb on pv"/);
    expect(h).toMatch(/title="engine\/src\/auth.ts" class="ftb"/);
  });
  test('§5.4 C26 duplicate names → the parent dir dim after the name', () => {
    expect(tabs('a', [['engine/src/auth.ts'], ['engine/test/auth.ts']])).toMatch(/auth.ts<\/span><span class="pd">test</);
  });
  test('§5.4 a tab with unsaved text shows ● instead of ×; no tab → no bar', () => {
    const h = tabs('a.ts', [['a.ts'], ['b.ts']], ['a.ts']);
    expect(h).toContain('class="x dt" aria-label="Chưa lưu — đóng sẽ hỏi trước"');
    expect(h).toContain('class="x" aria-label="Đóng tab (⌘W)"');
    expect(html(<TabBar set={{ tabs: [], active: null }} dirty={() => false} onSelect={nop} onPin={nop} onClose={nop} />)).toBe('');
  });
});

describe('§5.3 dialogs', () => {
  const dlg = (d: Dlg, lang: 'vi' | 'en' = 'vi') => html(<CodeDialog dlg={d} src="thư mục project" by={null} onChoose={nop} />, lang);
  test('§5.3 C23 Huỷ / Esc: "Sửa tiếp" · "Bỏ thay đổi" · "Lưu ⌘S"; C27 closing a tab: "Huỷ" · "Bỏ" · "Lưu"', () => {
    const c23 = dlg({ k: 'dirty', why: 'cancel', path: 'engine/src/auth.ts', lines: 1 });
    expect(c23).toContain('Bỏ thay đổi chưa lưu?');
    expect(c23).toContain('engine/src/auth.ts có 1 dòng chưa lưu. Huỷ sẽ bỏ thay đổi này.');
    expect(c23).toMatch(/>Sửa tiếp<.*class="btn sm bad"[^>]*>Bỏ thay đổi<.*class="btn sm pri"[^>]*>Lưu <kbd>⌘S/);
    const c27 = dlg({ k: 'dirty', why: 'close', path: 'a.ts', lines: 2 });
    expect(c27).toContain('Đóng tab sẽ bỏ thay đổi này.');
    expect(c27).toMatch(/>Huỷ<.*>Bỏ<.*>Lưu </);
  });
  test('§5.3 C7 960 px, two columns "Trên đĩa (mới)" | "Của anh", changed lines + underline, the lines listed', () => {
    const h = dlg({ k: 'conflict', path: 'a.ts', at: 0, mine: 'a\n/** trả false */\nz', disk: { kind: 'text', text: 'a\n/** trả flase */\nz', size: 1, hash: 'd' } });
    expect(h).toContain('width:960px');
    expect(h).toMatch(/Trên đĩa \(mới\).*<u>flase<\/u>.*Của anh.*<u>false<\/u>/);
    expect(h).toContain('Dòng 2 khác nhau. Không tự gộp — chọn một bản.');
    expect(h).toMatch(/>Huỷ, sửa tiếp<.*>Bỏ bản của anh, mở bản trên đĩa<.*class="btn sm bad"[^>]*>Ghi đè bằng bản của anh</);
  });
  test('§5.3 C22 gone: "Tạo lại bằng bản của anh" · "Bỏ" · "Huỷ, sửa tiếp"; English catalog', () => {
    const h = dlg({ k: 'gone', path: 'a.ts', at: 0 });
    expect(h).toContain('File đã bị xoá trên đĩa');
    expect(h).toMatch(/>Huỷ, sửa tiếp<.*>Bỏ<.*class="btn sm pri"[^>]*>Tạo lại bằng bản của anh</);
    expect(dlg({ k: 'gone', path: 'a.ts', at: 0 }, 'en')).toContain('Recreate from yours');
  });
});
