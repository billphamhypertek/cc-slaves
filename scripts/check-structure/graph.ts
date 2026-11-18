import { posix } from 'node:path';
import ts from 'typescript';
import type { HardRed } from './measure';

/**
 * The import graph of `check:structure`: resolves every import with TypeScript's own resolver (`moduleResolution:
 * bundler`) against the tree being measured — never against the disk — and derives the dependency rules of coding
 * standard §3: L1 / L2 (hard), L3 / L6 (edge keys) and L4 (runtime cycles per area, intra-fragment cycles hard).
 */

export interface ResolveOptions {
  /** Absolute directory the tree's relative paths hang from (the repo root, or a fixture root). */
  root: string;
}
interface Import { to: string; runtime: boolean; dynamic: boolean }
interface Graph { edges: Set<string>; l6: Set<string>; hard: HardRed[]; cycles: Map<string, number> }

const typeOnly = (clause: ts.ImportClause | undefined): boolean => {
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  const named = clause.namedBindings;
  return !clause.name && named !== undefined && ts.isNamedImports(named) && named.elements.length > 0
    && named.elements.every((e) => e.isTypeOnly);
};
const typeOnlyExport = (d: ts.ExportDeclaration): boolean =>
  d.isTypeOnly || (d.exportClause !== undefined && ts.isNamedExports(d.exportClause)
    && d.exportClause.elements.length > 0 && d.exportClause.elements.every((e) => e.isTypeOnly));

/** Module specifiers of one file: static imports / re-exports, and dynamic `import('…')` anywhere in the file. */
function specifiers(sf: ts.SourceFile): { spec: string; runtime: boolean; dynamic: boolean }[] {
  const out: { spec: string; runtime: boolean; dynamic: boolean }[] = [];
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)) {
      out.push({ spec: s.moduleSpecifier.text, runtime: !typeOnly(s.importClause), dynamic: false });
    } else if (ts.isExportDeclaration(s) && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier)) {
      out.push({ spec: s.moduleSpecifier.text, runtime: !typeOnlyExport(s), dynamic: false });
    }
  }
  if (sf.text.includes('import(')) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) out.push({ spec: arg.text, runtime: true, dynamic: true });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

function makeResolver(tree: ReadonlyMap<string, string>, opts: ResolveOptions) {
  const root = opts.root.replace(/\/+$/, '');
  const dirs = new Set<string>(['']);
  for (const p of tree.keys()) for (let d = posix.dirname(p); d !== '.' && !dirs.has(d); d = posix.dirname(d)) dirs.add(d);
  const rel = (abs: string): string | undefined => (abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : undefined);
  const host: ts.ModuleResolutionHost = {
    fileExists: (f) => { const r = rel(f); return r !== undefined && tree.has(r); },
    readFile: (f) => { const r = rel(f); return r === undefined ? undefined : tree.get(r); },
    directoryExists: (d) => (d === root ? true : (rel(d) !== undefined && dirs.has(rel(d) ?? ''))),
    realpath: (f) => f,
    getCurrentDirectory: () => root,
  };
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.ReactJSX,
    allowImportingTsExtensions: true, resolveJsonModule: false,
  };
  const cache = ts.createModuleResolutionCache(root, (f) => f, options);
  return (spec: string, from: string): string | undefined => {
    const r = ts.resolveModuleName(spec, `${root}/${from}`, options, host, cache).resolvedModule;
    const to = r ? rel(r.resolvedFileName) : undefined;
    return to !== undefined && tree.has(to) ? to : undefined;
  };
}

/** `engine/src/lane/x.ts` → `engine/lane`: the workspace plus up to two directories under `src/`. */
function areaOf(path: string): string {
  const parts = path.split('/');
  const rest = parts[1] === 'src' ? parts.slice(2, -1) : [];
  return [parts[0] ?? '', ...rest.slice(0, 2)].join('/');
}

/** The assemblers enclosing a path, outermost first: `X.ts` / `X.tsx` beside a directory `X/` that holds the path. */
function assemblersOf(path: string, tree: ReadonlyMap<string, string>): string[] {
  const parts = path.split('/');
  const out: string[] = [];
  for (let i = 1; i < parts.length - 1; i += 1) {
    const dir = parts.slice(0, i + 1).join('/');
    const asm = tree.has(`${dir}.ts`) ? `${dir}.ts` : tree.has(`${dir}.tsx`) ? `${dir}.tsx` : undefined;
    if (asm) out.push(asm);
  }
  return out;
}

function hardRule(from: string, to: string): HardRed['rule'] | undefined {
  if (from.startsWith('shared/') && !to.startsWith('shared/')) return 'L1';
  if (from.startsWith('web/') && to.startsWith('engine/')) return 'L2';
  if (from.startsWith('engine/') && to.startsWith('web/')) return 'L2';
  return undefined;
}

/** The first-paint entry: everything it reaches through static runtime imports lands in the entry chunk. */
const ENTRY = 'web/src/main.tsx';
const DECK = 'web/src/deck/';
/** The one deck module App may import statically (`web/test/native.test.ts` §8.4). */
const DECK_ALLOWED = new Set(['web/src/deck/actions.ts']);

/** Files reached from `start` through static runtime imports. */
function staticClosure(start: string, imports: ReadonlyMap<string, Import[]>): Set<string> {
  const seen = new Set<string>();
  const work = [start];
  for (let p = work.pop(); p !== undefined; p = work.pop()) {
    if (seen.has(p)) continue;
    seen.add(p);
    for (const i of imports.get(p) ?? []) if (i.runtime && !i.dynamic) work.push(i.to);
  }
  return seen;
}

/** L3: shared web layers never import ui / deck; first-paint code never imports a deck value statically. */
function l3Edges(imports: ReadonlyMap<string, Import[]>): Set<string> {
  const out = new Set<string>();
  const firstPaint = staticClosure(ENTRY, imports);
  for (const [from, list] of imports) {
    for (const i of list) {
      if (!i.runtime) continue;
      if (from.startsWith('web/src/lib/') && /^web\/src\/(ui|deck)\//.test(i.to)) out.add(`${from}→${i.to}`);
      if (!i.dynamic && firstPaint.has(from) && !from.startsWith(DECK) && i.to.startsWith(DECK) && !DECK_ALLOWED.has(i.to)) {
        out.add(`${from}→${i.to}`);
      }
    }
  }
  return out;
}

/** Tarjan's SCC, iterative; returns every strongly connected component of size ≥ 2. */
function cycleComponents(adj: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let next = 0;
  for (const start of adj.keys()) {
    if (index.has(start)) continue;
    const work: { node: string; it: Iterator<string> }[] = [];
    const open = (n: string) => {
      index.set(n, next); low.set(n, next); next += 1; stack.push(n); onStack.add(n);
      work.push({ node: n, it: (adj.get(n) ?? new Set<string>()).values() });
    };
    open(start);
    while (work.length > 0) {
      const top = work[work.length - 1]!;
      const step = top.it.next();
      if (!step.done) {
        const w = step.value;
        if (!index.has(w)) open(w);
        else if (onStack.has(w)) low.set(top.node, Math.min(low.get(top.node)!, index.get(w)!));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(top.node)!));
      if (low.get(top.node) === index.get(top.node)) {
        const comp: string[] = [];
        for (let w = stack.pop(); w !== undefined; w = stack.pop()) { onStack.delete(w); comp.push(w); if (w === top.node) break; }
        if (comp.length > 1) out.push(comp);
      }
    }
  }
  return out;
}

function resolveAll(sources: ReadonlyMap<string, ts.SourceFile>, resolve: (spec: string, from: string) => string | undefined) {
  const imports = new Map<string, Import[]>();
  for (const [path, sf] of sources) {
    const list: Import[] = [];
    for (const s of specifiers(sf)) {
      const to = resolve(s.spec, path);
      if (to !== undefined && to !== path) list.push({ to, runtime: s.runtime, dynamic: s.dynamic });
    }
    imports.set(path, list);
  }
  return imports;
}

export function collectGraph(tree: ReadonlyMap<string, string>, sources: ReadonlyMap<string, ts.SourceFile>, opts: ResolveOptions): Graph {
  const imports = resolveAll(sources, makeResolver(tree, opts));
  const g: Graph = { edges: l3Edges(imports), l6: new Set(), hard: [], cycles: new Map() };
  const hardSeen = new Set<string>();
  const fold = new Map<string, string>();
  const assemblers = new Set<string>();
  for (const path of sources.keys()) {
    const asms = assemblersOf(path, tree);
    fold.set(path, asms[0] ?? path);
    for (const a of asms) assemblers.add(a);
  }
  const adj = new Map<string, Set<string>>();
  /** Runtime edges between two fragments folding into the same assembler (a fragment → assembler edge is L6). */
  const intra = new Map<string, Set<string>>();
  for (const [from, list] of imports) {
    const node = fold.get(from)!;
    if (!adj.has(node)) adj.set(node, new Set());
    const asms = new Set(assemblersOf(from, tree));
    for (const imp of list) {
      const key = `${from}→${imp.to}`;
      const hard = hardRule(from, imp.to);
      if (hard && !hardSeen.has(key)) { hardSeen.add(key); g.hard.push({ rule: hard, key }); }
      if (imp.runtime && !imp.dynamic && asms.has(imp.to)) { g.edges.add(key); g.l6.add(key); }
      const target = fold.get(imp.to)!;
      if (imp.runtime && !imp.dynamic && target !== node) adj.get(node)!.add(target);
      if (imp.runtime && !imp.dynamic && target === node && !assemblers.has(from) && !assemblers.has(imp.to) && node !== from) {
        if (!intra.has(from)) intra.set(from, new Set());
        intra.get(from)!.add(imp.to);
      }
    }
  }
  // Folding X/* into X.ts turns a cycle X/a ↔ X/b into a self-loop the area count never sees: each one is a hard red.
  for (const comp of cycleComponents(intra)) g.hard.push({ rule: 'L4', key: [...comp].sort().join('↔') });
  const counts = new Map<string, number>();
  for (const node of adj.keys()) counts.set(areaOf(node), counts.get(areaOf(node)) ?? 0);
  for (const node of new Set(cycleComponents(adj).flat())) counts.set(areaOf(node), (counts.get(areaOf(node)) ?? 0) + 1);
  g.cycles = counts;
  return g;
}
