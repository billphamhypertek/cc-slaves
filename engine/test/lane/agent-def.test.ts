// v2.4 §5.6 tier 2: agent lookup by frontmatter `name:` (project before account), frontmatter only.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAgent } from '../../src/lane/agent-def.ts';

let tmp: string, proj: string, acct: string;
const put = (dir: string, file: string, body: string) => { mkdirSync(join(dir, file, '..'), { recursive: true }); writeFileSync(join(dir, file), body); };
const md = (fm: string) => `---\n${fm}\n---\nYou are…\nmodel: not-this-one\n`;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ccs-agent-'));
  proj = join(tmp, 'wt', '.claude', 'agents');
  acct = join(tmp, 'cfg', 'agents');
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('readAgent (v2.4 §5.6)', () => {
  test('§5.6 matched by frontmatter name: (file name differs, sub-folder), model + effort; body ignored', () => {
    put(acct, 'team/coder.md', md('name: coder-medium\ndescription: x\nmodel: sonnet\neffort: medium'));
    expect(readAgent('coder-medium', [proj, acct])).toEqual({ name: 'coder-medium', model: 'sonnet', effort: 'medium' });
  });

  test('§5.6 the project agent wins over the account agent of the same name', () => {
    put(acct, 'r.md', md('name: reviewer\nmodel: opus'));
    put(proj, 'r.md', md('name: "reviewer"\nmodel: \'haiku\'\neffort: high'));
    expect(readAgent('reviewer', [proj, acct])).toEqual({ name: 'reviewer', model: 'haiku', effort: 'high' });
  });

  test('§5.6 `model: inherit` = unset; effort only; unknown effort ignored', () => {
    put(proj, 'a.md', md('name: a\nmodel: inherit\neffort: medium'));
    put(proj, 'b.md', md('name: b\neffort: turbo\nmodel: opus'));
    expect(readAgent('a', [proj])).toEqual({ name: 'a', model: null, effort: 'medium' });
    expect(readAgent('b', [proj])).toEqual({ name: 'b', model: 'opus', effort: null });
  });

  test('§5.6 not found / broken frontmatter (no closing ---) / no dir → null + one log line', () => {
    put(proj, 'x.md', '---\nname: broken\nmodel: opus\n');
    const log: string[] = [];
    expect(readAgent('broken', [proj, join(tmp, 'nope')], (l) => log.push(l))).toBeNull();
    expect(readAgent('plugin:agent', [proj], (l) => log.push(l))).toBeNull();
    expect(log).toHaveLength(2);
    expect(log[0]).toContain('broken');
  });
});
