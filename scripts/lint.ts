import { relative } from 'node:path';
import { ESLint } from 'eslint';
import { runRatchet, type Finding } from './ratchet';

/**
 * `bun run lint` (coding standard §1): ESLint over the repo (`eslint.config.js`), ratcheted per file and rule against
 * `scripts/lint-baseline.json` — the errors that existed when the standard landed (web, which a sibling lane was editing,
 * and test files). A new error, or more of one rule in a file than the baseline holds, is red. A count that fell is red
 * too until `--update` writes it down (the baseline may only shrink; never edit it by hand to pass).
 *
 *   (no flag)   check; exit 1 on any red
 *   --update    write min(measured, baseline) per key; never adds
 *   --init      write the first baseline; refused when the file exists
 */

const root = process.cwd();
const results = await new ESLint({ cwd: root }).lintFiles(['.']);
const findings: Finding[] = results.flatMap((r) => r.messages.filter((m) => m.severity === 2).map((m) => ({
  file: relative(root, r.filePath), line: m.line ?? 0, kind: m.ruleId ?? 'parse', text: m.message,
})));
process.exitCode = runRatchet({ name: 'lint', cmd: 'bun run lint', baseline: 'scripts/lint-baseline.json', findings, argv: process.argv.slice(2) });
