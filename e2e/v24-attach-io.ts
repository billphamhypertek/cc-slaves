// v2.4 §6.1 attachment input for e2e (v24-attach.spec.ts on the real engine, v24-shots.spec.ts DK frames on the dev mock):
// a ⌘V / DOM drop / drag-over carrying real `File`s (a PNG drawn on a canvas, so the engine's byte sniff sees an image), the
// Mac app's native drop (`window.__TAURI__.event` stub: the page gets absolute paths, as Tauri gives them, NC §8-20), and
// the dev mock's `/attach*` (the mock engine has none: answered with `page.route`).
import type { Page, Route } from '@playwright/test';

/** One file to put on the clipboard / drop. `img` = a PNG drawn on a canvas (`hue` varies the look); `size` = the byte size
 *  (a PNG is padded past its end, which every decoder ignores — "Quá 20 MB" with a real thumbnail). */
export interface FileSpec { name: string; type?: string; size?: number; img?: { hue: number } }

declare global { interface Window { __ccDrop?: Record<string, (e: { payload: unknown }) => void> } }

/** Build the `File`s in the page and fire `kind` on `document` (paste: ClipboardEvent; drop / dragenter: DragEvent). */
async function fire(page: Page, kind: 'paste' | 'drop' | 'dragenter', files: FileSpec[]): Promise<void> {
  await page.evaluate(async ({ kind, files }) => {
    const png = (hue: number) => new Promise<Blob>((res) => {
      const c = document.createElement('canvas');
      c.width = 320; c.height = 200;
      const g = c.getContext('2d')!;
      g.fillStyle = `hsl(${hue} 30% ${hue % 2 ? 92 : 16}%)`; g.fillRect(0, 0, 320, 200);
      g.fillStyle = `hsl(${hue} 60% 45%)`; g.fillRect(0, 0, 320, 26);
      for (let i = 0; i < 9; i++) { g.fillStyle = `hsl(${(hue + i * 37) % 360} 35% ${hue % 2 ? 40 : 70}%)`; g.fillRect(16, 40 + i * 16, 80 + ((i * 53 + hue) % 200), 8); }
      c.toBlob(b => res(b!), 'image/png');
    });
    const dt = new DataTransfer();
    for (const f of files) {
      const head: BlobPart[] = f.img ? [await png(f.img.hue)] : [];
      const have = head.length ? (head[0] as Blob).size : 0;
      const pad = new Uint8Array(Math.max(0, (f.size ?? (f.img ? 0 : 1024)) - have));
      dt.items.add(new File([...head, pad], f.name, { type: f.type ?? (f.img ? 'image/png' : 'application/octet-stream') }));
    }
    const ev = kind === 'paste' ? new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      : new DragEvent(kind, { dataTransfer: dt, bubbles: true, cancelable: true });
    (kind === 'paste' ? document.activeElement ?? document : document).dispatchEvent(ev);
  }, { kind, files });
}

/** §6.1 ⌘V of images / files with no text on the clipboard. */
export const paste = (page: Page, files: FileSpec[]) => fire(page, 'paste', files);
/** §6.1 a drop in a plain browser (every file a copy, DK13). */
export const drop = (page: Page, files: FileSpec[]) => fire(page, 'drop', files);
/** §6.1 DK3 files dragged over the window, not dropped yet. */
export const dragOver = (page: Page) => fire(page, 'dragenter', [{ name: 'x.png', img: { hue: 200 } }]);

/** The Mac app's drop bridge (web/src/lib/native.ts `tauriDrop` listens on `window.__TAURI__.event`). Before `goto`. */
export const stubTauri = (page: Page) => page.addInitScript(() => {
  const on: Record<string, (e: { payload: unknown }) => void> = {};
  window.__ccDrop = on;
  (window as unknown as { __TAURI__: unknown }).__TAURI__ = {
    event: { listen: (name: string, cb: (e: { payload: unknown }) => void) => { on[name] = cb; return Promise.resolve(() => { delete on[name]; }); } },
    window: { getCurrentWindow: () => ({ setFocus: () => Promise.resolve() }) },
  };
});
/** §6.1 Finder → the app: the native drop with absolute paths. */
export async function nativeDrop(page: Page, paths: string[]): Promise<void> {
  await page.evaluate((paths) => window.__ccDrop!['tauri://drag-drop']!({ payload: { paths } }), paths);
}

/** What the dev mock's `/attach*` answers: an upload by file name (`hang` = still uploading, DK4; `fail` = 500, DK5b;
 *  default ok), `POST /attach/path` by path (status + body; default a 1 KB file). */
export interface MockAttach {
  upload?: (name: string) => 'hang' | 'fail' | 'ok';
  path?: Record<string, { status?: number; body?: Record<string, unknown> }>;
}
/** Route the dev page's `/attach*` (the mock engine has no such route). */
export async function mockAttach(page: Page, m: MockAttach = {}): Promise<void> {
  let n = 0;
  await page.route((u) => u.pathname === '/attach' || u.pathname.startsWith('/attach/'), async (route: Route) => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path === '/attach' && req.method() === 'POST') {
      const name = decodeURIComponent(req.headers()['x-attach-name'] ?? '');
      const how = m.upload?.(name) ?? 'ok';
      if (how === 'hang') return; // never answered: the chip keeps its spinner
      if (how === 'fail') return route.fulfill({ status: 500, body: 'fail' });
      const size = req.postDataBuffer()?.length ?? 0;
      return route.fulfill({ json: { id: `up${++n}`, name, size, kind: /\.(png|jpe?g|gif|webp)$/i.test(name) ? 'image' : 'file' } });
    }
    if (path === '/attach/path') {
      const p = (req.postDataJSON() as { path: string }).path;
      const r = m.path?.[p] ?? { body: { kind: 'file', name: p.slice(p.lastIndexOf('/') + 1), size: 1024 } };
      return route.fulfill({ status: r.status ?? 200, json: r.body ?? { error: 'blocked' } });
    }
    return route.fulfill({ status: req.method() === 'DELETE' ? 204 : 404 });
  });
}
