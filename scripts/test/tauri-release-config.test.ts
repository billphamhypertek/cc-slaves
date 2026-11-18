// Spec v2.6 §10.1: the release-only Tauri config (merged by app-build.sh when CC_SLAVES_RELEASE=1) turns on the updater
// artifacts (.app.tar.gz + .sig) and nothing else — a release build differs from a local one only there.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '../..');

test('§10.1 tauri.release.json = bundle.createUpdaterArtifacts: true, nothing else', () => {
  const cfg: unknown = JSON.parse(readFileSync(join(REPO, 'src-tauri/tauri.release.json'), 'utf8'));
  expect(cfg).toEqual({ bundle: { createUpdaterArtifacts: true } });
});

test('§10.1 the base config leaves updater artifacts off (a local build needs no signing key)', () => {
  const base = JSON.parse(readFileSync(join(REPO, 'src-tauri/tauri.conf.json'), 'utf8')) as { bundle: Record<string, unknown> };
  const bundle = JSON.parse(readFileSync(join(REPO, 'src-tauri/tauri.bundle.json'), 'utf8')) as { bundle?: Record<string, unknown> };
  expect(base.bundle.createUpdaterArtifacts).toBeUndefined();
  expect(bundle.bundle?.createUpdaterArtifacts).toBeUndefined();
});
