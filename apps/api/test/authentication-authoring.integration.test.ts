import { describe, expect, it } from "vitest";

import { AuthenticationAuthoringService } from "../src/authentication-authoring/index.js";

const digest = "c".repeat(64);

describe("authentication authoring kernel integration", () => {
  it("discovers fields, verifies submission, submits once, detects auth state, and creates a candidate", async () => {
    const attempts = new IntegrationAttemptRepository();
    const service = new AuthenticationAuthoringService({} as never, attempts as never);
    const probeSessionId = "00000000-0000-4000-8000-000000000011";
    const context = {
      probeSessionId,
      applicationOrigin: "https://vitract.example.test",
      entryUrl: "https://vitract.example.test/login",
      credentialReferenceId: "00000000-0000-4000-8000-000000000012",
      usernameInspection: {
        candidates: [
          {
            target: praxisTarget("Vitract email"),
            confidence: 0.93,
            runnerUpMargin: 0.42,
            evidenceKinds: ["autocomplete_username", "label", "praxis_verified"],
          },
        ],
      },
      passwordInspection: {
        candidates: [
          {
            target: praxisTarget("Vitract password"),
            confidence: 0.94,
            runnerUpMargin: 0.46,
            evidenceKinds: ["type_password", "form_relationship", "praxis_verified"],
          },
        ],
      },
      submissionInspection: {
        candidates: [
          {
            kind: "native_submit" as const,
            target: praxisTarget("Vitract sign in"),
            confidence: 0.91,
            evidenceKinds: ["form_relationship", "praxis_verified"],
          },
        ],
      },
      stateInspection: {
        signals: [
          "login_response_success" as const,
          "url_not_login" as const,
          "login_form_absent" as const,
          "portal_shell_present" as const,
        ],
      },
    };

    const username = await service.discoverUsernameField(context);
    const password = await service.discoverPasswordField(context);
    const submission = await service.discoverSubmissionPath(context);
    const submissionResult = await service.submitCredentialsOnce(context);
    const authenticatedState = await service.detectAuthenticatedState(context);
    const candidate = await service.createAuthenticationContractCandidate({
      probeSessionId,
      applicationOrigin: context.applicationOrigin,
      entryUrl: context.entryUrl,
      username,
      password,
      submission,
      submissionResult,
      authenticatedState,
      safeMetadata: {},
    });

    expect(username.status).toBe("resolved");
    expect(password.status).toBe("resolved");
    expect(submission.status).toBe("resolved");
    expect(submissionResult.status).toBe("submitted");
    expect(authenticatedState.status).toBe("authenticated");
    expect(candidate.applicationOrigin).toBe("https://vitract.example.test");
    expect(attempts.rows).toHaveLength(1);
    expect(JSON.stringify(candidate)).not.toMatch(/password=|token=|clipboard|selector|<html/i);
  });
});

function praxisTarget(concept: string) {
  return {
    authority: "praxis" as const,
    fingerprint: digest,
    concept,
    scopeKind: "document",
    capabilityDigest: "d".repeat(64),
  };
}

class IntegrationAttemptRepository {
  rows: Array<Record<string, unknown>> = [];

  async create(input: Record<string, unknown>) {
    const id = "00000000-0000-4000-8000-000000000013";
    this.rows.push({ id, ...input, dispatchState: "created" });
    return id;
  }

  async beginDispatch(id: string) {
    const row = this.rows.find((item) => item.id === id);
    if (!row || row.dispatchState !== "created") return false;
    row.dispatchState = "dispatching";
    return true;
  }

  async finish(input: Record<string, unknown>) {
    const row = this.rows.find((item) => item.id === input.attemptId);
    if (row) Object.assign(row, input);
  }
}
