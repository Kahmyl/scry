import { createHash, randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { Principal } from "../../src/auth/index.js";
import type { Database } from "../../src/infrastructure/index.js";
import { OperationContractRegistry } from "../../src/adaptive-sessions/operation-contract.registry.js";
import { PreparedProtectedOperationRepository } from "../../src/adaptive-sessions/repositories/prepared-protected-operation.repository.js";
import { AdaptiveSessionRepository } from "../../src/adaptive-sessions/repositories/adaptive-session.repository.js";
import { compilePreparedProtectedOperation } from "../../src/adaptive-sessions/prepared-protected-operation.compiler.js";

/** A1 only: repository boundary proof. This is not browser or J0–J15 qualification. */
export async function verifyCanonicalValueGrantBoundary(input: {
  database: Database;
  principal: Principal;
  sessionId: string;
  projectId: string;
  environmentId: string;
  missionId: string;
  objectiveId: string;
  agentSessionId: string;
  valueAssetId: string;
  credentialId: string;
}) {
  const { database, sessionId } = input;
  const sessions = new AdaptiveSessionRepository(database);
  const prepared = new PreparedProtectedOperationRepository(database);
  const origin = "https://preview.vitract.com";
  const fieldRef = `context-control-${"b".repeat(32)}`;
  const [entry] = await new OperationContractRegistry(database).register(sessionId, [
    {
      facts: {
        application: { key: "vitract_preview", provider: "vitract" },
        adapter: { key: "boundary_fixture", version: 1 },
        operation: {
          key: "authenticate",
          label: "Authenticate",
          method: "POST",
          pathTemplate: "/token",
          transports: ["fetch"],
          semantics: { dispatch: "mutation", effects: ["authentication"] },
        },
        inputs: [
          {
            key: "clientSecret",
            label: "Client secret",
            aliases: [],
            required: true,
            classification: "protected",
            acceptedPresentations: ["protected_text"],
          },
        ],
        auth: { presentationClasses: ["protected_text"] },
        response: {
          statusClasses: [2],
          mutationPolicy: { confirmedNotAppliedStatuses: [401] },
          outputs: [
            {
              key: "token",
              label: "Token",
              classification: "protected",
              extractor: { kind: "json_path", path: "$.token" },
              generatedValueEligible: true,
            },
          ],
          continuation: "none",
        },
      },
      provenance: {
        sourceKind: "runtime_observation",
        observationId: "a1-value-boundary",
        origin,
        observedAt: new Date().toISOString(),
      },
      interaction: {
        praxisSessionId: sessionId,
        documentEpoch: 0,
        origin,
        activationControlReference: `context-control-${"a".repeat(32)}`,
        inputControlReferences: { clientSecret: fieldRef },
      },
    },
  ]);
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  await expect(sessions.resolveCredential(sessionId, input.credentialId)).rejects.toBeDefined();
  const values = [
    {
      canonicalFieldKey: "clientSecret",
      targetReference: fieldRef,
      presentationClass: "protected_text" as const,
      source: {
        kind: "generated_protected" as const,
        valueAssetId: input.valueAssetId,
      },
    },
  ];
  const expectedOutputs = [{ key: "token", classification: "protected" as const }];
  const reservation = await prepared.reserve(sessionId, {
    projectId: input.projectId,
    environmentId: input.environmentId,
    missionId: input.missionId,
    objectiveId: input.objectiveId,
    agentSessionId: input.agentSessionId,
    publicOperationId: `grant-boundary-${randomUUID()}`,
    operationContractRevisionId: entry!.revision.id,
    operationContractRevisionDigest: entry!.revision.digest,
    runtimeInteractionCapabilityId: entry!.interaction!.id,
    targetCommitment: digest(
      values.map((v) => ({ key: v.canonicalFieldKey, targetReference: v.targetReference })),
    ),
    inputCommitment: digest(
      values.map((v) => ({
        key: v.canonicalFieldKey,
        presentationClass: v.presentationClass,
        sourceCommitment: digest(v.source),
      })),
    ),
    outputCommitment: digest(expectedOutputs),
    values,
    expectedOutputs,
    expiresAt,
  });
  const exact = {
    protectedOperationId: reservation.protectedOperationId,
    preparedExecutionCapabilityId: reservation.preparedExecutionCapabilityId,
    publicOperationId: reservation.publicOperationId,
  };
  const grants = await database.query<{ id: string }>(
    `SELECT id FROM value_use_grants WHERE consumer_protected_operation_id=$1`,
    [reservation.protectedOperationId],
  );
  expect(grants.rowCount).toBe(1);
  await expect(
    sessions.resolveProtectedInput(sessionId, reservation.publicOperationId, input.credentialId),
  ).rejects.toBeDefined();
  const material = await prepared.executionMaterial(sessionId, exact);
  const compiled = compilePreparedProtectedOperation({ material, entryUrl: `${origin}/token` });
  const protectedReservation = await prepared.finalizeExecutionCapability(
    exact.preparedExecutionCapabilityId,
    compiled.transaction,
  );
  await sessions.beginMissionOperation({
    workspaceId: input.principal.workspaceId ?? null,
    sessionId,
    intent: compiled.intent,
    operationId: reservation.publicOperationId,
    idempotencyKey: `grant-${reservation.protectedOperationId}`,
    action: compiled.transaction,
    expectedEffect: { type: "none" },
    mode: "transact",
    protectedReservation,
    earlyProtectedOperationId: reservation.protectedOperationId,
    preparedProtectedOperationId: reservation.protectedOperationId,
  });
  await prepared.consumeGeneratedBindings(reservation.protectedOperationId);
  await prepared.consumeGeneratedBindings(reservation.protectedOperationId); // crash-safe idempotence
  await expect(
    sessions.resolveProtectedInput(sessionId, "wrong-consumer", input.credentialId),
  ).rejects.toBeDefined();
  await expect(
    database.query(`UPDATE value_use_grants SET canonical_field_key='wrongField' WHERE id=$1`, [
      grants.rows[0]!.id,
    ]),
  ).rejects.toThrow();
  const resolutions = await Promise.allSettled([
    sessions.resolveProtectedInput(sessionId, reservation.publicOperationId, input.credentialId),
    sessions.resolveProtectedInput(sessionId, reservation.publicOperationId, input.credentialId),
  ]);
  expect(resolutions.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(resolutions.filter((r) => r.status === "rejected")).toHaveLength(1);
  const consumed = await database.query(
    `SELECT state,use_count FROM value_use_grants WHERE id=$1`,
    [grants.rows[0]!.id],
  );
  expect(consumed.rows[0]).toMatchObject({ state: "consumed", use_count: 1 });
  await sessions.settlePreparedExecutionDeadline({
    sessionId,
    operationId: reservation.publicOperationId,
    reasonCode: "A1_NO_DISPATCH_BOUNDARY_COMPLETE",
  });
  await sessions.projectProtectedOperationForAuthoring({
    sessionId,
    operationId: reservation.publicOperationId,
  });
}

function digest(value: unknown) {
  return createHash("sha256").update(stable(value)).digest("hex");
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => `${JSON.stringify(key)}:${stable(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
