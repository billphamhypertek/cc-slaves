import { expect } from 'bun:test';

type AsyncMatchers = { [K in keyof ReturnType<typeof expect>]: ReturnType<typeof expect>[K] extends (...a: infer A) => unknown ? (...a: A) => Promise<void> : never };

/**
 * `expect(p).rejects` with the type it has at runtime: bun-types declares its matchers as `void`, but Bun returns a
 * promise the test must await (else the assertion settles after the test). `await rejects(p).toThrow(…)`.
 */
export const rejects = (p: Promise<unknown>): AsyncMatchers => expect(p).rejects as unknown as AsyncMatchers;
