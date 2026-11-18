import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRatchet, type Finding } from './ratchet';

/**
 * `bun run check:dead` (coding standard §6 "no dead code"), two knip passes, each ratcheted per file and issue kind:
 * 1. knip over `knip.json` (tests are entries) against `scripts/dead-baseline.json`: an unused file, export, type or
 *    dependency is red.
 * 2. `knip --production` (only the `!` entries / projects; tests are not entries) against
 *    `scripts/dead-prod-baseline.json`: code that only tests keep alive is red. Exports used in their own file are not
 *    counted here (`ignoreExportsUsedInFile`), and a test seam says so with a `@internal` JSDoc tag.
 */

interface KnipIssue { file: string; [kind: string]: unknown }
function knip(extra: string[]): Finding[] {
  const r = spawnSync('bunx', ['knip', '--no-progress', '--reporter', 'json', ...extra], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.error) throw r.error;
  const issues = (JSON.parse(r.stdout) as { issues: KnipIssue[] }).issues;
  return issues.flatMap((issue) => Object.entries(issue).flatMap(([kind, list]) =>
    Array.isArray(list) ? (list as { name?: string; line?: number }[]).map((x) => ({ file: issue.file, line: x.line ?? 0, kind, text: x.name ?? '' })) : []));
}

const argv = process.argv.slice(2);
const dev = runRatchet({ name: 'check:dead', cmd: 'bun run check:dead', baseline: 'scripts/dead-baseline.json', findings: knip([]), argv });

const dir = mkdtempSync(join(tmpdir(), 'knip-prod-'));
let prod: number;
try {
  const cfg = join(dir, 'knip.json');
  writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync('knip.json', 'utf8')), ignoreExportsUsedInFile: true }));
  prod = runRatchet({ name: 'check:dead --production', cmd: 'bun run check:dead', baseline: 'scripts/dead-prod-baseline.json',
    findings: knip(['--production', '--config', cfg]), argv });
} finally { rmSync(dir, { recursive: true, force: true }); }
process.exitCode = Math.max(dev, prod);
