// v2.3 §10.2 fs_read / fs_write, §5.2 Mã hoá (V20) / Lớn / Nhị phân, §5.3 khoá sửa, §11 engine unit "mã hoá", "fs_write …".
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { LaneState, OrchestratorState } from '../../../shared/protocol.ts';
import { fixture as gitRepo, git } from '../git/_repo.ts';
import { BASE, codeFs, codeOf, fixture, hex, tmp } from './_helpers.ts';

const sha1 = (b: Uint8Array | string) => createHash('sha1').update(b).digest('hex');

function setup(name: string, bytes: Uint8Array | string) {
  const f = fixture();
  writeFileSync(join(f.dir, name), bytes);
  return { f, fs: codeFs(f), file: join(f.dir, name) };
}
const req = { projectId: 'p1', src: BASE } as const;

describe('§10.2 fs_read', () => {
  test('§5.2 utf-8 LF text: text, sha1 of bytes, eol lf, no bom', async () => {
    const { fs } = setup('a.ts', 'const a = 1;\n');
    expect(await fs.read({ ...req, path: 'a.ts' })).toEqual({ kind: 'text', text: 'const a = 1;\n', size: 13, hash: sha1('const a = 1;\n'), eol: 'lf', bom: false });
  });
  test('§11 Latin-1 + CRLF (636166e90d0a780d0a) → readOnly not_utf8', async () => {
    const bytes = Buffer.from('636166e90d0a780d0a', 'hex');
    const { fs } = setup('l1.txt', bytes);
    const r = await fs.read({ ...req, path: 'l1.txt' });
    expect(r).toMatchObject({ kind: 'text', readOnly: 'not_utf8', eol: 'crlf', hash: sha1(bytes), text: 'caf�\nx\n' });
  });
  test('§11 LF + CRLF mixed → readOnly mixed_eol', async () => {
    const { fs } = setup('m.txt', 'a\r\nb\nc\r\n');
    expect(await fs.read({ ...req, path: 'm.txt' })).toMatchObject({ kind: 'text', readOnly: 'mixed_eol', text: 'a\nb\nc\n' });
  });
  test('§5.2 UTF-8 BOM + CRLF → bom true, eol crlf, text without BOM / CR', async () => {
    const { fs } = setup('b.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('x\r\ny\r\n')]));
    expect(await fs.read({ ...req, path: 'b.txt' })).toMatchObject({ kind: 'text', text: 'x\ny\n', eol: 'crlf', bom: true });
  });
  test('§11 binary (byte 0 in the first 8 KB) → kind binary, no text', async () => {
    const bytes = new Uint8Array(100); bytes[50] = 0; bytes.fill(65, 0, 50);
    const { fs } = setup('bin.dat', bytes);
    const r = await fs.read({ ...req, path: 'bin.dat' });
    expect(r).toEqual({ kind: 'binary', size: 100, hash: sha1(bytes) });
  });
  test('§11 large (> 2 MB) → kind large, first 2 MB of text, hash of every byte', async () => {
    const big = 'x'.repeat(99) + '\n';
    const bytes = Buffer.from(big.repeat(22_000)); // 2.2 MB
    const { fs } = setup('big.log', bytes);
    const r = await fs.read({ ...req, path: 'big.log' });
    expect(r.kind).toBe('large');
    expect(r.text?.length).toBe(2 * 1024 * 1024);
    expect(r.size).toBe(bytes.length);
    expect(r.hash).toBe(sha1(bytes));
  });
  test('§5.2 a line > 20 000 chars → kind large', async () => {
    const { fs } = setup('min.js', 'a'.repeat(20_001));
    expect((await fs.read({ ...req, path: 'min.js' })).kind).toBe('large');
  });
  test('§11 image ≤ 5 MB → data URL', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const { fs } = setup('i.png', png);
    expect(await fs.read({ ...req, path: 'i.png' })).toEqual({ kind: 'image', dataUrl: `data:image/png;base64,${png.toString('base64')}`, size: png.length, hash: sha1(png) });
  });
  test('§5.2 svg is an image (rendered as <img>)', async () => {
    const { fs } = setup('i.svg', '<svg/>');
    expect((await fs.read({ ...req, path: 'i.svg' })).dataUrl).toStartWith('data:image/svg+xml;base64,');
  });
  test('§11 image > 5 MB → not an image (png has NUL → binary)', async () => {
    const png = Buffer.alloc(5 * 1024 * 1024 + 1);
    const { fs } = setup('huge.png', png);
    expect((await fs.read({ ...req, path: 'huge.png' })).kind).toBe('binary');
  });
  test('§11 MINOR-4 a 1 GB sparse file → binary, head-only hash sha1(size + mtimeMs + head), < 200 ms', async () => {
    const f = fixture();
    const file = join(f.dir, 'huge.bin');
    const fd = openSync(file, 'w');
    writeSync(fd, 'x');
    ftruncateSync(fd, 1 << 30);
    closeSync(fd);
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 10);
    const t0 = performance.now();
    const r = await codeFs(f).read({ ...req, path: 'huge.bin' });
    const ms = performance.now() - t0;
    await Bun.sleep(25);
    clearInterval(timer);
    expect(ms).toBeLessThan(200);
    expect(ticks).toBeGreaterThan(0);
    const st = statSync(file);
    const head = Buffer.alloc(5 * 1024 * 1024); head[0] = 0x78;
    expect(r).toEqual({ kind: 'binary', size: 1 << 30, hash: createHash('sha1').update(`${st.size}:${st.mtimeMs}:`).update(head).digest('hex') });
  });
  test('§10.2 a directory → forbidden', async () => {
    const f = fixture(); mkdirSync(join(f.dir, 'd'));
    expect(await codeOf(codeFs(f).read({ ...req, path: 'd' }))).toBe('forbidden');
  });
});

describe('§10.2 fs_write', () => {
  const write = (fs: ReturnType<typeof codeFs>, o: { path: string; text: string; eol?: 'lf' | 'crlf'; bom?: boolean; baseHash: string; recreate?: boolean }) =>
    fs.write({ ...req, eol: 'lf', bom: false, ...o });

  test('§11 UTF-8 CRLF + BOM, one-char edit → only that byte changes, CRLF + BOM intact', async () => {
    const before = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('héllo\r\nworld\r\n')]);
    const { fs, file } = setup('c.txt', before);
    const r = await fs.read({ ...req, path: 'c.txt' });
    const out = await write(fs, { path: 'c.txt', text: r.text!.replace('world', 'worle'), eol: r.eol!, bom: r.bom!, baseHash: r.hash });
    const after = readFileSync(file);
    expect(out).toEqual({ ok: true, hash: sha1(after) });
    expect(after.length).toBe(before.length);
    const diff = [...before].flatMap((b, i) => (b === after[i] ? [] : [i]));
    expect(diff).toEqual([before.indexOf('d'.charCodeAt(0), 10)]);
    expect(hex(after.subarray(0, 3))).toBe('efbbbf');
    expect(hex(after.subarray(-2))).toBe('0d0a');
  });
  test('§11 no final newline stays without one', async () => {
    const { fs, file } = setup('n.txt', 'a\r\nb');
    const r = await fs.read({ ...req, path: 'n.txt' });
    await write(fs, { path: 'n.txt', text: 'a\nc', eol: 'crlf', bom: false, baseHash: r.hash });
    expect(hex(readFileSync(file))).toBe(Buffer.from('a\r\nc').toString('hex'));
  });
  test('§5.3 a lone CR inside a CRLF file survives the round trip byte-exact', async () => {
    const bytes = Buffer.from('a\r\r\nb\r\n');
    const { fs, file } = setup('cr.txt', bytes);
    const r = await fs.read({ ...req, path: 'cr.txt' });
    await write(fs, { path: 'cr.txt', text: r.text!, eol: r.eol!, bom: r.bom!, baseHash: r.hash });
    expect(hex(readFileSync(file))).toBe(hex(bytes));
  });
  test('§11 Latin-1 file → fs_write refuses (forbidden), bytes untouched', async () => {
    const bytes = Buffer.from('636166e90d0a780d0a', 'hex');
    const { fs, file } = setup('l1.txt', bytes);
    expect(await codeOf(write(fs, { path: 'l1.txt', text: 'café\n', eol: 'crlf', baseHash: sha1(bytes) }))).toBe('forbidden');
    expect(hex(readFileSync(file))).toBe('636166e90d0a780d0a');
  });
  test('§5.3 mixed eol / binary / large files → forbidden', async () => {
    for (const [name, bytes] of [['m.txt', 'a\r\nb\n'], ['b.dat', Buffer.from([1, 0, 2])], ['l.txt', 'x'.repeat(2 * 1024 * 1024 + 1)]] as const) {
      const { fs } = setup(name, bytes);
      expect(await codeOf(write(fs, { path: name, text: 'z', baseHash: sha1(bytes) }))).toBe('forbidden');
    }
  });
  test('§11 baseHash differs from disk → conflict with the disk text, file untouched', async () => {
    const { fs, file } = setup('k.txt', 'disk\n');
    const out = await write(fs, { path: 'k.txt', text: 'mine\n', baseHash: sha1('old\n') });
    expect(out).toEqual({ ok: false, code: 'conflict', disk: { kind: 'text', text: 'disk\n', size: 5, hash: sha1('disk\n'), eol: 'lf', bom: false } });
    expect(readFileSync(file, 'utf8')).toBe('disk\n');
  });
  test('§11 file deleted → gone; recreate: true → written', async () => {
    const { fs, file } = setup('g.txt', 'x\n');
    rmSync(file);
    expect(await write(fs, { path: 'g.txt', text: 'mine\n', baseHash: sha1('x\n') })).toEqual({ ok: false, code: 'gone' });
    expect(existsSync(file)).toBe(false);
    expect(await write(fs, { path: 'g.txt', text: 'mine\n', baseHash: sha1('x\n'), recreate: true })).toEqual({ ok: true, hash: sha1('mine\n') });
    expect(readFileSync(file, 'utf8')).toBe('mine\n');
  });
  test('§11 fs_write into a symlink → forbidden (lstat), target untouched', async () => {
    const f = fixture();
    writeFileSync(join(f.dir, 't.txt'), 't\n');
    symlinkSync(join(f.dir, 't.txt'), join(f.dir, 'l.txt'));
    expect(await codeOf(write(codeFs(f), { path: 'l.txt', text: 'x\n', baseHash: sha1('t\n') }))).toBe('forbidden');
    expect(readFileSync(join(f.dir, 't.txt'), 'utf8')).toBe('t\n');
  });
  test('§5.3 ② dangling symlink + recreate → forbidden, the symlink stays', async () => {
    const f = fixture();
    symlinkSync(join(f.dir, 'nowhere.txt'), join(f.dir, 'd.txt'));
    expect(await codeOf(write(codeFs(f), { path: 'd.txt', text: 'x\n', baseHash: '', recreate: true }))).toBe('forbidden');
    expect(lstatSync(join(f.dir, 'd.txt')).isSymbolicLink()).toBe(true);
  });
  test('§10.2 atomic temp + rename keeps the file mode, leaves no temp file', async () => {
    const { f, fs, file } = setup('run.sh', '#!/bin/sh\n');
    chmodSync(file, 0o777);
    await write(fs, { path: 'run.sh', text: '#!/bin/sh\necho\n', baseHash: sha1('#!/bin/sh\n') });
    expect(statSync(file).mode & 0o7777).toBe(0o777);
    expect(readdirSync(f.dir)).toEqual(['run.sh']);
  });
  test('§11 MINOR-2 existing LF file + eol crlf / bom true in the request → forbidden, bytes untouched', async () => {
    const { fs, file } = setup('e.txt', 'a\nb\nc\n');
    const r = await fs.read({ ...req, path: 'e.txt' });
    expect(await codeOf(write(fs, { path: 'e.txt', text: r.text!, eol: 'crlf', bom: r.bom!, baseHash: r.hash }))).toBe('forbidden');
    expect(await codeOf(write(fs, { path: 'e.txt', text: r.text!, eol: r.eol!, bom: true, baseHash: r.hash }))).toBe('forbidden');
    expect(readFileSync(file, 'utf8')).toBe('a\nb\nc\n');
  });
  test('§11 MINOR-2 recreate keeps the request eol / bom', async () => {
    const { fs, file } = setup('n.txt', 'x\n');
    rmSync(file);
    await write(fs, { path: 'n.txt', text: 'a\nb\n', eol: 'crlf', bom: true, baseHash: '', recreate: true });
    expect(hex(readFileSync(file))).toBe('efbbbf610d0a620d0a');
  });
  test('§11 MINOR-1 parent dir swapped for a symlink out of the root right before the temp write → forbidden, outside untouched', async () => {
    const { f } = setup('top.txt', 't\n');
    const out = tmp('ccs-out-');
    mkdirSync(join(f.dir, 'sub'));
    writeFileSync(join(f.dir, 'sub', 'x.txt'), 'in\n');
    writeFileSync(join(out, 'x.txt'), 'in\n');
    let calls = 0;
    const fs2 = codeFs({ ...f, get lock() {
      if (++calls === 2) { renameSync(join(f.dir, 'sub'), join(f.dir, 'sub-moved')); symlinkSync(out, join(f.dir, 'sub')); }
      return { lanes: [], orchestrator: 'idle' as const };
    } });
    expect(await codeOf(write(fs2, { path: 'sub/x.txt', text: 'PWNED\n', baseHash: sha1('in\n') }))).toBe('forbidden');
    expect(readFileSync(join(out, 'x.txt'), 'utf8')).toBe('in\n');
    expect(readdirSync(out)).toEqual(['x.txt']);
  });
  test('§10.2 .GIT/config write → forbidden', async () => {
    const f = fixture(); mkdirSync(join(f.dir, '.git')); writeFileSync(join(f.dir, '.git', 'config'), 'c');
    expect(await codeOf(write(codeFs(f), { path: '.GIT/config', text: 'x', baseHash: sha1('c'), recreate: true }))).toBe('forbidden');
  });
});

describe('§5.3 khoá sửa (lane_running)', () => {
  const LIVE: LaneState[] = ['starting', 'running', 'idle', 'waiting_po', 'switching', 'waiting_quota', 'draining'];
  const DEAD: LaneState[] = ['done', 'stopped', 'broken'];
  const attempt = async (laneCwdOf: (root: string) => string, state: LaneState, orch: OrchestratorState | null = 'idle', lane = true) => {
    const { f, fs } = setup('a.txt', 'a\n');
    mkdirSync(join(f.dir, 'sub'));
    f.lock = { lanes: lane ? [{ name: 'D9', state, cwd: laneCwdOf(f.dir) }] : [], orchestrator: orch };
    return codeOf(fs.write({ ...req, path: 'a.txt', text: 'b\n', eol: 'lf', bom: false, baseHash: sha1('a\n') }));
  };
  for (const s of LIVE) test(`§11 lane ${s} in the source dir → lane_running`, async () => { expect(await attempt((r) => r, s)).toBe('lane_running'); });
  for (const s of DEAD) test(`§11 lane ${s} in the source dir → writes`, async () => { expect(await attempt((r) => r, s)).toBe(''); });
  test('§11 live lane in a sub-dir of the source → lane_running', async () => { expect(await attempt((r) => join(r, 'sub'), 'running')).toBe('lane_running'); });
  test('§11 live lane in a parent of the source → lane_running', async () => { expect(await attempt((r) => join(r, '..'), 'running')).toBe('lane_running'); });
  test('§11 live lane in a sibling dir → writes', async () => { expect(await attempt((r) => `${r}-other`, 'running')).toBe(''); });
  test('§11 live lane through a symlink to the source → lane_running (by realpath)', async () => {
    const link = join(tmp('ccs-ln-'), 'proj');
    expect(await attempt((r) => { symlinkSync(r, link); return link; }, 'running')).toBe('lane_running');
  });
  test('§11 D7 done and D9 running share one cwd → locked', async () => {
    const { f, fs } = setup('a.txt', 'a\n');
    f.lock = { lanes: [{ name: 'D7', state: 'done', cwd: f.dir }, { name: 'D9', state: 'running', cwd: f.dir }], orchestrator: 'idle' };
    const e = await fs.write({ ...req, path: 'a.txt', text: 'b\n', eol: 'lf', bom: false, baseHash: sha1('a\n') }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'lane_running', params: { lane: 'D9' } });
  });
  const ORCH: [OrchestratorState | null, string][] = [['idle', ''], ['stopped', ''], [null, ''], ['starting', 'lane_running'], ['running', 'lane_running'], ['switching', 'lane_running'], ['waiting_quota', 'lane_running']];
  for (const [o, want] of ORCH) {
    test(`§11 project dir with orchestrator ${String(o)} → ${want || 'writes'}`, async () => { expect(await attempt((r) => r, 'done', o, false)).toBe(want); });
  }
  test('§5.3 orchestrator running does not lock a lane worktree', async () => {
    const g = gitRepo();
    const wt = join(g.root, 'wt');
    git(g.repo, 'worktree', 'add', '-q', '-b', 'lane/d1', wt);
    const f = fixture(g.repo);
    writeFileSync(join(wt, 'a.txt'), 'a\n');
    f.lanes.D1 = wt; f.worktrees = [f.dir, wt];
    f.lock = { lanes: [], orchestrator: 'running' };
    expect(await codeFs(f).write({ ...req, src: { kind: 'lane', laneId: 'D1' }, path: 'a.txt', text: 'b\n', eol: 'lf', bom: false, baseHash: sha1('a\n') })).toEqual({ ok: true, hash: sha1('b\n') });
  });
});
