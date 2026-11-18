// v2.6 §5.5-4 (R22) `update-resume.json`: written only on a successful `update_commit`, read once at the next boot
// (≤ 10 min old → the projects to wake), always deleted after the read.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RESUME_MAX_AGE_MS, takeResume, writeResume } from '../../src/update/resume.ts';

let dir: string; let file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'resume-')); file = join(dir, 'update-resume.json'); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('§5.5-4 write: {from, at, projects} via a temp file + rename (nothing else left in the dir)', () => {
  writeResume(file, { from: '0.3.0', at: 5_000, projects: ['p1', 'p2'] });
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ from: '0.3.0', at: 5_000, projects: ['p1', 'p2'] });
  expect(readdirSync(dir)).toEqual(['update-resume.json']);
});

test('§5.5-4 take within 10 min → the projects, and the file is gone (read once)', () => {
  writeResume(file, { from: '0.3.0', at: 1_000, projects: ['p1'] });
  expect(takeResume(file, 1_000 + RESUME_MAX_AGE_MS)).toEqual(['p1']);
  expect(existsSync(file)).toBe(false);
  expect(takeResume(file, 1_000)).toEqual([]);
});

test('§5.5-4 older than 10 min → nothing wakes, the file is deleted', () => {
  writeResume(file, { from: '0.3.0', at: 1_000, projects: ['p1'] });
  expect(takeResume(file, 1_001 + RESUME_MAX_AGE_MS)).toEqual([]);
  expect(existsSync(file)).toBe(false);
});

test('§5.5-4 broken file (not JSON, wrong shape) → nothing wakes, the file is deleted; no file → nothing', () => {
  expect(takeResume(file, 0)).toEqual([]);
  for (const body of ['{', '{"at":1,"projects":"p1"}', '{"at":"x","projects":["p1"]}', '{"at":1,"projects":[1]}']) {
    writeFileSync(file, body);
    expect(takeResume(file, 1)).toEqual([]);
    expect(existsSync(file)).toBe(false);
  }
});
