// v2.7 G5 the Deck traces of issues / specs: §4.2 head strip, lane chip + line 2, issue cards (§4.2-4, §7.3, §5.7-5, §8 remote),
// §4.5 chat keys, §4.6 tool labels + the blocked Skill row, §5.0 session kinds + the R34 cap from the view, ⌘K Tasks.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { makeT } from '../../shared/i18n/index.ts';
import type { CardView, OrchestratorView } from '../../shared/protocol.ts';
import { issueRow, keyAct, rowText, rowTone } from '../src/lib/cards.ts';
import { deckHeader, issuesStrip } from '../src/lib/deckhead.ts';
import { LangProvider } from '../src/lib/i18n.tsx';
import { orchActions } from '../src/lib/actions.ts';
import { buildItems } from '../src/lib/palette.ts';
import { blockedSkill, ccsLabel, hideTools, type ToolCall } from '../src/lib/tool-rows.ts';
import { goArising, goIssue, goPatch, laneIssue, orchKindLabel, specShort, splitKeys } from '../src/lib/traces.ts';
import { laneLine2 } from '../src/deck/cards.ts';
import { buildFlow, type LaneData, type OrchData } from '../src/deck/flow/model.ts';
import { OrchCard } from '../src/deck/flow/nodes.tsx';
import { CardRow, type CardRowProps } from '../src/ui/Card.tsx';
import { HeadBar } from '../src/ui/HeadBar.tsx';
import { Markdown, MdIssueContext, type MdIssueHooks } from '../src/ui/Markdown.tsx';
import { ToolRow } from '../src/ui/ToolRow.tsx';
import { Conversation } from '../src/ui/Conversation.tsx';
import { designFresh, rootName } from '../src/lib/sessions.ts';
import { card, issueInfo, lane, projIssues, snapshot, specInfo } from './fixtures.ts';

const VI = makeT('vi');
const html = (el: ReactElement) => renderToStaticMarkup(<LangProvider lang="vi">{el}</LangProvider>);
const plain = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const P = (done: number, total: number, scope = 0, cancelled = 0) => ({ done, total, scope, cancelled, amend: 0 });

describe('§4.2-1 the head strip', () => {
  const v25 = specInfo(4, { title: 'v2.5 Toolkit graph', openedAt: 200, progress: P(8, 13, 2, 1) });
  test('§4.2-1 earliest active spec + "+1", "ngoài spec n" = open issues outside every spec, tooltip text', () => {
    const later = specInfo(5, { title: 'v2.6 Updater', openedAt: 300, progress: P(1, 4) });
    const pi = projIssues([later, v25], [issueInfo(1, { specId: null, state: 'todo' }), issueInfo(2, { specId: null, state: 'doing' }), issueInfo(3, { specId: null, state: 'done' })]);
    const part = issuesStrip(pi, VI)!;
    expect(part.strip!.spec!.short).toBe('v2.5');
    expect(part.strip!.more).toBe(1);
    expect(part.strip!.outside).toBe(2);
    expect(part.strip!.spec!.tip).toBe('8 xong / 13 mục · 2 phát sinh thêm phạm vi · 1 huỷ');
    expect(part.text).toBe('v2.5 8/13 +1 · ngoài spec 2');
  });
  test('§4.2-1 no active spec and no open issue → no strip; only outside issues → the outside part alone', () => {
    expect(issuesStrip(projIssues([specInfo(1, { state: 'approved' })], [issueInfo(1, { specId: null, state: 'done' })]), VI)).toBeNull();
    const only = issuesStrip(projIssues([], [issueInfo(1, { specId: null })]), VI)!;
    expect(only.strip!.spec).toBeNull();
    expect(only.text).toBe('ngoài spec 1');
  });
  test('§4.2-2 the strip draws THE progress bar (compact ProgressBar), only on the Deck with Tasks on', () => {
    const head = deckHeader({ snap: snapshot(), projectId: 'p1', roots: 1, subagents: {}, tr: VI, pi: projIssues([v25], []) });
    const bar = (mode: 'deck' | 'code', tasks = true) => html(<HeadBar head={head} mode={mode} onMode={() => {}} tasks={tasks} unseen={false} onTasks={() => {}} />);
    expect(bar('deck')).toContain('class="tpg cp"');
    expect(bar('deck')).toContain('class="hstrip" title="8 xong / 13 mục · 2 phát sinh thêm phạm vi · 1 huỷ"');
    expect(plain(bar('deck'))).toContain('v2.5 8/13');
    expect(bar('code')).not.toContain('tpg');
    expect(bar('deck', false)).not.toContain('hstrip');
  });
});

describe('§4.2-3 lane chip + line 2, §5.0 orchestrator kind', () => {
  const pi = projIssues([specInfo(4, { title: 'v2.5 Toolkit graph', sessions: { design: null, build: 's-b', edit: null } })], [
    issueInfo(47, { title: 'Màn Graph code', state: 'doing', lane: { name: 'D2', state: 'running', phase: 'code' } }),
    issueInfo(50, { key: 'B-50', kind: 'bug', title: 'CBM không tắt', state: 'doing', poSeen: false, source: 'lane', lane: { name: 'D15', state: 'running', phase: 'code' } }),
  ]);
  test('§4.2-3 line 2 priority: card → quota → note → issue title → task', () => {
    const l = lane('D2', { note: null, task: 'B2' });
    expect(laneLine2(l, [], [], VI, 'Màn Graph code')).toEqual({ kind: 'text', text: 'Màn Graph code' });
    expect(laneLine2({ ...l, note: 'đang chạy test' }, [], [], VI, 'Màn Graph code')).toEqual({ kind: 'text', text: 'đang chạy test' });
    expect(laneLine2(l, [], [], VI, null)).toEqual({ kind: 'text', text: 'B2' });
    expect(laneLine2(l, [card(1, { source: 'D2' })], [], VI, 'Màn Graph code').kind).toBe('card');
  });
  test('§4.2-3 the chip is the doing issue the lane holds; orange (unseen) for an arising one', () => {
    expect(laneIssue(pi, 'D2')?.key).toBe('T-47');
    expect(laneIssue(pi, 'X9')).toBeNull();
    expect(laneIssue(projIssues([], [issueInfo(9, { state: 'done', lane: { name: 'D9', state: 'done', phase: 'done' } })]), 'D9')).toBeNull(); // a finished issue keeps its lane name
    const snap = snapshot({ lanes: [lane('D2', { note: null }), lane('D15', { note: null })], issues: [pi] });
    const m = buildFlow({ snap, projectId: 'p1', subagents: {}, selected: null, now: 0, tr: VI, live: false });
    const d = (n: string) => m.nodes.find(x => x.id === `lane:${n}`)?.data as LaneData;
    expect(d('D2').issue).toEqual({ key: 'T-47', unseen: false });
    expect(d('D15').issue).toEqual({ key: 'B-50', unseen: true });
    expect(d('D2').line2).toEqual({ kind: 'text', text: 'Màn Graph code' });
  });
  test('§5.0 kind label: "Build · v2.5" on its spec, "Thiết kế", "Chung" only beside another kind', () => {
    const b: OrchestratorView = { ...snapshot().orchestrators[0]!, sessionId: 's-b', orchKind: 'build' };
    const g: OrchestratorView = { ...b, sessionId: 's-g', orchKind: 'general' }, d: OrchestratorView = { ...b, sessionId: 's-d', orchKind: 'design' };
    expect(orchKindLabel(VI, b, [b, g], pi)).toBe('Build · v2.5');
    expect(orchKindLabel(VI, g, [b, g], pi)).toBe('Chung');
    expect(orchKindLabel(VI, g, [g], pi)).toBeNull();
    expect(orchKindLabel(VI, d, [d, g], pi)).toBe('Thiết kế');
    const snap = snapshot({ orchestrators: [b, g, d], issues: [pi] });
    const m = buildFlow({ snap, projectId: 'p1', subagents: {}, selected: null, now: 0, tr: VI, live: false });
    expect(m.nodes.filter(n => n.type === 'orchestrator').map(n => (n.data as OrchData).kindLabel)).toEqual(['Build · v2.5', 'Chung', 'Thiết kế']);
  });
  test('v2.9 §4.7 the kind label is the step name of the session rev (Spec + Plan: "Plan"); Chung stays the catalog word', () => {
    const wf = { rev: 'r', name: 'Spec + Plan', step: 'plan', stepName: 'Plan', deny: [], rules: [], maxDoc: 3 };
    const d: OrchestratorView = { ...snapshot().orchestrators[0]!, sessionId: 's-x', orchKind: 'design', wf };
    const g: OrchestratorView = { ...d, sessionId: 's-g', orchKind: 'general', wf: { ...wf, step: 'general', stepName: 'Điều phối' } };
    expect(orchKindLabel(VI, d, [d, g], pi)).toBe('Plan');
    expect(orchKindLabel(VI, g, [d, g], pi)).toBe('Chung');
  });
  test('§4.7 UX-I1 a Thiết kế node is named by its session title ("Thiết kế · 15:02"); beside a kind chip the others read "Điều phối" (mockup); no title twice', () => {
    const b: OrchestratorView = { ...snapshot().orchestrators[0]!, sessionId: 's-b', seq: 1, orchKind: 'build', title: 'Build · v2.5 Toolkit graph' };
    const g: OrchestratorView = { ...b, sessionId: 's-g', seq: 2, orchKind: 'general', title: 'hotfix' };
    const d: OrchestratorView = { ...b, sessionId: 's-d', seq: 3, orchKind: 'design', title: 'Thiết kế · 15:02' };
    const m = buildFlow({ snap: snapshot({ orchestrators: [b, g, d], issues: [pi] }), projectId: 'p1', subagents: {}, selected: null, now: 0, tr: VI, live: false });
    const os = m.nodes.filter(n => n.type === 'orchestrator').map(n => n.data as OrchData);
    expect(os.map(o => [o.name, o.title, o.kindLabel])).toEqual([['Điều phối', null, 'Build · v2.5'], ['Điều phối', 'hotfix', 'Chung'], ['Thiết kế · 15:02', null, 'Thiết kế']]);
    expect(os.map(o => o.aria.split(' · ')[0])).toEqual(['Điều phối #1', 'Điều phối #2', 'Điều phối #3']); // the #n stays for VoiceOver
    const solo = buildFlow({ snap: snapshot({ orchestrators: [{ ...g, orchKind: 'general' }, { ...g, sessionId: 's-g2', seq: 3, orchKind: 'general', title: null }] }), projectId: 'p1', subagents: {}, selected: null, now: 0, tr: VI, live: false });
    expect(solo.nodes.filter(n => n.type === 'orchestrator').map(n => (n.data as OrchData).name)).toEqual(['Điều phối #2', 'Điều phối #3']); // pre-v2.7 Chung only: no chip, #n
  });
  test('§4.7 UX-I1 with a kind chip the account sits on the token line (v2.1 I5: always shown); without one it stays on line 1', () => {
    const b: OrchestratorView = { ...snapshot().orchestrators[0]!, sessionId: 's-b', seq: 1, orchKind: 'build', account: 'pm@x-io.test' };
    const g: OrchestratorView = { ...b, sessionId: 's-g', seq: 2, orchKind: 'general' };
    const nodes = (os: OrchestratorView[]) => buildFlow({ snap: snapshot({ orchestrators: os, issues: [pi] }), projectId: 'p1', subagents: {}, selected: null, now: 0, tr: VI, live: false })
      .nodes.filter(n => n.type === 'orchestrator');
    const lines = (n: ReturnType<typeof nodes>[number]) => html(<OrchCard id={n.id} d={n.data as OrchData} />).split('<div class="r').slice(1).map(plain);
    const [chip] = nodes([b, g]);
    expect(lines(chip!)[0]).toContain('Build · v2.5');
    expect(lines(chip!)[0]).not.toContain('pm@');
    expect(lines(chip!).at(-1)).toContain('pm@');
    const [solo] = nodes([g]);
    expect(lines(solo!)[0]).toContain('pm@');
  });
  test('§4.7 UX N1 (was UX-I1) on a session node the name never clips ("Thiết kế · 05:40"); the kind chip ellipsises (full kind in its title), the account gives way (flow.css)', () => {
    const css = readFileSync('web/src/deck/flow/flow.css', 'utf8');
    expect(css).toContain('.deck .orch .id.sans{flex:none;max-width:100%}');
    expect(css).toContain('.deck .orch .okind{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}');
    expect(css).toMatch(/\.deck \.orch \.acct\{flex:0 1000 auto;/);
  });
  test('§4.2-4 goPatch: the spec + issue of the trace; arising only from the issues_new card (IS3b), cleared by any other', () => {
    expect(goPatch({ sel: 'outside', issue: 'T-1' })).toEqual({ sel: 'outside', issue: 'T-1', arising: false });
    expect(goPatch({ sel: { spec: 2 }, issue: null, arising: true })).toEqual({ sel: { spec: 2 }, issue: null, arising: true });
    expect(goPatch({})).toEqual({ arising: false });
  });
  test('§4.2-1 specShort: the version, else the title cut at 16', () => {
    expect(specShort('v2.5 Toolkit graph')).toBe('v2.5');
    expect(specShort('Thông báo điện thoại di động')).toBe('Thông báo điện …');
  });
  test('§4.2 Deck → Tasks targets: an issue (its spec), ≥ 2 unseen → the newest one\'s spec filtered to Phát sinh', () => {
    expect(goIssue(pi, 'B-50')).toEqual({ sel: { spec: 1 }, issue: 'B-50' });
    expect(goIssue(projIssues([], [issueInfo(9, { specId: null })]), 'T-9')).toEqual({ sel: 'outside', issue: 'T-9' });
    expect(goIssue(pi, 'T-999')).toEqual({});
    expect(goArising(pi, null)).toEqual({ sel: { spec: 1 }, issue: null, arising: true });
    expect(goArising(pi, 'T-47')).toEqual({ sel: { spec: 1 }, issue: 'T-47' });
  });
});

describe('§4.2-4 / §7.3 / §5.7-5 the issue cards (+ §8 remote)', () => {
  const act = (id: string, label: string) => ({ id, label });
  const one = card(1, { kind: 'issues_new', source: null, titleKey: 'cards.issuesNewOne', params: { key: 'B-50', title: 'Daemon CBM không tắt khi đóng app' }, actions: [act('issues_view', 'Xem')], title: '' });
  const many = card(2, { kind: 'issues_new', source: null, titleKey: 'cards.issuesNewMany', params: { n: 2 }, actions: [act('issues_view', 'Xem')], title: '' });
  const sp = card(3, { kind: 'superpowers_off', source: null, titleKey: 'cards.superpowersOff', bodyKey: 'cardText.body.superpowersOff', actions: [act('open_skills', 'Mở Skills & MCP')], title: '' });
  const rc = card(4, { kind: 'revert_conflict', source: null, titleKey: 'cards.revertConflict', params: { key: 'T-46', blocker: 'T-53' },
    actions: [{ id: 'revert_keep', label: 'Giữ T-46', labelKey: 'cardText.act.keepIssue', labelParams: { key: 'T-46' } }, act('revert_cancel_both', 'Huỷ cả hai…')], title: '' });
  const row = (c: CardView, over: Partial<CardRowProps> = {}) => html(CardRow({ c, tr: VI, focused: false, isNew: false, channel: 'mac', offline: false, sessions: 1, undo: null,
    onChoose: () => {}, onUndo: () => {}, onAction: () => {}, onOpen: () => {}, ...over }));
  test('§4.2-4 one unseen: the orange key where a lane code sits, the full title, a "Xem" text button', () => {
    const h = row(one);
    expect(h).toContain('<span class="src am">B-50</span>');
    expect(h).toContain('title="Daemon CBM không tắt khi đóng app"');
    expect(plain(h)).toContain('B-50 Daemon CBM không tắt khi đóng app');
    expect(h).toContain('class="rb acc"');
    expect(rowTone(one)).toBe('info');
  });
  test('§4.2-4 ≥ 2 unseen: "2 việc phát sinh" in orange, no key', () => {
    expect(rowText(VI, many)).toEqual({ text: '2 việc phát sinh', am: true });
    expect(row(many)).toContain('<span class="tt am"');
  });
  test('§7.3 superpowers_off: red, two lines — "Mở Skills & MCP" + the body', () => {
    const h = row(sp);
    expect(rowTone(sp)).toBe('bad');
    expect(h).toContain('card bad two');
    expect(plain(h)).toContain('Engine Chưa bật superpowers — lane mới phải chờ');
    expect(plain(h)).toContain('Mở Skills &amp; MCP Lane đang chạy không bị ảnh hưởng');
  });
  test('§5.7-5 revert_conflict: red, "⌥1 Giữ T-46" first (default), "Huỷ cả hai…" red; ⌥1 runs Giữ', () => {
    const h = row(rc);
    expect(rowTone(rc)).toBe('bad');
    expect(h.indexOf('rb def')).toBeLessThan(h.indexOf('rb red'));
    expect(plain(h)).toContain('⌥1 Giữ T-46 Huỷ cả hai…');
    const k = { pending: [one, rc], focusId: 4, boxId: null, otherModal: false, offline: false };
    expect(keyAct(k, 1)).toEqual({ id: 4, action: 'revert_keep' });
    expect(keyAct(k, 2)).toBeNull();
    expect(keyAct({ ...k, focusId: 1 }, 1)).toBeNull();
    expect(keyAct({ ...k, offline: true }, 1)).toBeNull();
  });
  test('§5.7-5 UX-M11 a two-line card\'s title wraps (≤ 2 lines) instead of clipping (inbox.css)', () => {
    expect(readFileSync('web/src/ui/inbox.css', 'utf8')).toMatch(/#inbox \.card\.two \.tt\{white-space:normal;[^}]*-webkit-line-clamp:2/);
  });
  test('§8 remote (no actions on the wire): Xem hidden, revert buttons hidden + "trả lời trên Mac"', () => {
    expect(issueRow({ ...one, actions: [] })).toEqual({ k: 'none' });
    expect(row({ ...one, actions: [] })).not.toContain('rb acc');
    const r = row({ ...rc, actions: [] }, { channel: 'remote' });
    expect(r).not.toContain('Giữ');
    expect(plain(r)).toContain('trả lời trên Mac');
  });
});

describe('§4.5 IS7 issue keys in chat', () => {
  const iss: MdIssueHooks = { has: k => k === 'B-51' || k === 'T-47', unseen: k => k === 'B-51', open: () => {} };
  test('§4.5 the project\'s keys split out; unknown keys stay text', () => {
    expect(splitKeys('Ghi B-51 (ngoài spec), xem T-47 và B-99.', iss.has)).toEqual(['Ghi ', { key: 'B-51' }, ' (ngoài spec), xem ', { key: 'T-47' }, ' và B-99.']);
  });
  test('§4.5 under MdIssueContext a key (also in backticks) is a chip button, orange when unseen; chat elsewhere unchanged', () => {
    const md = <Markdown text={'Ghi B-51 rồi `T-47`, còn T-1 thì không.'} />;
    const h = html(<MdIssueContext.Provider value={iss}>{md}</MdIssueContext.Provider>);
    expect(h).toContain('<button type="button" class="ich am" title="Mở B-51 ở Tasks">B-51</button>');
    expect(h).toContain('class="ich" title="Mở T-47 ở Tasks">T-47</button>');
    expect(h).not.toContain('>T-1</button>');
    expect(html(md)).not.toContain('<button');
  });
});

describe('§4.6 tool rows: cc-slaves labels, the blocked Skill', () => {
  const call = (name: string, over: Partial<ToolCall> = {}): ToolCall => ({ id: name, name, arg: '', state: 'ok', ms: 10, ...over });
  const mcp = (tool: string, input: unknown, over: Partial<ToolCall> = {}) => call(`mcp__cc_slaves__${tool}`, { input: JSON.stringify(input), ...over });
  test('§4.6 every engine MCP tool has a Vietnamese label (no tool name shown)', () => {
    const src = ['tools', 'issue-tools', 'spec-tools'].map(f => readFileSync(`engine/src/mcp/${f}.ts`, 'utf8')).join('\n');
    const names = [...src.matchAll(/name: '([a-z_]+)', roles/g)].map(m => m[1]!);
    expect(names.length).toBeGreaterThan(25);
    for (const n of names) expect([n, ccsLabel(mcp(n, {}))?.key ?? null]).not.toEqual([n, null]);
  });
  test('§4.6 labels: đọc mục T-47 · báo xong T-47 · ghi việc phát sinh B-50 · mở lane D2; another server keeps v2.2', () => {
    const name = (c: ToolCall) => plain(html(<ToolRow call={c} />));
    expect(name(mcp('issue_get', { key: 'T-47' }))).toBe('đọc mục T-47');
    expect(name(mcp('issue_done', { key: 'T-47', summary: 'x' }))).toBe('báo xong T-47');
    expect(name(mcp('issue_create', { title: 'CBM' }, { result: '{"key":"T-50","state":"todo"}' }))).toBe('ghi việc phát sinh T-50');
    expect(name(mcp('issue_create', { title: 'CBM' }, { state: 'running' }))).toBe('ghi việc phát sinh …');
    expect(name(mcp('lane_start', { name: 'D2', cwd: '/w' }))).toBe('mở lane D2');
    expect(name(mcp('issue_assign', { key: 'T-44', lane: 'D2' }))).toBe('giao T-44 cho D2');
    expect(name(call('mcp__context7__resolve', { input: '{"q":"react"}' }))).toContain('resolve');
    expect(ccsLabel(call('mcp__context7__lane_start'))).toBeNull();
  });
  test('§4.6 UX-I9 issue_create wording by kind / source: a PO bug is "bug", never "việc phát sinh"', () => {
    const name = (inp: object) => plain(html(<ToolRow call={mcp('issue_create', { title: 'x', ...inp }, { result: '{"key":"B-51"}' })} />));
    expect(name({ kind: 'bug', source: 'po' })).toBe('ghi bug ngoài spec B-51');
    expect(name({ kind: 'bug', source: 'po', spec: 'docs/specs/v2.5.md' })).toBe('ghi bug B-51');
    expect(name({ kind: 'bug' })).toBe('ghi bug ngoài spec B-51');
    expect(name({ source: 'spec', spec: 'v2.5' })).toBe('ghi mục B-51');
    expect(name({ source: 'po' })).toBe('ghi mục B-51');
    expect(name({ source: 'prior', state: 'done' })).toBe('ghi mục B-51');
    expect(name({ source: 'orchestrator' })).toBe('ghi việc phát sinh B-51');
    expect(name({})).toBe('ghi việc phát sinh B-51');
  });
  const hook = 'PreToolUse:Skill hook error: Bị chặn có chủ ý — phiên Build: spec đã duyệt là thiết kế; thiếu gì hỏi po_ask.';
  test('§4.6 R-B5 a refused Skill: both text forms; a real Skill error / another tool is not', () => {
    expect(blockedSkill(call('Skill', { state: 'error', result: hook }))).toEqual({ reason: 'phiên Build: spec đã duyệt là thiết kế; thiếu gì hỏi po_ask.' });
    expect(blockedSkill(call('Skill', { state: 'error', result: 'Skill execution blocked by permission rules' }))).toEqual({ reason: null });
    expect(blockedSkill(call('Skill', { state: 'error', result: 'Unknown skill: foo' }))).toBeNull();
    expect(blockedSkill(call('Skill', { state: 'ok', result: hook }))).toBeNull();
    expect(blockedSkill(call('Bash', { state: 'error', result: hook }))).toBeNull();
  });
  test('§4.6 the blocked row is grey ⊘ "bị chặn · chính sách cc-slaves" + why, never red; a real error stays red', () => {
    const h = html(<ToolRow call={call('Skill', { arg: 'superpowers:writing-plans', state: 'error', result: hook })} />);
    expect(h).toContain('tr-blk');
    expect(plain(h)).toContain('bị chặn · chính sách cc-slaves phiên Build: spec đã duyệt là thiết kế');
    expect(h).not.toContain('tr-err');
    expect(html(<ToolRow call={call('Skill', { state: 'error', result: 'boom' })} />)).toContain('tr-err');
  });
  test('§4.6 "Ẩn công cụ" hides a blocked Skill like any done tool, keeps a real error', () => {
    const items = [call('Skill', { state: 'error', result: hook }), call('Bash', { state: 'error', result: 'exit 1' })];
    expect(hideTools(items, c => c).map(x => (x.k === 'count' ? `n${x.n}` : x.item.name))).toEqual(['n1', 'Bash']);
  });
});

describe('§5.0 R34 the session cap from the view; ⌘K Tasks', () => {
  const o = (sessionId: string, orchKind: OrchestratorView['orchKind']): OrchestratorView => ({ ...snapshot().orchestrators[0]!, sessionId, seq: 1, orchKind });
  const menu = (os: OrchestratorView[]) => orchActions(os[0]!, { tr: VI, snap: snapshot({ orchestrators: os }), offline: false, current: null } as never).find(i => i.id === 'parallel')!;
  test('§5.0 R34 three Chung sessions (pre-v2.7) do not reach the cap; Chung + 3 Thiết kế / Build do', () => {
    expect(menu([o('a', 'general'), o('b', 'general'), o('c', 'general')]).disabled).toBeUndefined();
    expect(menu([o('a', 'general'), o('b', 'build'), o('c', 'design'), o('d', 'design')]).disabled).toBe('Đã đủ 3 phiên Thiết kế / Build — đóng bớt một phiên');
  });
  test('G4-0 ⑥ ⌘K has a Tasks entry on the Mac channel only', () => {
    const ids = (channel: 'mac' | 'remote') => buildItems(VI, snapshot({ channel }), { projectId: 'p1', keys: [], selectedLane: null, sessionId: null } as never).map(i => i.id);
    expect(ids('mac')).toContain('mode:tasks');
    expect(ids('remote')).not.toContain('mode:tasks');
  });
});

describe('§4.7 UX-I11 a new Thiết kế session: its name, empty state, placeholder', () => {
  const o = (over: Partial<OrchestratorView>): OrchestratorView => ({ ...snapshot().orchestrators[0]!, sessionId: 's-d', seq: 3, ...over });
  const ln = (kind: 'po' | 'engine' | 'assistant') => ({ seq: 1, ts: 0, kind, text: 'x' });
  test('§4.7 rootName: a Thiết kế session by its title, else "Điều phối #n"', () => {
    expect(rootName(VI, o({ orchKind: 'design', title: 'Thiết kế · 15:02' }), true)).toBe('Thiết kế · 15:02');
    expect(rootName(VI, o({ orchKind: 'design', title: null }), true)).toBe('Điều phối #3');
    expect(rootName(VI, o({ orchKind: 'build', title: 'Build · v2.5' }), true)).toBe('Điều phối #3');
  });
  test('§4.7 designFresh: a Thiết kế session with no PO message yet (the engine\'s first line does not count)', () => {
    expect(designFresh(o({ orchKind: 'design' }), [])).toBe(true);
    expect(designFresh(o({ orchKind: 'design' }), [ln('engine'), ln('assistant')])).toBe(true);
    expect(designFresh(o({ orchKind: 'design' }), [ln('engine'), ln('po')])).toBe(false);
    expect(designFresh(o({ orchKind: 'general' }), [])).toBe(false);
    expect(designFresh(null, [])).toBe(false);
  });
  test('§4.7 the empty state text renders under the lines (vi + en)', () => {
    const conv = (lang: 'vi' | 'en') => plain(renderToStaticMarkup(<LangProvider lang={lang}><Conversation stream={{ lines: [], atTail: true, hasOlder: false, newer: false }}
      hideTools={false} color="#fff" designNew onOlder={() => {}} onJumpEnd={() => {}} /></LangProvider>));
    expect(conv('vi')).toBe('Phiên Thiết kế mới. Kể ý tưởng — Điều phối hỏi lại từng điểm, rồi viết spec + mockup để anh đọc và duyệt.');
    expect(conv('en')).toContain('New Design session.'); // v2.9 §4.7 {design} = the step name (en default "Design")
  });
});
