// spec v2.1 §5.6 bundle budget: what keeps the web chunks small (the lazy dialog chunk, no Rust-only catalog).
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC = resolve(import.meta.dir, '../src');
const read = (p: string) => readFileSync(resolve(import.meta.dir, '..', p), 'utf8');
const files = (d: string): string[] => readdirSync(d).flatMap(n => (statSync(join(d, n)).isDirectory() ? files(join(d, n)) : [join(d, n)]));

describe('§5.6 the web bundle', () => {
  test('§5.6 the `tauri` catalog (Rust shell only) is not in the web build, and no web source reads a tauri.* key', () => {
    expect(read('vite.config.ts')).toContain(String.raw`/\/shared\/i18n\/(vi|en)\/tauri\.json$/.test(id) ? '{}'`);
    for (const f of files(SRC).filter(f => /\.tsx?$/.test(f))) expect({ f, hit: /['"`]tauri\./.test(readFileSync(f, 'utf8')) }).toEqual({ f, hit: false });
  });
  test('§5.6 dialogs, Settings, ⌘K and the "⋯" menu are one lazy chunk; App and the wizard never import them statically', () => {
    const app = read('src/ui/App.tsx'), wiz = read('src/ui/Wizard.tsx');
    expect(app).toContain("import('./AppModals.tsx')");
    expect(wiz).toContain("import('./AppModals.tsx')");
    for (const src of [app, wiz]) expect(src).not.toMatch(/^import (?!type ).*'\.\/(AppModals|Accounts|Settings|Palette|AddProject|LaneDialogs|ActionMenu)\.tsx'/m);
  });
});
