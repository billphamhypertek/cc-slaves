import { describe, expect, test } from 'bun:test';
import { cleanupLine, INSTANT_TABS, settingsTabs } from '../src/lib/settings.ts';
import { makeT } from '../../shared/i18n/index.ts';

describe('§6.12 F12 settings tabs per channel', () => {
  test('Mac sees all eight tabs while remote is on (hf1116 (b): + Git; v2.9 §4.1: + Quy trình)', () => expect(settingsTabs('mac', true).map(t => t.id)).toEqual(['proj', 'acc', 'noti', 'model', 'git', 'wf', 'remote', 'engine']));
  test('G4 UX 5(a) remote off (deferred to v3): no "Truy cập từ xa" tab', () => expect(settingsTabs('mac', false).map(t => t.id)).toEqual(['proj', 'acc', 'noti', 'model', 'git', 'wf', 'engine']));
  test('remote channel hides Mac-only settings (only the remote tab, view only)', () => {
    expect(settingsTabs('remote', true).map(t => t.id)).toEqual(['remote']);
  });
  test('U9: instant tabs (model, git, remote, engine) have no Save', () => expect([...INSTANT_TABS]).toEqual(['model', 'git', 'remote', 'engine']));
});

describe('§4.14 Cài đặt › Engine: cleanupPeriodDays', () => {
  const VI = makeT('vi'), EN = makeT('en');
  test('§4.14 shows the value in use and suggests 90 while it is lower; null (not read yet) → no line', () => {
    expect(cleanupLine(VI, 30)).toBe('Claude Code giữ bản ghi 30 ngày (cleanupPeriodDays) · gợi ý đặt 90; cc-slaves không tự sửa settings.json');
    expect(cleanupLine(VI, 90)).toBe('Claude Code giữ bản ghi 90 ngày (cleanupPeriodDays)');
    expect(cleanupLine(EN, 30)).toBe('Claude Code keeps transcripts 30 days (cleanupPeriodDays) · 90 suggested; cc-slaves never edits settings.json');
    expect(cleanupLine(VI, null)).toBeNull();
  });
});
