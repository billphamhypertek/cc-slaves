// v2.7 §7.2 / §7.3, v2.9 §10.1 skill policy per pinned step: deny rules, the PreToolUse skill-gate hook reading the session's
// `.tsv` (R-B5, R-B9), §5.8 missingPlugin.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  missingPlugin, missingPluginKnown, removeSkillDeny, skillDenyPath, skillGatePath, skillSettings, writeSkillDeny, writeSkillGate,
} from '../../src/session/skills.ts';
import type { CompiledStep } from '../../src/workflow/compile.ts';
import { stepOf } from '../../src/workflow/runtime.ts';
import type { StepType } from '../../src/workflow/vocab.ts';
import { PO } from '../_fixtures/po-pack.ts';

let tmp: string;
const saved = process.env.CC_SLAVES_HOME;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'ccs-skills-')); process.env.CC_SLAVES_HOME = join(tmp, 'home'); });
afterEach(() => {
  if (saved === undefined) delete process.env.CC_SLAVES_HOME; else process.env.CC_SLAVES_HOME = saved;
  rmSync(tmp, { recursive: true, force: true });
});

const ALWAYS = ['writing-plans', 'executing-plans', 'finishing-a-development-branch', 'using-git-worktrees', 'subagent-driven-development'];
const ALLOWED = ['test-driven-development', 'systematic-debugging', 'verification-before-completion', 'requesting-code-review',
  'receiving-code-review', 'dispatching-parallel-agents'];

/** G0 measured hook stdin (NC §8): session_id, transcript_path, cwd, permission_mode, tool_name, tool_input {skill}. */
const stdin = (skill: string, args?: string) => JSON.stringify({
  session_id: 'c7af68b9-0000', transcript_path: '/tmp/x/c7af68b9.jsonl', cwd: '/tmp/x', permission_mode: 'bypassPermissions',
  hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill, ...(args !== undefined ? { args } : {}) },
});
const KINDS = ['design', 'build', 'general', 'lane'] as const;
const step = (k: StepType): CompiledStep => stepOf(PO, k)!;
/** The bare names a step of Quy trình PO denies. */
const forbidden = (k: StepType): string[] => step(k).deny.map((d) => /^Skill\(superpowers:(.*)\)$/.exec(d)![1]!);
/** The gate run as claude runs it for session `k` (its `.tsv` written from its step). */
function runGate(k: string, input: string): { code: number; out: string } {
  const r = Bun.spawnSync(['sh', skillGatePath(), skillDenyPath(k)], { stdin: Buffer.from(input), stdout: 'pipe', stderr: 'pipe' });
  return { code: r.exitCode, out: r.stdout.toString() };
}
const gateFor = () => { writeSkillGate(); for (const k of KINDS) writeSkillDeny(k, step(k)); };

describe('§7.2 forbidden skills per step (Quy trình PO)', () => {
  test('§7.2 Thiết kế: brainstorming allowed; plans / worktrees / finishing / SDD forbidden', () => {
    expect(forbidden('design')).not.toContain('brainstorming');
    for (const s of ALWAYS) expect(forbidden('design')).toContain(s);
  });
  test('§7.2 Build, Chung, lane: brainstorming forbidden too; TDD / debugging / review skills never forbidden', () => {
    for (const k of KINDS) {
      for (const s of ALLOWED) expect(forbidden(k)).not.toContain(s);
      if (k === 'design') continue;
      for (const s of ['brainstorming', ...ALWAYS]) expect(forbidden(k)).toContain(s);
    }
  });
  test('v2.9 §10.1 settings per session: the step\'s deny forms + PreToolUse Skill hook → skill-gate.sh <the session\'s .tsv>', () => {
    for (const k of KINDS) {
      const s = skillSettings(`s-${k}`, step(k));
      expect(s.deny).toEqual(step(k).deny);
      const cmd = `'${join(tmp, 'home', 'hooks', 'skill-gate.sh')}' '${join(tmp, 'home', 'skill-deny', `s-${k}.tsv`)}'`;
      expect(s.hooks).toEqual({ PreToolUse: [{ matcher: 'Skill', hooks: [{ type: 'command', command: cmd }] }] });
    }
  });
  test('v2.9 §10.1 the .tsv is 0600 under <home>/skill-deny/ and goes with the session', () => {
    writeSkillDeny('s1', step('build'));
    expect(statSync(skillDenyPath('s1')).mode & 0o777).toBe(0o600);
    expect(readFileSync(skillDenyPath('s1'), 'utf8')).toBe(step('build').gate);
    removeSkillDeny('s1');
    expect(() => statSync(skillDenyPath('s1'))).toThrow();
  });
});

describe('§7.3 R-B9 skill-gate hook script', () => {
  test('§7.3 review-B MINOR-2 engine home with a space / quote: the hook command still runs the gate and denies with the reason', () => {
    process.env.CC_SLAVES_HOME = join(tmp, "a b'c", 'home');
    gateFor();
    const cmd = (skillSettings('build', step('build')).hooks.PreToolUse as { hooks: { command: string }[] }[])[0]!.hooks[0]!.command;
    const r = Bun.spawnSync(['sh', '-c', cmd], { stdin: Buffer.from(stdin('superpowers:writing-plans')), stdout: 'pipe', stderr: 'pipe' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain('Bị chặn có chủ ý — phiên Build');
  });
  test('R-B9 written under the engine home, mode 0700, rewritten on every boot', () => {
    writeSkillGate();
    const p = skillGatePath();
    expect(p).toBe(join(tmp, 'home', 'hooks', 'skill-gate.sh'));
    expect(statSync(p).mode & 0o777).toBe(0o700);
    writeFileSync(p, 'echo stale');
    writeSkillGate();
    expect(readFileSync(p, 'utf8')).toStartWith('#!/bin/sh');
    expect(statSync(p).mode & 0o777).toBe(0o700);
  });
  test('§7.3 forbidden skill (qualified or bare) → deny JSON with the kind\'s Vietnamese reason "Bị chặn có chủ ý — …"', () => {
    gateFor();
    const reasons = new Set<string>();
    for (const k of KINDS) {
      for (const skill of [`superpowers:${forbidden(k)[0]}`, forbidden(k)[0]!]) {
        const r = runGate(k, stdin(skill));
        expect(r.code).toBe(0);
        const j = JSON.parse(r.out) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } };
        expect(j.hookSpecificOutput.hookEventName).toBe('PreToolUse');
        expect(j.hookSpecificOutput.permissionDecision).toBe('deny');
        expect(j.hookSpecificOutput.permissionDecisionReason).toStartWith('Bị chặn có chủ ý — ');
        reasons.add(j.hookSpecificOutput.permissionDecisionReason);
      }
    }
    expect(reasons.size).toBe(KINDS.length); // one reason per kind
  });
  test('§7.2 build session: brainstorming denied; design session: brainstorming → no output, exit 0', () => {
    gateFor();
    expect(JSON.parse(runGate('build', stdin('superpowers:brainstorming')).out).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(runGate('design', stdin('superpowers:brainstorming'))).toEqual({ code: 0, out: '' });
  });
  test('§7.2 allowed skills, another plugin\'s same-named skill, no .tsv, garbage stdin → empty, exit 0', () => {
    gateFor();
    for (const s of ALLOWED) expect(runGate('lane', stdin(`superpowers:${s}`))).toEqual({ code: 0, out: '' });
    expect(runGate('build', stdin('other:brainstorming'))).toEqual({ code: 0, out: '' });
    expect(runGate('nope', stdin('superpowers:writing-plans'))).toEqual({ code: 0, out: '' });
    expect(runGate('build', 'not json')).toEqual({ code: 0, out: '' });
    expect(runGate('build', stdin('superpowers:writing')).out).toBe(''); // a prefix of a denied name is not that name
    // args text that only mentions a forbidden skill is not the skill being called
    expect(runGate('build', stdin('superpowers:systematic-debugging', 'like \\"skill\\": \\"writing-plans\\"'))).toEqual({ code: 0, out: '' });
  });
});

describe('v2.9 §10.1 a pack reason with `"`, `\\` and a tab', () => {
  test('v2.9 §10.1 the gate prints the .tsv JSON as written: still valid JSON with the exact reason', () => {
    writeSkillGate();
    const reason = 'Dùng "Plan" \\ không \there';
    const json = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
    writeSkillDeny('q', { gate: `x:plan\t${json}\nplan\t${json}\n` });
    for (const skill of ['x:plan', 'plan']) {
      expect(JSON.parse(runGate('q', stdin(skill)).out).hookSpecificOutput.permissionDecisionReason).toBe(reason);
    }
  });
});

describe('§5.8 missingPlugin', () => {
  const settings = (o: unknown) => { const p = join(tmp, 'settings.json'); mkdirSync(tmp, { recursive: true }); writeFileSync(p, JSON.stringify(o)); return p; };
  const none = { skills: [], plugins: [] };
  const SP = ['superpowers'];
  test('§5.8 nothing required → null, whatever the settings', () => {
    expect(missingPlugin([], none, join(tmp, 'missing.json'))).toBeNull();
  });
  test('§7.3 enabledPlugins superpowers@… = true and not off for lanes → null', () => {
    expect(missingPlugin(SP, none, settings({ enabledPlugins: { 'superpowers@claude-plugins-official': true } }))).toBeNull();
  });
  test('§7.3 superpowers false / missing / no settings file / bad JSON → "superpowers"', () => {
    expect(missingPlugin(SP, none, settings({ enabledPlugins: { 'superpowers@claude-plugins-official': false } }))).toBe('superpowers');
    expect(missingPlugin(SP, none, settings({ enabledPlugins: { 'other@x': true } }))).toBe('superpowers');
    expect(missingPlugin(SP, none, settings({}))).toBe('superpowers');
    expect(missingPlugin(SP, none, join(tmp, 'missing.json'))).toBe('superpowers');
    const p = join(tmp, 'bad.json'); writeFileSync(p, '{'); expect(missingPlugin(SP, none, p)).toBe('superpowers');
  });
  test('§7.3 superpowers on but in the project\'s lane plugin-off list (v2.2 §5.5) → missing', () => {
    const p = settings({ enabledPlugins: { 'superpowers@claude-plugins-official': true } });
    expect(missingPlugin(SP, { plugins: ['superpowers@claude-plugins-official'] }, p)).toBe('superpowers');
    expect(missingPlugin(SP, { plugins: ['other@x'] }, p)).toBeNull();
  });
  test('§5.8 the first missing of several is named', () => {
    const p = settings({ enabledPlugins: { 'superpowers@m': true } });
    expect(missingPlugin(['superpowers', 'gsd', 'x'], none, p)).toBe('gsd');
  });
  test('hf-sp missingPluginKnown: on → null, off / not listed / no settings file → its name, unreadable JSON → undefined (unknown)', () => {
    expect(missingPluginKnown(SP, none, settings({ enabledPlugins: { 'superpowers@m': true } }))).toBeNull();
    expect(missingPluginKnown(SP, none, settings({ enabledPlugins: { 'superpowers@m': false } }))).toBe('superpowers');
    expect(missingPluginKnown(SP, none, settings({}))).toBe('superpowers');
    expect(missingPluginKnown(SP, none, join(tmp, 'missing.json'))).toBe('superpowers');
    const p = join(tmp, 'bad.json'); writeFileSync(p, '{'); expect(missingPluginKnown(SP, none, p)).toBeUndefined();
    expect(missingPluginKnown([], none, p)).toBeNull();
  });
  test('§7.3 default settings path = <claudeHome>/settings.json', () => {
    const saveCh = process.env.CLAUDE_HOME;
    process.env.CLAUDE_HOME = join(tmp, 'ch');
    try {
      mkdirSync(join(tmp, 'ch'), { recursive: true });
      writeFileSync(join(tmp, 'ch', 'settings.json'), JSON.stringify({ enabledPlugins: { 'superpowers@m': true } }));
      expect(missingPlugin(SP, none)).toBeNull();
    } finally { if (saveCh === undefined) delete process.env.CLAUDE_HOME; else process.env.CLAUDE_HOME = saveCh; }
  });
});
