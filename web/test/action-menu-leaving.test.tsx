// v28-gate: a closing menu (`leaving`, the 140 ms fade after a pick) never takes the focus back. Measured on
// e2e v28-theme §5.4: after "Tối" the test focused the editor and the leaving menu's item re-took it 3 ms later (1/15).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

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

test('a leaving menu: hovering its item does not pull the focus off what took it after the pick', async () => {
  const { act, createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { ActionMenu } = await import('../src/ui/ActionMenu.tsx');
  const items = [
    { id: 'a', label: 'Sáng', g: 0, checked: true, act: { t: 'theme' as const, mode: 'light' as const } },
    { id: 'b', label: 'Tối', g: 0, checked: false, act: { t: 'theme' as const, mode: 'dark' as const } },
  ];
  const host = document.createElement('div'), input = document.createElement('input');
  document.body.append(host, input);
  const root = createRoot(host);
  const menu = (leaving: boolean) => createElement(ActionMenu, { items, label: 'Giao diện', anchor: { x: 10, y: 10, w: 20, h: 20 },
    area: { x: 0, y: 0, w: 1440, h: 900 }, leaving, onRun: () => {}, onClose: () => {} });
  await act(async () => { root.render(menu(false)); });
  const row = () => document.querySelectorAll<HTMLElement>('[role=menuitemradio]')[1]!;
  expect(document.activeElement?.textContent).toContain('Sáng'); // an open menu focuses its checked item
  await act(async () => { root.render(menu(true)); });
  input.focus();
  await act(async () => { row().dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body as never }) as unknown as Event); });
  expect(row().className).toContain('on'); // the hover still lands (the row is lit) …
  expect(document.activeElement).toBe(input); // … but the focus stays where it went
  await act(async () => { root.unmount(); });
  host.remove(); input.remove();
});
