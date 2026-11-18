import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The per-file count ratchet shared by `bun run lint` and `bun run check:dead` (coding standard §1): counts keyed by
 * file then rule / issue kind, against a baseline json that may only shrink.
 */

export type Counts = Record<string, Record<string, number>>;
export interface Finding { file: string; line: number; kind: string; text: string }

/** Red lines of one run: every key measured above its baseline, and every baseline key measured below it. */
export function compare(measured: Counts, baseline: Counts, cmd: string): string[] {
  const reds: string[] = [];
  for (const [file, kinds] of Object.entries(measured)) {
    for (const [kind, n] of Object.entries(kinds)) {
      const was = baseline[file]?.[kind] ?? 0;
      if (n > was) reds.push(`${file} ${kind}: ${n} > baseline ${was}`);
    }
  }
  for (const [file, kinds] of Object.entries(baseline)) {
    for (const [kind, was] of Object.entries(kinds)) {
      const n = measured[file]?.[kind] ?? 0;
      if (n < was) reds.push(`${file} ${kind}: ${n} < baseline ${was}: run \`${cmd} --update\``);
    }
  }
  return reds;
}

/** `--update`: min(measured, baseline) per key, dropping zeros; never adds a key. */
export function shrink(measured: Counts, baseline: Counts): Counts {
  const out: Counts = {};
  for (const [file, kinds] of Object.entries(baseline)) {
    for (const [kind, was] of Object.entries(kinds)) {
      const n = Math.min(measured[file]?.[kind] ?? 0, was);
      if (n > 0) (out[file] ??= {})[kind] = n;
    }
  }
  return out;
}

export const countOf = (findings: readonly Finding[]): Counts => {
  const out: Counts = {};
  for (const f of findings) { const k = (out[f.file] ??= {}); k[f.kind] = (k[f.kind] ?? 0) + 1; }
  return out;
};

const byKey = ([a]: [string, unknown], [b]: [string, unknown]): number => (a < b ? -1 : a > b ? 1 : 0);
const serialize = (c: Counts): string =>
  `${JSON.stringify(Object.fromEntries(Object.entries(c).sort(byKey).map(([f, k]) => [f, Object.fromEntries(Object.entries(k).sort(byKey))])), null, 2)}\n`;

/** The CLI half: `--init` (once), `--update`, then the check. Prints the findings of every red file. Returns the exit code. */
export function runRatchet(o: { name: string; cmd: string; baseline: string; findings: readonly Finding[]; argv: readonly string[] }): number {
  const say = (line: string): void => { process.stdout.write(`${line}\n`); };
  const file = join(process.cwd(), o.baseline);
  const measured = countOf(o.findings);
  if (o.argv.includes('--init')) {
    if (existsSync(file)) { say(`${o.name} --init: ${o.baseline} exists; the baseline only shrinks`); return 2; }
    writeFileSync(file, serialize(measured));
  }
  let baseline = JSON.parse(readFileSync(file, 'utf8')) as Counts;
  if (o.argv.includes('--update')) { baseline = shrink(measured, baseline); writeFileSync(file, serialize(baseline)); }
  const reds = compare(measured, baseline, o.cmd);
  const redFiles = new Set(reds.map((r) => r.split(' ')[0]));
  for (const f of o.findings) if (redFiles.has(f.file)) say(`${f.file}:${f.line}  ${f.kind}  ${f.text}`);
  for (const r of reds) say(`RED ${r}`);
  say(`${o.name}: ${o.findings.length} finding(s), ${reds.length} red against ${o.baseline}`);
  return reds.length > 0 ? 1 : 0;
}
