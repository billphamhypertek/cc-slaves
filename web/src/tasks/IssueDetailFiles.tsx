// v2.7 §4.3 (review MINOR-2) the detail's "Ảnh đính kèm": an image (by its name) loads once through `issue_file` (Mac only,
// engine-checked path) as a 200 × 112 thumbnail as the mockup `.thumb`; a click opens it whole in a dialog over the app
// (scaled to fit, Esc / click / × closes). Any other file stays a name · size line.
import { useEffect, useState, type ReactElement } from 'react';
import type { IssueFileData, IssueInfo } from '../../../shared/issues.ts';
import { useT } from '../lib/i18n.tsx';
import type { IssueCmds } from '../lib/issues.ts';
import { Icon } from '../ui/icons.tsx';

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
/** A loaded thumbnail: its data URL, or null = the engine refused / failed (undefined in the map = still loading). */
type Shot = string | null;
const kb = (size: number) => `${Math.max(1, Math.round(size / 1024))} KB`;

/** The files `issue_file` can show (the engine refuses the rest). */
/** rereview-d NEW-D1: an ack without data shows the "cannot load" state for that one thumbnail, never a render-time throw. */
export const shotOf = (r: IssueFileData | undefined): Shot => (typeof r?.dataUrl === 'string' ? r.dataUrl : null);

export const imageFiles = (files: IssueInfo['files']) => files.filter(f => IMAGE.test(f.name));

export function IssueFiles({ cmds, issue: i }: { cmds: Pick<IssueCmds, 'file'>; issue: IssueInfo }): ReactElement {
  const tr = useT();
  const [shots, setShots] = useState<Record<number, Shot>>({});
  const [full, setFull] = useState<{ name: string; url: string } | null>(null);
  const ids = imageFiles(i.files).map(f => f.id).join(',');
  useEffect(() => {
    let live = true;
    setShots({});
    for (const f of imageFiles(i.files)) {
      cmds.file(i.key, f.id).then(r => { const u = shotOf(r); if (live) setShots(s => ({ ...s, [f.id]: u })); },
        () => { if (live) setShots(s => ({ ...s, [f.id]: null })); });
    }
    return () => { live = false; };
  }, [i.key, ids]); // eslint-disable-line react-hooks/exhaustive-deps -- reload only when the issue or its image set changes
  useEffect(() => {
    if (!full) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setFull(null); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [full]);

  return (
    <>
      <ul className="dfiles">{i.files.map(f => {
        const shot = IMAGE.test(f.name) ? shots[f.id] : undefined;
        return (
          <li key={f.id}>
            <span className="fln"><Icon n="image" s={13} />{f.name}<small>{kb(f.size)}</small></span>
            {IMAGE.test(f.name) ? (
              <button type="button" className="dthumb" disabled={!shot} aria-label={tr('tasks.detail.fileOpen', { name: f.name })}
                onClick={() => { if (shot) setFull({ name: f.name, url: shot }); }}>
                {shot ? <img src={shot} alt="" /> : shot === null ? <small>{tr('tasks.detail.fileErr')}</small> : null}
              </button>
            ) : null}
          </li>
        );
      })}</ul>
      {full ? (
        <div className="dimgv" role="dialog" aria-modal="true" aria-label={full.name} onClick={() => setFull(null)}>
          <button type="button" className="dclose" autoFocus aria-label={tr('tasks.detail.fileClose')} onClick={() => setFull(null)}><Icon n="x" s={14} /></button>
          <img src={full.url} alt={full.name} />
        </div>
      ) : null}
    </>
  );
}
