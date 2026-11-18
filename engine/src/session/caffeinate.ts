// Keeps the Mac awake while ≥1 session runs (spec §7.1 "Mac ngủ"): one `caffeinate -i -w <engine pid>`, ref-counted.
// `-w` makes caffeinate exit with the engine, so a crashed engine never leaves the Mac awake.

export interface Held { kill(): void }
export type CaffeinateSpawner = (argv: string[]) => Held;

const defaultSpawner: CaffeinateSpawner = (argv) => {
  const p = Bun.spawn(argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  return { kill: () => p.kill('SIGTERM') };
};

export interface CaffeinateOptions {
  /** config.caffeinate (read on each acquire so a settings change applies to the next hold). */
  enabled: () => boolean;
  pid?: number;
  spawner?: CaffeinateSpawner;
}

export class Caffeinate {
  private n = 0;
  private held: Held | null = null;
  private readonly pid: number;
  private readonly spawner: CaffeinateSpawner;

  constructor(private readonly opts: CaffeinateOptions) {
    this.pid = opts.pid ?? process.pid;
    this.spawner = opts.spawner ?? defaultSpawner;
  }

  get count(): number { return this.n; }

  /** Returns an idempotent release. */
  acquire(): () => void {
    this.n++;
    if (this.n === 1 && !this.held && this.opts.enabled()) {
      try { this.held = this.spawner(['caffeinate', '-i', '-w', String(this.pid)]); } catch { this.held = null; }
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.n--;
      if (this.n === 0 && this.held) { this.held.kill(); this.held = null; }
    };
  }
}
