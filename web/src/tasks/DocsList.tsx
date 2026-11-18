// v2.7 §4.10 (IS20, D94) a spec's documents: the "Tài liệu" block of the spec card / overview and the "Tài liệu ▾" list of
// the list head (spec Đang build / Xong). Rows come from `spec_outputs` in the engine's fixed order (Spec · Mockup · Ảnh ·
// Nghiên cứu / md khác · Prototype / link) with the engine's `display` (token masked, R33); the `ref` is never shown. A
// click opens: `.md` → Code (Đọc), image → Code's image viewer (← / → step through its folder), `.html` → the Mac browser
// through `open_doc` (§10.3), `http(s)` → the Mac browser (`open_url`). Nothing runs inside the app window (R32). A refused /
// failed open says why in a toast (hf1117-docs), never silently; the row shows a spinner while the open is pending (hf1117-fb).
import { useEffect, useRef, useState, type MutableRefObject, type ReactElement } from 'react';
import type { SpecInfo, SpecOutput } from '../../../shared/issues.ts';
import type { Tr } from '../../../shared/i18n/core.ts';
import { requestCodeOpen } from '../lib/code-open.ts';
import { useT } from '../lib/i18n.tsx';
import { openLink, openWhy, safeHref } from '../lib/links.ts';
import { hasTauri, invoke } from '../lib/tauri.ts';
import { appToast } from '../lib/toast-bus.ts';
import { Icon } from '../ui/icons.tsx';
import type { TasksCtx } from './tasks-ctx.ts';

/** §4.10 the row's name: Spec · Mockup · "Ảnh mockup · n" · a session's label (else the file name) · a link's label. */
export function docLabel(o: SpecOutput, tr: Tr): string {
  if (o.role === 'spec' || o.role === 'mockup') return tr(`tasks.docs.role.${o.role}`);
  if (o.role === 'images') return tr('tasks.docs.role.images', { n: o.count ?? 1 });
  if (o.label) return o.label;
  return o.role === 'link' ? tr('tasks.docs.role.link') : o.ref.split('/').pop() || tr('tasks.docs.role.doc');
}

/** §4.10 where a row opens: `.html` and links leave the app (R32), the rest is Code. */
export const docWhere = (o: SpecOutput): 'code' | 'browser' => (o.kind === 'html' || o.kind === 'link' ? 'browser' : 'code');

export interface DocEnv {
  /** absolute project root (`open_doc` takes an absolute path; Rust checks it against the open roots) */
  root: string;
  toCode: () => void;
  openDoc: (absPath: string) => Promise<unknown>;
  openUrl: (url: string) => Promise<unknown>;
  /** the open was refused or failed (`why` = the Rust refusal code or error) */
  fail: (o: SpecOutput, why: unknown) => void;
}

/** §4.10 a click on a row: true = opened in Code; a promise = the browser open, settled (a failure already reported through
 *  `fail`, never rejects); false = nothing opened (a missing file, a link that is not http(s)). */
export function docOpen(o: SpecOutput, env: DocEnv): boolean | Promise<void> {
  if (o.state === 'missing') return false;
  const out = (p: Promise<unknown>) => p.then(() => {}, (e: unknown) => env.fail(o, e));
  if (o.kind === 'link') {
    const url = safeHref(o.ref);
    if (!url || url.startsWith('mailto:')) return false;
    return out(env.openUrl(url));
  }
  if (o.kind === 'html') return out(env.openDoc(`${env.root.replace(/\/+$/, '')}/${o.ref}`));
  requestCodeOpen({ kind: 'base' }, o.ref);
  env.toCode();
  return true;
}

/** hf1117-fb (loading rule) one row click: ignored while `busy`; a browser open keeps the row busy (`set`) until it settles,
 *  then `done` (the menu closes); any other click is `done` at once. Returns the pending open, else null. */
export function rowClick(o: SpecOutput, env: DocEnv, busy: MutableRefObject<boolean>, set: (b: boolean) => void, done?: () => void): Promise<void> | null {
  if (busy.current) return null;
  const r = docOpen(o, env);
  if (!(r instanceof Promise)) { done?.(); return null; }
  busy.current = true;
  set(true);
  return r.finally(() => { busy.current = false; set(false); done?.(); });
}

const ICON = { md: 'file', other: 'file', image: 'image', html: 'globe', link: 'extLink' } as const;

/** hf1117-docs the toast of a refused / failed open: the row's name and the reason in words (`openWhy`). */
export function docFailText(tr: Tr, o: SpecOutput, why: unknown): string {
  return tr('tasks.docs.fail', { name: docLabel(o, tr), why: openWhy(tr, why) });
}

/** `.html` in the Mac app: Rust `open_doc`; a plain browser (dev, phone) cannot open `file://` from http: `mac_only`. */
const openDoc = (path: string): Promise<unknown> => (hasTauri() ? invoke('open_doc', { path }) : Promise.reject(new Error('mac_only')));
const docEnv = (c: TasksCtx, tr: Tr): DocEnv => ({
  root: c.project.path, toCode: c.toCode, openDoc, openUrl: openLink, fail: (o, why) => appToast('error', docFailText(tr, o, why)),
});

/** `spec_outputs` of one spec, asked again each time `n` changes (the localhost probe runs when the list shows). */
function useOutputs(c: TasksCtx, spec: SpecInfo, n: number): SpecOutput[] | null {
  const [st, setSt] = useState<{ key: string; rows: SpecOutput[] } | null>(null);
  const key = `${c.project.id}\n${spec.path}`;
  const { cmds, locked } = c;
  useEffect(() => {
    if (locked) return;
    let live = true;
    cmds.outputs(spec.path).then(rows => { if (live) setSt({ key, rows }); }, () => { if (live) setSt({ key, rows: [] }); });
    return () => { live = false; };
  }, [cmds, key, spec.path, n, locked]);
  return st?.key === key ? st.rows : null;
}

/** `done`: the open was handed over (the "Tài liệu ▾" menu closes then, so the busy row stays in sight). */
export function DocRow({ o, env, tr, done }: { o: SpecOutput; env: DocEnv; tr: Tr; done?: () => void }): ReactElement {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const where = tr(`tasks.docs.where.${docWhere(o)}`);
  const miss = o.state === 'missing';
  const cls = `drow${miss ? ' miss' : ''}${o.state === 'off' ? ' off' : ''}`;
  return (
    <button type="button" className={cls} disabled={miss} title={o.display} aria-busy={busy || undefined}
      onClick={() => { void rowClick(o, env, pending, setBusy, done); }}>
      {busy ? <span className="spin sm" aria-hidden="true" /> : <Icon n={ICON[o.kind]} s={14} />}
      <span className="dl">{docLabel(o, tr)}</span>
      <span className="dp"><bdi>{o.display}</bdi></span>
      <span className="dw">{miss ? tr('tasks.docs.missing') : o.state === 'off' ? `${tr('tasks.docs.off')} · ${where}` : where}</span>
    </button>
  );
}

function Rows({ rows, c, tr, done }: { rows: SpecOutput[] | null; c: TasksCtx; tr: Tr; done?: () => void }): ReactElement {
  if (!rows) return <p className="dnote">{tr('tasks.docs.loading')}</p>;
  const env = docEnv(c, tr);
  return (<>
    {rows.map((o, i) => <DocRow key={`${o.role}:${o.ref}:${i}`} o={o} env={env} tr={tr} done={done} />)}
    {rows.filter(o => o.role !== 'spec').length ? null : <p className="dnote">{tr('tasks.docs.empty')}</p>}
  </>);
}

/** §4.10 the "Tài liệu" block inside the spec card (IS14 / IS15) and the overview (IS22 / IS22b). */
export function DocsBlock({ c, spec }: { c: TasksCtx; spec: SpecInfo }): ReactElement {
  const tr = useT();
  const rows = useOutputs(c, spec, 0);
  return (
    <section className="sdocs" aria-label={tr('tasks.docs.title')}>
      <h4>{tr('tasks.docs.title')}</h4>
      <Rows rows={rows} c={c} tr={tr} />
    </section>
  );
}

/** §4.10 IS20 "Tài liệu ▾" in the list head of a spec Đang build / Xong: the same rows as a drop-down under the button;
 *  `item` = the row of the narrow "⋯" menu (IS10c, UX M3: doc icon + ›, the rows open to its left side). */
export function DocsMenu({ c, spec, item = false }: { c: TasksCtx; spec: SpecInfo; item?: boolean }): ReactElement {
  const tr = useT();
  const [open, setOpen] = useState(0);
  const btn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const rows = useOutputs(c, spec, open);
  const { setPop } = c;
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(0);
    setPop(close);
    const down = (e: MouseEvent) => { const t = e.target as Node; if (!box.current?.contains(t) && !btn.current?.contains(t)) close(); };
    document.addEventListener('mousedown', down);
    return () => { setPop(null); document.removeEventListener('mousedown', down); };
  }, [open, setPop]);
  const r = open ? btn.current?.getBoundingClientRect() : null;
  const toggle = () => setOpen(o => (o ? 0 : Date.now()));
  const close = () => setOpen(0);
  const at = r ? (item ? { top: r.top, right: Math.max(8, window.innerWidth - r.left + 4) } : { top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) }) : null;
  return (<>
    {item ? (
      <button ref={btn} type="button" role="menuitem" className="dmi" aria-expanded={!!open} aria-haspopup="true" onClick={toggle}>
        <Icon n="file" s={13} />{tr('tasks.docs.menu')}<span className="dmc"><Icon n="chevR" s={13} /></span>
      </button>
    ) : (
      <button ref={btn} type="button" className="lbtn" aria-expanded={!!open} aria-haspopup="true" onClick={toggle}>
        {tr('tasks.docs.menu')}<Icon n="chev" s={12} />
      </button>
    )}
    {open && at ? (
      <div ref={box} className="dmenu" data-pop="" role="menu" aria-label={tr('tasks.docs.title')} style={at}>
        <Rows rows={rows} c={c} tr={tr} done={close} />
      </div>
    ) : null}
  </>);
}
