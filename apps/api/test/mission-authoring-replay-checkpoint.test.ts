import { describe, expect, it } from "vitest";
import type { MissionAuthoringIntent } from "@scry/contracts";

import { selectProtectedReplayPreparation } from "../src/adaptive-sessions/adaptive-session.repository.js";

const objectiveId = "11111111-1111-4111-8111-111111111111";
const flowDraftId = "22222222-2222-4222-8222-222222222222";

describe("Mission authoring protected replay checkpoints", () => {
  it("removes pre-authentication history and replays only ephemeral state after the current-route checkpoint", () => {
    const rows = [
      row(1, "login-page", navigate("login-page", "https://app.test/login"), "https://app.test/login"),
      row(2, "email", fill("email", "Email"), "https://app.test/login"),
      row(3, "password", fill("password", "Password"), "https://app.test/login"),
      row(4, "login", activate("login", "Login"), "https://app.test/home"),
      row(5, "credentials", activate("credentials", "Credentials"), "https://app.test/credentials"),
      row(6, "open-dialog", activate("open-dialog", "Add credential"), "https://app.test/credentials"),
      row(7, "fill-name", fill("fill-name", "Name"), "https://app.test/credentials"),
    ];

    const selected = selectProtectedReplayPreparation(
      rows,
      rows.map((item) => item.intentId),
      "https://app.test/credentials",
    );

    expect(selected.map((intent) => intent.intentId)).toEqual(["open-dialog", "fill-name"]);
  });

  it("preserves an explicitly selected suffix and durable transcript order", () => {
    const rows = [
      row(1, "home", navigate("home", "https://app.test/home"), "https://app.test/home"),
      row(2, "open-drawer", activate("open-drawer", "Settings"), "https://app.test/home"),
      row(3, "open-tab", activate("open-tab", "Credentials"), "https://app.test/home"),
      row(4, "fill-name", fill("fill-name", "Name"), "https://app.test/home"),
    ];

    const selected = selectProtectedReplayPreparation(
      rows,
      ["fill-name", "open-drawer", "open-tab"],
      "https://app.test/home",
    );

    expect(selected.map((intent) => intent.intentId)).toEqual([
      "open-drawer",
      "open-tab",
      "fill-name",
    ]);
  });

  it("removes epoch-bound references when portable semantic evidence is available", () => {
    const referenced = activate("open-dialog", "Add credential");
    if (referenced.action.kind !== "activate") throw new Error("test setup");
    referenced.action.target.reference = "context-control-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const selected = selectProtectedReplayPreparation(
      [
        row(1, "checkpoint", navigate("checkpoint", "https://app.test/credentials"), "https://app.test/credentials"),
        row(2, "open-dialog", referenced, "https://app.test/credentials"),
      ],
      ["open-dialog"],
      "https://app.test/credentials",
    );
    expect(selected[0]?.action).toMatchObject({
      kind: "activate",
      target: { concept: "open-dialog", role: "button", name: "Add credential" },
    });
    expect((selected[0]?.action as { target?: { reference?: string } }).target?.reference)
      .toBeUndefined();
  });

  it("rejects a reference-only target that cannot be replayed in the protected context", () => {
    const referenced = activate("open-dialog", "Add credential");
    if (referenced.action.kind !== "activate") throw new Error("test setup");
    referenced.action.target = {
      concept: "open-dialog",
      reference: "context-control-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      exact: true,
    };
    expect(() => selectProtectedReplayPreparation(
      [
        row(1, "checkpoint", navigate("checkpoint", "https://app.test/credentials"), "https://app.test/credentials"),
        row(2, "open-dialog", referenced, "https://app.test/credentials"),
      ],
      ["open-dialog"],
      "https://app.test/credentials",
    )).toThrowError(expect.objectContaining({
      response: expect.objectContaining({
        code: "MISSION_AUTHORING_PREPARATION_REFERENCE_NOT_REPLAYABLE",
        mutationOutcome: "not_applied",
      }),
    }));
  });

  it("allows an empty ephemeral suffix when the imported route is already mutation-ready", () => {
    const rows = [
      row(1, "home", navigate("home", "https://app.test/home"), "https://app.test/home"),
    ];
    expect(
      selectProtectedReplayPreparation(rows, ["home"], "https://app.test/home"),
    ).toEqual([]);
  });

  it.each([
    {
      name: "missing selected intent",
      rows: [row(1, "home", navigate("home", "https://app.test/home"), "https://app.test/home")],
      ids: ["missing"],
      entryUrl: "https://app.test/home",
      code: "MISSION_AUTHORING_PREPARATION_INVALID",
    },
    {
      name: "duplicate selected intent",
      rows: [row(1, "home", navigate("home", "https://app.test/home"), "https://app.test/home")],
      ids: ["home", "home"],
      entryUrl: "https://app.test/home",
      code: "MISSION_AUTHORING_PREPARATION_INVALID",
    },
    {
      name: "entry URL without a durable checkpoint",
      rows: [row(1, "home", navigate("home", "https://app.test/home"), "https://app.test/home")],
      ids: ["home"],
      entryUrl: "https://app.test/credentials",
      code: "MISSION_AUTHORING_PROTECTED_REPLAY_CHECKPOINT_UNAVAILABLE",
    },
  ])("rejects $name", ({ rows, ids, entryUrl, code }) => {
    expect(() => selectProtectedReplayPreparation(rows, ids, entryUrl)).toThrowError(
      expect.objectContaining({ response: { code } }),
    );
  });
});

function row(
  sequence: number,
  intentId: string,
  intent: MissionAuthoringIntent,
  observedUrl: string,
) {
  return { sequence, intentId, intent, observedUrl };
}

function base(intentId: string): Omit<MissionAuthoringIntent, "action"> {
  return {
    intentId,
    objectiveId,
    flowDraftId,
    expectedEffect: { kind: "none" },
    constraints: { timeoutMs: 2_000, allowNewPage: false, allowNonExact: false },
    authorization: { kind: "ordinary" },
    protectedInputReferences: [],
  };
}

function navigate(intentId: string, url: string): MissionAuthoringIntent {
  return { ...base(intentId), action: { kind: "navigate", url } };
}

function activate(intentId: string, name: string): MissionAuthoringIntent {
  return {
    ...base(intentId),
    action: {
      kind: "activate",
      target: { concept: intentId, role: "button", name, exact: true },
    },
  };
}

function fill(intentId: string, name: string): MissionAuthoringIntent {
  return {
    ...base(intentId),
    action: {
      kind: "fill",
      target: { concept: intentId, role: "textbox", name, exact: true },
      publicValue: "synthetic",
    },
  };
}
