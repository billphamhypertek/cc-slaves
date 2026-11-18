import { createRoot } from 'react-dom/client';
import './styles.css';
import { Store } from './lib/store.ts';
import { shownLang } from './lib/i18n.tsx';
import { beep, chimeFor } from './lib/chime.ts';
import { installBridge, installPresence, type Bridge } from './lib/native.ts';
import { install as installScrollbars } from './lib/scrollbars.ts';
import { setToastSink } from './lib/toast-bus.ts';
import { invoke, tauriGlobal } from './lib/tauri.ts';
import { installTheme, THEME_KEY } from './lib/theme.ts';
import { ls, lsSet } from './ui/appEnv.ts';
import { EngineClient, wsUrl } from './lib/ws.ts';
import { App } from './ui/App.tsx';

// v2.8 §5 before the first render: /theme-boot.js already set data-theme; this keeps it, the window and macOS in step
installTheme({ read: () => ls(THEME_KEY), write: v => lsSet(THEME_KEY, v), media: matchMedia('(prefers-color-scheme: dark)'),
  root: document.documentElement, win: tauriGlobal()?.window?.getCurrentWindow() ?? null });
const store = new Store();
setToastSink((level, text) => store.toast(level, text), () => shownLang(store.lang(), 'vi'));
let url = wsUrl(location, (window as { __CC_TOKEN__?: string }).__CC_TOKEN__);
// dev only: pick a mock-engine scenario with ?f=F4 (web/dev/mock-engine.ts)
const f = new URLSearchParams(location.search).get('f');
if (import.meta.env.DEV && f) url += (url.includes('?') ? '&' : '?') + 'f=' + encodeURIComponent(f);
if (import.meta.env.DEV && new URLSearchParams(location.search).get('remote')) url += (url.includes('?') ? '&' : '?') + 'remote=1';
// dev only: ?lang=en → the mock engine's config.ui.lang (e2e v21-shots `-en` frames)
if (import.meta.env.DEV && new URLSearchParams(location.search).get('lang') === 'en') url += (url.includes('?') ? '&' : '?') + 'lang=en';
// dev only: ?cards=n → the mock engine's frame with n Chờ PO cards (e2e v21-leftcol m-2)
const cards = new URLSearchParams(location.search).get('cards');
// dev only: ?g=G6 → the mock engine's Git view scene (web/dev/mock-git.ts)
const g = new URLSearchParams(location.search).get('g');
if (import.meta.env.DEV && g) url += (url.includes('?') ? '&' : '?') + 'g=' + encodeURIComponent(g);
if (import.meta.env.DEV && cards) url += (url.includes('?') ? '&' : '?') + 'cards=' + encodeURIComponent(cards);
// dev only: ?md=MD4 → the mock engine's v2.4 model scene (web/dev/mock-model.ts)
const md = new URLSearchParams(location.search).get('md');
if (import.meta.env.DEV && md) url += (url.includes('?') ? '&' : '?') + 'md=' + encodeURIComponent(md);
// dev only: ?gs=license → the mock engine's hf1116 (b) Git block state (web/dev/scenarios.ts GIT_SETUP)
const gs = new URLSearchParams(location.search).get('gs');
if (import.meta.env.DEV && gs) url += (url.includes('?') ? '&' : '?') + 'gs=' + encodeURIComponent(gs);

let bridge: Bridge | null = null;
let presence: { onOpen(): void } | null = null;
const client = new EngineClient({
  url,
  onMessage: m => {
    store.apply(m); bridge?.onMessage(m);
    const gain = chimeFor(m, store.get().snap?.config, ls('ccs.muted') === '1');
    if (gain !== null) beep(gain);
  },
  onStatus: c => {
    store.setConn(c);
    if (c.status === 'reconnecting') bridge?.onReconnecting();
    if (c.status === 'open') presence?.onOpen(); // R10 (I5): a new connection starts "not present"
  },
});
bridge = installBridge({
  tauri: tauriGlobal(), invoke, win: window,
  setToken: token => client.setUrl(wsUrl(location, token ?? undefined)), retryNow: () => client.retryNow(),
});
presence = installPresence({ win: window, doc: document, send: visible => { void client.send({ cmd: 'presence', visible }).catch(() => {}); } });
// v2.2 §14.5 a hidden tab stops the text pacing loop; back → the backlog shows at once
// v2.3 §10.2 (M3) and the Git view's `git_watch` / reads; a window opened hidden starts hidden
document.addEventListener('visibilitychange', () => store.setTabHidden(document.hidden));
store.setTabHidden(document.hidden);
installScrollbars(document); // v2.4 §6.8 D54 the bar lights while the user scrolls a box
client.connect();
createRoot(document.getElementById('root')!).render(<App store={store} client={client} />);
