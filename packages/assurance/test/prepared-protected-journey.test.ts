import { describe, expect, it } from "vitest";

import { compareProtectedJourneyContinuity } from "../src/architecture/q3/comparator.js";

describe("prepared protected journey invariants", () => {
  const digest = "a".repeat(64);

  it("accepts one applied mutation followed by exact GET retrieval", () => {
    expect(
      compareProtectedJourneyContinuity({
        createdIdentityDigest: digest,
        retrievedIdentityDigest: digest,
        sourceMutationRepeatable: false,
        continuation: "read_only_retrieve",
        consumerMethod: "GET",
        mutationOutcome: "applied",
        dispatchCount: 1,
        protectedPlaintextObserved: false,
      }),
    ).toEqual({ verdict: "PASS", reasons: [] });
  });

  it("rejects mutation replay, identity mismatch, unsafe retrieval, plaintext, and UNKNOWN progression", () => {
    expect(
      compareProtectedJourneyContinuity({
        createdIdentityDigest: "a".repeat(64),
        retrievedIdentityDigest: "b".repeat(64),
        sourceMutationRepeatable: true,
        continuation: "read_only_retrieve",
        consumerMethod: "POST",
        mutationOutcome: "unknown",
        dispatchCount: 2,
        protectedPlaintextObserved: true,
      }).reasons,
    ).toEqual([
      "CREATED_RETRIEVED_IDENTITY_MISMATCH",
      "SOURCE_MUTATION_REPEATABLE",
      "PROTECTED_DISPATCH_COUNT_MISMATCH",
      "PROTECTED_PLAINTEXT_OBSERVED",
      "UNKNOWN_CONTINUATION_NOT_RECONCILIATION",
      "RETRIEVAL_CONSUMER_NOT_READ_ONLY",
    ]);
  });
});
