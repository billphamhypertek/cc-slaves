// v2.1 §4.2 line 3 / §5.3 "web tự giữ vòng đệm 10 phút": tokens / minute of the last 10 minutes from the `tokens` updates
// of each lane; §5.2 the series is recomputed at most once per 10 s.
export const SPARK_REDRAW_MS = 10_000;
const SPARK_WINDOW_MS = 10 * 60_000, SPARK_BUCKETS = 10;

export class SparkRing {
  private samples = new Map<string, [t: number, tok: number][]>();
  private cache = new Map<string, number[] | null>();
  private cacheAt = -1;

  /** One `tokens` update (displayTokens of the lane) at `t`. A lower total (a new lane with the same name) restarts. */
  push(key: string, t: number, tok: number): void {
    let s = this.samples.get(key);
    if (!s) this.samples.set(key, (s = []));
    const last = s.at(-1);
    if (last && tok < last[1]) s.length = 0;
    if (last && last[1] === tok && s.length) return;
    s.push([t, tok]);
    while (s.length > 2 && s[1]![0] < t - SPARK_WINDOW_MS) s.shift();
  }

  /** Tokens per minute in 10 one-minute buckets ending at `now`; null with < 2 samples. Cached per 10 s window. */
  series(key: string, now: number): number[] | null {
    const slot = Math.floor(now / SPARK_REDRAW_MS);
    if (slot !== this.cacheAt) { this.cache.clear(); this.cacheAt = slot; }
    if (this.cache.has(key)) return this.cache.get(key)!;
    const v = this.compute(key, slot * SPARK_REDRAW_MS);
    this.cache.set(key, v);
    return v;
  }

  private compute(key: string, now: number): number[] | null {
    const s = this.samples.get(key);
    if (!s || s.length < 2) return null;
    const out = new Array<number>(SPARK_BUCKETS).fill(0), start = now - SPARK_WINDOW_MS, bw = SPARK_WINDOW_MS / SPARK_BUCKETS;
    for (let i = 1; i < s.length; i++) {
      const [t0, a] = s[i - 1]!, [t1, b] = s[i]!;
      if (t1 <= start || t0 >= now) continue;
      const k = Math.min(SPARK_BUCKETS - 1, Math.max(0, Math.floor((t1 - start) / bw)));
      out[k]! += (b - a) * (60_000 / bw);
    }
    return out;
  }
}

/** Polyline points of a 40 × 14 sparkline (mockup `spark`). */
export function sparkPoints(v: number[], w = 40, h = 14): string {
  const m = Math.max(1, ...v);
  return v.map((x, i) => `${((i / Math.max(1, v.length - 1)) * w).toFixed(1)},${(h - (x / m) * h).toFixed(1)}`).join(' ');
}
