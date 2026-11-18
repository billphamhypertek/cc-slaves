// fake-claude control requests other than `interrupt` (spec v2.4 §10.2, shapes as measured in NC §8-1/2/3/5/13/14):
// `list_models`, `get_settings`, `set_model`, `apply_flag_settings`; any other subtype → error `unsupported_request`.
// They are answered at any time, also before the first user line (NC §8-11).
//
// Scenario key "control" (all optional):
//   "models": list_models rows (default: below) · "sources": get_settings `sources` layers before `flagSettings`
//   (default: one `userSettings` layer with model "fable") · "planDefault": what `set_model {}` picks (claude-opus-5-5) ·
//   "delayMs": ms | {<subtype>: ms} before the reply · "fail": {<subtype>: "not_found" | "unsupported_request" | "silent"}
//   ("silent" = never replies) · "pin": {"model"?, "effort"?} → get_settings `applied` reports these whatever was asked.
//   "startModel" / "startEffort": what a spawn without `--model` / `--effort` runs (default "claude-fake" / null; index.ts).
// A successful `set_model` also emits Claude Code's own replay line (a foreign uuid):
// `<local-command-stdout>Set model to <displayName></local-command-stdout>` (NC §8-2).
import { randomUUID } from 'node:crypto';

type Obj = Record<string, unknown>;
interface Io { out: (o: Obj) => void; emit: (o: Obj) => void }

const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const row = (value: string, resolvedModel: string, displayName: string, levels = LEVELS): Obj => ({
  value, resolvedModel, displayName, description: '', supportsEffort: levels.length > 0, supportedEffortLevels: levels,
});
const MODELS: Obj[] = [
  row('default', 'claude-opus-5-5', 'Default (recommended)'), row('opus', 'claude-opus-5-5', 'Opus 5.5'),
  row('sonnet', 'claude-sonnet-5-5', 'Sonnet 5.5'), row('haiku', 'claude-haiku-5-5', 'Haiku 5.5'),
  row('claude-haiku-4-5-20251001', 'claude-haiku-4-5-20251001', 'Haiku 4.5', []),
];

export function makeControl(cfg: Obj, start: { model: string; effort: string | null }, io: Io) {
  const models = Array.isArray(cfg.models) ? (cfg.models as Obj[]) : MODELS;
  const fail = (cfg.fail ?? {}) as Record<string, string>;
  const pin = (cfg.pin ?? {}) as Obj;
  let model = start.model;
  let effort = start.effort;
  let flagLayer: Obj | null = null;

  const find = (m: string) => {
    const bare = m.replace(/\[1m\]$/i, '');
    return models.find((r) => r.value === bare || r.resolvedModel === bare);
  };
  const levelsOf = (m: string) => (find(m)?.supportedEffortLevels as string[] | undefined) ?? LEVELS;
  const settings = (): Obj => {
    const sources = [...(Array.isArray(cfg.sources) ? (cfg.sources as Obj[]) : [{ source: 'userSettings', settings: { model: 'fable' } }])];
    if (flagLayer) sources.push({ source: 'flagSettings', settings: flagLayer });
    const effective: Obj = {};
    for (const x of sources) Object.assign(effective, x.settings as Obj);
    return { effective, sources, applied: { model: 'model' in pin ? pin.model : model, effort: 'effort' in pin ? pin.effort : effort } };
  };

  function answer(req: Obj): { response: Obj } | { error: string; code: string } {
    switch (req.subtype) {
      case 'list_models': return { response: { models } };
      case 'get_settings': return { response: settings() };
      case 'set_model': {
        const want = typeof req.model === 'string' ? req.model : typeof cfg.planDefault === 'string' ? cfg.planDefault : 'claude-opus-5-5';
        const r = find(want);
        if (!r) return { error: `Model '${want}' not found`, code: 'not_found' };
        model = `${String(r.resolvedModel)}${/\[1m\]$/i.test(want) ? '[1m]' : ''}`;
        if (!levelsOf(model).length) effort = null;
        io.emit({ type: 'user', uuid: randomUUID(), isReplay: true, parent_tool_use_id: null, message: { role: 'user',
          content: `<local-command-stdout>Set model to ${String(r.displayName)}</local-command-stdout>` } });
        return { response: { model } };
      }
      case 'apply_flag_settings': {
        const s = (req.settings ?? {}) as Obj;
        flagLayer = { ...flagLayer, ...s };
        // NC §8-5 / §8-13: a bad value still answers success, null drops the layer's level (fable → medium)
        if (s.effortLevel === null) effort = 'medium';
        else if (typeof s.effortLevel === 'string' && levelsOf(model).includes(s.effortLevel)) effort = s.effortLevel;
        return { response: {} };
      }
      default: return { error: `Unsupported control request subtype: ${String(req.subtype)}`, code: 'unsupported_request' };
    }
  }

  return {
    get model() { return model; },
    handle(requestId: unknown, req: Obj): void {
      const subtype = String(req.subtype);
      const forced = fail[subtype];
      if (forced === 'silent') return;
      const a = forced ? { error: `fake ${forced}`, code: forced } : answer(req);
      const response = 'response' in a
        ? { subtype: 'success', request_id: requestId, response: a.response }
        : { subtype: 'error', request_id: requestId, error: a.error, error_code: a.code };
      const d = cfg.delayMs;
      const ms = typeof d === 'number' ? d : Number((d as Obj | undefined)?.[subtype] ?? 0);
      const send = () => io.out({ type: 'control_response', response });
      if (ms > 0) setTimeout(send, ms); else send();
    },
  };
}
