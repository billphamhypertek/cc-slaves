// v2.5 fix wave (v25-review-w) in a DOM: I-3 a TK2 row's "Cài" / "Cập nhật" is disabled and spins at once, before the engine's
// `running` view arrives; M-2 the GR-upd / GR-clean primary is disabled while the engine is lost.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { ReactElement } from 'react';
import '../../shared/i18n/index.ts';
import type { GraphToolView } from '../../shared/graph.ts';
import type { Command } from '../../shared/protocol.ts';
import type { ToolkitRow, ToolkitView } from '../../shared/toolkit.ts';
import { GraphCleanDialog, GraphUpdateDialog } from '../src/ui/GraphDialogs.tsx';
import { ToolkitTab } from '../src/ui/Toolkit.tsx';

const G = globalThis as Record<string, unknown>;
const win = new Window({ url: 'http://localhost/', width: 1440, height: 900 });
const WIN = win as unknown as Record<string, unknown>;
const KEYS = [...new Set(['window', 'document', 'navigator', 'location', 'localStorage', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent',
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
let live: (() => Promise<void>) | null = null;
afterEach(async () => { if (live) await live(); live = null; document.body.innerHTML = ''; });

async function mount(el: ReactElement) {
  const { act, createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { LangProvider } = await import('../src/lib/i18n.tsx');
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(LangProvider, { lang: 'vi', children: el })); await new Promise(r => setTimeout(r, 10)); });
  live = () => act(async () => { root.unmount(); host.remove(); });
  return { act, q: (s: string) => document.querySelector<HTMLButtonElement>(s) };
}

/** A `send` whose commands stay pending until `settle()`; `toolkit_check` / the dialog asks answer at once. */
function pendingSend(answers: Partial<Record<Command['cmd'], unknown>> = {}) {
  const sent: Command[] = [];
  let settle = () => {};
  const send = (c: Command): Promise<unknown> => {
    sent.push(c);
    if (c.cmd in answers || c.cmd === 'toolkit_check') return Promise.resolve(answers[c.cmd]);
    return new Promise(r => { settle = () => r(undefined); });
  };
  return { sent, send, settle: () => settle() };
}

const r = (key: ToolkitRow['key'], over: Partial<ToolkitRow> = {}): ToolkitRow => ({ key, kind: 'plugin', id: `${key}@claude-plugins-official`, state: 'installed', version: '1.0.0', mcpLoginIds: [], ...over });
const VIEW: ToolkitView = { rows: [r('superpowers', { state: 'outdated' }), r('ui-ux-pro-max', { state: 'missing', version: undefined })], checkedAt: 1 };

describe('I-3 TK2 row: local pending spinner', () => {
  for (const [key, label, cmd] of [['ui-ux-pro-max', 'Cài', 'toolkit_install'], ['superpowers', 'Cập nhật', 'toolkit_update']] as const) {
    test(`"${label}" → disabled + .spin at once, one ${cmd}; back to the icon when the ack lands`, async () => {
      const s = pendingSend();
      const m = await mount(<ToolkitTab view={VIEW} mcp={null} connected send={s.send} toast={() => {}} onLogin={() => {}} onGraph={() => {}} onGraphUpdate={() => {}} />);
      const btn = () => m.q(`.tkr[data-key="${key}"] .tka .btn`)!;
      expect(btn().textContent).toContain(label);
      expect(btn().querySelector('.spin')).toBeNull();
      await m.act(async () => { btn().click(); });
      expect(btn().disabled).toBe(true);
      expect(btn().querySelector('.spin.sm')).not.toBeNull();
      await m.act(async () => { btn().click(); }); // a second press does nothing
      expect(s.sent.filter(c => c.cmd === cmd)).toHaveLength(1);
      await m.act(async () => { s.settle(); await new Promise(res => setTimeout(res, 5)); });
      expect(btn().disabled).toBe(false);
      expect(btn().querySelector('.spin')).toBeNull();
    });
  }
});

describe('M-2 GR-upd / GR-clean: primary disabled when the engine is lost', () => {
  const tool = { state: 'old', version: '0.8.1', latest: '0.12.1' } as GraphToolView;
  const answers = {
    graph_impact: { indexes: { n: 1, bytes: 1 }, lanesRunning: 0, processes: { lanes: 0, sessions: 0, other: 0 } },
    graph_orphans: { rows: [{ root_path: '/x', bytes: 1 }], bytes: 1, kept: 0, skipped: { n: 0 } },
  };
  for (const connected of [true, false]) {
    test(`connected=${connected}: GR-upd "Cập nhật" and GR-clean "Dọn" ${connected ? 'enabled' : 'disabled'}`, async () => {
      const s = pendingSend(answers);
      await mount(<><GraphUpdateDialog tool={tool} connected={connected} send={s.send} onClose={() => {}} /><GraphCleanDialog connected={connected} send={s.send} onClose={() => {}} /></>);
      const [upd, clean] = [...document.querySelectorAll<HTMLButtonElement>('.grd .mf .btn:last-child')];
      expect(upd!.textContent).toContain('Cập nhật');
      expect(clean!.textContent).toContain('Dọn');
      expect(upd!.disabled).toBe(!connected);
      expect(clean!.disabled).toBe(!connected);
    });
  }
});
