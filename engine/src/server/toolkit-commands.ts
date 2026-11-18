// v2.5 §5.8 the Bộ công cụ commands (Mac only: none is in REMOTE_ALLOWED). Install / update ack the view with their rows
// `running` and go on in the background on the `claude plugin` queue; progress and the result reach the Mac as `toolkit`.
import type { ToolkitKey } from '../../../shared/toolkit.ts';
import type { Engine } from '../engine.ts';
import { PLUGIN_ITEMS, TOOLKIT } from '../toolkit/catalog.ts';
import { CommandError, type Handlers } from './router.ts';

const KEYS: ReadonlySet<string> = new Set(TOOLKIT.map((i) => i.key));
const PLUGIN_KEYS: ReadonlySet<string> = new Set(PLUGIN_ITEMS.map((i) => i.key));

/** A key outside the catalog (or, for `toolkit_update`, the graph tool: its button opens GR-upd, §5.6) → bad_input. */
function keyOf(k: unknown, allowed: ReadonlySet<string>): ToolkitKey {
  if (typeof k !== 'string' || !allowed.has(k)) throw new CommandError('bad_input', { key: 'errors.toolkitKey', params: { key: String(k) } });
  return k as ToolkitKey;
}

export function toolkitHandlers(e: Engine): Pick<Handlers, 'toolkit_check' | 'toolkit_install' | 'toolkit_update'> {
  const log = (what: string) => (err: unknown) => e.log(`toolkit ${what}: ${err instanceof Error ? err.message : String(err)}`);
  return {
    toolkit_check: (c) => e.toolkit.check(c.force === true),
    toolkit_install: (c) => {
      if (!Array.isArray(c.keys) || c.keys.length === 0) throw new CommandError('bad_input', { key: 'errors.toolkitKey', params: { key: '' } });
      const keys = c.keys.map((k) => keyOf(k, KEYS));
      if (e.graphModule?.busy()) throw new CommandError('busy', { key: 'errors.graphBusy' }); // §5.6 one install at a time
      e.toolkit.install(keys).catch(log('install'));
      return e.toolkit.view();
    },
    toolkit_update: (c) => {
      if (e.graphModule?.busy()) throw new CommandError('busy', { key: 'errors.graphBusy' }); // §5.6 one install at a time
      e.toolkit.update(keyOf(c.key, PLUGIN_KEYS)).catch(log('update'));
      return e.toolkit.view();
    },
  };
}
