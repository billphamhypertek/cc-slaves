// v2.7.1 UX review MINOR-4 (AC4): the row tooltip goes away when the row's ⋯ menu opens, so the menu is the only overlay.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { account, snapshot } from '../fixtures.ts';

const G = globalThis as Record<string, unknown>;
const win = new Window({ url: 'http://localhost/', width: 1440, height: 900 });
const WIN = win as unknown as Record<string, unknown>;
const KEYS = [...new Set(['window', 'document', 'navigator', 'location', 'Event', 'MouseEvent',
  ...Object.getOwnPropertyNames(win).filter(k => !(k in globalThis) && !k.startsWith('_'))])];
const saved = new Map<string, unknown>();
beforeAll(() => {
  for (const k of [...KEYS, 'IS_REACT_ACT_ENVIRONMENT']) saved.set(k, G[k]);
  for (const k of KEYS) G[k] = k === 'window' ? win : WIN[k];
  G.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(async () => {
  for (const [k, v] of saved) { if (v === undefined) delete G[k]; else G[k] = v; }
  await win.happyDOM.close();
});

test('UX MINOR-4 hover a row → its tooltip; click ⋯ → the menu opens and the tooltip is gone', async () => {
  const { act, createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { LangProvider } = await import('../../src/lib/i18n.tsx');
  const { AccountPanel } = await import('../../src/deck/AccountPanel.tsx');
  const s = snapshot({ accounts: [account('pm@example.net', { headroomPct: 70, weekPct: 30, fetchedAt: Date.now() })], lanes: [] });
  const menus: string[] = [];
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(LangProvider, { lang: 'vi', children: null }, createElement(AccountPanel, {
      snap: s, projectId: 'p1', now: Date.now(), open: true, onToggle: () => {}, onAdd: () => {}, onRelogin: () => {}, onCfg: () => {},
      onSelectAccount: () => {}, onMenu: (e: string) => { menus.push(e); }, onCancelLogin: () => {}, hoverEmail: null, onHover: () => {}, initialReadyOpen: true,
    })));
  });
  const row = document.querySelector('.acrow[data-email="pm@example.net"]')!;
  await act(async () => { row.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body as never }) as unknown as Event); });
  expect(document.querySelector('.accp-tip')?.textContent).toContain('pm@example.net');
  await act(async () => { document.querySelector<HTMLButtonElement>('.acrow .amore')!.click(); });
  expect(menus).toEqual(['pm@example.net']);
  expect(document.querySelector('.accp-tip')).toBeNull();
  await act(async () => { root.unmount(); });
  host.remove();
});
