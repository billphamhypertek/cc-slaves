// The engine's Keychain write path (v2.2 §5.3, §3-14): every secret goes to `security -i` on stdin, never argv. Holds
// the localhost token (spec §7.1 NC1, §7.2: random per engine start, item `cc-slaves-engine-token`, read by the app
// through the Keychain API; no file ever holds it) and the MCP OAuth records (`cc-slaves-mcp`, split ≤ 3 900 B).
import { randomBytes } from 'node:crypto';

export const KEYCHAIN_SERVICE = 'cc-slaves-engine-token';
/** v2.2 §5.3 the MCP OAuth records (account = server id). */
export const MCP_KEYCHAIN_SERVICE = 'cc-slaves-mcp';
const KEYCHAIN_ACCOUNT = 'cc-slaves';
const SECURITY_BIN = '/usr/bin/security';
/** §3-14: one `security -i` line holds ~4 KB; each item's quoted value stays ≤ this many bytes. */
export const ENTRY_MAX = 3900;
/** errSecItemNotFound as `security` exits with it. */
const NOT_FOUND_CODE = 44;
/** The head item of a split value: `<SPLIT_TAG><parts>:<first chunk>` (a JSON value never starts with it). */
const SPLIT_TAG = 'cc-slaves-split:';
/** Stale parts beyond the current count are swept up to this index. */
const PARTS_SWEEP = 64;

/** `security <args>` (stdin optional) → exit code + output. Sync: one call is a few ms and rare. */
export type SecurityCli = (args: string[], stdin?: string) => { code: number; stdout: string; stderr: string };

/** The real runner (`/usr/bin/security`); tests pass a fake binary's path (never the real Keychain). */
export function securityCli(bin: string = SECURITY_BIN): SecurityCli {
  return (args, stdin) => {
    const p = Bun.spawnSync([bin, ...args], { stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin), stdout: 'pipe', stderr: 'pipe' });
    return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
  };
}

/** §3-14: a `security -i` word — `"…"` with `\` and `"` escaped (measured to round-trip byte for byte). */
export const quoteValue = (v: string): string => `"${v.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/**
 * §5.3 `security -i` is line-oriented: a CR / LF / NUL in any word would end the command and start an attacker's
 * (ids come from repo `.mcp.json` / plugin keys). Refused before any spawn, on every path (argv ones too).
 */
const CONTROL = /[\r\n\0]/;
function assertWords(...words: string[]): void {
  if (words.some((w) => CONTROL.test(w))) throw new Error('keychain: control char in service, account or value');
}

/** The item's value, or null when it does not exist (or `security` failed). `-w` prints the value on stdout. */
export function readSecret(cli: SecurityCli, service: string, account: string): string | null {
  assertWords(service, account);
  const r = cli(['find-generic-password', '-s', service, '-a', account, '-w']);
  return r.code === 0 ? r.stdout.replace(/\n$/, '') : null;
}

/** `add-generic-password -U` through stdin, then read back: `security -i` exits 0 even when a command failed. */
export function writeSecret(cli: SecurityCli, service: string, account: string, value: string): void {
  assertWords(service, account, value);
  const line = `add-generic-password -U -s ${quoteValue(service)} -a ${quoteValue(account)} -w ${quoteValue(value)}\n`;
  const r = cli(['-i'], line);
  if (readSecret(cli, service, account) !== value) {
    throw new Error(`Không ghi được vào Keychain (${service}, mã ${r.code}): ${r.stderr.trim().slice(0, 200)}`);
  }
}

/** True when the item is gone (deleted now or already missing). */
function deleteSecret(cli: SecurityCli, service: string, account: string): boolean {
  assertWords(service, account);
  const r = cli(['delete-generic-password', '-s', service, '-a', account]);
  return r.code === 0 || r.code === NOT_FOUND_CODE;
}

/** Chunks whose quoted form each fits ENTRY_MAX bytes (the head also carries the split tag). */
function chunks(value: string, headRoom: number): string[] {
  const out: string[] = [];
  let cur = '';
  let size = 2 + headRoom;
  for (const ch of value) {
    const n = Buffer.byteLength(ch) + (ch === '"' || ch === '\\' ? 1 : 0);
    if (size + n > ENTRY_MAX) { out.push(cur); cur = ''; size = 2; }
    cur += ch;
    size += n;
  }
  out.push(cur);
  return out;
}

/**
 * §5.3 a value over one item is split into `<account>`, `<account>#2`, `#3`…: the parts are written first, the head
 * (which names the part count) last, so a reader that sees the head sees a whole set. Stale parts of a longer old
 * value are deleted afterwards.
 */
export function writeSplit(cli: SecurityCli, service: string, account: string, value: string): void {
  let parts = chunks(value, 0);
  if (parts.length > 1) {
    const first = chunks(value, SPLIT_TAG.length + 4);
    parts = [first[0]!, ...chunks(value.slice(first[0]!.length), 0)];
  }
  for (let i = parts.length - 1; i >= 1; i--) writeSecret(cli, service, `${account}#${i + 1}`, parts[i]!);
  writeSecret(cli, service, account, parts.length > 1 ? `${SPLIT_TAG}${parts.length}:${parts[0]!}` : parts[0]!);
  for (let i = parts.length + 1; i <= PARTS_SWEEP; i++) {
    if (cli(['delete-generic-password', '-s', service, '-a', `${account}#${i}`]).code !== 0) break;
  }
}

/** The joined value; null when the head or any part is missing. */
export function readSplit(cli: SecurityCli, service: string, account: string): string | null {
  const head = readSecret(cli, service, account);
  if (head === null) return null;
  const m = new RegExp(`^${SPLIT_TAG}(\\d+):`).exec(head);
  if (!m) return head;
  let out = head.slice(m[0].length);
  for (let i = 2; i <= Number(m[1]); i++) {
    const p = readSecret(cli, service, `${account}#${i}`);
    if (p === null) return null;
    out += p;
  }
  return out;
}

/** Head first (a reader then sees nothing), then every part. True when the head is gone. */
export function deleteSplit(cli: SecurityCli, service: string, account: string): boolean {
  const gone = deleteSecret(cli, service, account);
  for (let i = 2; i <= PARTS_SWEEP; i++) {
    if (cli(['delete-generic-password', '-s', service, '-a', `${account}#${i}`]).code !== 0) break;
  }
  return gone;
}

const newToken = (): string => randomBytes(32).toString('base64url');

/** §7.1 NC1 `-U` updates the existing item; through stdin like every secret (§5.3). Tests inject a fake `cli`. */
export function storeToken(token: string, cli: SecurityCli = securityCli()): void {
  writeSecret(cli, KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, token);
}

/**
 * TEST-ONLY knob: `CC_SLAVES_TOKEN_OVERRIDE` (≥ 32 chars) is the localhost token for this start and the Keychain is
 * left untouched — the live smoke (spec §10, `scripts/smoke/`) must not overwrite the app's real Keychain item.
 * Never set it in the app / LaunchAgent.
 */
const TOKEN_OVERRIDE_ENV = 'CC_SLAVES_TOKEN_OVERRIDE';
export function bootToken(env: Record<string, string | undefined> = process.env): { token: string; store: boolean } {
  const o = env[TOKEN_OVERRIDE_ENV];
  return o && o.length >= 32 ? { token: o, store: false } : { token: newToken(), store: true };
}
