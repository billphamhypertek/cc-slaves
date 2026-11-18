// Spec v2.6 §7.3 / §13 "Script": latest.json for the Tauri updater (key, URL from GITHUB_REPOSITORY, signature = .sig content).
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { throwawayKey } from './_release-key';

const LATEST = join(import.meta.dir, '../../scripts/release/latest-json.ts');
const A = throwawayKey();
const B = throwawayKey();
const BUNDLE = 'tar.gz bytes of the app\n';
/** A real `.sig` of BUNDLE under key A, read once. */
const SIG = (() => {
  const f = join(mkdtempSync(join(tmpdir(), 'ccs-bundle-')), 'b.tar.gz');
  writeFileSync(f, BUNDLE);
  return A.sign(f);
})();

function setup(ver: string, sig: string | null, notes: string | null, pubkey: unknown = A.pubkey, bundle = BUNDLE) {
  const root = mkdtempSync(join(tmpdir(), 'ccs-latest-'));
  mkdirSync(join(root, 'out'));
  mkdirSync(join(root, 'docs/releases'), { recursive: true });
  mkdirSync(join(root, 'src-tauri'));
  writeFileSync(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ plugins: { updater: { pubkey } } }));
  writeFileSync(join(root, `out/cc-slaves_${ver}_aarch64.app.tar.gz`), bundle);
  if (sig !== null) writeFileSync(join(root, `out/cc-slaves_${ver}_aarch64.app.tar.gz.sig`), sig);
  if (notes !== null) writeFileSync(join(root, `docs/releases/${ver}.md`), notes);
  return root;
}
function run(root: string, repo: string | undefined, ...args: string[]) {
  const env = { ...process.env, GITHUB_REPOSITORY: repo };
  if (repo === undefined) delete env.GITHUB_REPOSITORY;
  const p = Bun.spawnSync(['bun', LATEST, ...args], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}
type Latest = { version: string; notes: string; pub_date: string; platforms: Record<string, { url: string; signature: string }> };

test('§7.3 latest.json: darwin-aarch64 key, download URL of GITHUB_REPOSITORY, signature = .sig content, notes file', () => {
  const root = setup('0.3.1', `${SIG}\n`, 'Bản mới.\n---\nNew build.\n');
  expect(run(root, 'someone/cc-slaves', '0.3.1', 'out').code).toBe(0);
  const j = JSON.parse(readFileSync(join(root, 'out/latest.json'), 'utf8')) as Latest;
  expect(j.version).toBe('0.3.1');
  expect(Object.keys(j.platforms)).toEqual(['darwin-aarch64']);
  expect(j.platforms['darwin-aarch64']).toEqual({
    signature: SIG.trim(),
    url: 'https://github.com/someone/cc-slaves/releases/download/v0.3.1/cc-slaves_0.3.1_aarch64.app.tar.gz',
  });
  expect(j.notes).toBe('Bản mới.\n---\nNew build.');
  expect(Number.isNaN(Date.parse(j.pub_date))).toBe(false);
  expect(j.pub_date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
});

test('§7.3 latest.json refuses: no GITHUB_REPOSITORY, a bad repo, a missing .sig, missing notes, a bad version', () => {
  expect(run(setup('0.3.1', SIG, 'n'), undefined, '0.3.1', 'out').code).toBe(1);
  expect(run(setup('0.3.1', SIG, 'n'), 'no-slash', '0.3.1', 'out').code).toBe(1);
  expect(run(setup('0.3.1', null, 'n'), 'a/b', '0.3.1', 'out').code).toBe(1);
  expect(run(setup('0.3.1', '  \n', 'n'), 'a/b', '0.3.1', 'out').code).toBe(1);
  expect(run(setup('0.3.1', SIG, null), 'a/b', '0.3.1', 'out').code).toBe(1);
  expect(run(setup('0.3.1', SIG, 'n'), 'a/b', 'v0.3.1', 'out').code).toBe(1);
  const noBundle = setup('0.3.1', SIG, 'n');
  rmSync(join(noBundle, 'out/cc-slaves_0.3.1_aarch64.app.tar.gz'));
  expect(run(noBundle, 'a/b', '0.3.1', 'out').code).toBe(1);
});

test('§7.2 latest.json refuses a .sig that does not verify under plugins.updater.pubkey (IMPORTANT-6)', () => {
  const refuse = (root: string, why: string) => {
    const r = run(root, 'a/b', '0.3.1', 'out');
    expect(r.code).toBe(1);
    expect(r.out).toContain(why);
    expect(() => readFileSync(join(root, 'out/latest.json'))).toThrow();
  };
  refuse(setup('0.3.1', SIG, 'n', B.pubkey), 'another key'); // the app would carry key B, the bundle is signed with A
  refuse(setup('0.3.1', SIG, 'n', A.pubkey, `${BUNDLE}tampered`), 'does not match the bundle');
  const sigLines = Buffer.from(SIG.trim(), 'base64').toString('utf8').split('\n');
  sigLines[2] = `${sigLines[2]}x`;
  refuse(setup('0.3.1', Buffer.from(sigLines.join('\n')).toString('base64'), 'n'), 'forged trusted comment');
  refuse(setup('0.3.1', Buffer.from('untrusted comment: x\n').toString('base64'), 'n'), 'not a minisign signature');
});

test('§7.2 latest.json refuses a release whose app would carry the placeholder or a broken updater key', () => {
  const bad = (pubkey: unknown) => run(setup('0.3.1', SIG, 'n', pubkey), 'a/b', '0.3.1', 'out');
  const placeholder = bad('O2-PLACEHOLDER: the orchestrator commits the real minisign public key here (spec v2.6 §7.2)');
  expect(placeholder.code).toBe(1);
  expect(placeholder.out).toContain('plugins.updater.pubkey');
  expect(bad('not base64 at all!').code).toBe(1);
  expect(bad(`${A.pubkey}!!`).code).toBe(1); // Buffer decodes this leniently to a valid-looking key
  expect(bad(Buffer.from('some other text').toString('base64')).code).toBe(1);
  expect(bad(null).code).toBe(1);
  expect(bad(A.pubkey).code).toBe(0);
});
