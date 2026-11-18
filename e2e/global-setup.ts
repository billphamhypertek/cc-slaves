// Build the web once per run: the engine serves web/dist (boot.ts staticDir).
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

export default function globalSetup(): void {
  if (process.env.E2E_SKIP_BUILD === '1') return;
  execFileSync('bun', ['run', 'web:build'], { cwd: resolve(import.meta.dirname, '..'), stdio: ['ignore', 'ignore', 'inherit'] });
}
