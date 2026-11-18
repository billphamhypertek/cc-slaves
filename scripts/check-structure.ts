import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  evaluate, initBaseline, parseBaseline, rekey, seedBaseline, serializeBaseline, updateBaseline, type Baseline, type Finding,
} from './check-structure/baseline';
import { mergeBase, refFile, topLevel, workingTree } from './check-structure/git';
import { measureTree, type Measurement } from './check-structure/measure';
import { FILE_RULES, scanScrollAnim, SCROLL_ANIM_KEY } from './check-structure/scrollbars';
import { TYPE_SCALE } from './check-structure/type-scale';

/**
 * `bun run check:structure` — the structure ratchet (coding standard §1, port of hagenta's RF1 checker). Measures the
 * working copy and compares it with `scripts/structure-baseline.json`.
 *
 *   (no flag)              check; exit 1 on any red
 *   --update               write min(measured, baseline), drop keys back under the limit or gone; never adds
 *   --rekey <old> <new>    rename one key (a file moved); refused when the new key measures more than the old value
 *   --seed <rule>          enter the measured debt of a rule added later (space-literal, bar-literal), once
 *   --init                 write the first baseline from the working copy; refused when the file exists
 *
 * Every run also compares the baseline file with its copy at $STRUCTURE_REF (default: the merge-base of HEAD and
 * `main`, else HEAD): a hand-raised value or an unmeasured new key is red.
 */

const BASELINE = 'scripts/structure-baseline.json';
const say = (line: string): void => { process.stdout.write(`${line}\n`); };

/** The baseline file at `$STRUCTURE_REF`, else at the merge-base with main, else at HEAD; undefined when absent. */
function refBaseline(root: string): Baseline | undefined {
  const named = process.env.STRUCTURE_REF;
  const base = mergeBase(root, 'HEAD', 'main');
  const refs = named !== undefined && named !== '' ? [named] : [...(base ? [base] : []), 'HEAD'];
  for (const ref of refs) {
    const text = refFile(root, ref, BASELINE);
    if (text !== undefined) return parseBaseline(text);
  }
  say(`note: ${BASELINE} is not at ${refs.join(' / ')}: the ref check is skipped`);
  return undefined;
}

/** A red on a `<literal rule>@<file>` key lists the literals, so the fixer sees the lines. */
function literalHits(f: Finding, tree: ReadonlyMap<string, string>): string[] {
  if (f.key === SCROLL_ANIM_KEY) return scanScrollAnim(tree).map((h) => `       ${h.file}:${h.line}  ${h.text}`);
  const at = f.key.indexOf('@'), scan = FILE_RULES[f.key.slice(0, at)];
  if (!scan || (f.rule !== 'a' && f.rule !== 'b')) return [];
  const file = f.key.slice(at + 1);
  return scan(file, tree.get(file) ?? '').map((h) => `       ${h.file}:${h.line}  ${h.text}`);
}

const HINTS: Readonly<Record<string, string>> = {
  'font-literal': `font sizes: use a step of the scale — var(--${Object.keys(TYPE_SCALE).join('|')})`,
  'space-literal': 'padding / margin / gap: use var(--s1…--s6), the next token down (spec v2.4 §6.7 D53)',
  'bar-literal': 'under the bars: calc(var(--bn) + var(--h-bar) + var(--h-head) + a space token)',
  'scrollbar-rule': 'scrollbars: only the D54 block in styles.css; never scrollbar-width / scrollbar-color (spec v2.4 §6.8)',
  'scroll-anim': 'a scroll box never carries its own animation: animate a non-scrolling wrapper (spec v2.4 §6.8 R36 I1)',
};

function report(findings: Finding[], tree: ReadonlyMap<string, string>): number {
  for (const f of findings) {
    say(`RED (${f.rule}) ${f.section} ${f.key}: ${f.message}`);
    for (const line of literalHits(f, tree)) say(line);
  }
  for (const [rule, hint] of Object.entries(HINTS)) {
    if (findings.some((f) => f.key.startsWith(`${rule}@`))) say(`${hint} (docs/ref/coding-standard.md §4)`);
  }
  say(`check:structure: ${findings.length} red`);
  return findings.length > 0 ? 1 : 0;
}

function main(argv: string[]): number {
  const started = Date.now();
  const root = topLevel(process.cwd());
  const file = join(root, BASELINE);
  const tree = workingTree(root);
  const head: Measurement = measureTree(tree, { root });
  const write = (b: Baseline) => writeFileSync(file, serializeBaseline(b));

  if (argv.includes('--init')) {
    if (existsSync(file)) { console.error(`check:structure --init: ${BASELINE} exists; the baseline only shrinks`); return 2; }
    write(initBaseline(head));
    say(`check:structure: wrote ${BASELINE}`);
  }
  let baseline = parseBaseline(readFileSync(file, 'utf8'));
  if (argv.includes('--update')) {
    baseline = updateBaseline(head, baseline);
    write(baseline);
  }
  const seed = argv.indexOf('--seed');
  if (seed !== -1) {
    const r = seedBaseline(head, baseline, argv[seed + 1] ?? '');
    if ('error' in r) { console.error(`check:structure --seed: ${r.error}`); return 2; }
    baseline = r.baseline;
    write(baseline);
    say(`seeded ${argv[seed + 1]}`);
  }
  const at = argv.indexOf('--rekey');
  if (at !== -1) {
    const [oldKey, newKey] = [argv[at + 1], argv[at + 2]];
    if (!oldKey || !newKey) { console.error('usage: --rekey <old key> <new key>'); return 2; }
    const r = rekey(head, baseline, oldKey, newKey);
    if ('error' in r) { console.error(`check:structure --rekey: ${r.error}`); return 1; }
    baseline = r.baseline;
    write(baseline);
    say(`rekeyed ${oldKey} → ${newKey}`);
  }
  const code = report(evaluate(head, baseline, refBaseline(root)), tree);
  say(`check:structure: ${head.values.files.size} files measured in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return code;
}

process.exitCode = main(process.argv.slice(2));
