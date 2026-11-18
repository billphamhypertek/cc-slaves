// Engine version (§7.1): the app replaces an engine whose version differs from its own. Single source: the root
// package.json `version` — bundled here by `bun build --compile`, and read by Tauri (`tauri.conf.json` → ../package.json).
import pkg from '../../package.json' with { type: 'json' };

export const ENGINE_VERSION: string = pkg.version;
