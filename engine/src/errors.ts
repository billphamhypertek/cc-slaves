// v2 §6A: an engine error the PO sees carries a catalog `key` (+ `params`) the UI renders in `ui.lang`; `message` stays
// the Vietnamese text (fallback for an older UI, logs). The keyed form builds `message` from the vi catalog, so the
// fallback can never drift from the catalog.
import { t, type Key, type Params } from '../../shared/i18n/index.ts';

export type Msg = string | { key: Key; params?: Params };

export class KeyedError extends Error {
  readonly key?: Key;
  readonly params?: Params;
  constructor(readonly code: string, m: Msg, key?: Key, params?: Params) {
    super(typeof m === 'string' ? m : t('vi', m.key, m.params));
    const k = typeof m === 'string' ? key : m.key;
    const p = typeof m === 'string' ? params : m.params;
    if (k) this.key = k;
    if (p) this.params = p;
  }
}
