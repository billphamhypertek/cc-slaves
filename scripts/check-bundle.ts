import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

/**
 * `check:bundle` (coding standard §1, spec v2.1 §5.6) — runs at the end of `bun run web:build`. Gzip size of each chunk
 * of `web/dist/assets` (keyed by chunk name without the hash: `index.js`, `DeckView.css` …) against `limitKb` in
 * `scripts/bundle-budget.json`, plus the JS total (CSS chunks are capped one by one). Red when a limit is exceeded, or when the dist carries three.js / WebGL.
 * A red means: make the new code lazy, or (only when the growth is the feature itself) raise one limit with `lane` +
 * `reason` in the json, in its own commit. Never raise a limit silently.
 */

/** `inTotal: false` = a lazy chunk off the first paint — the UI-language catalog (`en.js`, an alternative to the language inlined
 *  in `index.js`; spec v2.1 §5.6, lane v21-t10) or the highlighter loaded on the first code block (`hljs.js`, spec v2.2 §14.5) —
 *  capped on its own and left out of the JS total. */
export interface Budget { chunks: Record<string, { limitKb: number; inTotal?: boolean }>; totalKb: number; lane: string; reason: string }
export interface Chunk { key: string; kb: number; text: string }

/** `DeckView-C9Kq8kES.js` → `DeckView.js`. */
export const chunkKey = (file: string): string => file.replace(/-[A-Za-z0-9_-]{8}(\.[a-z]+)$/, '$1');

export function checkBundle(chunks: readonly Chunk[], budget: Budget): string[] {
  const reds: string[] = [];
  let total = 0;
  for (const c of chunks) {
    const own = budget.chunks[c.key], limit = own?.limitKb;
    if (c.key.endsWith('.js') && own?.inTotal !== false) total += c.kb; // spec v2.1 §5.6 ruling: the total caps JS; CSS chunks have their own limits
    if (limit !== undefined && c.kb > limit) reds.push(`${c.key}: ${c.kb.toFixed(2)} KB gzip > ${limit} KB`);
    if (/WebGLRenderer|THREE\.REVISION/.test(c.text)) reds.push(`${c.key}: carries three.js / WebGL (spec v2.1 §5.6)`);
  }
  if (total > budget.totalKb) reds.push(`total: ${total.toFixed(2)} KB gzip > ${budget.totalKb} KB`);
  return reds;
}

if (import.meta.main) {
  const dir = join(process.cwd(), 'web/dist/assets');
  const budget = JSON.parse(readFileSync(join(process.cwd(), 'scripts/bundle-budget.json'), 'utf8')) as Budget;
  const chunks = readdirSync(dir).filter((f) => /\.(js|css)$/.test(f)).sort().map((f) => {
    const text = readFileSync(join(dir, f), 'utf8');
    return { key: chunkKey(f), kb: gzipSync(text).length / 1024, text };
  });
  for (const c of chunks) {
    const limit = budget.chunks[c.key]?.limitKb;
    process.stdout.write(`${c.key.padEnd(16)} ${c.kb.toFixed(2).padStart(8)} KB gzip  ${limit === undefined ? '(no limit; counts in total)' : `/ ${limit}`}\n`);
  }
  const reds = checkBundle(chunks, budget);
  for (const r of reds) process.stdout.write(`RED ${r}\n`);
  process.stdout.write(`check:bundle: ${reds.length} red\n`);
  process.exitCode = reds.length > 0 ? 1 : 0;
}
