/**
 * `bun scripts/release/export.ts <ver> <out-dir>` — the clean public snapshot of the dev tag `v<ver>` (spec v2.6 §7.7).
 * Read-only on the dev repo (cwd); pushes nothing. Exit 1 on any finding, each printed as `path:line`; a red export
 * removes `<out-dir>` so nothing half-scanned is left to publish.
 * `bun scripts/release/export.ts --check <dir>` — only the scans of step 2–4 on an existing snapshot (publish.sh, §7.8-3).
 *
 * 1. preconditions: clean tree, HEAD = tag, package.json at the tag = <ver>, out-dir empty or absent;
 * 2. the allow-list of committed files at the tag (`git archive`, never the working tree), then a deny net on the result;
 * 3. an email scan that only lets reserved domains through (RFC 2606 / 6761), no per-file exemptions;
 * 4. secrets (keys, tokens, webhooks), the PO's private traces and handles — in text, binary files and every path name —,
 *    symlinks that point outside the snapshot, compile-time reads (`include_str!` / `include_bytes!`) and README links that
 *    must resolve inside the out-dir.
 * The patterns are written so that this file passes its own scan (it ships in scripts/).
 */
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** §7.7-2: a trailing `/` is a directory prefix, anything else one root file. */
export const ALLOW: readonly string[] = [
  'engine/', 'shared/', 'web/', 'src-tauri/', 'menubar/', 'scripts/', 'e2e/', 'fake-claude/', 'fake-cbm/', 'fake-mcp/',
  '.github/', 'docs/readme/', 'docs/releases/',
  'package.json', 'bun.lock', 'tsconfig.json', 'tsconfig.base.json', 'eslint.config.js', 'knip.json', 'playwright.config.ts',
  'LICENSE', 'README.md', 'README.en.md', '.gitignore',
];
/** §7.7-2 second net: checked on the exported result, so a widened allow-list still cannot leak these. */
const DENY = [/(^|\/)docs\/specs(\/|$)/, /(^|\/)docs\/ref(\/|$)/, /HANDOFF/, /(^|\/)\.local(\/|$)/, /(^|\/)reports(\/|$)/,
  /(^|\/)CLAUDE\.md$/, /(^|\/)reference(\/|$)/];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const RESERVED = ['example.com', 'example.net', 'example.org'];
const RESERVED_TLD = ['example', 'test', 'invalid', 'localhost'];
const SECRETS: [RegExp, string][] = [
  [/PRIVATE KEY-{5}/, 'private key'],
  [/rsign encrypted secret ke[y]/, 'minisign secret key'],
  [/TAURI_SIGNING_PRIVATE_KE[Y]=/, 'signing key assignment'],
  [/sk-an[t]-/, 'API key'],
  [/(^|[^A-Za-z0-9])hypertek\./, 'company domain'],
  [/\/Users\/binhp[s]/, 'Mac user path'],
  [/gh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/github_pa[t]_/, 'GitHub token'],
  [/AIza[0-9A-Za-z_-]{30}/, 'Google API key'],
  [/chat\.googleapis\.com\/v1\/spaces/, 'Google Chat webhook'],
  [/dungn[v]|binhp[s](?!@|hypertek)|nguyenvanbin[h]/, 'PO handle'],
];
const INCLUDE = /include_(?:str|bytes)!\(\s*"([^"]+)"\s*\)/g;
const LINKS = [/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, /(?:src|href)=["']([^"']+)["']/g];

function emailOk(addr: string): boolean {
  const raw = addr.slice(addr.indexOf('@') + 1).toLowerCase();
  if (/^\d+x\.(png|jpe?g|webp)$/.test(raw)) return true; // icon@2x.png
  const domain = raw.replace(/\.(log|jsonl)$/, ''); // stdin-pm@x.test.log names a log file
  return RESERVED.some((d) => domain === d || domain.endsWith(`.${d}`)) || RESERVED_TLD.some((t) => domain.endsWith(`.${t}`));
}

/** §7.7-3 / -4 content scans of one text file: `path:line what` per finding. */
export function scanText(rel: string, text: string): string[] {
  const found: string[] = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(EMAIL)) if (!emailOk(m[0])) found.push(`${rel}:${i + 1} email ${m[0]}`);
    for (const [re, what] of SECRETS) if (re.test(line)) found.push(`${rel}:${i + 1} ${what}`);
  });
  return found;
}

/** Literal paths of `include_str!` / `include_bytes!` and README links must exist inside the out-dir. */
function scanTargets(out: string, rel: string, text: string): string[] {
  const isRust = rel.endsWith('.rs');
  const isReadme = /^README.*\.md$/.test(basename(rel));
  if (!isRust && !isReadme) return [];
  const found: string[] = [];
  const here = dirname(join(out, rel));
  text.split('\n').forEach((line, i) => {
    const targets = isRust ? [...line.matchAll(INCLUDE)].map((m) => m[1]!) : LINKS.flatMap((re) => [...line.matchAll(re)].map((m) => m[1]!))
      .filter((t) => !/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(t)).map((t) => t.replace(/[#?].*$/, '')).filter(Boolean);
    for (const t of targets) {
      const abs = t.startsWith('/') && !isRust ? join(out, t) : isAbsolute(t) ? t : resolve(here, t);
      const inside = !relative(out, abs).startsWith('..') && !isAbsolute(relative(out, abs));
      if (!inside || !existsSync(abs)) found.push(`${rel}:${i + 1} ${isRust ? 'compile-time read' : 'link'} outside the snapshot: ${t}`);
    }
  });
  return found;
}

function git(repo: string, ...args: string[]): { ok: boolean; out: string } {
  const p = Bun.spawnSync(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe' });
  return { ok: p.exitCode === 0, out: p.stdout.toString() };
}

function preconditions(repo: string, ver: string, out: string): string[] {
  const errors: string[] = [];
  const tag = `v${ver}`;
  if (git(repo, 'status', '--porcelain', '--untracked-files=all').out.trim() !== '') errors.push('the working tree is not clean (commit or remove every change)');
  const tagSha = git(repo, 'rev-parse', '--verify', '-q', `${tag}^{commit}`);
  if (!tagSha.ok) errors.push(`no tag ${tag}`);
  else if (tagSha.out.trim() !== git(repo, 'rev-parse', 'HEAD').out.trim()) errors.push(`HEAD is not ${tag}`);
  const pkg = git(repo, 'show', `${tag}:package.json`);
  const pkgVer = pkg.ok ? (JSON.parse(pkg.out) as { version?: string }).version : undefined;
  if (tagSha.ok && pkgVer !== ver) errors.push(`package.json at ${tag} is ${pkgVer}, not ${ver}`);
  if (existsSync(out) && readdirSync(out).length > 0) errors.push(`${out} must be empty or absent`);
  return errors;
}

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p, base) : [relative(base, p)];
  });
}

/** The whole export; `allow` is a seam for the mutation test of the deny net (§13). */
export function exportSnapshot(o: { repo: string; ver: string; out: string; allow?: readonly string[] }): { errors: string[]; files: number; bytes: number } {
  const { repo, ver } = o;
  const out = resolve(o.out);
  const allow = o.allow ?? ALLOW;
  const pre = preconditions(repo, ver, out);
  if (pre.length > 0) return { errors: pre, files: 0, bytes: 0 };
  const stage = mkdtempSync(join(tmpdir(), 'ccs-export-stage-'));
  const tar = join(stage, 'tag.tar');
  if (!git(repo, 'archive', '--format=tar', '-o', tar, `v${ver}`).ok) return { errors: ['git archive failed'], files: 0, bytes: 0 };
  mkdirSync(join(stage, 'tree'));
  if (Bun.spawnSync(['tar', '-xf', tar, '-C', join(stage, 'tree')]).exitCode !== 0) return { errors: ['tar -x failed'], files: 0, bytes: 0 };
  const listed = git(repo, 'ls-tree', '-r', '-z', '--name-only', `v${ver}`).out.split('\0').filter(Boolean);
  mkdirSync(out, { recursive: true });
  for (const f of listed) {
    if (!allow.some((a) => (a.endsWith('/') ? f.startsWith(a) : f === a))) continue;
    const src = join(stage, 'tree', f);
    if (lstatSync(src, { throwIfNoEntry: false }) === undefined) continue; // a submodule entry: git archive leaves it out (a dangling symlink stays)
    mkdirSync(dirname(join(out, f)), { recursive: true });
    cpSync(src, join(out, f), { verbatimSymlinks: true });
  }
  const r = scanSnapshot(out);
  if (r.errors.length > 0) rmSync(out, { recursive: true, force: true }); // out was empty or absent (preconditions)
  return r;
}

/** Steps 2–4 on a snapshot dir: the deny net, then every content, path, symlink and link scan. */
function scanSnapshot(out: string): { errors: string[]; files: number; bytes: number } {
  const files = walk(out);
  const errors = files.filter((f) => DENY.some((re) => re.test(f))).map((f) => `${f}:1 deny net: must never be exported`);
  let bytes = 0;
  for (const f of files) {
    const st = lstatSync(join(out, f));
    bytes += st.size;
    errors.push(...scanText(f, f)); // the path name ships too
    if (st.isSymbolicLink()) { // never followed; its target must stay inside the snapshot
      const target = readlinkSync(join(out, f));
      const rel = relative(out, resolve(dirname(join(out, f)), target));
      if (isAbsolute(target) || rel.startsWith('..') || isAbsolute(rel)) errors.push(`${f}:1 symlink outside the snapshot: ${target}`);
      continue;
    }
    const buf = readFileSync(join(out, f));
    if (buf.includes(0)) { errors.push(...scanText(f, buf.toString('latin1'))); continue; } // binary: same rules, no link targets
    const text = buf.toString('utf8');
    errors.push(...scanText(f, text), ...scanTargets(out, f, text));
  }
  return { errors, files: files.length, bytes };
}

if (import.meta.main) {
  const [ver, out] = process.argv.slice(2);
  const check = ver === '--check';
  if (ver === undefined || out === undefined || !(check ? existsSync(out) : /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(ver))) {
    console.error('usage: bun scripts/release/export.ts <ver> <out-dir> | --check <snapshot-dir>');
    process.exitCode = 1;
  } else {
    const r = check ? scanSnapshot(resolve(out)) : exportSnapshot({ repo: process.cwd(), ver, out });
    for (const e of r.errors) console.error(e);
    if (r.errors.length === 0) console.log(`export: ${resolve(out)}: ${r.files} files, ${r.bytes} bytes`);
    process.exitCode = r.errors.length === 0 ? 0 : 1;
  }
}
