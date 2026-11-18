// v2 §6A (D19) UI language for the engine, Tauri checks and tests: the core (`t()`, keyed reasons, Intl formatters) with
// both catalogs loaded. The web imports core.ts + vi.ts and loads en.ts lazily (spec v2.1 §5.6).
// How to add a key / namespace: docs/ref/i18n.md.
import { EN } from './en.ts';
import type { Lang } from './core.ts';
import { VI } from './vi.ts';
import { loadLazyNs } from './lazy.ts';

export * from './core.ts';
/** @internal Both catalogs, flat `<ns>.<path>` keys (`en` must carry exactly the keys of `vi`, engine/test/i18n.test.ts). */
export const CATALOGS: Readonly<Record<Lang, Record<string, string>>> = { vi: VI, en: EN };
loadLazyNs(); // the engine and tests carry every namespace
