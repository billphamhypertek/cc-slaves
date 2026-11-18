import ts from 'typescript';
import { collectGraph, type ResolveOptions } from './graph';
import { FILE_RULES, scanScrollAnim, SCROLL_ANIM_KEY } from './scrollbars';
import { isTypeScaleFile } from './type-scale';

/**
 * The measuring half of `check:structure` (coding standard §1; port of hagenta's RF1 checker): one pass over a tree of
 * product files (path → text) that yields every measured key of the five sections, plus the hard reds (L1, L2, L4).
 * Pure: the tree may come from the working copy or from an in-memory test fixture.
 */

export type Section = 'files' | 'functions' | 'edges' | 'cycles' | 'patterns';
export const SECTIONS: readonly Section[] = ['files', 'functions', 'edges', 'cycles', 'patterns'];
/** A measured value strictly above this is a violation (file 800, function 250; any edge / cycle / pattern). */
export const THRESHOLD: Readonly<Record<Section, number>> = { files: 800, functions: 250, edges: 0, cycles: 0, patterns: 0 };

type Tree = ReadonlyMap<string, string>;
/** L1 / L2: a forbidden import; L4: a runtime cycle between fragments of one assembler (key `a↔b…`). */
export interface HardRed { rule: 'L1' | 'L2' | 'L4'; key: string }
export interface Measurement {
  /** Every key that points at something, with its value — also the ones at or under the threshold (rule (c)). */
  values: Record<Section, Map<string, number>>;
  /** L1 / L2 edges and intra-fragment-dir cycles: red at once, never baselined. */
  hard: HardRed[];
  /** Edge keys that break L6 (fragment → its assembler): red when new. */
  l6: Set<string>;
}
export type { ResolveOptions };

export const PRODUCT_DIRS = ['engine', 'web', 'shared', 'fake-claude', 'fake-cbm', 'fake-mcp', 'scripts'] as const;
const PRODUCT = new RegExp(`^(${PRODUCT_DIRS.join('|')})/`);
const isCode = (path: string): boolean => /\.(ts|tsx)$/.test(path) && !path.endsWith('.d.ts');
export const isProductFile = (path: string): boolean => PRODUCT.test(path) && (isCode(path) || path.endsWith('.css'));

/** A file carrying `GENERATED` in its first 5 lines is generated, and skipped for size and patterns. */
const isGenerated = (text: string): boolean => text.split('\n', 5).some((line) => line.includes('GENERATED'));

/** `wc -l`: the number of newline characters. */
const lineCount = (text: string): number => {
  let n = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n += 1;
  return n;
};

interface Pattern { name: string; re: RegExp; applies: (path: string) => boolean }
/** One home per helper (coding standard §4): a declaration of the same name anywhere else counts as `helper-decl`. */
const HELPER_HOMES: Readonly<Record<string, string>> = {
  ensureDir: 'engine/src/paths.ts',
  writeFileSecure: 'engine/src/paths.ts',
  displayTokens: 'shared/protocol.ts',
  isObj: 'shared/json.ts',
  shq: 'engine/src/session/env.ts',
  makeT: 'shared/i18n/core.ts',
  fmtNum: 'shared/i18n/core.ts',
  fmtPct: 'shared/i18n/core.ts',
  fmtDate: 'shared/i18n/core.ts',
  fmtTok: 'web/src/lib/format.ts',
  fmtCost: 'web/src/lib/format.ts',
  fmtLeft: 'web/src/lib/format.ts',
  fmtHm: 'web/src/lib/format.ts',
  shortEmail: 'web/src/lib/format.ts',
  fmtSecs: 'web/src/lib/format.ts',
  fmtBytes: 'web/src/lib/format.ts',
  safeHref: 'web/src/lib/links.ts',
  openExternal: 'web/src/lib/links.ts',
  copyText: 'web/src/lib/links.ts',
  canRun: 'web/src/lib/remote.ts',
  motionPolicy: 'web/src/deck/motion.ts',
  useReducedOS: 'web/src/lib/reduced-motion.ts',
};
const helperDecl = (name: string): RegExp => new RegExp(`(?:\\bfunction\\s+${name}\\b|\\b(?:const|let|var)\\s+${name}\\s*[=:])`, 'g');
/** Banned patterns, each with the paths it applies to. */
const PATTERNS: readonly Pattern[] = [
  { name: 'spread-accumulate', re: /\.set\([^,]+,\s*\[\.\.\.\(/g, applies: isCode },
  // §4 "Animate or not": the OS reduced-motion source lives in `useReducedOS` (lib/reduced-motion.ts); CSS @media stays allowed
  { name: 'local-reduced-motion', re: /prefers-reduced-motion/g, applies: (path) => isCode(path) && path.startsWith('web/src/') && path !== HELPER_HOMES.useReducedOS },
];
/** The checker's own tests carry every banned pattern as a fixture string. */
const CHECKER_TESTS = 'scripts/test/';
const countMatches = (text: string, re: RegExp): number => text.match(re)?.length ?? 0;
const helperCount = (path: string, text: string): number =>
  Object.entries(HELPER_HOMES).reduce((n, [name, home]) => (path === home ? n : n + countMatches(text, helperDecl(name))), 0);

/** Unwraps `( … )`, `as`, `satisfies`, `!` and the `memo(…)` / `forwardRef(…)` wrappers. */
const WRAPPERS = new Set(['memo', 'forwardRef']);
function unwrapFunction(expr: ts.Expression): ts.ArrowFunction | ts.FunctionExpression | undefined {
  let e: ts.Expression = expr;
  for (;;) {
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return e;
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) {
      e = e.expression;
      continue;
    }
    if (ts.isCallExpression(e) && e.arguments[0]) {
      const callee = e.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
      if (WRAPPERS.has(name)) { e = e.arguments[0]; continue; }
    }
    return undefined;
  }
}

const memberName = (name: ts.PropertyName | undefined, sf: ts.SourceFile): string => {
  if (!name) return 'constructor';
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return name.getText(sf);
};

function classMembers(cls: ts.ClassDeclaration, sf: ts.SourceFile, put: (name: string, node: ts.Node) => void): void {
  const name = cls.name?.text ?? 'default';
  for (const m of cls.members) {
    const hasBody = (ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m) || ts.isGetAccessorDeclaration(m)
      || ts.isSetAccessorDeclaration(m)) && m.body !== undefined;
    const isArrowProp = ts.isPropertyDeclaration(m) && m.initializer !== undefined && unwrapFunction(m.initializer) !== undefined;
    if (hasBody || isArrowProp) put(`${name}.${memberName(m.name, sf)}`, m);
  }
}

/** Top-level functions and class methods, `endLine − startLine + 1` from `getStart()`; nested ones are inside. */
function functionLengths(sf: ts.SourceFile): Map<string, number> {
  const out = new Map<string, number>();
  const span = (node: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(node.getEnd()).line - sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const put = (name: string, node: ts.Node) => out.set(name, Math.max(out.get(name) ?? 0, span(node)));
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt)) {
      if (stmt.body) put(stmt.name?.text ?? 'default', stmt);
    } else if (ts.isVariableStatement(stmt)) {
      const decls = stmt.declarationList.declarations;
      for (const d of decls) {
        if (d.initializer && unwrapFunction(d.initializer) && ts.isIdentifier(d.name)) put(d.name.text, decls.length === 1 ? stmt : d);
      }
    } else if (ts.isExportAssignment(stmt)) {
      if (unwrapFunction(stmt.expression)) put('default', stmt);
    } else if (ts.isClassDeclaration(stmt)) {
      classMembers(stmt, sf, put);
    }
  }
  return out;
}

const parse = (path: string, text: string): ts.SourceFile =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/** Measures one tree. Non-product paths in it are ignored; CSS files count for size and the type scale only. */
export function measureTree(tree: Tree, opts: ResolveOptions): Measurement {
  const values: Measurement['values'] = { files: new Map(), functions: new Map(), edges: new Map(), cycles: new Map(), patterns: new Map() };
  const product = new Map([...tree].filter(([path]) => isProductFile(path)));
  const sources = new Map<string, ts.SourceFile>();
  for (const [path, text] of product) {
    const sf = isCode(path) ? parse(path, text) : undefined;
    if (sf) sources.set(path, sf);
    if (isGenerated(text)) continue;
    values.files.set(path, lineCount(text));
    if (isTypeScaleFile(path)) for (const [rule, scan] of Object.entries(FILE_RULES)) values.patterns.set(`${rule}@${path}`, scan(path, text).length);
    if (!sf) continue;
    for (const [name, n] of functionLengths(sf)) values.functions.set(`${path}#${name}`, n);
    if (path.startsWith(CHECKER_TESTS)) continue;
    for (const p of PATTERNS) if (p.applies(path)) values.patterns.set(`${p.name}@${path}`, countMatches(text, p.re));
    values.patterns.set(`helper-decl@${path}`, helperCount(path, text));
  }
  values.patterns.set(SCROLL_ANIM_KEY, scanScrollAnim(product).length);
  const graph = collectGraph(product, sources, opts);
  for (const key of graph.edges) values.edges.set(key, 1);
  for (const [area, n] of graph.cycles) values.cycles.set(`cycles@${area}`, n);
  return { values, hard: graph.hard, l6: graph.l6 };
}
