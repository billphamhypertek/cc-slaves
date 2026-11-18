// v2.2 §5.3 / §3-14 the Keychain write path through `security -i` (stdin) + split / join of items over 3 900 B,
// against a fake `security` (engine/test/_fixtures/fake-security.ts) — never /usr/bin/security.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteSplit, ENTRY_MAX, KEYCHAIN_SERVICE, quoteValue, readSecret, readSplit, securityCli, storeToken, writeSecret, writeSplit } from '../src/keychain.ts';
import { makeFakeSecurity, type FakeSecurity } from './_fixtures/fake-security.ts';

let tmp: string;
let fake: FakeSecurity;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'ccs-kc-')); fake = makeFakeSecurity(tmp); });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const SVC = 'cc-slaves-mcp';
const nasty = 'a"b\\c\'d$e`f {"k":"v\\"q"}';

describe('§3-14 security -i', () => {
  test('§3-14 quoteValue escapes \\ and " only', () => {
    expect(quoteValue('a"b\\c$d')).toBe('"a\\"b\\\\c$d"');
  });

  test('§5.3 writeSecret goes through stdin: argv never holds the value; read back byte for byte', () => {
    const cli = securityCli(fake.bin);
    writeSecret(cli, SVC, 'user:x', nasty);
    expect(readSecret(cli, SVC, 'user:x')).toBe(nasty);
    const argv = fake.log().filter((l) => !l.startsWith('stdin:'));
    expect(argv).toContain('["-i"]');
    expect(argv.join('\n')).not.toContain('v\\"q');
    expect(argv.join('\n')).not.toContain('$e');
  });

  test('§5.3 a write the Keychain refused (read-back differs) throws', () => {
    const cli = securityCli(fake.bin);
    fake.failWrites(1);
    expect(() => writeSecret(cli, SVC, 'user:x', 'v')).toThrow(/Keychain/);
  });

  test('§5.3 readSecret of a missing item → null', () => {
    expect(readSecret(securityCli(fake.bin), SVC, 'nope')).toBeNull();
  });

  test('§7.1 NC1 the engine token moves to the stdin path (argv has no token)', () => {
    storeToken('tok-SECRET-123', securityCli(fake.bin));
    expect(fake.items()[`${KEYCHAIN_SERVICE}/cc-slaves`]).toBe('tok-SECRET-123');
    expect(fake.log().join('\n')).not.toContain('tok-SECRET-123');
  });
});

describe('§5.3 control chars never reach `security`', () => {
  const evil = 'project:p1:evil\ndelete-generic-password -s cc-slaves-engine-token -a cc-slaves\nx';
  test('§5.3 an id carrying a delete-generic-password line throws before any -i call; the victim item stays', () => {
    const cli = securityCli(fake.bin);
    writeSecret(cli, KEYCHAIN_SERVICE, 'cc-slaves', 'victim');
    const before = fake.log().length;
    expect(() => writeSplit(cli, SVC, evil, '{"a":1}')).toThrow(/control/);
    expect(fake.log().slice(before)).toEqual([]);
    expect(fake.items()).toEqual({ 'cc-slaves-engine-token/cc-slaves': 'victim' });
  });

  test('§5.3 CR, LF, NUL in service, account or value are refused by write / read / delete with no spawn', () => {
    const cli = securityCli(fake.bin);
    for (const bad of ['a\rb', 'a\nb', 'a\u0000b']) {
      expect(() => writeSecret(cli, bad, 'x', 'v')).toThrow(/control/);
      expect(() => writeSecret(cli, SVC, bad, 'v')).toThrow(/control/);
      expect(() => writeSecret(cli, SVC, 'x', bad)).toThrow(/control/);
      expect(() => readSecret(cli, SVC, bad)).toThrow(/control/);
      expect(() => deleteSplit(cli, SVC, bad)).toThrow(/control/);
    }
    expect(fake.log()).toEqual([]);
  });
});

describe('§5.3 split / join > 3 900 B', () => {
  test('§5.3 a value that fits stays one item (no parts)', () => {
    const cli = securityCli(fake.bin);
    writeSplit(cli, SVC, 'user:s', '{"a":1}');
    expect(Object.keys(fake.items())).toEqual([`${SVC}/user:s`]);
    expect(readSplit(cli, SVC, 'user:s')).toBe('{"a":1}');
  });

  test('§5.3 a 10 KB JSON with quotes is split into <id>, <id>#2, … each ≤ 3 900 B escaped, parts written before the head', () => {
    const cli = securityCli(fake.bin);
    const big = JSON.stringify({ accessToken: 'x"'.repeat(2500), refreshToken: 'y\\'.repeat(1200) });
    writeSplit(cli, SVC, 'user:s', big);
    const keys = Object.keys(fake.items());
    expect(keys.length).toBeGreaterThanOrEqual(3);
    for (const v of Object.values(fake.items())) expect(quoteValue(v).length).toBeLessThanOrEqual(ENTRY_MAX + 2);
    expect(readSplit(cli, SVC, 'user:s')).toBe(big);
    const order = fake.log().filter((l) => l.startsWith('stdin:add')).map((l) => /-a "([^"]+)"/.exec(l)![1]);
    expect(order.at(-1)).toBe('user:s');
  });

  test('§5.3 a missing part → the whole item reads as missing', () => {
    const cli = securityCli(fake.bin);
    writeSplit(cli, SVC, 'user:s', 'z'.repeat(9000));
    cli(['delete-generic-password', '-s', SVC, '-a', 'user:s#2']);
    expect(readSplit(cli, SVC, 'user:s')).toBeNull();
  });

  test('§5.3 rewriting smaller drops the stale parts; deleteSplit removes head and parts', () => {
    const cli = securityCli(fake.bin);
    writeSplit(cli, SVC, 'user:s', 'z'.repeat(9000));
    writeSplit(cli, SVC, 'user:s', 'small');
    expect(Object.keys(fake.items())).toEqual([`${SVC}/user:s`]);
    writeSplit(cli, SVC, 'user:s', 'z'.repeat(9000));
    deleteSplit(cli, SVC, 'user:s');
    expect(fake.items()).toEqual({});
  });
});
