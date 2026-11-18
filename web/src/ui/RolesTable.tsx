// Roles & caps table shared by F1d (wizard) and F12 "Account & ngưỡng" (spec §6.1 step 4, §6.12). Same controls as A5
// (segmented Vai trò, Mềm / Cứng; G4 UX M2). One account = Điều phối + lane: its lane cap stays real (v2 §6, UX I1).
// D26: with more accounts the Điều phối row's max lanes is editable too (default 0 = it takes no lanes).
import type { CSSProperties, ReactElement } from 'react';
import type { AccountView, Role } from '../../../shared/protocol.ts';
import { fmtLeft } from '../lib/format.ts';
import { useT } from '../lib/i18n.tsx';
import { accountColor, ROLE_KEY } from '../lib/labels.ts';
import { soloAccount, withRole, type RoleRow } from '../lib/wizard.ts';

export interface RolesTableProps {
  rows: RoleRow[];
  accounts: AccountView[];
  /** F12: show current % and data age, mark changed fields */
  current?: { now: number; base: RoleRow[] };
  onChange: (rows: RoleRow[]) => void;
}

const ROLES: Role[] = ['primary', 'backup', 'orchestrator'];

export function RolesTable({ rows, accounts, current, onChange }: RolesTableProps): ReactElement {
  const set = (i: number, patch: Partial<RoleRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const ch = (i: number, k: keyof RoleRow) => (current && current.base[i] && current.base[i][k] !== rows[i]![k] ? 'changed' : '');
  const solo = soloAccount(rows);
  // D103 (review-b MINOR-1) Ultra has no 5-hour window: no cap field on its row, no "5h" column unless some row is Max
  const hasFive = (email: string) => accounts.find(x => x.email === email)?.fiveWindow !== false;
  const fiveCol = rows.some(r => hasFive(r.email));
  const tr = useT();
  return (<>
    <div className="tw-wrap"><table className="t">
      <thead><tr><th>{tr('roles.th.account')}</th><th>{tr('roles.th.role')}</th><th>{tr('roles.th.week')}</th>{fiveCol ? <th>{tr('roles.th.five')}</th> : null}<th>{tr('roles.th.maxLanes')}</th>{current ? <><th>{tr('roles.th.now')}</th><th>{tr('roles.th.age')}</th></> : null}</tr></thead>
      <tbody>{rows.map((r, i) => {
        const a = accounts.find(x => x.email === r.email);
        const full = a ? (r.hard ? (a.weekPct ?? 0) >= r.week - 1 : (a.weekPct ?? 0) >= r.week) : false;
        return (
          <tr key={r.email}>
            <td className="wr"><i className="dot" style={{ '--c': accountColor(accounts, r.email) } as CSSProperties} /> {r.email}</td>
            <td><div className={`seg ${ch(i, 'role')}`} role="radiogroup" aria-label={tr('roles.aria.role', { email: r.email })}>{ROLES.map(k =>
              <button key={k} type="button" role="radio" aria-checked={r.role === k} className={r.role === k ? 'on' : ''} onClick={() => onChange(rows.map((x, j) => (j === i ? withRole(x, k, solo) : x)))}>{tr(ROLE_KEY[k])}</button>)}</div></td>
            <td><span className="row" style={{ gap: 'var(--s2)', flexWrap: 'nowrap' }}>
              <input type="number" min={1} max={100} style={{ width: 52 }} aria-label={tr('roles.aria.week', { email: r.email })} className={ch(i, 'week')} value={r.week} onChange={e => set(i, { week: Number(e.target.value) })} />
              <span className={`seg ${ch(i, 'hard')}`} role="radiogroup" aria-label={tr('roles.aria.kind', { email: r.email })}>
                <button type="button" role="radio" aria-checked={!r.hard} className={!r.hard ? 'on' : ''} onClick={() => set(i, { hard: false })}>{tr('roles.soft')}</button>
                <button type="button" role="radio" aria-checked={r.hard} className={r.hard ? 'on' : ''} onClick={() => set(i, { hard: true })}>{tr('roles.hard')}</button></span></span></td>
            {!fiveCol ? null : hasFive(r.email) ? <td><input type="text" style={{ width: 46 }} aria-label={tr('roles.aria.five', { email: r.email })} placeholder="—" className={ch(i, 'five')} value={r.five} onChange={e => set(i, { five: e.target.value })} /></td> : <td />}
            <td><input type="number" min={0} max={16} style={{ width: 52 }} aria-label={tr('roles.aria.max', { email: r.email })} className={ch(i, 'maxLanes')} value={r.maxLanes} onChange={e => set(i, { maxLanes: Number(e.target.value) })} /></td>
            {current ? <>
              <td className="mono num" style={full ? { color: 'var(--bad)' } : undefined}>{!a ? '—' : a.fiveWindow ? tr('roles.usage', { week: a.weekPct ?? '?', five: a.fivePct ?? '?' }) : tr('roles.usageWeek', { week: a.weekPct ?? '?' })}</td>
              <td className="num">{a?.fetchedAt ? fmtLeft(current.now - a.fetchedAt, tr) : tr('roles.noData')}</td>
            </> : null}
          </tr>
        );
      })}</tbody>
    </table></div>
    {solo && rows[0]!.role === 'orchestrator' ? <p className="foot" style={{ margin: 0 }}>{tr('roles.solo')}</p>
      : rows.some(r => r.role === 'orchestrator') ? <p className="foot" style={{ margin: 0 }}>{tr('roles.orchLanesHint')}</p> : null}
  </>);
}
