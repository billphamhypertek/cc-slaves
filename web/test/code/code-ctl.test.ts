// spec v2.3 §5.3 / §5.4 / §10.1 the Code tab controller over a fake fs: `guardDirty` on each of the three paths that drop
// text ("Huỷ", Esc, close tab by × / ⌘W / middle click) and none on the others (tree, ⌘P, chip, pick, mode, ⌘1–9, doc link,
// `code_changed`); save with `baseHash` / eol / bom → C19, conflict → C7, gone → C22; hot exit (restore with ●, band,
// lock; cleared on save / discard / dropped source); one tab set per source.
import { describe, expect, test } from 'bun:test';
import type { FsReadResult, FsWriteReq, FsWriteResult } from '../../../shared/protocol.ts';
import { CodeTabs } from '../../src/code/code-tabs.ts';
import type { FsCmd } from '../../src/code/fs.ts';
import { HotExit } from '../../src/code/hot-exit.ts';
import { saveTabs } from '../../src/code/tabs.ts';
import { memKv } from './mem-kv.ts';
import { CommandError } from '../../src/lib/ws.ts';

const txt = (text: string, hash = `h:${text}`): FsReadResult => ({ kind: 'text', text, size: text.length, hash, eol: 'lf', bom: false });
const tick = () => new Promise(r => setTimeout(r, 0));
const now = () => 1_700_000_000_000;

function rig(files: Record<string, string> = { 'a.ts': 'A', 'b.ts': 'B', 'c.ts': 'C' }) {
  const disk = new Map(Object.entries(files));
  const writes: FsWriteReq[] = [];
  let writeErr: Error | null = null;
  const send = (c: FsCmd): Promise<unknown> => {
    if (c.cmd === 'fs_read') { const t = disk.get(c.path); return t === undefined ? Promise.reject(new CommandError('not_found', 'gone')) : Promise.resolve(txt(t)); }
    if (c.cmd === 'fs_write') {
      writes.push(c);
      if (writeErr) return Promise.reject(writeErr);
      const t = disk.get(c.path);
      let r: FsWriteResult;
      if (t === undefined && !c.recreate) r = { ok: false, code: 'gone' };
      else if (t !== undefined && `h:${t}` !== c.baseHash) r = { ok: false, code: 'conflict', disk: txt(t) };
      else { disk.set(c.path, c.text); r = { ok: true, hash: `h:${c.text}` }; }
      return Promise.resolve(r);
    }
    return Promise.reject(new Error('unexpected'));
  };
  const kv = memKv(), ls = new Map<string, string>();
  const ks = { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => void ls.set(k, v) };
  const timers = { set: (fn: () => void) => { queueMicrotask(fn); return 1; }, clear: () => {} };
  const he = new HotExit(kv, timers);
  const ctl = new CodeTabs({ send, hot: he, ks, now });
  return { ctl, disk, writes, kv, ks, he, failWrite: (e: Error) => { writeErr = e; } };
}
const LIVE = new Set(['base', 'lane:D15']);
async function editing(r = rig(), text = 'A2') {
  r.ctl.show('p', 'base', LIVE);
  await tick();
  r.ctl.open('a.ts');
  await tick();
  r.ctl.startEdit();
  r.ctl.change(text, 1);
  await tick();
  return r;
}

describe('§10.1 guardDirty — asks on the three paths that drop text', () => {
  test('§5.3 "Huỷ" with changes → C23 dialog (why: cancel); "Sửa tiếp" keeps the text', async () => {
    const { ctl } = await editing();
    ctl.cancelEdit();
    expect(ctl.dlg).toMatchObject({ k: 'dirty', why: 'cancel', path: 'a.ts' });
    ctl.choose('keep');
    expect(ctl.dlg).toBeNull();
    expect(ctl.file()?.edit?.text).toBe('A2');
  });
  test('§5.3 Esc (the shell\'s `edit` step) goes through the same guard', async () => {
    const { ctl } = await editing();
    expect(ctl.escSteps()).toEqual({ codeDlg: false, edit: true });
    ctl.escEdit();
    expect(ctl.dlg).toMatchObject({ k: 'dirty', why: 'cancel' });
    expect(ctl.escSteps()).toEqual({ codeDlg: true, edit: true });
    ctl.escDlg();
    expect(ctl.dlg).toBeNull();
  });
  test('§5.4 close by × / ⌘W / middle click on a ● tab → C27 (why: close); "Bỏ" closes and drops the text', async () => {
    const r = await editing();
    r.ctl.close('a.ts');
    expect(r.ctl.dlg).toMatchObject({ k: 'dirty', why: 'close' });
    r.ctl.choose('discard');
    expect(r.ctl.set().tabs).toEqual([]);
    expect(r.ctl.file()).toBeNull();
    r.ctl.closeActive(); // ⌘W with no tab: nothing
    expect(r.ctl.dlg).toBeNull();
  });
  test('§5.3 no changes → "Huỷ" / close act at once, no dialog', async () => {
    const { ctl } = await editing(rig(), 'A');
    ctl.cancelEdit();
    expect(ctl.dlg).toBeNull();
    expect(ctl.file()?.edit).toBeNull();
    ctl.closeActive();
    expect(ctl.dlg).toBeNull();
    expect(ctl.set().tabs).toEqual([]);
  });
});

describe('§10.1 guardDirty — never asks elsewhere; the text stays in its ● tab', () => {
  test('§5.3 tree / ⌘P / doc link open another file, chip / pick / ⌘1–9 switch source or project: no dialog, text kept', async () => {
    const { ctl } = await editing();
    ctl.open('b.ts');
    await tick();
    expect(ctl.dlg).toBeNull();
    expect(ctl.set().tabs.map(t => t.path)).toEqual(['a.ts', 'b.ts']); // the edited tab was pinned, b is the preview
    ctl.show('p', 'lane:D15', LIVE);
    ctl.show('q', 'base', new Set(['base']));
    ctl.show('p', 'base', LIVE);
    expect(ctl.dlg).toBeNull();
    ctl.select('a.ts');
    expect(ctl.file()?.edit).toMatchObject({ text: 'A2', dirty: true });
  });
  test('§5.3 code_changed on the file being edited: no reload, no dialog — only the yellow "vừa chạy" footer', async () => {
    const r = await editing();
    r.disk.set('a.ts', 'A-by-lane');
    r.ctl.codeChanged({ type: 'code_changed', projectId: 'p', src: { kind: 'base' }, paths: ['a.ts'] }, () => false, null);
    await tick();
    expect(r.ctl.dlg).toBeNull();
    expect(r.ctl.file()).toMatchObject({ edit: { text: 'A2' }, ran: { who: null } });
    expect(r.ctl.file()?.res?.text).toBe('A');
  });
  test('§5.3 C15 the event names the lane holding the dir → the footer names it ("D15 vừa chạy …")', async () => {
    const r = await editing();
    r.ctl.codeChanged({ type: 'code_changed', projectId: 'p', src: { kind: 'base' }, paths: ['a.ts'] }, () => false, 'D15');
    await tick();
    expect(r.ctl.file()?.ran).toEqual({ who: 'D15' });
  });
});

describe('§5.3 save', () => {
  test('§5.3 ⌘S sends fs_write with the open baseHash / eol / bom → C19 "Đã lưu", back to read mode, buffer dropped', async () => {
    const r = await editing();
    r.ctl.save();
    await tick(); await tick();
    expect(r.writes[0]).toMatchObject({ cmd: 'fs_write', projectId: 'p', src: { kind: 'base' }, path: 'a.ts', text: 'A2', baseHash: 'h:A', eol: 'lf', bom: false });
    expect(r.writes[0]!.recreate).toBeUndefined();
    expect(r.ctl.file()).toMatchObject({ edit: null, savedAt: now(), res: { text: 'A2', hash: 'h:A2' } });
    expect(await r.he.load('p', 'base')).toEqual(new Map());
  });
  test('§5.3 the disk changed since open → C7 with the disk text; "Ghi đè" saves over it with the new baseHash', async () => {
    const r = await editing();
    r.disk.set('a.ts', 'A-disk');
    r.ctl.save();
    await tick();
    expect(r.ctl.dlg).toMatchObject({ k: 'conflict', path: 'a.ts', disk: { text: 'A-disk' } });
    r.ctl.choose('overwrite');
    await tick(); await tick();
    expect(r.writes[1]?.baseHash).toBe('h:A-disk');
    expect(r.disk.get('a.ts')).toBe('A2');
    expect(r.ctl.dlg).toBeNull();
  });
  test('§5.3 C7 "Bỏ bản của anh, mở bản trên đĩa" → the disk text, read mode, buffer dropped', async () => {
    const r = await editing();
    r.disk.set('a.ts', 'A-disk');
    r.ctl.save();
    await tick();
    r.ctl.choose('takeDisk');
    await tick();
    expect(r.ctl.file()).toMatchObject({ edit: null, res: { text: 'A-disk' } });
    expect((await r.he.load('p', 'base')).size).toBe(0);
  });
  test('§5.3 the file was deleted → C22; "Tạo lại" writes with recreate; "Bỏ" closes the tab', async () => {
    const r = await editing();
    r.disk.delete('a.ts');
    r.ctl.save();
    await tick();
    expect(r.ctl.dlg).toMatchObject({ k: 'gone', path: 'a.ts' });
    r.ctl.choose('recreate');
    await tick(); await tick();
    expect(r.writes[1]?.recreate).toBe(true);
    expect(r.disk.get('a.ts')).toBe('A2');
    const r2 = await editing();
    r2.disk.delete('a.ts');
    r2.ctl.save();
    await tick();
    r2.ctl.choose('discard');
    expect(r2.ctl.set().tabs).toEqual([]);
  });
  test('§5.4 C27 "Lưu" saves through baseHash and closes the tab only after the save', async () => {
    const r = await editing();
    r.ctl.close('a.ts');
    r.ctl.choose('save');
    expect(r.ctl.set().tabs.length).toBe(1);
    await tick(); await tick();
    expect(r.writes[0]?.baseHash).toBe('h:A');
    expect(r.ctl.set().tabs).toEqual([]);
  });
  test('§5.4 C27 "Lưu" hitting a conflict shows C7 and does not close the tab', async () => {
    const r = await editing();
    r.disk.set('a.ts', 'other');
    r.ctl.close('a.ts');
    r.ctl.choose('save');
    await tick(); await tick();
    expect(r.ctl.dlg?.k).toBe('conflict');
    expect(r.ctl.set().tabs.length).toBe(1);
  });
  test('§5.3 the engine refuses (lane_running) → the error stays on the tab, the text stays', async () => {
    const r = await editing();
    r.failWrite(new CommandError('lane_running', 'x', 'errors.codeLaneRunning', { lane: 'D7' }));
    r.ctl.save();
    await tick(); await tick();
    expect(r.ctl.file()?.saveErr).toBeInstanceOf(CommandError);
    expect(r.ctl.file()?.edit?.text).toBe('A2');
  });
});

describe('§5.4 tabs per source + restore + hot exit', () => {
  test('§5.4 each source has its own set; switching away and back gives the same selected tab (C28)', async () => {
    const { ctl } = rig();
    ctl.show('p', 'base', LIVE);
    ctl.open('a.ts', true); ctl.open('b.ts', true); ctl.select('a.ts');
    ctl.show('p', 'lane:D15', LIVE);
    expect(ctl.set().tabs).toEqual([]);
    ctl.open('c.ts');
    ctl.show('p', 'base', LIVE);
    expect(ctl.set()).toMatchObject({ active: 'a.ts', tabs: [{ path: 'a.ts' }, { path: 'b.ts' }] });
  });
  test('§5.4 "Sửa" pins the preview tab; double click on a tab pins it', async () => {
    const { ctl } = rig();
    ctl.show('p', 'base', LIVE);
    ctl.open('a.ts');
    await tick();
    expect(ctl.set().tabs[0]?.preview).toBe(true);
    ctl.startEdit();
    expect(ctl.set().tabs[0]?.preview).toBe(false);
    ctl.open('b.ts');
    ctl.pin('b.ts');
    expect(ctl.set().tabs.every(t => !t.preview)).toBe(true);
  });
  test('§5.4 reload: tabs come back from localStorage; a removed lane\'s set and its buffers are dropped', async () => {
    const r = rig();
    saveTabs('p', 'base', { tabs: [{ path: 'a.ts', preview: false }, { path: 'gone.ts', preview: true }], active: 'gone.ts' }, r.ks);
    saveTabs('p', 'lane:D7', { tabs: [{ path: 'x.ts', preview: false }], active: 'x.ts' }, r.ks);
    r.he.queue('p', 'lane:D7', 'x.ts', { text: 'x', baseHash: 'h', eol: 'lf', bom: false, line: 1, savedAt: 1 });
    r.he.flush();
    await tick();
    r.ctl.show('p', 'base', LIVE);
    await tick(); await tick();
    expect(r.ctl.set()).toMatchObject({ active: 'gone.ts', tabs: [{ path: 'a.ts' }, { path: 'gone.ts' }] });
    expect(r.ctl.file()).toMatchObject({ res: null, loading: false }); // §7 the deleted file keeps its tab, read error shown
    expect(r.ctl.file()?.err).toBeInstanceOf(CommandError);
    expect((await r.he.load('p', 'lane:D7')).size).toBe(0);
  });
  test('§5.4 hot exit: edit, reload → the tab is back with ●, the text, edit mode and the band time; no dialog', async () => {
    const r = await editing(rig(), 'A-typed');
    r.ctl.flush(); // pagehide
    await tick();
    const ctl2 = new CodeTabs({ send: (c: FsCmd) => Promise.resolve(c.cmd === 'fs_read' ? txt('A') : null), hot: r.he, ks: r.ks, now });
    ctl2.show('p', 'base', LIVE);
    await tick(); await tick(); await tick();
    expect(ctl2.dlg).toBeNull();
    expect(ctl2.file()).toMatchObject({ edit: { text: 'A-typed', baseHash: 'h:A', dirty: true, free: false }, restored: expect.any(Number) });
  });
  test('§5.4 "Bỏ thay đổi" drops the IndexedDB buffer', async () => {
    const r = await editing();
    r.ctl.flush();
    await tick();
    expect((await r.he.load('p', 'base')).size).toBe(1);
    r.ctl.cancelEdit();
    r.ctl.choose('discard');
    await tick();
    expect((await r.he.load('p', 'base')).size).toBe(0);
    expect(r.ctl.file()?.edit).toBeNull();
  });
});

describe('§7 C15 changed on disk while reading', () => {
  async function reading() {
    const r = rig();
    r.ctl.show('p', 'lane:D15', LIVE);
    r.ctl.open('a.ts');
    await tick();
    r.disk.set('a.ts', 'A-new');
    return r;
  }
  test('§7 C15 not scrolled → the new text quietly; scrolled → the band, the old text stays', async () => {
    const r = await reading();
    r.ctl.refocus(() => false);
    await tick();
    expect(r.ctl.file()).toMatchObject({ res: { text: 'A-new' }, stale: null });
    r.disk.set('a.ts', 'A-3');
    r.ctl.refocus(() => true);
    await tick();
    expect(r.ctl.file()).toMatchObject({ res: { text: 'A-new' }, stale: { by: null } });
  });
  test('§10.2 code_changed of a lane source names the lane on the band; another path is ignored', async () => {
    const r = await reading();
    r.ctl.codeChanged({ type: 'code_changed', projectId: 'p', src: { kind: 'lane', laneId: 'D15' }, paths: ['zz.ts'] }, () => true, null);
    await tick();
    expect(r.ctl.file()?.stale).toBeNull();
    r.ctl.codeChanged({ type: 'code_changed', projectId: 'p', src: { kind: 'lane', laneId: 'D15' } }, () => true, null);
    await tick();
    expect(r.ctl.file()?.stale).toEqual({ by: 'D15', at: now() });
  });
});

describe('§5.1 I1 the tree follows the shown set only', () => {
  test('§5.1 C28 / C29 activeOf: null for a (project, source) before `show` runs for it, its restored active file after', () => {
    const r = rig();
    saveTabs('p', 'lane:D15', { tabs: [{ path: 'engine/src/auth.ts', preview: false }], active: 'engine/src/auth.ts' }, r.ks);
    r.ctl.show('p', 'base', LIVE);
    r.ctl.open('a.ts');
    expect(r.ctl.activeOf('p', 'base')).toBe('a.ts');
    expect(r.ctl.activeOf('p', 'lane:D15')).toBeNull(); // the render before the switch: never base's a.ts
    r.ctl.show('p', 'lane:D15', LIVE);
    expect(r.ctl.activeOf('p', 'lane:D15')).toBe('engine/src/auth.ts');
    expect(r.ctl.activeOf('p', 'base')).toBeNull();
  });
});
