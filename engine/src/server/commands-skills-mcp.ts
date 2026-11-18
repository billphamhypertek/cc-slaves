// v2.2 §5.4 / §5.5 Skills & MCP command handlers (Mac only: none is in REMOTE_ALLOWED, D32 / C24). Every handler acks
// with the fresh SkillsMcpView; the registry / skills errors carry their catalog key (`skillsMcp.err.*`).
import type { Key, Params } from '../../../shared/i18n/index.ts';
import type { SkillsMcpView } from '../../../shared/protocol.ts';
import type { Config } from '../config.ts';
import type { Engine } from '../engine.ts';
import { sameUrl } from '../mcp/oauth.ts';
import { ackedOf, ackIssue, unackIssue, withAcked, type SkillIssue } from '../skills/catalog.ts';
import { addFromFolder, checkSkillDir, copyOverAppLink, relinkSkill, removeSkill, SkillOpError, unlinkBroken, type SkillOpCode } from '../skills/ops.ts';
import { CommandError, type Handlers } from './router.ts';

const err = (code: string, key: Key, params?: Params) => new CommandError(code, { key, ...(params ? { params } : {}) });

const SKILL_KEYS: Partial<Record<SkillOpCode, Key>> = {
  exists: 'skillsMcp.err.skill.exists', noSkillMd: 'skillsMcp.err.skill.noSkillMd', badName: 'skillsMcp.err.skill.badName',
  badUrl: 'skillsMcp.err.skill.badUrl', gitFailed: 'skillsMcp.err.skill.gitFailed', noSkillsInRepo: 'skillsMcp.err.skill.noSkillsInRepo',
  copyFailed: 'skillsMcp.err.skill.copyFailed', noFolder: 'skillsMcp.err.skill.noFolder',
};

/** SkillOpError → a keyed CommandError (the codes the PO cannot act on read "changed on disk — reload"). */
async function skillOp<T>(f: () => T | Promise<T>): Promise<T> {
  try { return await f(); } catch (e) {
    if (!(e instanceof SkillOpError)) throw e;
    const detail = e.message.slice(e.code.length + 2);
    throw err(e.code, SKILL_KEYS[e.code] ?? 'skillsMcp.err.skill.stale', { name: detail, detail });
  }
}

const setIn = (list: readonly string[], id: string, inList: boolean): string[] => (inList ? [...new Set([...list, id])] : list.filter((x) => x !== id));
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function skillsMcpHandlers(e: Engine) {
  const sm = () => e.skillsMcp;
  const view = (): SkillsMcpView => sm().view();
  const fresh = (rev: unknown) => {
    if (typeof rev === 'string' && rev !== sm().rev()) throw err('source_changed', 'skillsMcp.err.sourceChanged');
  };
  const write = async (f: () => Promise<void>): Promise<SkillsMcpView> => {
    try { await f(); } finally { sm().flush(); } // §6 K14 the post-write rev reaches the Mac before the reply
    return view();
  };
  const config = (f: (c: Config) => Config): SkillsMcpView => { sm().setConfig(f(e.config)); return view(); };
  const mcpRow = (id: string) => {
    const r = view().mcp.rows.find((x) => x.id === id);
    if (!r) throw err('no_item', 'skillsMcp.err.badId', { id });
    if (r.unused || r.builtin) throw err('read_only', 'skillsMcp.err.readOnly', { id }); // K1-local, §6 F-I1 cc_slaves (always on)
    return r;
  };
  const issue = (id: string): SkillIssue => {
    const i = sm().skillCatalog()?.issues.find((x) => x.id === id);
    if (!i) throw err('no_item', 'skillsMcp.err.badId', { id });
    return i;
  };
  const skillsChanged = <T>(r: T): SkillsMcpView => { void r; sm().rescan(); sm().changed(); return view(); };
  const oauth = () => sm().oauth;
  /** K4 "Đăng nhập: Không" → `mcp.noLogin` holds `user:<to>` (and never the old id of a rename / a removed server). */
  const setNoLogin = (drop: string, to: string | null, on: boolean) => {
    const cur = e.config.mcp.noLogin;
    const next = setIn(cur.filter((x) => x !== drop), to ?? drop, on && to !== null);
    if (next.length !== cur.length || next.some((x, i) => x !== cur[i])) sm().setConfig({ ...e.config, mcp: { ...e.config.mcp, noLogin: next } });
  };
  const secretOf = (c: { clientSecret?: unknown }) => (typeof c.clientSecret === 'string' && c.clientSecret ? c.clientSecret : undefined);
  /** §5.3 only a remote catalog entry has a login. */
  const remote = (id: unknown): string => {
    const s = str(id);
    if (!oauth().view(s)) throw err('not_remote', 'skillsMcp.err.notRemote', { id: s });
    return s;
  };

  return {
    mcp_add: async (c) => {
      fresh(c.rev);
      await write(() => sm().registry.add(str(c.name), c.config, secretOf(c)));
      setNoLogin(`user:${str(c.name)}`, `user:${str(c.name)}`, c.noLogin === true);
      sm().probeSoon([`user:${str(c.name)}`]); // §5.4b C22 after save
      return view();
    },
    mcp_which: (c) => ({ path: Bun.which(str(c.command), { PATH: e.login.env.PATH ?? '' }) }), // K4 "npx có trên PATH (…)"
    mcp_edit: async (c) => {
      fresh(c.rev);
      const from = str(c.name);
      const to = typeof c.to === 'string' && c.to ? c.to : from;
      const oldUrl = view().mcp.rows.find((r) => r.id === `user:${from}`)?.config.url;
      await write(() => sm().registry.edit(from, to, c.config, (l) => sm().addLost(l), secretOf(c)));
      setNoLogin(`user:${from}`, `user:${to}`, c.noLogin === true);
      // §5.3 rename moves the login; a new URL drops it (revoke first, K5 warned)
      if (to !== from) oauth().rename(`user:${from}`, `user:${to}`);
      const newUrl = c.config.url;
      if (typeof oldUrl === 'string' && (typeof newUrl !== 'string' || !sameUrl(oldUrl, newUrl))) await oauth().logout(`user:${to}`);
      sm().probeSoon([`user:${to}`]); // §5.4b C22 after edit (after the login moved / dropped)
      return view();
    },
    mcp_remove: async (c) => {
      fresh(c.rev);
      await write(() => sm().registry.delete(str(c.name)));
      setNoLogin(`user:${str(c.name)}`, null, false);
      await oauth().logout(`user:${str(c.name)}`); // §5.3 remove → revoke, then delete the Keychain item
      return view();
    },
    mcp_toggle: (c) => {
      const r = mcpRow(str(c.id));
      const on = c.on === true;
      return config((x) => ({
        ...x, mcp: { ...x.mcp, offForLanes: setIn(x.mcp.offForLanes, r.id, !on), projectOn: r.source === 'project' ? setIn(x.mcp.projectOn, r.id, on) : x.mcp.projectOn },
      }));
    },
    mcp_project_enable: (c) => {
      const r = mcpRow(str(c.id));
      if (r.source !== 'project') throw err('no_item', 'skillsMcp.err.badId', { id: r.id });
      const on = c.on === true;
      return config((x) => ({ ...x, mcp: { ...x.mcp, offForLanes: setIn(x.mcp.offForLanes, r.id, !on), projectOn: setIn(x.mcp.projectOn, r.id, on) } }));
    },
    mcp_check: (c) => {
      const id = str(c.id);
      if (!view().mcp.rows.some((r) => r.id === id)) throw err('no_item', 'skillsMcp.err.badId', { id });
      if (!sm().check(id)) throw err('not_checkable', 'skillsMcp.err.notCheckable', { id }); // §5.4b C22: K7 / K1-local stdio
      return view();
    },
    mcp_login: (c) => { // K3: the ack is immediate; discovery / the browser / errors follow as pushed views
      void oauth().login(remote(c.id), { ...(c.clientId ? { clientId: c.clientId } : {}), ...(c.clientSecret ? { clientSecret: c.clientSecret } : {}) });
      return view();
    },
    mcp_login_cancel: (c) => { oauth().cancelLogin(remote(c.id)); return view(); },
    mcp_logout: async (c) => {
      const id = remote(c.id);
      await oauth().logout(id);
      sm().autoProbe([id]); // §5.4b the row shows what the server says without the login
      return view();
    },
    mcp_keychain_retry: (c) => {
      const id = remote(c.id);
      if (!oauth().view(id)!.loggedIn) throw err('no_login', 'skillsMcp.err.noLogin', { id });
      oauth().retrySave(id);
      return view();
    },
    mcp_snooze: (c) => { sm().loginCards.snooze(str(c.id)); return view(); },
    skill_add_folder: (c) => skillOp(() => skillsChanged(addFromFolder(sm().roots, str(c.path), c.mode === 'copy' ? 'copy' : 'link'))),
    skill_check_folder: (c) => skillOp(() => checkSkillDir(sm().roots, str(c.path))), // K9-folder dry run, nothing written
    skill_git_fetch: (c) => skillOp(() => sm().gitFetch(str(c.url))),
    skill_git_add: (c) => skillOp(() => {
      if (sm().gitAdd(str(c.cloneId), Array.isArray(c.names) ? c.names.filter((n) => typeof n === 'string') : []) === null) throw err('no_item', 'skillsMcp.err.badId', { id: str(c.cloneId) });
      return view();
    }),
    skill_git_cancel: (c) => { sm().dropClone(str(c.cloneId)); },
    skill_remove: (c) => skillOp(() => {
      const s = view().skills.rows.find((x) => x.id === c.id && x.scope === 'user');
      if (!s) throw err('no_item', 'skillsMcp.err.badId', { id: str(c.id) });
      return skillsChanged(removeSkill(sm().roots, s));
    }),
    skill_fix: (c) => skillOp(() => {
      const i = issue(str(c.issueId));
      const dir = i.dir ?? '';
      if (c.fix === 'copy' && i.code === 'appLink') return skillsChanged(copyOverAppLink(sm().roots, dir));
      if (c.fix === 'unlink' && i.code === 'brokenLink') return skillsChanged(unlinkBroken(sm().roots, dir));
      if (c.fix === 'relink' && i.code === 'brokenLink') return skillsChanged(relinkSkill(sm().roots, dir, str(c.target)));
      if (c.fix === 'trash' && i.code === 'missingSkillMd') return skillsChanged(removeSkill(sm().roots, { scope: i.project === null ? 'user' : 'project', path: i.path }));
      throw err('no_item', 'skillsMcp.err.badId', { id: i.id });
    }),
    skill_ack: (c) => {
      const i = issue(str(c.issueId));
      if (c.on === true && !i.ackable) throw err('not_ackable', 'skillsMcp.err.skill.notAckable');
      return config((x) => withAcked(x, c.on === true ? ackIssue(ackedOf(x), i) : unackIssue(ackedOf(x), i.id)));
    },
    skill_toggle: (c) => {
      const s = view().skills.rows.find((x) => x.id === c.id && x.scope !== 'plugin');
      if (!s) throw err('no_item', 'skillsMcp.err.badId', { id: str(c.id) });
      return config((x) => ({ ...x, skills: { ...x.skills, offForLanes: setIn(x.skills.offForLanes, s.id, c.on !== true) } }));
    },
    plugin_toggle: (c) => {
      if (!view().skills.plugins.some((p) => p.key === c.key)) throw err('no_item', 'skillsMcp.err.badId', { id: str(c.key) });
      return config((x) => ({ ...x, plugins: { offForLanes: setIn(x.plugins.offForLanes, str(c.key), c.on !== true) } }));
    },
  } satisfies Partial<Handlers>;
}
