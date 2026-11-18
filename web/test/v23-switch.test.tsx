// spec v2.3 §4 the Deck · Code · Git switch: D / C / G keys and the ⌘ keys inside the viewer (§4.1, V14), Esc ladder
// additions (V9 mode memory: replaced by v2.7 §4.1, tasks-mode.test.tsx), Code source from Đang xem (§4.2), composer target override (§4.3, V12).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { isTyping, keyAction, type KeyLike } from '../src/lib/keys.ts';
import { editorEsc, escapeStep, listOnAfter, modeEsc, type EscState } from '../src/ui/shell.ts';
import { srcFor } from '../src/code/src.ts';
import { applyPick, askFor, composerFor, ORCH, type Selection } from '../src/lib/inspector.ts';
import { HeadBar } from '../src/ui/HeadBar.tsx';
import { LangProvider } from '../src/lib/i18n.tsx';
import { buildItems } from '../src/lib/palette.ts';
import { lane, snapshot } from './fixtures.ts';
import { makeT } from '../../shared/i18n/index.ts';

const VI = makeT('vi');
const k = (key: string, over: Partial<KeyLike> = {}): KeyLike =>
  ({ key, code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });
const html = (el: ReactElement) => renderToStaticMarkup(<LangProvider lang="vi">{el}</LangProvider>);

describe('§4.1 keys', () => {
  test('§4.1 D / C / G switch the mode when the caret is not in a text field', () => {
    expect(keyAction(k('d'), false)).toEqual({ t: 'mode', m: 'deck' });
    expect(keyAction(k('C', { shiftKey: true }), false)).toEqual({ t: 'mode', m: 'code' });
    expect(keyAction(k('g'), false)).toEqual({ t: 'mode', m: 'git' });
  });
  test('§4.1 V14 D / C / G are dead while typing and inside .cm-editor (isTyping counts the viewer)', () => {
    for (const key of ['d', 'c', 'g']) expect(keyAction(k(key), true)).toBeNull();
    const inCm = { matches: () => false, isContentEditable: false, closest: (q: string) => (q === '.cm-editor' ? {} : null) };
    const outside = { matches: () => false, isContentEditable: false, closest: () => null };
    expect(isTyping(inCm)).toBe(true);
    expect(isTyping(outside)).toBe(false);
  });
  test('§4.1 ⌘K and ⌘. run with the focus inside .cm-editor', () => {
    expect(keyAction(k('k', { metaKey: true }), true, false, true)).toEqual({ t: 'palette' });
    expect(keyAction(k('.', { metaKey: true }), true, false, true)).toEqual({ t: 'interrupt' });
  });
  test('§4.1 ⌘P / ⌘S / ⌘W are code keys (also while typing / in the viewer); the shell always preventDefaults them', () => {
    expect(keyAction(k('p', { metaKey: true }), true, false, true)).toEqual({ t: 'code', k: 'quickOpen' });
    expect(keyAction(k('s', { metaKey: true }), false)).toEqual({ t: 'code', k: 'save' });
    expect(keyAction(k('w', { ctrlKey: true }), true, false, true)).toEqual({ t: 'code', k: 'closeTab' });
    const src = readFileSync(new URL('../src/ui/useWindowHooks.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/a\.t === 'code'\) \{ e\.preventDefault\(\);/);
  });
  test('§4.1 Esc inside .cm-editor is the editor\'s (no escapeStep); outside it stays the ladder', () => {
    expect(keyAction(k('Escape'), true, false, true)).toEqual({ t: 'editorEsc' });
    expect(keyAction(k('Escape'), true, false, false)).toEqual({ t: 'escape' });
  });
});

describe('§4.1 one Esc inside the editor (R21: follow the spec)', () => {
  test('§4.1 one Esc while editing (CodeMirror did not take it) → the edit step: exit, or the C23 dialog when dirty', () => {
    expect(editorEsc(false, 'code', { edit: true })).toBe('edit');
  });
  test('§4.1 CodeMirror took it (⌘F box), not editing, not at Code, or a dialog / ⌘P on top → blur or nothing', () => {
    expect(editorEsc(true, 'code', { edit: true })).toBeNull();
    expect(editorEsc(false, 'code', { edit: false })).toBe('blur');
    expect(editorEsc(false, 'code', null)).toBe('blur');
    expect(editorEsc(false, 'git', { edit: true })).toBe('blur');
    expect(editorEsc(false, 'code', { edit: true, codeDlg: true })).toBe('blur');
    expect(editorEsc(false, 'code', { edit: true, quickOpen: true })).toBe('blur');
  });
  test('§4.1 the key map runs the edit step through codeApi.close', () => {
    const src = readFileSync(new URL('../src/ui/useWindowHooks.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/const s = editorEsc\(e\.defaultPrevented, mode, mode === 'code' \? codeApi\.current\?\.esc\(\) \?\? null : null\);\s*if \(s === 'edit'\) codeApi\.current\?\.close\('edit'\); else if \(s === 'blur'\) el\?\.blur\(\);/);
  });
});

describe('§4.1 Esc ladder at Code / Git', () => {
  const none: EscState = { palette: false, stopLane: false, moveAll: false, addOpen: false, settings: false, wizard: false, up: false, drawer: false };
  test('§10.1 codeDlg → quickOpen → edit come before up, after the menus', () => {
    expect(escapeStep({ ...none, codeDlg: true, quickOpen: true, edit: true, up: true })).toBe('codeDlg');
    expect(escapeStep({ ...none, quickOpen: true, edit: true, up: true })).toBe('quickOpen');
    expect(escapeStep({ ...none, edit: true, up: true, drawer: true })).toBe('edit');
    expect(escapeStep({ ...none, menu: true, codeDlg: true })).toBe('menu');
    expect(escapeStep({ ...none, accPanel: true, edit: true })).toBe('accPanel');
  });
  test('§4.1 at Code / Git: no accPanel step and no "up"; at Deck both stay', () => {
    const s = { accPanel: true, up: true };
    expect(modeEsc('deck', s)).toEqual(s);
    expect(modeEsc('code', s)).toEqual({ accPanel: false, up: false });
    expect(modeEsc('git', s)).toEqual({ accPanel: false, up: false });
    const src = readFileSync(new URL('../src/ui/useWindowHooks.ts', import.meta.url), 'utf8');
    expect(src).toContain('...modeEsc(mode, { accPanel: accOpen && !list, up: selUp(sel) !== null })');
  });
});

describe('§4.1 L / F9 at Code / Git → the Deck list', () => {
  test('§4.1 L / F9 at Code / Git turns the list on (Deck); at Deck it toggles', () => {
    expect(listOnAfter('code', false)).toBe(true);
    expect(listOnAfter('git', true)).toBe(true);
    expect(listOnAfter('deck', false)).toBe(true);
    expect(listOnAfter('deck', true)).toBe(false);
  });
  test('§4.1 the toggle always switches the mode to Deck', () => {
    const src = readFileSync(new URL('../src/ui/App.tsx', import.meta.url), 'utf8');
    expect(src).toMatch(/const toggleList = \(\) => \{ const on = listOnAfter\(mode, listOn\); setMode\('deck'\); setListOn\(on\);/);
  });
});

describe('§4.2 Code source follows Đang xem', () => {
  const ls = [
    lane('D15', { worktreeExists: true, branch: null }),
    lane('D7', { state: 'done', worktreeExists: false }),
    lane('D9', { worktreeExists: true, branch: { name: null, base: null, state: 'none', ahead: 0, files: 0, add: 0, del: 0, measuredAt: 0 } }),
  ];
  test('§4.2 Điều phối / account / done list → project folder', () => {
    for (const s of [ORCH, { k: 'account', email: 'a@x' }, { k: 'doneList' }] as Selection[]) expect(srcFor(s, ls)).toEqual({ lane: null, note: null });
  });
  test('§4.2 lane with a worktree → its worktree; a subagent → like its parent lane', () => {
    expect(srcFor({ k: 'lane', name: 'D15' }, ls)).toEqual({ lane: 'D15', note: null });
    expect(srcFor({ k: 'sub', lane: 'D15', taskId: 't1' }, ls)).toEqual({ lane: 'D15', note: null });
  });
  test('§4.2 C12 lane without worktree → project folder + "no worktree" band; done lane view too', () => {
    expect(srcFor({ k: 'doneLane', name: 'D7' }, ls)).toEqual({ lane: null, note: { k: 'noWorktree', lane: 'D7' } });
  });
  test('§4.2 lane with no branch of its own (runs in the repo) → project folder + "runs in the repo"', () => {
    expect(srcFor({ k: 'lane', name: 'D9' }, ls)).toEqual({ lane: null, note: { k: 'direct', lane: 'D9' } });
  });
  test('§4.2 a lane that vanished → project folder', () => {
    expect(srcFor({ k: 'lane', name: 'Z1' }, ls)).toEqual({ lane: null, note: null });
  });
});

describe('§4.3 composer target override', () => {
  const ls = [lane('D2'), lane('D7', { state: 'done' })];
  const d2: Selection = { k: 'lane', name: 'D2' };
  test('§4.3 no override: the target follows Đang xem (done lane / vanished lane → Điều phối)', () => {
    expect(composerFor(d2, 'p1', null, ls, null)).toEqual({ kind: 'lane', projectId: 'p1', name: 'D2' });
    expect(composerFor({ k: 'doneLane', name: 'D7' }, 'p1', 's1', ls, null)).toEqual({ kind: 'orchestrator', projectId: 'p1', sessionId: 's1' });
    expect(composerFor({ k: 'lane', name: 'Z1' }, 'p1', null, ls, null)).toEqual({ kind: 'orchestrator', projectId: 'p1' });
  });
  test('§4.3 V12 "Nhờ …" sets the override: the target is the asked one, Đang xem (sel) does not change', () => {
    const t = { kind: 'orchestrator' as const, projectId: 'p1' };
    expect(composerFor(d2, 'p1', null, ls, t)).toEqual(t);
    const lane7 = { kind: 'lane' as const, projectId: 'p1', name: 'D7' };
    for (const who of [t, lane7]) {
      const s = askFor({ sel: d2, override: null }, who);
      expect(s.sel).toBe(d2);
      expect(s.override).toBe(who);
      expect(composerFor(s.sel, 'p1', null, ls, s.override)).toEqual(who);
    }
    const same = { sel: d2, override: t };
    expect(askFor(same, t)).toBe(same); // no new state → no re-render
    expect(askFor(same, null)).toEqual({ sel: d2, override: null });
  });
  test('§4.3 every "Nhờ …" in App (Git asks, C8 "Nhắn D15…") goes through ui.ask (askFor), never pick', () => {
    const app = readFileSync(new URL('../src/ui/App.tsx', import.meta.url), 'utf8');
    const asks = [/const askLane = [^\n]*/.exec(app)?.[0], /\n\s*ask: \(who, text\) => [^\n]*/.exec(app)?.[0]];
    for (const a of asks) {
      expect(a).toContain('ui.ask(');
      expect(a).not.toMatch(/\bpick\(|applyPick|setTarget|selectLane/);
    }
    const st = readFileSync(new URL('../src/ui/useAppState.ts', import.meta.url), 'utf8');
    expect(st).toMatch(/const ask = useCallback\(\(t: Target \| null\) => setSo\(s => askFor\(s, t\)\)/);
  });
  test('§4.3 pick() = set sel + clear the override (value or updater)', () => {
    const t = { kind: 'orchestrator' as const, projectId: 'p1' };
    expect(applyPick({ sel: d2, override: t }, ORCH)).toEqual({ sel: ORCH, override: null });
    expect(applyPick({ sel: d2, override: t }, s => s)).toEqual({ sel: d2, override: null });
  });
  test('§4.3 the override is cleared on send and on project change (pickProject → pick)', () => {
    const left = readFileSync(new URL('../src/ui/LeftColumn.tsx', import.meta.url), 'utf8');
    expect(left).toMatch(/onSend=\{\(t, text, raw, attachments\) => \{ ui\.ask\(null\);/);
    const app = readFileSync(new URL('../src/ui/App.tsx', import.meta.url), 'utf8');
    expect(app).toMatch(/const pickProject = \(id: string\) => \{[^}]*pick\(ORCH\)/);
    expect(app).not.toMatch(/\bsetSel\b/);
  });
});

describe('§4.1 head bar + switch', () => {
  const head = { parts: [{ k: 'name' as const, text: 'hagenta' }, { k: 'counts' as const, text: '5 lane · 0 subagent' }], tip: [] };
  test('§4.1 tablist outside the role=status stats; the on tab is aria-selected; key hint ≥ 11 px via .kb', () => {
    const h = html(<HeadBar head={head} mode="code" onMode={() => {}} tasks={false} unseen={false} />);
    const tl = h.indexOf('role="tablist"'), st = h.indexOf('role="status"');
    expect(tl).toBeGreaterThan(-1);
    expect(st).toBeGreaterThan(tl);
    expect(h.slice(tl, st)).toContain('</div>'); // the tablist closes before the status span opens
    expect(h).toMatch(/<button[^>]*role="tab"[^>]*aria-selected="true"[^>]*>.*?Code/);
    expect((h.match(/role="tab"/g) ?? []).length).toBe(3);
    expect(h).toContain('title="Code · phím C (khi con trỏ không ở ô chữ)"');
    expect(h).toContain('<span class="kb">G</span>');
  });
  test('§4.1 ⌘K lists Deck, Code, Git and "Mở file…" (⌘P)', () => {
    const items = buildItems(VI, snapshot({ lanes: [lane('D2')] }), { projectId: 'p1', selectedLane: null, keys: [], offline: false, tauri: false });
    const by = (id: string) => items.find(i => i.id === id);
    expect(by('mode:deck')?.kbd).toBe('D');
    expect(by('mode:code')?.kbd).toBe('C');
    expect(by('mode:git')?.kbd).toBe('G');
    expect(by('quickOpen')?.kbd).toBe('⌘P');
  });
});

describe('§4.2 / §7 C12 the Code shell band', () => {
  test('§7 C12 band only for a lane whose worktree is gone, not for a lane running in the repo', async () => {
    const { CodeView } = await import('../src/code/CodeView.tsx');
    const none = { name: null, base: null, state: 'none' as const, ahead: 0, files: 0, add: 0, del: 0, measuredAt: 0 };
    const ls = [lane('D7', { state: 'done', worktreeExists: false }), lane('D9', { branch: none })];
    const view = (sel: Selection, offline = false) => html(<CodeView shown sel={sel} lanes={ls} project={{ id: 'p1', path: '/p' }} narrow={false} rawSend={() => new Promise(() => {})} openVscode={() => {}} askLane={() => {}} orchestrators={[]} codeEv={null} req={null} api={{ current: null }}
      offline={offline} dataAt={new Date(2026, 10, 16, 14, 32).getTime()} />);
    expect(view({ k: 'doneLane', name: 'D7' })).toContain('D7 không còn worktree · đang xem thư mục project');
    expect(view({ k: 'lane', name: 'D9' })).not.toContain('class="cnote"');
    expect(view({ k: 'lane', name: 'D9' })).toContain('thư mục project');
    // §7 C16 offline: the band on top of the Code view; the tree column stays
    expect(view(ORCH, true)).toMatch(/<div class="coff" role="status">.*Mất kết nối · số liệu lúc 14:32 · đang nối lại.*class="cside"/);
    expect(view(ORCH)).not.toContain('class="coff"');
  });
});
