/**
 * The Tauri updater key and signature format (spec v2.6 §7.2): minisign Ed25519, each file base64 of the minisign text.
 * `tauri signer sign` writes the prehashed form (`ED`, Ed25519 over BLAKE2b-512 of the file); plain `Ed` is accepted too.
 * Node builtins + Bun only: `bump.ts --check` runs before `bun install` in the release workflow.
 */
import { createPublicKey, verify } from 'node:crypto';

const BASE64 = /^(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type Pubkey = { id: Buffer; key: Buffer };

/** Strict base64 → its bytes (Buffer alone decodes `abc!!` leniently). */
function b64(text: string): Buffer | null {
  return BASE64.test(text) ? Buffer.from(text, 'base64') : null;
}

/** `untrusted comment: …` + base64 of `Ed` · key id (8) · Ed25519 key (32). Null = not a minisign public key. */
export function parsePubkey(conf: unknown): Pubkey | null {
  if (typeof conf !== 'string') return null;
  const lines = b64(conf)?.toString('utf8').split('\n') ?? [];
  if (!lines[0]?.startsWith('untrusted comment:')) return null;
  const raw = b64(lines[1]?.trim() ?? '');
  if (raw?.length !== 42 || raw.subarray(0, 2).toString() !== 'Ed') return null;
  return { id: raw.subarray(2, 10), key: raw.subarray(10) };
}

function ed25519(pk: Buffer, msg: Buffer, sig: Buffer): boolean {
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pk.toString('base64url') }, format: 'jwk' });
  return verify(null, msg, key, sig);
}

/** Why the `.sig` content does not verify `file` under `pk` (null = it does): signature, then the trusted comment. */
export function sigError(pk: Pubkey, sigFile: string, file: Buffer): string | null {
  const lines = b64(sigFile.trim())?.toString('utf8').split('\n') ?? [];
  const sig = b64(lines[1]?.trim() ?? '');
  const trusted = lines[2]?.startsWith('trusted comment: ') ? lines[2].slice('trusted comment: '.length) : null;
  const global = b64(lines[3]?.trim() ?? '');
  if (sig?.length !== 74 || trusted === null || global?.length !== 64) return 'is not a minisign signature';
  const alg = sig.subarray(0, 2).toString();
  if (alg !== 'ED' && alg !== 'Ed') return `has the unknown algorithm ${alg}`;
  if (!sig.subarray(2, 10).equals(pk.id)) return 'was made by another key than plugins.updater.pubkey';
  const msg = alg === 'ED' ? Buffer.from(new Bun.CryptoHasher('blake2b512').update(file).digest()) : file;
  if (!ed25519(pk.key, msg, sig.subarray(10))) return 'does not match the bundle under plugins.updater.pubkey';
  if (!ed25519(pk.key, Buffer.concat([sig.subarray(10), Buffer.from(trusted)]), global)) return 'has a forged trusted comment';
  return null;
}
