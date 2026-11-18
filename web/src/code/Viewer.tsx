// spec v2.3 §5.2 / §5.3 the viewer pane (C1–C4, C6–C10, C12, C14, C15, C19–C23, C29): the 44 px head (path cut in the
// middle, meta, "Đọc" | "Nguồn" for .md / .mdx, "Sửa" or while editing "Đang sửa" · "Huỷ" · "Lưu ⌘S", "Mở trong VS Code")
// over the whole file. Text → CodeMirror (its own lazy chunk, one state per tab), Markdown "Đọc" → DocView, image → on a
// checkerboard, binary → a centre note, large → yellow band + the first 2 MB as plain text, a failed read → "Không đọc
// được … · Thử lại". The footer only while editing / just saved / after a click on the greyed "Sửa" (ViewerBits).
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type RefObject } from 'react';
import type { FsReadResult } from '../../../shared/protocol.ts';
import type { LoadImage, ResolveLink } from '../lib/doc-links.ts';
import { errText, useT } from '../lib/i18n.tsx';
import { fmtBytes, fmtHm } from '../lib/format.ts';
import { openExternal } from '../lib/links.ts';
import { midEllipsis } from '../lib/mid-ellipsis.ts';
import { Icon } from '../ui/icons.tsx';
import { DocView } from './DocView.tsx';
import type { OpenFile, MdMode } from './code-tabs.ts';
import type { TabDoc, TabEditors } from './editor.ts';
import { monoFont } from '../lib/mono-font.ts';
import { isMd, langOf, largeRest, roReason, wrapFor } from './file-view.ts';
import { EditButtons, ViewerFoot, type EditGate } from './ViewerBits.tsx';

/** §5.3 the edit actions of the shown tab */
export interface EditActs {
  onEdit: () => void; onCancel: () => void; onSave: () => void;
  /** the editor's text after a change, with the cursor line (hot exit) */
  onChange: (text: string, line: number) => void;
  /** C8 "Nhắn D15…" */
  onAsk: (lane: string) => void;
}
export interface ViewerProps {
  file: OpenFile | null;
  /** (project, source, path) of the shown tab: its editor state */
  docKey: string;
  /** the open tabs' keys (a closed tab's editor state is let go) */
  keep: ReadonlySet<string>;
  /** §5.3 ③ / ④ a live session holds the source dir: the reason, the lane to message ("" lane = the orchestrator) */
  lock: EditGate;
  /** "Lưu" greyed with this reason (a restored buffer while the source is locked, C29) */
  saveOff: string | null;
  /** §7 C16 the engine is unreachable: the file stays readable, "Sửa" / "Lưu" / "Nhắn …" are locked */
  offline: boolean;
  ed: EditActs;
  onRetry: () => void;
  onMd: (m: MdMode) => void;
  onVscode: (path: string) => void;
  /** §10.1 the "Đọc" hooks (engine-checked links / images, open in the current file slot) */
  resolveLink: ResolveLink; loadImage: LoadImage; openInCode: (path: string) => void;
  /** the scroll box of the body (C15 "has the PO scrolled") */
  body: RefObject<HTMLDivElement>;
  /** a narrow window (C17): the md outline stays hidden */
  narrow: boolean;
}

/** The CodeMirror host: the core chunk loads on the first text file (§10.1), one view, one kept state per tab. */
function CmHost({ doc, keep, onChange }: { doc: TabDoc; keep: ReadonlySet<string>; onChange: (text: string, line: number) => void }): ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const eds = useRef<TabEditors | null>(null);
  const change = useRef(onChange);
  change.current = onChange;
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    void import('./editor.ts').then(m => {
      if (!live || !host.current) return;
      eds.current = m.TabEditors.mount(host.current, (t, l) => change.current(t, l));
      setReady(true);
    });
    return () => { live = false; eds.current?.destroy(); eds.current = null; };
  }, []);
  useEffect(() => { if (ready) eds.current?.show(doc); }, [ready, doc]);
  useEffect(() => { eds.current?.forget(keep); }, [keep]);
  return <div className={`ccm${doc.edit ? ' ed' : ''}`} ref={host} />;
}

/** px left for the path in the head: the head's width minus every other item (the spacer excluded). */
function usePathRoom(head: RefObject<HTMLDivElement>, deps: unknown): number {
  const [px, setPx] = useState(600);
  useLayoutEffect(() => {
    const el = head.current;
    if (!el) return;
    const measure = () => {
      // v2.4 §6.7 D53: the head's padding and gap are read from its computed style (tokens), never copied as px
      const cs = getComputedStyle(el);
      const gap = parseFloat(cs.columnGap) || 0;
      let used = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      for (const c of Array.from(el.children) as HTMLElement[]) if (!c.classList.contains('pth') && !c.classList.contains('sp')) used += c.offsetWidth + gap;
      setPx(Math.max(80, el.clientWidth - used));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [head, deps]);
  return px;
}

type T = ReturnType<typeof useT>;
function meta(tr: T, r: FsReadResult, dims: string | null): string | null {
  if (r.kind === 'image') return dims ? `${fmtBytes(r.size, tr)} · ${dims}` : fmtBytes(r.size, tr);
  if (r.kind === 'binary' || r.kind === 'large') return fmtBytes(r.size, tr);
  if (r.readOnly) return `${tr(r.readOnly === 'not_utf8' ? 'code.meta.notUtf8' : 'code.meta.mixedEol')}${r.eol ? ` · ${r.eol.toUpperCase()}` : ''}`;
  return null;
}

export function Viewer(p: ViewerProps): ReactElement {
  const tr = useT();
  const head = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState<string | null>(null);
  const f = p.file, r = f?.res ?? null;
  useEffect(() => setDims(null), [r]);
  const room = usePathRoom(head, `${f?.path}|${r?.kind}|${dims}|${f?.md}`);
  const [doc, setDoc] = useState<TabDoc | null>(null);
  const [lockShown, setLockShown] = useState<EditGate | null>(null);
  const editing = !!f?.edit;
  useEffect(() => setLockShown(null), [p.docKey, editing]);
  const { docKey } = p;
  useEffect(() => {
    if (!f?.edit && (!f || !r || (r.kind !== 'text' && r.kind !== 'large'))) { setDoc(null); return; }
    const large = r?.kind === 'large', rest = r ? largeRest(r) : 0;
    setDoc({ key: docKey, v: f.v, text: f.edit?.text ?? r?.text ?? '', lang: large ? null : langOf(f.path), wrap: wrapFor(f.path), edit: !!f.edit, line: f.edit?.line,
      endNote: large ? (rest ? tr('code.large.end', { rest: fmtBytes(rest, tr) }) : tr('code.large.endLines')) : null });
  }, [f?.v, f?.edit ? 1 : 0, f?.path, r, tr, docKey]); // eslint-disable-line react-hooks/exhaustive-deps -- the text lives in the editor between versions
  const bar = f?.loading ? <div className="cbar" /> : null;
  if (!f) return <div className="cvw">{bar}<div className="cemp"><Icon n="file" s={28} /><span>{tr('code.empty')}</span></div></div>;
  const ro = r ? roReason(r) : null;
  const md = !f.edit && r?.kind === 'text' && isMd(f.path);
  const gate: EditGate = ro ? { reason: tr(`code.ro.${ro}`), lane: null } : p.offline ? { reason: tr('code.offEdit'), lane: null } : p.lock;
  const saveOff = p.offline ? tr('code.foot.offline') : p.saveOff;
  const edit = f.edit || (r && r.kind !== 'image')
    ? <EditButtons f={f} gate={gate} saveOff={saveOff} onEdit={p.ed.onEdit} onLocked={() => setLockShown(gate)} onCancel={p.ed.onCancel} onSave={p.ed.onSave} /> : null;
  const vsc = !f.edit && r && r.kind !== 'binary'
    ? <button type="button" className="hb" title={tr('code.vscode.tip')} onClick={() => p.onVscode(f.path)}><Icon n="extLink" s={13} />{tr('code.vscode')}</button> : null;
  const m = r ? meta(tr, r, dims) : null;
  return (
    <div className="cvw">
      {r?.kind === 'large' ? <div className="cband warn"><Icon n="bang" s={13} />{tr('code.large.band', { size: fmtBytes(r.size, tr) })}</div> : null}
      {f.edit && f.restored !== null ? <div className="cband acc"><Icon n="history" s={13} /><span>{tr('code.restored', { time: fmtHm(f.restored) })}</span></div> : null}
      {f.stale ? <div className="cband acc"><Icon n="refresh" s={13} />
        <span>{f.stale.by ? tr('code.changedBy', { lane: f.stale.by, time: fmtHm(f.stale.at) }) : tr('code.changed')}</span>
        <button type="button" className="btn sm" onClick={p.onRetry}>{tr('code.reload')}</button></div> : null}
      <div className="cvh" ref={head}>
        <span className="pth" title={f.path}>{midEllipsis(f.path, room, monoFont('sm'))}</span>
        {f.edit ? <span className="edp"><Icon n="pencil" s={12} />{tr('code.editing')}</span> : null}
        {m ? <span className="meta">{m}</span> : null}
        {md ? <span className="seg2" role="group" aria-label={tr('code.md.aria')}>
          {(['read', 'src'] as const).map(k => <button key={k} type="button" className={f.md === k ? 'on' : undefined} aria-pressed={f.md === k} onClick={() => p.onMd(k)}>{tr(`code.md.${k}`)}</button>)}
        </span> : null}
        <span className="sp" />
        {edit}{vsc}
      </div>
      {bar}
      <div className="cbody" ref={p.body}>
        {f.edit && doc ? <CmHost doc={doc} keep={p.keep} onChange={p.ed.onChange} />
          : !r && f.loading ? <div className="cskel" aria-label={tr('deck.mode.loading')}>{[60, 72, 40, 0, 55, 68, 30].map((w, i) => <i key={i} style={{ width: `${w}%`, opacity: w ? undefined : 0 }} />)}</div>
          : !r ? <div className="cemp"><Icon n="fileX" s={28} /><b>{tr('code.err.title', { path: f.path })}</b><span className="mut">{errText(tr, f.err)}</span>
          <button type="button" className="btn sm" onClick={p.onRetry}><Icon n="refresh" s={13} />{tr('code.retry')}</button></div>
          : r.kind === 'image' ? <div className="cimg"><img className={/\.svg$/i.test(f.path) ? 'vec' : undefined} src={r.dataUrl} alt={f.path} onLoad={e => setDims(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)} /></div>
          : r.kind === 'binary' ? <div className="cemp"><Icon n="binary" s={28} /><span>{tr('code.binary', { size: fmtBytes(r.size, tr) })}</span>
            <button type="button" className="btn sm" onClick={() => p.onVscode(f.path)}><Icon n="extLink" s={13} />{tr('code.vscode.tip')}</button></div>
          : md && f.md === 'read' ? <DocView text={r.text ?? ''} path={f.path} resolveLink={p.resolveLink} loadImage={p.loadImage} openInCode={p.openInCode} openExternal={openExternal} narrow={p.narrow} />
          : doc ? <CmHost doc={doc} keep={p.keep} onChange={p.ed.onChange} /> : null}
      </div>
      <ViewerFoot f={f} lock={p.lock} lockShown={lockShown} offline={p.offline} onAsk={p.ed.onAsk} />
    </div>
  );
}
