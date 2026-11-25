import assert from "node:assert/strict";
import { before, after, test } from "node:test";
export const beforeAll = before,
  afterAll = after;
export const it = {
  each: (rows: readonly any[]) => (name: string, run: (...args: any[]) => Promise<void>) => {
    for (const args of rows) test(name.replace("%s", String(args[0])), async () => run(...args));
  },
};
export function expect(actual: any) {
  return {
    toBe: (expected: any) => assert.strictEqual(actual, expected),
    toBeTruthy: () => assert.ok(actual),
    not: { toBe: (expected: any) => assert.notStrictEqual(actual, expected) },
  };
}
