// spec v2.7 §4.10 IS20 (Tài liệu of a spec), R33, §10.1 `spec_output_add`, §13 "tài liệu: tự thêm theo tên ngày,
// spec_output_add ngoài project / URL không http bị từ chối, cổng localhost đóng → đã tắt".
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listOutputs, validateOutputRef } from '../../src/specs/outputs.ts';

let root: string;
const SPEC = 'docs/specs/2026-11-16-x-tasks-design.md';
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-out-')));
  mkdirSync(join(root, 'docs/specs/assets'), { recursive: true });
  writeFileSync(join(root, SPEC), '# X\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (rel: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), 'x'); };
const closed = async () => false;
const list = (sessionRows: { ref: string; label: string | null }[] = [], connect: (h: string, p: number, ms: number) => Promise<boolean> = closed) =>
  listOutputs({ root, docs: 'docs/specs', specPath: SPEC, sessionRows, connect });

describe('§4.10 listOutputs', () => {
  test('§4.10 only the spec file → one row (the empty state is the web\'s)', async () => {
    expect(await list()).toEqual([{ role: 'spec', kind: 'md', ref: SPEC, label: null, display: '2026-11-16-x-tasks-design.md', addedBy: 'auto', state: 'ok' }]);
  });

  test('v2.9 §8 a spec of another doc step: auto rows from <its docs>/assets, display relative to its docs', async () => {
    const plan = 'docs/plans/2026-11-16-x-design.md';
    put(plan);
    put('docs/plans/assets/2026-11-16-x.html');
    put('docs/specs/assets/2026-11-16-x.html');
    const r = await listOutputs({ root, docs: 'docs/plans', specPath: plan, sessionRows: [], connect: closed });
    expect(r.map((o) => [o.ref, o.display])).toEqual([[plan, '2026-11-16-x-design.md'], ['docs/plans/assets/2026-11-16-x.html', 'assets/2026-11-16-x.html']]);
  });

  test('§4.10 / R33 auto rows by the dated name (`-design` cut), images grouped, fixed order, other dates ignored', async () => {
    put('docs/specs/assets/2026-11-16-x-tasks.html');
    put('docs/specs/assets/2026-11-16-x-tasks-research.md');
    put('docs/specs/assets/2026-11-16-x-tasks-shots/b.png');
    put('docs/specs/assets/2026-11-16-x-tasks-shots/a.png');
    put('docs/specs/assets/2026-11-16-x-tasks-shots/deep/c.jpg');
    put('docs/specs/assets/2026-11-01-other.html');
    const r = await list([{ ref: 'http://example.com/p', label: 'Proto' }]);
    expect(r.map((o) => [o.role, o.kind, o.ref, o.addedBy, o.count])).toEqual([
      ['spec', 'md', SPEC, 'auto', undefined],
      ['mockup', 'html', 'docs/specs/assets/2026-11-16-x-tasks.html', 'auto', undefined],
      ['images', 'image', 'docs/specs/assets/2026-11-16-x-tasks-shots/a.png', 'auto', 3],
      ['doc', 'md', 'docs/specs/assets/2026-11-16-x-tasks-research.md', 'auto', undefined],
      ['link', 'link', 'http://example.com/p', 'session', undefined],
    ]);
  });

  test('§4.10 session rows: kind by extension, label kept, duplicate of an auto row merged', async () => {
    put('docs/specs/assets/2026-11-16-x-tasks.html');
    put('notes/data.csv');
    const r = await list([{ ref: 'docs/specs/assets/2026-11-16-x-tasks.html', label: 'Mockup v2' }, { ref: 'notes/data.csv', label: null }]);
    expect(r.map((o) => [o.role, o.kind, o.ref, o.label, o.addedBy])).toEqual([
      ['spec', 'md', SPEC, null, 'auto'],
      ['mockup', 'html', 'docs/specs/assets/2026-11-16-x-tasks.html', 'Mockup v2', 'auto'],
      ['doc', 'other', 'notes/data.csv', null, 'session'],
    ]);
  });

  test('§4.10 missing file → state missing (also a session path that left the project)', async () => {
    rmSync(join(root, SPEC));
    symlinkSync('/etc', join(root, 'out'));
    const r = await list([{ ref: 'gone.md', label: null }, { ref: 'out/hosts', label: null }]);
    expect(r.map((o) => [o.ref, o.state])).toEqual([[SPEC, 'missing'], ['gone.md', 'missing'], ['out/hosts', 'missing']]);
  });

  test('§4.10 localhost / 127.0.0.1 probed (≤ 300 ms): closed → off, open → ok; other hosts never probed', async () => {
    const probes: [string, number, number][] = [];
    const connect = async (h: string, p: number, ms: number) => { probes.push([h, p, ms]); return p === 5173; };
    const r = await list([
      { ref: 'http://localhost:5173/', label: null }, { ref: 'http://127.0.0.1:4000/x', label: null },
      { ref: 'https://localhost/', label: null }, { ref: 'https://example.com:5173/', label: null },
    ], connect);
    expect(r.slice(1).map((o) => o.state)).toEqual(['ok', 'off', 'off', 'ok']);
    expect(probes.sort()).toEqual([['127.0.0.1', 4000, 300], ['localhost', 443, 300], ['localhost', 5173, 300]]);
  });

  test('§4.10 / R33 display: host + path, any `token=` value masked; ref keeps the token', async () => {
    const r = await list([{ ref: 'http://localhost:5173/app?x=1&token=s3cr3t&Token=b#h', label: null }]);
    expect(r[1]!.display).toBe('localhost:5173/app?x=1&token=…&Token=…#h');
    expect(r[1]!.ref).toContain('s3cr3t');
    expect(r[1]!.display).not.toContain('s3cr3t');
  });

  test('§4.10 / R33 display drops user:password and masks every *token= (query + fragment)', async () => {
    const r = await list([
      { ref: 'http://user:pw@example.com/a?x=1&token=abc#token=zzz', label: null },
      { ref: 'https://example.com/b?access_token=sek&id_token=t2', label: null },
    ]);
    expect(r.slice(1).map((o) => o.display)).toEqual(['example.com/a?x=1&token=…#token=…', 'example.com/b?access_token=…&id_token=…']);
  });

  test('§4.10 a symlinked dir / file under assets is not walked (names outside the project never listed)', async () => {
    const out = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-out-x-')));
    try {
      mkdirSync(join(out, 'sub'));
      writeFileSync(join(out, 'secret.md'), 'x');
      writeFileSync(join(out, 'sub/id_rsa.png'), 'x');
      symlinkSync(out, join(root, 'docs/specs/assets/2026-11-16-x-tasks-shots'));
      symlinkSync(join(out, 'secret.md'), join(root, 'docs/specs/assets/2026-11-16-x-tasks-notes.md'));
      expect((await list()).map((o) => o.ref)).toEqual([SPEC]);
    } finally { rmSync(out, { recursive: true, force: true }); }
  });
});

describe('§10.1 validateOutputRef (spec_output_add)', () => {
  test('§10.1 http(s) URL → link', () => {
    expect(validateOutputRef(root, 'https://localhost:5173/?token=a')).toEqual({ ok: true, kind: 'link', ref: 'https://localhost:5173/?token=a' });
  });

  test.each(['file:///etc/passwd', 'javascript:alert(1)', 'ftp://x/y', 'data:text/html,x'])('§10.1 "%s" → refused as not http(s), even when a file of that name exists', (ref) => {
    writeFileSync(join(root, 'javascript:alert(1)'), 'x');
    const r = validateOutputRef(root, ref);
    expect(r).toEqual({ ok: false, error: `Từ chối: "${ref}" nằm ngoài project — chỉ nhận link http(s) hoặc file trong project.` });
  });

  test('§10.1 "http//bad" (no scheme) is a path → refused when no such file', () => {
    expect(validateOutputRef(root, 'http//bad').ok).toBe(false);
  });

  test('§10.1 a path inside the project → its root-relative ref + kind; absolute inside → relativized', () => {
    put('docs/specs/assets/m.html');
    expect(validateOutputRef(root, 'docs/specs/assets/m.html')).toEqual({ ok: true, kind: 'html', ref: 'docs/specs/assets/m.html' });
    expect(validateOutputRef(root, join(root, 'docs/specs/assets/m.html'))).toEqual({ ok: true, kind: 'html', ref: 'docs/specs/assets/m.html' });
  });

  test('§10.1 outside the project (../, absolute elsewhere, symlink out, .git) → Vietnamese refusal', () => {
    symlinkSync('/etc', join(root, 'out'));
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git/config'), 'x');
    for (const ref of ['../x.md', '/etc/hosts', 'out/hosts', '.git/config']) {
      const r = validateOutputRef(root, ref);
      expect(r).toEqual({ ok: false, error: `Từ chối: "${ref}" nằm ngoài project — chỉ nhận link http(s) hoặc file trong project.` });
    }
  });

  test('§10.1 a directory is refused; a non-normalised path is stored normalised (one row per file)', () => {
    put('docs/specs/assets/m.html');
    expect(validateOutputRef(root, 'docs')).toEqual({ ok: false, error: 'Từ chối: "docs" không phải file — chỉ nhận link http(s) hoặc file trong project.' });
    expect(validateOutputRef(root, 'docs/./specs/../specs/assets/m.html')).toEqual({ ok: true, kind: 'html', ref: 'docs/specs/assets/m.html' });
  });

  test('§10.1 a path with no file → refused', () => {
    expect(validateOutputRef(root, 'docs/none.md')).toEqual({ ok: false, error: 'Từ chối: không có file "docs/none.md" trong project.' });
  });
});
