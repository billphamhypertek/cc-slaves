// Test IssuePorts (v2.7 §5.2–§5.5, v2.9 §5.3 / §5.8): the real store + events over `db`, recorded session sends, the real git runner.
import type { Db } from '../../src/db.ts';
import { IssueEvents } from '../../src/issues/events.ts';
import type { IssuePorts } from '../../src/mcp/issue-tools.ts';
import { execIn } from '../../src/setup/setup.ts';

export interface PortLog { sent: { sid: string; text: string }[]; renamed: [string, string][]; closing: string[]; changed: string[]; conflicts: [string, string, string][]; started: [string, string][] }

export function issuePorts(db: Db, o: { superpowers?: () => boolean; running?: (sid: string) => boolean; startNext?: (projectId: string, path: string) => Promise<unknown> } = {}): IssuePorts & { log: PortLog } {
  const log: PortLog = { sent: [], renamed: [], closing: [], changed: [], conflicts: [], started: [] };
  const events = new IssueEvents({
    db, send: (sid, text) => log.sent.push({ sid, text }), running: o.running ?? (() => true), hasRoom: () => true,
    timers: { set: () => 0, clear: () => {} },
  });
  return {
    db, exec: execIn(process.env), events, log,
    rename: (sid, title) => log.renamed.push([sid, title]), closeWhenIdle: (sid) => log.closing.push(sid),
    // `superpowers` false = the workflow's first required plugin is off (v2.9 §5.8)
    missingPlugin: (_p, plugins) => (o.superpowers?.() === false ? plugins[0] ?? null : null), changed: (p) => log.changed.push(p),
    startNext: async (p, path) => { log.started.push([p, path]); await o.startNext?.(p, path); },
    conflict: (orig, revert, detail) => log.conflicts.push([orig.key, revert.key, detail]),
  };
}
