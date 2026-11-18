// App shell environment: localStorage access that survives private mode, and the dev-only mock-engine frame.
export const ls = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
export const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
// dev only: the mock engine's frame (?f=F9…) also opens the matching UI state
export const DEV = import.meta.env.DEV ? new URLSearchParams(location.search) : null;
export const F0 = DEV?.get('f') ?? '';
// v2.1 §4.7 account panel: always collapsed when the app opens (never persisted); dev `?acc=open|ready` opens it (shots)
export const ACC0 = DEV?.get('acc') ?? '';
