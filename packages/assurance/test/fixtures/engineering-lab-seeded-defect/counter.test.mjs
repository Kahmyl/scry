import assert from "node:assert/strict";
import test from "node:test";

import { increment } from "./counter.mjs";

test("increment advances by exactly one", () => {
  assert.equal(increment(4), 5);
});
