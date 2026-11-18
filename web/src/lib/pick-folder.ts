// The macOS "Choose folder" panel (hot fix 2026-11-17). In the Mac app the app itself opens it (`pick_folder`, already
// frontmost: instant); the engine's osascript panel must first `activate` a background process, measured 2.1 s before
// anything showed — it stays for the plain browser on this Mac (dev). `null` = the PO cancelled.
import type { Command } from '../../../shared/protocol.ts';
import { invoke } from './tauri.ts';

export async function pickFolder(send: (c: Command) => Promise<unknown>, message: string): Promise<string | null> {
  const native = await invoke<string | null>('pick_folder', { message });
  if (native !== undefined) return native;
  return ((await send({ cmd: 'folder_pick' })) as { path: string | null }).path;
}
