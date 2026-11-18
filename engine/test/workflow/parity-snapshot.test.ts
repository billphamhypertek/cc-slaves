// spec v2.9 §12 / §15 A1: the v2.7 strings are frozen in `_fixtures/v27-parity.json` before any of them moves into a pack.
// This file keeps the live v2.7 code equal to the snapshot; `compile.test.ts` holds "Quy trình PO" byte-identical to it.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { captureV27 } from './_v27.ts';

const snapshot = JSON.parse(readFileSync(new URL('../_fixtures/v27-parity.json', import.meta.url), 'utf8')) as ReturnType<typeof captureV27>;

describe('v2.9 §12 v2.7 parity snapshot', () => {
  const live = captureV27();
  for (const k of Object.keys(snapshot) as (keyof typeof snapshot)[]) {
    test(`live v2.7 ${k} = snapshot`, () => { expect(live[k] as unknown).toEqual(snapshot[k]); });
  }
  test('the snapshot covers every part of the capture', () => { expect(Object.keys(live).sort()).toEqual(Object.keys(snapshot).sort()); });
});
