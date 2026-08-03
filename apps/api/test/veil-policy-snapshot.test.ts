import { describe, expect, it } from "vitest";
import { VeilAuthority } from "@scry/executor";

import { snapshotVeilPolicy } from "../src/veil-policy-snapshot.js";

const executionPolicy = {
  allowedOrigins: ["https://example.test"], allowPrivateNetwork: false, allowDownloads: false as const,
  allowPopups: false as const, maxActions: 100, maxDurationMs: 120_000, maxNavigations: 10,
};

describe("run-bound Veil policy snapshots", () => {
  it("makes persisted private preferences authoritative for capture", () => {
    const snapshot = snapshotVeilPolicy(executionPolicy, { profile: "private", allowedOrigins: ["https://example.test"] });
    const authority = new VeilAuthority(snapshot);
    expect(snapshot.controls.video).toBe(false);
    expect(authority.decide({
      context: { userId: "user", environmentId: "env", transactionId: "tx", origin: "https://example.test", browserContextId: "browser", pageId: "page", frameId: "frame", documentEpoch: 1 },
      operation: "capture", channel: "video", classification: "public", scope: "channel",
    })).toMatchObject({ disposition: "suppress", policyDigest: snapshot.digest, reasonCode: "VEIL_CHANNEL_DISABLED" });
  });

  it("does not mutate an existing run snapshot when later preferences change", () => {
    const original = snapshotVeilPolicy(executionPolicy, { profile: "private", allowedOrigins: ["https://example.test"] });
    const later = snapshotVeilPolicy(executionPolicy, { profile: "minimal_capture", allowedOrigins: ["https://example.test"] });
    expect(original.profile).toBe("private");
    expect(original.controls.screenshots).toBe(true);
    expect(later.controls.screenshots).toBe(false);
    expect(later.digest).not.toBe(original.digest);
  });
});
