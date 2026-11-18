// Engine shared config (spec v2 §5.2–§5.5, A9): settings mirror, shared-config check, A9 cards, merge / share.
import { readdirSync, statSync } from 'node:fs';
import type { AccountsInfo } from '../../../shared/protocol.ts';
import { act, keyedBody, type KeyedBody, type SystemPayload } from '../cards/store.ts';
import type { Key } from '../../../shared/i18n/index.ts';
import { AccountError } from '../accounts/remove.ts';
import type { Account } from '../accounts/registry.ts';
import { saveConfig, type Config } from '../config.ts';
import { getMeta, setMeta } from '../db.ts';
import { paths } from '../paths.ts';
import { ensureMirrored, mirrorSettings, watchSettings } from '../accounts/mirror.ts';
import { defaultBrowser } from '../accounts/browser.ts';
import { classifyEntry, entryList, unknownEntries } from '../accounts/layout.ts';
import { clashCopies, mergeShared, newUnknownEntries, planMerge, unshareEntry, type ClashCopy, type MergePlan, type MergeResult, type SharedCfgCheck } from '../accounts/shared-cfg.ts';
import type { Engine } from '../engine.ts';

// ---------- v2 shared config (§5.2, §5.5, A9) ----------

/** The accounts laid out as links into `~/.claude`: every one but the terminal account, which IS `~/.claude` (hf1116 T3). */
const linked = (eng: Engine): Account[] => eng.accounts.filter((a) => !a.terminal);
const linkedOf = (eng: Engine, email: string): Account | undefined => linked(eng).find((x) => x.email === email.trim().toLowerCase());

/** §5.3 settings copy + §5.5 check of that account only (≤ 20 ms); false = flagged → a lane does not spawn there. */
export function preSpawn(eng: Engine, dir: string): boolean {
  const a = eng.accounts.find((x) => x.configDir === dir);
  if (a?.terminal) return true; // hf1116 T3: the source itself — nothing to mirror or heal
  eng.logMirror(ensureMirrored(dir));
  return a ? eng.checkSharedCfg(a).ok : true;
}

/** The picker's config: an account whose shared config is broken takes no new lane, like a paused one (§5.5). */
export function laneConfig(eng: Engine): Config {
  const flagged = eng.sharedCfg.flagged();
  if (flagged.size === 0) return eng.config;
  const noNewLanes = { ...eng.config.noNewLanes };
  for (const e of flagged) noNewLanes[e] = true;
  return { ...eng.config, noNewLanes };
}

/** §5.5 heal + check one account; a change re-runs waiting lanes and pushes the view; A9 cards follow the issues. */
export function checkSharedCfg(eng: Engine, a: Account): SharedCfgCheck {
  const before = eng.sharedCfg.get(a.email);
  const r = eng.sharedCfg.check(a);
  if (r.ms > 20) eng.log(`kiểm tra cấu hình chung ${a.email}: ${r.ms.toFixed(1)} ms (> 20 ms)`);
  eng.syncSharedCards(a, r);
  if (before && (before.ok !== r.ok || JSON.stringify(before.issues) !== JSON.stringify(r.issues))) eng.accountChanged(a.email);
  return r;
}

export function checkAllSharedCfg(eng: Engine): void {
  const live = new Set(eng.accounts.map((a) => a.email));
  for (const email of eng.sharedCfg.flagged()) { // a deleted / signed-out-of-registry account: drop its state + A9 cards
    if (live.has(email)) continue;
    eng.sharedCfg.forget(email);
    for (const c of eng.cards.list({ status: 'open' }).filter((x) => x.kind === 'shared_cfg' && ((x.payload as SystemPayload).key ?? '').startsWith(`${email}/`))) eng.cards.resolveSystem(c.id);
  }
  for (const a of linked(eng)) eng.checkSharedCfg(a);
}

export function syncSharedCards(eng: Engine, a: Account, r: SharedCfgCheck): void {
  const short = `${a.email.split('@')[0]}@`;
  const keys = new Set(r.issues.map((i) => `${a.email}/${i.name}`));
  for (const c of eng.cards.list({ status: 'open' }).filter((x) => x.kind === 'shared_cfg')) {
    const k = (c.payload as SystemPayload).key ?? '';
    if (k.startsWith(`${a.email}/`) && !keys.has(k)) eng.cards.resolveSystem(c.id);
  }
  for (const k of [...eng.sharedDismissed]) if (k.startsWith(`${a.email}/`) && !keys.has(k)) eng.sharedDismissed.delete(k);
  for (const i of r.issues) {
    const key = `${a.email}/${i.name}`;
    if (eng.sharedDismissed.has(key)) continue;
    const open = eng.cards.findOpenSystem('shared_cfg', key);
    if (i.kind === 'real-entry' && i.name) {
      const plan = planMerge(paths().claudeHome, a.configDir, i.name, { extraShared: eng.config.sharedExtra ?? [] });
      if (open) { eng.refreshA9(open.id, a.email, i.name, plan); continue; } // G4 UX I3: the body follows the disk
      eng.cards.createSystem({
        kind: 'shared_cfg', key, titleKey: 'cards.sharedCfgNotLinked', params: { who: short, name: i.name },
        ...mergeBody(plan), actions: a9Actions(a.email, i.name, plan),
      });
    } else if (!open) {
      const later = act('cardText.act.later', 'dismiss');
      eng.cards.createSystem({
        kind: 'shared_cfg', key, titleKey: 'cards.sharedCfgBroken', params: { who: short, name: i.name || a.configDir },
        bodyKey: ISSUE_KEY[i.kind], bodyParams: { path: i.path }, actions: [later],
      });
    }
  }
}

/** §5.5 "Gộp vào ~/.claude" (dry run = the plan only). The account is re-checked after a real merge. */
export function mergeSharedCfg(eng: Engine, email: string, name: string, dryRun: boolean): (MergePlan & { copies?: ClashCopy[] }) | MergeResult {
  const a = linkedOf(eng, email);
  if (!a) throw new AccountError('no_account', { key: 'errors.noAccount', params: { email } });
  const opts = { extraShared: eng.config.sharedExtra ?? [] };
  if (dryRun) { // G4 UX I2: A9C shows both copies of each clash (folder + mtime); I3: the A9 card body follows the plan
    const plan = planMerge(paths().claudeHome, a.configDir, name, opts);
    const open = eng.cards.findOpenSystem('shared_cfg', `${a.email}/${name}`);
    if (open) eng.refreshA9(open.id, a.email, name, plan);
    return { ...plan, copies: clashCopies(paths().claudeHome, a.configDir, plan) };
  }
  const r = mergeShared(paths().claudeHome, a.configDir, name, opts);
  if (!r.ok) {
    if (r.reason === 'clash') throw new AccountError('clash', { key: 'errors.mergeClash', params: { names: r.clashes.join(', ') } });
    throw new AccountError('bad_input', { key: `errors.merge_${r.reason}` });
  }
  eng.log(`cấu hình chung: đã gộp ${a.email}/${name} vào ~/.claude (${r.moved.length} file), bản cũ ${r.backup}`);
  eng.checkSharedCfg(a);
  return r;
}

/** §5.2 "Dùng chung" for an unknown entry: config.json `sharedExtra`, then every account is re-laid; off = unlink only. */
export function toggleShared(eng: Engine, name: string, shared: boolean): { sharedExtra: string[] } {
  if (classifyEntry(name) !== 'unknown' || !name || name === '.' || name === '..' || /[/\\\0]/.test(name)) {
    throw new AccountError('bad_input', { key: 'errors.notUnknownEntry', params: { name } });
  }
  const cur = eng.config.sharedExtra ?? [];
  const sharedExtra = shared ? [...new Set([...cur, name])].sort() : cur.filter((n) => n !== name);
  const next = { ...eng.config, sharedExtra };
  saveConfig(next, { keepRegistryKeys: !eng.registryImported() });
  eng.config = next;
  if (!shared) for (const a of linked(eng)) unshareEntry(paths().claudeHome, a.configDir, name);
  const card = eng.cards.findOpenSystem('shared_cfg_new', name);
  if (card) eng.cards.resolveSystem(card.id, shared ? 'shared_cfg_toggle' : undefined);
  eng.checkAllSharedCfg();
  eng.hub.broadcast({ type: 'config', config: eng.configView() });
  return { sharedExtra };
}

/** §5.2 unknown entries of the ~/.claude root: one not seen before gets the "dùng chung cho mọi account?" card. */
export function scanClaudeRoot(eng: Engine): void {
  const home = paths().claudeHome;
  let names: string[] = [];
  try { names = readdirSync(home); } catch { return; }
  const raw = getMeta(eng.db, SHARED_SEEN_KEY);
  const seen = raw === null ? null : (JSON.parse(raw) as string[]);
  if (seen !== null) {
    for (const n of newUnknownEntries(names, seen)) {
      if ((eng.config.sharedExtra ?? []).includes(n)) continue;
      let isDir = false;
      try { isDir = statSync(`${home}/${n}`).isDirectory(); } catch { /* gone */ }
      eng.cards.createSystem({
        kind: 'shared_cfg_new', key: n, titleKey: 'cards.sharedCfgNew', params: { name: `${n}${isDir ? '/' : ''}` },
        bodyKey: 'cardText.body.sharedNew',
        actions: [act('cardText.act.share', 'shared_cfg_toggle', { name: n, shared: true }), act('cardText.act.keepPrivate', 'dismiss')],
      });
    }
  }
  setMeta(eng.db, SHARED_SEEN_KEY, JSON.stringify([...new Set([...(seen ?? []), ...unknownEntries(names)])].sort()));
}

/** v2 §6 A2 the Account tab's engine facts: `~/.claude` entries (§5.2), private-window support. */
export async function accountsInfo(eng: Engine): Promise<AccountsInfo> {
  let names: string[] = [];
  try { names = readdirSync(paths().claudeHome); } catch { /* no ~/.claude yet */ }
  const b = await defaultBrowser(eng.o.browserExec).catch(() => null);
  return { entries: entryList(names, eng.config.sharedExtra ?? []), privateWindow: !!b && b.kind !== 'unknown' && !!b.flag };
}

export function refreshA9(eng: Engine, id: number, email: string, name: string, plan: MergePlan): void {
  eng.cards.updateSystem(id, { ...mergeBody(plan), actions: a9Actions(email, name, plan) });
}

/**
 * §6 A9C "Mở Finder": the account copy of a clash. `file` is only a lookup key: the path is built from the engine's
 * own re-plan and the registry dir, so a client string that is not one of the plan's clashes gives null.
 */
export function clashPath(eng: Engine, email: string, name: string, file: string): string | null {
  const a = linkedOf(eng, email);
  if (!a) return null;
  const plan = planMerge(paths().claudeHome, a.configDir, name, { extraShared: eng.config.sharedExtra ?? [] });
  const hit = clashCopies(paths().claudeHome, a.configDir, plan, () => null).find((c) => c.file === file);
  return hit ? hit.account.path : null;
}

export function logMirror(eng: Engine, r: { errors: string[] }): void {
  for (const e of r.errors) eng.log(`settings mirror: ${e}`);
}

/** v2 §5.3 one full mirror at boot, then the 1 s-debounced watch on ~/.claude (stopped in stop()). */
export function startSettingsMirror(eng: Engine): void {
  const dirs = () => linked(eng).map((a) => a.configDir);
  const home = paths().claudeHome;
  eng.logMirror(mirrorSettings(home, dirs()));
  eng.stopSettingsWatch = watchSettings(home, dirs, { onMirror: (r) => eng.logMirror(r) });
}

/** meta key: unknown ~/.claude entries already seen (first boot seeds it silently; later ones get a card). */
const SHARED_SEEN_KEY = 'shared_cfg_seen';
const ISSUE_KEY: Record<SharedCfgCheck['issues'][number]['kind'], Key> = {
  'missing-target': 'cardText.body.issue.missingTarget', 'target-not-dir': 'cardText.body.issue.targetNotDir',
  'missing-link': 'cardText.body.issue.missingLink', 'wrong-target': 'cardText.body.issue.wrongTarget', 'real-entry': 'cardText.body.issue.realEntry',
};
const MERGE_REFUSED_KEY: Record<'not_shared' | 'not_real_dir' | 'target_not_dir', Key> = {
  not_shared: 'cardText.body.refused.notShared', not_real_dir: 'cardText.body.refused.notRealDir', target_not_dir: 'cardText.body.refused.targetNotDir',
};
const LIST_MAX = 20;
/** §6 A9 actions: a clash can't be merged → the primary opens A9C ("Xem trùng tên", same dry-run-first dialog). */
function a9Actions(email: string, name: string, p: MergePlan): SystemPayload['actions'] {
  const clash = !p.ok && p.reason === 'clash';
  return [act(clash ? 'cardText.act.viewClash' : 'cardText.act.merge', 'shared_cfg_merge', { email, name }), act('cardText.act.later', 'dismiss')];
}
/** A9 card body (§6A keyed): the files that would move (or the clashes, ≤ LIST_MAX + "… và n file nữa"), then "Không ghi đè." */
export function mergeBody(p: MergePlan): KeyedBody {
  const list = (xs: string[]) => xs.slice(0, LIST_MAX).map((x) => `- ${x}`).join('\n');
  const more = (xs: string[]) => Math.max(0, xs.length - LIST_MAX);
  if (!p.ok && p.reason === 'clash') {
    const m = more(p.clashes);
    return m ? keyedBody('cardText.body.mergeClashMore', { list: list(p.clashes), more: m }) : keyedBody('cardText.body.mergeClash', { list: list(p.clashes) });
  }
  if (!p.ok) return keyedBody(MERGE_REFUSED_KEY[p.reason]);
  if (!p.files.length) return keyedBody('cardText.body.mergeEmpty', { name: p.name });
  const m = more(p.files), base = { n: p.files.length, name: p.name, list: list(p.files) };
  return m ? keyedBody('cardText.body.mergeFilesMore', { ...base, more: m }) : keyedBody('cardText.body.mergeFiles', base);
}
