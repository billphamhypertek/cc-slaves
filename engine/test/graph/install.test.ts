// v2.5 §5.6 / §5.3 the graph installer: the latest tag from the `releases/latest` redirect (§3-15), the pinned script of
// that tag run as `bash <file> --skip-config --dir <dir>` with CBM_DOWNLOAD_URL of the same tag, the equivalent one-line
// command for the UI. Loopback servers only (never GitHub), temp dirs only.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckError, installLine, latestTag, runInstaller, type GraphUrls } from '../../src/graph/install.ts';

let tmp: string;
let server: ReturnType<typeof Bun.serve>;
let urls: GraphUrls;
let latest: () => Response;
let script = '';

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-install-'));
  server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    fetch: (r) => {
      const u = new URL(r.url);
      if (u.pathname === '/releases/latest') return latest();
      if (u.pathname === '/raw/v0.13.0/install.sh') return new Response(script);
      return new Response('nope', { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  urls = { latest: `${base}/releases/latest`, raw: `${base}/raw`, download: `${base}/download` };
});
afterAll(() => { void server.stop(true); rmSync(tmp, { recursive: true, force: true }); });

describe('§5.3 graph_check: the latest tag from the releases/latest redirect', () => {
  test('a 302 to …/releases/tag/v0.13.0 → v0.13.0 (the redirect is read, not followed)', async () => {
    latest = () => new Response(null, { status: 302, headers: { location: 'https://github.com/DeusData/codebase-memory-mcp/releases/tag/v0.13.0' } });
    expect(await latestTag(urls)).toBe('v0.13.0');
  });
  test('no redirect, or a tag that is not vX.Y.Z (never put into a URL / command) → unknown', async () => {
    latest = () => new Response('ok');
    expect(await latestTag(urls).catch((e: CheckError) => e.code)).toBe('unknown');
    latest = () => new Response(null, { status: 302, headers: { location: 'https://x/releases/tag/v1.0.0;rm%20-rf' } });
    expect(await latestTag(urls).catch((e: CheckError) => e.code)).toBe('unknown');
  });
  test('no network (connection refused) → offline', async () => {
    const dead = { ...urls, latest: 'http://127.0.0.1:1/releases/latest' };
    expect(await latestTag(dead).catch((e: CheckError) => e.code)).toBe('offline');
  });
});

describe('§5.6 the pinned installer run', () => {
  test('the one-line equivalent: curl of the tag script | CBM_DOWNLOAD_URL of the tag, --skip-config, the dir (default "$HOME/.local/bin")', () => {
    expect(installLine('v0.13.0', null)).toBe('curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/v0.13.0/install.sh | '
      + 'CBM_DOWNLOAD_URL=https://github.com/DeusData/codebase-memory-mcp/releases/download/v0.13.0 bash -s -- --skip-config --dir "$HOME/.local/bin"');
    expect(installLine('v0.13.0', '/opt/my bin')).toEndWith('--skip-config --dir "/opt/my bin"');
  });
  test('downloads the script of that tag, runs bash <file> --skip-config --dir <dir> (dir one argument) with CBM_DOWNLOAD_URL, lines streamed', async () => {
    const out = join(tmp, 'args.txt');
    script = `printf '%s\\n' "$@" > "${out}"; echo "url=$CBM_DOWNLOAD_URL" >> "${out}"; echo "Downloading…"; echo "Installed binary" 1>&2; exit 0\n`;
    const dir = join(tmp, 'my bin');
    const lines: string[] = [];
    expect(await runInstaller({ tag: 'v0.13.0', dir, env: { PATH: '/usr/bin:/bin', HOME: tmp }, urls, onLine: (l) => lines.push(l) })).toEqual({ ok: true });
    expect(readFileSync(out, 'utf8').split('\n')).toEqual(['--skip-config', '--dir', dir, `url=${urls.download}/v0.13.0`, '']);
    expect(lines).toEqual(expect.arrayContaining(['Downloading…', 'Installed binary']));
  });
  test('a non-zero exit → failed with the last log line; the temp script is removed', async () => {
    script = 'echo "checksum mismatch for codebase-memory-mcp-darwin-arm64.tar.gz"; exit 3\n';
    const temps = () => readdirSync(tmpdir()).filter((n) => n.startsWith('ccs-cbm-install-')).length;
    const before = temps();
    const r = await runInstaller({ tag: 'v0.13.0', dir: join(tmp, 'b'), env: { PATH: '/usr/bin:/bin' }, urls, onLine: () => {} });
    expect(r).toEqual({ ok: false, line: 'checksum mismatch for codebase-memory-mcp-darwin-arm64.tar.gz' });
    expect(temps()).toBe(before);
  });
  test('the script of the tag cannot be fetched (404) → failed, nothing run', async () => {
    const r = await runInstaller({ tag: 'v9.9.9', dir: join(tmp, 'c'), env: { PATH: '/usr/bin:/bin' }, urls, onLine: () => {} });
    expect(r).toMatchObject({ ok: false });
    expect((r as { line: string }).line).toContain('404');
  });
  test('past its limit (5 min; seam) → killed, failed "hết giờ"', async () => {
    script = 'echo start; sleep 30\n';
    const t0 = Date.now();
    const r = await runInstaller({ tag: 'v0.13.0', dir: join(tmp, 'd'), env: { PATH: '/usr/bin:/bin' }, urls, onLine: () => {}, timeoutMs: 300 });
    expect(r).toEqual({ ok: false, line: 'hết giờ' });
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  // review-e IMPORTANT-1: the script's children (a hung curl / tar) die with it — the whole group, not bash alone
  const survivors = (marker: string) => Bun.spawnSync(['pgrep', '-f', marker]).stdout.toString().trim();
  test('past its limit → the whole process group is killed (no child of the script survives)', async () => {
    const m = `${4000 + Math.floor(Math.random() * 900)}`;
    script = `sleep 1${m} & sleep 2${m}\n`;
    const t0 = Date.now();
    const r = await runInstaller({ tag: 'v0.13.0', dir: join(tmp, 'e'), env: { PATH: '/usr/bin:/bin' }, urls, onLine: () => {}, timeoutMs: 300 });
    expect(r).toEqual({ ok: false, line: 'hết giờ' });
    expect(Date.now() - t0).toBeLessThan(1500); // SIGTERM first: no 2 s grace wait when the group goes on TERM
    expect(survivors(`sleep [12]${m}`)).toBe('');
  });
  test('an abort (Engine.stop) → the group is killed, failed "đã dừng"', async () => {
    const m = `${5000 + Math.floor(Math.random() * 900)}`;
    script = `echo go; sleep 1${m} & sleep 2${m}\n`;
    const ac = new AbortController();
    const run = runInstaller({ tag: 'v0.13.0', dir: join(tmp, 'f'), env: { PATH: '/usr/bin:/bin' }, urls, signal: ac.signal, onLine: (l) => { if (l === 'go') ac.abort(); } });
    expect(await run).toEqual({ ok: false, line: 'đã dừng' });
    expect(survivors(`sleep [12]${m}`)).toBe('');
  });
});
