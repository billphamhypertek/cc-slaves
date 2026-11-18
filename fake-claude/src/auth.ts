// fake-claude `auth login|status|logout` (v2 spec §8 IT). Never calls any API. Env:
// - FAKE_CLAUDE_AUTH=success (default) | fail | fail_fork | wrong_email | never | fork
//   success: runs `$BROWSER <url>`, then waits for `<CLAUDE_CONFIG_DIR>/.fake-auth-go` (the "browser finished") or a
//            pasted `code#state` line on stdin, then writes `<CLAUDE_CONFIG_DIR>/.claude.json` with `oauthAccount`, exit 0;
//   fail: prints an error line, exit 1; wrong_email: as success but writes `other-<email>`; never: waits forever;
//   fail_fork: forks the same grandchild as `fork`, waits 600 ms (the engine records the pids), then fails as `fail`;
//   fork: forks a grandchild that ignores SIGTERM and SIGHUP (`sh -c 'trap "" TERM HUP; sleep 600'`), then waits forever.
// - FAKE_CLAUDE_AUTH_EMAIL: the email written (default `--email` value, else `fake@example.test`).
// - FAKE_CLAUDE_AUTH_PIDS=<file>: writes {pid, pgid-less child pids} so the IT can check `ps` after a cancel.
// - FAKE_CLAUDE_AUTH_STATUS=<code>: `auth status` exit code (default 0 when `.claude.json` has oauthAccount, else 1).
// - `<CLAUDE_CONFIG_DIR>/.fake-auth-status` {"code"?, "delayMs"?}: per-account `auth status` exit code / delay before exit.
// - FAKE_CLAUDE_AUTH_LOG=<file>: appends `<subcommand>` per call.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const forever = () => new Promise<never>(() => { setInterval(() => {}, 1 << 30); });

function readJson(p: string): Record<string, unknown> {
  try { return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>; } catch { return {}; }
}

export async function runAuth(args: string[]): Promise<never> {
  const sub = args[0] ?? '';
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (process.env.FAKE_CLAUDE_AUTH_LOG) appendFileSync(process.env.FAKE_CLAUDE_AUTH_LOG, `${sub}\n`);
  if (!dir) { process.stderr.write('fake-claude: CLAUDE_CONFIG_DIR not set\n'); process.exit(2); }
  const cfg = join(dir, '.claude.json');
  if (sub === 'status') {
    // per account: `<CLAUDE_CONFIG_DIR>/.fake-auth-status` = {"code"?: n, "delayMs"?: n} beats the env knob
    const per = readJson(join(dir, '.fake-auth-status')) as { code?: number; delayMs?: number };
    if (per.delayMs) await new Promise((r) => setTimeout(r, per.delayMs));
    const forced = per.code ?? process.env.FAKE_CLAUDE_AUTH_STATUS;
    process.exit(forced !== undefined ? Number(forced) : readJson(cfg).oauthAccount ? 0 : 1);
  }
  if (sub === 'logout') {
    const j = readJson(cfg);
    delete j.oauthAccount;
    writeFileSync(cfg, JSON.stringify(j));
    process.stdout.write('Successfully logged out\n');
    process.exit(0);
  }
  if (sub !== 'login') { process.stderr.write(`fake-claude: unknown auth ${sub}\n`); process.exit(2); }

  const scenario = process.env.FAKE_CLAUDE_AUTH ?? 'success';
  const i = args.indexOf('--email');
  const asked = i >= 0 ? args[i + 1] : undefined;
  const url = `https://claude.ai/oauth/authorize?code=true&state=fake${process.pid}`;
  const pidsFile = process.env.FAKE_CLAUDE_AUTH_PIDS;
  const pids: number[] = [];
  if (scenario === 'fork' || scenario === 'fail_fork') {
    const g = spawn('/bin/sh', ['-c', 'trap "" TERM HUP; sleep 600'], { stdio: 'ignore' });
    pids.push(g.pid!);
  }
  if (pidsFile) writeFileSync(pidsFile, JSON.stringify({ pid: process.pid, children: pids }));
  if (scenario === 'fail_fork') await Bun.sleep(600);
  if (scenario === 'fail' || scenario === 'fail_fork') {
    process.stdout.write('Opening browser to sign in…\nError: connect ECONNREFUSED 127.0.0.1:443\n');
    process.exit(1);
  }
  process.stdout.write(`Opening browser to sign in…\nIf the browser didn't open, visit: ${url}\n`);
  const browser = process.env.BROWSER;
  if (browser) await new Promise<void>((r) => spawn(browser, [url], { stdio: 'ignore' }).on('exit', () => r()));
  if (scenario === 'never' || scenario === 'fork') await forever();

  let pasted: string | null = null;
  void (async () => {
    const dec = new TextDecoder();
    let buf = '';
    for await (const c of Bun.stdin.stream()) {
      buf += dec.decode(c, { stream: true });
      const m = /([^\s#]+#[^\s#]+)\s*[\r\n]/.exec(buf);
      if (m) { pasted = m[1]!; return; }
    }
  })();
  const go = join(dir, '.fake-auth-go');
  while (!existsSync(go) && pasted === null) await Bun.sleep(25);
  if (pasted !== null) writeFileSync(join(dir, '.fake-auth-code'), pasted);
  const base = process.env.FAKE_CLAUDE_AUTH_EMAIL ?? asked ?? 'fake@example.test';
  const email = scenario === 'wrong_email' ? `other-${base}` : base;
  const j = readJson(cfg);
  j.oauthAccount = {
    accountUuid: `acct-${email}`, organizationUuid: `org-${email}`, emailAddress: email,
    organizationRateLimitTier: 'default_claude_max_20x', planDisplayName: 'Max 20x',
  };
  writeFileSync(cfg, JSON.stringify(j));
  process.stdout.write('Login successful.\n');
  process.exit(0);
}
