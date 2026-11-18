// The engine MCP tool shape shared by tools.ts (lanes, cards, notify) and the v2.7 issue-tools.ts / spec-tools.ts:
// identity, deps, the schema subset, the refusal error and the §4.14 owner check. No tool lives here.
import type { CardStore } from '../cards/store.ts';
import type { LaneManager } from '../lane/manager.ts';
import { notOwnerText } from '../orchestrator/owners.ts';
import type { OwnerPort } from '../orchestrator/session.ts';
import type { IssuePorts } from './issue-tools.ts';

export type Role = 'orchestrator' | 'lane';
/**
 * Who owns a bearer token. v2.5 §5.4 `cwd` + `graph` are what the spawn wrote beside it: the session's working dir (the
 * `/mcp-graph` gate's `repo_path` root, its front's cwd) and whether its MCP file has the cc-slaves graph entry (§5.7).
 */
export interface Identity { sessionId: string; role: Role; projectId: string; cwd: string; graph: boolean }

export type McpLanes = Pick<LaneManager,
  'list' | 'start' | 'message' | 'interrupt' | 'stop' | 'resume' | 'finish' | 'result' | 'tail' | 'setPhase' | 'bySession'>;

export interface ToolDeps {
  lanes: McpLanes;
  cards: Pick<CardStore, 'ask' | 'list'>;
  /** `accounts_usage` (QuotaTracker-backed view). */
  usage: () => unknown;
  /** `notify` sink (macOS / Google Chat, §8.3). */
  notify: (projectId: string, level: 'info' | 'warn' | 'error', text: string) => void;
  /** v2.7 issues / specs (§5.2–§5.5): store, git, events and the session ports. */
  issues: IssuePorts;
  worktreeExists?: (cwd: string) => boolean;
  /** v2.1 §4.14 lane owners; absent = no owner checks (pre-v2.1 wiring). */
  owners?: OwnerPort;
}

/** Minimal JSON Schema subset the validator understands. */
export interface Schema {
  type: 'object' | 'string' | 'integer' | 'boolean' | 'array';
  properties?: Record<string, Schema>;
  required?: string[];
  enum?: string[];
  items?: Schema;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  /** `null` is a value (`issue_create {spec: null}` = outside any spec). */
  nullable?: true;
  description?: string;
}

export type Args = Record<string, unknown>;
export interface ToolDef {
  name: string;
  description: string;
  roles: readonly Role[];
  /** Per-role schema (a lane's `lane_set_phase` has no `name`); `phases` = the caller's workflow lane phases (v2.9 §6.1). */
  schema: (role: Role, phases: readonly string[]) => Schema;
  run: (d: ToolDeps, who: Identity, a: Args) => unknown;
}

/** A refusal the model reads as-is (Vietnamese, names the right way). */
export class ToolError extends Error {}

export const str = (description?: string): Schema => (description ? { type: 'string', description } : { type: 'string' });
export const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, required });
export const fixed = (s: Schema) => () => s;
export const O: readonly Role[] = ['orchestrator'];
export const BOTH: readonly Role[] = ['orchestrator', 'lane'];
export const opt = <T>(a: Args, k: string): T | undefined => (a[k] === undefined ? undefined : a[k] as T);

/** §4.14 command tools only take the caller's own lanes (a lane with no owner yet: anyone). */
export function mustOwn(d: ToolDeps, who: Identity, name: string): void {
  if (who.role !== 'orchestrator' || !d.owners) return;
  const o = d.owners.ownerOf(who.projectId, name);
  if (o && o.sessionId !== who.sessionId) throw new ToolError(notOwnerText(name, o.seq));
}
