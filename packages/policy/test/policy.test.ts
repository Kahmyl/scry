import { describe, expect, it } from "vitest";

import type { CurrentPlan, ExecutionPolicy } from "@scry/contracts";

import { isPrivateAddress, RuntimeRequestPolicy, SecretRedactor } from "../src/index.js";

describe("runtime policy helpers", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.1.1", "::1", "fd00::1"])(
    "recognizes private address %s",
    (address) => expect(isPrivateAddress(address)).toBe(true),
  );

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("permits public address %s", (address) =>
    expect(isPrivateAddress(address)).toBe(false),
  );

  it("redacts literal and URL-encoded secret values recursively", () => {
    const redactor = new SecretRedactor();
    redactor.add("a+b@example.invalid");
    expect(
      redactor.redactValue({
        message: "received a+b@example.invalid",
        url: "https://example.test/?email=a%2Bb%40example.invalid",
        "a+b@example.invalid": "secret used as a property name",
      }),
    ).toEqual({
      message: "received [REDACTED]",
      url: "https://example.test/?email=[REDACTED]",
      "[REDACTED]": "secret used as a property name",
    });
  });

  it("allows environment-approved page dependencies outside plan navigation origins", async () => {
    const plan = {
      name: "Page dependency policy",
      objective: "Load an approved application and its approved static assets.",
      preconditions: [],
      allowedOrigins: ["https://app.example.test"],
      budgets: {
        maxActions: 1,
        maxDurationMs: 10_000,
        maxNavigations: 1,
      },
      checkpoints: [],
      steps: [
        {
          id: "open-app",
          title: "Open app",
          action: { type: "navigate", url: "https://app.example.test" },
          assertions: [],
          onFailure: "stop",
          evidence: [],
          captureIntent: "final",
        },
      ],
    } satisfies CurrentPlan;
    const policy = {
      allowedOrigins: ["https://app.example.test", "https://assets.example.test"],
      allowPrivateNetwork: true,
      allowDownloads: false,
      allowPopups: false,
      maxActions: 10,
      maxDurationMs: 10_000,
      maxNavigations: 2,
    } satisfies ExecutionPolicy;

    const runtime = new RuntimeRequestPolicy(plan, policy);

    await expect(
      runtime.assertAllowed("https://assets.example.test/app.css"),
    ).resolves.toBeUndefined();
    await expect(
      runtime.assertAllowed("https://unapproved.example.test/tracker.js"),
    ).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
  });
});
