// Temp CC_SLAVES_HOME / CC_SLAVES_ACCOUNTS / CC_SLAVES_ATTACH for the attachment tests (spec v2.4 §10.2 A11): never the real dirs.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KEYS = ['CC_SLAVES_HOME', 'CC_SLAVES_ACCOUNTS', 'CC_SLAVES_ATTACH'] as const;

export interface AttachEnv { tmp: string; home: string; accts: string; attach: string; restore(): void }

export function attachEnv(): AttachEnv {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ccs-attach-')));
  const home = join(tmp, 'home');
  const accts = join(tmp, 'accts');
  const attach = join(tmp, 'attach');
  for (const d of [home, accts]) mkdirSync(d, { recursive: true });
  process.env.CC_SLAVES_HOME = home;
  process.env.CC_SLAVES_ACCOUNTS = accts;
  process.env.CC_SLAVES_ATTACH = attach;
  return {
    tmp, home, accts, attach,
    restore() {
      for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

export const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
export const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
export const GIF = new TextEncoder().encode('GIF89a\x01\x00\x01\x00');
export const WEBP = new TextEncoder().encode('RIFF\x10\x00\x00\x00WEBPVP8 ');
