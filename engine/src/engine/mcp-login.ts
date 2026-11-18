// v2.2 §6 K13 / C24 / C26 the "MCP cần đăng nhập lại" card, engine side (the web draws it, G6b): one system card per
// server (`projectId: null`, key = server id), the lanes missing it merged into the title, the login action carrying
// their projects (the tab badge counts it only there). "Để sau" hides it 4 h, or until a lane that was not missing the
// server then misses it now; a login (needsLogin cleared) closes it.
import type { McpOAuthView } from '../../../shared/protocol.ts';
import type { Key } from '../../../shared/i18n/index.ts';
import { act, type CardStore, type SystemPayload, type Timers } from '../cards/store.ts';

export const SNOOZE_MS = 4 * 60 * 60_000;

export interface MissingLane { name: string; projectId: string }

export interface McpLoginCardsDeps {
  cards: CardStore;
  view: (id: string) => McpOAuthView | null;
  name: (id: string) => string;
  /** Lanes whose session MCP file has this server (its proxy id is in their `mcpIds`). */
  missing: (id: string) => MissingLane[];
  now?: () => number;
  timers?: Timers;
}

const laneKey = (l: MissingLane): string => `${l.projectId}/${l.name}`;
const NODE_TIMERS: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

export class McpLoginCards {
  private readonly snoozed = new Map<string, { until: number; lanes: ReadonlySet<string>; timer: unknown }>();
  private readonly now: () => number;
  private readonly timers: Timers;

  constructor(private readonly d: McpLoginCardsDeps) {
    this.now = d.now ?? Date.now;
    this.timers = d.timers ?? NODE_TIMERS;
  }

  private unsnooze(id: string): void {
    const s = this.snoozed.get(id);
    if (s) { this.timers.clear(s.timer); this.snoozed.delete(id); }
  }

  /** Re-derive the card of `id` from its OAuth state and the lanes missing it. */
  sync(id: string): void {
    const open = this.d.cards.findOpenSystem('mcp_login', id, null);
    const need = this.d.view(id)?.needsLogin ?? null;
    const lanes = need ? this.d.missing(id) : [];
    if (!need || (need.reason === 'no_token' && lanes.length === 0)) {
      this.unsnooze(id);
      if (open) this.d.cards.resolveSystem(open.id);
      return;
    }
    const s = this.snoozed.get(id);
    if (s) {
      if (this.now() < s.until && lanes.every((l) => s.lanes.has(laneKey(l)))) return;
      this.unsnooze(id);
    }
    const names = lanes.map((l) => l.name).join(', ');
    const titleKey: Key = lanes.length === 0 ? 'cards.mcpReloginIdle'
      : need.reason === 'no_token' ? 'cards.mcpLogin' : need.reason === 'insufficient_scope' ? 'cards.mcpReloginScope' : 'cards.mcpRelogin';
    const params = { name: this.d.name(id), lanes: names, scope: need.scope ?? '' };
    const actions = [act('cardText.act.login', 'mcp_login', { id, projectIds: [...new Set(lanes.map((l) => l.projectId))] }), act('cardText.act.later', 'mcp_snooze', { id })];
    if (open && (open.payload as SystemPayload).titleKey === titleKey) {
      this.d.cards.updateSystem(open.id, { body: null, actions, params });
      return;
    }
    if (open) this.d.cards.resolveSystem(open.id);
    this.d.cards.createSystem({ kind: 'mcp_login', key: id, projectId: null, titleKey, params, actions });
  }

  /** K13 "Để sau". */
  snooze(id: string): void {
    const open = this.d.cards.findOpenSystem('mcp_login', id, null);
    if (open) this.d.cards.resolveSystem(open.id, 'mcp_snooze');
    this.unsnooze(id);
    const timer = this.timers.set(() => { this.snoozed.delete(id); this.sync(id); }, SNOOZE_MS);
    this.snoozed.set(id, { until: this.now() + SNOOZE_MS, lanes: new Set(this.d.missing(id).map(laneKey)), timer });
  }

  stop(): void {
    for (const id of [...this.snoozed.keys()]) this.unsnooze(id);
  }
}
