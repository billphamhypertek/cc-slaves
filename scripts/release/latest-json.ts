/**
 * `bun scripts/release/latest-json.ts <ver> <dir>` — write `<dir>/latest.json` for the Tauri updater (spec v2.6 §7.3).
 * Key `darwin-aarch64`; URL = the release download of `$GITHUB_REPOSITORY` (never the API URL, 60 calls / h — NC §2);
 * signature = the content of `<dir>/cc-slaves_<ver>_aarch64.app.tar.gz.sig`; notes = `docs/releases/<ver>.md`
 * (Vietnamese, `---`, English — UP2 splits it). Run from the repo root. Refuses unless the `.sig` verifies the bundle
 * under the app's updater key (`src-tauri/tauri.conf.json` `plugins.updater.pubkey`, §7.2): an app built with another
 * key would reject every later update as forged (UP6b, forever).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePubkey, sigError } from './minisign';

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const CONF = 'src-tauri/tauri.conf.json';

function fail(msg: string): number {
  console.error(`latest-json: ${msg}`);
  return 1;
}

function main(argv: string[]): number {
  const [ver, dir] = argv;
  if (ver === undefined || dir === undefined || !SEMVER.test(ver)) return fail('usage: latest-json.ts <major.minor.patch[-pre]> <dir>');
  const repo = process.env.GITHUB_REPOSITORY ?? '';
  if (!REPO.test(repo)) return fail(`GITHUB_REPOSITORY must be owner/name, is "${repo}"`);
  const pk = parsePubkey((JSON.parse(readFileSync(CONF, 'utf8')) as { plugins?: { updater?: { pubkey?: unknown } } }).plugins?.updater?.pubkey);
  if (pk === null) return fail(`${CONF} plugins.updater.pubkey is not a minisign public key`);
  const bundle = `cc-slaves_${ver}_aarch64.app.tar.gz`;
  const sigPath = join(dir, `${bundle}.sig`);
  const notesPath = join('docs/releases', `${ver}.md`);
  for (const p of [join(dir, bundle), sigPath, notesPath]) if (!existsSync(p)) return fail(`missing ${p}`);
  const signature = readFileSync(sigPath, 'utf8').trim();
  const bad = sigError(pk, signature, readFileSync(join(dir, bundle)));
  if (bad !== null) return fail(`${sigPath} ${bad}`);
  const latest = {
    version: ver,
    notes: readFileSync(notesPath, 'utf8').trim(),
    pub_date: new Date().toISOString(),
    platforms: {
      'darwin-aarch64': { signature, url: `https://github.com/${repo}/releases/download/v${ver}/${bundle}` },
    },
  };
  writeFileSync(join(dir, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
  console.log(`latest-json: ${join(dir, 'latest.json')}`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
