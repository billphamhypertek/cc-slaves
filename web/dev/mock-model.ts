// v2.4 §4 dev data for the model chip / picker / session dialog row (`?md=<frame>`, mockup frames MD*). The three model
// commands (§5.5) answered like the engine will (G1c); `wait` = never answers (MD2b spinner, MD8 skeleton).
import type { ModelInfo, OrchestratorView, SessionModels, Snapshot, StreamLine } from '../../shared/protocol.ts';

export const MD_SCENES = ['MD1', 'MD2', 'MD2b', 'MD3', 'MD4', 'MD4b', 'MD5', 'MD6', 'MD7', 'MD8', 'MD8b', 'MD9', 'MD10c', 'MD11', 'MD13', 'MD14'] as const;
export type MdScene = (typeof MD_SCENES)[number];

const ALL = ['low', 'medium', 'high', 'xhigh', 'max'];
const M = (value: string, displayName: string, resolvedModel: string, effortLevels = ALL): ModelInfo => ({ value, displayName, resolvedModel, effortLevels });
const OLDER = [M('claude-opus-4-6', 'Opus 4.6', 'claude-opus-4-6', ['low', 'medium', 'high', 'max']), M('claude-opus-4-5', 'Opus 4.5', 'claude-opus-4-5'),
  M('claude-opus-4-1', 'Opus 4.1', 'claude-opus-4-1'), M('claude-sonnet-4-5', 'Sonnet 4.5', 'claude-sonnet-4-5'), M('claude-sonnet-4', 'Sonnet 4', 'claude-sonnet-4'),
  M('claude-haiku-4-5', 'Haiku 4.5', 'claude-haiku-4-5', []), M('claude-fable-5-1', 'Fable 5.1', 'claude-fable-5-1'), M('claude-fable-5', 'Fable 5', 'claude-fable-5'),
  M('claude-sonnet-5', 'Sonnet 5', 'claude-sonnet-5')];
const LIST: SessionModels = {
  defaultModel: 'fable', defaultModelName: 'Fable 5.2', claudeModel: 'fable', claudeEffort: 'high', claudeSource: 'claude',
  models: [M('default', 'Default', 'claude-fable-5-2'), M('opus', 'Opus 5.5', 'claude-opus-5-5'), M('fable', 'Fable 5.2', 'claude-fable-5-2'),
    M('sonnet', 'Sonnet 5.5', 'claude-sonnet-5-5'), M('haiku', 'Haiku 5.5', 'claude-haiku-5-5', []), ...OLDER],
};

const SCENE: Partial<Record<MdScene, Partial<OrchestratorView>>> = {
  MD2: { state: 'idle' },
  MD2b: { state: 'idle' },
  MD3: { state: 'idle', model: 'claude-opus-4-6', modelName: 'Opus 4.6', modelPick: 'claude-opus-4-6', effort: 'high' },
  MD4: { state: 'running', pending: { model: 'sonnet', modelName: 'Sonnet 5.5' } },
  MD4b: { state: 'running', pending: { effort: 'max' } },
  MD5: { state: 'idle', model: 'claude-haiku-4-5', modelName: 'Haiku 4.5', modelPick: 'claude-haiku-4-5', effort: null },
  MD7: { state: 'stopped' },
  MD6: { state: 'idle' },
  MD14: { state: 'idle', model: 'claude-sonnet-5-5', modelName: 'Sonnet 5.5', modelPick: 'sonnet', effort: 'max', effortPick: 'max' },
  MD8: { state: 'idle' },
  MD8b: { state: 'idle' },
  MD9: { state: 'idle', model: 'claude-sonnet-5-5', modelName: 'Sonnet 5.5', modelPick: 'opus', modelMismatch: true },
};

/** lines the scene adds under the orchestrator's history: MD4b the message held for the pending change (§5.3), MD14 the engine
 *  line once the change applied (G1c `console.modelChanged`). */
export function modelLines(scene: MdScene | null): Omit<StreamLine, 'seq' | 'ts'>[] {
  if (scene === 'MD4b') return [{ kind: 'po', text: 'Xong lượt này thì review lại lot-2.', afterModelChange: true }];
  if (scene === 'MD14') return [{ kind: 'engine', text: 'Đổi model: Fable 5.2 → Sonnet 5.5 · effort: high → max' }];
  return [];
}

/** every orchestrator runs Fable 5.2 · high and every lane Opus 5.5 · medium (§4.5 LM1 `run`) unless the scene says otherwise. */
export function modelSnapshot(s: Snapshot, scene: MdScene | null): void {
  for (const o of s.orchestrators) Object.assign(o, { model: 'claude-fable-5-2', modelName: 'Fable 5.2', effort: 'high', modelPick: null, effortPick: null });
  for (const l of s.lanes) if (l.state !== 'done') l.run ??= { model: 'claude-opus-5-5', modelName: 'Opus 5.5', effort: 'medium' };
  if (!scene || !s.orchestrators[0]) return;
  // a session id so the picker can address it, only in a model scene: the v2.1–v2.3 frames keep their root ids (`orch:<project>`);
  // 's3' is the mock's plain stream key (mock-engine `key`)
  Object.assign(s.orchestrators[0], { sessionId: s.orchestrators[0].sessionId ?? 's3' }, SCENE[scene] ?? {});
}

export function modelReply(scene: MdScene, c: { cmd: string }): { ok: unknown } | { code: string; message: string } | { wait: true } | null {
  if (c.cmd === 'session_models') {
    if (scene === 'MD8') return { wait: true };
    if (scene === 'MD8b' || scene === 'MD10c') return { ok: { models: [], defaultModel: null, defaultModelName: null, unavailable: true } };
    // §4.5 LM2 a lane's default is Cài đặt › Lane (Opus 5.5 · medium, the mock's lane `run`)
    return { ok: 'lane' in c ? { ...LIST, defaultModel: 'opus', defaultModelName: 'Opus 5.5', defaultSource: 'settings', defaultEffort: 'medium' } : LIST };
  }
  if (c.cmd === 'session_set_model') {
    if (scene === 'MD2b') return { wait: true };
    if (scene === 'MD6') return { code: 'model_not_found', message: 'model_not_found' };
    return { ok: { applied: scene === 'MD4' || scene === 'MD4b' ? 'pending' : 'now' } };
  }
  if (c.cmd === 'session_model_cancel') return { ok: null };
  return null;
}
