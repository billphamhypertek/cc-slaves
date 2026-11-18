import { describe, expect, test } from 'bun:test';
import type { ServerMsg } from '../../shared/protocol.ts';
import { chimeGain, notifyEventOf, notifyMatrix, notifyOn } from '../../shared/notify-prefs.ts';
import { chimeFor } from '../src/lib/chime.ts';
import { NOTIFY_CHANNELS, NOTIFY_EVENTS } from '../src/lib/settings.ts';
import { makeT } from '../../shared/i18n/index.ts';

const notify = (sound: boolean): ServerMsg => ({ type: 'event', event: { type: 'notify', kind: 'ask', title: 't', body: 'b', sound, mac: true } });

describe('Cài đặt › Thông báo matrix (shared by engine + web)', () => {
  test('defaults: all on except Lane Xong → Chat and Chuyển account → macOS / Chat', () => {
    const m = notifyMatrix(undefined);
    expect(m.lane_done).toEqual({ app: true, macos: true, gchat: false });
    expect(m.switch).toEqual({ app: true, macos: false, gchat: false });
    expect(m.ask).toEqual({ app: true, macos: true, gchat: true });
  });
  test('saved cells override; non-boolean junk falls back to the default', () => {
    const m = notifyMatrix({ ask: { macos: false }, broken: { gchat: 'no' } });
    expect(m.ask.macos).toBe(false);
    expect(m.broken.gchat).toBe(true);
  });
  test('kinds → rows: permission follows ask, account_switch → switch, kinds outside the matrix use the fallback', () => {
    expect(notifyEventOf('permission')).toBe('ask');
    expect(notifyEventOf('account_switch')).toBe('switch');
    expect(notifyEventOf('mcp_login')).toBeNull();
    expect(notifyOn(notifyMatrix({ ask: { app: false } }), 'permission', 'app', true)).toBe(false);
    expect(notifyOn(notifyMatrix({}), 'mcp_login', 'macos', true)).toBe(true);
  });
  test('every row / column label exists in both languages', () => {
    for (const lang of ['vi', 'en'] as const) {
      const tr = makeT(lang);
      for (const [, k] of [...NOTIFY_EVENTS, ...NOTIFY_CHANNELS]) expect(tr(k)).not.toBe(k);
    }
  });
});

describe('in-app chime follows notify.sound, config.volume and the top-bar mute', () => {
  test('volume 25 (default) keeps the old gain; 0 = silent', () => {
    expect(chimeGain(undefined)).toBeCloseTo(0.06);
    expect(chimeFor(notify(true), { volume: 0 }, false)).toBeNull();
    expect(chimeFor(notify(true), { volume: 100 }, false)).toBeCloseTo(0.24);
  });
  test('no sound flag or muted → silent', () => {
    expect(chimeFor(notify(false), {}, false)).toBeNull();
    expect(chimeFor(notify(true), {}, true)).toBeNull();
  });
});
