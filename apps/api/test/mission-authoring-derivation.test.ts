import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  currentActionSchema,
  expectedEffectSchema,
  missionAuthoringIntentSchema,
} from "@scry/contracts";

import { deriveMissionAuthoringOperation } from "../src/adaptive-sessions/mission-authoring-derivation.js";
import { compileMissionAuthoringProtectedTransaction } from "../src/adaptive-sessions/mission-authoring-protected-transaction.js";

const ids = { objectiveId: randomUUID(), flowDraftId: randomUUID(), turnId: randomUUID() };
const target = {
  concept: "control",
  role: "button" as const,
  name: "Control",
  testId: "control-id",
};

function derive(action: Record<string, unknown>) {
  return deriveMissionAuthoringOperation({
    turnId: ids.turnId,
    intent: {
      intentId: `intent-${String(action.kind)}`,
      ...ids,
      action,
      expectedEffect: { kind: "none" },
      constraints: { timeoutMs: 1_000, allowNewPage: false, allowNonExact: false },
      authorization: { kind: "ordinary" },
      protectedInputReferences: [],
    } as never,
  });
}

function deriveWithEffect(
  action: Record<string, unknown>,
  expectedEffect: Record<string, unknown>,
) {
  return deriveMissionAuthoringOperation({
    turnId: ids.turnId,
    intent: {
      intentId: `intent-${String(action.kind)}-${String(expectedEffect.kind)}`,
      ...ids,
      action,
      expectedEffect,
      constraints: { timeoutMs: 1_000, allowNewPage: false, allowNonExact: false },
      authorization: { kind: "ordinary" },
      protectedInputReferences: [],
    } as never,
  });
}

describe("Mission authoring semantic derivation", () => {
  it("normalizes the public navigation urlPattern alias into the kernel URL contract", () => {
    const parsed = missionAuthoringIntentSchema.parse({
      intentId: "navigate-with-host-alias",
      objectiveId: ids.objectiveId,
      flowDraftId: ids.flowDraftId,
      action: { kind: "navigate", url: "https://example.test/partner" },
      expectedEffect: {
        kind: "navigation",
        urlPattern: "https://example.test/partner",
        match: "exact",
      },
      constraints: { timeoutMs: 1_000, allowNewPage: false, allowNonExact: false },
      authorization: { kind: "ordinary" },
      protectedInputReferences: [],
    });
    expect(
      deriveMissionAuthoringOperation({ turnId: ids.turnId, intent: parsed }).expectedEffect,
    ).toEqual({ type: "navigation", url: "https://example.test/partner", match: "exact" });
  });

  it("derives action-specific capabilities and typed test-ID evidence", () => {
    expect(
      (derive({ kind: "fill", target, publicValue: "value" }).action as any).target
        .requiredCapabilities,
    ).toEqual(["focusable", "accepts_text", "editable"]);
    expect(
      (derive({ kind: "activate", target }).action as any).target.requiredCapabilities,
    ).toEqual(["focusable", "pointer_activatable"]);
    expect(
      (derive({ kind: "select", target, value: "value" }).action as any).target
        .requiredCapabilities,
    ).toEqual(["focusable", "selects_option"]);
    expect(
      (derive({ kind: "set_checked", target, checked: true }).action as any).target
        .requiredCapabilities,
    ).toEqual(["focusable", "toggleable"]);
    expect(
      (derive({ kind: "fill", target, publicValue: "value" }).action as any).target
        .preferredEvidence.testIds,
    ).toEqual(["control-id"]);
  });

  it("preserves an authoritative semantic-context reference without rediscovery evidence", () => {
    const reference = "context-control-0123456789abcdef0123456789abcdef";
    const operation = derive({
      kind: "fill",
      target: { concept: "observed password", reference },
      publicValue: "fixture",
    });
    expect((operation.action as any).target).toMatchObject({
      authoritativeReference: reference,
      preferredEvidence: { roles: [], names: [], labels: [], placeholders: [] },
    });
    expect(() => currentActionSchema.parse(operation.action)).not.toThrow();
  });

  it("carries explicit semantic effect into fail-closed dispatch semantics", () => {
    const base = {
      intentId: "live-context",
      objectiveId: ids.objectiveId,
      flowDraftId: ids.flowDraftId,
      expectedEffect: { kind: "none" as const },
      constraints: { timeoutMs: 1_000, allowNewPage: false, allowNonExact: false },
      authorization: { kind: "live_read" as const },
      protectedInputReferences: [],
    };
    const readContext = missionAuthoringIntentSchema.parse({
      ...base,
      action: {
        kind: "activate",
        target,
        semanticEffect: "read_context_transition",
        activationMechanism: "dom",
      },
    });
    expect(
      deriveMissionAuthoringOperation({ turnId: ids.turnId, intent: readContext }),
    ).toMatchObject({
      mode: "observe",
      action: { type: "click", dispatchSemantics: "read_only", activationMechanism: "dom" },
    });
    const unknownByDefault = missionAuthoringIntentSchema.parse({
      ...base,
      intentId: "unknown-context",
      action: { kind: "activate", target },
    });
    expect(
      deriveMissionAuthoringOperation({ turnId: ids.turnId, intent: unknownByDefault }),
    ).toMatchObject({ mode: "observe", action: { type: "click", dispatchSemantics: "mutation" } });
    const readContextPress = missionAuthoringIntentSchema.parse({
      ...base,
      intentId: "read-context-press",
      action: { kind: "press", target, key: "Enter", semanticEffect: "read_context_transition" },
    });
    expect(
      deriveMissionAuthoringOperation({ turnId: ids.turnId, intent: readContextPress }),
    ).toMatchObject({ mode: "observe", action: { type: "press", dispatchSemantics: "read_only" } });
  });

  it("rejects read-context activation without explicit live_read authority", () => {
    expect(() =>
      missionAuthoringIntentSchema.parse({
        intentId: "unauthorized-read-context",
        objectiveId: ids.objectiveId,
        flowDraftId: ids.flowDraftId,
        action: { kind: "activate", target, semanticEffect: "read_context_transition" },
        expectedEffect: { kind: "none" },
        constraints: { timeoutMs: 1_000, allowNewPage: false, allowNonExact: false },
        authorization: { kind: "ordinary" },
        protectedInputReferences: [],
      }),
    ).toThrow("read-context transition requires explicit live_read authority");
    expect(() =>
      missionAuthoringIntentSchema.parse({
        intentId: "unauthorized-read-context-press",
        objectiveId: ids.objectiveId,
        flowDraftId: ids.flowDraftId,
        action: { kind: "press", target, key: "Enter", semanticEffect: "read_context_transition" },
        expectedEffect: { kind: "none" },
        constraints: { timeoutMs: 1_000, allowNewPage: false, allowNonExact: false },
        authorization: { kind: "ordinary" },
        protectedInputReferences: [],
      }),
    ).toThrow("read-context transition requires explicit live_read authority");
  });

  it("preserves new-page ownership as a distinct internal effect", () => {
    const derived = deriveMissionAuthoringOperation({
      turnId: ids.turnId,
      intent: {
        intentId: "popup",
        ...ids,
        action: { kind: "activate", target },
        expectedEffect: { kind: "new_page", origin: "https://example.test" },
        constraints: { timeoutMs: 1_000, allowNewPage: true, allowNonExact: false },
        authorization: { kind: "ordinary" },
        protectedInputReferences: [],
      } as never,
    });
    expect(derived.expectedEffect).toEqual({ type: "new_page", origin: "https://example.test" });
  });

  it("observes positive visibility without requiring value extraction", () => {
    const credentials = { concept: "navigation", role: "link", name: "Credentials" };
    const addCredential = { concept: "dialog trigger", role: "button", name: "Add credential" };

    expect(
      deriveWithEffect(
        { kind: "activate", target },
        { kind: "target_visibility", target: credentials, visible: true },
      ).expectedEffect,
    ).toMatchObject({
      type: "visibility_change",
      visible: true,
      target: { requiredCapabilities: ["observable"] },
    });
    expect(
      deriveWithEffect(
        { kind: "activate", target },
        { kind: "target_visibility", target: addCredential, visible: true },
      ).expectedEffect,
    ).toMatchObject({ target: { requiredCapabilities: ["observable"] } });
  });

  it("observes positive wait states without requiring value extraction", () => {
    for (const state of ["visible", "attached"] as const) {
      expect(
        (derive({ kind: "wait_for", target, state }).action as any).target.requiredCapabilities,
      ).toEqual(["observable"]);
    }
  });

  it("produces positive observation targets accepted by the runtime contracts", () => {
    const operation = deriveWithEffect(
      { kind: "activate", target },
      {
        kind: "target_visibility",
        target: { concept: "navigation", role: "link", name: "Credentials" },
        visible: true,
      },
    );
    expect(() => currentActionSchema.parse(operation.action)).not.toThrow();
    expect(() => expectedEffectSchema.parse(operation.expectedEffect)).not.toThrow();
  });

  it.each([
    { concept: "login", role: "form" as const },
    { concept: "email", role: "textbox" as const },
  ])(
    "keeps MCP-admitted role-only inspection targets valid for runtime execution: $role",
    (semanticTarget) => {
      const operation = derive({ kind: "inspect", target: semanticTarget });

      expect(() => currentActionSchema.parse(operation.action)).not.toThrow();
      expect(operation.action).toMatchObject({
        type: "waitFor",
        target: {
          concept: semanticTarget.concept,
          requiredCapabilities: ["observable"],
          preferredEvidence: { roles: [semanticTarget.role], names: [] },
        },
      });
    },
  );

  it("preserves conservative negative observation and value-reading capabilities", () => {
    expect(
      deriveWithEffect(
        { kind: "activate", target },
        { kind: "target_visibility", target, visible: false },
      ).expectedEffect,
    ).toMatchObject({ target: { requiredCapabilities: ["observable"] } });
    for (const state of ["hidden", "detached"] as const) {
      expect(
        (derive({ kind: "wait_for", target, state }).action as any).target.requiredCapabilities,
      ).toEqual(["observable"]);
    }
    expect(
      deriveWithEffect(
        { kind: "activate", target },
        { kind: "target_value", target, expected: "ready" },
      ).expectedEffect,
    ).toMatchObject({ target: { requiredCapabilities: ["readable_value"] } });
    expect(
      (derive({ kind: "activate", target }).action as any).target.requiredCapabilities,
    ).toEqual(["focusable", "pointer_activatable"]);
  });

  it("compiles only server-owned adapters and replayable same-session preparation", () => {
    const preparation = missionAuthoringIntentSchema.parse({
      intentId: "fill-name",
      objectiveId: ids.objectiveId,
      flowDraftId: ids.flowDraftId,
      action: {
        kind: "fill",
        target: { concept: "credential name", role: "textbox", name: "Name", exact: true },
        publicValue: "Qualification",
      },
      expectedEffect: { kind: "none" },
      constraints: { timeoutMs: 1_000, allowNewPage: false, allowNonExact: false },
      authorization: { kind: "ordinary" },
      protectedInputReferences: [],
    });
    const acquisition = missionAuthoringIntentSchema.parse({
      intentId: "generate",
      objectiveId: ids.objectiveId,
      flowDraftId: ids.flowDraftId,
      action: {
        kind: "acquire_protected_outputs",
        preparationIntentIds: ["fill-name"],
        mutation: {
          kind: "one_time",
          target: { concept: "generate", role: "button", name: "Generate", exact: true },
        },
        outputs: [
          {
            reference: "clientId",
            classification: "public",
            target: { concept: "client id", role: "textbox", name: "Client ID", exact: true },
            storageName: "Client ID",
          },
          {
            reference: "clientSecret",
            classification: "protected",
            target: {
              concept: "client secret",
              role: "textbox",
              name: "Client secret",
              exact: true,
            },
            storageName: "Client secret",
          },
        ],
        request: {
          method: "POST",
          pathTemplate: "/api/v1/partner-api/orders",
          transports: ["fetch"],
        },
        response: { confirmedNotAppliedStatuses: [400, 401, 403, 404, 409, 429] },
        externalResourceBindings: [
          {
            status: "active",
            identityReference: "clientId",
            provider: "example",
            resourceKind: "credential",
            resourceScope: "application-1",
            identityContractVersion: 1,
            identitySource: "response",
            requiredForDestructiveLifecycle: true,
          },
        ],
      },
      expectedEffect: { kind: "none" },
      constraints: { timeoutMs: 2_000, allowNewPage: false, allowNonExact: false },
      authorization: { kind: "protected_mutation", authorizationId: randomUUID() },
      protectedInputReferences: [],
    });
    if (acquisition.action.kind !== "acquire_protected_outputs")
      throw new Error("test action mismatch");
    const transaction = compileMissionAuthoringProtectedTransaction({
      operationId: "authoring-generate",
      entryUrl: "https://example.test/credentials",
      action: acquisition.action,
      preparation: [preparation],
      timeoutMs: 2_000,
    });
    expect(transaction.preparation.actions).toHaveLength(1);
    expect(transaction.preparation.actions[0]).toMatchObject({
      target: { confidence: { minimum: 0.35, minimumMargin: 0.05, minimumFamilyCount: 1 } },
    });
    expect(transaction.mutation.kind).toBe("one_time");
    expect(transaction.mutation.dispatchSemantics).toBe("mutation");
    expect(transaction.mutation.request).toEqual({
      method: "POST",
      pathTemplate: "/api/v1/partner-api/orders",
      transports: ["fetch"],
    });
    expect(transaction.mutation.response?.confirmedNotAppliedStatuses).toEqual([
      400, 401, 403, 404, 409, 429,
    ]);
    if (!transaction.mutation.action.target) throw new Error("mutation target missing");
    expect(transaction.mutation.action.target.confidence.minimumFamilyCount).toBeUndefined();
    expect(transaction.extraction.outputs).toHaveLength(2);
    expect(
      transaction.extraction.outputs.every((output) => output.storage.scope === "project"),
    ).toBe(true);
    expect(
      transaction.extraction.outputs.find((output) => output.reference === "clientId")?.acquisition
        .permittedMethods,
    ).toEqual(["protected_network_value"]);
    expect(
      transaction.extraction.outputs.find((output) => output.reference === "clientSecret")
        ?.acquisition.permittedMethods,
    ).toEqual([
      "semantic_field_value",
      "input_value",
      "text_content",
      "copy_control",
      "protected_network_value",
    ]);
    expect(JSON.stringify(transaction)).not.toMatch(
      /selector|javascript|coordinates|adapterId|plaintext/i,
    );
  });

  it("compiles read-only protected output acquisition without mutation semantics", () => {
    const acquisition = missionAuthoringIntentSchema.parse({
      intentId: "list-orders",
      objectiveId: ids.objectiveId,
      flowDraftId: ids.flowDraftId,
      action: {
        kind: "acquire_protected_outputs",
        preparationIntentIds: ["prepare-list"],
        mutation: {
          kind: "read_only",
          target: { concept: "run list", role: "button", name: "Run", exact: true },
        },
        outputs: [
          {
            reference: "orderId",
            classification: "protected",
            target: { concept: "order id", role: "value", name: "id", exact: true },
            storageName: "Order ID",
          },
        ],
      },
      expectedEffect: { kind: "none" },
      constraints: { timeoutMs: 2_000, allowNewPage: false, allowNonExact: false },
      authorization: { kind: "protected_mutation", authorizationId: randomUUID() },
      protectedInputReferences: [],
    });
    if (acquisition.action.kind !== "acquire_protected_outputs")
      throw new Error("test action mismatch");
    const preparation = missionAuthoringIntentSchema.parse({
      intentId: "prepare-list",
      objectiveId: ids.objectiveId,
      flowDraftId: ids.flowDraftId,
      action: {
        kind: "wait_for",
        target: { concept: "run list", role: "button", name: "Run", exact: true },
        state: "visible",
      },
      expectedEffect: { kind: "none" },
      constraints: { timeoutMs: 1_000, allowNewPage: false, allowNonExact: false },
      authorization: { kind: "ordinary" },
      protectedInputReferences: [],
    });
    const transaction = compileMissionAuthoringProtectedTransaction({
      operationId: "authoring-list-orders",
      entryUrl: "https://example.test/docs",
      action: acquisition.action,
      preparation: [preparation],
      timeoutMs: 2_000,
    });

    expect(transaction.mutation).toMatchObject({
      kind: "repeatable",
      dispatchSemantics: "read_only",
    });
  });

  it("compiles protected preparation fields as prohibited output sources", () => {
    const protectedReferenceId = randomUUID();
    const preparation = missionAuthoringIntentSchema.parse({
      intentId: "fill-client-id",
      objectiveId: ids.objectiveId,
      flowDraftId: ids.flowDraftId,
      action: {
        kind: "fill",
        target: {
          concept: "List Orders Client ID",
          role: "textbox",
          name: "Client ID",
          exact: true,
          scope: { kind: "section", name: "List Orders" },
        },
        protectedReferenceId,
      },
      expectedEffect: { kind: "none" },
      constraints: { timeoutMs: 1_000, allowNewPage: false, allowNonExact: false },
      authorization: { kind: "authentication" },
      protectedInputReferences: [protectedReferenceId],
    });
    const acquisition = missionAuthoringIntentSchema.parse({
      intentId: "list-orders",
      objectiveId: ids.objectiveId,
      flowDraftId: ids.flowDraftId,
      action: {
        kind: "acquire_protected_outputs",
        preparationIntentIds: ["fill-client-id"],
        mutation: {
          kind: "read_only",
          target: { concept: "run list", role: "button", name: "Run", exact: true },
        },
        outputs: [
          {
            reference: "orderId",
            classification: "protected",
            target: {
              concept: "order id",
              role: "value",
              name: "id",
              exact: true,
              scope: { kind: "section", name: "List Orders" },
            },
            storageName: "Order ID",
          },
        ],
      },
      expectedEffect: { kind: "none" },
      constraints: { timeoutMs: 2_000, allowNewPage: false, allowNonExact: false },
      authorization: { kind: "protected_mutation", authorizationId: randomUUID() },
      protectedInputReferences: [],
    });
    if (acquisition.action.kind !== "acquire_protected_outputs")
      throw new Error("test action mismatch");

    const transaction = compileMissionAuthoringProtectedTransaction({
      operationId: "authoring-list-orders",
      entryUrl: "https://example.test/docs",
      action: acquisition.action,
      preparation: [preparation],
      timeoutMs: 2_000,
    });

    expect(transaction.extraction.outputs[0]!.acquisition.prohibitedSourceTargets).toEqual([
      expect.objectContaining({
        concept: "List Orders Client ID",
        preferredEvidence: expect.objectContaining({ names: ["Client ID"] }),
        scope: { kind: "section", name: "List Orders" },
      }),
    ]);
    expect(Object.values(transaction.inputs)).toEqual([
      { classification: "known_secret", credentialRef: protectedReferenceId },
    ]);
  });

  it("compiles a navigation-only checkpoint as a safe entry replay", () => {
    const acquisition = missionAuthoringIntentSchema.parse({
      intentId: "generate",
      objectiveId: ids.objectiveId,
      flowDraftId: ids.flowDraftId,
      action: {
        kind: "acquire_protected_outputs",
        preparationIntentIds: ["visit-fixture"],
        mutation: {
          kind: "one_time",
          target: { concept: "generate", role: "button", name: "Generate", exact: true },
        },
        outputs: [
          {
            reference: "secret",
            classification: "protected",
            target: { concept: "secret", role: "textbox", name: "Secret", exact: true },
            storageName: "Secret",
          },
        ],
      },
      expectedEffect: { kind: "none" },
      constraints: { timeoutMs: 600, allowNewPage: false, allowNonExact: false },
      authorization: { kind: "protected_mutation", authorizationId: randomUUID() },
      protectedInputReferences: [],
    });
    if (acquisition.action.kind !== "acquire_protected_outputs")
      throw new Error("test action mismatch");

    const transaction = compileMissionAuthoringProtectedTransaction({
      operationId: "navigation-only-operation",
      entryUrl: "https://example.test/protected/interrupted-acquisition",
      action: acquisition.action,
      preparation: [],
      timeoutMs: 600,
    });

    expect(transaction.preparation.actions).toEqual([
      {
        type: "navigate",
        url: "https://example.test/protected/interrupted-acquisition",
        effect: "read_only",
        timeoutMs: 600,
      },
    ]);
    expect(transaction.mutation.kind).toBe("one_time");
  });

  it("compiles same-control fill, select, and checked lifecycle profiles", () => {
    const preparation = [
      {
        intentId: "fill-name",
        action: {
          kind: "fill",
          target: { concept: "name", role: "textbox", name: "Name", exact: true },
          publicValue: "Qualification",
        },
      },
      {
        intentId: "select-kind",
        action: {
          kind: "select",
          target: { concept: "kind", role: "combobox", name: "Kind", exact: true },
          value: "Test",
        },
      },
      {
        intentId: "check-active",
        action: {
          kind: "set_checked",
          target: { concept: "active", role: "checkbox", name: "Active", exact: true },
          checked: true,
        },
      },
    ].map(({ intentId, action }) =>
      missionAuthoringIntentSchema.parse({
        intentId,
        objectiveId: ids.objectiveId,
        flowDraftId: ids.flowDraftId,
        action,
        expectedEffect: { kind: "none" },
        constraints: { timeoutMs: 1_000, allowNewPage: false, allowNonExact: false },
        authorization: { kind: "ordinary" },
        protectedInputReferences: [],
      }),
    );
    const acquisition = missionAuthoringIntentSchema.parse({
      intentId: "generate",
      objectiveId: ids.objectiveId,
      flowDraftId: ids.flowDraftId,
      action: {
        kind: "acquire_protected_outputs",
        preparationIntentIds: preparation.map((item) => item.intentId),
        mutation: {
          kind: "one_time",
          target: { concept: "generate", role: "button", name: "Generate", exact: true },
        },
        outputs: [
          {
            reference: "secret",
            classification: "protected",
            target: { concept: "secret", role: "textbox", name: "Secret", exact: true },
            storageName: "Secret",
          },
        ],
      },
      expectedEffect: { kind: "none" },
      constraints: { timeoutMs: 2_000, allowNewPage: false, allowNonExact: false },
      authorization: { kind: "protected_mutation", authorizationId: randomUUID() },
      protectedInputReferences: [],
    });
    if (acquisition.action.kind !== "acquire_protected_outputs")
      throw new Error("test action mismatch");
    const transaction = compileMissionAuthoringProtectedTransaction({
      operationId: "profile-operation",
      entryUrl: "https://example.test/credentials",
      action: acquisition.action,
      preparation,
      timeoutMs: 2_000,
    });
    const [fill, select, checked] = transaction.preparation.actions;
    expect(fill).toMatchObject({
      type: "fillPublicInput",
      target: { requiredCapabilities: ["focusable", "accepts_text", "editable", "readable_value"] },
    });
    expect(select).toMatchObject({
      type: "selectPublicInput",
      target: { requiredCapabilities: ["focusable", "selects_option", "readable_value"] },
    });
    expect(checked).toMatchObject({
      type: "checkPublicInput",
      target: { requiredCapabilities: ["focusable", "toggleable"] },
    });
    expect(transaction.preparation.assertions.map((assertion) => assertion.type)).toEqual([
      "fieldValueMatchesInput",
      "selectedValueMatchesInput",
      "checkedMatchesInput",
      "enabled",
    ]);
    expect(transaction.preparation.assertions[0]).toMatchObject({
      target: fill && "target" in fill ? fill.target : undefined,
    });
    expect(transaction.preparation.assertions[1]).toMatchObject({
      target: select && "target" in select ? select.target : undefined,
    });
    expect(transaction.preparation.assertions[2]).toMatchObject({
      target: checked && "target" in checked ? checked.target : undefined,
    });
  });

  it("derives checked and mixed target-state capability unions", () => {
    expect(
      deriveWithEffect(
        { kind: "activate", target },
        {
          kind: "target_state",
          target: { concept: "active", role: "checkbox", name: "Active" },
          checked: true,
        },
      ).expectedEffect,
    ).toMatchObject({ target: { requiredCapabilities: ["toggleable"] } });
    expect(
      deriveWithEffect(
        { kind: "activate", target },
        {
          kind: "target_state",
          target: { concept: "active", role: "checkbox", name: "Active" },
          checked: true,
          enabled: true,
        },
      ).expectedEffect,
    ).toMatchObject({ target: { requiredCapabilities: ["toggleable", "observable"] } });
  });
});
