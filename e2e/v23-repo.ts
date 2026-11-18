// v2.3 e2e fixture repo (spec §11 E2E): a real git repo in the engine's temp dir shaped like the mockup's mock set
// (§14): project `hagenta` with docs/specs + engine/src, lane D15's worktree on `lane/d15` (spec + auth.ts fix + a
// lanes.ts change that conflicts with main), lane D2's worktree on `lane/d2` (2 commits, 4 files, merges clean).
// Git runs with the PO's global / system config shut out (GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_NOSYSTEM=1).
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { E2eEngine } from './fixtures.ts';

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...a: string[]): string =>
  execFileSync('git', ['-c', 'user.email=e2e@x.test', '-c', 'user.name=e2e', '-c', 'commit.gpgsign=false', ...a], { cwd, env: ENV, encoding: 'utf8' });

function put(root: string, files: Record<string, string>): void {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
}
const commit = (cwd: string, files: Record<string, string>, msg: string) => { put(cwd, files); git(cwd, 'add', '-A'); git(cwd, 'commit', '-q', '-m', msg); };

const AUTH = `import { jwt } from './jwt'
import { readKeys, type Key } from './keys'

/** Token rỗng hay sai chữ ký đều trả flase. */
export function verify(tok: string): boolean {
  return jwt.check(tok, KEYS)
}

export const KEYS = readKeys(process.env.KEY_DIR)
`;
const LANES = (body: string) => `/** Lane rảnh nhất, cũ nhất trước. */\n\nexport function pick(lanes: Lane[]) {\n  ${body}\n}\n`;
const SPEC_MD = `# Auth: token rỗng và khoá xoay vòng

Spec · lane D15 · 2026-11-16

## 1. Vì sao làm

Hôm nay \`verify('')\` ném lỗi thay vì trả \`false\`.

## 2. Mục tiêu

- Token rỗng hay sai chữ ký → \`false\`, không ném lỗi.
`;

/** Builds `repos/hagenta` (main + lane/d15 + lane/d2 worktrees at `e.wt('D15')` / `e.wt('D2')`). Call before `addProject`. */
export function hagentaRepo(e: E2eEngine): string {
  const repo = e.repo('hagenta');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  commit(repo, {
    '.gitignore': '.local/\nnode_modules/\n.env\n', 'CLAUDE.md': '# hagenta\n', 'README.md': '# hagenta\n', 'package.json': '{ "name": "hagenta" }\n',
    'docs/HANDOFF.md': '# Handoff\n\nD2 port parser lot-2; D15 auth.\n', 'docs/specs/2026-10-28-quota-design.md': '# Quota\n',
    'engine/src/auth.ts': AUTH, 'engine/src/config.ts': 'export const PORT = 4318\n', 'engine/src/lanes.ts': LANES('return lanes.sort(byAge)[0]'),
    'engine/src/store.ts': 'export const lanes = new Map<string, Lane>()\n', 'engine/test/auth.test.ts': "import { verify } from '../src/auth'\n",
  }, 'v2.2 G5: catalog skills');
  mkdirSync(join(e.dir, 'wt'), { recursive: true });
  git(repo, 'worktree', 'add', '-q', '-b', 'lane/d15', e.wt('D15'), 'main');
  commit(e.wt('D15'), { 'docs/specs/2026-11-16-auth-design.md': SPEC_MD }, 'D15: spec auth');
  commit(e.wt('D15'), { 'engine/src/auth.ts': AUTH.replace('flase', 'false'), 'engine/src/lanes.ts': LANES('return lanes.filter(isReady).sort(byAge)[0]') }, 'D15: verify rỗng trả false');
  commit(repo, { 'engine/src/lanes.ts': LANES('return lanes.sort(byQuota)[0]') }, 'B2: chọn lane theo quota');
  git(repo, 'worktree', 'add', '-q', '-b', 'lane/d2', e.wt('D2'), 'main');
  commit(e.wt('D2'), { 'engine/src/lot2/parser.ts': "export function parseLot(raw: string) {\n  return raw.split(',')\n}\n", 'fixtures/lot2.json': '{ "lot": 2 }\n' }, 'D2: bắt đầu parser lot-2');
  commit(e.wt('D2'), { 'engine/src/lot2/index.ts': "export * from './parser'\n", 'engine/test/parser.test.ts': "import { parseLot } from '../src/lot2/parser'\n" }, 'D2: port parser lot-2');
  return repo;
}
