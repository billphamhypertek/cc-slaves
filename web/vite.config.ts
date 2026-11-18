import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const CM_CORE = /node_modules\/(@codemirror\/(state|view|language|search|commands)|@lezer\/(common|highlight|lr)|style-mod|w3c-keyname|crelt|@marijn\/find-cluster-break)\//;
function cmChunk(id: string): string | undefined {
  if (CM_CORE.test(id)) return 'cm';
  const m = /node_modules\/(?:@codemirror\/lang-|@lezer\/)([a-z]+)\//.exec(id) ?? /node_modules\/@codemirror\/legacy-modes\/mode\/([a-z]+)\./.exec(id);
  return m ? `cm-${m[1]}` : undefined;
}

// Dev: Vite on 5173 proxies /ws to the mock engine (web/dev/mock-engine.ts) or the real engine.
const engine = process.env.CC_ENGINE_URL ?? 'ws://127.0.0.1:4318';

export default defineConfig({
  plugins: [react(), {
    // the `tauri` namespace is read by the Rust shell only (src-tauri, include_str!); the web bundle never shows it
    name: 'ccs-no-tauri-catalog', enforce: 'pre',
    load: id => (/\/shared\/i18n\/(vi|en)\/tauri\.json$/.test(id) ? '{}' : null),
  }],
  // catalogs are read through their default export only: no per-key named exports (−2.9 KB gzip index.js, v21-t11)
  json: { namedExports: false },
  build: {
    outDir: 'dist', emptyOutDir: true, target: 'safari16',
    // spec v2.3 §10.3: CodeMirror's core in one lazy chunk `cm` (node_modules only: a manual chunk pulls in its deps, and the
    // wrapper's dynamic imports would drag vite's preload helper — needed by the first paint — into it), each language its own `cm-<lang>`
    // (shared language parts stay named, never `index`, which would count as first paint in check:bundle)
    rollupOptions: { output: { manualChunks: cmChunk } },
  },
  server: { port: 5173, strictPort: false, proxy: { '/ws': { target: engine, ws: true } } },
});
