import { describe, expect, test } from 'bun:test';
import { Caffeinate } from '../../src/session/caffeinate.ts';

function fake(enabled = true) {
  const spawned: string[][] = [];
  let killed = 0;
  const c = new Caffeinate({ enabled: () => enabled, pid: 4242, spawner: (argv) => { spawned.push(argv); return { kill: () => { killed++; } }; } });
  return { c, spawned, killed: () => killed };
}

describe('caffeinate (§7.1 Mac ngủ)', () => {
  test('§7.1 one caffeinate -i -w <engine pid> while ≥1 session runs, stopped at zero', () => {
    const f = fake();
    const r1 = f.c.acquire();
    const r2 = f.c.acquire();
    expect(f.spawned).toEqual([['caffeinate', '-i', '-w', '4242']]);
    r1();
    expect(f.killed()).toBe(0);
    r2();
    expect(f.killed()).toBe(1);
    f.c.acquire();
    expect(f.spawned).toHaveLength(2);
  });
  test('§7.1 release is idempotent (a double release does not under-count)', () => {
    const f = fake();
    const r1 = f.c.acquire();
    f.c.acquire();
    r1(); r1();
    expect(f.killed()).toBe(0);
    expect(f.c.count).toBe(1);
  });
  test('§7.1 setting off → never spawns', () => {
    const f = fake(false);
    f.c.acquire()();
    expect(f.spawned).toEqual([]);
  });
});
