import { createHash } from "node:crypto";

import type { MissionRelationDisclosure, MutationReceipt } from "@scry/contracts";

export type MissionReportCompositionDigestInput = Readonly<{
  missionId: string;
  sourceMissionRevision: number;
  selectedRunIds: readonly string[];
  evidenceDigest: string;
  recordingDigest: string | null;
  mutationReceipts: readonly MutationReceipt[];
  relatedMissions: readonly MissionRelationDisclosure[];
}>;

/**
 * Bind the independently authoritative evidence, recording and protected
 * mutation projections into one deterministic factual report composition.
 * Chronicle validates scope and hashes facts; it does not select them.
 */
export function digestMissionReportComposition(input: MissionReportCompositionDigestInput) {
  if (!input.missionId) throw new Error("CHRONICLE_REPORT_MISSION_ID_REQUIRED");
  if (!Number.isInteger(input.sourceMissionRevision) || input.sourceMissionRevision < 0)
    throw new Error("CHRONICLE_REPORT_MISSION_REVISION_INVALID");
  if (!/^[a-f0-9]{64}$/.test(input.evidenceDigest))
    throw new Error("CHRONICLE_REPORT_EVIDENCE_DIGEST_INVALID");
  if (input.recordingDigest !== null && !/^[a-f0-9]{64}$/.test(input.recordingDigest))
    throw new Error("CHRONICLE_REPORT_RECORDING_DIGEST_INVALID");

  const selectedRunIds = [...new Set(input.selectedRunIds)];
  if (selectedRunIds.length !== input.selectedRunIds.length)
    throw new Error("CHRONICLE_REPORT_SELECTED_RUN_DUPLICATE");
  const selected = new Set(selectedRunIds);
  const receiptIds = new Set<string>();
  for (const receipt of input.mutationReceipts) {
    if (receiptIds.has(receipt.receiptId))
      throw new Error("CHRONICLE_REPORT_MUTATION_RECEIPT_DUPLICATE");
    receiptIds.add(receipt.receiptId);
    if (receipt.correlation.missionId !== input.missionId)
      throw new Error("CHRONICLE_REPORT_MUTATION_RECEIPT_MISSION_MISMATCH");
    if (!receipt.correlation.runId || !selected.has(receipt.correlation.runId))
      throw new Error("CHRONICLE_REPORT_MUTATION_RECEIPT_RUN_UNSELECTED");
  }
  const relationIds = new Set<string>();
  for (const relation of input.relatedMissions) {
    if (relationIds.has(relation.relationId))
      throw new Error("CHRONICLE_REPORT_MISSION_RELATION_DUPLICATE");
    relationIds.add(relation.relationId);
    if (relation.relatedMission.id === input.missionId)
      throw new Error("CHRONICLE_REPORT_MISSION_RELATION_SELF_REFERENCE");
  }

  return createHash("sha256")
    .update(
      canonical({
        schemaVersion: 1,
        missionId: input.missionId,
        sourceMissionRevision: input.sourceMissionRevision,
        selectedRunIds,
        evidenceDigest: input.evidenceDigest,
        recordingDigest: input.recordingDigest,
        mutationReceipts: input.mutationReceipts,
        relatedMissions: input.relatedMissions,
      }),
    )
    .digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
