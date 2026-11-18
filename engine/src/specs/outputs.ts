// spec v2.7 §4.10 IS20 / R33 / §10.1: the documents of a spec — the spec file and `docs/specs/assets/<dated spec name>*`
// (auto) + the rows sessions add with `spec_output_add`. Fixed order Spec · Mockup · Ảnh (grouped) · Nghiên cứu / md khác ·
// Prototype / link. A localhost link is probed (≤ 300 ms) so a stopped server shows "đã tắt"; other hosts never are.
// Pure over fs (R-B3): the caller passes the session rows and the port probe. Labels are the web's (catalog), by `role`.
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path';
import { checkPath, relOf } from '../code/path.ts';
import type { SpecOutput, SpecOutputKind, SpecOutputRole } from '../../../shared/issues.ts';

const PROBE_MS = 300;
const WALK_DEPTH = 3;
const WALK_MAX = 500;

type OutputKind = SpecOutputKind;
type OutputRole = SpecOutputRole;
export interface SessionOutputRow { ref: string; label: string | null }
/** `connect(host, port, timeoutMs)` → is something listening. */
export type PortProbe = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif']);
const isUrl = (ref: string) => /^https?:\/\//i.test(ref);

function kindOf(ref: string): OutputKind {
  if (isUrl(ref)) return 'link';
  const ext = extname(ref).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'md';
  if (ext === '.html' || ext === '.htm') return 'html';
  return IMAGE.has(ext) ? 'image' : 'other';
}
const ROLE: Record<OutputKind, OutputRole> = { md: 'doc', other: 'doc', html: 'mockup', image: 'images', link: 'link' };
const ORDER: OutputRole[] = ['spec', 'mockup', 'images', 'doc', 'link'];

/** §4.10 a URL as host + path, `user:pw@` dropped and every `…token=` value masked (query and fragment); a path relative to
 * the spec's `docs` dir (v2.9 §8, `docs/specs` in Quy trình PO) when under it. */
function displayOf(ref: string, docs: string): string {
  if (!isUrl(ref)) return ref.startsWith(`${docs}/`) ? ref.slice(docs.length + 1) : ref;
  const rest = ref.replace(/^https?:\/\//i, '').replace(/^[^/?#]*@/, '');
  return rest.replace(/([?&#][\w-]*token=)[^&#]*/gi, '$1…').replace(/^([^/?#]*)\/(?=$|[?#])/, '$1');
}

/** Files under `rel` (a file or a dir walked ≤ 3 deep, ≤ 500 files), sorted root-relative paths. A symlink is never
 * followed (`lstat`): its target may be outside the project. */
function walk(root: string, rel: string, depth = 0, out: string[] = []): string[] {
  let st;
  try { st = lstatSync(join(root, rel)); } catch { return out; }
  if (st.isFile()) out.push(rel);
  else if (st.isDirectory() && depth < WALK_DEPTH) {
    for (const n of readdirSync(join(root, rel)).sort()) {
      if (out.length >= WALK_MAX) break;
      if (!n.startsWith('.')) walk(root, `${rel}/${n}`, depth + 1, out);
    }
  }
  return out;
}

/** R33 `<docs>/assets/<date-name>*`: the spec file's stem without the `-design` suffix of the spec naming. */
function autoRefs(root: string, docs: string, specPath: string): string[] {
  const prefix = basename(specPath, '.md').replace(/-design$/, '');
  const assets = `${docs}/assets`;
  let names: string[];
  try { names = readdirSync(join(root, assets)).filter((n) => n.startsWith(prefix)).sort(); } catch { return []; }
  return names.flatMap((n) => walk(root, `${assets}/${n}`));
}

function present(realRoot: string, ref: string): boolean {
  try { return checkPath(realRoot, ref).exists; } catch { return false; }
}

async function probe(ref: string, connect: PortProbe): Promise<'ok' | 'off'> {
  let u: URL;
  try { u = new URL(ref); } catch { return 'ok'; }
  if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return 'ok';
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  return (await connect(u.hostname, port, PROBE_MS).catch(() => false)) ? 'ok' : 'off';
}

/** §4.10 the rows of one spec in the fixed order; images (auto + session) become one `images` row. */
export async function listOutputs(o: { root: string; docs: string; specPath: string; sessionRows: readonly SessionOutputRow[]; connect: PortProbe }): Promise<SpecOutput[]> {
  const realRoot = realpathSync.native(o.root);
  const rows = new Map<string, { ref: string; label: string | null; addedBy: 'auto' | 'session' }>();
  for (const ref of autoRefs(o.root, o.docs, o.specPath)) rows.set(ref, { ref, label: null, addedBy: 'auto' });
  for (const s of o.sessionRows) {
    const had = rows.get(s.ref);
    if (had) had.label = s.label ?? had.label;
    else if (s.ref !== o.specPath) rows.set(s.ref, { ref: s.ref, label: s.label, addedBy: 'session' });
  }
  const make = async (r: { ref: string; label: string | null; addedBy: 'auto' | 'session' }, role: OutputRole): Promise<SpecOutput> => {
    const kind = kindOf(r.ref);
    const state = kind === 'link' ? await probe(r.ref, o.connect) : present(realRoot, r.ref) ? 'ok' : 'missing';
    return { role, kind, ref: r.ref, label: r.label, display: displayOf(r.ref, o.docs), addedBy: r.addedBy, state };
  };
  const all = [...rows.values()];
  const images = all.filter((r) => kindOf(r.ref) === 'image');
  const out = await Promise.all([
    make({ ref: o.specPath, label: null, addedBy: 'auto' }, 'spec'),
    ...all.filter((r) => kindOf(r.ref) !== 'image').map((r) => make(r, ROLE[kindOf(r.ref)])),
  ]);
  if (images.length > 0) out.push({ ...(await make(images[0]!, 'images')), count: images.length });
  return out.map((r, i) => ({ r, i })).sort((a, b) => ORDER.indexOf(a.r.role) - ORDER.indexOf(b.r.role) || a.i - b.i).map((x) => x.r);
}

export type OutputRefCheck = { ok: true; kind: OutputKind; ref: string } | { ok: false; error: string };

/** §10.1 `spec_output_add`: an `http(s)` URL, or an existing file inside the project (the `code/path.ts` check). */
export function validateOutputRef(root: string, ref: string): OutputRefCheck {
  if (isUrl(ref)) {
    try { new URL(ref); return { ok: true, kind: 'link', ref }; } catch { /* falls to the refusal */ }
  }
  const outside = { ok: false as const, error: `Từ chối: "${ref}" nằm ngoài project — chỉ nhận link http(s) hoặc file trong project.` };
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return outside;
  const realRoot = realpathSync.native(root);
  let rel = ref;
  if (isAbsolute(ref)) {
    const base = [realRoot, root].find((r) => ref.startsWith(r + sep));
    if (base === undefined) return outside;
    rel = relative(base, ref).split(sep).join('/');
  }
  let real: string;
  try {
    const c = checkPath(realRoot, rel, { allowMissing: true });
    if (!c.exists) return { ok: false, error: `Từ chối: không có file "${ref}" trong project.` };
    real = c.real;
  } catch { return outside; }
  if (!statSync(real).isFile()) return { ok: false, error: `Từ chối: "${ref}" không phải file — chỉ nhận link http(s) hoặc file trong project.` };
  const norm = relOf(realRoot, real);
  return { ok: true, kind: kindOf(norm), ref: norm };
}
