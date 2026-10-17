import assert from "node:assert/strict";
import test from "node:test";
import { boundaryViolations } from "../boundary-ownership-rules.mjs";

const consumer = "apps/api/src/browser-execution/example.ts";

test("rejects cryptographic protection outside Veil, including aliased and namespace calls", () => {
  for (const source of [
    'import { createCipheriv as encrypt } from "node:crypto"; encrypt("aes-256-gcm", key, nonce);',
    'import * as crypto from "node:crypto"; crypto.createDecipheriv("aes-256-gcm", key, nonce);',
    "class ProtectionAuthority {}",
  ])
    assert.notEqual(boundaryViolations(consumer, source).length, 0);
});

test("rejects Assurance and Veil-internal dependencies through static and dynamic imports", () => {
  for (const source of [
    'import "@scry/assurance";',
    'await import("@scry/assurance/internal");',
    'export { authority } from "@scry/veil/src/protection-authority.js";',
    'import { authority } from "../../../../packages/veil/src/protection-authority.js";',
  ])
    assert.notEqual(boundaryViolations(consumer, source).length, 0);
});

test("permits public Veil capabilities and keeps Veil independent of runtime implementations", () => {
  assert.deepEqual(
    boundaryViolations(consumer, 'import { ProtectionAuthority } from "@scry/veil";'),
    [],
  );
  assert.deepEqual(
    boundaryViolations(
      "packages/veil/src/cipher.ts",
      'import { createCipheriv } from "node:crypto"; createCipheriv("aes-256-gcm", key, nonce);',
    ),
    [],
  );
  for (const dependency of [
    "@scry/browser-runtime",
    "@scry/chronicle",
    "playwright",
    "@nestjs/common",
  ]) {
    assert.notEqual(
      boundaryViolations(
        "packages/veil/src/authority.ts",
        `import { implementation } from "${dependency}";`,
      ).length,
      0,
    );
  }
});
