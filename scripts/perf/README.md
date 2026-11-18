# scripts/perf — UI smoothness measurements (perf audit 2026-11-17)

Dev mock + a storm proxy + Playwright (WebKit first: the app is WKWebView; Chromium for the CDP numbers). Own ports, no e2e.

```sh
(cd web && MOCK_PORT=4871 bun dev/mock-engine.ts) &
PROXY_PORT=4872 UPSTREAM=ws://127.0.0.1:4871 bun scripts/perf/storm-proxy.ts &
(cd web && CC_ENGINE_URL=ws://127.0.0.1:4872 bunx vite --port 5771 --strictPort) &   # load one page first (Vite warm-up)
bun scripts/perf/measure.ts webkit 5 1440x900 deck,tasks,vhist   # engine, storm stream lines/s (0 = none), viewport, scenarios
```

- Prod build: `bun run web:build`, `(cd web && CC_ENGINE_URL=ws://127.0.0.1:4872 bunx vite preview --port 5772)`, then
  `PERF_URL=http://localhost:5772 bun scripts/perf/measure.ts …` (the probe adds `f=` itself; the prod build ignores `?f=`).
- `storm-proxy.ts`: on the watched target a `partial` every 50 ms + n stream lines/s (`⏱<ms>` stamped); one lane event every
  250 ms; every account view every 10 s (like `engine/accounts.ts:120`).
- `probe.ts` (`window.__perf`, injected with `addInitScript(installProbe, storm)`): React commits / components rendered / mounted per commit (DevTools-hook stub), rAF frames,
  input → next paint, WS message → next paint, Chromium-only longtask / LoAF / layout-shift / event entries.
- `vhist` scenario healthy values: ≈ 1 commit/s idle, `driftSteps` 0, `tasksRoundTripShiftPx` 0.
- Vite's watcher can miss a file restored with `cp`: restart Vite after a temporary patch and check the served module with `curl`.
