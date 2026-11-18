// @ts-check
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * Flat config for ESLint 9 (coding standard §1; same rule set as hagenta's). The rules kept here catch a *defect* the
 * TypeScript compiler does not: a promise nobody awaited, a `catch` that swallows, an `any` that erases a contract, a
 * `console.log` left in the engine. Style is not policed — the repo has no formatter and a style rule would only
 * produce noise nobody reads.
 *
 * Type-aware linting is on (`projectService`), which is why `no-floating-promises` and `no-misused-promises` can be
 * enabled at all: both are the difference between an engine pass that reports its failure and one that crashes the
 * sidecar with an unhandled rejection. Errors that existed when the standard landed are counted per file in
 * `scripts/lint-baseline.json` (the same ratchet as the structure baseline); `bun run lint` fails on any new one.
 */
export default tseslint.config(
  {
    // Build output, dependencies, the Tauri / Swift shells, the measured prototype (`reference/`, plain .mjs that is
    // ported, never run by the app) and `docs/` (research scripts / mockups, never shipped).
    ignores: ['**/node_modules/**', '**/dist/**', '.tsbuild/**', 'src-tauri/**', 'menubar/**', 'reference/**', 'docs/**',
      '.e2e-results/**', 'playwright-report/**', '.local/**', '.superpowers/**', '.claude/**',
      // declarations carry no runtime; stray `tsc` emits beside a source are not in any project
      '**/*.d.ts',
      // copied verbatim into the build (v2.8 /theme-boot.js, plain ES5 before any bundle); web/test/theme.test.ts runs it
      'web/public/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // An unused binding is either a leftover or a rename that missed a use site. `_` prefixed parameters are the
      // documented way to say "this position exists but I do not read it".
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'all', caughtErrorsIgnorePattern: '^_',
      }],
      // A promise nobody awaits is a failure nobody reports. `void expr` is the explicit opt-out.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // `any` crosses a module boundary and takes the contract with it. `unknown` is always available.
      '@typescript-eslint/no-explicit-any': 'error',
      // The engine logs through its own logger; `console` in a request path is how a secret reaches a terminal.
      'no-console': 'error',
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      // OFF, deliberately: a handler whose return value must be a promise and a test body that only builds a rejected
      // promise both declare `async` without awaiting; the rule cannot tell either from a mistake.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // Rules-of-hooks and dependency checking for the web app. Only the two classic rules, not the React-Compiler preset:
    // the app is written with manual memoization and the compiler rules would report a design choice, not a defect.
    files: ['web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    // The browser bundle: `console.error` / `warn` is the only place a user-visible failure can be reported from.
    files: ['web/**/*.{ts,tsx}'],
    rules: { 'no-console': ['error', { allow: ['error', 'warn'] }] },
  },
  {
    // Operator CLIs, the fake `claude`, the dev servers: their output contract is stdout / stderr.
    files: ['scripts/**/*.ts', 'fake-claude/**/*.ts', 'fake-cbm/**/*.ts', 'fake-mcp/**/*.ts', 'web/dev/**/*.ts', 'e2e/**/*.ts'],
    rules: { 'no-console': ['error', { allow: ['error', 'warn', 'log'] }] },
  },
  {
    // The sidecar entry: its stderr lines are the boot contract Tauri reads (lock held, port, fatal start error).
    files: ['engine/src/boot.ts'],
    rules: { 'no-console': ['error', { allow: ['error'] }] },
  },
  {
    // Tests assert against values the runtime hands back untyped (JSON frames, SQLite rows, DOM nodes).
    files: ['**/test/**/*.{ts,tsx}', '**/it/**/*.{ts,tsx}', 'e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    // This file is linted by the config it defines; it is plain JS with no project entry.
    files: ['eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
