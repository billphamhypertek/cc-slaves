// v2.7 §4.3 review MINOR-2 / IMPORTANT-2: the detail's attachments (issue_file sender, 200 × 112 thumbnail per image) and
// the history naming each event's own lane (the engine maps the lane id at read).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { makeT } from '../../shared/i18n/index.ts';
import type { Command } from '../../shared/protocol.ts';
import { LangProvider } from '../src/lib/i18n.tsx';
import { issueCmds } from '../src/lib/issues.ts';
import { historyLines, type DetailCtx } from '../src/tasks/IssueDetail.model.ts';
import { imageFiles, IssueFiles, shotOf } from '../src/tasks/IssueDetailFiles.tsx';
import { issueInfo } from './fixtures.ts';

const tr = makeT('vi');
const html = (el: ReactElement) => renderToStaticMarkup(<LangProvider lang="vi">{el}</LangProvider>);

describe('§4.3 review MINOR-2 issue attachments', () => {
  test('§4.3 issueCmds.file sends issue_file {projectId, key, id} (Mac-only command)', async () => {
    const sent: Command[] = [];
    await issueCmds(async (c) => { sent.push(c); return { name: 'a.png', size: 1, dataUrl: 'data:image/png;base64,AA==' }; }, 'p1').file('B-51', 3);
    expect(sent).toEqual([{ cmd: 'issue_file', projectId: 'p1', key: 'B-51', id: 3 }]);
  });

  test('§4.3 only image names get a thumbnail; every file keeps its name · size line', () => {
    const files = [{ id: 1, name: 'tab-giat.png', size: 184_220 }, { id: 2, name: 'log.txt', size: 10 }, { id: 3, name: 'A.JPEG', size: 2048 }];
    expect(imageFiles(files).map(f => f.id)).toEqual([1, 3]);
    const h = html(<IssueFiles cmds={{ file: () => new Promise(() => {}) }} issue={issueInfo(51, { key: 'B-51', files })} />);
    expect((h.match(/class="dthumb"/g) ?? []).length).toBe(2);
    expect(h).toContain('aria-label="Xem ảnh tab-giat.png"');
    expect(h).toContain('180 KB');
    expect(h).toContain('log.txt');
    expect(h).not.toContain('role="dialog"'); // the full view opens only on click
  });

  test('§4.3 rereview-d NEW-D1 an ack without data = that thumbnail cannot load, no throw', () => {
    expect(shotOf(undefined)).toBeNull();
    expect(shotOf({ name: 'a.png', size: 1 } as never)).toBeNull();
    expect(shotOf({ name: 'a.png', size: 1, dataUrl: 'data:image/png;base64,AA==' })).toBe('data:image/png;base64,AA==');
  });

  test('§4.3 the thumbnail is the mockup .thumb: 200 × 112, neutral border, var() colours only', () => {
    const css = readFileSync(new URL('../src/tasks/IssueDetail.css', import.meta.url), 'utf8');
    const rule = /\.dthumb\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('width:200px');
    expect(rule).toContain('height:112px');
    expect(rule).toContain('border:1px solid var(--line-2)');
  });
});

describe('§4.3 review IMPORTANT-2 history lane names', () => {
  const x: DetailCtx = { tr, now: 0, spec: null, all: [], quotaAt: () => null, lanes: [] };
  test('§4.3 taken D2 → returned D2 → taken D5: each line names its own lane while the issue now sits on D5', () => {
    const i = issueInfo(47, { state: 'doing', lane: { name: 'D5', state: 'running', phase: 'code' }, events: [
      { ts: 1, type: 'taken', data: { lane: 'D2' } }, { ts: 2, type: 'returned', data: { lane: 'D2', reason: 'lane D2 kết thúc' } },
      { ts: 3, type: 'taken', data: { lane: 'D5' } }] });
    const lines = historyLines(i, x).map(h => h.text);
    expect(lines[0]).toContain('D2');
    expect(lines[1]).toContain('D2');
    expect(lines[2]).toContain('D5');
    expect(lines.slice(0, 2).some(l => l.includes('D5'))).toBe(false);
  });
  test('§4.3 a gone lane (null) never borrows the current lane', () => {
    const i = issueInfo(47, { lane: { name: 'D5', state: 'running', phase: 'code' }, sourceLane: 'D9', events: [{ ts: 1, type: 'taken', data: { lane: null } }] });
    expect(historyLines(i, x)[0]!.text).not.toMatch(/D5|D9/);
  });
});
