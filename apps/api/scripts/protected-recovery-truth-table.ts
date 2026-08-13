import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ProtectedOperationState } from "@scry/contracts";

import { runKernelOwnerCertification } from "./protected-certification-production-owner.js";

type Evidence = "none" | "partial_staged" | "complete_staged" | "complete_committed";
type OutputClass = "protected" | "public_only";
type Semantics = "one_time" | "read_only";
type Case = {
  id: string;
  state: ProtectedOperationState;
  semantics: Semantics;
  evidence: Evidence;
  outputClass: OutputClass;
};

const active = ["dispatching", "dispatched", "acquiring", "persisting", "persisted", "reconciling"] as const;
const cases: Case[] = [
  ...active.map((state) => ({ id: `${state}-mutation-none-protected`, state, semantics: "one_time" as const, evidence: "none" as const, outputClass: "protected" as const })),
  ...(["dispatching", "acquiring", "persisting"] as const).flatMap((state) => (["partial_staged", "complete_staged"] as const).map((evidence) => ({ id: `${state}-mutation-${evidence}-protected`, state, semantics: "one_time" as const, evidence, outputClass: "protected" as const }))),
  ...(["persisted", "reconciling"] as const).map((state) => ({ id: `${state}-mutation-complete_committed-protected`, state, semantics: "one_time" as const, evidence: "complete_committed" as const, outputClass: "protected" as const })),
  { id: "dispatching-mutation-none-public", state: "dispatching", semantics: "one_time", evidence: "none", outputClass: "public_only" },
  { id: "acquiring-mutation-none-public", state: "acquiring", semantics: "one_time", evidence: "none", outputClass: "public_only" },
  { id: "dispatching-mutation-complete_staged-public", state: "dispatching", semantics: "one_time", evidence: "complete_staged", outputClass: "public_only" },
  { id: "persisted-mutation-complete_committed-public", state: "persisted", semantics: "one_time", evidence: "complete_committed", outputClass: "public_only" },
  ...active.map((state) => ({ id: `${state}-read_only-none-protected`, state, semantics: "read_only" as const, evidence: "none" as const, outputClass: "protected" as const })),
];

const results = [];
for (const item of cases) {
  const observed = await runKernelOwnerCertification({
    family: "I", cellId: `truth-${item.id}`, initialState: item.state,
    semantics: item.semantics, recoveryEvidence: item.evidence,
    outputClassification: item.outputClass,
  });
  results.push({
    caseId: item.id,
    startingState: item.state,
    dispatchSemantics: item.semantics === "read_only" ? "read_only" : "mutation",
    mutationKind: "one_time",
    outputClassification: item.outputClass,
    inputEvidence: item.evidence,
    stagedOutputCount: observed.stagedOutputCount ?? 0,
    persistedReferenceCount: observed.referenceCount,
    completeOutputSet: item.evidence === "complete_staged" || item.evidence === "complete_committed",
    reclaimState: observed.reclaimState ?? "unknown",
    reclaimMutationOutcome: observed.reclaimMutationOutcome ?? "unknown",
    recoverDurableEntered: true,
    finalState: observed.finalProtectedState,
    finalMutationOutcome: observed.mutationOutcome,
    reasonCode: observed.reasonCode,
    reconciliationRequired: ["recovery_required", "compromised"].includes(observed.finalProtectedState),
    credentialCompromiseAction: (observed.credentialCompromiseActions ?? 0) > 0,
    dispatchDelta: observed.dispatchCount,
    redispatchDelta: observed.redispatchCount,
    fencingDelta: observed.fencingDelta ?? 0,
    plaintextLeak: observed.plaintextLeak,
  });
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  cases: results.length,
  invariants: {
    redispatchNever: results.every((result) => result.redispatchDelta === 0),
    fencingAdvanced: results.every((result) => result.fencingDelta === 1),
    plaintextLeaks: results.filter((result) => result.plaintextLeak).length,
  },
  results,
};
const root = path.resolve(process.cwd(), "../..");
const output = path.join(root, "docs/runbooks/evidence/protected-certification/recovery-truth-table.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ outcome: "PROTECTED_RECOVERY_TRUTH_TABLE_COMPLETE", output, cases: results.length, invariants: report.invariants })}\n`);
