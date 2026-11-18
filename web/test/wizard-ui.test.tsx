// v2.5 §6 the wizard, rendered statically: 5 steps, step 3 "Bộ công cụ" shows its title + lead and TK1-chk's waiting line
// with "Quay lại · Để sau · Cài (off)" while the lazy list chunk loads (the static render never resolves `lazy`).
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import '../../shared/i18n/index.ts';
import type { SetupStatus } from '../../shared/protocol.ts';
import { LangProvider, type Lang } from '../src/lib/i18n.tsx';
import { Wizard } from '../src/ui/Wizard.tsx';
import { snapshot } from './fixtures.ts';

const setup: SetupStatus = {
  claude: { found: true, path: '/c', version: '2.1.330', ok: true }, accounts: [{ email: 'a@x', loggedIn: true }], poEmail: null, done: false,
  git: { state: 'ok', version: '2.50', detail: null, identity: { name: 'a', email: 'a@x' }, gh: 'missing', ghUser: null, ghLogin: null },
};
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const wiz = (step: 3 | 4 | 5, lang: Lang = 'vi') => renderToStaticMarkup(<LangProvider lang={lang}><Wizard setup={setup} snap={snapshot()} installs={{}} initialStep={step}
  send={() => Promise.resolve()} onAccDlg={() => {}} onAccMenu={() => {}} toast={() => {}} onClose={() => {}} onAddProject={() => {}} /></LangProvider>);

describe('v2.5 §6 wizard 5 steps', () => {
  test('stepper: 1. Công cụ … 5. Xong, step 3 now (1 and 2 ok)', () => {
    const h = wiz(3);
    expect(text(h.split('class="stepper"')[1]!)).toMatch(/1\. Công cụ .*2\. Account .*3\. Bộ công cụ .*4\. Vai trò & ngưỡng .*5\. Xong/);
    expect(h).toMatch(/<div class="now"><i><\/i><span>3\. Bộ công cụ/);
  });
  test('step 3 while the chunk loads: title, lead with ~/.claude, the waiting line, foot Quay lại · Để sau · Cài (off)', () => {
    const t = text(wiz(3));
    expect(t).toContain('Bộ công cụ Những thứ lane của bạn dùng hằng ngày. Cài vào ~/.claude , terminal cũng dùng được.');
    expect(t).toContain('Đang kiểm tra máy này… Quay lại Để sau Cài');
    expect(wiz(3)).toMatch(/<button class="btn pri" disabled="">/);
    expect(text(wiz(3, 'en'))).toContain('Checking this Mac… Back Later Install');
  });
  test('roles at step 4 (Quay lại → 3), done at step 5', () => {
    expect(text(wiz(4))).toContain('Chọn một account Điều phối.');
    expect(text(wiz(5))).toContain('Thêm project đầu tiên');
  });
});
