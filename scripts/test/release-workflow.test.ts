// Spec v2.6 §7.3 / §10.1: the release workflow (parsed, and its release step run with a stub `gh`) and the
// CC_SLAVES_RELEASE flag of app-build.sh (run in a temp tree with stub bun / cargo / codesign).
import { expect, test } from 'bun:test';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '../..');
type Step = { name?: string; run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, string> };
type Job = { if: string; 'runs-on': string; env?: unknown; strategy: { matrix: { include: Record<string, string>[] } }; steps: Step[] };
type Wf = { on: { push: { tags: string[] } }; permissions: Record<string, string>; env?: unknown; jobs: Record<string, Job> };
const WF = Bun.YAML.parse(readFileSync(join(REPO, '.github/workflows/release.yml'), 'utf8')) as Wf;
const JOB = Object.values(WF.jobs)[0]!;
const runs = JOB.steps.map((s) => s.run ?? '');
const at = (needle: string) => runs.findIndex((r) => r.includes(needle));

test('§7.3 trigger, guard, permissions and a one-element matrix', () => {
  expect(WF.on.push.tags).toEqual(['v*.*.*']);
  expect(Object.keys(WF.jobs)).toHaveLength(1);
  expect(JOB.if).toBe("github.repository == 'billphamhypertek/cc-slaves'");
  expect(WF.permissions).toEqual({ contents: 'write' });
  expect(JOB.strategy.matrix.include).toEqual([{ runner: 'macos-15', target: 'aarch64-apple-darwin', key: 'darwin-aarch64' }]);
  expect(JOB['runs-on']).toBe('${{ matrix.runner }}');
});

test('§7.3 the signing key lives only in the env of the app-build step; nothing prints it', () => {
  expect(JSON.stringify(WF.env ?? {}) + JSON.stringify(JOB.env ?? {})).not.toContain('SIGNING');
  const keyed = JOB.steps.filter((s) => JSON.stringify(s.env ?? {}).includes('TAURI_SIGNING_PRIVATE_KEY'));
  expect(keyed).toHaveLength(1);
  expect(keyed[0]!.run?.trim()).toBe('bash scripts/app-build.sh');
  expect(keyed[0]!.env).toEqual({
    CC_SLAVES_RELEASE: '1',
    TAURI_SIGNING_PRIVATE_KEY: '${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}',
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}',
  });
  for (const r of runs) expect(r).not.toMatch(/set -[a-wyz]*x|set -o xtrace/);
});

test('§7.3 step order: tag check → frozen install → cheap tests → signed build → package → latest.json → draft', () => {
  const order = ['scripts/release/bump.ts --check', 'bun install --frozen-lockfile', 'bun run typecheck', 'bun run test\n',
    'bun run test:web', 'bash scripts/app-build.sh', 'ditto -c -k --keepParent', 'scripts/release/latest-json.ts', 'gh release create'];
  const idx = order.map((n) => at(n));
  expect(idx.every((i) => i >= 0)).toBe(true);
  expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  const uses = JOB.steps.map((s) => s.uses ?? '').filter(Boolean);
  expect(uses.some((u) => u.startsWith('actions/checkout@'))).toBe(true);
  const pins = JOB.steps.map((s) => s.with ?? {});
  expect(pins.some((w) => /^\d+\.\d+\.\d+$/.test(w['bun-version'] ?? ''))).toBe(true);
  expect(pins.some((w) => /^\d+\.\d+\.\d+$/.test(w.toolchain ?? ''))).toBe(true);
  expect(pins.some((w) => /^24\.\d+\.\d+$/.test(w['node-version'] ?? ''))).toBe(true);
});

function stubBin(names: string[], log: string): string {
  const bin = mkdtempSync(join(tmpdir(), 'ccs-stub-'));
  for (const n of names) {
    writeFileSync(join(bin, n), `#!/bin/bash\necho "${n} $*" >> "${log}"\n`);
    chmodSync(join(bin, n), 0o755);
  }
  return bin;
}
function releaseStep(tag: string): string {
  const step = JOB.steps.find((s) => s.run?.includes('gh release create'))!;
  const root = mkdtempSync(join(tmpdir(), 'ccs-gh-'));
  const ver = tag.slice(1);
  mkdirSync(join(root, 'out'));
  mkdirSync(join(root, 'docs/releases'), { recursive: true });
  writeFileSync(join(root, `docs/releases/${ver}.md`), 'n');
  for (const f of [`cc-slaves_${ver}_aarch64.app.tar.gz`, `cc-slaves_${ver}_aarch64.app.tar.gz.sig`, `cc-slaves_${ver}_aarch64.zip`, 'latest.json']) {
    writeFileSync(join(root, 'out', f), 'x');
  }
  const log = join(root, 'calls.log');
  const p = Bun.spawnSync(['bash', '-e', '-c', step.run!], {
    cwd: root, stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, PATH: `${stubBin(['gh'], log)}:${process.env.PATH}`, GITHUB_REF_NAME: tag, GH_TOKEN: 't' },
  });
  expect(p.stderr.toString()).toBe('');
  return readFileSync(log, 'utf8');
}

test('§7.3 draft release with the four files and the notes; a "-" tag adds --prerelease', () => {
  const final = releaseStep('v0.3.0');
  expect(final).toContain('gh release create v0.3.0');
  expect(final).toContain('--draft');
  expect(final).not.toContain('--prerelease');
  expect(final).toContain('docs/releases/0.3.0.md');
  for (const f of ['cc-slaves_0.3.0_aarch64.app.tar.gz', 'cc-slaves_0.3.0_aarch64.app.tar.gz.sig', 'cc-slaves_0.3.0_aarch64.zip', 'latest.json']) {
    expect(final).toContain(`out/${f}`);
  }
  expect(releaseStep('v0.3.0-rc.1')).toContain('--prerelease');
});

function appBuild(release: string | undefined): string {
  const root = mkdtempSync(join(tmpdir(), 'ccs-appbuild-'));
  mkdirSync(join(root, 'scripts'));
  cpSync(join(REPO, 'scripts/app-build.sh'), join(root, 'scripts/app-build.sh'));
  writeFileSync(join(root, 'package.json'), '{ "scripts": { "build:engine": "x" } }');
  mkdirSync(join(root, 'menubar/target/release'), { recursive: true });
  writeFileSync(join(root, 'menubar/target/release/cc-slaves-menubar'), '');
  const app = join(root, 'src-tauri/target/release/bundle/macos/cc-slaves.app/Contents/Resources');
  mkdirSync(join(app, 'web'), { recursive: true });
  for (const f of ['cc-slaves', 'cc-slaves-menubar', 'web/index.html']) writeFileSync(join(app, f), '');
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist/cc-slaves'), '');
  const log = join(root, 'calls.log');
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${stubBin(['bun', 'cargo', 'codesign'], log)}:${process.env.PATH}` };
  if (release === undefined) delete env.CC_SLAVES_RELEASE;
  else env.CC_SLAVES_RELEASE = release;
  const p = Bun.spawnSync(['bash', join(root, 'scripts/app-build.sh')], { env, stdout: 'pipe', stderr: 'pipe' });
  expect(p.exitCode).toBe(0);
  return readFileSync(log, 'utf8').split('\n').find((l) => l.startsWith('bun x tauri build')) ?? '';
}

test('§10.1 app-build.sh: CC_SLAVES_RELEASE=1 adds tauri.release.json after tauri.bundle.json; a local build does not', () => {
  expect(appBuild('1')).toBe('bun x tauri build --bundles app --config src-tauri/tauri.bundle.json --config src-tauri/tauri.release.json');
  expect(appBuild(undefined)).toBe('bun x tauri build --bundles app --config src-tauri/tauri.bundle.json');
  expect(appBuild('0')).toBe('bun x tauri build --bundles app --config src-tauri/tauri.bundle.json');
});
