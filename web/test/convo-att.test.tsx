// spec v2.4 §6.3 DK7 / DK12 (what a sent message shows: labels, never bytes), §5.3 MD4b ("gửi khi lượt này xong" on a PO line),
// §4.3 MD14 (the model-change line). The engine emits `att` only from G3c on: the lines here are unit fixtures.
import { describe, expect, test } from 'bun:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StreamLine } from '../../shared/protocol.ts';
import '../../shared/i18n/index.ts';
import { LangProvider } from '../src/lib/i18n.tsx';
import { ConvList } from '../src/ui/Conversation.tsx';
import { textWidth } from '../src/lib/mid-ellipsis.ts';
import { monoFont } from '../src/lib/mono-font.ts';

const html = (el: ReactElement, lang: 'vi' | 'en' = 'vi') => renderToStaticMarkup(<LangProvider lang={lang}>{el}</LangProvider>);
const plain = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
let seq = 0;
const po = (over: Partial<StreamLine>): StreamLine => ({ seq: ++seq, ts: new Date(2026, 10, 16, 14, 22).getTime(), kind: 'po', text: 'Lỗi này từ đâu ra?', ...over });
const conv = (lines: StreamLine[], lang: 'vi' | 'en' = 'vi') => html(<ConvList lines={lines} hideTools={false} color="#fff" />, lang);
const labels = (h: string) => [...h.matchAll(/<span class="m-lb"[^>]*>([^<]*)<\/span>/g)].map(m => m[1]);
const LONG = '2026-11-15-cc-slaves-v2.4-model-attach-design.md';

describe('§6.3 DK7 attachment labels under a sent PO message', () => {
  test('§6.3 image → "ảnh · <name>", file → its name, copied file → "<name> · bản sao", in chip order, under the text', () => {
    const h = conv([po({ att: [{ kind: 'image', name: 'ảnh-142233.png', copy: true }, { kind: 'file', name: 'doanh-thu.xlsx' }, { kind: 'file', name: 'ghi-chú.md', copy: true }] })]);
    expect(labels(h)).toEqual(['ảnh · ảnh-142233.png', 'doanh-thu.xlsx', 'ghi-chú.md · bản sao']);
    expect(h.indexOf('Lỗi này từ đâu ra?')).toBeLessThan(h.indexOf('class="m-lbs"'));
  });
  test('§6.3 labels are plain text: no image, no link, no button (never bytes)', () => {
    const h = conv([po({ att: [{ kind: 'image', name: 'a.png' }, { kind: 'file', name: 'b.pdf' }] })]);
    const row = /<div class="m-lbs">.*?<\/div>/.exec(h)![0];
    expect(row).not.toMatch(/<img|<a |<button|data:/);
  });
  test('§6.3 a long name is cut in the middle, keeps its extension, the full name stays in the title (label ≤ 200 px)', () => {
    const h = conv([po({ att: [{ kind: 'file', name: LONG }, { kind: 'image', name: LONG.replace('.md', '.png') }] })]);
    const [file, img] = labels(h);
    expect(file).toContain('…');
    expect(file!.endsWith('design.md')).toBe(true);
    expect(file!.startsWith('2026')).toBe(true);
    expect(img!.startsWith('ảnh · 2026')).toBe(true);
    expect(img!.endsWith('design.png')).toBe(true);
    // §6.7 D53 measured in .m-lb's step (the bun fallback: 0.6 em of --xs a character); 8 px padding inside the 200 px cap
    expect(textWidth(file!, monoFont('xs'))).toBeLessThanOrEqual(192);
    expect(textWidth(img!, monoFont('xs'))).toBeLessThanOrEqual(192);
    expect(h).toContain(`title="${LONG}"`);
  });
  test('§6.3 a short name is not cut', () => {
    expect(labels(conv([po({ att: [{ kind: 'file', name: 'doanh-thu.xlsx', copy: true }] })]))).toEqual(['doanh-thu.xlsx · bản sao']);
  });
  test('§6.3 DK15 a message with only attachments shows no empty text row, just the labels', () => {
    const h = conv([po({ text: '', att: [{ kind: 'file', name: 'doanh-thu.xlsx' }] })]);
    expect(h).not.toContain('<span></span>');
    expect(labels(h)).toEqual(['doanh-thu.xlsx']);
  });
  test('§6.3 a message without attachments has no label row (v2.1 line unchanged)', () => {
    expect(conv([po({})])).not.toContain('m-lbs');
    expect(conv([po({ att: [] })])).not.toContain('m-lbs');
  });
  test('§6.3 DK7 "đã gửi vào lượt đang chạy" sits on the who line after the time', () => {
    const h = conv([po({ inTurn: true, att: [{ kind: 'image', name: 'ảnh-142702.png' }] })]);
    expect(plain(/<span class="m-who">.*?<\/span><\/span>/.exec(h)![0])).toBe('Bạn · 14:22 · đã gửi vào lượt đang chạy');
  });
  test('§6.3 en catalog: "image · <name>", "<name> · copy"', () => {
    expect(labels(conv([po({ att: [{ kind: 'image', name: 'a.png' }, { kind: 'file', name: 'n.md', copy: true }] })], 'en'))).toEqual(['image · a.png', 'n.md · copy']);
  });
});

describe('§5.3 MD4b a PO message sent while a model change waits', () => {
  test('§5.3 afterModelChange → who line "Bạn · 14:31 · gửi khi lượt này xong"', () => {
    const h = conv([po({ ts: new Date(2026, 10, 16, 14, 31).getTime(), text: 'Xong lượt này thì review lại lot-2.', afterModelChange: true })]);
    expect(plain(/<span class="m-who">.*?<\/span><\/span>/.exec(h)![0])).toBe('Bạn · 14:31 · gửi khi lượt này xong');
    expect(h).toContain('Xong lượt này thì review lại lot-2.');
  });
  test('§5.3 a held message is not in the running turn: afterModelChange wins over inTurn (one note)', () => {
    const h = plain(conv([po({ afterModelChange: true, inTurn: true })]));
    expect(h).toContain('gửi khi lượt này xong');
    expect(h).not.toContain('đã gửi vào lượt đang chạy');
  });
  test('§5.3 en catalog', () => {
    expect(plain(conv([po({ afterModelChange: true })], 'en'))).toContain('sent when this turn ends');
  });
});

describe('§4.3 MD14 / §6.3 DK12 engine lines', () => {
  test('§4.3 "Đổi model: … · effort: …" and §6.3 "Không gửi được …" render verbatim as engine lines', () => {
    const eng = (text: string): StreamLine => ({ seq: ++seq, ts: 1, kind: 'engine', text });
    const h = conv([eng('Đổi model: Fable 5.2 → Sonnet 5.5 · effort: high → max'), eng('Không gửi được doanh-thu.xlsx: file không còn trên máy.')]);
    expect(h).toContain('<div class="m-evt">Đổi model: Fable 5.2 → Sonnet 5.5 · effort: high → max</div>');
    expect(h).toContain('<div class="m-evt">Không gửi được doanh-thu.xlsx: file không còn trên máy.</div>');
  });
});
