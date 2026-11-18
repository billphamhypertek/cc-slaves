// Account registry (v2 spec §7, §7.1, D25): the `account` table in state.db, keyed by normalised email. The single
// source of accounts (a row with `dir` = usable), roles/caps (`registryCaps`) and lane limits (`registryLaneConfig`);
// `caps_update` / `config_update` write here (`writeCaps` / `writeLaneConfig`). caps.json is read once, at the import.
import { createHash, randomBytes } from 'node:crypto';
import { DEFAULT_CAPS, type CapEntry, type Caps, type Config, type Role } from '../config.ts';
import { getMeta, setMeta, type Db } from '../db.ts';
import { isObj } from '../../../shared/json.ts';

/** meta key: set (to the import time, epoch s) once the v1 caps.json import has run — never re-imported after. */
export const CAPS_IMPORTED_KEY = 'v2_caps_imported';
/** meta key: the generic `default` caps entry (JSON), taken from caps.json at import. */
const CAPS_DEFAULT_KEY = 'caps_default';

export interface AccountRow {
  email: string;
  id: string | null;
  dir: string | null;
  accountUuid: string | null;
  orgUuid: string | null;
  plan: string | null;
  tier: string | null;
  role: Role | null;
  week: number | null;
  five: number | null;
  hard: boolean | null;
  lanesMax: number | null;
  paused: boolean;
  status: string | null;
  addedAt: number;
  updatedAt: number;
  lastAuthCheck: number | null;
  /** hf1116: the terminal's own login (`dir` = `~/.claude`, default Keychain item, CLAUDE_CONFIG_DIR unset). */
  terminal: boolean;
}

interface DbRow {
  email: string; id: string | null; dir: string | null; account_uuid: string | null; org_uuid: string | null;
  plan: string | null; tier: string | null; role: Role | null; week: number | null; five: number | null;
  hard: number | null; lanes_max: number | null; paused: number; status: string | null; added_at: number;
  updated_at: number; last_auth_check: number | null; terminal: number;
}

const toRow = (r: DbRow): AccountRow => ({
  email: r.email, id: r.id, dir: r.dir, accountUuid: r.account_uuid, orgUuid: r.org_uuid, plan: r.plan, tier: r.tier,
  role: r.role, week: r.week, five: r.five, hard: r.hard === null ? null : r.hard === 1, lanesMax: r.lanes_max,
  paused: r.paused === 1, status: r.status, addedAt: r.added_at, updatedAt: r.updated_at, lastAuthCheck: r.last_auth_check,
  terminal: r.terminal === 1,
});

/** Writable fields → column. `email` is the key and never updated. */
const COLS = {
  id: 'id', dir: 'dir', accountUuid: 'account_uuid', orgUuid: 'org_uuid', plan: 'plan', tier: 'tier', role: 'role',
  week: 'week', five: 'five', hard: 'hard', lanesMax: 'lanes_max', paused: 'paused', status: 'status',
  lastAuthCheck: 'last_auth_check', terminal: 'terminal',
} as const satisfies Partial<Record<keyof AccountRow, string>>;

export type AccountPatch = { email: string } & Partial<Pick<AccountRow, keyof typeof COLS>>;

const nowS = () => Math.floor(Date.now() / 1000);

/** §5.1 account id: 12 random lowercase hex, never renamed (T1 safe delete accepts only `<root>/<12 hex>`). */
export const newAccountId = (): string => randomBytes(6).toString('hex');

export const DEFAULT_KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** Same derivation as reference/cc-lanes.mjs: sha256 of the exact config-dir string, first 8 hex chars. */
export function keychainService(configDir: string | null): string {
  return configDir
    ? `${DEFAULT_KEYCHAIN_SERVICE}-${createHash('sha256').update(configDir).digest('hex').slice(0, 8)}`
    : DEFAULT_KEYCHAIN_SERVICE;
}

/** A usable account (a registry row with `dir`): every session on it runs with CLAUDE_CONFIG_DIR = `configDir` (§5.4). */
export interface Account {
  email: string;
  /** §5.1 12-hex id; null only for a row written before T3 assigned ids. */
  id: string | null;
  /** The row's `dir`, verbatim (§3.2 SA4: the Keychain item name hashes this exact string). */
  configDir: string;
  keychainService: string;
  planTier: string | null;
  /** hf1116: the terminal login — `configDir` is `~/.claude` itself, so CLAUDE_CONFIG_DIR stays unset (else the Keychain
   *  item name would hash the path and miss the default item) and no shared-config link / mirror applies. */
  terminal: boolean;
}

/** D25: one email = one account; case and surrounding whitespace never make a second one. */
export const normEmail = (e: string): string => e.trim().toLowerCase();

const toDb = (v: unknown): string | number | null =>
  v === null || v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : (v as string | number);

export function getAccount(db: Db, email: string): AccountRow | null {
  const r = db.query<DbRow, [string]>('SELECT * FROM account WHERE email = ?').get(normEmail(email));
  return r ? toRow(r) : null;
}

export function listAccounts(db: Db): AccountRow[] {
  return db.query<DbRow, []>('SELECT * FROM account ORDER BY email').all().map(toRow);
}

/** Insert or update by email; only the fields present in `p` are written (an explicit `null` clears one). */
export function upsertAccount(db: Db, p: AccountPatch, at: number = nowS()): AccountRow {
  const email = normEmail(p.email);
  // §5.1: the id is born with the first `dir`, and never changes after.
  if (p.dir && p.id === undefined && !getAccount(db, email)?.id) p = { ...p, id: newAccountId() };
  const keys = (Object.keys(COLS) as (keyof typeof COLS)[]).filter((k) => k in p && p[k] !== undefined);
  const cols = keys.map((k) => COLS[k]);
  const vals = keys.map((k) => toDb(p[k]));
  const set = ['updated_at = excluded.updated_at', ...cols.map((c) => `${c} = excluded.${c}`)].join(', ');
  const row = db.query<DbRow, (string | number | null)[]>(
    `INSERT INTO account (email, ${[...cols, 'added_at', 'updated_at'].join(', ')})
     VALUES (${['?', ...cols.map(() => '?'), '?', '?'].join(', ')})
     ON CONFLICT(email) DO UPDATE SET ${set} RETURNING *`,
  ).get(email, ...vals, at, at);
  return toRow(row!);
}

/** §7: the accounts the engine can run sessions on — rows with `dir` (a v1-imported row has none until its login). */
export function usableAccounts(db: Db): Account[] {
  return listAccounts(db).filter((a) => a.dir !== null).map((a) => ({
    email: a.email, id: a.id, configDir: a.dir!, keychainService: a.terminal ? DEFAULT_KEYCHAIN_SERVICE : keychainService(a.dir),
    planTier: a.tier ?? a.plan, terminal: a.terminal,
  }));
}

/** meta key: terminal-login emails the PO removed from cc-slaves ("Xoá"); the boot / refresh detection skips them. */
const TERMINAL_DISMISSED_KEY = 'terminal_dismissed';

export function terminalDismissed(db: Db): Set<string> {
  try { return new Set(JSON.parse(getMeta(db, TERMINAL_DISMISSED_KEY) ?? '[]') as string[]); } catch { return new Set(); }
}

const writeDismissed = (db: Db, s: Set<string>) => setMeta(db, TERMINAL_DISMISSED_KEY, JSON.stringify([...s].sort()));

/** hf1116 T3 "Xoá" on the terminal account: only the row goes; this keeps the detection from adding it back. */
export function dismissTerminal(db: Db, email: string): void {
  const s = terminalDismissed(db);
  s.add(normEmail(email));
  writeDismissed(db, s);
}

/** hf1116 T3: a later cc-slaves login of that email clears the dismissal. */
export function undismissTerminal(db: Db, email: string): void {
  const s = terminalDismissed(db);
  if (s.delete(normEmail(email))) writeDismissed(db, s);
}

/** §6 A2: when `claude auth status` last finished. UPDATE only — a row removed meanwhile is never re-created. */
export function setLastAuthCheck(db: Db, email: string, at: number): void {
  db.query('UPDATE account SET last_auth_check = ? WHERE email = ?').run(at, normEmail(email));
}

export function deleteAccount(db: Db, email: string): boolean {
  return db.query('DELETE FROM account WHERE email = ?').run(normEmail(email)).changes > 0;
}

// ---------- §7.1 one-time import from caps.json ----------
const pct = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0 && x <= 100;
const ROLES: readonly Role[] = ['primary', 'backup', 'orchestrator'];
const laneCap = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 16;

type Imported = Partial<Pick<AccountRow, 'role' | 'week' | 'five' | 'hard' | 'lanesMax' | 'paused'>>;

/** Only the fields caps.json defines, only when valid; anything else is ignored. */
function capFields(e: Record<string, unknown>): Imported {
  const out: Imported = {};
  if (ROLES.includes(e.role as Role)) out.role = e.role as Role;
  if (pct(e.week)) out.week = e.week;
  if (pct(e.five)) out.five = e.five;
  if (typeof e.hard === 'boolean') out.hard = e.hard;
  return out;
}

/**
 * §7.1: on the first v2 boot, copy caps.json (role, week/5h caps, hard) plus config `laneCaps` (accountLanes) and
 * `noNewLanes` (accountsPaused) into the `account` table, one row per normalised email, no `dir`. Runs once (marker in
 * `meta`); never overwrites a row that already exists. Same email spelled twice → merged, later spelling wins per field.
 */
export function importFromCaps(
  db: Db, caps: unknown, config?: Partial<Pick<Config, 'laneCaps' | 'noNewLanes'>>, at: number = nowS(),
): { imported: boolean; count: number } {
  return db.transaction(() => {
    if (getMeta(db, CAPS_IMPORTED_KEY) !== null) return { imported: false, count: 0 };
    const merged = new Map<string, Imported>();
    const add = (raw: string, f: Imported) => {
      const k = normEmail(raw);
      if (!k) return;
      merged.set(k, { ...(merged.get(k) ?? {}), ...f });
    };
    if (isObj(caps)) {
      if (isObj(caps.default) && pct(caps.default.week)) {
        const d: CapEntry = { week: caps.default.week };
        if (pct(caps.default.five)) d.five = caps.default.five;
        setMeta(db, CAPS_DEFAULT_KEY, JSON.stringify(d));
      }
      for (const [email, e] of Object.entries(caps)) if (email !== 'default' && isObj(e)) add(email, capFields(e));
    }
    if (isObj(config?.laneCaps)) for (const [email, n] of Object.entries(config.laneCaps)) if (laneCap(n)) add(email, { lanesMax: n });
    if (isObj(config?.noNewLanes)) for (const [email, b] of Object.entries(config.noNewLanes)) if (typeof b === 'boolean') add(email, { paused: b });
    let count = 0;
    for (const [email, f] of merged) {
      if (getAccount(db, email)) continue;
      upsertAccount(db, { email, ...f }, at);
      count++;
    }
    setMeta(db, CAPS_IMPORTED_KEY, String(at));
    return { imported: true, count };
  })();
}

// ---------- thin adapter: today's picker shapes, read from the table (T3 rewires call sites) ----------
function capsDefault(db: Db): CapEntry {
  const raw = getMeta(db, CAPS_DEFAULT_KEY);
  if (raw) {
    try {
      const v = JSON.parse(raw) as unknown;
      if (isObj(v) && pct(v.week)) return { week: v.week, ...(pct(v.five) ? { five: v.five } : {}) };
    } catch { /* fall through to the generic default */ }
  }
  return { ...DEFAULT_CAPS.default };
}

/** `Caps` as caps.json would have held it: only the fields set on a row (NULL = inherit `default`). */
export function registryCaps(db: Db): Caps {
  const caps = { default: capsDefault(db) } as Caps;
  for (const a of listAccounts(db)) {
    const e: Partial<CapEntry> = {};
    if (a.role !== null) e.role = a.role;
    if (a.week !== null) e.week = a.week;
    if (a.five !== null) e.five = a.five;
    if (a.hard !== null) e.hard = a.hard;
    if (Object.keys(e).length) caps[a.email] = e as CapEntry;
  }
  return caps;
}

/** `Config.laneCaps` / `Config.noNewLanes` as v1 kept them, from `lanes_max` / `paused`. */
export function registryLaneConfig(db: Db): Pick<Config, 'laneCaps' | 'noNewLanes'> {
  const laneCaps: Record<string, number> = {};
  const noNewLanes: Record<string, boolean> = {};
  for (const a of listAccounts(db)) {
    if (a.lanesMax !== null) laneCaps[a.email] = a.lanesMax;
    if (a.paused) noNewLanes[a.email] = true;
  }
  return { laneCaps, noNewLanes };
}

/**
 * Rows a save may clear when absent from its payload: only usable ones (with `dir`). The UI lists only those, so a
 * dir-less imported row keeps its v1 values until named (§7.1-3 "ngưỡng cũ được giữ", G1 IMPORTANT-2).
 */
function clearable(db: Db): string[] {
  return listAccounts(db).filter((a) => a.dir !== null).map((a) => a.email);
}

/**
 * `caps_update` (§7.1-2 one source): the caps map replaces role/week/five/hard on every usable row — a usable email
 * absent from `caps` gets NULLs (inherits `default`); a dir-less row changes only when named; a new email gets a
 * dir-less row; `default` goes to meta.
 */
export function writeCaps(db: Db, caps: Caps, at: number = nowS()): void {
  db.transaction(() => {
    setMeta(db, CAPS_DEFAULT_KEY, JSON.stringify(caps.default));
    const given = new Map<string, CapEntry>();
    for (const [k, e] of Object.entries(caps)) if (k !== 'default') given.set(normEmail(k), e);
    const emails = new Set([...clearable(db), ...given.keys()]);
    for (const email of emails) {
      const e = given.get(email);
      upsertAccount(db, { email, role: e?.role ?? null, week: e?.week ?? null, five: e?.five ?? null, hard: e?.hard ?? null }, at);
    }
  })();
}

/**
 * `config_update` (§7.1-2): `laneCaps` → `lanes_max`, `noNewLanes` → `paused`; each key given replaces that column on
 * every usable row; a dir-less row changes only when named (G1 IMPORTANT-2).
 */
export function writeLaneConfig(db: Db, patch: Partial<Pick<Config, 'laneCaps' | 'noNewLanes'>>, at: number = nowS()): void {
  db.transaction(() => {
    const norm = <T>(m: Record<string, T>) => new Map(Object.entries(m).map(([k, v]) => [normEmail(k), v] as const));
    const lanes = patch.laneCaps ? norm(patch.laneCaps) : null;
    const paused = patch.noNewLanes ? norm(patch.noNewLanes) : null;
    const emails = new Set([...clearable(db), ...(lanes?.keys() ?? []), ...(paused?.keys() ?? [])]);
    for (const email of emails) {
      const p: AccountPatch = { email };
      if (lanes) p.lanesMax = lanes.get(email) ?? null;
      if (paused) p.paused = paused.get(email) === true;
      upsertAccount(db, p, at);
    }
  })();
}

/**
 * §7.1 boot hook: import only when both files loaded cleanly. A broken caps.json / config.json makes the loaders fall
 * back to defaults; importing those would set the marker and lose the PO's real values, so wait for the next boot.
 */
export function importAtBoot(
  db: Db, caps: { caps: Caps; error: string | null },
  config: { config: Partial<Pick<Config, 'laneCaps' | 'noNewLanes'>>; error: string | null }, at: number = nowS(),
): { imported: boolean; count: number } {
  if (caps.error || config.error) return { imported: false, count: 0 };
  return importFromCaps(db, caps.caps, config.config, at);
}
