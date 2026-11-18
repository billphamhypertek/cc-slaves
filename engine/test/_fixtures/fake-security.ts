// A fake macOS `security` for tests (v2.2 §5.3, §8): never `/usr/bin/security`, never the real Keychain. Items live in
// a JSON file; every call's argv (and `-i` stdin line) is logged so a test can assert no secret ever sits in argv.
// Speaks what the engine uses: `-i` (stdin commands, quoted + `\`-escaped values, a line over ~4 KB fails with
// "unknown command" as measured §3-14), `find-generic-password -s -a -w`, `delete-generic-password -s -a`,
// `add-generic-password` with argv (only the legacy engine-token path ever did). Knob: `<state>.fail` holds how many
// next `add-generic-password` writes fail.
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** §3-14 measured: a 4 052 B line passed, 4 058 B did not. */
const LINE_MAX = 4052;
const NOT_FOUND = 44;

export interface FakeSecurity {
  /** The executable to inject (a `security` wrapper in `dir`). */
  bin: string;
  items: () => Record<string, string>;
  /** argv of every call, then the stdin lines of `-i` calls (prefixed `stdin:`). */
  log: () => string[];
  /** The next `n` add writes fail. */
  failWrites: (n: number) => void;
}

/** Writes `dir/security` (+ state files) and returns its handle. */
export function makeFakeSecurity(dir: string): FakeSecurity {
  const state = join(dir, 'security-items.json');
  const logFile = join(dir, 'security-argv.log');
  const bin = join(dir, 'security');
  writeFileSync(state, '{}');
  writeFileSync(logFile, '');
  writeFileSync(bin, `#!/bin/sh\nFAKE_SECURITY_STATE=${JSON.stringify(state)} FAKE_SECURITY_LOG=${JSON.stringify(logFile)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(import.meta.path)} "$@"\n`);
  chmodSync(bin, 0o755);
  return {
    bin,
    items: () => JSON.parse(readFileSync(state, 'utf8')) as Record<string, string>,
    log: () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean),
    failWrites: (n) => writeFileSync(`${state}.fail`, String(n)),
  };
}

/** `security -i` tokenizer: whitespace-separated words, `"…"` with `\\` / `\"` escapes. */
function words(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === ' ' || line[i] === '\t') { i++; continue; }
    let w = '';
    if (line[i] === '"') {
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length) i++;
        w += line[i++];
      }
      i++;
    } else {
      while (i < line.length && line[i] !== ' ') w += line[i++];
    }
    out.push(w);
  }
  return out;
}

function run(argv: string[], items: Record<string, string>, statePath: string, write: (s: string) => void): number {
  const [verb, ...rest] = argv;
  const opt = (f: string): string | undefined => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : undefined; };
  const key = `${opt('-s') ?? ''}/${opt('-a') ?? ''}`;
  switch (verb) {
    case 'add-generic-password': {
      const failFile = `${statePath}.fail`;
      const fails = existsSync(failFile) ? Number(readFileSync(failFile, 'utf8')) : 0;
      if (fails > 0) { writeFileSync(failFile, String(fails - 1)); process.stderr.write('SecKeychainItemCreateFromContent: write failed\n'); return 1; }
      if (!rest.includes('-U') && key in items) { process.stderr.write('already exists\n'); return 45; }
      items[key] = opt('-w') ?? '';
      return 0;
    }
    case 'find-generic-password':
      if (!(key in items)) { process.stderr.write('The specified item could not be found in the keychain.\n'); return NOT_FOUND; }
      write(`${items[key]}\n`);
      return 0;
    case 'delete-generic-password':
      if (!(key in items)) { process.stderr.write('The specified item could not be found in the keychain.\n'); return NOT_FOUND; }
      delete items[key];
      return 0;
    default:
      process.stderr.write(`unknown command "${verb ?? ''}"\n`);
      return 2;
  }
}

if (import.meta.main) {
  const statePath = process.env.FAKE_SECURITY_STATE!;
  const logFile = process.env.FAKE_SECURITY_LOG!;
  const argv = process.argv.slice(2);
  appendFileSync(logFile, `${JSON.stringify(argv)}\n`);
  const items = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, string>;
  let code = 0;
  if (argv[0] === '-i') {
    // `security -i` keeps going after a failed command and exits 0 (the engine verifies by reading back).
    for (const line of readFileSync(0, 'utf8').split('\n').filter(Boolean)) {
      appendFileSync(logFile, `stdin:${line.split(' -w ')[0]}\n`);
      if (line.length > LINE_MAX) { process.stderr.write('unknown command\n'); continue; }
      run(words(line), items, statePath, (s) => process.stdout.write(s));
    }
  } else {
    code = run(argv, items, statePath, (s) => process.stdout.write(s));
  }
  writeFileSync(statePath, JSON.stringify(items));
  process.exit(code);
}
