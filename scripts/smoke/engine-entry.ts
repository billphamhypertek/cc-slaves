#!/usr/bin/env bun
// Live smoke engine (spec v2.7 §15 G6): the real boot path (engine/src/boot.ts: lock, engine.json, signals, real `claude`,
// real login shell) on the temp home of lib.ts, plus ONE usable account so the items can run without a browser login:
//   SMOKE_TOKEN_DIR   the temp account dir (seeded here, identity = SMOKE_TOKEN_EMAIL), CLAUDE_HOME = the temp claude home
//   claude-bin        wrapper around the real `claude`: for that dir only it exports CLAUDE_CODE_OAUTH_TOKEN, read at
//                     every spawn from the PO's terminal Keychain item (read only — measured G0 the same way; the
//                     real HOME, which picks the keychain search list)
// The PO's `~/.claude`, `~/.claude.json` and `~/.cc-slaves-accounts` are never written: CLAUDE_HOME / CLAUDE_JSON /
// CC_SLAVES_ACCOUNTS all point into $SMOKE_DIR. v2.5: the login env the engine hands every spawn has HOME = $SMOKE_DIR/
// graph-home and no real `~/.local/bin` on PATH, so the graph module only ever finds a temp codebase-memory-mcp (installed
// there by `graph_install`) and its temp cache — never the PO's tool, cache or daemon (G0 isolation). Spends real quota
// (haiku): never part of `bun test`.
import { chmodSync, copyFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runEngine } from '../../engine/src/boot.ts';
import { applyLayout, planLayout } from '../../engine/src/accounts/layout.ts';
import { keychainHasLogin, keychainQuotaSource } from '../../engine/src/accounts/quota.ts';
import { DEFAULT_KEYCHAIN_SERVICE, keychainService } from '../../engine/src/accounts/registry.ts';
import { securityExec, type SecurityExec } from '../../engine/src/accounts/keychain.ts';
import { ensureHome, paths } from '../../engine/src/paths.ts';
import { loadLoginEnv } from '../../engine/src/session/env.ts';
import { seedAccounts } from '../../engine/it/seed-accounts.ts';

const email = process.env.SMOKE_TOKEN_EMAIL;
const dir = process.env.SMOKE_DIR;
if (!email || !dir) { console.error('SMOKE_TOKEN_EMAIL / SMOKE_DIR not set'); process.exit(2); }

ensureHome();
const acct = seedAccounts([email]).find((a) => a.email === email)!;
applyLayout(planLayout(paths().claudeHome, acct.configDir)); // what a real login does (accounts/login.ts)
const own = keychainService(acct.configDir);
/** The seeded account's Keychain reads go to the terminal item (read only); every other account reads its own. */
const exec: SecurityExec = (cmd, args) => securityExec(cmd, args.map((a) => (a === own ? DEFAULT_KEYCHAIN_SERVICE : a)));

const real = await loadLoginEnv();
const graphHome = join(dir, 'graph-home');
mkdirSync(graphHome, { recursive: true });
// `claude plugin` (toolkit) writes $HOME/.claude while the engine reads CLAUDE_HOME: one dir, as ~/.claude in the app
if (!existsSync(join(graphHome, '.claude'))) symlinkSync(paths().claudeHome, join(graphHome, '.claude'));
const gitconfig = join(homedir(), '.gitconfig'); // lanes still commit as the PO (read-only copy)
if (existsSync(gitconfig) && !existsSync(join(graphHome, '.gitconfig'))) copyFileSync(gitconfig, join(graphHome, '.gitconfig'));
const realBin = join(homedir(), '.local', 'bin');
const login = { ...real, env: { ...real.env, HOME: graphHome, PATH: (real.env.PATH ?? '').split(':').filter((d) => d !== realBin).join(':') } };
const claudePath = join(dir, 'claude-bin');
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
writeFileSync(claudePath, `#!/bin/sh
if [ "$CLAUDE_CONFIG_DIR" = ${q(acct.configDir)} ]; then
  CLAUDE_CODE_OAUTH_TOKEN=$(HOME=${q(homedir())} /usr/bin/security find-generic-password -s ${q(DEFAULT_KEYCHAIN_SERVICE)} -w | sed -n 's/.*"accessToken":"\\([^"]*\\)".*/\\1/p')
  export CLAUDE_CODE_OAUTH_TOKEN
fi
exec ${q(login.claudePath ?? 'claude')} "$@"
`, { mode: 0o700 });
chmodSync(claudePath, 0o700);

await runEngine({
  graphModule: true, // as engine/src/main.ts (v2.5 §5.3); safe here: the graph-home isolation above
  gh: null, // never the real gh (network; v2.1 §4.15 PR lookup)
  loginEnv: { ...login, claudePath },
  hasLogin: (a) => keychainHasLogin(a, exec),
  quotaSource: keychainQuotaSource({ exec }),
});
