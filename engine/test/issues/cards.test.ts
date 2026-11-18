// spec v2.7 the three new Chờ PO cards: §4.2-4 / §5.6 `issues_new` (one per project, unseen count, auto-close at 0), §7.3
// `superpowers_off`, §5.7-5 `revert_conflict` (IS5b, Giữ first), §8 remote = the cards without their buttons.
import { beforeEach, describe, expect, test } from 'bun:test';
import { remoteCard } from '../../../shared/issues.ts';
import { CardStore, type Card, type SystemPayload } from '../../src/cards/store.ts';
import { insertProject, openDb, type Db } from '../../src/db.ts';
import { IssueCards } from '../../src/issues/cards.ts';
import { addDep, createIssue, markSeen, type NewIssue } from '../../src/issues/store.ts';
import { cardView } from '../../src/server/views.ts';

let db: Db;
let store: CardStore;
let cards: IssueCards;
const issue = (o: Partial<NewIssue> = {}) => createIssue(db, { projectId: 'p1', kind: 'bug', specId: null, source: 'lane', title: 'nút Lưu mất khi cuộn', ...o });
const open = (kind: Card['kind']) => store.list({ status: 'open' }).filter((c) => c.kind === kind);
const pay = (c: Card) => c.payload as SystemPayload;

beforeEach(() => {
  db = openDb(':memory:');
  insertProject(db, { id: 'p1', name: 'Shop', path: '/r' });
  insertProject(db, { id: 'p2', name: 'Blog', path: '/b' });
  store = new CardStore({ db, sessions: { writeControl: () => true, askOpen: () => {}, askClose: () => {}, deliver: () => {} } });
  cards = new IssueCards({ db, cards: store });
});

describe('§4.2-4 / §5.6 issues_new', () => {
  test('§4.2-4 one unseen issue → one card: its key + full title, button Xem with the key', () => {
    const b = issue();
    cards.syncUnseen('p1');
    const [c] = open('issues_new');
    expect(c).toMatchObject({ projectId: 'p1' });
    expect(pay(c!)).toMatchObject({ titleKey: 'cards.issuesNewOne', params: { key: b.key, title: 'nút Lưu mất khi cuộn' }, title: 'nút Lưu mất khi cuộn' });
    expect(pay(c!).actions).toEqual([expect.objectContaining({ action: 'issues_view', args: { projectId: 'p1', key: b.key }, label: 'Xem' })]);
  });

  test('§4.2-4 ≥ 2 unseen → the same project has ONE card "<n> việc phát sinh", Xem filters (no key); po-made issues never count', () => {
    issue();
    cards.syncUnseen('p1');
    issue({ source: 'orchestrator', title: 'khác' });
    issue({ source: 'po', title: 'PO tự tạo' }); // §5.6 source po starts seen
    cards.syncUnseen('p1');
    cards.syncUnseen('p1');
    const all = open('issues_new');
    expect(all).toHaveLength(1);
    expect(pay(all[0]!)).toMatchObject({ titleKey: 'cards.issuesNewMany', params: { n: 2 }, title: '2 việc phát sinh' });
    expect(pay(all[0]!).actions[0]!.args).toEqual({ projectId: 'p1' });
  });

  test('§4.2-4 the card closes by itself at 0 (seen / cancelled), and is per project', () => {
    const a = issue();
    const b = issue({ title: 'khác' });
    createIssue(db, { projectId: 'p2', kind: 'task', specId: null, source: 'lane', title: 'blog' });
    cards.syncUnseen('p1');
    cards.syncUnseen('p2');
    expect(open('issues_new').map((c) => c.projectId).sort()).toEqual(['p1', 'p2']);
    markSeen(db, a.id);
    cards.syncUnseen('p1');
    expect(pay(open('issues_new').find((c) => c.projectId === 'p1')!).params).toEqual({ key: b.key, title: 'khác' });
    db.query("UPDATE issue SET state = 'cancelled' WHERE id = ?").run(b.id); // §5.6 cancelled ones do not count
    cards.syncUnseen('p1');
    expect(open('issues_new').map((c) => c.projectId)).toEqual(['p2']);
  });
});

describe('§7.3 superpowers_off', () => {
  test('§7.3 a failed check opens one red card per project with "Mở Skills & MCP"; the next passing check closes it', () => {
    cards.superpowers('p1', false);
    cards.superpowers('p1', false);
    const all = open('superpowers_off');
    expect(all).toHaveLength(1);
    expect(pay(all[0]!)).toMatchObject({ title: 'Chưa bật superpowers — lane mới phải chờ', body: 'Lane đang chạy không bị ảnh hưởng' });
    expect(pay(all[0]!).actions).toEqual([expect.objectContaining({ action: 'open_skills', label: 'Mở Skills & MCP' })]);
    cards.superpowers('p1', true);
    expect(open('superpowers_off')).toEqual([]);
  });
});

describe('§5.7-5 revert_conflict (IS5b)', () => {
  test('§5.7-5 "Hoàn tác T-1 vướng T-3 (đã merge, dựa vào T-1)": Giữ T-1 first (default), Huỷ cả hai… carries both keys; the blocker = newest done issue built on it', () => {
    const o = issue({ kind: 'task', source: 'spec', title: 'gốc' });
    const r = issue({ kind: 'task', source: 'po', title: 'Hoàn tác', reverts: o.id });
    const built = issue({ kind: 'task', source: 'spec', title: 'xây trên' });
    addDep(db, built.id, o.id);
    db.query("UPDATE issue SET state = 'done' WHERE id IN (?, ?)").run(o.id, built.id);
    const blocker = cards.blocker({ ...o, state: 'done' });
    expect(blocker?.key).toBe(built.key);
    cards.conflict(o, r, blocker);
    const [c] = open('revert_conflict');
    expect(pay(c!).title).toBe(`Hoàn tác ${o.key} vướng ${built.key} (đã merge, dựa vào ${o.key})`);
    expect(pay(c!).actions.map((a) => [a.action, a.label])).toEqual([['revert_keep', `Giữ ${o.key}`], ['revert_cancel_both', 'Huỷ cả hai…']]);
    expect(pay(c!).actions[1]!.args).toMatchObject({ keys: [built.key, o.key], revertKey: r.key });
    cards.closeConflict(o);
    expect(open('revert_conflict')).toEqual([]);
  });

  test('§5.7-5 no done dependant → the bare title', () => {
    const o = issue({ kind: 'task', source: 'spec' });
    cards.conflict(o, issue({ kind: 'task', source: 'po', reverts: o.id }), null);
    expect(pay(open('revert_conflict')[0]!).title).toBe(`Hoàn tác ${o.key} vướng xung đột`);
  });
});

test('§8 remote channel: the three cards keep their text, lose every button; other cards untouched', () => {
  issue();
  cards.syncUnseen('p1');
  cards.superpowers('p1', false);
  const o = issue({ kind: 'task', source: 'spec' });
  cards.conflict(o, issue({ kind: 'task', source: 'po', reverts: o.id }), null);
  store.createSystem({ kind: 'cc_updated', key: '9', titleKey: 'cards.ccUpdatedOk', params: { version: '9' }, actions: [{ label: 'x', action: 'dismiss' }] });
  const views = store.list({ status: 'open' }).map(cardView);
  for (const v of views.filter((x) => x.kind !== 'cc_updated')) {
    expect(remoteCard(v).actions).toEqual([]);
    expect(remoteCard(v).title).toBe(v.title);
  }
  const cc = views.find((x) => x.kind === 'cc_updated')!;
  expect(remoteCard(cc)).toBe(cc);
});
