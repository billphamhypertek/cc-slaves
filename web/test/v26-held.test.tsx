// v2.6 §4.8 UP8 a PO message kept back during the update hold shows at once with the small label "giữ lại — gửi sau khi
// cập nhật"; the engine's `po_written {target, seqs}` (E3) clears it. Only PO lines carry `held` (R13, the engine's side).
// §4.7 the version line now names the app the way UP2 does.
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StreamLine, Target } from '../../shared/protocol.ts';
import '../../shared/i18n/index.ts';
import { LangProvider, useT } from '../src/lib/i18n.tsx';
import { Store, targetKey } from '../src/lib/store.ts';
import { ConvList } from '../src/ui/Conversation.tsx';
import { snapshot } from './fixtures.ts';

const po = (seq: number, over: Partial<StreamLine> = {}): StreamLine => ({ seq, ts: new Date(2026, 10, 18, 14, 31).getTime(), kind: 'po', text: `tin ${seq}`, ...over });
const conv = (lines: StreamLine[], lang: 'vi' | 'en' = 'vi') =>
  renderToStaticMarkup(<LangProvider lang={lang}><ConvList lines={lines} hideTools={false} color="#fff" /></LangProvider>);
const labels = (h: string) => [...h.matchAll(/<span class="m-hold"[^>]*>(.*?)<\/span>/g)].map(m => m[1]!.replace(/<[^>]+>/g, ''));

describe('v2.6 §4.8 UP8 the "giữ lại" label on a held PO line', () => {
  test('UP8 held → the label after "Bạn · HH:MM"; a written line → none', () => {
    const h = conv([po(1, { held: true }), po(2)]);
    expect(labels(h)).toEqual(['giữ lại — gửi sau khi cập nhật']);
    expect(h.indexOf('Bạn · 14:31')).toBeLessThan(h.indexOf('m-hold'));
    expect(h.indexOf('m-hold')).toBeLessThan(h.indexOf('tin 1'));
  });
  test('en', () => {
    expect(labels(conv([po(1, { held: true })], 'en'))).toEqual(['held — sent after the update']);
  });
});

describe('v2.6 §10.3 `po_written` clears the label of exactly those lines', () => {
  const orch: Target = { kind: 'orchestrator', projectId: 'p1' };
  const lines = (s: Store) => s.get().streams[targetKey(orch)]!.lines.map(l => [l.seq, !!l.held]);
  test('the named seqs lose `held`, the others keep it', () => {
    const s = new Store();
    s.apply({ type: 'snapshot', snapshot: snapshot() });
    s.apply({ type: 'event', event: { type: 'stream', target: orch, lines: [po(5, { held: true }), po(6, { held: true })] } });
    s.apply({ type: 'event', event: { type: 'po_written', target: orch, seqs: [5] } });
    expect(lines(s)).toEqual([[5, false], [6, true]]);
    s.apply({ type: 'event', event: { type: 'po_written', target: { kind: 'lane', projectId: 'p1', name: 'D2' }, seqs: [6] } });
    expect(lines(s)).toEqual([[5, false], [6, true]]); // another target's seqs never touch this one
  });
  test('a held line still waiting behind a revealing block is cleared too', () => {
    const s = new Store(() => 0, null, { clock: { now: () => 0, raf: () => 1, caf: () => {} } }); // frames never come: nothing reveals
    s.apply({ type: 'snapshot', snapshot: snapshot() });
    const tk = targetKey(orch);
    const stop = s.show(tk, null); // paced: the block keeps its line (and the lines after it) until revealed
    try {
      s.apply({ type: 'event', event: { type: 'partial', target: orch, key: 'm:0', parent: null, delta: 'Đang chạy' } });
      s.apply({ type: 'event', event: { type: 'stream', target: orch, lines: [{ seq: 1, ts: 1, kind: 'assistant', text: 'Đang chạy', key: 'm:0' }, po(2, { held: true })] } });
      const after = () => Object.values(s.get().partials[tk] ?? {}).flatMap(b => b.after);
      expect(after().map(l => !!l.held)).toEqual([true]);
      s.apply({ type: 'event', event: { type: 'po_written', target: orch, seqs: [2] } });
      expect(after().map(l => !!l.held)).toEqual([false]);
    } finally { stop(); }
  });
});

describe('v2.6 §4.7 the version line', () => {
  test('vi / en: "cc-slaves <v> · giao thức N · claude X"', () => {
    const Line = () => { const tr = useT(); return <>{tr('settings.engine.versionLine', { engine: '0.3.0', protocol: 7, claude: '2.3.1' })}</>; };
    expect(renderToStaticMarkup(<LangProvider lang="vi"><Line /></LangProvider>)).toBe('cc-slaves 0.3.0 · giao thức 7 · claude 2.3.1');
    expect(renderToStaticMarkup(<LangProvider lang="en"><Line /></LangProvider>)).toBe('cc-slaves 0.3.0 · protocol 7 · claude 2.3.1');
  });
});
