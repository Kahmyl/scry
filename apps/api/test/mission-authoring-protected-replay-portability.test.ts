import { describe, expect, it } from "vitest";

import { selectProtectedReplayPreparation } from "../src/adaptive-sessions/adaptive-session.repository.js";
import { compileMissionAuthoringProtectedTransaction } from "../src/adaptive-sessions/mission-authoring-protected-transaction.js";

const entryUrl = "https://app.test/credentials";
const ref = (value: string) => `context-control-${value.repeat(32).slice(0, 32)}`;

function intent(
  intentId: string,
  reference: string,
  concept: string,
  kind: "activate" | "fill" = "activate",
) {
  return {
    intentId,
    objectiveId: "11111111-1111-4111-8111-111111111111",
    flowDraftId: "22222222-2222-4222-8222-222222222222",
    action:
      kind === "fill"
        ? {
            kind: "fill",
            target: { concept, reference, exact: true },
            publicValue: "Qualification Credential",
          }
        : {
            kind: "activate",
            target: { concept, reference, exact: true },
            semanticEffect: "read_context_transition",
          },
    authorization: { kind: kind === "activate" ? "live_read" : "ordinary" },
    expectedEffect: { kind: "none" },
    protectedInputReferences: [],
    constraints: {
      allowNonExact: false,
      allowNewPage: false,
      timeoutMs: 30_000,
    },
  } as never;
}

function checkpoint() {
  return {
    intentId: "checkpoint",
    objectiveId: "11111111-1111-4111-8111-111111111111",
    flowDraftId: "22222222-2222-4222-8222-222222222222",
    action: { kind: "navigate", url: entryUrl },
    authorization: { kind: "live_read" },
    expectedEffect: { kind: "none" },
    protectedInputReferences: [],
    constraints: {
      allowNonExact: false,
      allowNewPage: false,
      timeoutMs: 30_000,
    },
  } as never;
}

describe("protected replay target portability", () => {
  it("reconstructs portable semantic targets from the exact durable control snapshot", () => {
    const openReference = ref("a");
    const fillReference = ref("b");

    const rows = [
      {
        sequence: 1,
        intentId: "checkpoint",
        intent: checkpoint(),
        observedUrl: entryUrl,
        semanticPageContext: { controls: [] },
      },
      {
        sequence: 2,
        intentId: "open",
        intent: intent("open", openReference, "Add credential"),
        observedUrl: entryUrl,
        semanticPageContext: {
          controls: [
            {
              reference: openReference,
              role: "button",
              name: "Add credential",
              group: "Credentials",
              boundary: { kind: "region", name: "Credentials" },
              capabilities: ["observe", "activate"],
            },
          ],
        },
      },
      {
        sequence: 3,
        intentId: "fill",
        intent: intent("fill", fillReference, "Name", "fill"),
        observedUrl: entryUrl,
        semanticPageContext: {
          controls: [
            {
              reference: fillReference,
              role: "textbox",
              name: "Name",
              capabilities: ["observe", "enter_text"],
            },
          ],
        },
      },
    ];

    const selected = selectProtectedReplayPreparation(
      rows,
      ["open", "fill"],
      entryUrl,
      { preserveExactReferences: true },
    );

    expect(selected).toHaveLength(2);

    const openTarget = (selected[0]!.action as any).target;
    expect(openTarget).toMatchObject({
      concept: "Add credential",
      exact: true,
      role: "button",
      name: "Add credential",
      scope: { kind: "region", name: "Credentials", direct: true },
    });
    expect(openTarget).not.toHaveProperty("reference");

    const fillTarget = (selected[1]!.action as any).target;
    expect(fillTarget).toMatchObject({
      concept: "Name",
      exact: true,
      role: "textbox",
      name: "Name",
    });
    expect(fillTarget).not.toHaveProperty("reference");

    expect(() => compileMissionAuthoringProtectedTransaction({
      operationId: "group-scoped-protected-acquisition",
      entryUrl,
      action: {
        kind: "acquire_protected_outputs",
        preparationIntentIds: ["open", "fill"],
        mutation: {
          kind: "one_time",
          target: { concept: "Generate", role: "button", name: "Generate", exact: true },
        },
        outputs: [{
          reference: "client-secret",
          classification: "protected",
          target: { concept: "Client secret", role: "textbox", exact: true },
          storageName: "Client secret",
        }],
      },
      preparation: selected,
      timeoutMs: 30_000,
    })).not.toThrow();
  });

  it("fails closed when a document-bound reference has no unique durable snapshot", () => {
    const reference = ref("c");

    const row = {
      sequence: 2,
      intentId: "open",
      intent: intent("open", reference, "Add credential"),
      observedUrl: entryUrl,
      semanticPageContext: {
        controls: [
          {
            reference,
            role: "button",
            name: "Add credential",
          },
          {
            reference,
            role: "button",
            name: "Add credential",
          },
        ],
      },
    };

    expect(() =>
      selectProtectedReplayPreparation(
        [
          {
            sequence: 1,
            intentId: "checkpoint",
            intent: checkpoint(),
            observedUrl: entryUrl,
            semanticPageContext: { controls: [] },
          },
          row,
        ],
        ["open"],
        entryUrl,
        { preserveExactReferences: true },
      ),
    ).toThrowError(
      expect.objectContaining({
        response: expect.objectContaining({
          code: "MISSION_AUTHORING_PREPARATION_REFERENCE_NOT_REPLAYABLE",
        }),
      }),
    );
  });

  it("preserves and validates an explicit canonical row scope while stripping the stale reference", () => {
    const reference = ref("d");
    const scoped = intent("scoped-fill", reference, "Name", "fill") as any;
    scoped.action.target.scope = { kind: "row", name: "Credential Alpha" };
    const selected = selectProtectedReplayPreparation([
      { sequence: 1, intentId: "checkpoint", intent: checkpoint(), observedUrl: entryUrl, semanticPageContext: { controls: [] } },
      {
        sequence: 2, intentId: "scoped-fill", intent: scoped, observedUrl: entryUrl,
        semanticPageContext: { controls: [{ reference, role: "textbox", name: "Name", group: "Ignored group" }] },
      },
    ], ["scoped-fill"], entryUrl, { preserveExactReferences: true });
    expect((selected[0]!.action as any).target).toMatchObject({
      role: "textbox", name: "Name", scope: { kind: "row", name: "Credential Alpha" },
    });
    expect((selected[0]!.action as any).target).not.toHaveProperty("reference");
  });

  it("rejects an unsupported factual role during canonical reconstruction", () => {
    const reference = ref("e");
    expect(() => selectProtectedReplayPreparation([
      { sequence: 1, intentId: "checkpoint", intent: checkpoint(), observedUrl: entryUrl, semanticPageContext: { controls: [] } },
      {
        sequence: 2, intentId: "invalid", intent: intent("invalid", reference, "Unsupported"), observedUrl: entryUrl,
        semanticPageContext: { controls: [{ reference, role: "unsupported_widget", name: "Unsupported" }] },
      },
    ], ["invalid"], entryUrl, { preserveExactReferences: true })).toThrowError(
      expect.objectContaining({ response: expect.objectContaining({ code: "MISSION_AUTHORING_PREPARATION_TARGET_INVALID" }) }),
    );
  });
});
