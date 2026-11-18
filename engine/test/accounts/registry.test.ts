import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAPS_IMPORTED_KEY, deleteAccount, getAccount, importAtBoot, importFromCaps, keychainService, listAccounts, newAccountId, normEmail,
  registryCaps, registryLaneConfig, upsertAccount, usableAccounts, writeCaps, writeLaneConfig,
} from '../../src/accounts/registry.ts';
import { assertDeletableAccountDir } from '../../src/accounts/layout.ts';
import { DEFAULT_CAPS, resolveCaps, type Caps } from '../../src/config.ts';
import { MIGRATIONS, getMeta, migrate, openDb, type Db } from '../../src/db.ts';
import { PO_CAPS } from '../_fixtures/po-caps.ts';

let tmp: string;
let db: Db;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-reg-'));
  db = openDb(join(tmp, 'state.db'));
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const PO_CONFIG = { laneCaps: { 'bo@example.org': 0, 'pm@example.net': 2 }, noNewLanes: { 'ba@example.net': true } };

describe('§7 account table migration', () => {
  test('§7.1 migration on a v1 db (user_version 5) keeps every row and adds an empty account table', () => {
    const old = new Database(':memory:', { strict: true });
    for (const m of MIGRATIONS.slice(0, 5)) old.exec(m);
    old.exec('PRAGMA user_version = 5');
    old.run("INSERT INTO project (id, name, path, created_at) VALUES ('p1','one','/r/one',1)");
    old.run("INSERT INTO session (id, project_id, kind, account, created_at) VALUES ('s1','p1','lane','pm@example.net',2)");
    old.run("INSERT INTO run (session_id, n, account, started_at) VALUES ('s1',1,'pm@example.net',3)");
    old.run("INSERT INTO quota (account, week_pct, source, fetched_at, status) VALUES ('pm@example.net',40,'api',4,'ok')");
    old.run("INSERT INTO meta (key, value) VALUES ('po_email','bo@example.org')");
    // v9 (D18) drops project.permission_mode; `prepare` (uncached) so the post-migration read sees the new columns
    const before = ['project', 'session', 'run', 'quota', 'meta'].map((t) => old.prepare<Record<string, unknown>, []>(`SELECT * FROM ${t}`).all())
      .map((rows, i) => (i === 0 ? rows.map(({ permission_mode: _pm, ...r }) => r) : i === 1 ? rows.map(({ prompt_version: _v, ...r }) => r) : rows)); // v25 drops session.prompt_version
    migrate(old);
    migrate(old);
    expect(old.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(MIGRATIONS.length);
    // v13+ (v2.1 §4.14), v19 (v2.4 §5.1) and v23 (v2.7 orch_kind) add session columns (seq / opened_at backfilled, the rest null): compare the columns that existed before
    const v13 = ['seq', 'title', 'end_reason', 'handoff_path', 'ctx_last', 'account_home', 'opened_at', 'model_pick', 'effort_pick', 'last_model', 'last_model_name', 'last_effort', 'orch_kind', 'cwd', 'step', 'workflow_rev', 'prompt_hash'];
    expect(['project', 'session', 'run', 'quota', 'meta'].map((t) => old.prepare<Record<string, unknown>, []>(`SELECT * FROM ${t}`).all()
      .map((r) => (t === 'session' ? Object.fromEntries(Object.entries(r).filter(([k]) => !v13.includes(k)))
        : t === 'project' ? Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'closed_at' && k !== 'workflow' && k !== 'workflow_fallback'))
          : t === 'quota' ? Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'five_window')) : r)))).toEqual(before); // v21 closed_at (hotfix 2026-11-16), v24 five_window (v2.7.1 D103), v25 workflow (v2.9 §6.1), v27 workflow_fallback (hf-sp)
    expect(old.query('SELECT * FROM account').all()).toEqual([]);
    const cols = old.query<{ name: string; notnull: number }, []>('PRAGMA table_info(account)').all();
    expect(cols.map((c) => c.name).sort()).toEqual([
      'account_uuid', 'added_at', 'dir', 'email', 'five', 'hard', 'id', 'lanes_max', 'last_auth_check', 'org_uuid',
      'paused', 'plan', 'role', 'status', 'terminal', 'tier', 'updated_at', 'week', // terminal: v22 (hf1116)
    ]);
    // §7: a v1 row without a login has no dir / uuid / caps — every such column must be nullable.
    const notNull = cols.filter((c) => c.notnull === 1).map((c) => c.name).sort();
    expect(notNull).toEqual(['added_at', 'paused', 'terminal', 'updated_at']); // terminal: DEFAULT 0 (v22)
    old.close();
  });

  test('§7 role CHECK rejects an unknown role', () => {
    expect(() => db.run("INSERT INTO account (email, role, added_at, updated_at) VALUES ('a@x','boss',1,1)")).toThrow();
  });
});

describe('§7.1 importFromCaps', () => {
  test('§7.1 maps every caps.json field + accountLanes + accountsPaused, one row per email, no dir', () => {
    const r = importFromCaps(db, PO_CAPS, PO_CONFIG, 1000);
    expect(r).toEqual({ imported: true, count: 5 });
    expect(getAccount(db, 'bo@example.org')).toMatchObject({
      email: 'bo@example.org', dir: null, id: null, role: 'orchestrator', week: 99, five: 97, hard: null, lanesMax: 0, paused: false,
      addedAt: 1000, updatedAt: 1000,
    });
    expect(getAccount(db, 'pm@example.net')).toMatchObject({ role: 'primary', week: 99, five: null, hard: null, lanesMax: 2 });
    expect(getAccount(db, 'dev2609@example.com')).toMatchObject({ role: 'primary', week: 60, five: null, hard: true, lanesMax: null });
    expect(getAccount(db, 'ba@example.net')).toMatchObject({ role: 'backup', week: 70, five: 95, hard: true, paused: true });
    expect(listAccounts(db).map((a) => a.email)).toEqual([
      'ba@example.net', 'bo24990@example.com', 'bo@example.org', 'dev2609@example.com', 'pm@example.net',
    ]);
    expect(getMeta(db, CAPS_IMPORTED_KEY)).toBe('1000');
  });

  test('§7.1 caps values preserved exactly: the adapter resolves every email the same as caps.json did', () => {
    importFromCaps(db, PO_CAPS, PO_CONFIG, 1);
    const back = registryCaps(db);
    expect(back).toEqual(PO_CAPS);
    for (const email of [...Object.keys(PO_CAPS), 'new@x']) expect(resolveCaps(back, email)).toEqual(resolveCaps(PO_CAPS, email));
    expect(registryLaneConfig(db)).toEqual(PO_CONFIG);
  });

  test('§7.1 a fractional cap (98.5) survives the round trip', () => {
    importFromCaps(db, { default: { week: 98 }, 'a@x': { week: 98.5, five: 12.25 } }, undefined, 1);
    expect(getAccount(db, 'a@x')).toMatchObject({ week: 98.5, five: 12.25 });
  });

  test('§7.1 an email only in accountLanes / accountsPaused still gets a row (caps inherited)', () => {
    importFromCaps(db, { default: { week: 98, five: 95 } }, { laneCaps: { 'l@x': 1 }, noNewLanes: { 'p@x': true, 'q@x': false } }, 1);
    expect(getAccount(db, 'l@x')).toMatchObject({ role: null, week: null, lanesMax: 1, paused: false });
    expect(getAccount(db, 'p@x')).toMatchObject({ paused: true });
    expect(getAccount(db, 'q@x')).toMatchObject({ paused: false });
    expect(registryCaps(db)).toEqual({ default: { week: 98, five: 95 } });
  });

  test('§7.1 second boot does not re-import nor overwrite PO edits', () => {
    importFromCaps(db, PO_CAPS, PO_CONFIG, 1);
    upsertAccount(db, { email: 'pm@example.net', week: 80, dir: '/acc/pm' }, 2);
    const again = importFromCaps(db, { default: { week: 50 }, 'pm@example.net': { week: 10 }, 'new@x': { week: 33 } }, PO_CONFIG, 3);
    expect(again).toEqual({ imported: false, count: 0 });
    expect(getAccount(db, 'pm@example.net')).toMatchObject({ week: 80, dir: '/acc/pm', updatedAt: 2 });
    expect(getAccount(db, 'new@x')).toBeNull();
    expect(registryCaps(db).default).toEqual(PO_CAPS.default);
    expect(getMeta(db, CAPS_IMPORTED_KEY)).toBe('1');
  });

  test('§7.1 marker survives a db reopen (idempotent across boots)', () => {
    importFromCaps(db, PO_CAPS, PO_CONFIG, 1);
    db.close();
    db = openDb(join(tmp, 'state.db'));
    expect(importFromCaps(db, PO_CAPS, PO_CONFIG, 2).imported).toBe(false);
    expect(listAccounts(db)).toHaveLength(5);
  });

  test('§7.1 import never overwrites a row that already exists (registered before the import ran)', () => {
    upsertAccount(db, { email: 'pm@example.net', dir: '/acc/pm', week: 75 }, 5);
    importFromCaps(db, PO_CAPS, PO_CONFIG, 9);
    expect(getAccount(db, 'pm@example.net')).toMatchObject({ dir: '/acc/pm', week: 75, updatedAt: 5 });
  });

  test('§7.1 unknown fields ignored, invalid values dropped, non-object entries skipped', () => {
    const caps = {
      default: { week: 97, five: 90, colour: 'red' },
      'a@x': { role: 'backup', week: 70, five: null, hard: true, nickname: 'A', accountLanes: 4 },
      'b@x': { role: 'boss', week: 500, five: 'x', hard: 'yes' },
      'c@x': 'not an object',
      version: 3,
    } as unknown;
    const r = importFromCaps(db, caps, { laneCaps: { 'a@x': 99, 'd@x': -1, 'e@x': 'two' } as never, extra: 1 } as never, 1);
    expect(r.count).toBe(2);
    expect(getAccount(db, 'a@x')).toMatchObject({ role: 'backup', week: 70, five: null, hard: true, lanesMax: null });
    expect(getAccount(db, 'b@x')).toMatchObject({ role: null, week: null, five: null, hard: null });
    expect(getAccount(db, 'c@x')).toBeNull();
    expect(getAccount(db, 'version')).toBeNull();
    expect(registryCaps(db).default).toEqual({ week: 97, five: 90 });
  });

  test('§7.1 garbage caps (not an object / no default) → generic default, still marked imported', () => {
    expect(importFromCaps(db, 'garbage', undefined, 1)).toEqual({ imported: true, count: 0 });
    expect(registryCaps(db)).toEqual({ default: DEFAULT_CAPS.default });
    expect(importFromCaps(db, PO_CAPS, undefined, 2).imported).toBe(false);
  });

  test('§7.1 D25 email case / whitespace normalised; same email twice → one row', () => {
    importFromCaps(db, {
      default: { week: 98 },
      ' PM@Example.Net ': { role: 'backup', week: 70 },
      'pm@example.net': { week: 60, hard: true },
    }, { laneCaps: { 'Pm@EXAMPLE.net': 1 }, noNewLanes: { '  pm@example.net': true } }, 1);
    const rows = listAccounts(db);
    expect(rows).toHaveLength(1);
    // later spelling wins per field, missing fields kept from the earlier one
    expect(rows[0]).toMatchObject({ email: 'pm@example.net', role: 'backup', week: 60, hard: true, lanesMax: 1, paused: true });
  });
});

describe('§7 registry CRUD', () => {
  test('§7 D25 upsert by email: normalised key, partial update keeps other fields, updated_at moves', () => {
    const a = upsertAccount(db, { email: ' A@X ', role: 'primary', week: 99, lanesMax: 3 }, 10);
    expect(a).toMatchObject({ email: 'a@x', role: 'primary', week: 99, lanesMax: 3, paused: false, addedAt: 10, updatedAt: 10 });
    const b = upsertAccount(db, { email: 'a@X', dir: '/acc/a', accountUuid: 'u1', orgUuid: 'o1', paused: true }, 20);
    expect(b).toMatchObject({ email: 'a@x', role: 'primary', week: 99, lanesMax: 3, dir: '/acc/a', accountUuid: 'u1', orgUuid: 'o1', paused: true, addedAt: 10, updatedAt: 20 });
    const c = upsertAccount(db, { email: 'a@x', five: null, week: null }, 30);
    expect(c).toMatchObject({ week: null, five: null, role: 'primary' });
    expect(listAccounts(db)).toHaveLength(1);
  });

  test('§7 dir stored verbatim (SA4), id unique', () => {
    upsertAccount(db, { email: 'a@x', id: 'k1', dir: '/Users/x/.cc-slaves-accounts/k1/' }, 1);
    expect(getAccount(db, 'a@x')?.dir).toBe('/Users/x/.cc-slaves-accounts/k1/');
    expect(() => upsertAccount(db, { email: 'b@x', id: 'k1' }, 1)).toThrow();
  });

  test('§7 delete by normalised email', () => {
    upsertAccount(db, { email: 'a@x' }, 1);
    expect(deleteAccount(db, ' A@x')).toBe(true);
    expect(deleteAccount(db, 'a@x')).toBe(false);
    expect(getAccount(db, 'a@x')).toBeNull();
  });

  test('§7 adapter: role/caps omitted when null; laneCaps/noNewLanes only for set values', () => {
    upsertAccount(db, { email: 'a@x', lanesMax: 0 }, 1);
    upsertAccount(db, { email: 'b@x', role: 'backup', week: 70, five: 90, hard: false, paused: true }, 1);
    const caps: Caps = registryCaps(db);
    expect(caps).toEqual({ default: DEFAULT_CAPS.default, 'b@x': { role: 'backup', week: 70, five: 90, hard: false } });
    expect(registryLaneConfig(db)).toEqual({ laneCaps: { 'a@x': 0 }, noNewLanes: { 'b@x': true } });
  });

  test('normEmail trims and lowercases', () => {
    expect(normEmail('  Foo@Bar.TEST\n')).toBe('foo@bar.test');
  });
});

describe('§7.1 importAtBoot', () => {
  const okCfg = { config: { laneCaps: { 'pm@example.net': 2 }, noNewLanes: {} }, error: null };
  test('§7.1 first v2 boot imports the loaded caps + config', () => {
    expect(importAtBoot(db, { caps: PO_CAPS, error: null }, okCfg, 1)).toEqual({ imported: true, count: 5 });
    expect(getAccount(db, 'pm@example.net')?.lanesMax).toBe(2);
  });
  test('§7.1 caps.json or config.json failed to load → skip (no marker), retried on the next boot', () => {
    expect(importAtBoot(db, { caps: DEFAULT_CAPS, error: 'bad caps' }, okCfg, 1)).toEqual({ imported: false, count: 0 });
    expect(importAtBoot(db, { caps: PO_CAPS, error: null }, { ...okCfg, error: 'bad config' }, 1)).toEqual({ imported: false, count: 0 });
    expect(getMeta(db, CAPS_IMPORTED_KEY)).toBeNull();
    expect(importAtBoot(db, { caps: PO_CAPS, error: null }, okCfg, 2).imported).toBe(true);
  });
});

describe('§5.1 account id + §7 usable accounts (T3)', () => {
  test('§5.1 id is 12 lowercase hex, assigned when a row first gets dir, never changed after', () => {
    upsertAccount(db, { email: 'a@x', week: 70 }, 1);
    expect(getAccount(db, 'a@x')?.id).toBeNull();
    const first = upsertAccount(db, { email: 'a@x', dir: join(tmp, 'acc', 'one') }, 2).id;
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    expect(upsertAccount(db, { email: 'a@x', dir: join(tmp, 'acc', 'two') }, 3).id).toBe(first);
    expect(newAccountId()).not.toBe(newAccountId());
  });

  test('§5.1 a generated id passes the T1 safe-delete guard (<root>/<12 hex>)', () => {
    const root = join(realpathSync(tmp), 'accts');
    mkdirSync(root);
    const id = newAccountId();
    expect(() => assertDeletableAccountDir(join(root, id), root)).not.toThrow();
  });

  test('§7 usable account = row with dir; its config dir is dir verbatim; dir-less (v1 import) rows are not usable', () => {
    upsertAccount(db, { email: 'old@x', role: 'primary', week: 90 }, 1);
    upsertAccount(db, { email: 'b@x', dir: '/r/bbb/', plan: 'max' }, 1);
    const list = usableAccounts(db);
    expect(list.map((a) => a.email)).toEqual(['b@x']);
    expect(list[0]).toMatchObject({ configDir: '/r/bbb/', keychainService: keychainService('/r/bbb/'), planTier: 'max' });
    expect(list[0]!.id).toMatch(/^[0-9a-f]{12}$/);
  });

  test('§7.1-2 caps_update path: writeCaps replaces role/caps per email (absent → NULL), keeps default in meta', () => {
    upsertAccount(db, { email: 'a@x', dir: '/r/aaa', role: 'backup', week: 70, five: 80, hard: true, lanesMax: 2 }, 1);
    writeCaps(db, { default: { week: 90, five: 85 }, 'b@x': { role: 'orchestrator', week: 99 } });
    expect(getAccount(db, 'a@x')).toMatchObject({ role: null, week: null, five: null, hard: null, lanesMax: 2 });
    expect(registryCaps(db)).toEqual({ default: { week: 90, five: 85 }, 'b@x': { role: 'orchestrator', week: 99 } });
  });

  test('§7.1-2 config_update path: writeLaneConfig replaces only the keys given', () => {
    upsertAccount(db, { email: 'a@x', dir: '/r/aaa', lanesMax: 1, paused: true }, 1);
    writeLaneConfig(db, { laneCaps: { 'B@x': 0 } });
    expect(registryLaneConfig(db)).toEqual({ laneCaps: { 'b@x': 0 }, noNewLanes: { 'a@x': true } });
    writeLaneConfig(db, { noNewLanes: { 'a@x': false } });
    expect(registryLaneConfig(db)).toEqual({ laneCaps: { 'b@x': 0 }, noNewLanes: {} });
  });

  // IMPORTANT-2 (G1 review), §7.1-3 "ngưỡng cũ được giữ": Settings › Account sends only usable (dir) rows; a dir-less
  // imported row keeps role / caps / lane cap / pause until it is named.
  test('IMPORTANT-2 §7.1-3 a save naming only usable emails keeps every not-yet-logged-in row', () => {
    importFromCaps(db, PO_CAPS, { laneCaps: { 'bo@example.org': 0 }, noNewLanes: { 'dev2609@example.com': true } }, 1);
    upsertAccount(db, { email: 'pm@example.net', dir: '/r/abcdef012345' }, 2);
    const dirless = () => listAccounts(db).filter((a) => a.dir === null)
      .map(({ email, role, week, five, hard, lanesMax, paused }) => ({ email, role, week, five, hard, lanesMax, paused }));
    const before = dirless();
    expect(before.find((a) => a.email === 'bo@example.org')).toMatchObject({ role: 'orchestrator', lanesMax: 0 });
    const rows = usableAccounts(db).map((a) => a.email);
    writeCaps(db, { default: { week: 98, five: 95 }, ...Object.fromEntries(rows.map((e) => [e, { role: 'primary', week: 99, hard: false }])) });
    writeLaneConfig(db, { laneCaps: Object.fromEntries(rows.map((e) => [e, 3])), noNewLanes: {} });
    expect(dirless()).toEqual(before);
    expect(getAccount(db, 'pm@example.net')).toMatchObject({ role: 'primary', week: 99, hard: false, lanesMax: 3 });
    // an empty save (the cutover case) also keeps them; a dir-less row that IS named changes
    writeCaps(db, { default: { week: 98 }, 'ba@example.net': { role: 'backup', week: 50 } });
    writeLaneConfig(db, { laneCaps: {}, noNewLanes: {} });
    expect(getAccount(db, 'bo@example.org')).toMatchObject({ role: 'orchestrator', lanesMax: 0 });
    expect(getAccount(db, 'dev2609@example.com')!.paused).toBe(true);
    expect(getAccount(db, 'ba@example.net')).toMatchObject({ role: 'backup', week: 50, hard: null });
    expect(getAccount(db, 'pm@example.net')).toMatchObject({ role: null, week: null, lanesMax: null });
  });
});
