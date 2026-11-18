// F13 starting screen and F10 disconnected banner (spec §6.13, §6.10, U11).
import type { ReactElement } from 'react';
import type { Snapshot } from '../../../shared/protocol.ts';
import type { Conn } from '../lib/store.ts';
import { fmtHm } from '../lib/format.ts';
import { useT } from '../lib/i18n.tsx';
import { Icon } from './icons.tsx';

const LATE_MS = 30_000;

export function Boot({ snap, conn }: { snap: Snapshot | null; conn: Conn }): ReactElement {
  const tr = useT();
  const step = (done: boolean, now: boolean, label: string, note: string) => (
    <div>{done ? <Icon n="check" /> : now ? <span className="spin" /> : <span style={{ width: 16 }} />}<span>{label}</span><small>{note}</small></div>
  );
  const lanes = snap?.lanes.length ?? 0;
  const names = snap?.projects.map(p => p.name).join(', ') ?? '';
  return (
    <div id="screen"><div className="boot"><span className="logo big" /><h1>CC-SLAVES</h1><div className="progress"><i style={{ width: snap ? '72%' : '24%' }} /></div>
      <div className="steps">
        {step(!!snap, !snap, tr('screens.deps'), snap ? '' : conn.attempt ? tr('screens.connTry', { n: conn.attempt }) : tr('screens.conn'))}
        {step(!!snap, false, tr('screens.accounts'), snap ? tr('screens.nAcc', { n: snap.accounts.length }) : '')}
        {step(false, !!snap, tr('screens.resume'), snap ? `${names}${names ? ' · ' : ''}${tr('screens.nLanes', { n: lanes })}` : '')}
      </div></div></div>
  );
}

export const connLate = (conn: Conn, now: number): boolean => conn.since !== null && now - conn.since >= LATE_MS;
/** v2.1 N4-d: while the deck is on screen its strip "Mất kết nối · số liệu lúc HH:MM" is the only reconnect message, so
 *  the v1 banner shows only without the deck (F9 list, no project) — or once late, for the restart action (v1 F10). */
export const bannerShown = (o: { offline: boolean; listOn: boolean; projectId: string | null; late: boolean }): boolean =>
  o.offline && (o.listOn || !o.projectId || o.late);

/** F10 / U11. Without the deck: the v1 text. With the deck (late only): the restart action without the time (the strip
 *  has it) — never the same text twice. */
export function Banner({ conn, dataAt, now, onRestart, deckShown = false }: { conn: Conn; dataAt: number | null; now: number; onRestart: () => void; deckShown?: boolean }): ReactElement {
  const tr = useT();
  const at = dataAt ? fmtHm(dataAt) : '—';
  const late = connLate(conn, now);
  return (
    <div id="banner" role="status">
      {late ? <><Icon n="alert" /> {tr('screens.late')}{deckShown ? '.' : ` ${tr('screens.lateAt', { at })}`}
        <button className="btn sm" onClick={onRestart}>{tr('screens.restart')}</button></>
        : <><span className="spin" /> {tr('screens.lost', { n: conn.attempt })} <span style={{ fontWeight: 400 }}>{tr('screens.lostNote', { at })}</span></>}
    </div>
  );
}
