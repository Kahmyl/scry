import { readFile } from "node:fs/promises";

import { currentPlanSchema, type InteractionTargetIntent } from "@scry/contracts";
import { describe, expect, it } from "vitest";

import { AuthenticationAuthoringService } from "../src/authentication-authoring/index.js";
import { deriveCompiledPlan } from "../src/authoring/authoring.service.js";

const probeSessionId = "00000000-0000-4000-8000-000000000021";

describe("Vitract authoring vertical", () => {
  it("treats already-visible desktop navigation as redundant and keeps auth single-shot", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("../../../scripts/fixtures/vitract-login-baseline.json", import.meta.url),
        "utf8",
      ),
    );
    const attempts = new SingleShotAttemptRepository();
    const authentication = new AuthenticationAuthoringService(attempts as never);
    const ordersTarget = target("orders", "link", "Orders");
    const plan = currentPlanSchema.parse({
      name: "Vitract partner orders",
      objective: "Authenticate to Vitract and open partner orders",
      preconditions: [],
      allowedOrigins: ["https://preview.vitract.com"],
      budgets: {
        maxActions: 4,
        maxDurationMs: 45_000,
        maxNavigations: 3,
      },
      checkpoints: [],
      steps: [
        {
          id: "open-login",
          title: "Open Vitract login",
          action: {
            type: "navigate",
            url: fixture.target.url,
          },
          assertions: [],
          onFailure: "stop",
          evidence: [],
          captureIntent: "final",
        },
        {
          id: "open-menu",
          title: fixture.observedOutcome.failedStepTitle,
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
          onFailure: "stop",
          evidence: [],
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
          onFailure: "stop",
          evidence: [],
          captureIntent: "final",
        },
      ],
    });

    const authContext = {
      probeSessionId,
      applicationOrigin: "https://preview.vitract.com",
      entryUrl: fixture.target.url,
      usernameInspection: {
        candidates: [
          {
            target: authTarget("Vitract username field", "1"),
            confidence: 0.94,
            runnerUpMargin: 0.5,
            evidenceKinds: ["autocomplete_username", "type_email", "praxis_verified"],
          },
        ],
      },
      passwordInspection: {
        candidates: [
          {
            target: authTarget("Vitract password field", "2"),
            confidence: 0.95,
            runnerUpMargin: 0.5,
            evidenceKinds: ["type_password", "autocomplete_current_password", "praxis_verified"],
          },
        ],
      },
      submissionInspection: {
        candidates: [
          {
            kind: "native_submit" as const,
            target: authTarget("Vitract sign in", "3"),
            confidence: 0.92,
            evidenceKinds: ["form_relationship", "praxis_verified"],
          },
        ],
      },
      stateInspection: {
        signals: [
          "login_response_success" as const,
          "url_not_login" as const,
          "login_form_absent" as const,
          "authenticated_navigation_present" as const,
          "portal_shell_present" as const,
        ],
      },
    };

    const username = await authentication.discoverUsernameField(authContext);
    const password = await authentication.discoverPasswordField(authContext);
    const submission = await authentication.discoverSubmissionPath(authContext);
    const submissionResult = await authentication.submitCredentialsOnce(authContext);
    const authenticatedState = await authentication.detectAuthenticatedState(authContext);
    const candidate = await authentication.createAuthenticationContractCandidate({
      probeSessionId,
      applicationOrigin: authContext.applicationOrigin,
      entryUrl: authContext.entryUrl,
      username,
      password,
      submission,
      submissionResult,
      authenticatedState,
      safeMetadata: {},
    });

    const compiled = deriveCompiledPlan(plan, [
      {
        stepId: "open-menu",
        channel: "action",
        status: "redundant",
        reason: "expected_effect_already_satisfied",
        expectedEffectTarget: {
          role: "link",
          accessibleName: "Orders",
        },
      },
      {
        stepId: "open-orders",
        channel: "action",
        status: "resolved",
      },
    ]);

    expect(fixture.observedOutcome.failureCode).toBe("TARGET_NOT_FOUND");
    expect(fixture.characterization.actualLayout).toBe("desktop-sidebar-expanded");
    expect(fixture.characterization.actualVisibleNavigation).toContain("Orders");
    expect(submissionResult.status).toBe("submitted");
    expect(attempts.created).toBe(1);
    expect(attempts.begun).toBe(1);
    expect(authenticatedState.status).toBe("authenticated");
    expect(authenticatedState.signals.length).toBeGreaterThanOrEqual(3);
    expect(compiled.steps.map((step) => step.id)).toEqual(["open-login", "open-orders"]);
    expect(JSON.stringify(candidate)).not.toMatch(/password=|token=|clipboard|selector|<html/i);
  });
});

type InteractionRole = InteractionTargetIntent["preferredEvidence"]["roles"][number];

function target(concept: string, role: InteractionRole, name: string): InteractionTargetIntent {
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

function authTarget(concept: string, suffix: string) {
  return {
    authority: "praxis" as const,
    fingerprint: `${suffix}`.repeat(64).slice(0, 64),
    concept,
    scopeKind: "document",
    capabilityDigest: `${Number(suffix) + 4}`.repeat(64).slice(0, 64),
  };
}

class SingleShotAttemptRepository {
  created = 0;
  begun = 0;

  async create() {
    this.created += 1;
    return "00000000-0000-4000-8000-000000000022";
  }

  async beginDispatch() {
    this.begun += 1;
    return true;
  }

  async finish() {}
}
