// spec v2.3 §5.3 / §5.4 the dialogs over the Code view: C23 / C27 "Bỏ thay đổi chưa lưu?" (Huỷ / Esc: "Sửa tiếp" ·
// "Bỏ thay đổi" · "Lưu"; closing a tab: "Huỷ" · "Bỏ" · "Lưu"), C7 the save conflict (960 px, "Trên đĩa (mới)" | "Của anh",
// lines wrap, changed lines tinted on both sides, the differing part underlined; no automatic merge) and C22 the file
// deleted on disk ("Tạo lại bằng bản của anh" · "Bỏ" · "Huỷ").
import { useMemo, type ReactElement } from 'react';
import { useT } from '../lib/i18n.tsx';
import { fmtHm } from '../lib/format.ts';
import { Icon } from '../ui/icons.tsx';
import type { Dlg, DlgChoice } from './code-tabs.ts';
import { conflictView, type CfRow } from './edit.ts';

export interface CodeDialogProps {
  dlg: Dlg;
  /** "thư mục project" / "worktree D15" */
  src: string;
  /** who ran in the dir while editing (C7 subtitle), already worded */
  by: string | null;
  onChoose: (c: DlgChoice) => void;
}

function Col({ title, rows }: { title: string; rows: CfRow[] }): ReactElement {
  return (
    <div className="cfc">
      <div className="sh3">{title}</div>
      <div className="cfl">
        {rows.map((r, i) => ('gap' in r ? <div key={i} className="cfg">⋯</div> : (
          <div key={i} className={`cfr${r.chg ? ' chg' : ''}`}>
            <span className="no">{r.no}</span>
            <span className="tx">{r.u ? <>{r.text.slice(0, r.u[0])}<u>{r.text.slice(...r.u)}</u>{r.text.slice(r.u[1])}</> : r.text || ' '}</span>
          </div>)))}
      </div>
    </div>
  );
}

export function CodeDialog({ dlg, src, by, onChoose }: CodeDialogProps): ReactElement {
  const tr = useT();
  const cf = useMemo(() => (dlg.k === 'conflict' ? conflictView(dlg.disk.text ?? '', dlg.mine) : null), [dlg]);
  const btn = (c: DlgChoice, label: string, cls = '') => <button type="button" className={`btn sm${cls}`} onClick={() => onChoose(c)}>{label}</button>;
  const saveBtn = <button type="button" className="btn sm pri" onClick={() => onChoose('save')}>{tr('code.save')} <kbd>⌘S</kbd></button>;
  let body: ReactElement;
  if (dlg.k === 'dirty') {
    body = (
      <div className="cdlg" role="alertdialog" aria-modal="true" aria-labelledby="cdlg-h" style={{ width: 480 }}>
        <h3 id="cdlg-h"><Icon n="pencil" s={16} />{tr('code.dirty.title')}</h3>
        <div className="bd">{tr(dlg.why === 'cancel' ? 'code.dirty.cancel' : 'code.dirty.close', { path: dlg.path, n: dlg.lines })}</div>
        <div className="ft">
          {btn('keep', tr(dlg.why === 'cancel' ? 'code.dirty.keep' : 'code.cancel'))}
          {btn('discard', tr(dlg.why === 'cancel' ? 'code.dirty.discard' : 'code.dirty.drop'), ' bad')}
          {saveBtn}
        </div>
      </div>);
  } else if (dlg.k === 'conflict' && cf) {
    const ls = cf.changed.slice(0, 6).map(String);
    const lines = ls.length > 1 ? `${ls.slice(0, -1).join(', ')} ${tr('code.cf.and')} ${ls.at(-1)}` : ls[0] ?? '';
    body = (
      <div className="cdlg" role="alertdialog" aria-modal="true" aria-labelledby="cdlg-h" style={{ width: 960 }}>
        <h3 id="cdlg-h"><Icon n="alert" s={16} />{tr('code.cf.title')}</h3>
        <div className="sb">{dlg.path} · {tr('code.cf.sub', { src, time: fmtHm(dlg.at) })}{by ? ` ${tr('code.cf.by', { who: by })}` : ''}</div>
        <div className="cf2"><Col title={tr('code.cf.disk')} rows={cf.disk} /><Col title={tr('code.cf.mine')} rows={cf.mine} /></div>
        <div className="ft">
          <span className="ml">{lines ? tr('code.cf.lines', { lines }) : null}</span>
          {btn('keep', tr('code.cf.keep'))}{btn('takeDisk', tr('code.cf.takeDisk'))}{btn('overwrite', tr('code.cf.overwrite'), ' bad')}
        </div>
      </div>);
  } else {
    body = (
      <div className="cdlg" role="alertdialog" aria-modal="true" aria-labelledby="cdlg-h" style={{ width: 520 }}>
        <h3 id="cdlg-h"><Icon n="fileX" s={16} />{tr('code.gone.title')}</h3>
        <div className="sb">{dlg.path} · {tr('code.gone.sub', { src, time: fmtHm(dlg.k === 'gone' ? dlg.at : 0) })}</div>
        <div className="bd">{tr('code.gone.body')}</div>
        <div className="ft">{btn('keep', tr('code.cf.keep'))}{btn('discard', tr('code.dirty.drop'), ' bad')}{btn('recreate', tr('code.gone.recreate'), ' pri')}</div>
      </div>);
  }
  return <div className="cdlgw"><div className="cscrim" onClick={() => onChoose('keep')} />{body}</div>;
}
