import assert from "node:assert/strict";
import { it as test } from "vitest";
import {
  createSessionDenials,
  DENIAL_LIMITS,
  type DenialCursor,
} from "../src/mcp-native/scope-denials.js";

const blocked = (origin: unknown) => ({ origin, reason: "origin_not_allowed" });
const identity = (value: string) => value;

test("existing callback becomes contextual diagnostics without an app/action verdict", () => {
  const collector = createSessionDenials({ clean: identity });
  collector.record(blocked("https://dependency.example"));
  collector.record(blocked("https://dependency.example"));
  collector.record(blocked("http://dependency.example:8080"));
  const snapshot = collector.snapshot();
  assert.equal(snapshot.denialCount, 3);
  assert.equal(snapshot.scopeRestrictionObserved, true);
  assert.deepEqual(snapshot.endpoints, [
    { transport: "http_origin", endpoint: "https://dependency.example", count: 2 },
    { transport: "http_origin", endpoint: "http://dependency.example:8080", count: 1 },
  ]);
  assert.equal(snapshot.interpretation, "contextual_observation_only");
  assert.equal(snapshot.applicationConclusion, "not_determined");
  assert.equal(snapshot.actionDispatch, "not_determined");
  assert.equal(snapshot.causalAssociation, "not_established");
});

test("CONNECT stays an endpoint, never implies HTTPS, origin approval, or dispatch state", () => {
  const collector = createSessionDenials({ clean: identity });
  for (const origin of [
    "tunnel://::1:443", // Existing proxy callback can emit this ambiguous IPv6 form.
    "tunnel://socket.example:0443",
    "tunnel://socket.example:0",
    "tunnel://socket.example:65536",
    "tunnel://Socket.example:443",
    "tunnel://socket.example:443/",
    "tunnel://u:p@socket.example:443",
    "tunnel://socket.example:443?token=secret",
    "tunnel://[0:0:0:0:0:0:0:1]:443",
  ])
    collector.record(blocked(origin));
  for (const origin of [
    "tunnel://socket.example:80",
    "tunnel://socket.example:443",
    "tunnel://[::1]:443",
  ])
    collector.record(blocked(origin));
  const snapshot = collector.snapshot();
  assert.equal(snapshot.denialCount, 12);
  assert.equal(snapshot.detailUnavailableCount, 5);
  assert.equal(snapshot.droppedCallbackCount, 4);
  assert.deepEqual(snapshot.endpoints, [
    { transport: "connect_endpoint", endpoint: "socket.example:80", count: 1 },
    { transport: "connect_endpoint", endpoint: "socket.example:443", count: 1 },
    { transport: "connect_endpoint", endpoint: "[::1]:443", count: 1 },
  ]);
  assert.equal(JSON.stringify(snapshot).includes("https://"), false);
  assert.equal(snapshot.applicationConclusion, "not_determined");
});

test("noncanonical URL injection never reaches cleaner, storage display, or error strings", () => {
  const cleaned: string[] = [];
  const collector = createSessionDenials({
    clean: (value) => {
      cleaned.push(value);
      return value;
    },
  });
  const rejected = [
    "https://dependency.example/path",
    "https://dependency.example/",
    "https://dependency.example?token=raw",
    "https://dependency.example#secret",
    "https://u:p@dependency.example",
    "https://Dependency.example",
    "https://dependency.example:443",
    "https://dependency.example\n",
    " https://dependency.example",
    "https://dependency.example\\injected",
    "https://%64ependency.example",
    "https://127.1",
    "file:///secret",
    "data:text/plain,secret",
    "javascript:secret",
    "not-a-url",
  ];
  for (const origin of rejected) collector.record(blocked(origin));
  const snapshot = collector.snapshot();
  assert.equal(snapshot.denialCount, rejected.length);
  assert.equal(snapshot.detailUnavailableCount, Math.min(rejected.length, DENIAL_LIMITS.capacity));
  assert.equal(snapshot.droppedDenialCount, rejected.length - DENIAL_LIMITS.capacity);
  assert.deepEqual(cleaned, []);
  assert.deepEqual(snapshot.endpoints, []);
  const output = JSON.stringify(snapshot);
  for (const forbidden of ["token=", "u:p@", "injected", "javascript:", "raw", "secret", "path"])
    assert.equal(output.includes(forbidden), false);
});

test("the injected privacy owner can suppress secret hosts without changing counts", () => {
  const secret = "seeded-secret-982734";
  const collector = createSessionDenials({
    clean: (value) => (value.includes(secret) ? "[PROTECTED]" : value),
  });
  collector.record(blocked(`https://${secret}.example`));
  collector.record(blocked(`tunnel://${secret}.example:443`));
  collector.record(blocked("https://public.example"));
  const snapshot = collector.snapshot();
  assert.equal(snapshot.denialCount, 3);
  assert.equal(snapshot.detailUnavailableCount, 2);
  assert.deepEqual(snapshot.unavailableReasons, ["display_redacted"]);
  assert.deepEqual(snapshot.endpoints, [
    { transport: "http_origin", endpoint: "https://public.example", count: 1 },
  ]);
  const output = JSON.stringify(snapshot);
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes("PROTECTED"), false);
});

test("missing, failed, changed and unknown cleaners fail closed while preserving counts", () => {
  const cases = [
    { clean: undefined, issue: "cleaner_missing" },
    {
      clean: () => {
        throw Error("RAW_PASSWORD=secret");
      },
      issue: "cleaner_failed",
    },
    ...[
      null,
      {},
      [],
      42,
      false,
      Symbol("secret"),
      Promise.resolve("https://hidden.example"),
      Promise.reject(Error("raw-secret-from-async-cleaner")),
      {
        get then() {
          throw Error("raw-secret-from-thenable");
        },
      },
    ].map((output) => ({ clean: () => output, issue: "cleaner_output_invalid" })),
    { clean: () => "[PROTECTED]", issue: "display_redacted" },
    { clean: () => "https://other.example", issue: "display_redacted" },
    { clean: () => "https://hidden.example/path?secret=raw", issue: "display_redacted" },
  ];
  for (const { clean, issue } of cases) {
    const collector = createSessionDenials(clean ? { clean } : {});
    collector.record(blocked("https://hidden.example"));
    const snapshot = collector.snapshot();
    assert.equal(snapshot.denialCount, 1);
    assert.equal(snapshot.detailUnavailableCount, 1);
    assert.deepEqual(snapshot.endpoints, []);
    assert.deepEqual(snapshot.unavailableReasons, [issue]);
    assert.equal(JSON.stringify(snapshot).includes("hidden"), false);
    assert.equal(JSON.stringify(snapshot).includes("secret"), false);
  }
});

test("fixed ring overload preserves aggregate counts and explicit truncation", () => {
  let calls = 0;
  const collector = createSessionDenials({
    capacity: 3,
    clean: (value) => {
      calls++;
      return value;
    },
  });
  const start = collector.cursor();
  for (let i = 0; i < 25_000; i++) collector.record(blocked(`https://destination-${i}.example`));
  const snapshot = collector.snapshot(start);
  assert.equal(snapshot.denialCount, 25_000);
  assert.equal(snapshot.observedCallbackCount, 25_000);
  assert.equal(snapshot.retainedCallbackCount, 3);
  assert.equal(snapshot.droppedCallbackCount, 24_997);
  assert.equal(snapshot.droppedDenialCount, 24_997);
  assert.equal(snapshot.endpoints.length, 3);
  assert.equal(calls, 3);
  assert.deepEqual(
    snapshot.endpoints.map((item) => item.endpoint),
    [
      "https://destination-24997.example",
      "https://destination-24998.example",
      "https://destination-24999.example",
    ],
  );
  assert.equal(snapshot.countsExact, true);
});

test("oversized, malformed and hostile callback objects stay count-only and bounded", () => {
  const collector = createSessionDenials({
    capacity: 5,
    clean: () => {
      assert.fail("must not sanitize malformed input");
    },
  });
  const huge = `https://${"x".repeat(100_000)}.example`;
  for (let i = 0; i < 1000; i++) collector.record(blocked(huge));
  collector.record(null);
  collector.record({ reason: "unexpected", origin: "https://valid.example" });
  collector.record(
    new Proxy(
      {},
      {
        get() {
          throw Error("raw-secret");
        },
      },
    ),
  );
  collector.record({
    reason: "origin_not_allowed",
    get origin() {
      throw Error("raw-secret");
    },
  });
  collector.record(blocked(huge));
  const snapshot = collector.snapshot();
  assert.equal(snapshot.observedCallbackCount, 1005);
  assert.equal(snapshot.denialCount, 1002);
  assert.equal(snapshot.retainedCallbackCount, 5);
  assert.equal(snapshot.droppedCallbackCount, 1000);
  assert.equal(snapshot.droppedDenialCount, 1000);
  assert.equal(snapshot.detailUnavailableCount, 2);
  assert.deepEqual(snapshot.endpoints, []);
  assert.equal(JSON.stringify(snapshot).length < 1500, true);
  assert.equal(JSON.stringify(snapshot).includes("raw-secret"), false);
});

test("prior and since cursors are temporal windows, do not consume events or claim causality", () => {
  const collector = createSessionDenials({ capacity: 2, clean: identity });
  collector.record(blocked("https://prior.example"));
  const prior = collector.snapshot();
  collector.record(blocked("https://since.example"));
  const since = collector.snapshot(prior.cursor);
  assert.equal(prior.window, "session_to_snapshot");
  assert.equal(since.window, "cursor_to_snapshot");
  assert.equal(since.denialCount, 1);
  assert.deepEqual(
    since.endpoints.map((item) => item.endpoint),
    ["https://since.example"],
  );
  assert.equal(since.causalAssociation, "not_established");
  assert.deepEqual(collector.snapshot(prior.cursor).endpoints, since.endpoints);
  assert.equal(collector.snapshot(since.cursor).denialCount, 0);
  assert.equal(collector.snapshot(since.cursor).scopeRestrictionObserved, false);
  assert.equal(collector.snapshot().denialCount, 2);
});

test("sessions, invalid/forged cursors, clear and disposal are independent", () => {
  const a = createSessionDenials({ clean: identity });
  const b = createSessionDenials({ clean: identity });
  a.record(blocked("https://a.example"));
  b.record(blocked("https://b.example"));
  const old = a.cursor();
  assert.deepEqual(Object.keys(old), []);
  for (const invalid of [b.cursor(), {}, Object.create(Object.getPrototypeOf(old))]) {
    const snapshot = a.snapshot(invalid as DenialCursor);
    assert.equal(snapshot.cursorStatus, "invalid");
    assert.equal(snapshot.window, "session_to_snapshot");
    assert.equal(snapshot.denialCount, 1);
  }
  a.clear();
  assert.equal(a.snapshot(old).cursorStatus, "invalid");
  assert.equal(a.snapshot().denialCount, 0);
  assert.deepEqual(a.snapshot().endpoints, []);
  assert.equal(b.snapshot().denialCount, 1);
  a.record(blocked("https://new.example"));
  a.dispose();
  a.record(blocked("https://ignored.example"));
  a.clear();
  const stopped = a.snapshot();
  assert.equal(stopped.lifecycle, "disposed");
  assert.equal(stopped.denialCount, 0);
  assert.deepEqual(stopped.endpoints, []);
});

test("concurrent callbacks/snapshots retain atomic bounded immutable observations", async () => {
  const collector = createSessionDenials({ capacity: 7, clean: identity });
  const snapshots = await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      Promise.resolve().then(() => {
        collector.record(blocked(`https://event-${i}.example`));
        return collector.snapshot();
      }),
    ),
  );
  snapshots.forEach((snapshot, i) => {
    assert.equal(snapshot.denialCount, i + 1);
    assert.equal(snapshot.retainedCallbackCount, Math.min(7, i + 1));
    assert.equal(snapshot.droppedCallbackCount, Math.max(0, i + 1 - 7));
    assert.equal(snapshot.endpoints.at(-1)?.endpoint, `https://event-${i}.example`);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.endpoints), true);
    snapshot.endpoints.forEach((item) => assert.equal(Object.isFrozen(item), true));
  });
  assert.equal(snapshots[0]?.endpoints[0]?.endpoint, "https://event-0.example");
});

test("a reentrant cleaner cannot rewrite the snapshot's captured temporal window", () => {
  let reentered = false;
  const collector = createSessionDenials({
    clean: (value) => {
      if (!reentered) {
        reentered = true;
        collector.clear();
        collector.record(blocked("https://later.example"));
      }
      return value;
    },
  });
  collector.record(blocked("https://captured.example"));
  const snapshot = collector.snapshot();
  assert.equal(snapshot.denialCount, 1);
  assert.equal(snapshot.endpoints[0]?.endpoint, "https://captured.example");
  const next = collector.snapshot(snapshot.cursor);
  assert.equal(next.cursorStatus, "invalid");
  assert.equal(next.endpoints[0]?.endpoint, "https://later.example");
});

test("capacity is finite and explicit; larger callback populations cannot expand output", () => {
  for (const capacity of [0, -1, 1.5, NaN, Infinity, DENIAL_LIMITS.maxCapacity + 1])
    assert.throws(() => createSessionDenials({ capacity }), /INVALID_DENIAL_CAPACITY/);
  const collector = createSessionDenials({ capacity: DENIAL_LIMITS.maxCapacity, clean: identity });
  for (let i = 0; i < 1000; i++) collector.record(blocked(`https://bounded-${i}.example`));
  assert.equal(collector.snapshot().endpoints.length, DENIAL_LIMITS.maxCapacity);
});
