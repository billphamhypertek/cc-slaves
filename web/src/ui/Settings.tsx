// F12 settings (⌘,) — spec §6.12, U9: fixed-height box, tab strip never jumps, no Save on instant tabs.
import { lazy, Suspense, useEffect, useMemo, useState, type ReactElement } from 'react';
import type { Command, ProjectView, SessionsList, Snapshot } from '../../../shared/protocol.ts';
import { capsPreview, previewText } from '../lib/caps.ts';
import { fmtHm } from '../lib/format.ts';
import { cleanupLine, gitRecheck, INSTANT_TABS, NOTIFY_CHANNELS, NOTIFY_EVENTS, settingsTabs, type SettingsTab } from '../lib/settings.ts';
import { notifyMatrix, type NotifyMatrix } from '../../../shared/notify-prefs.ts';
import { hasTauri, invoke } from '../lib/tauri.ts';
import { capsPayload, defaultRoles, laneCapsPayload, orchLaneCap, roleErrors, type RoleRow } from '../lib/wizard.ts';
import { AccountsTab, type AccDlg } from './Accounts.tsx';
import { errText, useT } from '../lib/i18n.tsx';
import { LangSelect } from './Wizard.tsx';
import { Icon } from './icons.tsx';
import { RolesTable } from './RolesTable.tsx';

// v2.4 §4.5 LM3 the Model tab: lazy, with the picker chunk (its list hook and catalog)
const ModelDefaults = lazy(() => import('./ModelDefaults.tsx'));
// hf1116 (b) the Git tab: the optional Git block of the wizard's "Công cụ" step (lazy, with its catalog)
const GitSetup = lazy(() => import('./GitSetup.tsx'));
// v2.6 §4.7 the "Cập nhật" row: Mac app only (the state lives in its Rust side), loads with the update chip's chunk
const UpdateRow = lazy(() => import('./UpdateChip.tsx').then(m => ({ default: m.UpdateRow })));

export interface SettingsProps {
  snap: Snapshot;
  /** the selected project: v2.4 §4.5 LM3 reads its orchestrator account's model list. */
  pid: string | null;
  tab: SettingsTab;
  connected: boolean;
  now: number;
  onTab: (t: SettingsTab) => void;
  onClose: () => void;
  send: (c: Command) => Promise<unknown>;
  /** v2.2 §6 an account's ⚠ "cấu hình chung lỗi" chip opens Skills & MCP › Thư mục chung (K12). */
  onCfg: () => void;
  onAddProject: () => void;
  onSetup: () => void;
  onAccDlg: (d: AccDlg) => void;
  /** v2.1 §4.12 an account row "⋯" → the App's account menu. */
  onAccMenu: (email: string, anchor: Element) => void;
  toast: (t: string) => void;
}

interface ProjDraft { webhook: string; send: boolean }
const cfgNum = (v: unknown, d: number) => (typeof v === 'number' ? v : d);

export function Settings(p: SettingsProps): ReactElement {
  const { snap } = p;
  const tr = useT();
  const tabs = settingsTabs(snap.channel, snap.engine.remote.enabled);
  const tab = tabs.some(t => t.id === p.tab) ? p.tab : tabs[0]!.id;
  const mac = snap.channel === 'mac';
  const maxLanesCfg = (snap.config.laneCaps ?? {}) as Record<string, number>;
  // v2 §6: an orchestrator's stored 0 is not its lane cap when it is the only account; D26: otherwise its own value (default 0)
  const baseRows = useMemo(() => defaultRoles(snap.accounts.map(a => a.email), snap.accounts).map(r => ({ ...r, maxLanes: r.role === 'orchestrator' ? orchLaneCap(maxLanesCfg[r.email], snap.accounts.length === 1) : maxLanesCfg[r.email] ?? 3 })), [snap.accounts]); // eslint-disable-line react-hooks/exhaustive-deps
  const [proj, setProj] = useState<Record<string, ProjDraft>>({});
  const [menu, setMenu] = useState<string | null>(null);
  const [rows, setRows] = useState<RoleRow[] | null>(null);
  const [keychain, setKeychain] = useState<boolean | null>(null);
  const [noti, setNoti] = useState<NotifyMatrix | null>(null);
  const [sound, setSound] = useState<boolean | null>(null);
  const [volume, setVolume] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editCaps, setEditCaps] = useState(false);
  // §4.14 the engine reads cleanupPeriodDays from the shared settings.json; `sessions_list` of any project carries it
  const [cleanup, setCleanup] = useState<number | null>(null);
  const anyProject = snap.projects[0]?.id ?? null;
  useEffect(() => {
    if (tab !== 'engine' || !anyProject) return;
    p.send({ cmd: 'sessions_list', projectId: anyProject }).then(r => setCleanup((r as SessionsList).cleanupPeriodDays ?? 30), () => {});
  }, [tab, anyProject]); // eslint-disable-line react-hooks/exhaustive-deps -- p.send is stable per connection
  useEffect(() => gitRecheck(tab, mac, p.send), [tab]); // eslint-disable-line react-hooks/exhaustive-deps -- p.send is stable per connection

  const draftOf = (pr: ProjectView): ProjDraft => proj[pr.id] ?? { webhook: '', send: pr.gchatSendCommandText };
  const setDraft = (pr: ProjectView, patch: Partial<ProjDraft>) => setProj(d => ({ ...d, [pr.id]: { ...draftOf(pr), ...patch } }));
  const accRows = rows ?? baseRows;
  const moves = capsPreview(snap.lanes, snap.accounts, accRows);
  const rowErrs = roleErrors(tr, accRows); // no PO email here (remote access moved to v3)
  const readKeychain = keychain ?? (snap.config.quotaReading !== false);
  const matrix = noti ?? notifyMatrix(snap.config.notify);
  const soundOn = sound ?? (snap.config.sound !== false);
  const vol = volume ?? cfgNum(snap.config.volume, 25);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      if (tab === 'proj') {
        for (const pr of snap.projects) {
          const d = proj[pr.id];
          if (!d) continue;
          const patch: Extract<Command, { cmd: 'project_update' }>['patch'] = {};
          if (d.send !== pr.gchatSendCommandText) patch.gchatSendCommandText = d.send;
          if (d.webhook.trim()) patch.gchatWebhook = d.webhook.trim();
          if (Object.keys(patch).length) await p.send({ cmd: 'project_update', id: pr.id, patch });
        }
      } else if (tab === 'acc') {
        if (rows) {
          await p.send({ cmd: 'caps_update', caps: capsPayload(rows) });
          await p.send({ cmd: 'config_update', patch: { laneCaps: laneCapsPayload(rows) } });
        }
        if (keychain !== null) await p.send({ cmd: 'config_update', patch: { quotaReading: keychain } });
      } else if (tab === 'noti') {
        await p.send({ cmd: 'config_update', patch: { notify: matrix, sound: soundOn, volume: vol } });
      }
      p.onClose();
    } catch (e) { setErr(errText(tr, e)); } finally { setBusy(false); }
  };

  let body: ReactElement;
  if (tab === 'proj') {
    body = <>
      <div className="tw-wrap" style={{ overflow: 'visible' }}><table className="t"><thead><tr><th>{tr('settings.proj.th.project')}</th><th>{tr('settings.proj.th.webhook')}</th><th className="wr">{tr('settings.proj.th.send')}</th><th style={{ width: 44 }} /></tr></thead>
        <tbody>{snap.projects.map(pr => {
          const d = draftOf(pr);
          return <tr key={pr.id}>
            <td className="wr"><b>{pr.name}</b><br /><small className="foot mono">{pr.path.replace(/^\/Users\/[^/]+/, '~')}</small></td>
            <td className="wr">{pr.gchatWebhookSet && !d.webhook ? <span className="pill ok"><Icon n="check" s={12} /> {tr('settings.proj.set')}</span> : null}
              <input type="text" className="field" style={{ width: 200, display: pr.gchatWebhookSet && !proj[pr.id] ? 'none' : undefined }} placeholder={tr('settings.proj.webhookPh')} aria-label={tr('settings.proj.webhookAria', { name: pr.name })} value={d.webhook} onChange={e => setDraft(pr, { webhook: e.target.value })} /></td>
            <td><input type="checkbox" aria-label={tr('settings.proj.sendAria', { name: pr.name })} checked={d.send} onChange={e => setDraft(pr, { send: e.target.checked })} /></td>
            <td style={{ position: 'relative' }}><button className="ib" aria-label={tr('settings.proj.moreAria', { name: pr.name })} aria-expanded={menu === pr.id} onClick={() => setMenu(m => (m === pr.id ? null : pr.id))}>⋯</button>
              {menu === pr.id ? <div className="rmenu glass" role="menu">
                {hasTauri() ? <button onClick={() => { setMenu(null); void invoke('open_path', { path: pr.path }); }}>{tr('settings.proj.openDir')}</button> : null}
                <button onClick={() => { setMenu(null); void p.send({ cmd: 'open_in_vscode', path: pr.path }).catch(() => {}); }}>{tr('settings.proj.vscode')}</button>
                {pr.gchatWebhookSet ? <button onClick={() => { setMenu(null); setDraft(pr, { webhook: '' }); }}>{tr('settings.proj.changeWebhook')}</button> : null}
                <button style={{ color: 'var(--bad)' }} onClick={() => { setMenu(null); if (window.confirm(tr('settings.proj.removeConfirm', { name: pr.name }))) void p.send({ cmd: 'project_remove', id: pr.id }).catch(() => {}); }}>{tr('settings.proj.remove')}</button>
              </div> : null}</td>
          </tr>;
        })}</tbody></table></div>
      <div className="row"><button className="btn" onClick={p.onAddProject}><Icon n="plus" /> {tr('settings.proj.add')}</button><button className="btn" onClick={p.onSetup}>{tr('settings.proj.setup')}</button></div>
      <div className="foot">{tr('settings.proj.d18Note')}</div>
    </>;
  } else if (tab === 'acc') {
    // v2 §6 A2: the account table; role / caps editing (F12 §6.12, T9) opens below on demand (progressive disclosure)
    const editor = editCaps ? <>
      <h3 className="acc-h">{tr('settings.acc.roles')}</h3>
      <RolesTable rows={accRows} accounts={snap.accounts} current={{ now: p.now, base: baseRows }} onChange={setRows} />
      {moves.map(m => <div key={m.lane} className="preview"><Icon n="alert" /><span><b>{previewText(m, tr).split(' — ')[0]}</b> — {previewText(m, tr).split(' — ').slice(1).join(' — ')}</span></div>)}
      {rowErrs.length ? <div className="err"><Icon n="alert" s={14} /><span>{rowErrs.join(' ')}</span></div> : null}
      <label className="toggle"><input type="checkbox" checked={readKeychain} onChange={e => setKeychain(e.target.checked)} /> {tr('settings.acc.keychain')}</label>
      <div className="foot">{tr('settings.acc.capsNote')}</div>
    </> : null;
    // G4 UX 5(c): the editor opens from the table toolbar, next to "Cấu hình chung"
    body = <AccountsTab snap={snap} onCfg={p.onCfg} onDlg={p.onAccDlg} onMenu={p.onAccMenu} editor={editor} onEditRoles={editCaps ? undefined : () => setEditCaps(true)} />;
  } else if (tab === 'noti') {
    body = <>
      <div className="tw-wrap"><table className="t"><thead><tr><th>{tr('settings.noti.event')}</th>{NOTIFY_CHANNELS.map(([ch, l]) => <th key={ch}>{tr(l)}</th>)}</tr></thead>
        <tbody>{NOTIFY_EVENTS.map(([e, label]) => <tr key={e}><td>{tr(label)}</td>{NOTIFY_CHANNELS.map(([ch, cl]) => <td key={ch}>
          <input type="checkbox" aria-label={`${tr(label)} · ${tr(cl)}`} checked={matrix[e][ch]} onChange={x => setNoti({ ...matrix, [e]: { ...matrix[e], [ch]: x.target.checked } })} /></td>)}</tr>)}</tbody></table></div>
      <div className="foot">{tr('settings.noti.note')}</div>
      <label className="toggle"><input type="checkbox" checked={soundOn} onChange={e => setSound(e.target.checked)} /> {tr('settings.noti.sound')} <input type="range" min={0} max={100} value={vol} aria-label={tr('settings.noti.volume')} onChange={e => setVolume(Number(e.target.value))} /></label>
    </>;
  } else if (tab === 'model') {
    body = <Suspense fallback={null}><ModelDefaults config={snap.config.modelDefaults} project={snap.projects.find(x => x.id === p.pid) ?? snap.projects[0] ?? null} connected={p.connected} send={p.send} /></Suspense>;
  } else if (tab === 'git') {
    body = snap.setup ? <Suspense fallback={null}><GitSetup setup={snap.setup} send={p.send} mac={mac} toast={p.toast} /></Suspense>
      : <div className="row foot"><span className="spin" /> {tr('settings.git.checking')}</div>;
  } else if (tab === 'remote') {
    const r = snap.engine.remote;
    body = <>
      <div className="form"><span className="foot">{tr('settings.remote.state')}</span><span>{r.enabled ? <span className="pill ok"><Icon n="globe" s={12} /> {tr('settings.remote.on')}</span> : <span className="pill">{tr('settings.remote.off')}</span>}</span>
        {r.hostname ? <><span className="foot">Hostname</span><span className="mono">https://{r.hostname}</span></> : null}</div>
      <div className="preview inf"><Icon n="info" /><span><b>{tr('settings.remote.laterTitle')}</b> {tr('settings.remote.laterText')}</span></div>
      <div className="foot">{tr('settings.remote.note')}</div>
    </>;
  } else {
    const run = snap.lanes.filter(l => l.state === 'running' || l.state === 'starting' || l.state === 'switching' || l.state === 'draining');
    const tauri = hasTauri();
    const act = async (cmd: 'engine_restart' | 'engine_uninstall') => {
      if (cmd === 'engine_uninstall' && !window.confirm(tr('settings.engine.uninstallConfirm'))) return;
      try { await invoke(cmd); } catch (e) { setErr(errText(tr, e)); }
    };
    body = <>
      <div className="form"><span className="foot">{tr('settings.engine.state')}</span><span>{p.connected ? <span className="pill ok"><Icon n="check" s={12} /> {tr('settings.engine.running')}</span> : <span className="pill bad">{tr('settings.engine.lost')}</span>} {tr('settings.engine.since', { time: fmtHm(snap.engine.startedAt) })}</span>
        <span className="foot">{tr('settings.engine.version')}</span><span className="mono">{tr('settings.engine.versionLine', { engine: snap.engine.version, protocol: snap.engine.protocol, claude: snap.engine.claudeVersion ?? '?' })}</span>
        {tauri ? <><span className="foot">{tr('update.update')}</span><Suspense fallback={<span />}><UpdateRow snap={snap} /></Suspense></> : null}
        <span className="foot">{tr('common.lang')}</span><span className="row" style={{ gap: 'var(--s3)' }}><LangSelect send={p.send} /><span className="foot">{tr('settings.langNote')}</span></span>
        <span className="foot">{tr('settings.engine.lanes')}</span><span>{run.length}{run.length ? ` (${run.map(l => l.name).join(', ')})` : ''}</span>
        {cleanupLine(tr, cleanup) ? <><span className="foot">{tr('settings.engine.cleanup')}</span><span>{cleanupLine(tr, cleanup)}</span></> : null}</div>
      <div className="row">
        <button className="btn" disabled={!tauri} title={tauri ? undefined : tr('settings.engine.macOnly')} onClick={() => void act('engine_restart')}><Icon n="refresh" s={14} /> {tr('settings.engine.restart')}</button>
        <button className="btn bad" disabled={!tauri || run.length > 0} title={!tauri ? tr('settings.engine.macOnly') : run.length ? tr('settings.engine.lanesLeft', { n: run.length }) : undefined} onClick={() => void act('engine_uninstall')}>{tr('settings.engine.uninstall')}</button>
      </div>
      <div className="foot">{tr('settings.engine.note', { cmd: 'launchctl bootout' })}</div>
    </>;
  }
  const instant = INSTANT_TABS.has(tab) || (tab === 'acc' && !editCaps); // v2 A2 actions apply at once; the caps editor saves
  const canSave = !busy && !(tab === 'acc' && rowErrs.length);
  return (
    <div className="modal glass wide set" role="dialog" aria-label={tr('settings.title')}>
      <div className="mh"><h2>{tr('settings.title')}</h2>{mac ? <span className="foot">⌘,</span> : null}<button className="x" onClick={p.onClose} aria-label={tr('common.close')}><Icon n="x" /></button></div>
      <div className="stabs" role="tablist">{tabs.map(t => <button key={t.id} role="tab" aria-selected={t.id === tab} className={t.id === tab ? 'on' : ''} onClick={() => { setErr(null); p.onTab(t.id); }}>{tr(t.key)}</button>)}</div>
      <div className="sbody">{body}{err ? <div className="err"><Icon n="alert" s={14} /><span>{err}</span></div> : null}</div>
      {instant ? <div className="mf"><span className="foot" style={{ marginRight: 'auto' }}>{tr('settings.instant')}</span><button className="btn" onClick={p.onClose}>{tr('common.close')}</button></div>
        : <div className="mf"><button className="btn" onClick={p.onClose}>{tr('common.cancel')}</button><button className="btn pri" disabled={!canSave} onClick={() => void save()}>{tab === 'acc' ? tr('settings.saveRoles') : tr('common.save')}</button></div>}
    </div>
  );
}
