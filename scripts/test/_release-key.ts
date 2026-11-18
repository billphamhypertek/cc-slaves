// A throwaway updater key pair, made by the real `tauri signer` in a temp dir (never a real key), for the release tests.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TAURI = join(import.meta.dir, '../../node_modules/.bin/tauri');

function tauri(...args: string[]): void {
  const p = Bun.spawnSync([TAURI, 'signer', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (p.exitCode !== 0) throw new Error(`tauri signer ${args[0]}: ${p.stderr.toString()}`);
}

/** `pubkey` = the tauri.conf.json value; `sign(file)` = the `.sig` content `tauri signer sign` writes. */
export function throwawayKey(): { pubkey: string; sign: (file: string) => string } {
  const key = join(mkdtempSync(join(tmpdir(), 'ccs-key-')), 'updater.key');
  tauri('generate', '--ci', '-p', '', '-w', key);
  return {
    pubkey: readFileSync(`${key}.pub`, 'utf8').trim(),
    sign: (file) => {
      tauri('sign', '-f', key, '-p', '', file);
      return readFileSync(`${file}.sig`, 'utf8');
    },
  };
}
