import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  currentPlanSchema,
  executionPolicySchema,
  type InteractionTargetIntent,
} from "@scry/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { probeFlowPlan } from "../src/probe.js";

let server: Server;
let origin: string;
const directories: string[] = [];

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`
      <main>
        <button type="button" aria-label="Open documentation">
          Docs
        </button>

        <nav aria-label="Partner navigation">
          <a href="/dashboard">Dashboard</a>
          <a href="/orders">Orders</a>
        </nav>
      </main>
    `);
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("probe server unavailable");
  }

  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));

  await Promise.all(
    directories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("probe Veil composition boundary", () => {
  it("authorizes a real inspection page before Praxis schedules observation", async () => {
    const result = await probeFlowPlan({
      ...(await probeInput("inspection")),
      plan: planWithInspectionTarget(),
    });

    expect(result.allResolved).toBe(true);
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]).toMatchObject({
      stepId: "inspect-docs",
      status: "resolved",
    });
    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PRAXIS_VEIL_SCHEDULE_REFUSED",
        }),
      ]),
    );
  }, 20_000);

  it("carries the same privacy context into reversible execution", async () => {
    const result = await probeFlowPlan({
      ...(await probeInput("reversible")),
      plan: planWithNavigationOnly(),
    });

    expect(result.allResolved).toBe(true);
    expect(result.execution).toMatchObject({
      state: "passed",
    });
    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "VEIL_ADMISSION_KEY_REQUIRED",
        }),
      ]),
    );
  }, 25_000);

  it("returns an unresolved target as a probe diagnostic", async () => {
    const result = await probeFlowPlan({
      ...(await probeInput("inspection")),
      plan: plan([
        {
          id: "inspect-missing-control",
          title: "Inspect missing control",
          action: {
            type: "waitFor",
            target: target("missing_control", "button", "Control that does not exist"),
            state: "visible",
          },
          assertions: [],
          evidence: [],
          onFailure: "stop",
          captureIntent: "final",
        },
      ]),
    });

    expect(result.allResolved).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepId: "inspect-missing-control",
          channel: "action",
        }),
      ]),
    );
  }, 20_000);

  it("marks a missing visibility-change click as redundant when its effect target is already visible", async () => {
    const result = await probeFlowPlan({
      ...(await probeInput("inspection")),
      plan: planWithAlreadyExpandedNavigation(),
    });

    expect(result.allResolved).toBe(true);

    expect(result.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepId: "open-menu",
          channel: "action",
          status: "redundant",
          reason: "expected_effect_already_satisfied",
        }),
        expect.objectContaining({
          stepId: "open-orders",
          channel: "action",
          status: "resolved",
        }),
      ]),
    );

    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stepId: "open-menu",
        }),
      ]),
    );
  }, 20_000);
});

async function probeInput(level: "inspection" | "reversible") {
  const outputDirectory = await mkdtemp(
    path.join(tmpdir(), "scry-probe-veil-test-"),
  );

  directories.push(outputDirectory);

  return {
    level,
    policy: executionPolicySchema.parse({
      allowedOrigins: [origin],
      allowPrivateNetwork: true,
    }),
    browserChannel: process.env.SCRY_BROWSER_CHANNEL ?? "chrome",
    outputDirectory,
    privacy: {
      environmentId: "probe-test-environment",
      veilAdmissionKey: "probe-test-only-veil-admission-key-32-bytes",
    },
  };
}

function planWithNavigationOnly() {
  return plan([]);
}

function planWithInspectionTarget() {
  return plan([
    {
      id: "inspect-docs",
      title: "Inspect documentation control",
      action: {
        type: "waitFor",
        target: target(
          "open_documentation",
          "button",
          "Open documentation",
        ),
        state: "visible",
      },
      assertions: [],
      evidence: [],
      onFailure: "stop",
      captureIntent: "final",
    },
  ]);
}

function planWithAlreadyExpandedNavigation() {
  const ordersTarget = target("orders", "link", "Orders");

  return plan([
    {
      id: "open-menu",
      title: "Open partner navigation",
      action: {
        type: "click",
        target: target("open_menu", "button", "Open menu"),
        expectedEffect: {
          type: "visibility_change",
          target: ordersTarget,
          visible: true,
        },
      },
      assertions: [],
      evidence: [],
      onFailure: "stop",
      captureIntent: "final",
    },
    {
      id: "open-orders",
      title: "Open orders",
      action: {
        type: "click",
        target: ordersTarget,
        expectedEffect: {
          type: "navigation",
          url: "/orders",
          match: "path",
        },
      },
      assertions: [],
      evidence: [],
      onFailure: "stop",
      captureIntent: "final",
    },
  ]);
}

function target(
  concept: string,
  role: string,
  name: string,
): InteractionTargetIntent {
  return {
    concept,
    requiredCapabilities: ["pointer_activatable"],
    preferredEvidence: {
      roles: [role],
      names: [name],
      labels: [name],
      descriptions: [],
      placeholders: [],
      inputTypes: [],
    },
    scope: {
      kind: "page",
    },
    relations: [],
    prohibited: ["hidden", "disabled"],
    risk: "read_only",
    confidence: {
      requiredFamilies: [],
      minimum: 0.35,
      minimumMargin: 0,
      minimumFamilyCount: 1,
    },
  };
}

function plan(extraSteps: unknown[]) {
  return currentPlanSchema.parse({
    name: "Probe Veil boundary",
    objective: "Inspect through the production probe boundary",
    allowedOrigins: [origin],
    budgets: {
      maxActions: 4,
      maxDurationMs: 15_000,
      maxNavigations: 2,
    },
    checkpoints: [],
    steps: [
      {
        id: "open",
        title: "Open fixture",
        action: {
          type: "navigate",
          url: origin,
        },
        assertions: [],
        evidence: [],
        onFailure: "stop",
        captureIntent: "final",
      },
      ...extraSteps,
    ],
  });
}