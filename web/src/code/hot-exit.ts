// spec v2.3 §5.4 / §10.1 hot exit (C29): the unsaved buffer of each tab is kept in IndexedDB under (project, source, path),
// a short beat after each change and at once on `pagehide` (quitting / reloading never asks). Deleted when saved, on
// "Bỏ thay đổi" / "Bỏ", and with its source when the source is dropped at restore.
import type { Eol } from '../../../shared/protocol.ts';
import { isObj } from '../../../shared/json.ts';
import type { Kv } from '../lib/idb.ts';

/** `line` = the cursor line (1-based); `savedAt` = when it was kept (the "Thay đổi chưa lưu từ lần trước · 14:22" band). */
export interface HotBuf { text: string; baseHash: string; eol: Eol; bom: boolean; line: number; savedAt: number }
interface Timers { set: (fn: () => void, ms: number) => number; clear: (id: number) => void }
const realTimers: Timers = { set: (fn, ms) => window.setTimeout(fn, ms), clear: id => window.clearTimeout(id) };

const srcPrefix = (pid: string, src: string) => `code\n${pid}\n${src}\n`;
const isBuf = (v: unknown): v is HotBuf => isObj(v) && typeof v.text === 'string' && typeof v.baseHash === 'string'
  && (v.eol === 'lf' || v.eol === 'crlf') && typeof v.bom === 'boolean' && typeof v.line === 'number' && typeof v.savedAt === 'number';

export class HotExit {
  private pending = new Map<string, { id: number; buf: HotBuf }>();
  constructor(private kv: Kv, private timers: Timers = realTimers, private delay = 400) {}

  queue(pid: string, src: string, path: string, buf: HotBuf): void {
    const k = srcPrefix(pid, src) + path, old = this.pending.get(k);
    if (old) this.timers.clear(old.id);
    const id = this.timers.set(() => { this.pending.delete(k); void this.kv.put(k, buf); }, this.delay);
    this.pending.set(k, { id, buf });
  }
  /** `pagehide`: write everything pending now */
  flush(): void {
    for (const [k, p] of this.pending) { this.timers.clear(p.id); void this.kv.put(k, p.buf); }
    this.pending.clear();
  }
  drop(pid: string, src: string, path: string): void {
    const k = srcPrefix(pid, src) + path, p = this.pending.get(k);
    if (p) { this.timers.clear(p.id); this.pending.delete(k); }
    void this.kv.del(k);
  }
  async load(pid: string, src: string): Promise<Map<string, HotBuf>> {
    const pre = srcPrefix(pid, src), out = new Map<string, HotBuf>();
    for (const k of await this.kv.keys(pre)) {
      const v = await this.kv.get(k);
      if (isBuf(v)) out.set(k.slice(pre.length), v);
    }
    return out;
  }
  async dropSrc(pid: string, src: string): Promise<void> {
    const pre = srcPrefix(pid, src);
    for (const [k, p] of this.pending) if (k.startsWith(pre)) { this.timers.clear(p.id); this.pending.delete(k); }
    for (const k of await this.kv.keys(pre)) await this.kv.del(k);
  }
}
