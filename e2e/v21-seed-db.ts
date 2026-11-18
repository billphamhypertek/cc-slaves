#!/usr/bin/env bun
// v2.1 e2e seed (spec §6 "Phiên, e2e" / "Quy mô / Xong / thông báo, e2e"): writes a project, its orchestrator sessions,
// live lanes and done lanes (with a measured branch) straight into the temp home's state.db BEFORE the engine boots.
// Boot recovery (engine/src/recovery.ts) then restores each session row: orchestrators boot on fake-claude, quiet lanes
// come back without a process. Run by e2e/v21-seed.ts (`bun e2e/v21-seed-db.ts`, env as the engine's) with $V21_SEED =
// the path of a `V21Seed` JSON.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { insertEvent, insertLane, insertProject, openDb, setLaneBranch, setSessionModel, updateLaneFields, updateLaneState, type SessionModel } from '../engine/src/db.ts';
import { transcriptPath } from '../engine/src/orchestrator/resume.ts';
import { ensureHome, paths } from '../engine/src/paths.ts';

export type BranchState = 'unmerged' | 'merged' | 'gone' | 'none' | 'unknown';
export interface SeedLane { name: string; owner: string; account: string; cwd: string; task: string; phase?: string; done?: { agoMin: number; branch: BranchState } }
export interface V21Seed {
  project: { id: string; name: string; path: string; account: string };
  /** `model`: v2.4 §4.4 the picks + last model the session ran with (MD11 "Chạy tiếp" prefills them). */
  sessions: { id: string; seq: number; title?: string; account: string; ended?: { ctx: number; handoff: boolean; transcript: boolean }; model?: SessionModel }[];
  lanes: SeedLane[];
}

if (import.meta.main) seed(JSON.parse(readFileSync(process.env.V21_SEED!, 'utf8')) as V21Seed);

function seed(seed: V21Seed): void {
  ensureHome();
  const db = openDb(paths().stateDb);
  const nowS = Math.floor(Date.now() / 1000);
  const p = seed.project;
  insertProject(db, { id: p.id, name: p.name, path: p.path, orchestratorAccount: p.account });
  seed.sessions.forEach((s, i) => {
    const e = s.ended;
    const handoff = e?.handoff ? join(p.path, '.local-check', `orchestrator-${s.seq}.md`) : null;
    db.query(`INSERT INTO session (id, project_id, kind, account, account_home, state, seq, title, created_at, opened_at, ended_at, end_reason, ctx_last, handoff_path)
      VALUES (?, ?, 'orchestrator', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(s.id, p.id, s.account, s.account, e ? 'done' : 'idle', s.seq, s.title ?? null, nowS - 7200 + i, Date.now() - 7_200_000 + i * 1000,
        e ? nowS - 3600 + i : null, e ? 'handoff' : null, e?.ctx ?? null, handoff);
    if (s.model) setSessionModel(db, s.id, s.model);
    if (handoff) { mkdirSync(join(p.path, '.local-check'), { recursive: true }); writeFileSync(handoff, `# handoff #${s.seq}\n`); }
    // the session answered at least once (else "chưa từng trả lời", §4.14 N5-i)
    if (e) insertEvent(db, { sessionId: s.id, type: 'result', json: { account: s.account, usage: { input_tokens: 900, output_tokens: 2100 } }, ts: Date.now() - 4_000_000 });
    // …so its first message was delivered: a resume is a real `--resume` with the engine's "nối lại" line (m-5), not a fresh start
    if (e) db.query('INSERT INTO outbox (uuid, session_id, text, prefix, created_at, delivered_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`seed-${s.id}`, s.id, 'Bắt đầu điều phối.', '[cc-slaves]', nowS - 4100, nowS - 4000);
    if (e?.transcript) { // §4.14 resumable = Claude Code's jsonl still on disk
      const t = transcriptPath(paths().claudeHome, p.path, s.id);
      mkdirSync(join(t, '..'), { recursive: true });
      writeFileSync(t, '{}\n');
    }
  });
  for (const l of seed.lanes) {
    const sid = `lane-${l.name}`;
    db.query("INSERT INTO session (id, project_id, kind, account, state, created_at, opened_at, ended_at) VALUES (?, ?, 'lane', ?, ?, ?, ?, ?)")
      .run(sid, p.id, l.account, l.done ? 'done' : 'idle', nowS - 1800, Date.now() - 1_800_000, l.done ? nowS - 60 : null);
    const row = insertLane(db, { projectId: p.id, name: l.name, cwd: l.cwd, sessionId: sid, task: l.task, ownerSession: l.owner, briefPath: `/briefs/${l.name}.md` });
    updateLaneFields(db, row.id, { phase: l.done ? 'done' : (l.phase ?? 'code'), task: l.task });
    updateLaneState(db, row.id, l.done ? 'done' : 'idle');
    if (l.done) {
      // newest first: doneAgoMin orders the list; measuredAt in the future keeps the 60 s re-measure (real git) away
      db.query('UPDATE lane SET done_at = ? WHERE id = ?').run(nowS - l.done.agoMin * 60, row.id);
      const b = l.done.branch;
      setLaneBranch(db, row.id, { name: b === 'none' ? null : `lane/${l.name.toLowerCase()}`, info: {
        name: b === 'none' ? null : `lane/${l.name.toLowerCase()}`, base: 'main', state: b, ahead: b === 'unmerged' ? 2 : 0,
        files: b === 'unmerged' ? 6 : 0, add: b === 'unmerged' ? 170 : 0, del: b === 'unmerged' ? 28 : 0, measuredAt: Date.now() + 3_600_000,
        ...(b === 'unknown' ? { reason: 'repo đang khoá' } : {}) } });
    }
  }
  db.close();
}
