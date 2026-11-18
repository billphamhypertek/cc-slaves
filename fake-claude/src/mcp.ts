// fake-claude `mcp add-json -s user <name> <json>` / `mcp remove -s user <name>` (v2.2 spec §8 "`claude mcp` giả").
// Never calls any API. Reads / writes `$HOME/.claude.json` `mcpServers` like the real CLI (§3-12: add-json never
// overwrites, exit 1 "already exists"; remove of an unknown name → exit 1). Knobs:
// - FAKE_CLAUDE_MCP_PLAN=<file>: JSON `{ "add-json"?: Outcome[], "remove"?: Outcome[] }`; each call takes (and removes)
//   the first outcome of its subcommand, default `ok`. Outcome: `ok` · `fail` (exit 1, nothing written) · `lost` (exit 0,
//   nothing written: another writer won the race) · `clobber` (writes, but drops every other server: a stale writer).
// - FAKE_CLAUDE_MCP_LOG=<file>: appends `<subcommand> <name>` per call (tests assert add-json was never called);
//   `add-json … --client-secret` (a flag without value, §3-9) reads env MCP_CLIENT_SECRET: logged as `--client-secret=<v>`,
//   missing → exit 1 (the real CLI would prompt on a closed stdin).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Outcome = 'ok' | 'fail' | 'lost' | 'clobber';
type Obj = Record<string, unknown>;

function readJson(p: string): Obj {
  try { return JSON.parse(readFileSync(p, 'utf8')) as Obj; } catch { return {}; }
}

function nextOutcome(sub: string): Outcome {
  const f = process.env.FAKE_CLAUDE_MCP_PLAN;
  if (!f || !existsSync(f)) return 'ok';
  const plan = readJson(f) as Record<string, Outcome[]>;
  const list = plan[sub] ?? [];
  const o = list.shift() ?? 'ok';
  plan[sub] = list;
  writeFileSync(f, JSON.stringify(plan));
  return o;
}

const fail = (msg: string): never => { process.stderr.write(`${msg}\n`); process.exit(1); };

export function runMcp(args: string[]): never {
  const sub = args[0] ?? '';
  const secretFlag = args.includes('--client-secret');
  const rest = args.slice(1).filter((a, i, all) => a !== '-s' && all[i - 1] !== '-s' && a !== '--client-secret');
  const name = rest[0] ?? '';
  const secret = secretFlag ? ` --client-secret=${process.env.MCP_CLIENT_SECRET ?? ''}` : '';
  if (process.env.FAKE_CLAUDE_MCP_LOG) appendFileSync(process.env.FAKE_CLAUDE_MCP_LOG, `${sub} ${name}${secret}\n`);
  if (secretFlag && !process.env.MCP_CLIENT_SECRET) fail('fake-claude mcp: --client-secret needs MCP_CLIENT_SECRET (stdin closed)');
  if (!args.includes('-s') || args[args.indexOf('-s') + 1] !== 'user') fail('fake-claude mcp: only -s user');
  const file = join(process.env.HOME ?? '', '.claude.json');
  const json = readJson(file);
  const servers = { ...((json.mcpServers as Obj | undefined) ?? {}) };
  if (sub === 'add-json') {
    let entry: unknown;
    try { entry = JSON.parse(rest[1] ?? ''); } catch { fail('Invalid JSON'); }
    if (name in servers) fail(`MCP server ${name} already exists in user config`);
    const o = nextOutcome(sub);
    if (o === 'fail') fail('fake-claude mcp: add-json failed (plan)');
    if (o === 'ok') writeFileSync(file, JSON.stringify({ ...json, mcpServers: { ...servers, [name]: entry } }, null, 2));
    if (o === 'clobber') writeFileSync(file, JSON.stringify({ ...json, mcpServers: { [name]: entry } }, null, 2));
    process.stdout.write(`Added stdio MCP server ${name} to user config\n`);
    process.exit(0);
  }
  if (sub === 'remove') {
    if (!(name in servers)) fail(`No user-scoped MCP server found with name: ${name}`);
    const o = nextOutcome(sub);
    if (o === 'fail') fail('fake-claude mcp: remove failed (plan)');
    const { [name]: _gone, ...left } = servers;
    if (o === 'ok') writeFileSync(file, JSON.stringify({ ...json, mcpServers: left }, null, 2));
    if (o === 'clobber') writeFileSync(file, JSON.stringify({ ...json, mcpServers: {} }, null, 2));
    process.stdout.write(`Removed MCP server ${name} from user config\n`);
    process.exit(0);
  }
  return fail(`fake-claude mcp: unknown subcommand ${sub}`);
}
