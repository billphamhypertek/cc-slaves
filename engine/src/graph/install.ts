// v2.5 §5.6 installing / updating the graph tool, always to the latest release (D67) but with the script and the download
// of one run pinned to the same tag: the tag comes from the `releases/latest` redirect (§3-15, read, never followed), the
// script from `<raw>/<tag>/install.sh`, the download from env CBM_DOWNLOAD_URL=`<download>/<tag>` (the tag script checks the
// tarball digest itself). Run as `bash <file> --skip-config --dir <dir>`: the dir is its own argument, never spliced into a
// command string; `--skip-config` always (N8: cc-slaves puts the graph into lanes itself, §5.7). Never `curl | bash`.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Env } from '../session/env.ts';
import type { RunEnd } from './queue.ts';

export interface GraphUrls { latest: string; raw: string; download: string }
const REPO = 'DeusData/codebase-memory-mcp';
const GRAPH_URLS: GraphUrls = {
  latest: `https://github.com/${REPO}/releases/latest`,
  raw: `https://raw.githubusercontent.com/${REPO}`,
  download: `https://github.com/${REPO}/releases/download`,
};
/** Only a plain release tag ever reaches a URL or a command. */
const TAG = /^v\d+\.\d+\.\d+$/;
/** §5.6 dòng a: the installer's limit. */
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;
const TIMEOUT_LINE = 'hết giờ';
const STOPPED_LINE = 'đã dừng';
/** SIGTERM to the group, SIGKILL after this (the pattern of setup/gh-login.ts). */
const GRACE_MS = 2_000;

/** §5.3 "không kiểm được": `offline` = no network, `unknown` = an answer that is not the expected redirect. */
export class CheckError extends Error {
  override name = 'CheckError';
  constructor(readonly code: 'offline' | 'unknown', line: string) { super(line); }
}

/** §3-15 the latest tag (`vX.Y.Z`) from the redirect of `releases/latest`. */
export async function latestTag(urls: GraphUrls = GRAPH_URLS): Promise<string> {
  let r: Response;
  try {
    r = await fetch(urls.latest, { redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    throw new CheckError('offline', e instanceof Error ? e.message : String(e));
  }
  const tag = /\/releases\/tag\/([^/?#]+)$/.exec(r.headers.get('location') ?? '')?.[1] ?? '';
  if (r.status < 300 || r.status >= 400 || !TAG.test(tag)) throw new CheckError('unknown', `releases/latest: HTTP ${r.status} ${tag}`.trim());
  return tag;
}

/** §5.6 the one-line equivalent the UI shows ("Sẽ chạy:"); `dir` null = a new install in `$HOME/.local/bin`. */
export function installLine(tag: string, dir: string | null, urls: GraphUrls = GRAPH_URLS): string {
  return `curl -fsSL ${urls.raw}/${tag}/install.sh | CBM_DOWNLOAD_URL=${urls.download}/${tag} bash -s -- --skip-config --dir "${dir ?? '$HOME/.local/bin'}"`;
}

export interface InstallerRun {
  tag: string;
  dir: string;
  /** The graph env (graphEnv of the login env). */
  env: Env;
  onLine: (line: string) => void;
  urls?: GraphUrls;
  /** Engine.stop: the run's whole process group is killed. */
  signal?: AbortSignal;
  /** @internal test seam: the run's limit (default 5 min). */
  timeoutMs?: number;
}

const killGroup = (pid: number, sig: 'SIGTERM' | 'SIGKILL') => { try { process.kill(-pid, sig); } catch { /* ESRCH: gone */ } };

async function lines(stream: ReadableStream<Uint8Array>, onLine: (l: string) => void, last: { line: string }): Promise<void> {
  const dec = new TextDecoder();
  let buf = '';
  const emit = (l: string) => { const t = l.trim(); if (t) { last.line = t; onLine(t); } };
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { emit(buf.slice(0, i)); buf = buf.slice(i + 1); }
  }
  emit(buf);
}

/** §5.6 one installer run of `tag` into `dir`: ok, or the last log line (a fetch error, the exit, "hết giờ"). */
export async function runInstaller(o: InstallerRun): Promise<RunEnd> {
  if (!TAG.test(o.tag)) return { ok: false, line: `bad tag ${o.tag}` };
  const urls = o.urls ?? GRAPH_URLS;
  let text: string;
  try {
    const r = await fetch(`${urls.raw}/${o.tag}/install.sh`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!r.ok) return { ok: false, line: `install.sh ${o.tag}: HTTP ${r.status}` };
    text = await r.text();
  } catch (e) {
    return { ok: false, line: e instanceof Error ? e.message : String(e) };
  }
  const tmp = mkdtempSync(join(tmpdir(), 'ccs-cbm-install-'));
  try {
    const file = join(tmp, 'install.sh');
    writeFileSync(file, text, { mode: 0o600 });
    o.onLine(`$ ${installLine(o.tag, o.dir, urls)}`);
    // detached: bash leads its own group, so the limit / a stop kills what it started too (curl, tar, the self-activation)
    const p = Bun.spawn(['bash', file, '--skip-config', '--dir', o.dir], {
      cwd: tmp, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: true, env: { ...o.env, CBM_DOWNLOAD_URL: `${urls.download}/${o.tag}` },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort = () => {};
    const cut = new Promise<'late' | 'stopped'>((ok) => {
      timer = setTimeout(() => ok('late'), o.timeoutMs ?? INSTALL_TIMEOUT_MS);
      onAbort = () => ok('stopped');
      if (o.signal?.aborted) onAbort(); else o.signal?.addEventListener('abort', onAbort, { once: true });
    });
    const last = { line: '' };
    // a child of the script (curl, sleep…) may hold the pipes after bash is gone: the limit does not wait for them
    const r = await Promise.race([Promise.all([p.exited, lines(p.stdout, o.onLine, last), lines(p.stderr, o.onLine, last)]), cut]);
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', onAbort);
    if (r === 'late' || r === 'stopped') {
      killGroup(p.pid, 'SIGTERM');
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([p.exited, new Promise((ok) => { grace = setTimeout(ok, GRACE_MS); })]);
      clearTimeout(grace);
      killGroup(p.pid, 'SIGKILL'); // always: bash dying on TERM says nothing of a TERM-ignoring child
      return { ok: false, line: r === 'late' ? TIMEOUT_LINE : STOPPED_LINE };
    }
    return r[0] === 0 ? { ok: true } : { ok: false, line: last.line || `exit ${r[0]}` };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
