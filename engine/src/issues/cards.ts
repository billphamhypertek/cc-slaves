// v2.7 the three Chờ PO cards of the Tasks flow (§4.2-4 / §5.6 `issues_new`, §7.3 `superpowers_off`, §5.7-5
// `revert_conflict`), one open card per (kind, project[, issue]) through CardStore's system cards. Their buttons act on the
// Mac only (§8, `MAC_ACTION_CARDS`): `issues_view` / `open_skills` / `revert_cancel_both` are UI-only (the web navigates,
// nothing resolves), `revert_keep` answers the conflict ("Giữ T-46").
import type { Db } from '../db.ts';
import { t, type Params } from '../../../shared/i18n/index.ts';
import type { IssueRow } from '../../../shared/issues.ts';
import { act, type CardStore, type SystemAction, type SystemPayload } from '../cards/store.ts';
import { getIssue, listIssues, projectDeps, unseenCount } from './store.ts';

type Cards = Pick<CardStore, 'createSystem' | 'updateSystem' | 'findOpenSystem' | 'resolveSystem'>;

const UNSEEN_KEY = 'issues_new';
const SUPERPOWERS_KEY = 'superpowers_off';
const conflictKey = (origKey: string) => `revert:${origKey}`;

/** Card action ids (the web renders them; `card_action` runs `revert_keep`, the rest are UI-only). */
export const ISSUE_CARD_ACTIONS = { view: 'issues_view', openSkills: 'open_skills', keep: 'revert_keep', cancelBoth: 'revert_cancel_both' } as const;
export const UI_ONLY_ACTIONS: ReadonlySet<string> = new Set([ISSUE_CARD_ACTIONS.view, ISSUE_CARD_ACTIONS.openSkills, ISSUE_CARD_ACTIONS.cancelBoth]);

export class IssueCards {
  constructor(private readonly d: { db: Db; cards: Cards }) {}

  /** §5.6 the count of `po_seen=false`, not cancelled: one issue → its key + title, ≥ 2 → "<n> việc phát sinh"; 0 → closed. */
  syncUnseen(projectId: string): void {
    const n = unseenCount(this.d.db, projectId);
    const open = this.d.cards.findOpenSystem('issues_new', UNSEEN_KEY, projectId);
    if (n === 0) { if (open) this.d.cards.resolveSystem(open.id); return; }
    const one = n === 1 ? listIssues(this.d.db, projectId).find((i) => !i.poSeen && i.state !== 'cancelled') ?? null : null;
    const titleKey = one ? 'cards.issuesNewOne' as const : 'cards.issuesNewMany' as const;
    const params: Params = one ? { key: one.key, title: one.title } : { n };
    const actions = [act('cardText.act.view', ISSUE_CARD_ACTIONS.view, { projectId, ...(one ? { key: one.key } : {}) })];
    if (open && (open.payload as SystemPayload).titleKey !== titleKey) this.d.cards.resolveSystem(open.id);
    else if (open) { this.d.cards.updateSystem(open.id, { body: null, actions, params }); return; }
    this.d.cards.createSystem({ kind: 'issues_new', projectId, key: UNSEEN_KEY, titleKey, params, actions });
  }

  /** §7.3 a superpowers check of the project's lanes: off → the red card (once), on again → it closes. */
  superpowers(projectId: string, active: boolean): void {
    const open = this.d.cards.findOpenSystem('superpowers_off', SUPERPOWERS_KEY, projectId);
    if (active) { if (open) this.d.cards.resolveSystem(open.id); return; }
    if (open) return;
    this.d.cards.createSystem({
      kind: 'superpowers_off', projectId, key: SUPERPOWERS_KEY, titleKey: 'cards.superpowersOff', bodyKey: 'cardText.body.superpowersOff',
      actions: [act('cardText.act.openSkills', ISSUE_CARD_ACTIONS.openSkills, { projectId })],
    });
  }

  /** §5.7-5 the issue that blocks the revert: the newest `done` issue built on the original (null = none known). */
  blocker(orig: IssueRow): IssueRow | null {
    const built = projectDeps(this.d.db, orig.projectId).filter((d) => d.blockedById === orig.id).map((d) => getIssue(this.d.db, d.issueId)!);
    return built.filter((i) => i?.state === 'done').sort((a, b) => b.num - a.num)[0] ?? null;
  }

  /** §5.7-5 IS5b: "Hoàn tác T-46 vướng T-53" — Giữ T-46 (first = default, ⌥1) · Huỷ cả hai… (IS4 for both, on the web). */
  conflict(orig: IssueRow, revert: IssueRow, blocker: IssueRow | null): void {
    const args = { projectId: orig.projectId, key: orig.key, revertKey: revert.key, blocker: blocker?.key ?? null };
    const labelParams = { key: orig.key };
    const keep: SystemAction = { label: t('vi', 'cardText.act.keepIssue', labelParams), action: ISSUE_CARD_ACTIONS.keep, args, labelKey: 'cardText.act.keepIssue', labelParams };
    const both = act('cardText.act.cancelBoth', ISSUE_CARD_ACTIONS.cancelBoth, { ...args, keys: blocker ? [blocker.key, orig.key] : [orig.key] });
    this.d.cards.createSystem({
      kind: 'revert_conflict', projectId: orig.projectId, key: conflictKey(orig.key),
      ...(blocker ? { titleKey: 'cards.revertConflict' as const, params: { key: orig.key, blocker: blocker.key } } : { titleKey: 'cards.revertConflictBare' as const, params: { key: orig.key } }),
      actions: [keep, both],
    });
  }

  /** The PO answered the conflict elsewhere (a new revert of the original was confirmed): the card closes. */
  closeConflict(orig: IssueRow): void {
    const open = this.d.cards.findOpenSystem('revert_conflict', conflictKey(orig.key), orig.projectId);
    if (open) this.d.cards.resolveSystem(open.id);
  }
}
