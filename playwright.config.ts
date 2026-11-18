// UI e2e (spec §10): the built web (web/dist) served by a real engine process (e2e/engine-entry.ts) with fake-claude,
// temp homes and a random port per spec file. One worker: specs run one at a time on this machine.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e/specs',
  globalSetup: './e2e/global-setup.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? 'dot' : [['line']],
  // v2.4 §6.8 R36 I3: headless Chromium hides every scrollbar (--hide-scrollbars, gutter 0); the app (WKWebView) and the mockup
  // have the D54 10 px gutter, so every spec runs with the bars shown. M5: WebKit runs only the D54 spec.
  // v2.8 §5.1 the specs (and their screenshots) were written dark: e2e/fixtures.ts seeds `ccs.theme=dark` (the app's default is
  // light) and the system scheme is dark too, so a stored "system" reads dark as well. v28-theme starts from an empty store.
  use: { viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure', locale: 'vi-VN', colorScheme: 'dark', launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } }, testMatch: /v24-scrollbars\.spec\.ts$/ },
  ],
  outputDir: '.e2e-results',
});
