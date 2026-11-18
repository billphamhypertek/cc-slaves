// config.json + caps.json (spec §3.4, §7.4, §7.8). Loaders never throw at boot: bad files → defaults + an error string
// the UI can show (Vietnamese, it reaches the PO). The validators return a catalog issue `{ key, params }` (v2 §6A, ns
// `config`) so a refused command renders in `ui.lang`; `issueText` is the vi text for logs / thrown Errors.
import { existsSync, readFileSync } from 'node:fs';
import { t, type Key, type Params } from '../../shared/i18n/index.ts';
import { classifyEntry } from './accounts/layout.ts';
import { paths, writeFileSecure } from './paths.ts';
import { isObj } from '../../shared/json.ts';

// ---------- config.json ----------
export interface Config {
  /** §7.4 machine-wide live lanes. */
  maxLanes: number;
  /** §3.4 lanes per account. */
  maxLanesPerAccount: number;
  /** §7.2 remote access switches itself off after this many hours. */
  remoteAutoOffHours: number;
  caffeinate: boolean;
  quotaReading: boolean;
  /** F12 / F1: lanes per account (overrides maxLanesPerAccount; 0 = none, e.g. the orchestrator account). */
  laneCaps: Record<string, number>;
  /** F24 "Không giao lane mới": the picker skips these accounts for new lanes (running lanes untouched). */
  noNewLanes: Record<string, boolean>;
  /** F12 Thông báo: notify matrix (UI-owned shape), in-app sound, volume 0–100. */
  notify: Record<string, unknown>;
  sound: boolean;
  volume: number;
  /** §8.4 reduced motion for the 3D map. */
  reducedMotion: boolean;
  /** v2 §5.2 unknown `~/.claude` entries the PO switched to "Dùng chung" (only `shared_cfg_toggle` writes it). */
  sharedExtra: string[];
  /** v2 §6A UI language (web, cards, errors, Google Chat, Tauri). Default `vi`, never guessed from macOS. */
  ui: { lang: 'vi' | 'en' };
  /** v2.2 §5.4 MCP ids (scoped, §5.1) kept out of lanes; `project:` ids the PO turned on (off by default);
   *  §6 K4 "Đăng nhập: Không": remote ids never logged in by cc-slaves (a 401 is an error, not "Cần đăng nhập"). */
  mcp: { offForLanes: string[]; projectOn: string[]; noLogin: string[] };
  /** v2.2 §5.5 skills kept out of lanes (`user:<name>` / `project:<projectId>:<name>`) and the C23 "Đã biết" map:
   *  issue id → fingerprint (accessor `skills/catalog.ts` `ackedOf` / `withAcked`). */
  skills: { offForLanes: string[]; acked: Record<string, string> };
  /** v2.2 §5.5 plugins kept out of lanes: `<plugin>@<marketplace>`. */
  plugins: { offForLanes: string[] };
  /** v2.5 §5.7 projects whose lanes do not get the graph (default empty = on for every project). */
  graph: { offProjects: string[] };
  /** v2.4 §5.6 tier 3 "Cài đặt › Model": each cell `null` = "Theo Claude Code". Never written to `~/.claude/settings.json`. */
  modelDefaults: ModelDefaults;
}

/** v2.4 §5.6 one Settings row of "Cài đặt › Model". */
interface ModelDefault { model: string | null; effort: string | null }
export interface ModelDefaults { orchestrator: ModelDefault; lane: ModelDefault }
/** v2.4 §5.6 the effort levels a Settings cell may hold. */
const EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const NO_DEFAULT: ModelDefault = Object.freeze({ model: null, effort: null });

/** v2.4 §5.6 the loader / `config_update` fill: a missing row or cell is `null` (the loader merges one level only). */
export function fillModelDefaults(v: unknown): ModelDefaults {
  const row = (r: unknown): ModelDefault => (isObj(r) ? { model: (r.model as string | null | undefined) ?? null, effort: (r.effort as string | null | undefined) ?? null } : { ...NO_DEFAULT });
  const o = isObj(v) ? v : {};
  return { orchestrator: row(o.orchestrator), lane: row(o.lane) };
}

const isModelDefaults = (x: unknown): boolean => isObj(x) && Object.entries(x).every(([k, r]) => (k === 'orchestrator' || k === 'lane') && isObj(r)
  && Object.entries(r).every(([f, c]) => c === null || (f === 'model' ? typeof c === 'string' && c.length >= 1 && c.length <= 100
    : f === 'effort' && EFFORT_LEVELS.includes(c as string))));

export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze({
  maxLanes: 8,
  maxLanesPerAccount: 3,
  remoteAutoOffHours: 12,
  caffeinate: true,
  quotaReading: true,
  laneCaps: {},
  noNewLanes: {},
  notify: {},
  sound: true,
  volume: 25,
  reducedMotion: false,
  sharedExtra: [],
  ui: Object.freeze({ lang: 'vi' as const }),
  mcp: Object.freeze({ offForLanes: [], projectOn: [], noLogin: [] }),
  skills: Object.freeze({ offForLanes: [], acked: Object.freeze({}) }),
  plugins: Object.freeze({ offForLanes: [] }),
  graph: Object.freeze({ offProjects: [] }),
  modelDefaults: Object.freeze({ orchestrator: NO_DEFAULT, lane: NO_DEFAULT }),
});

/** Object-valued keys merged per field over the defaults on load (a file may hold only some of their fields). */
const NESTED = ['ui', 'mcp', 'skills', 'plugins', 'graph'] as const;


const isStrMap = (v: unknown) => isObj(v) && Object.values(v).every((f) => typeof f === 'string');
const isInt = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

function readJsonFile(path: string): { value: unknown; error: string | null } {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')), error: null };
  } catch (e) {
    return { value: undefined, error: `Không đọc được ${path}: ${(e as Error).message}` };
  }
}

export interface ConfigIssue { key: Key; params?: Params }
/** The Vietnamese text of a validation issue (logs, loader `error`, thrown Errors). */
export const issueText = (i: ConfigIssue): string => t('vi', i.key, i.params);

/** First bad field of config.json (§6A: one keyed issue, translated per field kind), or null. */
export function validateConfig(v: unknown): ConfigIssue | null {
  if (!isObj(v)) return { key: 'config.notObject', params: { file: 'config.json' } };
  type Bad = { key: Key; min?: number; max?: number } | null;
  const int = (min: number, max: number) => (x: unknown): Bad => (isInt(x, min, max) ? null : { key: 'config.int', min, max });
  const bool = (x: unknown): Bad => (typeof x === 'boolean' ? null : { key: 'config.bool' });
  const idLists = (...keys: string[]) => (x: unknown): Bad =>
    (isObj(x) && keys.every((k) => !(k in x) || (Array.isArray(x[k]) && (x[k] as unknown[]).every((s) => typeof s === 'string'))) ? null : { key: 'config.idLists' });
  const checks: [keyof Config, (x: unknown) => Bad][] = [
    ['maxLanes', int(1, 64)],
    ['maxLanesPerAccount', int(1, 16)],
    ['remoteAutoOffHours', int(1, 168)],
    ['caffeinate', bool],
    ['quotaReading', bool],
    ['laneCaps', (x) => (isObj(x) && Object.values(x).every((n) => isInt(n, 0, 16)) ? null : { key: 'config.emailInt', min: 0, max: 16 })],
    ['noNewLanes', (x) => (isObj(x) && Object.values(x).every((b) => typeof b === 'boolean') ? null : { key: 'config.emailBool' })],
    ['notify', (x) => (isObj(x) ? null : { key: 'config.object' })],
    ['sound', bool],
    ['volume', int(0, 100)],
    ['reducedMotion', bool],
    ['ui', (x) => (isObj(x) && (x.lang === 'vi' || x.lang === 'en') ? null : { key: 'config.uiLang' })],
    ['mcp', idLists('offForLanes', 'projectOn', 'noLogin')],
    ['skills', (x) => idLists('offForLanes')(x) ?? (isObj(x) && (!('acked' in x) || isStrMap(x.acked)) ? null : { key: 'config.object' })],
    ['plugins', idLists('offForLanes')],
    ['graph', idLists('offProjects')],
    ['modelDefaults', (x) => (isModelDefaults(x) ? null : { key: 'config.modelDefaults' })],
    ['sharedExtra', (x) => (Array.isArray(x) && x.every((n) => typeof n === 'string' && /^[^/\\\0]+$/.test(n) && n !== '.' && n !== '..' && classifyEntry(n) === 'unknown') ? null : { key: 'config.sharedExtra' })],
  ];
  for (const [k, check] of checks) {
    if (!(k in v)) continue;
    const bad = check(v[k]);
    if (!bad) continue;
    const params: Params = { field: k };
    if (bad.min !== undefined && bad.max !== undefined) Object.assign(params, { min: bad.min, max: bad.max });
    return { key: bad.key, params };
  }
  return null;
}

export function loadConfig(): { config: Config; error: string | null } {
  const { config: path } = paths();
  if (!existsSync(path)) return { config: { ...DEFAULT_CONFIG }, error: null };
  const { value, error } = readJsonFile(path);
  if (error) return { config: { ...DEFAULT_CONFIG }, error };
  const bad = validateConfig(value);
  if (bad) return { config: { ...DEFAULT_CONFIG }, error: issueText(bad) };
  const v = value as Partial<Config>;
  const out = { ...DEFAULT_CONFIG };
  for (const k of Object.keys(DEFAULT_CONFIG) as (keyof Config)[]) if (k in v) (out as Record<string, unknown>)[k] = v[k];
  for (const k of NESTED) (out as Record<string, unknown>)[k] = { ...DEFAULT_CONFIG[k], ...(v[k] ?? {}) };
  out.modelDefaults = fillModelDefaults(v.modelDefaults);
  return { config: out, error: null };
}

/** v2.2 §5.1 the catalog switches of config.json. */
export function catalogPrefs(c: Pick<Config, 'mcp' | 'plugins'>): { offForLanes: string[]; projectOn: string[]; pluginsOff: string[] } {
  return { offForLanes: c.mcp.offForLanes, projectOn: c.mcp.projectOn, pluginsOff: c.plugins.offForLanes };
}

/**
 * v2.2 §5.5 what a session of `projectId` turns off in its `--settings` file: skill names (`skillOverrides`, user ones
 * and this project's) and plugin keys (`enabledPlugins: false`).
 */
export function lanesOff(c: Pick<Config, 'skills' | 'plugins'>, projectId: string): { skills: string[]; plugins: string[] } {
  const skills: string[] = [];
  for (const id of c.skills.offForLanes) {
    if (id.startsWith('user:')) skills.push(id.slice(5));
    else if (id.startsWith(`project:${projectId}:`)) skills.push(id.slice(projectId.length + 9));
  }
  return { skills, plugins: [...c.plugins.offForLanes] };
}

/** v2 §7.1-2: these two live in the `account` table (`lanes_max`, `paused`); config.json keeps everything else. */
const REGISTRY_KEYS = ['laneCaps', 'noNewLanes'] as const;

/**
 * Writes config.json without the registry keys — except while the §7.1 import has not run yet (`keepRegistryKeys`):
 * then config.json is still their only source and must keep them for the next boot's import (G1 IMPORTANT-1).
 */
export function saveConfig(c: Config, o: { keepRegistryKeys?: boolean } = {}): void {
  const bad = validateConfig(c);
  if (bad) throw new Error(issueText(bad));
  const file: Partial<Config> = { ...c };
  if (!o.keepRegistryKeys) for (const k of REGISTRY_KEYS) delete file[k];
  writeFileSecure(paths().config, `${JSON.stringify(file, null, 2)}\n`);
}

/**
 * §7.1-2 after the import: drop `laneCaps` / `noNewLanes` from config.json (one source). Leaves a missing, unreadable or
 * key-less file untouched; returns whether it rewrote the file.
 */
export function stripRegistryKeys(): boolean {
  const { config: path } = paths();
  if (!existsSync(path)) return false;
  const { value, error } = readJsonFile(path);
  if (error || !isObj(value) || !REGISTRY_KEYS.some((k) => k in value)) return false;
  for (const k of REGISTRY_KEYS) delete value[k];
  writeFileSecure(path, `${JSON.stringify(value, null, 2)}\n`);
  return true;
}

// ---------- caps.json ----------
export type Role = 'primary' | 'backup' | 'orchestrator';
export interface CapEntry { role?: Role; week: number; five?: number; hard?: boolean }
/** `default` applies under every account entry (per-field merge), exactly like the cc-lanes prototype. */
export type Caps = { default: CapEntry } & Record<string, CapEntry>;

/** Generic default only (v2 §7.1 G5): per-account caps live in the `account` table (`accounts/registry.ts`). */
export const DEFAULT_CAPS: Readonly<Caps> = Object.freeze({
  default: { week: 98, five: 95 },
});

const ROLES: readonly Role[] = ['primary', 'backup', 'orchestrator'];
const pct = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x > 0 && x <= 100;

export function validateCaps(v: unknown): ConfigIssue | null {
  if (!isObj(v)) return { key: 'config.notObject', params: { file: 'caps.json' } };
  if (!isObj(v.default)) return { key: 'config.capsNoDefault' };
  for (const [name, e] of Object.entries(v)) {
    if (!isObj(e)) return { key: 'config.capsEntry', params: { name } };
    if (!pct(e.week)) return { key: 'config.capsPct', params: { name, field: 'week' } };
    if ('five' in e && e.five !== undefined && e.five !== null && !pct(e.five)) return { key: 'config.capsPct', params: { name, field: 'five' } };
    if ('role' in e && !ROLES.includes(e.role as Role)) return { key: 'config.capsRole', params: { name } };
    if ('hard' in e && typeof e.hard !== 'boolean') return { key: 'config.capsHard', params: { name } };
  }
  return null;
}

const cloneDefaults = (): Caps => structuredClone(DEFAULT_CAPS);

export interface LoadedCaps { caps: Caps; error: string | null; imported: boolean }

/**
 * caps.json if present; else first run: import `$CLAUDE_HOME/state/cc-lanes-caps.json` (§3.4) or write the defaults.
 * A bad caps.json is left on disk untouched so the PO can fix it; the engine runs on defaults meanwhile.
 */
export function loadCaps(): LoadedCaps {
  const p = paths();
  if (existsSync(p.caps)) {
    const { value, error } = readJsonFile(p.caps);
    if (error) return { caps: cloneDefaults(), error, imported: false };
    const bad = validateCaps(value);
    return bad ? { caps: cloneDefaults(), error: issueText(bad), imported: false } : { caps: value as Caps, error: null, imported: false };
  }
  if (existsSync(p.legacyCaps)) {
    const { value, error } = readJsonFile(p.legacyCaps);
    const issue = error ? null : validateCaps(value);
    const bad = error ?? (issue && issueText(issue));
    if (bad) return { caps: cloneDefaults(), error: `Không nhập được ngưỡng cũ: ${bad}`, imported: false };
    saveCaps(value as Caps);
    return { caps: value as Caps, error: null, imported: true };
  }
  const caps = cloneDefaults();
  saveCaps(caps);
  return { caps, error: null, imported: false };
}

export function saveCaps(c: Caps): void {
  const bad = validateCaps(c);
  if (bad) throw new Error(issueText(bad));
  writeFileSecure(paths().caps, `${JSON.stringify(c, null, 2)}\n`);
}

export interface ResolvedCaps {
  role: Role;
  hard: boolean;
  week: number;
  five: number | null;
  /** Leave the account when week_pct ≥ this (hard: cap − 1). */
  weekLeaveAt: number;
  /**
   * A new lane may be placed only when week_pct ≤ this AND week_pct < weekLeaveAt (hard: cap − 3; soft: the cap, so a
   * soft account takes new lanes right up to where it leaves — cc-lanes behaviour).
   */
  weekAdmitMax: number;
  /** 5h is always soft (D6): leave at the cap itself. */
  fiveLeaveAt: number | null;
}

export function resolveCaps(caps: Caps, email: string): ResolvedCaps {
  const m: CapEntry = { role: 'primary', hard: false, ...caps.default, ...(caps[email] ?? {}) };
  const hard = m.hard === true;
  const five = m.five ?? null;
  return {
    role: m.role ?? 'primary',
    hard,
    week: m.week,
    five,
    weekLeaveAt: hard ? m.week - 1 : m.week,
    weekAdmitMax: hard ? m.week - 3 : m.week,
    fiveLeaveAt: five,
  };
}
