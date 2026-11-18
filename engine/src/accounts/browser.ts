// v2 §3.2 SA6: read the macOS default browser and open a login link in a private window (best-effort). Lives in the
// engine (it runs as a LaunchAgent when the app is closed). Unknown browser (Safari, anything else) → `ok:false`: the
// caller makes "Sao chép link" the main button. `exec` is injected; tests never open a real browser.

type BrowserKind = 'chromium' | 'firefox' | 'unknown';
export interface BrowserInfo {
  kind: BrowserKind;
  /** App name for `open -a`; null when unknown. */
  app: string | null;
  /** Private-window flag; null when unknown. */
  flag: string | null;
  bundleId: string | null;
}
export type BrowserExec = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string }>;
export type OpenResult = { ok: true; app: string } | { ok: false; reason: 'unknown_browser' | 'open_failed' | 'bad_url' };

/** Lower-case bundle id → app + flag (§3.2 SA6: Chrome / Brave / Arc `--incognito`, Edge `--inprivate`, Firefox). */
const KNOWN: Record<string, { kind: Exclude<BrowserKind, 'unknown'>; app: string; flag: string }> = {
  'com.google.chrome': { kind: 'chromium', app: 'Google Chrome', flag: '--incognito' },
  'com.google.chrome.canary': { kind: 'chromium', app: 'Google Chrome Canary', flag: '--incognito' },
  'com.brave.browser': { kind: 'chromium', app: 'Brave Browser', flag: '--incognito' },
  'company.thebrowser.browser': { kind: 'chromium', app: 'Arc', flag: '--incognito' },
  'org.chromium.chromium': { kind: 'chromium', app: 'Chromium', flag: '--incognito' },
  'com.microsoft.edgemac': { kind: 'chromium', app: 'Microsoft Edge', flag: '--inprivate' },
  'org.mozilla.firefox': { kind: 'firefox', app: 'Firefox', flag: '-private-window' },
};

const UNKNOWN: BrowserInfo = { kind: 'unknown', app: null, flag: null, bundleId: null };

/** Top-level handler dicts of the `LSHandlers` array, with nested dicts (LSHandlerPreferredVersions) cut out. */
function handlerDicts(plist: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of plist) {
    if (ch === '{') depth++;
    if (depth === 2) cur += ch;
    if (ch === '}') {
      if (depth === 2) { out.push(cur); cur = ''; }
      depth--;
    }
  }
  return out;
}

const field = (dict: string, key: string): string | null => {
  const m = new RegExp(`(?:^|[\\s{;])${key}\\s*=\\s*"?([^";]*)"?\\s*;`).exec(dict);
  return m ? m[1]!.trim() : null;
};

/** Pure: `defaults read …launchservices.secure` output → the https handler (http as fallback). */
export function parseDefaultBrowser(plist: string): BrowserInfo {
  const dicts = handlerDicts(plist);
  const forScheme = (s: string) => dicts.find((d) => field(d, 'LSHandlerURLScheme')?.toLowerCase() === s);
  const d = forScheme('https') ?? forScheme('http');
  const id = d ? field(d, 'LSHandlerRoleAll') : null;
  if (!id || id === '-') return UNKNOWN;
  const k = KNOWN[id.toLowerCase()];
  return k ? { ...k, bundleId: id } : { ...UNKNOWN, bundleId: id };
}

const defaultBrowserExec: BrowserExec = async (cmd, args) => {
  const p = Bun.spawn([cmd, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
  const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { code, stdout };
};

export async function defaultBrowser(exec: BrowserExec = defaultBrowserExec): Promise<BrowserInfo> {
  try {
    const r = await exec('defaults', ['read', 'com.apple.LaunchServices/com.apple.launchservices.secure']);
    return r.code === 0 ? parseDefaultBrowser(r.stdout) : UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

/**
 * §3.2 SA6 `open -na <app> --args <flag> <url>`. `-n` because `--args` is ignored by an already-running app.
 * Only http(s) URLs: the link comes from the `claude` child and is passed as an argv entry.
 */
export async function openPrivate(url: string, exec: BrowserExec = defaultBrowserExec): Promise<OpenResult> {
  if (!/^https?:\/\/[^\s]+$/.test(url)) return { ok: false, reason: 'bad_url' };
  const b = await defaultBrowser(exec);
  if (b.kind === 'unknown' || !b.app || !b.flag) return { ok: false, reason: 'unknown_browser' };
  try {
    const r = await exec('open', ['-na', b.app, '--args', b.flag, url]);
    return r.code === 0 ? { ok: true, app: b.app } : { ok: false, reason: 'open_failed' };
  } catch {
    return { ok: false, reason: 'open_failed' };
  }
}

/** v2.2 §5.3 an MCP login link in the default browser (`open <url>`, a normal window: the MCP account is the PO's). */
export async function openUrl(url: string, exec: BrowserExec = defaultBrowserExec): Promise<OpenResult> {
  if (!/^https?:\/\/[^\s]+$/.test(url)) return { ok: false, reason: 'bad_url' };
  try {
    const r = await exec('open', [url]);
    return r.code === 0 ? { ok: true, app: 'default' } : { ok: false, reason: 'open_failed' };
  } catch {
    return { ok: false, reason: 'open_failed' };
  }
}
