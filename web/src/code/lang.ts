// spec v2.3 §5.2 / §10.3 one lazy chunk per language (vite `manualChunks` names them `cm-<lang>`), loaded by extension
// the first time a file of that kind opens. Shell and TOML come from the legacy modes through `StreamLanguage`.
import type { Extension } from '@codemirror/state';
import type { LangId } from './file-view.ts';

const legacy = async (mode: Promise<{ [k: string]: unknown }>, name: string): Promise<Extension> => {
  const [{ StreamLanguage }, m] = await Promise.all([import('@codemirror/language'), mode]);
  return StreamLanguage.define(m[name] as Parameters<typeof StreamLanguage.define>[0]);
};

const LOAD: Readonly<Record<LangId, () => Promise<Extension>>> = {
  js: () => import('@codemirror/lang-javascript').then(m => m.javascript()),
  jsx: () => import('@codemirror/lang-javascript').then(m => m.javascript({ jsx: true })),
  ts: () => import('@codemirror/lang-javascript').then(m => m.javascript({ typescript: true })),
  tsx: () => import('@codemirror/lang-javascript').then(m => m.javascript({ jsx: true, typescript: true })),
  json: () => import('@codemirror/lang-json').then(m => m.json()),
  md: () => import('@codemirror/lang-markdown').then(m => m.markdown()),
  css: () => import('@codemirror/lang-css').then(m => m.css()),
  html: () => import('@codemirror/lang-html').then(m => m.html()),
  py: () => import('@codemirror/lang-python').then(m => m.python()),
  rs: () => import('@codemirror/lang-rust').then(m => m.rust()),
  go: () => import('@codemirror/lang-go').then(m => m.go()),
  yaml: () => import('@codemirror/lang-yaml').then(m => m.yaml()),
  sql: () => import('@codemirror/lang-sql').then(m => m.sql()),
  toml: () => legacy(import('@codemirror/legacy-modes/mode/toml'), 'toml'),
  sh: () => legacy(import('@codemirror/legacy-modes/mode/shell'), 'shell'),
};

export const loadLang = (id: LangId): Promise<Extension> => LOAD[id]();
