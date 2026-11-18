// fake-claude `plugin marketplace add|update`, `plugin install|update` (v2.5 spec §5.2, §8): never calls any network.
// Writes the same files as Claude Code 2.1.325 (research §1.3) under `$CLAUDE_CONFIG_DIR` or `$HOME/.claude`:
// `settings.json` (`extraKnownMarketplaces`, `enabledPlugins`), `plugins/known_marketplaces.json`,
// `plugins/installed_plugins.json`, `plugins/marketplaces/<name>/`, `plugins/cache/<mkt>/<plugin>/<version>/` (+ `.in_use`).
// Every reply is one JSON line on stdout (`--json`). Knobs:
// - FAKE_CLAUDE_PLUGIN_REMOTE=<file>: the "network": `{ "<owner/repo>": { name, head, plugins: RemotePlugin[] } }`.
//   `marketplace add <repo>` clones it, `marketplace update <name>` re-reads it (a test edits the file = a new release).
// - FAKE_CLAUDE_PLUGIN_PLAN=<file>: `{ "<sub>": Outcome[] }` (sub = `marketplace-add`, `marketplace-update`, `install`,
//   `update`); each call takes the first outcome, default `ok`. `offline` = exit 1, `error_unknown`, a git network error
//   in `message` and stderr; `fail` = exit 1, `error_unknown`, "boom".
// - FAKE_CLAUDE_PLUGIN_LOG=<file>: appends `<sub> <arg> cfg=<set|unset>` per call.
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Obj = Record<string, unknown>;
type Outcome = 'ok' | 'offline' | 'fail';
/** `sha` → a url source (version from `pluginVersion`); else a path source `./plugins/<name>` with optional `version`. */
interface RemotePlugin { name: string; version?: string; sha?: string; pluginVersion?: string; files?: Record<string, string> }
interface Remote { name: string; head: string; plugins: RemotePlugin[] }

const readJson = (p: string): Obj => { try { return JSON.parse(readFileSync(p, 'utf8')) as Obj; } catch { return {}; } };
const writeJson = (p: string, v: unknown) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2)); };
const writeText = (p: string, v: string) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, v); };
const out = (v: Obj, code = 0): never => { process.stdout.write(`${JSON.stringify(v)}\n`); process.exit(code); };

function nextOutcome(sub: string): Outcome {
  const f = process.env.FAKE_CLAUDE_PLUGIN_PLAN;
  if (!f || !existsSync(f)) return 'ok';
  const plan = readJson(f) as Record<string, Outcome[]>;
  const o = plan[sub]?.shift() ?? 'ok';
  writeFileSync(f, JSON.stringify(plan));
  return o;
}

function failOn(command: string, o: Outcome, extra: Obj): void {
  if (o === 'ok') return;
  const message = o === 'offline'
    ? "Failed: fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com\nssh: Could not resolve hostname github.com"
    : 'boom';
  process.stderr.write(`✘ ${message}\n`);
  out({ command, outcome: 'failed', ...extra, message, failureCode: 'error_unknown' }, 1);
}

export function runPlugin(args: string[]): never {
  const home = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME ?? '', '.claude');
  const pdir = join(home, 'plugins');
  const files = { settings: join(home, 'settings.json'), known: join(pdir, 'known_marketplaces.json'), installed: join(pdir, 'installed_plugins.json') };
  const pos = args.filter((a, i) => !a.startsWith('-') && args[i - 1] !== '-s');
  const sub = pos[0] === 'marketplace' ? `marketplace-${pos[1] ?? ''}` : (pos[0] ?? '');
  const arg = pos[0] === 'marketplace' ? (pos[2] ?? '') : (pos[1] ?? '');
  if (process.env.FAKE_CLAUDE_PLUGIN_LOG) appendFileSync(process.env.FAKE_CLAUDE_PLUGIN_LOG, `${sub} ${arg} cfg=${process.env.CLAUDE_CONFIG_DIR ? 'set' : 'unset'}\n`);
  if (!args.includes('--json')) out({ message: 'fake-claude plugin: tests always pass --json' }, 2);
  const remotes = readJson(process.env.FAKE_CLAUDE_PLUGIN_REMOTE ?? '') as Record<string, Remote>;
  const known = readJson(files.known);
  const settings = readJson(files.settings);

  /** Clone / refresh: the marketplace dir holds `.claude-plugin/marketplace.json` + every path plugin's files. */
  const clone = (repo: string, r: Remote): string => {
    const dir = join(pdir, 'marketplaces', r.name);
    rmSync(dir, { recursive: true, force: true });
    const plugins = r.plugins.map((p) => {
      if (p.sha) return { name: p.name, source: { source: 'url', url: `https://example.test/${p.name}.git`, sha: p.sha }, ...(p.version ? { version: p.version } : {}) };
      mkdirSync(join(dir, 'plugins', p.name), { recursive: true });
      for (const [rel, text] of Object.entries(p.files ?? {})) writeText(join(dir, 'plugins', p.name, rel), text);
      return { name: p.name, source: `./plugins/${p.name}`, ...(p.version ? { version: p.version } : {}) };
    });
    writeJson(join(dir, '.claude-plugin', 'marketplace.json'), { name: r.name, plugins });
    writeJson(join(dir, 'remote.json'), { repo, ...r });
    return dir;
  };

  if (sub === 'marketplace-add') {
    const r = remotes[arg];
    failOn('marketplace-add', r ? nextOutcome(sub) : 'offline', {});
    const dir = clone(arg, r!);
    writeJson(files.known, { ...known, [r!.name]: { source: { source: 'github', repo: arg }, installLocation: dir, lastUpdated: new Date().toISOString() } });
    writeJson(files.settings, { ...settings, extraKnownMarketplaces: { ...(settings.extraKnownMarketplaces as Obj | undefined), [r!.name]: { source: { source: 'github', repo: arg } } } });
    return out({ command: 'marketplace-add', outcome: 'ok', marketplace: r!.name, message: `Successfully added marketplace: ${r!.name}` });
  }
  if (sub === 'marketplace-update') {
    const k = known[arg] as { source: { repo: string } } | undefined;
    if (!k) out({ command: 'marketplace-update', outcome: 'failed', message: `Marketplace '${arg}' not found`, failureCode: 'not_found' }, 1);
    failOn('marketplace-update', nextOutcome(sub), { marketplace: arg });
    clone(k!.source.repo, remotes[k!.source.repo]!);
    return out({ command: 'marketplace-update', outcome: 'ok', marketplace: arg, message: `Successfully updated marketplace: ${arg}` });
  }

  const [name, mkt] = arg.split('@') as [string, string | undefined];
  const installed = readJson(files.installed) as { version?: number; plugins?: Record<string, Obj[]> };
  const rows = installed.plugins ?? {};
  const mine = (rows[arg] ?? []).find((x) => x.scope === 'user');
  const k = mkt ? (known[mkt] as { installLocation: string } | undefined) : undefined;
  const local = k ? (readJson(join(k.installLocation, 'remote.json')) as unknown as Remote).plugins.find((p) => p.name === name) : undefined;
  const versionOf = (p: RemotePlugin, head: string) => p.version ?? p.pluginVersion ?? head.slice(0, 12);
  const put = (p: RemotePlugin): string => {
    const head = (readJson(join(k!.installLocation, 'remote.json')) as unknown as Remote).head;
    const v = versionOf(p, head);
    const dir = join(pdir, 'cache', mkt!, name, v);
    rmSync(dir, { recursive: true, force: true });
    if (p.sha) writeJson(join(dir, '.claude-plugin', 'plugin.json'), { name, version: v });
    else cpSync(join(k!.installLocation, 'plugins', name), dir, { recursive: true });
    writeFileSync(join(dir, '.in_use'), String(process.pid));
    const now = new Date().toISOString();
    const row = { scope: 'user', installPath: dir, version: v, installedAt: (mine?.installedAt as string | undefined) ?? now, lastUpdated: now, ...(p.sha ? { gitCommitSha: p.sha } : {}) };
    writeJson(files.installed, { version: 2, plugins: { ...rows, [arg]: [...(rows[arg] ?? []).filter((x) => x.scope !== 'user'), row] } });
    return v;
  };

  if (sub === 'install') {
    if (!local) out({ command: 'install', outcome: 'failed', plugin: arg, scope: 'user', message: `Plugin "${arg}" not found in any marketplace`, failureCode: 'not_found' }, 1);
    failOn('install', nextOutcome(sub), { plugin: arg, scope: 'user' });
    if (mine) out({ command: 'install', outcome: 'ok', plugin: name, pluginId: arg, scope: 'user', message: `Plugin "${arg}" is already installed (scope: user)`, installedVersion: mine.version });
    put(local!);
    const s = readJson(files.settings);
    writeJson(files.settings, { ...s, enabledPlugins: { ...(s.enabledPlugins as Obj | undefined), [arg]: true } });
    return out({ command: 'install', outcome: 'ok', plugin: name, pluginId: arg, scope: 'user', message: `Successfully installed plugin: ${arg} (scope: user)` });
  }
  if (sub === 'update') {
    if (!mine) out({ command: 'update', outcome: 'failed', plugin: arg, message: `Plugin "${arg}" is not installed`, failureCode: 'not_installed' }, 1);
    failOn('update', nextOutcome(sub), { plugin: arg, scope: 'user' });
    const old = mine!.version as string;
    const same = local!.sha ? local!.sha === mine!.gitCommitSha : versionOf(local!, (readJson(join(k!.installLocation, 'remote.json')) as unknown as Remote).head) === old;
    if (same) out({ command: 'update', outcome: 'ok', plugin: name, pluginId: arg, scope: 'user', message: `Plugin "${name}" is already at the latest version`, updateOutcome: 'up_to_date', oldVersion: old, newVersion: old });
    const v = put(local!);
    return out({ command: 'update', outcome: 'ok', plugin: name, pluginId: arg, scope: 'user', message: `Plugin "${name}" updated from ${old} to ${v} for scope user. Restart to apply changes.`, updateOutcome: 'updated', oldVersion: old, newVersion: v });
  }
  return out({ message: `fake-claude plugin: unknown subcommand ${sub}` }, 2);
}
