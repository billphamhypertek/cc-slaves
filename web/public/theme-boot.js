// v2.8 §5.3 no flash: an external file (not inline, so a later CSP keeps it working) loaded before the CSS sets
// <html data-theme> from `ccs.theme` (light / dark / system; anything else or an unreadable store = light, PO 17/11 21:55).
// web/src/lib/theme.ts takes over once the app runs; keep the two readings the same.
(function () {
  var m = null;
  try { m = localStorage.getItem('ccs.theme'); } catch (e) { /* private mode: light */ }
  var dark = m === 'dark' || (m === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();
