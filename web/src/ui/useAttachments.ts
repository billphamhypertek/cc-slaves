// v2.4 §6.1–§6.3 the composer's attachments, first-paint half: the send gate (§6.2 / §6.3 / §6.6) and the hook that loads
// the chip store (lib/attach-store.ts, its own chunk) with the first paste / drop and follows its state.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Key } from '../lib/i18n.tsx';
import { CommandError } from '../lib/ws.ts';
import type { Att, AttachEnv, Attachments, AttachState, SendItem } from '../lib/attach-store.ts';

/** §6.2 / §6.3 why send is locked by the chips (`why` = the send button's tip, `line` = the red line over the frame), or the items to send. */
export function sendGate(text: string, items: readonly Att[]): { ok: true; items: SendItem[] } | { ok: false; why: Key; line?: Key; params?: Record<string, string> } {
  if (!items.length) return { ok: true, items: [] };
  const cmd = /^\s*(\/\S*)/.exec(text)?.[1];
  if (cmd) return { ok: false, why: 'attach.lock.slash', line: 'attach.slashNo', params: { cmd } }; // §6.6 DK14 tip + the red line
  if (items.some(a => a.st === 'bad')) return { ok: false, why: 'attach.lock.bad' };
  if (items.some(a => a.st === 'fail')) return { ok: false, why: 'attach.lock.fail' };
  if (items.some(a => a.st === 'busy')) return { ok: false, why: 'attach.lock.busy' };
  return { ok: true, items: items.map(a => (a.up ? { up: a.up } : { path: a.path! })) };
}

/** R21 §6.4 the item a failed `send` names (engine `errors.attachBad` + `index`, attach/store.ts `take`), else null. */
export function attachBadIndex(e: unknown): number | null {
  return e instanceof CommandError && e.key === 'errors.attachBad' && typeof e.params?.index === 'number' ? e.params.index : null;
}

const EMPTY: AttachState = { items: [], dropped: 0 };
const none = () => () => {};
const empty = () => EMPTY;

type StoreModule = { Attachments: new (env: AttachEnv) => Attachments };
/** The chip store loaded on first use (`run`); `dispose` (unmount) disposes it, also when it lands after the call. */
export function attachLoader(load: () => Promise<StoreModule>, env: () => AttachEnv, onLoad: (a: Attachments) => void): { run: (f: (a: Attachments) => void) => void; dispose: () => void } {
  let p: Promise<Attachments> | null = null;
  return {
    run: f => { p ??= load().then(m => { const a = new m.Attachments(env()); onLoad(a); return a; }); void p.then(f); },
    dispose: () => { void p?.then(a => a.dispose()); },
  };
}

/** One chip store per composer mount (blob URLs revoked, unsent copies deleted on unmount). */
export function useAttachments(env: () => AttachEnv): { state: AttachState; run: (f: (a: Attachments) => void) => void } {
  const [att, setAtt] = useState<Attachments | null>(null);
  const mk = useRef(env);
  mk.current = env;
  const [ld] = useState(() => attachLoader(() => import('../lib/attach-store.ts'), () => mk.current(), setAtt));
  useEffect(() => () => ld.dispose(), [ld]);
  const state = useSyncExternalStore(att?.subscribe ?? none, att?.get ?? empty, att?.get ?? empty);
  return { state, run: ld.run };
}
