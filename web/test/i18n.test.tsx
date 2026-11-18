// v2 §6A (D19) web side: store `lang`, `useT()` switching, card titles / command errors rendered by key.
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Snapshot } from '../../shared/protocol.ts';
import { makeT } from '../../shared/i18n/index.ts';
import { cardBody, cardTitle, errText, installLast, LangProvider, reasonText, shownLang, useT } from '../src/lib/i18n.tsx';
import { cardSource } from '../src/lib/labels.ts';
import { Store } from '../src/lib/store.ts';
import { CommandError } from '../src/lib/ws.ts';
import { card, snapshot } from './fixtures.ts';

function Probe() {
  const tr = useT();
  return <b>{tr('common.close')}</b>;
}

describe('§6A store lang', () => {
  test('§6A no snapshot / no ui → vi; config event with ui.lang en → en at once (no restart)', () => {
    const s = new Store(() => 1);
    expect(s.lang()).toBe('vi');
    s.apply({ type: 'snapshot', snapshot: snapshot() });
    expect(s.lang()).toBe('vi');
    s.apply({ type: 'event', event: { type: 'config', config: { ui: { lang: 'en' } } } });
    expect(s.lang()).toBe('en');
  });
});

describe('§6A useT()', () => {
  test('§6A switches with the provider lang', () => {
    expect(renderToStaticMarkup(<LangProvider lang="vi"><Probe /></LangProvider>)).toBe('<b>Đóng</b>');
    expect(renderToStaticMarkup(<LangProvider lang="en"><Probe /></LangProvider>)).toBe('<b>Close</b>');
  });
  test('§6A no provider → vi (default)', () => {
    expect(renderToStaticMarkup(<Probe />)).toBe('<b>Đóng</b>');
  });
  test('§6A the App provides the snapshot language (wizard title in en)', async () => {
    const g = globalThis as Record<string, unknown>;
    g.window ??= { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
    g.location ??= { search: '' };
    const { App } = await import('../src/ui/App.tsx');
    const html = (snap: Snapshot) => {
      const store = new Store(() => 1);
      store.apply({ type: 'snapshot', snapshot: snap });
      return renderToStaticMarkup(<App store={store} client={{ send: () => Promise.resolve(null) } as never} />);
    };
    const base = snapshot({ engine: { ...snapshot().engine, setupNeeded: true } });
    expect(html({ ...base, config: { ui: { lang: 'en' } } })).toContain('First-run setup');
    expect(html(base)).toContain('Cài đặt lần đầu');
  });
});

describe('§6A card title / command error by key', () => {
  const en = makeT('en');
  test('§6A titleKey (+ params) preferred over title', () => {
    expect(cardTitle(en, card(1, { title: 'Cấu hình chung ⚠ 2', titleKey: 'accounts.cfgBad', params: { n: 2 } }))).toBe('Shared config ⚠ 2');
  });
  test('§6A no titleKey (old card_v2 row) or a key this UI does not know → title', () => {
    expect(cardTitle(en, card(1, { title: 'D2 hỏi' }))).toBe('D2 hỏi');
    expect(cardTitle(en, card(1, { title: 'D2 hỏi', titleKey: 'cards.newerEngine' }))).toBe('D2 hỏi');
  });
  test('§6A error key preferred over message; plain Error → message', () => {
    expect(errText(en, new CommandError('bad_input', 'Lệnh lỗi', 'common.cmdFailed'))).toBe('Command failed');
    expect(errText(en, new CommandError('bad_input', 'Sai rồi'))).toBe('Sai rồi');
    expect(errText(en, new Error('boom'))).toBe('boom');
  });
});

describe('§6A G5-fix orchestrator source + engine-composed reasons', () => {
  const en = makeT('en'), vi = makeT('vi');
  test('§6A G5-fix cardSource / cardTitle: "orchestrator" and old "Điều phối" rows → the role name per language', () => {
    for (const source of ['orchestrator', 'Điều phối']) {
      const c = card(1, { kind: 'permission', source, title: 'Điều phối xin chạy: Bash ls', titleKey: 'cards.permission', params: { source, tool: 'Bash', main: 'ls' } });
      expect(cardSource(en, c)).toBe('Orchestrator · permission');
      expect(cardTitle(en, c)).toBe('Orchestrator wants to run: Bash ls');
      expect(cardTitle(vi, c)).toBe('Điều phối xin chạy: Bash ls');
    }
    expect(cardSource(en, card(2, { kind: 'ask', source: 'D2' }))).toBe('Lane D2');
  });

  test('§7.1-3 cutover card: account source, title with n in en / vi', () => {
    const c = card(3, { kind: 'cutover', source: null, title: 'Chưa có account v2 · 2 lane đang chờ', titleKey: 'cards.cutover', params: { n: 2 } });
    expect(cardSource(en, c)).toBe('Engine · account');
    expect(cardTitle(en, c)).toBe('No v2 account yet · 2 lanes waiting');
    expect(cardTitle(vi, c)).toBe('Chưa có account v2 · 2 lane đang chờ');
  });

  test('§6A G5-fix reasonText / cardBody: keyed (nested inner fills {detail}) in en; unknown key or none → the stored text', () => {
    const inner = { key: 'errors.start_init_timeout', params: { s: 60 } };
    expect(reasonText(en, 'không khởi động được: …', { key: 'errors.orchStart', inner })).toBe('could not start: claude sent no system/init within 60 s');
    expect(reasonText(en, 'API Error: 500', null)).toBe('API Error: 500');
    expect(reasonText(en, 'vi text', { key: 'errors.zzNew' })).toBe('vi text');
    expect(reasonText(en, 'vi text', { key: 'errors.orchStart', inner: { key: 'errors.zzNew' } })).toBe('vi text');
    expect(cardBody(en, { context: 'claude thoát (mã 1) khi chưa xong lượt', bodyKey: 'errors.exitCode', bodyParams: { code: 1 } })).toBe('claude exited (code 1) before the turn finished');
    expect(cardBody(en, { context: 'x', bodyKey: 'errors.orchStart', bodyInner: inner })).toBe('could not start: claude sent no system/init within 60 s');
  });

  test('§6A G5-fix install log last line by lineKey; old engine (no key) → the line', () => {
    const s = new Store(() => 1);
    s.apply({ type: 'event', event: { type: 'install_log', job: 'cc', line: 'Thất bại', lineKey: 'labels.installFailed', done: true, ok: false } });
    expect(installLast(en, s.get().installs.cc!)).toBe('Failed');
    expect(installLast(vi, s.get().installs.cc!)).toBe('Thất bại');
    expect(installLast(en, { lines: ['Xong'] })).toBe('Xong');
  });
});

describe('spec v2.1 §5.6 lazy UI language (lane v21-t10)', () => {
  test('§5.6 the inactive catalog is not in the first-paint graph: web code imports core.ts + vi.ts, en.ts only through import()', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    const files = walk(join(import.meta.dir, '../src')).filter(f => /\.tsx?$/.test(f));
    const statics = files.flatMap(f => [...readFileSync(f, 'utf8').matchAll(/^import [^;]*?from '([^']*shared\/i18n\/[^']*)'|^import '([^']*shared\/i18n\/[^']*)'/gm)].map(m => m[1] ?? m[2]));
    expect(statics.filter(s => /\/(index|en)\.ts$/.test(s!))).toEqual([]);
    expect(statics.some(s => s!.endsWith('/vi.ts'))).toBe(true);
  });
  test('§5.6 switching language keeps the shown one until the new catalog is in, then renders it', () => {
    const none = (l: string) => l === 'vi';
    expect(shownLang('en', 'vi', none)).toBe('vi');
    expect(shownLang('en', 'vi', () => true)).toBe('en');
    expect(shownLang('vi', 'en', none)).toBe('vi');
  });
});
