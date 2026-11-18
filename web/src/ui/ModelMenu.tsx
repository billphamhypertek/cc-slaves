// v2.4 §4.2 / §4.5 the model / effort picker of Điều phối and of a lane (MD2–MD9, MD13, LM2) and §4.4 the Model · Effort row of the session dialogs
// (MD10–MD11). Lazy chunk: the chip (Inspector) loads it on the first open. Pure rules: lib/model.ts.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { extendCatalog } from '../../../shared/i18n/core.ts';
import enModelMenu from '../../../shared/i18n/en/modelMenu.json';
import viModelMenu from '../../../shared/i18n/vi/modelMenu.json';
import type { Command, SessionModels, SetModelResult } from '../../../shared/protocol.ts';
import { useT, type Tr } from '../lib/i18n.tsx';
import type { MenuPlace, ModelSubject } from '../lib/model.ts';
import { cacheDirty, EFFORTS, effortRow, impactLine, mismatchPick, modelRows, pickModel, rowMark, setModelError, type ModelRow, type Who } from '../lib/model-menu.ts';
import { bootWaitText } from '../lib/boot-wait.ts';
import type { Prior } from '../lib/start.ts';
import { Icon } from './icons.tsx';
import './model.css';

// §6A the `modelMenu` namespace ships with this chunk only (§10.3 first paint; also in lazy.ts LAZY_NS for engine / tests)
extendCatalog('vi', { modelMenu: viModelMenu });
extendCatalog('en', { modelMenu: enModelMenu });

/** §10.3 the list comes back ≤ 5 s or the picker says it could not read it (MD8b / MD10c). */
const LIST_WAIT_MS = 5000;
const FAILED: SessionModels = { models: [], defaultModel: null, defaultModelName: null, unavailable: true };
/** §10.3 "≤ 300 ms khi đã nhớ": the last list per session / account shows at once while it is read again. */
const cache = new Map<string, SessionModels>();

/** the list for one key (session or dialog account); `retry` reads it again. */
export function useModelList(key: string, load: () => Promise<unknown>): { models: SessionModels | null; loading: boolean; retry: () => void } {
  const [models, setModels] = useState<SessionModels | null>(cache.get(key) ?? null);
  const [loading, setLoading] = useState(true), [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true); setModels(cache.get(key) ?? null);
    const timer = setTimeout(() => { if (live) { live = false; setLoading(false); setModels(m => m ?? FAILED); } }, LIST_WAIT_MS);
    load().then(r => {
      if (!live) return;
      const m = r as SessionModels;
      if (!m.unavailable) cache.set(key, m);
      setModels(m); setLoading(false); clearTimeout(timer); live = false;
    }, () => { if (live) { setModels(m => m ?? FAILED); setLoading(false); clearTimeout(timer); live = false; } });
    return () => { live = false; clearTimeout(timer); };
  }, [key, n]); // eslint-disable-line react-hooks/exhaustive-deps
  return { models, loading, retry: () => setN(x => x + 1) };
}

/** §5 G2c while a command waits for a session still `starting`: "Đang chờ phiên khởi động…", past 30 s "Claude chưa trả lời
 *  sau 30 giây — vẫn đang chờ" (1 s tick only while it waits); null = not waiting. */
export function useBootWait(on: boolean): string | null {
  const tr = useT();
  const [since, setSince] = useState<number | null>(null), [now, setNow] = useState(0);
  useEffect(() => {
    if (!on) { setSince(null); return; }
    const t0 = Date.now();
    setSince(t0); setNow(t0);
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, [on]);
  return on ? bootWaitText(tr, since ?? 0, since === null ? 0 : now) : null;
}

const keyOf = (v: string | null) => v ?? '';
const MARK: Record<'pending' | 'pick' | 'running', ReactElement> = {
  pending: <Icon n="clock" s={12} />, pick: <Icon n="check" s={12} />, running: <i className="adot" />,
};

/** rows when the list is missing (MD8 / MD8b): "Theo mặc định" and the running model (the pick, else what runs) stay. */
function fallbackRows(tr: Tr, o: ModelSubject): ModelRow[] {
  const def: ModelRow = { value: null, label: tr('model.byDefault'), code: '', name: o.modelPick ? '' : o.modelName ?? '', resolved: o.modelPick ? null : o.model ?? null };
  const run = o.modelPick ?? o.model;
  return run ? [def, { value: run, label: o.modelName ?? run, code: o.model ?? '', resolved: o.model ?? null }] : [def];
}

export interface MenuBodyProps {
  o: ModelSubject; name: string; models: SessionModels | null; loading: boolean;
  /** §4.5 Điều phối or a lane (default row source, impact wording); default Điều phối */
  who?: Who;
  /** the row / level waiting for Claude Code (`''` = "Theo mặc định", `effort:<level>`), MD2b */
  busy: string | null; err: string | null; olderOpen: boolean; lastModel: boolean;
  /** MD13 read only with this reason (offline) */
  ro: string | null; account: string;
  /** §5 G2c the change waits for the session to boot (`useBootWait`) */
  wait?: string | null;
  onModel: (v: string | null) => void; onEffort: (level: string) => void; onOlder: () => void; onCancel: () => void; onRetry: () => void;
}

/** §4.2 MD8b / §4.4 MD10c / §4.5 LM3 "Chưa lấy được danh sách model" + "Thử lại". */
export function ListFail({ ro, onRetry }: { ro: boolean; onRetry: () => void }): ReactElement {
  const tr = useT();
  return <div className="mfail"><Icon n="bang" s={12} /><span>{tr('modelMenu.listFail')}</span>
    <button type="button" className="btn sm" disabled={ro || undefined} onClick={onRetry}><Icon n="refresh" s={12} />{tr('modelMenu.retry')}</button></div>;
}

/** §4.2 the picker body (static: state comes from props). */
export function MenuBody(p: MenuBodyProps): ReactElement {
  const tr = useT();
  const { o } = p, who = p.who ?? 'orch';
  const list = p.models && !p.models.unavailable ? modelRows(tr, p.models, who) : null;
  const top = list ? list.top : fallbackRows(tr, o), older = list?.older ?? [];
  const lock = p.busy !== null || !!p.ro;
  const olderShown = p.olderOpen || older.some(r => r.resolved === o.model || r.value === o.modelPick || (o.pending?.model !== undefined && r.value === o.pending.model));
  const row = (r: ModelRow) => {
    const mark = rowMark(o, r), k = keyOf(r.value), busy = p.busy === k;
    return <button type="button" key={k} className={['mrow', mark, busy ? 'busy' : null].filter(Boolean).join(' ')} disabled={(lock && !busy) || undefined}
      aria-pressed={mark === 'pick'} onClick={() => p.onModel(r.value)}>
      <span className="mk">{busy ? <span className="spin" /> : mark ? MARK[mark] : null}</span>
      <b>{r.label}</b><span className="mx">{r.name ? <span className="mn">{r.name}</span> : null}<code>{r.code}</code></span></button>;
  };
  const e = effortRow(tr, o, p.models);
  const imp = impactLine(tr, o, p.name, p.lastModel, who);
  return (
    <>
      <div className="mh3">{tr('modelMenu.title', { name: p.name })}</div>
      <div className="mlist">
        {top.map(row)}
        {p.loading && !list ? <div className="mskel"><i /><i /><i /></div> : null}
        {older.length ? <button type="button" className="mrow grp" disabled={lock || undefined} aria-expanded={olderShown} onClick={p.onOlder}>
          <span className="mk" /><b>{tr('modelMenu.older', { n: older.length })}</b><i className="car" aria-hidden="true">{olderShown ? '▾' : '▸'}</i></button> : null}
        {olderShown ? older.map(row) : null}
      </div>
      {!p.loading && p.models?.unavailable ? <ListFail ro={!!p.ro} onRetry={p.onRetry} /> : null}
      <div className="meff">
        <span className="ml">{tr('modelMenu.effort')}</span>
        <div className="mseg">{e.levels.map(l => <button type="button" key={l.level}
          className={['lv', l.level === e.lit ? 'lit' : null, l.level === e.pending ? 'pending' : null, p.busy === `effort:${l.level}` ? 'busy' : null].filter(Boolean).join(' ')}
          disabled={!l.on || lock || undefined} onClick={() => p.onEffort(l.level)}>{l.level === e.pending ? <Icon n="clock" s={12} /> : null}{l.level}</button>)}</div>
      </div>
      {e.note ? <div className="mnote">{e.note}</div> : null}
      {p.wait ? <div className="mwait" role="status"><span className="spin sm" aria-hidden="true" /><span>{p.wait}</span></div> : null}
      {p.err ? <div className="merr" role="alert"><Icon n="bang" s={12} /><span>{p.err}</span></div> : null}
      {o.modelMismatch ? <div className="mmis"><i className="adot" /><span>{tr('modelMenu.mismatch', { account: p.account, pick: mismatchPick(tr, o, p.models, who), run: o.modelName ?? o.model ?? '' })}</span></div> : null}
      {p.ro ? <div className="mro"><Icon n="wifi" s={12} /><span>{p.ro}</span></div> : null}{/* MD13 the reason in the impact line's place */}
      {imp && !p.ro ? <div className="mimp"><span>{imp.text}</span>{imp.cancel ? <button type="button" className="btn sm" disabled={!!p.ro} onClick={p.onCancel}>{tr('modelMenu.cancelPending')}</button> : null}</div> : null}
    </>
  );
}

/** §4.2 / §4.5 whose picker and the engine commands it ends in. */
export type MenuOf = { kind: 'orch'; projectId: string; sessionId: string } | { kind: 'lane'; projectId: string; name: string };

/** the list / change / cancel commands of one picker (`session_*` for Điều phối, `lane_*` + `session_models {lane}`, §5.6). */
export function menuCmds(of: MenuOf): { key: string; list: Command; set: (c: { model?: string | null; effort?: string }) => Command; cancel: Command } {
  const pid = of.projectId;
  if (of.kind === 'orch') {
    const sessionId = of.sessionId;
    return { key: `s:${sessionId}`, list: { cmd: 'session_models', projectId: pid, sessionId }, set: c => ({ cmd: 'session_set_model', sessionId, ...c }),
      cancel: { cmd: 'session_model_cancel', sessionId } };
  }
  const name = of.name;
  return { key: `l:${pid}:${name}`, list: { cmd: 'session_models', projectId: pid, lane: name }, set: c => ({ cmd: 'lane_set_model', projectId: pid, name, ...c }),
    cancel: { cmd: 'lane_model_cancel', projectId: pid, name } };
}

export interface ModelMenuProps {
  o: ModelSubject; of: MenuOf; name: string; account: string; ro: string | null;
  /** where it hangs in the window (lib/model.ts `menuPlace`). */
  place: MenuPlace;
  send: (c: Command) => Promise<unknown>; onClose: () => void;
  /** an answer that comes back after the picker closed */
  onToast: (text: string) => void;
}

/** §4.2 the picker: anchored under the chip; Esc / a click outside closes it; each click applies at once. */
export default function ModelMenu(p: ModelMenuProps): ReactElement {
  const tr = useT();
  const cmds = menuCmds(p.of), who: Who = p.of.kind;
  const { models, loading, retry } = useModelList(cmds.key, () => p.send(cmds.list));
  const [busy, setBusy] = useState<string | null>(null), [err, setErr] = useState<string | null>(null);
  const [olderOpen, setOlderOpen] = useState(false), [lastModel, setLastModel] = useState(false);
  const box = useRef<HTMLDivElement>(null), open = useRef(true);
  const wait = useBootWait(busy !== null && p.o.state === 'starting');
  useEffect(() => {
    open.current = true;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); p.onClose(); } };
    const down = (e: MouseEvent) => { const t = e.target as Element | null; if (box.current && t && !box.current.contains(t) && !t.closest('.mchip')) p.onClose(); };
    window.addEventListener('keydown', key, true); document.addEventListener('mousedown', down);
    return () => { open.current = false; window.removeEventListener('keydown', key, true); document.removeEventListener('mousedown', down); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // MD3 / MD5 the opened group's head (opened by a click, or at once when it holds the model in use) goes to the top of the
  // list and sticks there
  useEffect(() => { box.current?.querySelector('.mrow.grp[aria-expanded=true]')?.scrollIntoView({ block: 'start' }); }, [olderOpen, models]);
  useEffect(() => { if (p.o.state === 'running') setLastModel(d => cacheDirty(d, 'turn')); }, [p.o.state]); // m4 a turn reads the new model's cache
  const fail = (text: string) => (open.current ? setErr(text) : p.onToast(text));
  const set = (c: { model?: string | null; effort?: string }, k: string, label: string) => {
    setBusy(k); setErr(null);
    p.send(cmds.set(c)).then(r => {
      setBusy(null);
      if ((r as SetModelResult | null)?.applied === 'unsupported') fail(setModelError(tr, 'unsupported', label));
      else setLastModel(d => cacheDirty(d, c.model !== undefined ? 'model' : 'effort'));
    }, (e: unknown) => { setBusy(null); fail(setModelError(tr, (e as { code?: string }).code ?? 'timeout', label)); });
  };
  const o = p.o;
  const onModel = (v: string | null) => {
    if (o.pending?.model === undefined && (o.modelPick ?? null) === v) return; // the current pick: nothing
    const id = models?.models.find(m => m.value === (v ?? models.defaultModel))?.resolvedModel; // MD6 names the full id
    set({ model: v }, keyOf(v), id ?? v ?? tr('model.byDefault'));
  };
  const onEffort = (level: string) => {
    if (o.pending?.effort === undefined && o.effortPick === level) return;
    set({ effort: level }, `effort:${level}`, level);
  };
  const cancel = () => { void p.send(cmds.cancel).catch((e: unknown) => fail(setModelError(tr, (e as { code?: string }).code ?? 'timeout', ''))); };
  const { left, width, top, bottom, maxH } = p.place;
  // fixed in the window (portal): the Inspector clips its children; only a room under one model row flips it above the chip
  return createPortal(
    <div ref={box} className="mdmenu glass" role="dialog" aria-label={tr('modelMenu.title', { name: p.name })} style={{ left, width, top, bottom, maxHeight: maxH }}>
      <MenuBody o={o} who={who} name={p.name} models={models} loading={loading} busy={busy} err={err} wait={wait} olderOpen={olderOpen} lastModel={lastModel} ro={p.ro} account={p.account}
        onModel={onModel} onEffort={onEffort} onOlder={() => setOlderOpen(x => !x)} onCancel={cancel} onRetry={retry} />
    </div>, document.body);
}

export interface ModelPickProps {
  models: SessionModels | null; loading: boolean; model: string | null; effort: string | null;
  /** one change = model + effort together (two calls would each spread the same old value, IMPORTANT-1). */
  onChange: (v: { model: string | null; effort: string | null }) => void; onRetry: () => void;
  /** v2.7.1 §4.2 SA6b IS17 "Nhận phiên cũ": no pick = the old session's model / effort ("Như phiên cũ (<giá trị>)") */
  asBefore?: Prior;
}

/** §4.4 MD10 / MD10b / MD10c / MD11 the session dialog row: "Model" (same list + older group as §4.2) and "Effort". */
export function ModelPick(p: ModelPickProps): ReactElement {
  const tr = useT();
  // the list hangs under the field in the window (portal, fixed): the dialog clips its children (mockup MD10b overlaps its foot)
  const [open, setOpen] = useState<{ left: number; top: number; width: number } | null>(null), [olderOpen, setOlderOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!(e.target as Element | null)?.closest('.mpop, .mpick')) setOpen(null); };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [open]);
  const m = p.models && !p.models.unavailable ? p.models : null;
  const list = m ? modelRows(tr, m) : null;
  const info = m?.models.find(x => x.value === (p.model ?? m.defaultModel ?? 'default'));
  const defName = m?.defaultModelName ?? info?.displayName ?? null;
  const before = (v: string | null) => (v ? tr('session.stAsBeforeVal', { v }) : tr('session.stAsBefore'));
  // the transcript holds the resolved id ("claude-opus-5-5"): the list's own row for it, never the "default" alias that resolves there too
  const prev = p.asBefore?.model ?? null;
  const prevName = prev ? (m?.models.find(x => x.value === prev) ?? m?.models.find(x => x.value !== 'default' && x.resolvedModel === prev))?.displayName ?? prev : null;
  const asBefore = p.asBefore ? before(prevName) : null, effBefore = p.asBefore ? before(p.asBefore.effort) : null;
  const label = p.model === null ? asBefore ?? (defName ? tr('modelMenu.byDefaultName', { name: defName }) : tr('model.byDefault'))
    : m?.models.find(x => x.value === p.model)?.displayName ?? p.model;
  // v2.7.1 SA1 / SA5: "Theo mặc định (medium)" = the account's default effort; "◌ Đang tải danh sách model…" while it is read
  const defEffort = m?.defaultEffort ?? m?.claudeEffort ?? null;
  const reading = p.loading && !m;
  const levels = info ? info.effortLevels : p.effort ? [p.effort] : [];
  const pick = (v: string | null) => { p.onChange(pickModel(m, { model: p.model, effort: p.effort }, v)); setOpen(null); };
  const row = (r: ModelRow) => <button type="button" key={keyOf(r.value)} role="option" aria-selected={r.value === p.model} className={`mrow${r.value === p.model ? ' pick' : ''}`} onClick={() => pick(r.value)}>
    <span className="mk">{r.value === p.model ? <Icon n="check" s={12} /> : null}</span><b>{r.label}</b><span className="mx">{r.name ? <span className="mn">{r.name}</span> : null}<code>{r.code}</code></span></button>;
  const older = list?.older ?? [], olderShown = olderOpen || older.some(r => r.value === p.model);
  return (
    <div className="mpicks">
      <div className="sfield"><span>{tr('modelMenu.model')}</span>
        <button type="button" className="field mpick" aria-haspopup="listbox" aria-expanded={!!open} onClick={e => {
          const r = e.currentTarget.closest('.mpicks')!.getBoundingClientRect(), b = e.currentTarget.getBoundingClientRect();
          setOpen(o => (o ? null : { left: r.left, top: b.bottom + 4, width: r.width }));
        }}>
          {reading ? <span><span className="spin sm" aria-hidden="true" />{tr('modelMenu.loadingList')}</span> : <span>{label}</span>}<Icon n="chev" s={14} /></button>
        {open ? createPortal(<div className="mpop glass mlist" role="listbox" style={open}>
          {p.loading && !list ? <div className="mskel"><i /><i /><i /></div> : null}
          {(list?.top ?? [{ value: null, label: tr('model.byDefault'), code: '', resolved: null }, ...(p.model ? [{ value: p.model, label: p.model, code: '', resolved: null }] : [])]).map(row)}
          {older.length ? <button type="button" className="mrow grp" aria-expanded={olderShown} onClick={() => setOlderOpen(x => !x)}>
            <span className="mk" /><b>{tr('modelMenu.older', { n: older.length })}</b><i className="car" aria-hidden="true">{olderShown ? '▾' : '▸'}</i></button> : null}
          {olderShown ? older.map(row) : null}
        </div>, document.body) : null}
      </div>
      <label className="sfield"><span>{tr('modelMenu.effort')}</span>
        <select className="field" value={p.effort ?? ''} onChange={e => p.onChange({ model: p.model, effort: e.target.value || null })}>
          <option value="">{effBefore ?? (defEffort ? tr('modelMenu.byDefaultName', { name: defEffort }) : tr('model.byDefault'))}</option>
          {EFFORTS.filter(l => levels.includes(l)).map(l => <option key={l} value={l}>{l}</option>)}
        </select></label>
      {!p.loading && p.models?.unavailable ? <ListFail ro={false} onRetry={p.onRetry} /> : null}
    </div>
  );
}
