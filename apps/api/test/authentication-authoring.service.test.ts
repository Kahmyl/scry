import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { AuthenticationAuthoringService } from "../src/authentication-authoring/index.js";

const digest = "a".repeat(64);
const probeSessionId = "00000000-0000-4000-8000-000000000001";
const attemptId = "00000000-0000-4000-8000-000000000002";

function target(concept = "login field") {
  return {
    authority: "praxis" as const,
    fingerprint: digest,
    concept,
    scopeKind: "document",
    capabilityDigest: "b".repeat(64),
  };
}

function makeService(overrides: Partial<FakeAttemptRepository> = {}) {
  const attempts = new FakeAttemptRepository();
  Object.assign(attempts, overrides);
  return {
    attempts,
    service: new AuthenticationAuthoringService({} as never, attempts as never),
  };
}

function context() {
  return {
    probeSessionId,
    applicationOrigin: "https://app.example.test",
    entryUrl: "https://app.example.test/login",
    credentialReferenceId: "00000000-0000-4000-8000-000000000003",
    usernameInspection: {
      candidates: [
        {
          target: target("email"),
          confidence: 0.88,
          runnerUpMargin: 0.3,
          evidenceKinds: ["autocomplete_email", "type_email", "praxis_verified"],
        },
      ],
    },
    passwordInspection: {
      candidates: [
        {
          target: target("password"),
          confidence: 0.92,
          runnerUpMargin: 0.4,
          evidenceKinds: ["type_password", "autocomplete_current_password"],
        },
      ],
    },
    submissionInspection: {
      candidates: [
        {
          kind: "custom_control" as const,
          target: target("custom login"),
          confidence: 0.9,
          evidenceKinds: ["praxis_verified"],
        },
        {
          kind: "form_button" as const,
          target: target("sign in"),
          confidence: 0.86,
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
      ],
    },
  };
}

describe("AuthenticationAuthoringService", () => {
  it("discovers username fields using the required evidence priority", async () => {
    const { service } = makeService();

    const result = await service.discoverUsernameField(context());

    expect(result).toMatchObject({
      status: "resolved",
      field: "username",
      target: { authority: "praxis", concept: "email" },
    });
    expect(result.evidence.map((item) => item.kind)).toContain("autocomplete_email");
  });

  it("discovers password fields from Praxis evidence", async () => {
    const { service } = makeService();

    const result = await service.discoverPasswordField(context());

    expect(result).toMatchObject({
      status: "resolved",
      field: "password",
      target: { authority: "praxis", concept: "password" },
    });
    expect(result.evidence.map((item) => item.kind)).toContain("type_password");
  });

  it("blocks ambiguous password fields", async () => {
    const { service } = makeService();
    const ambiguous = context();
    ambiguous.passwordInspection.candidates.push({
      target: target("confirm password"),
      confidence: 0.91,
      runnerUpMargin: 0.4,
      evidenceKinds: ["type_password"],
    });

    const result = await service.discoverPasswordField(ambiguous);

    expect(result.status).toBe("ambiguous");
    expect(result.target).toBeUndefined();
  });

  it("orders submission methods by verified native/form/keyboard/custom priority", async () => {
    const { service } = makeService();

    const result = await service.discoverSubmissionPath(context());

    expect(result.status).toBe("resolved");
    expect(result.methods.map((method) => method.kind)).toEqual(["click", "click"]);
    expect(result.methods[0]!.target?.concept).toBe("sign in");
  });

  it("returns uncertain dispatch and does not perform an automatic retry", async () => {
    const { service, attempts } = makeService();
    const uncertain = context();
    uncertain.stateInspection.signals = [];

    const result = await service.submitCredentialsOnce(uncertain);

    expect(result.status).toBe("uncertain_dispatch");
    expect(attempts.beginCalls).toBe(1);
    expect(attempts.finishCalls).toBe(1);
    expect(attempts.lastFinish).toMatchObject({
      dispatchState: "uncertain",
      resultClassification: "uncertain_dispatch",
    });
  });

  it("scores authenticated state from multiple independent signals", async () => {
    const { service } = makeService();

    const result = await service.detectAuthenticatedState(context());

    expect(result.status).toBe("authenticated");
    expect(result.requiredSignals).toEqual([
      "login_response_success",
      "url_not_login",
      "login_form_absent",
    ]);
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it("generates a createAuthenticationContract-compatible candidate", async () => {
    const { service } = makeService();
    const base = context();
    const username = await service.discoverUsernameField(base);
    const password = await service.discoverPasswordField(base);
    const submission = await service.discoverSubmissionPath(base);
    const submissionResult = await service.submitCredentialsOnce(base);
    const authenticatedState = await service.detectAuthenticatedState(base);

    const candidate = await service.createAuthenticationContractCandidate({
      probeSessionId,
      applicationOrigin: base.applicationOrigin,
      entryUrl: base.entryUrl,
      username,
      password,
      submission,
      submissionResult,
      authenticatedState,
      safeMetadata: {},
    });

    expect(candidate).toMatchObject({
      applicationOrigin: base.applicationOrigin,
      usernameTarget: { authority: "praxis" },
      passwordTarget: { authority: "praxis" },
      selectedMethodIndex: 0,
      sessionReuse: "never",
    });
  });

  it("rejects selector-only durable evidence", async () => {
    const { service } = makeService();
    const base = context();
    const username = await service.discoverUsernameField(base);
    const password = await service.discoverPasswordField(base);
    const submission = await service.discoverSubmissionPath(base);
    const authenticatedState = await service.detectAuthenticatedState(base);

    await expect(
      service.createAuthenticationContractCandidate({
        probeSessionId,
        applicationOrigin: base.applicationOrigin,
        entryUrl: base.entryUrl,
        username: {
          ...username,
          target: { ...username.target!, concept: "selector #email" },
        },
        password,
        submission,
        authenticatedState,
        safeMetadata: {},
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("fails if a secret-like artifact appears in output", async () => {
    const { service } = makeService();
    const base = context();
    const username = await service.discoverUsernameField(base);
    const password = await service.discoverPasswordField(base);
    const submission = await service.discoverSubmissionPath(base);
    const authenticatedState = await service.detectAuthenticatedState(base);

    await expect(
      service.createAuthenticationContractCandidate({
        probeSessionId,
        applicationOrigin: base.applicationOrigin,
        entryUrl: base.entryUrl,
        username,
        password: {
          ...password,
          target: { ...password.target!, concept: "password=not-allowed" },
        },
        submission,
        authenticatedState,
        safeMetadata: {},
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

class FakeAttemptRepository {
  beginCalls = 0;
  finishCalls = 0;
  lastFinish?: unknown;

  async create() {
    return attemptId;
  }

  async beginDispatch() {
    this.beginCalls += 1;
    return true;
  }

  async finish(input: unknown) {
    this.finishCalls += 1;
    this.lastFinish = input;
  }
}
