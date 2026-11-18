// Mac app bridge (Tauri shell, src-tauri/src/lib.rs): native notifications (§8.3), the S5 focus fallback
// (`open_latest_card`), window hidden → free the 3D scene (§8.4), F10 engine restart with a fresh token (§7.1), v2.4 §6.1
// the native file drop.
// Every part is a no-op in a plain browser (dev, phone).
import type { ServerMsg } from '../../../shared/protocol.ts';
import type { TauriGlobal } from './tauri.ts';

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T | undefined>;

/** v2.1 §4.15 §4 where a notification click leads (notify.rs remembers the latest one and emits it on focus). */
export interface NotifyTarget { cardId: number | null; projectId: string | null; lane: string | null }

/** §8.3: an engine `notify` with `mac: true` becomes a macOS notification (the engine already applied R10); §4.15 §4 with
 *  its target. */
export function notifyArgs(m: ServerMsg): { title: string; body: string; cardId: number | null; projectId?: string; lane?: string } | null {
  if (m.type !== 'event' || m.event.type !== 'notify' || !m.event.mac) return null;
  const e = m.event;
  return { title: e.title, body: e.body, cardId: e.cardId ?? null, ...(e.projectId ? { projectId: e.projectId } : {}), ...(e.lane ? { lane: e.lane } : {}) };
}

export interface BridgeDeps {
  tauri: TauriGlobal | null;
  invoke: Invoke;
  win: Pick<Window, 'dispatchEvent'> & { __CC_RESTART_ENGINE__?: () => void };
  /** Point the WS client at a URL carrying this token (used from the next attempt on). */
  setToken: (token: string | null) => void;
  /** Skip the remaining backoff. */
  retryNow: () => void;
}

export interface Bridge {
  /** Feed every server message (forwards notify events). */
  onMessage(m: ServerMsg): void;
  /** WS dropped: re-read the token (an engine restart makes a new one) before the next attempt. */
  onReconnecting(): void;
}

export function installBridge(d: BridgeDeps): Bridge {
  if (!d.tauri) return { onMessage() {}, onReconnecting() {} };
  const ev = d.tauri.event;
  void ev?.listen<{ visible: boolean }>('window_state', e => {
    d.win.dispatchEvent(new Event(e.payload.visible ? 'window-shown' : 'window-hidden'));
  });
  void ev?.listen<Partial<NotifyTarget> | null>('open_latest_card', e => {
    const t: NotifyTarget = { cardId: e.payload?.cardId ?? null, projectId: e.payload?.projectId ?? null, lane: e.payload?.lane ?? null };
    d.win.dispatchEvent(new CustomEvent('ccs:open-card', { detail: t }));
  });
  const fresh = () => d.invoke<string | null>('engine_token').then(t => { if (t) d.setToken(t); d.retryNow(); }).catch(() => {});
  d.win.__CC_RESTART_ENGINE__ = () => { void d.invoke('engine_restart').catch(() => {}).then(fresh); };
  let refreshing = false;
  return {
    onMessage(m) {
      const n = notifyArgs(m);
      if (n) void d.invoke('notify', n).catch(() => {});
    },
    onReconnecting() {
      if (refreshing) return;
      refreshing = true;
      void d.invoke<string | null>('engine_token').then(t => { if (t) d.setToken(t); }).catch(() => {}).finally(() => { refreshing = false; });
    },
  };
}

export interface PresenceDeps {
  win: Pick<EventTarget, 'addEventListener'>;
  doc: Pick<EventTarget, 'addEventListener'> & { readonly visibilityState: DocumentVisibilityState };
  send: (visible: boolean) => void;
}

/**
 * R10 / §8.1 (I5): tell the engine whether the PO can see the app. The Tauri window only hides on close (the WS stays
 * open), so `window-hidden` / `window-shown` from the bridge count, and so does a hidden browser tab. Sends on change;
 * `onOpen` re-sends after every (re)connect (a new connection starts "not present").
 */
export function installPresence(d: PresenceDeps): { onOpen(): void } {
  let appHidden = false;
  const visible = () => !appHidden && d.doc.visibilityState !== 'hidden';
  let last = visible();
  const changed = () => { const v = visible(); if (v !== last) { last = v; d.send(v); } };
  d.win.addEventListener('window-hidden', () => { appHidden = true; changed(); });
  d.win.addEventListener('window-shown', () => { appHidden = false; changed(); });
  d.doc.addEventListener('visibilitychange', changed);
  return { onOpen() { last = visible(); d.send(last); } };
}

export interface DropHandlers { enter(): void; leave(): void; drop(paths: string[]): void }
/** tauri#14134: a macOS drop may fire twice; the same path list within this window is one drop. */
export const DROP_DEDUPE_MS = 300;

/**
 * v2.4 §6.1 / NC §8-20 the native drop (Tauri turns DOM drops off, so this is the only way to get real paths;
 * `core:event:allow-listen`). R6 / NC §8-21: Finder is the active app while dragging, so after a drop the window is
 * activated (`setFocus`, `core:window:allow-set-focus`) before the composer takes the caret. `null` in a plain browser.
 */
export function tauriDrop(tauri: TauriGlobal | null, now: () => number = Date.now): ((h: DropHandlers) => () => void) | null {
  const ev = tauri?.event;
  if (!ev) return null;
  return h => {
    let last = { key: '', at: -Infinity }, live = true;
    const offs: Promise<() => void>[] = [
      ev.listen<{ paths?: string[] }>('tauri://drag-enter', () => h.enter()),
      ev.listen<null>('tauri://drag-leave', () => h.leave()),
      ev.listen<{ paths?: string[] }>('tauri://drag-drop', e => {
        const paths = e.payload?.paths ?? [], key = paths.join('\n'), t = now();
        if (!paths.length) return h.leave();
        if (key === last.key && t - last.at < DROP_DEDUPE_MS) return;
        last = { key, at: t };
        void tauri.window?.getCurrentWindow().setFocus().catch(() => {});
        h.drop(paths);
      }),
    ];
    return () => { if (!live) return; live = false; for (const o of offs) void o.then(f => f()).catch(() => {}); };
  };
}
