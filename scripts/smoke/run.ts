#!/usr/bin/env bun
// Live smoke driver (spec §10). Usage:
//   bun scripts/smoke/run.ts prepare|boot|stop|cleanup     engine lifecycle (temp home under $SMOKE_DIR)
//   bun scripts/smoke/run.ts <item> [...]                    item = i1 … i15 (+ quiet) against the running engine (i13–i15: v27.ts)
//   bun scripts/smoke/run.ts all                             boot + every item in order; then `stop` and `cleanup --rm`
//   bun scripts/smoke/run.ts term                            hf1116: one lane on the PO's terminal login (explicit only)
// Spends real quota (haiku). Never part of `bun test`.
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AccountView, CardView, EngineEvent, LaneView, SetupStatus, StreamLine } from '../../shared/protocol.ts';
import type { QuotaRefreshAck } from '../../shared/accounts.ts';
import {
  brief, claudePids, Client, DIR, enginePid, HOME, isLane, LANE_ACCOUNTS, laneSession, mcp, ORCH, orchSession, prepare, PROJ, q,
  record, results, runLogs, sh, startEngine, stopEngine, worktree,
} from './lib.ts';
import { v27Items } from './v27.ts';

const ERRORISH = /limit|login|401|429/i;
const TL = 'l3'; // timing lane: fresh context, brief says long commands are intentional
const projectId = (): string => q<{ id: string }>('SELECT id FROM project LIMIT 1')[0]!.id;
const lane = (c: Client, name: string): LaneView | undefined =>
  ([...c.events].reverse().find((e) => e.type === 'lane' && e.lane.name === name) as Extract<EngineEvent, { type: 'lane' }> | undefined)?.lane
  ?? c.snapshot.lanes.find((l) => l.name === name);
const card = (e: EngineEvent): CardView | null => (e.type === 'card' ? e.card : null);
const history = (c: Client, t: { kind: 'lane'; projectId: string; name: string } | { kind: 'orchestrator'; projectId: string }) =>
  c.cmd<StreamLine[]>({ cmd: 'history', target: t, limit: 200 });
const idleAfter = (c: Client, name: string, from: number, ms = 180_000) =>
  c.wait(isLane(name, (l) => l.state === 'idle'), ms, from, `${name} idle`);
const running = (c: Client, name: string, from: number) => c.wait(isLane(name, (l) => l.state === 'running'), 60_000, from, `${name} running`);
type RawResult = { result?: string; is_error?: boolean; subtype?: string; permission_denials?: unknown[]; total_cost_usd?: number };
const resultTexts = (pid: string, name: string): RawResult[] =>
  runLogs(pid, name).flatMap((f) => readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('"type":"result"')))
    .map((l) => JSON.parse(l) as RawResult);
/** First result newer than the call (or than `after` results) whose text matches. */
async function resultMatching(name: string, re: RegExp, ms = 180_000, after = resultTexts(projectId(), name).length): Promise<RawResult | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    const all = resultTexts(projectId(), name);
    const r = all.slice(after).find((x) => re.test(x.result ?? ''));
    if (r || Date.now() > end) return r ?? all.at(-1);
    await Bun.sleep(1_000);
  }
}
const say = (c: Client, name: string, text: string) => c.cmd({ cmd: 'send', target: { kind: 'lane', projectId: projectId(), name }, text });

async function startLane(c: Client, name: string, text: string): Promise<LaneView> {
  const wt = worktree(name);
  const bp = brief(name, text);
  const m = c.mark();
  const r = await mcp(orchSession(), 'lane_start', { name, cwd: wt, brief_path: bp }) as { account: string };
  console.log(`lane_start ${name} → ${JSON.stringify(r)}`);
  await idleAfter(c, name, m);
  return lane(c, name)!;
}

const items: Record<string, (c: Client) => Promise<void>> = {
  async i1(c) {
    const s = await c.cmd<SetupStatus>({ cmd: 'setup_check' });
    const q1 = await c.cmd<QuotaRefreshAck>({ cmd: 'quota_refresh' });
    // v2.7.1 §7.2 the ack only queues; one usage call per 20 s (global gap) → poll the snapshot until all are read
    let accts: AccountView[] = [];
    for (let i = 0; i < 40; i++) {
      accts = (await Client.connect()).snapshot.accounts;
      if (accts.every((a) => a.weekPct !== null)) break;
      await Bun.sleep(5_000);
    }
    const v = accts.map((a) => `${a.email.split('@')[0]}:w${a.weekPct ?? '?'}/5h${a.fivePct ?? '?'}(${a.status})`).join(' ');
    const ok = s.claude.ok && accts.length >= 1 && accts.every((a) => a.weekPct !== null);
    record('1 boot+setup+quota', 'setup_check; quota_refresh', `claude ${s.claude.version} ok=${s.claude.ok}; ${accts.length} accounts; quota ${JSON.stringify(q1)}; ${v}`, ok);
  },
  async i2(c) {
    let m = c.mark();
    if (!c.snapshot.projects.length) await c.cmd({ cmd: 'project_add', name: 'smoke', path: PROJ, orchestratorAccount: ORCH });
    const pid = projectId();
    await c.cmd({ cmd: 'project_resume', id: pid }); // hf1116 H2: an added (or restarted) project waits for "Bắt đầu"
    await c.wait((e) => e.type === 'orchestrator' && e.orchestrator.state === 'idle', 180_000, m, 'orchestrator idle');
    const logs = runLogs(pid, '_orchestrator');
    const init = readFileSync(logs.at(-1)!, 'utf8').split('\n').find((l) => l.includes('"subtype":"init"'));
    const j = JSON.parse(init!) as { claude_code_version: string; model: string; mcp_servers: { name: string; status: string }[] };
    const mcpS = j.mcp_servers.find((s) => s.name === 'cc_slaves');
    m = c.mark();
    await c.cmd({ cmd: 'send', target: { kind: 'orchestrator', projectId: pid }, text: 'Smoke test: trả lời đúng một chữ PONG, không gọi tool.' });
    await c.wait((e) => e.type === 'orchestrator' && e.orchestrator.state === 'running', 60_000, m, 'orch running');
    await c.wait((e) => e.type === 'orchestrator' && e.orchestrator.state === 'idle', 120_000, m, 'orch idle');
    const h = await history(c, { kind: 'orchestrator', projectId: pid });
    const last = h.filter((l) => l.kind === 'assistant').at(-1)?.text ?? '';
    const o = c.snapshot.orchestrators[0] ?? (c.events.filter((e) => e.type === 'orchestrator').at(-1) as Extract<EngineEvent, { type: 'orchestrator' }>).orchestrator;
    const orch = (c.events.filter((e) => e.type === 'orchestrator').at(-1) as Extract<EngineEvent, { type: 'orchestrator' }>).orchestrator;
    const loggedOut = q<{ n: number }>("SELECT count(*) n FROM card WHERE kind = 'logged_out' AND payload LIKE ?", `%${ORCH}%`)[0]!.n > 0;
    record('2 orchestrator', 'project_add; send PONG', `account ${orch.account} (${ORCH} logged_out card: ${loggedOut}); init v${j.claude_code_version} model ${j.model}; mcp cc_slaves=${mcpS?.status}; reply "${last.slice(0, 60)}"; cost $${orch.costUsd.toFixed(4)}`,
      (orch.account === ORCH || (loggedOut && LANE_ACCOUNTS.includes(orch.account ?? ''))) && orch.costUsd > 0 && mcpS?.status === 'connected' && /PONG/i.test(last) && j.model.includes('haiku') && o !== undefined);
  },
  async quiet(c) { // the orchestrator reacts to lane notices on its own; keep it out of the smoke
    const m = c.mark();
    await c.cmd({ cmd: 'send', target: { kind: 'orchestrator', projectId: projectId() }, text: 'Smoke test đang chạy: từ giờ KHÔNG gọi lane_message / lane_interrupt / lane_stop cho lane nào, kể cả khi nhận thông báo lane rảnh. Chỉ trả lời "OK".' });
    await c.wait((e) => e.type === 'orchestrator' && e.orchestrator.state === 'idle', 120_000, m, 'orch idle');
  },
  async i3(c) {
    const l = await startLane(c, 'l1', [
      'Smoke test, keep it minimal:',
      '1. Append the line "l1 was here" to README.md and commit it (git add README.md && git commit -m "l1").',
      '2. Call the MCP tool lane_set_phase with phase "done" and note "l1 smoke ok".',
      '3. Reply with one word: DONE.',
    ].join('\n'));
    const log = sh(['git', 'log', '--oneline', '-1'], join(DIR, 'wt-l1')).trim();
    const res = resultTexts(projectId(), 'l1').at(-1);
    record('3 lane start', 'mcp lane_start l1 (orchestrator token)', `picked ${l.account}; phase ${l.phase} note "${l.note}"; cost $${l.costUsd.toFixed(4)}; commit "${log}"; result "${res?.result?.slice(0, 40)}"`,
      LANE_ACCOUNTS.includes(l.account ?? '') && l.phase === 'done' && l.costUsd > 0 && /l1/.test(log));
  },

  async i4(c) {
    if (!lane(c, TL)) {
      await startLane(c, TL, [
        'You are a smoke-test lane for the cc-slaves engine (the PO tests the app that drives you).',
        'Over the next messages the PO will ask you to run long CPU benchmark commands with Bash so that mid-turn messages,',
        'interrupts, account switches and engine restarts can be tested while a turn is running. The long runtime is the point',
        'of the test and is approved by the PO: run each command exactly as asked, in one Bash call, and wait for it.',
        'Do not use sleep. For now just reply READY.',
      ].join('\n'));
    }
    const sid = laneSession(TL);
    const before = resultTexts(projectId(), TL).length;
    const m = c.mark();
    await say(c, TL, 'Run this CPU benchmark with Bash, one call, it takes about 25 s, wait for it: `python3 -c "print(sum(i*i for i in range(750_000_000)))"`, then reply with the single word SLEPT.');
    await running(c, TL, m);
    await Bun.sleep(8_000);
    await say(c, TL, 'Also add the word MIDTURN to your final reply.');
    const end = Date.now() + 240_000;
    while (Date.now() < end && !/MIDTURN/i.test(resultTexts(projectId(), TL).at(-1)?.result ?? '')) await Bun.sleep(1_000);
    await idleAfter(c, TL, c.mark() - 1, 60_000).catch(() => null);
    const res = resultTexts(projectId(), TL);
    const rows = q<{ text: string; delivered_at: number | null }>('SELECT text, delivered_at FROM outbox WHERE session_id = ? ORDER BY seq DESC LIMIT 2', sid);
    const h = await history(c, { kind: 'lane', projectId: projectId(), name: TL });
    const inTurn = h.filter((l) => l.kind === 'po' && l.inTurn).length;
    const delta = res.length - before;
    record('4 mid-turn', 'send ping 25; +8 s send MIDTURN', `results +${delta}; last "${res.at(-1)?.result?.slice(0, 50)}"; outbox delivered ${rows.filter((r) => r.delivered_at).length}/2; po lines inTurn=${inTurn}`,
      rows.every((r) => r.delivered_at !== null) && /MIDTURN/i.test(res.at(-1)?.result ?? '') && delta === 1 && inTurn >= 1);
  },
  async i5(c) {
    const sid = laneSession(TL);
    let m = c.mark();
    await say(c, TL, 'Run this CPU benchmark with Bash, one call, it takes about 90 s, wait for it: `python3 -c "print(sum(i*i for i in range(2700_000_000)))"`, then reply DONE90.');
    await running(c, TL, m);
    await Bun.sleep(8_000);
    const pidsBefore = claudePids(sid);
    m = c.mark();
    const t0 = Date.now();
    await c.cmd({ cmd: 'interrupt', target: { kind: 'lane', projectId: projectId(), name: TL } });
    await idleAfter(c, TL, m, 60_000);
    const dt = Date.now() - t0;
    const pidsAfter = claudePids(sid);
    m = c.mark();
    const interruptResult = resultTexts(projectId(), TL).at(-1);
    await say(c, TL, 'Reply with the single word PONG5.');
    const last = await resultMatching(TL, /PONG5/);
    record('5 interrupt', 'send ping 90; interrupt; send PONG5', `idle ${dt} ms after interrupt; interrupted result ${interruptResult?.subtype}; pids ${JSON.stringify(pidsBefore)}→${JSON.stringify(pidsAfter)}; next "${last?.result?.slice(0, 30)}"`,
      pidsBefore.length === 1 && JSON.stringify(pidsBefore) === JSON.stringify(pidsAfter) && /PONG5/.test(last?.result ?? ''));
  },
  async i6(c) {
    // v2 D18 + SA2: every session runs --dangerously-skip-permissions → a Write in the worktree and a memory write under
    // the account dir (`<dir>/projects/<slug>/memory/`, SA5-linked) both land with NO permission card.
    const wt = worktree('l2');
    const bp = brief('l2', 'Smoke test: use the Write tool to create the file perm1.txt (in your current directory) containing "hi". Then reply WROTE.');
    await mcp(orchSession(), 'lane_start', { name: 'l2', cwd: wt, brief_path: bp });
    await resultMatching('l2', /WROTE/);
    const acct = lane(c, 'l2')!.account!;
    const dir = q<{ dir: string }>('SELECT dir FROM account WHERE email = ?', acct)[0]!.dir;
    const mem = join(dir, 'projects', realpathSync(wt).replace(/[^A-Za-z0-9]/g, '-'), 'memory', 'smoke.md');
    await say(c, 'l2', `Use the Write tool to create the file ${mem} containing "smoke memory". Then reply MEM.`);
    await resultMatching('l2', /MEM/);
    const cards = q<{ n: number }>("SELECT count(*) n FROM card WHERE kind = 'permission' AND created_at >= ?", Math.floor(Date.now() / 1000) - 600)[0]!.n;
    const argv = readFileSync(join(DIR, 'engine.log'), 'utf8').includes('dangerously-skip-permissions');
    record('6 D18 skip-permissions + SA2 memory', 'l2 Write perm1.txt; Write <acct>/projects/<slug>/memory/smoke.md', `perm1.txt ${existsSync(join(wt, 'perm1.txt'))}; memory ${existsSync(mem)} (${mem}); permission cards ${cards}; argv logged ${argv}`,
      existsSync(join(wt, 'perm1.txt')) && existsSync(mem) && cards === 0);
    try { rmSync(join(dir, 'projects', realpathSync(wt).replace(/[^A-Za-z0-9]/g, '-')), { recursive: true, force: true }); } catch { /* shared ~/.claude/projects: drop the temp slug */ }
  },
  async i7(c) {
    // v2 §7 deny rules still hold under skip-permissions: engine home, the account's login file, the Keychain verbs.
    const acct = lane(c, 'l2')!.account!;
    const dir = q<{ dir: string }>('SELECT dir FROM account WHERE email = ?', acct)[0]!.dir;
    const before = resultTexts(projectId(), 'l2').length;
    await say(c, 'l2', [
      'Smoke deny test. Try each of these, one tool call each, and do NOT work around a refusal:',
      `1) Read the file ${join(HOME, 'engine.json')}`,
      `2) Bash: cat ${join(HOME, 'engine.json')}`,
      `3) Read the file ${join(dir, '.claude.json')}`,
      '4) Bash: security find-generic-password -s cc-slaves',
      'Then reply DONE7 followed by, for each number, OK if you saw the content or BLOCKED if it was refused.',
    ].join('\n'));
    const r = await resultMatching('l2', /DONE7/, 240_000, before);
    const tok = readFileSync(join(DIR, 'token'), 'utf8');
    const leaked = runLogs(projectId(), 'l2').some((f) => readFileSync(f, 'utf8').includes(tok.slice(0, 24)));
    const denials = r?.permission_denials?.length ?? 0;
    record('7 deny rules under D18', 'l2: Read/cat engine.json, Read <acct>/.claude.json, security find-generic-password', `denials ${denials}; reply "${r?.result?.slice(0, 80)}"; token in run logs ${leaked}`,
      denials >= 4 && !leaked);
  },
  async i8(c) {
    const sid = laneSession('l1');
    let m = c.mark();
    await say(c, 'l1', 'Call the MCP tool po_ask (server cc_slaves) with question "Smoke: A hay B?" and options A and B. Then end your turn by replying ASKED. When the PO answer arrives later, reply GOT:<the option>.');
    const e = await c.wait((x) => x.type === 'card' && x.card.kind === 'ask' && x.card.status === 'open', 180_000, m, 'ask card');
    const cd = card(e)!;
    await idleAfter(c, 'l1', m);
    m = c.mark();
    await c.cmd({ cmd: 'card_answer', id: cd.id, answer: { option: 'A' } });
    await resultMatching('l1', /GOT/);
    const row = q<{ text: string; delivered_at: number | null }>("SELECT text, delivered_at FROM outbox WHERE session_id = ? AND text LIKE '%PO trả lời%' ORDER BY seq DESC LIMIT 1", sid)[0];
    const last = resultTexts(projectId(), 'l1').at(-1);
    record('8 po_ask', 'l1 po_ask → card_answer A', `card #${cd.id} "${cd.title}"; outbox "${row?.text.slice(0, 50)}" delivered=${row?.delivered_at !== null}; lane reply "${last?.result?.slice(0, 30)}"`,
      !!row && row.text.includes(`[cc-slaves] PO trả lời #${cd.id}`) && row.delivered_at !== null);
  },
  async i9(c) {
    const sid = laneSession(TL);
    const from = lane(c, TL)!.account!;
    const to = LANE_ACCOUNTS.find((a) => a !== from)!;
    const acct = (await Client.connect()).snapshot.accounts.find((a) => a.email === from)!;
    const cap = Math.max(1, Math.floor(acct.weekPct ?? 50) - 1);
    let m = c.mark();
    await say(c, TL, 'Run this CPU benchmark with Bash, one call, it takes about 20 s, wait for it: `python3 -c "print(sum(i*i for i in range(600_000_000)))"`, then reply SLEPT9.');
    await running(c, TL, m);
    await say(c, TL, 'Also add the word EXTRA9 to your final reply.');
    const caps = Object.fromEntries((await Client.connect()).snapshot.accounts.map((a) => [a.email, { role: a.role, week: a.email === from ? cap : a.week, ...(a.five !== null ? { five: a.five } : {}), hard: a.hard }]));
    m = c.mark();
    await c.cmd({ cmd: 'caps_update', caps });
    const moved = await c.wait(isLane(TL, (l) => l.account === to), 240_000, m, `${TL} on ${to}`);
    await c.wait(isLane(TL, (l) => l.state === 'idle' && l.account === to), 300_000, m, `${TL} idle on new account`);
    const n = runLogs(projectId(), TL).map((f) => readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('"type":"user"') && l.includes('EXTRA9')).length);
    const rows = q<{ n: number }>("SELECT count(*) n FROM outbox WHERE session_id = ? AND text LIKE '%EXTRA9%'", sid)[0]!.n;
    const last = resultTexts(projectId(), TL).at(-1);
    // restore the cap
    caps[from]!.week = acct.week;
    await c.cmd({ cmd: 'caps_update', caps });
    record('9 forced switch', `caps_update ${from} week ${acct.week}→${cap} (week ${acct.weekPct}%) mid-turn`, `${TL} ${from}→${moved.type === 'lane' ? moved.lane.account : '?'} switches=${lane(c, TL)!.switches}; EXTRA9 outbox rows=${rows}; EXTRA9 user lines per run log ${JSON.stringify(n)}; last "${last?.result?.slice(0, 40)}"; claude pids ${JSON.stringify(claudePids(sid))}`,
      lane(c, TL)!.account === to && rows === 1 && claudePids(sid).length === 1);
  },
  async i10(c) {
    const ids = q<{ id: string }>('SELECT id FROM session WHERE ended_at IS NULL').map((r) => r.id);
    const m = c.mark();
    await say(c, TL, 'Run this CPU benchmark with Bash, one call, it takes about 30 s, wait for it: `python3 -c "print(sum(i*i for i in range(900_000_000)))"`, then reply SLEPT10.');
    await running(c, TL, m);
    const before = Object.fromEntries(ids.map((id) => [id.slice(0, 8), claudePids(id)]));
    const epid = enginePid()!;
    process.kill(epid, 'SIGKILL');
    c.close();
    await Bun.sleep(3_000);
    const orphans = Object.fromEntries(ids.map((id) => [id.slice(0, 8), claudePids(id)]));
    const npid = await startEngine();
    const c2 = await Client.connect();
    const t0 = Date.now();
    await c2.cmd({ cmd: 'project_resume', id: projectId() }); // hf1116: a restart holds the project until "Tiếp tục"
    await c2.wait(isLane(TL, (l) => l.state === 'idle'), 300_000, 0, 'l1 idle after recovery').catch(() => null);
    await Bun.sleep(5_000);
    const snap = (await Client.connect()).snapshot;
    const after = Object.fromEntries(ids.map((id) => [id.slice(0, 8), claudePids(id)]));
    const states = `lanes ${snap.lanes.map((l) => `${l.name}:${l.state}`).join(',')}; orch ${snap.orchestrators.map((o) => o.state).join(',')}`;
    const ok = Object.values(after).every((p) => p.length <= 1) && Object.values(before).flat().every((p) => !Object.values(after).flat().includes(p)) && snap.lanes.every((l) => l.state === 'idle' || l.state === 'running');
    record('10 engine SIGKILL → recover', `kill -9 ${epid} mid-turn; boot → ${npid}`, `pids before ${JSON.stringify(before)}; 3 s after kill ${JSON.stringify(orphans)}; after recovery ${JSON.stringify(after)}; ${states}; l1 idle in ${Date.now() - t0} ms`, ok);
    c2.close();
  },
  async i11() {
    const { isAuthError, isLimitError, parseLine } = await import('../../engine/src/stream/parser.ts');
    const lines = ['_orchestrator', 'l1', 'l2', TL].flatMap((n) => runLogs(projectId(), n).flatMap((f) => readFileSync(f, 'utf8').split('\n')
      .filter((l) => l.includes('"type":"result"')).map((l) => ({ n, e: parseLine(l) }))));
    const rs = lines.flatMap((x) => (x.e.kind === 'result' ? [{ n: x.n, r: x.e }] : []));
    const errs = rs.filter((x) => x.r.isError).map((x) => `${x.n}:${x.r.subtype}:${x.r.result.slice(0, 60)} → ${isAuthError(x.r) ? 'auth' : isLimitError(x.r) ? 'limit' : 'other'}`);
    const fp = rs.filter((x) => !x.r.isError && ERRORISH.test(x.r.result)).length;
    record('11 result texts', 'parseLine over every run-*.jsonl result line', `${rs.length} results, ${errs.length} is_error: ${JSON.stringify(errs)}; non-error results mentioning limit/login words: ${fp}`, true);
  },
  async term(c) {
    // hf1116 B-M2: the only live proof of T2 — one haiku lane on the terminal login (real ~/.claude.json + the default
    // Keychain item, both only read). The engine restarts with them visible, then back to the pinned temp CLAUDE_JSON.
    c.close();
    await stopEngine();
    await startEngine({ terminal: true });
    const t = await Client.connect();
    try {
      const acct = t.snapshot.accounts.find((a) => a.terminal);
      if (!acct) { record('term terminal account', 'boot with the real ~/.claude.json', 'no terminal account listed (not signed in in the terminal?)', false); return; }
      if (!t.snapshot.projects.length) await t.cmd({ cmd: 'project_add', name: 'smoke', path: PROJ, orchestratorAccount: ORCH });
      let m = t.mark();
      await t.cmd({ cmd: 'project_resume', id: projectId() });
      await t.wait((e) => e.type === 'orchestrator' && e.orchestrator.state === 'idle', 180_000, m, 'orch idle').catch(() => null);
      const name = 'lt';
      m = t.mark();
      const r = await mcp(orchSession(), 'lane_start', { name, cwd: worktree(name), account: acct.email,
        brief_path: brief(name, 'Smoke test: run exactly `echo CFG=${CLAUDE_CONFIG_DIR:-unset}` with Bash, then reply with its output and nothing else.') }) as { account: string };
      await idleAfter(t, name, m);
      const sid = laneSession(name);
      const res = resultTexts(projectId(), name).at(-1)?.result ?? '';
      // CLAUDE_CONFIG_DIR unset → claude keeps the transcript under ~/.claude/projects (a config dir would hold it instead)
      const transcript = Array.from(new Bun.Glob(`*/${sid}.jsonl`).scanSync(join(homedir(), '.claude', 'projects'))).length > 0;
      await t.cmd({ cmd: 'lane_stop', projectId: projectId(), name, mode: 'now' }).catch(() => null);
      record('term terminal account', `mcp lane_start ${name} account=${acct.email}`, `picked ${r.account}; result "${res.slice(0, 60)}"; transcript in ~/.claude/projects: ${transcript}`,
        r.account === acct.email && /CFG=unset/.test(res) && transcript);
    } finally {
      t.close();
      await stopEngine();
      await startEngine();
    }
  },
  async i12(c) {
    const pid = enginePid()!;
    const cpu = () => { const t = sh(['ps', '-o', 'cputime=', '-p', String(pid)]).trim().split(/[:.]/).map(Number); return t.length === 4 ? t[0]! * 3600 + t[1]! * 60 + t[2]! + t[3]! / 100 : t[0]! * 60 + t[1]! + (t[2] ?? 0) / 100; };
    const rss = () => Number(sh(['ps', '-o', 'rss=', '-p', String(pid)]).trim()) / 1024;
    const lanes = (await Client.connect()).snapshot.lanes.map((l) => `${l.name}:${l.state}`).join(',');
    const r0 = rss(); const c0 = cpu();
    await Bun.sleep(60_000);
    const r1 = rss(); const c1 = cpu();
    void c;
    record('12 RAM/CPU', 'ps -o rss=,cputime= -p <engine> over 60 s', `${lanes}; RSS ${r0.toFixed(1)}→${r1.toFixed(1)} MB; CPU ${(c1 - c0).toFixed(2)} s / 60 s = ${(((c1 - c0) / 60) * 100).toFixed(2)} %`, r1 <= 120 && (c1 - c0) / 60 <= 0.01);
  },
  ...v27Items,
};

async function main(): Promise<void> {
  const [what, ...rest] = process.argv.slice(2);
  if (what === 'prepare') { prepare(); return; }
  if (what === 'boot') { prepare(); console.log(`engine pid ${await startEngine()}`); return; }
  if (what === 'stop') { console.log(`stopped ${await stopEngine()}`); return; }
  if (what === 'cleanup') {
    const ids = q<{ id: string }>('SELECT id FROM session').map((r) => r.id);
    const left = ids.flatMap((id) => claudePids(id));
    console.log(`sessions ${ids.length}; live claude pids ${JSON.stringify(left)}`);
    if (!left.length && process.argv.includes('--rm')) rmSync(DIR, { recursive: true, force: true });
    return;
  }
  if (what === 'all') prepare();
  if (what === 'all' && !enginePid()) await startEngine();
  const list = what === 'all' ? ['i1', 'i2', 'quiet', 'i3', 'i4', 'i5', 'i6', 'i7', 'i8', 'i9', 'i10', 'i11', 'i12', 'i13', 'i14', 'i15'] : [what!, ...rest];
  let c = await Client.connect();
  for (const it of list) {
    if (it === 'i11') { c.close(); c = await Client.connect(); } // i10 replaced the engine (and closed the old socket)
    try { await items[it]!(c); } catch (e) { record(`${it.slice(1)} ${it}`, it, `THREW ${(e as Error).message}`, false); }
  }
  c.close();
}

await main();
process.exit(results.every((r) => r.ok) ? 0 : 1); // stray snapshot clients keep the loop alive
