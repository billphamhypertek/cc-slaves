// v2.2 §5.4 writes to the source (`~/.claude.json` user `mcpServers`) only through `claude mcp add-json | remove -s user`
// (C21, D28): the engine never writes that file. Every call is checked by re-reading the file (the entry is right AND
// every other server is intact), retried once after 2 s, else K4e. Edit = snapshot → remove → add-json new, restoring
// the snapshot when the new entry cannot be written (K4e-restore); a failed restore leaves "Chép JSON cũ" (no file write).
import { readFileSync } from 'node:fs';
import type { Key, Params } from '../../../shared/i18n/index.ts';
import { KeyedError } from '../errors.ts';
import { shq, type Env } from '../session/env.ts';
import { CLAUDE_INSTALL, type ExecResult } from '../setup/setup.ts';
import { isObj, jsonErrorAt } from '../../../shared/json.ts';

type Obj = Record<string, unknown>;

export type RegistryCode =
  | 'no_claude' | 'name_taken' | 'bad_name' | 'bad_entry' | 'not_found' | 'unreadable' | 'cli_failed' | 'busy' | 'restored' | 'lost';

const KEYS: Record<RegistryCode, Key> = {
  no_claude: 'skillsMcp.err.noClaude', name_taken: 'skillsMcp.err.nameTaken', bad_name: 'skillsMcp.err.badName',
  bad_entry: 'skillsMcp.err.badEntry', not_found: 'skillsMcp.err.notFound', unreadable: 'skillsMcp.err.unreadable',
  cli_failed: 'skillsMcp.err.cliFailed', busy: 'skillsMcp.err.busy', restored: 'skillsMcp.err.restored', lost: 'skillsMcp.err.lost',
};

class RegistryError extends KeyedError {
  constructor(code: RegistryCode, params?: Params) { super(code, { key: KEYS[code], ...(params ? { params } : {}) }); this.name = 'RegistryError'; }
}

/** K14: the parsed file, or where it stopped parsing (1-based line; null = unreadable / no position). */
export type ClaudeJsonRead = { ok: true; json: Obj } | { ok: false; line: number | null };

/** Reads `~/.claude.json`; a missing file is an empty config (Claude Code creates it on first write). */
export function readClaudeJson(file: string): ClaudeJsonRead {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { ok: true, json: {} } : { ok: false, line: null };
  }
  try {
    const v: unknown = JSON.parse(text);
    return isObj(v) ? { ok: true, json: v } : { ok: false, line: 1 };
  } catch {
    return { ok: false, line: jsonErrorAt(text).line };
  }
}

const userServers = (json: Obj): Obj => (isObj(json.mcpServers) ? json.mcpServers : {});

const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

/** The written entry carries every key we gave, same values (Claude Code may add its own, e.g. `type`). */
const holds = (actual: unknown, want: Obj): boolean => isObj(actual) && Object.keys(want).every((k) => canon(actual[k]) === canon(want[k]));

/** Every server of `before` except `skip` is still there, unchanged. */
const othersIntact = (before: Obj, after: Obj, skip: readonly string[]): boolean =>
  Object.keys(before).every((n) => skip.includes(n) || canon(before[n]) === canon(after[n]));

/** Claude Code's own name rule for `claude mcp add` (letters, digits, `_`, `-`, `.`); never a leading `-` (argv). */
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

/** The full command the PO can paste ("Sẽ chạy:" / "Chép JSON cũ"). */
const addJsonCommand = (name: string, entry: Obj): string => `claude mcp add-json -s user ${shq(name)} ${shq(JSON.stringify(entry))}`;

const CLI_TIMEOUT_MS = 30_000;

/** Bun.spawn with exactly `env` (never the engine's own: no `CLAUDE_CONFIG_DIR`, §5.4). */
const defaultMcpRun = async (argv: string[], env: Env): Promise<ExecResult> => {
  const p = Bun.spawn(argv, { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => p.kill('SIGTERM'), CLI_TIMEOUT_MS);
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr };
};

export interface RegistryDeps {
  /** `claude` on the login PATH; null → `no_claude` (K4e: reason + install command). */
  claudePath: () => string | null;
  /** The login env, already without `CLAUDE_CONFIG_DIR` (`stripEnv`). */
  env: () => Env;
  claudeJson: () => string;
  run?: (argv: string[], env: Env) => Promise<ExecResult>;
  /** §5.4 wait before the one retry (default 2 s). */
  retryMs?: number;
  /** After every call that ran the CLI (the catalog re-reads its sources). */
  onWritten?: () => void;
}

/** A restore that failed: the band "Server `<name>` đang không có trong `~/.claude.json`" + "Chép JSON cũ". */
export interface LostEntry { name: string; json: string; command: string }

export class McpRegistry {
  constructor(private readonly d: RegistryDeps) {}

  private servers(): Obj {
    const r = readClaudeJson(this.d.claudeJson());
    if (!r.ok) throw new RegistryError('unreadable', { line: r.line ?? '?' });
    return userServers(r.json);
  }

  /** `secret`: §5.4 `--client-secret` is a flag without value, the CLI reads env `MCP_CLIENT_SECRET` (never argv). */
  private async cli(args: string[], secret?: string): Promise<ExecResult> {
    const claude = this.d.claudePath();
    if (!claude) throw new RegistryError('no_claude', { cmd: CLAUDE_INSTALL });
    try {
      const env = secret ? { ...this.d.env(), MCP_CLIENT_SECRET: secret } : this.d.env();
      return await (this.d.run ?? defaultMcpRun)([claude, 'mcp', ...args, ...(secret ? ['--client-secret'] : [])], env);
    } finally {
      this.d.onWritten?.();
    }
  }

  /** Re-read until `ok(servers)`: now, then once more after the retry wait. */
  private async settled(ok: (s: Obj) => boolean): Promise<boolean> {
    if (ok(this.servers())) return true;
    await Bun.sleep(this.d.retryMs ?? 2000);
    return ok(this.servers());
  }

  /** add-json + re-read; false = exit ≠ 0 (`exit`, `stderr`) or the file is still wrong after the retry (exit 0). */
  private async addJson(name: string, entry: Obj, before: Obj, skip: readonly string[], secret?: string): Promise<{ ok: boolean; exit: number; stderr: string }> {
    const r = await this.cli(['add-json', '-s', 'user', name, JSON.stringify(entry)], secret);
    if (r.code !== 0) return { ok: false, exit: r.code, stderr: r.stderr.trim() };
    return { ok: await this.settled((s) => holds(s[name], entry) && othersIntact(before, s, skip)), exit: 0, stderr: '' };
  }

  private async remove(name: string, before: Obj): Promise<void> {
    const r = await this.cli(['remove', '-s', 'user', name]);
    if (r.code !== 0) throw new RegistryError('cli_failed', { detail: firstLine(r.stderr) });
    if (!(await this.settled((s) => !(name in s) && othersIntact(before, s, [name])))) throw new RegistryError('busy');
  }

  /** §5.4 "Thêm": the name is checked first, so add-json never meets a taken name. `secret`: K4 "Client ID" + secret. */
  async add(name: string, entry: unknown, secret?: string): Promise<void> {
    const e = checkEntry(name, entry);
    const before = this.servers();
    if (name in before) throw new RegistryError('name_taken', { name });
    const r = await this.addJson(name, e, before, [name], secret);
    if (!r.ok) throw r.stderr ? new RegistryError('cli_failed', { detail: firstLine(r.stderr) }) : new RegistryError('busy');
  }

  /** §5.4 "Xoá" (user scope only). */
  async delete(name: string): Promise<void> {
    const before = this.servers();
    if (!(name in before)) throw new RegistryError('not_found', { name });
    await this.remove(name, before);
  }

  /**
   * §5.4 "Sửa" (C21): snapshot → remove → add-json new (`to` = new name, may equal `name`). The new entry not written →
   * add-json the snapshot → re-read must match it → `restored`; that failing too → `lost` (+ `onLost` payload).
   */
  async edit(name: string, to: string, entry: unknown, onLost: (l: LostEntry) => void, secret?: string): Promise<void> {
    const e = checkEntry(to, entry);
    const before = this.servers();
    const snap = before[name];
    if (!isObj(snap)) throw new RegistryError('not_found', { name });
    if (to !== name && to in before) throw new RegistryError('name_taken', { name: to });
    const others = Object.fromEntries(Object.entries(before).filter(([n]) => n !== name));
    try {
      await this.remove(name, before);
    } catch (err) { // step 2 re-read wrong: the entry may be gone already → put the snapshot back
      if (err instanceof RegistryError && err.code === 'busy' && !(name in this.servers())) return this.restore(name, snap, others, onLost, { exit: 0, stderr: '' });
      throw err;
    }
    const step3 = await this.addJson(to, e, others, [to], secret);
    if (step3.ok) return;
    if (to !== name && !(await this.cleanup(to, others))) { onLost(lostOf(name, snap)); throw new RegistryError('lost', { name }); }
    return this.restore(name, snap, others, onLost, step3);
  }

  /** add-json the snapshot; the re-read matches it → `restored` + why step 3 failed (K4e-restore: exit + its text; exit 0 =
   *  the re-read was wrong), else `lost` (band + "Chép JSON cũ"). */
  private async restore(name: string, snap: Obj, others: Obj, onLost: (l: LostEntry) => void, why: { exit: number; stderr: string }): Promise<never> {
    if ((await this.addJson(name, snap, others, [name])).ok) throw new RegistryError('restored', { name, exit: why.exit, detail: firstLine(why.stderr) });
    onLost(lostOf(name, snap));
    throw new RegistryError('lost', { name });
  }

  /** A renamed edit whose new entry half-landed: take it out before the snapshot goes back. */
  private async cleanup(to: string, others: Obj): Promise<boolean> {
    if (!(to in this.servers())) return true;
    const r = await this.cli(['remove', '-s', 'user', to]);
    return r.code === 0 && (await this.settled((s) => !(to in s) && othersIntact(others, s, [to])));
  }
}

const firstLine = (s: string) => s.trim().split('\n')[0] ?? '';
const lostOf = (name: string, snap: Obj): LostEntry => ({ name, json: JSON.stringify(snap, null, 2), command: addJsonCommand(name, snap) });

function checkEntry(name: string, entry: unknown): Obj {
  if (!NAME.test(name)) throw new RegistryError('bad_name', { name });
  if (!isObj(entry) || (typeof entry.command !== 'string' && typeof entry.url !== 'string')) throw new RegistryError('bad_entry');
  return entry;
}
