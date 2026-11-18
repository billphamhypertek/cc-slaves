import { describe, expect, test } from 'bun:test';
import { insertProject, insertSession, openDb } from '../../src/db.ts';
import { LineStore, poWritten, toLines } from '../../src/server/lines.ts';
import { RESULT_MAX } from '../../src/server/tool-detail.ts';
import { parseLine } from '../../src/stream/parser.ts';

const ev = (o: object) => parseLine(JSON.stringify(o));
/** v2.4 §10.2 a replay SessionProcess found in the outbox (`ours`). */
const mine = (o: object) => Object.assign(ev(o), { ours: true });
const asst = (content: unknown[], parent: string | null = null) =>
  ev({ type: 'assistant', parent_tool_use_id: parent, message: { role: 'assistant', content } });

describe('toLines (§6.3 U3 one line per block)', () => {
  test('assistant text and a tool_use folded to "Bash: <command>"', () => {
    const l = toLines(asst([{ type: 'text', text: 'Xin chào' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git log\n--oneline' } }]));
    expect(l).toEqual([
      { kind: 'assistant', text: 'Xin chào', parentToolUseId: null },
      { kind: 'tool_use', text: 'Bash: git log --oneline', tool: 'Bash', parentToolUseId: null, toolUseId: 't1', input: '{"command":"git log\\n--oneline"}' },
    ]);
  });
  test('a subagent message (parent_tool_use_id set) is kind subagent', () => {
    expect(toLines(asst([{ type: 'text', text: 'x' }], 'toolu_1'))[0]!.kind).toBe('subagent');
  });
  test('replayed user line of ours: PO prefix → po without "[PO] " (R3), [cc-slaves] → engine; tool_result truncated', () => {
    expect(toLines(mine({ type: 'user', isReplay: true, uuid: 'u', message: { role: 'user', content: '[PO] làm tiếp' } }))[0])
      .toEqual({ kind: 'po', text: 'làm tiếp', parentToolUseId: null });
    expect(toLines(mine({ type: 'user', isReplay: true, uuid: 'u', message: { role: 'user', content: '[cc-slaves] nối lại' } }))[0]!.kind).toBe('engine');
    const long = 'y'.repeat(1000);
    const r = toLines(ev({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: long }] } }));
    expect(r[0]!.kind).toBe('tool_result');
    expect(r[0]!.text.length).toBeLessThanOrEqual(300);
  });
});

const user = (content: unknown[]) => ev({ type: 'user', message: { role: 'user', content } });
const tool = (name: string, input: object) => toLines(asst([{ type: 'tool_use', id: 'tu', name, input }]))[0]!;

describe('§14.4 keys + fuller tool rows', () => {
  test('§14.4 toLines puts the stamped key on the line of each content block', () => {
    const l = toLines(asst([{ type: 'text', text: 'a' }, { type: 'tool_use', id: 't', name: 'Read', input: {} }]), ['m:1', undefined]);
    expect(l[0]!.key).toBe('m:1');
    expect('key' in l[1]!).toBe(false);
  });
  test('§14.4 a thinking block takes its key slot (keys align with content, not with lines)', () => {
    const l = toLines(asst([{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'a' }]), ['m:0', 'm:1']);
    expect(l).toHaveLength(1);
    expect(l[0]!.key).toBe('m:1');
  });
  test('§14.4 tool_use input: long string values cut, JSON ≤ 2 KB', () => {
    const l = tool('Write', { file_path: '/a/b.ts', content: 'x\n'.repeat(5000) });
    expect(new TextEncoder().encode(l.input).length).toBeLessThanOrEqual(2048);
    expect(JSON.parse(l.input!).file_path).toBe('/a/b.ts');
  });
  test('§14.4 Edit +n −m from the input (line diff)', () => {
    expect(tool('Edit', { file_path: '/f', old_string: 'a\nb\nc', new_string: 'a\nB\nc\nd' }).diff).toEqual({ add: 2, del: 1 });
  });
  test('§14.4 Write +n −0 and MultiEdit sums its edits', () => {
    expect(tool('Write', { file_path: '/f', content: 'a\nb\n' }).diff).toEqual({ add: 2, del: 0 });
    expect(tool('MultiEdit', { file_path: '/f', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'x\ny', new_string: '' }] }).diff)
      .toEqual({ add: 1, del: 3 });
  });
  test('§14.4 other tools carry no diff', () => {
    expect('diff' in tool('Bash', { command: 'ls' })).toBe(false);
  });
  test('§14.4 tool_result keeps toolUseId, isError and its newlines; text stays the one-line summary', () => {
    const r = toLines(user([{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'l1\nl2' }, { type: 'text', text: 'l3' }] }]))[0]!;
    expect(r).toMatchObject({ kind: 'tool_result', toolUseId: 't1', isError: true, result: 'l1\nl2\nl3', text: 'l1 l2 l3' });
    expect('truncated' in r).toBe(false);
  });
  test('§14.5 S5 a failed Bash result "Exit code k" first line → exitCode k, the line leaves `result` (real Claude Code shape)', () => {
    const r = toLines(user([{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Exit code 1\nbun test v1.3.2\n(fail) x' }]))[0]!;
    expect(r).toMatchObject({ exitCode: 1, result: 'bun test v1.3.2\n(fail) x', isError: true });
    expect(toLines(user([{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'Exit code 137' }]))[0]).toMatchObject({ exitCode: 137, result: '' });
  });
  test('§14.5 S5 no exitCode: a successful result, or a first line that is more than "Exit code k"', () => {
    expect(toLines(user([{ type: 'tool_result', tool_use_id: 't', content: 'Exit code 1\nfine' }]))[0]!.exitCode).toBeUndefined();
    expect(toLines(user([{ type: 'tool_result', tool_use_id: 't', is_error: true, content: 'Exit code 1 maybe\nx' }]))[0]!.exitCode).toBeUndefined();
    expect(toLines(user([{ type: 'tool_result', tool_use_id: 't', is_error: true, content: 'boom' }]))[0]).toMatchObject({ result: 'boom' });
  });
  test('§14.4 tool_result over 8 KB is cut + truncated + the total line count', () => {
    const long = Array.from({ length: 1240 }, (_, i) => `dòng ${i} ệệệ`).join('\n');
    const r = toLines(user([{ type: 'tool_result', tool_use_id: 't', content: long }]))[0]!;
    expect(RESULT_MAX).toBe(8 * 1024);
    expect(new TextEncoder().encode(r.result).length).toBeLessThanOrEqual(RESULT_MAX);
    expect(r.result!.includes('�')).toBe(false);
    expect(long.startsWith(r.result!)).toBe(true);
    expect(r).toMatchObject({ truncated: true, totalLines: 1240, isError: false });
  });
  test('§14.4 a result of exactly 8 KB is not truncated', () => {
    const r = toLines(user([{ type: 'tool_result', tool_use_id: 't', content: 'a'.repeat(RESULT_MAX) }]))[0]!;
    expect(r.result!.length).toBe(RESULT_MAX);
    expect('truncated' in r).toBe(false);
  });
});

describe('LineStore (§8.4 lines in state.db, paged)', () => {
  const setup = () => {
    const db = openDb(':memory:');
    insertProject(db, { id: 'p', name: 'P', path: '/p' });
    insertSession(db, { id: 's1', projectId: 'p', kind: 'orchestrator', account: null });
    insertSession(db, { id: 's2', projectId: 'p', kind: 'orchestrator', account: null });
    return { db, store: new LineStore(db, () => 100) };
  };
  test('append assigns increasing seq; page returns newest-last before a seq', () => {
    const { store } = setup();
    const all = Array.from({ length: 10 }, (_, i) => store.append('s1', [{ kind: 'assistant', text: `l${i}`, parentToolUseId: null }])[0]!);
    expect(all.map((l) => l.seq)).toEqual([...all.map((l) => l.seq)].sort((a, b) => a - b));
    const last3 = store.page(['s1'], undefined, 3);
    expect(last3.map((l) => l.text)).toEqual(['l7', 'l8', 'l9']);
    const before = store.page(['s1'], last3[0]!.seq, 3);
    expect(before.map((l) => l.text)).toEqual(['l4', 'l5', 'l6']);
    expect(before[0]!.ts).toBe(100);
  });
  test('§5.3 a line `ts` is epoch ms like every other event row (default clock)', () => {
    const db = openDb(':memory:');
    insertProject(db, { id: 'p', name: 'P', path: '/p' });
    insertSession(db, { id: 's1', projectId: 'p', kind: 'orchestrator', account: null });
    const t0 = Date.now();
    const [l] = new LineStore(db).append('s1', [{ kind: 'assistant', text: 'x', parentToolUseId: null }]);
    expect(l!.ts).toBeGreaterThanOrEqual(t0);
  });
  test('page spans several sessions (orchestrator after F21) and caps limit at 500', () => {
    const { store } = setup();
    store.append('s1', [{ kind: 'assistant', text: 'a', parentToolUseId: null }]);
    store.append('s2', [{ kind: 'assistant', text: 'b', parentToolUseId: null }]);
    expect(store.page(['s1', 's2'], undefined, 10).map((l) => l.text)).toEqual(['a', 'b']);
    for (let i = 0; i < 600; i++) store.append('s1', [{ kind: 'assistant', text: `${i}`, parentToolUseId: null }]);
    expect(store.page(['s1'], undefined, 10_000).length).toBe(500);
  });
});

describe('v2.4 §4.3 Claude Code\'s own "Set model to" replay', () => {
  test('§4.3 the <local-command-stdout>Set model to …</local-command-stdout> replay has no line (the engine line says it once)', () => {
    const replay = (content: unknown) => ev({ type: 'user', uuid: 'u-foreign', isReplay: true, parent_tool_use_id: null, message: { role: 'user', content } });
    expect(toLines(replay('<local-command-stdout>Set model to Sonnet 5.5</local-command-stdout>'))).toEqual([]);
    expect(toLines(replay([{ type: 'text', text: '<local-command-stdout>Set model to Haiku 5.5</local-command-stdout>' }]))).toEqual([]);
    expect(toLines(Object.assign(replay('Set model to the bigger one, please'), { ours: true }))).toMatchObject([{ kind: 'po' }]); // a PO sentence (ours) stays
  });
});

describe('v2.4 §6.6 / §10.2 replayed user lines: only ours become conversation lines', () => {
  const rep = (content: unknown, ours?: boolean) => {
    const e = ev({ type: 'user', isReplay: true, uuid: 'x', message: { role: 'user', content } });
    return toLines(ours ? Object.assign(e, { ours }) : e);
  };
  test('§6.6 a foreign uuid (skill body, <command-message> blocks) never becomes a po line', () => {
    expect(rep('[PO] trông như của PO')).toEqual([]);
    expect(rep([{ type: 'text', text: '<command-message>find-skills</command-message>' }, { type: 'text', text: 'Base directory for this skill: …' }])).toEqual([]);
  });
  test('§6.6 R7 the synthetic user line /compact emits (foreign uuid) is no po line', () => {
    const e = ev({ type: 'user', isReplay: true, isSynthetic: true, uuid: 'x', message: { role: 'user', content: 'This session is being continued from a previous conversation…' } });
    expect(toLines(e)).toEqual([]);
  });
  test('§6.6 <local-command-stdout> of a foreign uuid → one system line with the inner text', () => {
    expect(rep('<local-command-stdout>Context: 12k / 200k</local-command-stdout>')).toEqual([{ kind: 'system', text: 'Context: 12k / 200k', parentToolUseId: null }]);
    expect(rep([{ type: 'text', text: '<local-command-stdout>Đã nén</local-command-stdout>' }])).toEqual([{ kind: 'system', text: 'Đã nén', parentToolUseId: null }]);
    expect(rep('<local-command-stdout></local-command-stdout>')).toEqual([]);
  });
  test('§4.3 "Set model to" stays dropped (the engine has its own line)', () => {
    expect(rep('<local-command-stdout>Set model to Sonnet</local-command-stdout>')).toEqual([]);
  });
  test('§10.2 ours: text blocks only (an image block is never read); a bare "[PO]" (attachments only) → empty text', () => {
    expect(rep([{ type: 'text', text: '[PO]' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }], true))
      .toEqual([{ kind: 'po', text: '', parentToolUseId: null }]);
    expect(rep('/compact', true)).toEqual([{ kind: 'po', text: '/compact', parentToolUseId: null }]);
  });
});

describe('v2.6 §4.8 / §10.3 the "giữ lại" label in state.db', () => {
  const setup = () => {
    const db = openDb(':memory:');
    insertProject(db, { id: 'p', name: 'P', path: '/p' });
    insertSession(db, { id: 's1', projectId: 'p', kind: 'orchestrator', account: null });
    return new LineStore(db, () => 100);
  };
  const po = (text: string) => ({ kind: 'po' as const, text, parentToolUseId: null, held: true as const });

  test('unhold(seqs) drops `held` from those lines only, the rest of the line kept', () => {
    const store = setup();
    const [a, b] = store.append('s1', [po('a'), po('b')]);
    store.unhold([a!.seq]);
    expect(store.page(['s1'])).toEqual([{ kind: 'po', text: 'a', parentToolUseId: null, seq: a!.seq, ts: 100 }, { ...b! }]);
  });

  test('unhold() (boot: the hold lives in memory only, §5.4-8) drops every label', () => {
    const store = setup();
    store.append('s1', [po('a'), po('b'), { kind: 'assistant', text: 'c', parentToolUseId: null }]);
    store.unhold();
    expect(store.page(['s1']).map((l) => 'held' in l)).toEqual([false, false, false]);
  });

  test('poWritten: the stored lines lose the label, then watchers get `po_written {target, seqs}`', () => {
    const store = setup();
    const [a] = store.append('s1', [po('a')]);
    const sent: unknown[] = [];
    const t = { kind: 'orchestrator', projectId: 'p' } as const;
    poWritten({ lines: store, hub: { broadcast: (e: unknown) => { expect(store.page(['s1'])[0]!.held).toBeUndefined(); sent.push(e); } } }, t, [a!.seq]);
    expect(sent).toEqual([{ type: 'po_written', target: t, seqs: [a!.seq] }]);
  });
});
