// spec v2.9 §5.1 / §6.1 / §10.1 the workflow library (workflow/library.ts): built-ins + `<home>/workflows/`, pinned copies in
// `<home>/workflow-revs/` (registered at boot, dropped when nobody pins them), the stat poll, save / copy / import / delete,
// the project's workflow. Temp homes only.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { insertProject, insertSession, openDb, type Db } from '../../src/db.ts';
import { insertSpec } from '../../src/issues/store.ts';
import { BLANK_TEMPLATE } from '../../../shared/workflows.ts';
import { WorkflowLibrary } from '../../src/workflow/library.ts';
import { packRev } from '../../src/workflow/pack.ts';
import { dropWorkflow, projectWorkflow, spawnPrompt, stepOf, workflowOf, workflowRev } from '../../src/workflow/runtime.ts';
import { basePack, fm, type Files } from './_packs.ts';

let tmp: string;
let home: string;
let db: Db;
let changes: number;
let clock: number;
const lib = () => new WorkflowLibrary({ home, trashHome: join(tmp, 'user'), db, now: () => clock, onChange: () => { changes++; } });
const libDir = () => join(home, 'workflows');
const revsDir = () => join(home, 'workflow-revs');
const index = () => JSON.parse(readFileSync(join(revsDir(), 'index.json'), 'utf8')) as Record<string, { id: string; name: string; at: number }>;
/** Each test its own names: the runtime registry is shared by the process. */
let tag = 0;
const named = (name: string, over: Files = {}): Files =>
  basePack({ 'WORKFLOW.md': fm(`name: ${name}\ndescription: gói ${name}\ndoc_label: Spec\ndocs_done: done`, `Chung ${name}.`), ...over });
function writeDir(dir: string, files: Files): void {
  for (const [p, t] of Object.entries(files)) { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), t); }
}
const revOf = (id: string) => db.query<{ r: string }, [string]>('SELECT workflow_rev AS r FROM session WHERE id = ?').get(id)!.r;
/** A write the 2 s poll must see even inside one mtime tick. */
function touch(path: string, text: string): void {
  writeFileSync(path, text);
  clock += 1000;
  utimesSync(path, new Date(clock), new Date(clock));
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-wflib-')));
  home = join(tmp, 'home');
  db = openDb(':memory:');
  insertProject(db, { id: 'p1', name: 'one', path: join(tmp, 'r1') });
  insertProject(db, { id: 'p2', name: 'two', path: join(tmp, 'r2') });
  changes = 0;
  clock = 1_800_000_000_000;
  tag++;
});
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

describe('v2.9 §6.1 boot: pinned copies', () => {
  test('the three built-ins are copied to workflow-revs/<rev>/ with an index row; a library pack is read, registered, copied', () => {
    const name = `Gói A${tag}`;
    writeDir(join(libDir(), 'goi-a'), named(name));
    const l = lib();
    l.boot();
    for (const id of ['builtin:po', 'builtin:spec-plan', 'builtin:direct']) {
      const rev = workflowOf(id).rev;
      expect(existsSync(join(revsDir(), rev, 'WORKFLOW.md'))).toBe(true);
      expect(index()[rev]).toMatchObject({ id, name: workflowOf(id).name });
    }
    const rev = packRev(named(name));
    expect(workflowOf('goi-a').rev).toBe(rev);
    expect(readdirSync(join(revsDir(), rev, 'steps')).sort()).toEqual(['build.md', 'design.md', 'general.md', 'lane.md']);
    expect(l.list().map((r) => r.id)).toEqual(['builtin:po', 'builtin:spec-plan', 'builtin:direct', 'goi-a']);
    expect(l.list()[3]).toMatchObject({ name, builtin: false, rev, diskRev: rev, validAt: clock, errors: [], usedBy: [] });
  });

  test('rulings 22:05: every stored rev is registered at boot (its library pack gone); unpinned copies are deleted', () => {
    const kept = named(`Ghim ${tag}`);
    const loose = named(`Lỏng ${tag}`);
    const [kRev, lRev] = [packRev(kept), packRev(loose)];
    writeDir(join(revsDir(), kRev), kept);
    writeDir(join(revsDir(), lRev), loose);
    expect(() => workflowRev(kRev)).toThrow('không còn trên máy');
    insertSpec(db, { projectId: 'p1', path: 'docs/specs/a.md', title: 'A', origin: 'app', workflowRev: kRev, step: 'design' });
    lib().boot();
    expect(workflowRev(kRev).name).toBe(`Ghim ${tag}`);
    expect(existsSync(join(revsDir(), lRev))).toBe(false);
    expect(() => workflowRev(lRev)).toThrow('không còn trên máy');
  });

  test('a session / lane row pins a copy too; the newest rev of a library id stays (its fallback)', () => {
    const [a, b, c] = [named(`s${tag}`), named(`l${tag}`), named(`n${tag}`)];
    for (const f of [a, b, c]) writeDir(join(revsDir(), packRev(f)), f);
    writeFileSync(join(revsDir(), 'index.json'), JSON.stringify({ [packRev(c)]: { id: 'gone', name: 'n', at: 1 } }));
    insertSession(db, { id: 's1', projectId: 'p1', kind: 'orchestrator', account: null });
    db.query('UPDATE session SET workflow_rev = ? WHERE id = ?').run(packRev(a), 's1');
    db.query("INSERT INTO lane (project_id, name, cwd, session_id, brief_path, state, workflow_rev, created_at) VALUES ('p1', 'L1', '/w', 's1', '/b', 'running', ?, 0)").run(packRev(b));
    lib().boot();
    for (const f of [a, b, c]) expect(existsSync(join(revsDir(), packRev(f)))).toBe(true);
  });

  test('a pinned rev whose copy is gone fails closed at spawn, naming the pack from index.json', () => {
    const rev = 'a'.repeat(63) + String(tag % 10);
    mkdirSync(revsDir(), { recursive: true });
    writeFileSync(join(revsDir(), 'index.json'), JSON.stringify({ [rev]: { id: 'mat', name: `Gói mất ${tag}`, at: 1 } }));
    insertSession(db, { id: 'd1', projectId: 'p1', kind: 'orchestrator', account: null });
    db.query("UPDATE session SET orch_kind = 'design', workflow_rev = ?, step = 'design' WHERE id = 'd1'").run(rev);
    lib().boot();
    expect(() => spawnPrompt(db, 'd1', true)).toThrow(`Quy trình "Gói mất ${tag}" bản ${rev.slice(0, 12)} không còn trên máy`);
  });
});

describe('v2.9 §10.1 the poll (stat signature)', () => {
  test('an edit registers the new rev; a broken file keeps the last valid rev running (WF5b); a removed folder drops the row', () => {
    const name = `Sửa ${tag}`;
    writeDir(join(libDir(), 'sua'), named(name));
    const l = lib();
    l.boot();
    const first = workflowOf('sua').rev;
    expect(l.scan()).toBe(false);
    changes = 0;
    touch(join(libDir(), 'sua', 'steps/lane.md'), fm('type: lane\nphases: [queue, review, done]', 'Làm.'));
    expect(l.scan()).toBe(true);
    expect(changes).toBe(1);
    const second = workflowOf('sua');
    expect(second.rev).not.toBe(first);
    expect(stepOf(second, 'lane')!.phases).toEqual(['queue', 'review', 'done']);
    expect(existsSync(join(revsDir(), second.rev))).toBe(true);
    const at = clock;
    touch(join(libDir(), 'sua', 'steps/lane.md'), fm('type: lane\nphases: [queue, review]', 'Làm.'));
    expect(l.scan()).toBe(true);
    const row = l.list().find((r) => r.id === 'sua')!;
    expect(row.errors.map((e) => e.code)).toEqual(['V9']);
    expect([row.rev, row.validAt, workflowOf('sua').rev]).toEqual([second.rev, at, second.rev]);
    expect(row.diskRev).not.toBe(second.rev);
    rmSync(join(libDir(), 'sua'), { recursive: true });
    expect(l.scan()).toBe(true);
    expect(l.list().some((r) => r.id === 'sua')).toBe(false);
    expect(workflowOf('sua').rev).toBe(second.rev); // a project on it keeps running
  });

  test('after a restart a broken library pack runs its newest indexed rev', () => {
    const name = `Khởi động ${tag}`;
    writeDir(join(libDir(), 'kd'), named(name));
    lib().boot();
    const rev = workflowOf('kd').rev;
    dropWorkflow('kd'); // a new engine process
    writeFileSync(join(libDir(), 'kd', 'WORKFLOW.md'), fm('name: [hỏng'));
    const l = lib();
    l.boot();
    expect(workflowOf('kd').rev).toBe(rev);
    expect(l.list().find((r) => r.id === 'kd')).toMatchObject({ rev, validAt: clock, errors: [expect.objectContaining({ code: 'V1' })] });
  });
});

describe('v2.9 §4.6 / WF5c save', () => {
  test('a stale baseRev is a conflict; files with errors are not written; a valid save writes and registers', () => {
    writeDir(join(libDir(), 'luu'), named(`Lưu ${tag}`));
    const l = lib();
    l.boot();
    const base = l.list().find((r) => r.id === 'luu')!.diskRev;
    expect(() => l.save('luu', named(`Lưu ${tag}`), 'f'.repeat(64))).toThrow('File quy trình vừa đổi ngoài app');
    const bad = named(`Lưu ${tag}`, { 'steps/lane.md': fm('type: lane\nphases: []', '') });
    const r = l.save('luu', bad, base);
    expect([r.saved, r.errors[0]?.code]).toEqual([false, 'V9']);
    expect(readFileSync(join(libDir(), 'luu', 'steps/lane.md'), 'utf8')).toBe(named('x')['steps/lane.md']!);
    const good = named(`Lưu ${tag}`, { 'steps/general.md': fm('type: general\nname: Chung mới', 'x') });
    l.setProject('p1', 'luu');
    for (const [id, p] of [['g1', 'p1'], ['g2', 'p2']] as const) {
      insertSession(db, { id, projectId: p, kind: 'orchestrator', account: null });
      db.query("UPDATE session SET orch_kind = 'general', workflow_rev = ?, step = 'general' WHERE id = ?").run(id === 'g1' ? workflowOf('luu').rev : workflowOf('builtin:po').rev, id);
    }
    changes = 0;
    const ok = l.save('luu', good, base);
    expect(ok).toMatchObject({ saved: true, row: { id: 'luu', rev: packRev(good), diskRev: packRev(good) } });
    expect(changes).toBe(1);
    expect(stepOf(workflowOf('luu'), 'general')!.name).toBe('Chung mới');
    expect(revOf('g1')).toBe(packRev(good)); // v29-fz Lưu bản mới re-pins the Chung of a project using the pack at once
    expect(revOf('g2')).toBe(workflowOf('builtin:po').rev); // another project's Chung is untouched
    expect(readdirSync(libDir())).toEqual(['luu']); // no temp folder left
    expect(() => l.save('builtin:po', good, base)).toThrow('Mẫu có sẵn chỉ xem');
  });
  test('v29-fw MINOR-1 a conflict refreshes the row at once: Ghi đè on the fresh diskRev saves before the next poll', () => {
    writeDir(join(libDir(), 'tay'), named(`Tay ${tag}`));
    const l = lib();
    l.boot();
    const base = l.list().find((r) => r.id === 'tay')!.diskRev;
    const hand = named(`Tay ${tag}`, { 'steps/general.md': fm('type: general\nname: Sửa tay', 'x') });
    writeFileSync(join(libDir(), 'tay', 'steps/general.md'), hand['steps/general.md']!);
    changes = 0;
    expect(() => l.save('tay', named(`Tay ${tag}`), base)).toThrow('File quy trình vừa đổi ngoài app');
    const row = l.list().find((r) => r.id === 'tay')!;
    expect([row.diskRev, changes]).toEqual([packRev(hand), 1]);
    expect(l.save('tay', named(`Tay ${tag}`), row.diskRev).saved).toBe(true);
  });
});

describe('v2.9 R9 / R13 / §4.8 create + import', () => {
  test('a copy of a built-in gets based_on + a new folder; a taken name becomes "(2)"', () => {
    const l = lib();
    l.boot();
    const row = l.create('builtin:po', 'Quy trình PO');
    expect(row).toMatchObject({ id: 'quy-trinh-po-2', name: 'Quy trình PO (2)', basedOn: `builtin:po@${workflowOf('builtin:po').rev}`, baseOutdated: false, errors: [] });
    expect(readFileSync(join(libDir(), 'quy-trinh-po-2', 'WORKFLOW.md'), 'utf8')).toContain('based_on: ');
    expect(l.create('quy-trinh-po-2', 'Đội Đỏ').id).toBe('doi-do');
    expect(l.create('quy-trinh-po-2', 'Đội Đỏ').name).toBe('Đội Đỏ (2)');
    expect(readdirSync(libDir()).sort()).toEqual(['doi-do', 'doi-do-2', 'quy-trinh-po-2']);
    expect(() => l.create('builtin:po', '  ')).toThrow('Tên quy trình trống');
  });

  test('R9 "Trống": readable + copied (Chung + Lane, no instruction, no based_on); never a row, never applied', () => {
    const l = lib();
    l.boot();
    const d = l.get({ id: BLANK_TEMPLATE });
    expect([d.name, Object.keys(d.files).sort()]).toEqual(['Trống', ['WORKFLOW.md', 'steps/general.md', 'steps/lane.md']]);
    const row = l.create(BLANK_TEMPLATE, 'Trống');
    expect(row).toMatchObject({ id: 'trong', basedOn: null, errors: [] });
    expect(l.list().map((r) => r.id)).not.toContain(BLANK_TEMPLATE);
    expect(() => l.setProject('p1', BLANK_TEMPLATE)).toThrow('chưa có bản hợp lệ');
  });

  test('v29-g4 WF5b / WF10b: a library row names its folder (Mở thư mục, the delete box); a built-in has none', () => {
    const l = lib();
    l.boot();
    const row = l.create('builtin:direct', `Thư mục ${++tag}`);
    expect(row.dir).toBe(join(libDir(), row.id));
    expect(l.list().find((r) => r.id === 'builtin:po')!.dir).toBeNull();
  });

  test('R13 a copy whose built-in has a newer rev says so', () => {
    writeDir(join(libDir(), 'cu'), named(`Cũ ${tag}`));
    const wf = join(libDir(), 'cu', 'WORKFLOW.md');
    writeFileSync(wf, readFileSync(wf, 'utf8').replace('docs_done: done', `docs_done: done\nbased_on: builtin:po@${'0'.repeat(64)}`));
    const l = lib();
    l.boot();
    expect(l.list().find((r) => r.id === 'cu')).toMatchObject({ baseOutdated: true });
  });

  test('import: preview copies nothing; a pack with errors (a symlink) is refused; a good one is added under a free name', () => {
    const src = join(tmp, 'src');
    writeDir(src, named('Quy trình PO'));
    const l = lib();
    l.boot();
    const p = l.importDir(src, true);
    expect(p).toMatchObject({ name: 'Quy trình PO (2)', description: 'gói Quy trình PO', errors: [], row: null });
    expect(readdirSync(libDir())).toEqual([]);
    const row = l.importDir(src, false).row!;
    expect(row).toMatchObject({ id: 'quy-trinh-po-2', name: 'Quy trình PO (2)' });
    symlinkSync(join(src, 'WORKFLOW.md'), join(src, 'steps', 'x.md'));
    expect(l.importDir(src, true).errors.map((e) => e.code)).toEqual(['V11']);
    expect(() => l.importDir(src, false)).toThrow('Gói có 1 lỗi');
    expect(() => l.importDir(join(tmp, 'none'), true)).toThrow('không phải thư mục');
  });
  test('v29-fw IMPORTANT-1 400 stray files → the preview ack stays < 300 KB', () => {
    const src = join(tmp, 'big');
    writeDir(src, named('Quy trình to'));
    for (let i = 0; i < 400; i++) writeFileSync(join(src, `junk-${i}.log`), 'x'.repeat(255 * 1024));
    const l = lib();
    l.boot();
    const p = l.importDir(src, true);
    expect(p.errors).toHaveLength(400);
    expect(JSON.stringify(p).length).toBeLessThan(300 * 1024);
  });
  test('v29-fw MINOR-5 a picked folder reached through a symlink is imported (its contents stay lstat-only)', () => {
    const src = join(tmp, 'real');
    writeDir(src, named('Qua link'));
    symlinkSync(src, join(tmp, 'alias'));
    const l = lib();
    l.boot();
    expect(l.importDir(join(tmp, 'alias'), true)).toMatchObject({ name: 'Qua link', errors: [] });
  });
});

describe('v2.9 R12 / §4.6 delete + apply', () => {
  test('delete: refused while a project uses it; else the folder goes to the Trash and the id is gone', () => {
    const l = lib();
    l.boot();
    const row = l.create('builtin:direct', `Xoá ${tag}`);
    l.setProject('p2', row.id);
    expect(l.list().find((r) => r.id === row.id)!.usedBy).toEqual([{ id: 'p2', name: 'two' }]);
    expect(() => l.remove(row.id)).toThrow(`"Xoá ${tag}" đang dùng ở two: đổi quy trình các project đó trước`);
    l.setProject('p2', 'builtin:po');
    const { trashed } = l.remove(row.id);
    expect(trashed.startsWith(join(tmp, 'user', '.Trash', `${row.id} `))).toBe(true);
    expect(existsSync(join(trashed, 'WORKFLOW.md'))).toBe(true);
    expect(() => workflowOf(row.id)).toThrow('không có trong thư viện');
    expect(() => l.remove('builtin:po')).toThrow('Mẫu có sẵn không xoá được');
  });

  test('apply: the project runs the pack; v29-fz its live Chung re-pins at once ("Quy trình đổi" once at the next spawn), an ended Chung / a design session keep theirs; an unknown id / project is refused', () => {
    const l = lib();
    l.boot();
    const row = l.create('builtin:direct', `Áp ${tag}`);
    const po = workflowOf('builtin:po').rev;
    for (const [id, kind] of [['g1', 'general'], ['g0', 'general'], ['d1', 'design']] as const) {
      insertSession(db, { id, projectId: 'p1', kind: 'orchestrator', account: null });
      db.query('UPDATE session SET orch_kind = ?, workflow_rev = ?, step = ? WHERE id = ?').run(kind, po, kind, id);
    }
    db.query("UPDATE session SET ended_at = 1 WHERE id = 'g0'").run();
    changes = 0;
    l.setProject('p1', row.id);
    expect(changes).toBe(1);
    expect(projectWorkflow(db, 'p1').rev).toBe(row.rev!);
    expect(['g1', 'g0', 'd1'].map((id) => revOf(id))).toEqual([row.rev!, po, po]);
    expect(spawnPrompt(db, 'g1', true).update).toStartWith('[cc-slaves] Quy trình đổi: ');
    expect(spawnPrompt(db, 'g1', true).update).toBeNull();
    expect(() => l.setProject('p1', 'nope')).toThrow('chưa có bản hợp lệ');
    expect(() => l.setProject('p9', row.id)).toThrow('Không có project p9');
  });
});
