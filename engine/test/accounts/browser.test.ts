import { describe, expect, test } from 'bun:test';
import { defaultBrowser, openPrivate, openUrl, parseDefaultBrowser, type BrowserExec } from '../../src/accounts/browser.ts';

/** Old-style plist as `defaults read com.apple.LaunchServices/com.apple.launchservices.secure` prints it. */
const plist = (https: string, http = https) => `{
    LSHandlers =     (
                {
            LSHandlerContentType = "public.html";
            LSHandlerPreferredVersions =             {
                LSHandlerRoleAll = "-";
            };
            LSHandlerRoleAll = "com.apple.safari";
        },
                {
            LSHandlerPreferredVersions =             {
                LSHandlerRoleAll = "-";
            };
            LSHandlerRoleAll = "${http}";
            LSHandlerURLScheme = http;
        },
                {
            LSHandlerModificationDate = 813043038;
            LSHandlerPreferredVersions =             {
                LSHandlerRoleAll = "-";
            };
            LSHandlerRoleAll = "${https}";
            LSHandlerURLScheme = https;
        }
    );
}`;

const URL = 'https://claude.ai/oauth/authorize?state=abc';

function fakeExec(out: string, code = 0) {
  const calls: { cmd: string; args: string[] }[] = [];
  const exec: BrowserExec = async (cmd, args) => {
    calls.push({ cmd, args });
    return cmd === 'defaults' ? { code, stdout: out } : { code: 0, stdout: '' };
  };
  return { exec, calls };
}

describe('§3.2 SA6 default browser', () => {
  test.each([
    ['com.google.chrome', 'chromium', 'Google Chrome', '--incognito'],
    ['com.brave.browser', 'chromium', 'Brave Browser', '--incognito'],
    ['company.thebrowser.browser', 'chromium', 'Arc', '--incognito'],
    ['com.microsoft.edgemac', 'chromium', 'Microsoft Edge', '--inprivate'],
    ['org.mozilla.firefox', 'firefox', 'Firefox', '-private-window'],
  ])('§3.2 SA6 %s → %s / %s / %s', (id, kind, app, flag) => {
    expect(parseDefaultBrowser(plist(id))).toEqual({ kind, app, flag, bundleId: id } as never);
  });
  test('§3.2 SA6 bundle ids are matched case-insensitively', () => {
    expect(parseDefaultBrowser(plist('com.Google.Chrome')).app).toBe('Google Chrome');
  });
  test('§3.2 SA6 the https handler wins; nested LSHandlerPreferredVersions "-" is never read as the app', () => {
    expect(parseDefaultBrowser(plist('org.mozilla.firefox', 'com.google.chrome')).kind).toBe('firefox');
  });
  test('§3.2 SA6 Safari / unknown / no https handler / garbage → unknown', () => {
    expect(parseDefaultBrowser(plist('com.apple.safari')).kind).toBe('unknown');
    expect(parseDefaultBrowser(plist('com.example.weird')).kind).toBe('unknown');
    expect(parseDefaultBrowser('{ LSHandlers = ( ); }').kind).toBe('unknown');
    expect(parseDefaultBrowser('').kind).toBe('unknown');
  });
  test('§3.2 SA6 defaults read failing → unknown', async () => {
    const { exec } = fakeExec('', 1);
    expect((await defaultBrowser(exec)).kind).toBe('unknown');
  });
});

describe('§3.2 SA6 openPrivate', () => {
  test('§3.2 SA6 Chrome → open -na "Google Chrome" --args --incognito <url>', async () => {
    const { exec, calls } = fakeExec(plist('com.google.chrome'));
    expect(await openPrivate(URL, exec)).toEqual({ ok: true, app: 'Google Chrome' });
    expect(calls[1]).toEqual({ cmd: 'open', args: ['-na', 'Google Chrome', '--args', '--incognito', URL] });
  });
  test('§3.2 SA6 Edge → --inprivate, Firefox → -private-window', async () => {
    let f = fakeExec(plist('com.microsoft.edgemac'));
    await openPrivate(URL, f.exec);
    expect(f.calls[1]!.args).toEqual(['-na', 'Microsoft Edge', '--args', '--inprivate', URL]);
    f = fakeExec(plist('org.mozilla.firefox'));
    await openPrivate(URL, f.exec);
    expect(f.calls[1]!.args).toEqual(['-na', 'Firefox', '--args', '-private-window', URL]);
  });
  test('§3.2 SA6 unknown browser → ok:false, nothing opened (caller shows "Sao chép link")', async () => {
    const { exec, calls } = fakeExec(plist('com.apple.safari'));
    expect(await openPrivate(URL, exec)).toEqual({ ok: false, reason: 'unknown_browser' });
    expect(calls.map((c) => c.cmd)).toEqual(['defaults']);
  });
  test('§3.2 SA6 open failing → ok:false', async () => {
    const exec: BrowserExec = async (cmd) => cmd === 'defaults' ? { code: 0, stdout: plist('com.google.chrome') } : { code: 1, stdout: '' };
    expect(await openPrivate(URL, exec)).toEqual({ ok: false, reason: 'open_failed' });
  });
  test('§3.2 SA6 only http(s) URLs are opened', async () => {
    const { exec, calls } = fakeExec(plist('com.google.chrome'));
    expect(await openPrivate('file:///etc/passwd', exec)).toEqual({ ok: false, reason: 'bad_url' });
    expect(await openPrivate('-n --foo', exec)).toEqual({ ok: false, reason: 'bad_url' });
    expect(calls).toEqual([]);
  });
});

describe('v2.2 §5.3 openUrl (MCP login, default browser, no private window)', () => {
  test('§5.3 open <url> as one argv entry; a non-http URL is never opened', async () => {
    const { exec, calls } = fakeExec('');
    expect(await openUrl(URL, exec)).toEqual({ ok: true, app: 'default' });
    expect(calls).toEqual([{ cmd: 'open', args: [URL] }]);
    expect(await openUrl('file:///etc/passwd', exec)).toEqual({ ok: false, reason: 'bad_url' });
    expect(calls).toHaveLength(1);
  });
});
