// Tauri bridge (optional): the web UI also runs in a plain browser (dev, phone) where none of this exists.
import type { ThemeWindow } from './theme.ts';
interface TauriGlobal {
  core?: { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };
  invoke?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  event?: { listen<T>(name: string, cb: (e: { payload: T }) => void): Promise<() => void> };
  /** v2.4 R6 activate the window after a Finder drop (`core:window:allow-set-focus`); v2.8 §7.2 the window theme
   *  (`core:window:allow-set-theme`, `null` = follow macOS) and the macOS theme event (lib/theme.ts). */
  window?: { getCurrentWindow(): { setFocus(): Promise<void> } & ThemeWindow };
}
export type { TauriGlobal };
export const tauriGlobal = (): TauriGlobal | null => g();
const g = (): TauriGlobal | null => (typeof window === 'undefined' ? null : ((window as { __TAURI__?: TauriGlobal }).__TAURI__ ?? null));
export const hasTauri = () => g() !== null;

/** Run a Tauri command; `undefined` when not inside the Mac app. */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | undefined> {
  const t = g();
  const fn = t?.core?.invoke ?? t?.invoke;
  return fn ? fn<T>(cmd, args) : undefined;
}
