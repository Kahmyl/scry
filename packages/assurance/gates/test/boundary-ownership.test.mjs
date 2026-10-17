import assert from "node:assert/strict";
import test from "node:test";
import { boundaryViolations } from "../boundary-ownership-rules.mjs";

const consumer = "apps/api/src/browser-execution/example.ts";

test("Praxis is the only browser driver owner and consumes only boundary contracts", () => {
  const praxis = "packages/praxis/src/browser-engine.ts";
  for (const dependency of ["playwright", "rrweb"]) {
    assert.deepEqual(
      boundaryViolations(praxis, `import { implementation } from "${dependency}";`),
      [],
    );
    assert.notEqual(boundaryViolations(consumer, `await import("${dependency}");`).length, 0);
  }
  for (const dependency of [
    "@scry/veil",
    "@scry/chronicle",
    "@nestjs/common",
    "pg",
    "../../../apps/api/src/infrastructure/database.js",
  ])
    assert.notEqual(
      boundaryViolations(praxis, `import { implementation } from "${dependency}";`).length,
      0,
    );
  assert.notEqual(
    boundaryViolations(consumer, 'import { engine } from "@scry/praxis/src/browser-engine.js";')
      .length,
    0,
  );
});

test("rejects duplicate evidence custody and evidence writes outside Chronicle", () => {
  for (const source of [
    "class AuthenticatedEvidenceStore {}",
    "const statement = `INSERT INTO browser_effect_events(effect_id) VALUES($1)`;",
    'const statement = "UPDATE browser_captures SET state=$1";',
  ]) {
    assert.notEqual(boundaryViolations(consumer, source).length, 0);
    assert.deepEqual(boundaryViolations("packages/chronicle/src/repository.ts", source), []);
  }
});

test("Chronicle accepts capabilities without depending on their implementations", () => {
  for (const dependency of ["@scry/veil", "@scry/chronicle"])
    assert.notEqual(
      boundaryViolations(
        "packages/praxis/src/recorder.ts",
        `import { implementation } from "${dependency}";`,
      ).length,
      0,
    );
  const owner = "packages/chronicle/src/example.ts";
  assert.deepEqual(
    boundaryViolations(owner, 'import type { EvidenceProtectionPort } from "@scry/contracts";'),
    [],
  );
  for (const dependency of [
    "@scry/veil",
    "@scry/browser-runtime",
    "playwright",
    "rrweb",
    "pg",
    "@scry/assurance",
    "../../veil/src/index.js",
  ])
    assert.notEqual(boundaryViolations(owner, `await import("${dependency}");`).length, 0);
  assert.notEqual(
    boundaryViolations(consumer, 'import { store } from "@scry/chronicle/src/index.js";').length,
    0,
  );
});

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
    'import { report } from "../../../../packages/assurance/src/index.js";',
    'export { authority } from "@scry/veil/src/protection-authority.js";',
    'import { authority } from "../../../../packages/veil/src/protection-authority.js";',
  ])
    assert.notEqual(boundaryViolations(consumer, source).length, 0);
});

test("Assurance interprets public facts without importing application or custody internals", () => {
  const analysis = "packages/assurance/src/diagnostics.ts";
  const fixture = "packages/assurance/test/browser-recording.test.ts";
  assert.deepEqual(
    boundaryViolations(
      analysis,
      'import type { ChronicleRecordingDiagnostics } from "@scry/contracts";',
    ),
    [],
  );
  for (const dependency of ["@scry/praxis", "@scry/veil", "@scry/chronicle", "playwright"]) {
    assert.deepEqual(boundaryViolations(fixture, `import { publicApi } from "${dependency}";`), []);
    assert.notEqual(
      boundaryViolations(analysis, `import { implementation } from "${dependency}";`).length,
      0,
    );
  }
  for (const dependency of [
    "pg",
    "@nestjs/common",
    "@scry/api",
    "@scry/chronicle/src/index.js",
    "../../../apps/api/src/infrastructure/database.js",
  ]) {
    assert.notEqual(boundaryViolations(analysis, `await import("${dependency}");`).length, 0);
    assert.notEqual(boundaryViolations(fixture, `await import("${dependency}");`).length, 0);
  }
  for (const source of [
    "class ChronicleRepository {}",
    'const sql = "UPDATE browser_captures SET state=$1";',
  ])
    assert.notEqual(boundaryViolations(analysis, source).length, 0);
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
