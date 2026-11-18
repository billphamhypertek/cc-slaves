// v2.1 §5.3 W10 token meter: cumulative counts that move within a turn. Each `assistant` line adds its `message.usage`
// provisionally (one API message is split over several lines with the same `message.id` → counted once, last wins);
// the turn's `result.usage` then replaces the provisional sum exactly.
import { addTokens, ZERO_TOKENS, type TokenCounts } from '../../../shared/protocol.ts';
import type { MessageEvent, ResultEvent } from './parser.ts';
import { isObj } from '../../../shared/json.ts';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Claude `usage` → TokenCounts; null when it carries none of the four fields. */
export function usageOf(u: unknown): TokenCounts | null {
  if (!isObj(u)) return null;
  const p = [u.input_tokens, u.output_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens].map(num);
  if (p.every((x) => x === null)) return null;
  return { input: p[0] ?? 0, output: p[1] ?? 0, cacheWrite: p[2] ?? 0, cacheRead: p[3] ?? 0 };
}

const same = (a: TokenCounts, b: TokenCounts) =>
  a.input === b.input && a.output === b.output && a.cacheWrite === b.cacheWrite && a.cacheRead === b.cacheRead;
const sum = (xs: Iterable<TokenCounts>): TokenCounts => { let t: TokenCounts = ZERO_TOKENS; for (const x of xs) t = addTokens(t, x); return t; };

export class TokenMeter {
  private committed: TokenCounts;
  private readonly turn = new Map<string, TokenCounts>();
  private anon = 0;

  constructor(base: TokenCounts = ZERO_TOKENS) { this.committed = { ...base }; }

  /** Adds one assistant line's usage to the running turn; true when the total changed. */
  assistant(e: MessageEvent): boolean {
    const msg = isObj(e.message) ? e.message : {};
    const u = usageOf(msg.usage);
    if (u === null) return false;
    const id = typeof msg.id === 'string' ? msg.id : `\u0000${this.anon++}`;
    const prev = this.turn.get(id);
    if (prev && same(prev, u)) return false;
    this.turn.set(id, u);
    return true;
  }

  /** Ends the turn: `result.usage` (or the provisional sum when absent) is committed; returns the turn's exact usage. */
  result(r: ResultEvent): TokenCounts {
    const exact = r.usage ?? this.provisional;
    this.committed = addTokens(this.committed, exact);
    this.turn.clear();
    return exact;
  }

  /**
   * The process died or was stopped mid-turn (no result will come): keep what it reported. Returns that sum for the
   * caller to store (a `usage` event, §5.3), null when the turn reported none.
   */
  abandon(): TokenCounts | null {
    const cut = this.provisional;
    this.committed = addTokens(this.committed, cut);
    this.turn.clear();
    return same(cut, ZERO_TOKENS) ? null : cut;
  }

  get provisional(): TokenCounts { return sum(this.turn.values()); }
  get total(): TokenCounts { return addTokens(this.committed, this.provisional); }
}
