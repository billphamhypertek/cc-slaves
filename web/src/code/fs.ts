// spec v2.3 §10.2 the Code reads / writes through the engine (Mac only): `fs_list` (one dir), `fs_find` (⌘P), `fs_read`
// (one file), `fs_write` (§5.3 Lưu).
// The web only ever sends root-relative paths; the engine checks the root. §5.1 "Hiện file bị bỏ qua" is remembered per
// project in localStorage.
import type { FsFindReq, FsFindResult, FsListReq, FsListResult, FsReadReq, FsReadResult, FsWriteReq, FsWriteResult, Src } from '../../../shared/protocol.ts';
import { isObj } from '../../../shared/json.ts';
import type { CodeSrc } from './src.ts';

export type FsCmd = FsListReq | FsFindReq | FsReadReq | FsWriteReq;
export type FsSend = (c: FsCmd) => Promise<unknown>;

export interface FsApi {
  list: (dir: string) => Promise<FsListResult>;
  find: (query: string) => Promise<FsFindResult>;
  read: (path: string) => Promise<FsReadResult>;
  write: (q: Omit<FsWriteReq, 'cmd' | 'projectId' | 'src'>) => Promise<FsWriteResult>;
}

/** the wire `Src` of a Code source */
export const wireSrc = (s: Pick<CodeSrc, 'lane'>): Src => (s.lane === null ? { kind: 'base' } : { kind: 'lane', laneId: s.lane });
/** `base` / `lane:<name>`: the key of a source (tree memory, tab sets, hot exit) */
export const srcKey = (s: Pick<CodeSrc, 'lane'>): string => (s.lane === null ? 'base' : `lane:${s.lane}`);
/** the wire `Src` of a source key */
export const keySrc = (k: string): Src => (k.startsWith('lane:') ? { kind: 'lane', laneId: k.slice(5) } : { kind: 'base' });
/** the source key of a wire `Src` (`code_changed`) */
export const srcKeyOf = (s: Src): string => (s.kind === 'lane' ? `lane:${s.laneId}` : 'base');

export function fsApi(send: FsSend, projectId: string, src: Src, showIgnored: boolean): FsApi {
  return {
    list: dir => send({ cmd: 'fs_list', projectId, src, dir, showIgnored }) as Promise<FsListResult>,
    find: query => send({ cmd: 'fs_find', projectId, src, query, showIgnored }) as Promise<FsFindResult>,
    read: path => send({ cmd: 'fs_read', projectId, src, path }) as Promise<FsReadResult>,
    write: q => send({ cmd: 'fs_write', projectId, src, ...q }) as Promise<FsWriteResult>,
  };
}

type KeyStore = Pick<Storage, 'getItem' | 'setItem'>;
const IGN_KEY = 'ccs.code.showIgnored';
const readIgn = (ks: KeyStore | null): Record<string, boolean> => {
  try { const v: unknown = JSON.parse(ks?.getItem(IGN_KEY) ?? '{}'); return isObj(v) ? v as Record<string, boolean> : {}; } catch { return {}; }
};
/** §5.1 default off */
export const showIgnoredOf = (pid: string, ks: KeyStore | null = globalThis.localStorage ?? null): boolean => readIgn(ks)[pid] === true;
export function setShowIgnored(pid: string, on: boolean, ks: KeyStore | null = globalThis.localStorage ?? null): void {
  const all = readIgn(ks);
  if (on) all[pid] = true; else delete all[pid];
  try { ks?.setItem(IGN_KEY, JSON.stringify(all)); } catch { /* storage full / blocked: the toggle still works this session */ }
}
