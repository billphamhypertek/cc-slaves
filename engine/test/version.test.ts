import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ENGINE_VERSION } from '../src/version.ts';

const root = resolve(import.meta.dir, '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

describe('§7.1 one version source (engine.json version = app version)', () => {
  test('engine version is the root package.json version', () => {
    expect(ENGINE_VERSION).toBe((JSON.parse(read('package.json')) as { version: string }).version);
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('Tauri reads its app version from the root package.json; Cargo crates agree', () => {
    expect((JSON.parse(read('src-tauri/tauri.conf.json')) as { version: string }).version).toBe('../package.json');
    for (const toml of ['src-tauri/Cargo.toml', 'src-tauri/core/Cargo.toml', 'menubar/Cargo.toml']) {
      expect(/^version = "([^"]+)"/m.exec(read(toml))?.[1]).toBe(ENGINE_VERSION);
    }
  });
});
