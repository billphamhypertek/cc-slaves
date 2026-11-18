// spec v2.3 §5.2 C1 / C2 a TS type-only import name takes the type colour, a value import beside it does not.
import { describe, expect, test } from 'bun:test';
import { javascript } from '@codemirror/lang-javascript';
import { EditorState } from '@codemirror/state';
import { typeImports } from '../../src/code/ts-types.ts';

const marked = (code: string) => {
  const st = EditorState.create({ doc: code, extensions: [javascript({ typescript: true })] });
  return typeImports(st).map(r => code.slice(r.from, r.to));
};

describe('§5.2 type-only imports', () => {
  test('§5.2 C1 `import { readKeys, type Key }` → Key only; `import type { A, B }` → both; plain imports → none', () => {
    expect(marked("import { readKeys, type Key } from './keys'")).toEqual(['Key']);
    expect(marked("import type { A, B } from './t'")).toEqual(['A', 'B']);
    expect(marked("import { jwt } from './jwt'\nconst type = 1")).toEqual([]);
  });
});
