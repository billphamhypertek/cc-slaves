// App shell fixes of the v1.1 review (fx2): §4.6 boot / no-project screens, F9 from the deck as the left panel,
// Esc order, body classes, 1024 × 640 console dock, toast region, "Chờ PO" naming, deck font weights.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Snapshot } from '../../shared/protocol.ts';
import { Store } from '../src/lib/store.ts';
import type { EngineClient } from '../src/lib/ws.ts';
import { bodyClasses, bootScreen, escapeStep, shellVars, toastVars, type EscState } from '../src/ui/shell.ts';
import { bannerShown } from '../src/ui/Screens.tsx';
import { ZERO_TOKENS as ZT } from '../../shared/protocol.ts';
import { ListView } from '../src/ui/ListView.tsx';
import { buildFlow } from '../src/deck/flow/model.ts';
import { HUD_SELECTORS } from '../src/deck/DeckView.tsx';
import { lane, snapshot } from './fixtures.ts';
import { NOW, scene } from './deck/scene.ts';
import { makeT } from '../../shared/i18n/index.ts';
const VI = makeT('vi');

const CSS = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const SHELL = readFileSync(new URL('../src/ui/shell.ts', import.meta.url), 'utf8');

// ---------- App rendered on the server (no DOM): only the first paint, which is what these screens decide ----------
async function renderApp(snap: Snapshot | null): Promise<string> {
  const g = globalThis as Record<string, unknown>;
  g.window ??= { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
  g.location ??= { search: '' };
  const { App } = await import('../src/ui/App.tsx');
  const store = new Store(() => NOW);
  if (snap) store.apply({ type: 'snapshot', snapshot: snap } as never);
  const el = <App store={store} client={{ send: () => Promise.resolve(null) } as unknown as EngineClient} />;
  // v2.7 review C IMPORTANT-2: the left column is a lazy chunk (with the deck); the first render starts it loading
  renderToStaticMarkup(el);
  await Promise.all([import('../src/ui/LeftColumn.tsx'), import('../src/deck/DeckView.tsx')]);
  await new Promise(r => setTimeout(r, 0));
  return renderToStaticMarkup(el);
}

describe('§4.6 screens in the App', () => {
  test('§4.6 "Đang khởi động" with a snapshot → the deck (orchestrator / lanes starting), not the v1 Boot screen', async () => {
    const s = snapshot({ engine: { ...snapshot().engine, startedAt: Date.now() } });
    s.orchestrators[0]!.state = 'starting';
    s.lanes = [lane('D2', { state: 'starting' })];
    const html = await renderApp(s);
    expect(html).not.toContain('class="boot"');
    expect(html).toContain('id="map"'); // the deck chunk's placeholder: DeckView takes this place once loaded
    expect(html).toContain('id="inspector"'); // §4.10 N4-c: Đang xem shows the boot skeleton, composer locked
  });
  test('§4.6 no snapshot yet → v1 Boot (no data to draw)', async () => {
    expect(await renderApp(null)).toContain('class="boot"');
    expect(bootScreen(null)).toBe(true);
    expect(bootScreen(snapshot())).toBe(false);
  });
  test('§4.6 F2 "Chưa có project": one empty state — no v1 centre panel; the deck hint + "＋ Thêm project" opens the dialog', async () => {
    const html = await renderApp(snapshot({ projects: [], orchestrators: [], lanes: [] }));
    expect(html).not.toContain('id="center"');
    expect(html).not.toContain('Chưa có project'); // that text belongs to the deck hint only (model screen no_project)
    const m = buildFlow({ tr: VI, snap: snapshot({ projects: [], orchestrators: [], lanes: [] }), projectId: null, subagents: {}, selected: null, now: NOW, live: false });
    expect(m.screen).toBe('no_project');
  });
});

describe('v2.1 §5.1 F9 = one full list (no side list, no zone / chip filter) + the §4.8 stats line', () => {
  const lv = (snap: Snapshot, selected: string | null = null) => renderToStaticMarkup(<ListView snap={snap} projectId="p1" selected={selected}
    onLane={() => {}} onMenu={() => {}} />);
  test('§4.8 N4-k F9 = one lane table LANE · VIỆC · TRẠNG THÁI · ACCOUNT · CHI PHÍ; no Chờ PO / Account board, no filter', () => {
    const html = lv(scene(30));
    expect(html).toContain('<div id="listview">');
    expect([...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map(m => m[1]).filter(Boolean)).toEqual(['Lane', 'Việc', 'Trạng thái', 'Account', 'Chi phí']);
    expect(html).not.toContain('class="board');
    expect(html).not.toContain('Bỏ lọc');
    expect(CSS).not.toContain('#listview.side');
    expect(SHELL).not.toMatch(/listMode|sideList|ListFilter/);
  });
  test('§4.8 N4-k rows: the project\'s lanes, Chờ PO / Hỏng first (R1 order), done lanes left to the deck\'s Xong group', () => {
    const other = scene(5);
    const snap = { ...other, lanes: [...other.lanes, lane('Z1', { projectId: 'p2' })] };
    const names = [...lv(snap).matchAll(/<tr class="lt-row[^"]*"[^>]*><td[^>]*>.*?<\/td><td class="nm">([^<]+)<\/td>/g)].map(m => m[1]);
    expect(names.slice(0, 2)).toEqual(['D15', 'R5']);
    expect(names).not.toContain('E4');
    expect(names).not.toContain('Z1');
    expect(names).toHaveLength(9);
  });
  test('§4.8 N4-k a waiting lane\'s VIỆC carries the blocking question; the selected lane row is marked; every row has "⋯"', () => {
    const html = lv(scene(5), 'D2');
    expect(html).toContain('giữ API cũ?');
    expect(html).toMatch(/<tr class="lt-row on"[^>]*><td[^>]*>.*?<\/td><td class="nm">D2</);
    expect((html.match(/aria-haspopup="menu"/g) ?? []).length).toBe(9);
  });
  test('§4.8 / v2.3 §4.1 the stats line is the shell\'s one header bar (HUD), not drawn in the list: money never disappears', async () => {
    expect(lv(scene(5))).not.toContain('role="status"');
    const html = await renderApp({ ...scene(5), stats: { at: NOW, tokens5h: ZT, projects: { p1: { tokensToday: { ...ZT, input: 4_200_000 }, costTodayUsd: 38.1 } } } });
    const hud = html.slice(html.indexOf('id="hud"'));
    expect(hud).toContain('class="dhead"');
    expect(hud).toContain('hôm nay 4,2M tok · ≈ $38,10');
  });
  const none: EscState = { palette: false, stopLane: false, moveAll: false, addOpen: false, settings: false, wizard: false, up: false, drawer: false };
  test('§4.11 Esc: modals first, then up one level, then the drawer', () => {
    expect(escapeStep({ ...none, up: true, addOpen: true })).toBe('addOpen');
    expect(escapeStep({ ...none, wizard: true, up: true })).toBe('wizard');
    expect(escapeStep({ ...none, drawer: true, up: true })).toBe('up');
    expect(escapeStep(none)).toBeNull();
  });
  test('§5.1 bodyClasses: no has-panel / no-console / no-inbox; narrow + drawer only below 1280 px', () => {
    const b = { narrow: false, drawer: true, offline: false, reduced: false };
    expect(bodyClasses(b)).toBe('');
    expect(bodyClasses({ ...b, narrow: true })).toBe('narrow drawer');
    expect(bodyClasses({ ...b, narrow: true, drawer: false, offline: true })).toBe('narrow offline');
  });
  test('v2.3 I2 C16 / G11 --bn = 36 px only while the v1 banner is drawn: offline on Deck / Code / Git with a project → 0 px', () => {
    const v = (o: Partial<Parameters<typeof bannerShown>[0]>) =>
      shellVars({ width: 1440, narrow: false, drawerOpen: false, leftCol: true, banner: bannerShown({ offline: true, listOn: false, projectId: 'p', late: false, ...o }) })['--bn'];
    expect(v({})).toBe('0px');
    expect(v({ offline: false, listOn: true })).toBe('0px');
    expect(v({ listOn: true })).toBe('36px');
    expect(v({ projectId: null })).toBe('36px');
    expect(v({ late: true })).toBe('36px');
    expect(shellVars({ width: 1440, narrow: false, drawerOpen: false, banner: false, leftCol: true })).toEqual({ '--deck-left': '424px', '--tl': '424px', '--bn': '0px' });
    // v2.7 §4.1 D88 Tasks has no left column: the toast centres on the full width
    expect(shellVars({ width: 1440, narrow: false, drawerOpen: false, banner: false, leftCol: false })['--tl']).toBe('0px');
  });
});

describe('§6 "Cột trái": tooltips and toasts never cover the left column', () => {
  const rule = (sel: string) => CSS.split('\n').find(l => l.startsWith(sel + '{')) ?? '';
  test('§4.13 N3-k the toast is centred on the visible graph (deck area minus the open account panel), under the deck header bar', () => {
    const t = rule('#toasts');
    expect(t).toContain('left:calc(var(--tl,0px) + (100vw - var(--tl,0px) - var(--accw,0px)) / 2)');
    expect(t).toContain('max-width:calc(100vw - var(--tl,0px) - var(--accw,0px) - 24px)');
    expect(t).toContain('transform:translateX(-50%)');
    expect(t).toContain('top:calc(var(--bn) + var(--h-bar) + var(--h-head) + var(--s4))'); // §6.7 D53 top bar + deck header + --s4 (UX-M9: inside the fit's toast band)
    expect(rule('#toasts .toast')).toContain('padding:var(--s2) var(--s4)');
    expect(HUD_SELECTORS as readonly string[]).not.toContain('#toasts');
  });
  test('§6 UX-M6 the toast entry slide starts under the deck header bar (never drawn on .dhead, even mid-animation)', () => {
    expect(rule('#toasts')).toContain('top:calc(var(--bn) + var(--h-bar) + var(--h-head) + var(--s4))'); // under the bars by --s4 (10 px since hot fix 2026-11-16)
    expect(CSS).toContain('--s4:10px;');
    expect(CSS).toContain('.toast{animation:mo-down ');
    const slide = Number(/@keyframes mo-down\{from\{[^}]*translateY\(-(\d+)px\)/.exec(CSS)![1]);
    expect(8).toBeGreaterThanOrEqual(slide);
  });
  test('§4.13 / §6 toast never covers the left column: narrow + open drawer → centred right of the 424 px drawer', () => {
    expect(toastVars(1440, false)).toEqual({ '--tl': '424px' });
    expect(toastVars(1440, true)).toEqual({ '--tl': '424px' });
    expect(toastVars(1024, false)).toEqual({ '--tl': '0px' });
    expect(toastVars(1024, true)).toEqual({ '--tl': '424px' });
  });
  test('§6 the deck tooltip avoids the whole left column (#left), not the v1 #inbox / #console boxes', () => {
    expect(HUD_SELECTORS as readonly string[]).toContain('#left');
    expect(HUD_SELECTORS as readonly string[]).not.toContain('#console');
  });
  test('§4.7 the deck tooltip avoids the open account panel too', () => {
    expect(HUD_SELECTORS as readonly string[]).toContain('.accp.open');
  });
});

describe('§4.11 Tab order: Chờ PO → Đang xem → roots / lanes / subs → account card / panel → viewport buttons', () => {
  test('§4.11 the left column (#inbox, #inspector) comes before the deck in the DOM', async () => {
    const html = await renderApp(snapshot());
    const at = (s: string) => { const i = html.indexOf(s); expect(i).toBeGreaterThan(-1); return i; };
    expect(at('id="inbox"')).toBeLessThan(at('id="inspector"'));
    expect(at('id="inspector"')).toBeLessThan(at('id="map"'));
  });
  test('§4.11 inside the deck: the account panel is a React Flow child placed before the viewport buttons (DeckViewport)', () => {
    const src = readFileSync(new URL('../src/deck/DeckView.tsx', import.meta.url), 'utf8');
    const flow = src.slice(src.indexOf('<ReactFlow '), src.indexOf('</ReactFlow>'));
    expect(flow.indexOf('{panel}')).toBeGreaterThan(-1);
    expect(flow.indexOf('{panel}')).toBeLessThan(flow.indexOf('<DeckViewport'));
  });
});

describe('UX-M3 one name: "Chờ PO"', () => {
  test('F9 lane state and inbox say "Chờ PO", never "Chờ anh"', () => {
    const html = renderToStaticMarkup(<ListView snap={scene(5)} projectId="p1" selected={null} onLane={() => {}} onMenu={() => {}} />);
    expect(html).toContain('Chờ PO');
    expect(html.toLowerCase()).not.toContain('chờ anh');
    expect(readFileSync(new URL('../src/ui/Inbox.tsx', import.meta.url), 'utf8')).not.toMatch(/chờ anh/i);
  });
});

describe('CR-M2 fonts', () => {
  test('JetBrains Mono 700 ships (latin, latin-ext, vietnamese) instead of a synthesized bold', () => {
    for (const s of ['latin', 'latin-ext', 'vietnamese']) {
      expect(CSS).toContain(`font-weight:700;font-display:swap;src:url(/fonts/jetbrains-mono-700-${s}.woff2)`);
      expect(Bun.file(new URL(`../public/fonts/jetbrains-mono-700-${s}.woff2`, import.meta.url).pathname).size).toBeGreaterThan(1000);
    }
  });
});

describe('§8.4 first paint stays light', () => {
  test('the HUD modules (App, actions, shell) never value-import the deck model / geometry (that is the lazy deck chunk)', () => {
    for (const f of ['../src/ui/App.tsx', '../src/deck/actions.ts', '../src/ui/shell.ts', '../src/ui/ListView.tsx']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      expect({ f, bad: src.match(/^import (?!type )[^;]*from '[./]*(deck\/)?(model|geom|DeckView)\.tsx?';/m)?.[0] ?? null }).toEqual({ f, bad: null });
    }
  });
});

describe('R24 (PO 16/11) the head bar spans the full width; the wide left column starts under it', () => {
  const rule = (sel: string) => CSS.split('\n').find(l => l.startsWith(sel + '{')) ?? '';
  test('R24 .dhead: left 0, 12 px padding-left (--s5) → Deck · Code · Git start at x 12, the left column\'s edge; §6.7 D53 heights', () => {
    const h = rule('.dhead');
    expect(h).toContain('left:0;');
    // hot fix 2026-11-16 --s5 = 14 px: the left padding stays 12 px (--s5 − --s1), the left column's edge
    expect(h).toContain('padding:0 var(--s5) 0 calc(var(--s5) - var(--s1))');
    expect(CSS).toContain('--s5:14px;');
    expect(CSS).toContain('--s1:2px;');
    expect(CSS).toContain('#left{position:fixed;left:12px;');
    expect(h).toContain('top:calc(var(--bn) + var(--h-bar))');
    expect(h).toContain('height:var(--h-head)');
    expect(/#left\{[^}]*left:12px/.test(CSS)).toBe(true);
  });
  test('R24 + §6.7 D53 wide #left top = top bar + head bar + --s4 (mockup .lcol); the narrow drawer keeps its place under the top bar', () => {
    expect(rule('#left')).toContain('top:calc(var(--bn) + var(--h-bar) + var(--h-head) + var(--s4))');
    expect(rule('body.narrow #left')).toContain('top:calc(var(--bn) + var(--h-bar))');
  });
});

describe('UX-I6 N2-a the Subagent head stays on screen in a tall lane info block', () => {
  const rule = (sel: string) => CSS.split('\n').find(l => l.startsWith(sel + '{')) ?? '';
  test('UX-I6 the head sticks to the bottom of the scrolling .iinfo: .subsec makes no box, so the head\'s containing block is the whole lane head', () => {
    expect(rule('#inspector .iinfo')).toContain('overflow-y:auto');
    expect(rule('#inspector .subsec')).toContain('display:contents');
    const h = rule('#inspector .subsec .log-h');
    for (const d of ['position:sticky', 'bottom:0', 'background:var(--solid)', 'border-top:1px solid var(--line)']) expect(h).toContain(d);
  });
});

describe('R-I1 toasts stack above every modal and sheet', () => {
  const z = (sel: string) => Number(/z-index:(\d+)/.exec(CSS.split('\n').find(l => l.startsWith(sel + '{')) ?? '')?.[1] ?? NaN);
  test('R-I1 #toasts z-index > #modal (Skills & MCP sheet), #accmodal, .amenu-layer, #screen, #reloadBand, #banner; < the session list popover', () => {
    const SL = readFileSync(new URL('../src/ui/sessions.css', import.meta.url), 'utf8');
    for (const sel of ['#modal', '#accmodal', '.amenu-layer', '#screen', '#reloadBand', '#banner']) expect(z('#toasts')).toBeGreaterThan(z(sel));
    expect(z('#toasts')).toBeLessThan(Number(/\.slist-back\{[^}]*z-index:(\d+)/.exec(SL)![1]));
    expect(CSS).toMatch(/#toasts\{[^}]*pointer-events:none/);
  });
});
