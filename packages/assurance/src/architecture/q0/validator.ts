import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  adaptiveSessionStateSchema,
  agentSessionStatusSchema,
  canTransitionProtectedOperation,
  flowDraftStateSchema,
  missionStatusSchema,
  objectiveStatusSchema,
  orchestrationStateSchema,
  protectedOperationStateSchema,
  protectedOperationTerminalStates,
  reportStatusSchema,
  runStateSchema,
} from "@scry/contracts";

import type {
  CorrectnessManifest,
  NegativeControlResult,
  ProductionSnapshot,
  Q0Finding,
  Q0ReasonId,
} from "./types.js";

const allowedCanonicalSources = new Set([
  "docs/rearchitecture/README.md",
  "docs/rearchitecture/R0-ARCHITECTURE.md",
  "docs/rearchitecture/R0-ROADMAP.md",
]);

const requiredLegacyOverlayNames = new Set([
  "execution_kernel_operations",
  "execution_kernel_mutations",
  "protected_transactions",
  "protected_mutation_ledger",
  "calibration paths",
  "probe paths",
  "authenticated-session leases",
  "authoring-browser leases",
  "run_checkpoints",
]);

const schemaOptions: Record<string, string[]> = {
  missionStatusSchema: [...missionStatusSchema.options],
  objectiveStatusSchema: [...objectiveStatusSchema.options],
  orchestrationStateSchema: [...orchestrationStateSchema.options],
  flowDraftStateSchema: [...flowDraftStateSchema.options],
  runStateSchema: [...runStateSchema.options],
  agentSessionStatusSchema: [...agentSessionStatusSchema.options],
  adaptiveSessionStateSchema: [...adaptiveSessionStateSchema.options],
  protectedOperationStateSchema: [...protectedOperationStateSchema.options],
  reportStatusSchema: [...reportStatusSchema.options],
};

export async function createProductionSnapshot(root: string): Promise<ProductionSnapshot> {
  const adaptiveTransitions = await extractAdaptiveTransitions(root);
  const protectedTransitions = Object.fromEntries(
    protectedOperationStateSchema.options.map((from) => [
      from,
      protectedOperationStateSchema.options.filter((to) =>
        canTransitionProtectedOperation(from, to),
      ),
    ]),
  );

  return {
    states: Object.fromEntries(
      Object.entries(schemaOptions).map(([exportName, states]) => [exportName, [...states]]),
    ),
    terminalStates: {
      protectedOperationStateSchema: [...protectedOperationTerminalStates],
    },
    transitionEdges: {
      "machine.adaptive_session": flattenEdges(adaptiveTransitions),
      "machine.protected_operation": flattenEdges(protectedTransitions),
    },
  };
}

export async function validateQ0Manifest(
  root: string,
  manifest: CorrectnessManifest,
  snapshot: ProductionSnapshot,
): Promise<Q0Finding[]> {
  const findings: Q0Finding[] = [];
  const machineIds = new Set(manifest.machines.map(({ id }) => id));
  const boundaryIds = new Set(manifest.boundaries.map(({ id }) => id));
  const invariantIds = new Set(manifest.invariants.map(({ id }) => id));
  const ownerIds = new Set(manifest.ownership.map(({ id }) => id));

  checkDuplicateIds(
    findings,
    "machine",
    manifest.machines.map(({ id }) => id),
  );
  checkDuplicateIds(
    findings,
    "legacy overlay",
    manifest.legacyOverlays.map(({ id }) => id),
  );
  checkDuplicateIds(
    findings,
    "ownership concern",
    manifest.ownership.map(({ id }) => id),
  );
  checkDuplicateIds(
    findings,
    "boundary",
    manifest.boundaries.map(({ id }) => id),
  );
  checkDuplicateIds(
    findings,
    "timer/lease",
    manifest.timersAndLeases.map(({ id }) => id),
  );
  checkDuplicateIds(
    findings,
    "authority domain",
    manifest.authorityDomains.map(({ id }) => id),
  );
  checkDuplicateIds(
    findings,
    "conflict scope",
    manifest.conflictScopes.map(({ id }) => id),
  );
  checkDuplicateIds(
    findings,
    "invariant",
    manifest.invariants.map(({ id }) => id),
  );
  checkDuplicateIds(
    findings,
    "risk",
    manifest.risks.map(({ id }) => id),
  );

  for (const machine of manifest.machines) {
    for (const terminal of machine.terminalStates) {
      if (!machine.states.includes(terminal)) {
        findings.push({
          reasonId: "Q0_MANIFEST_TERMINAL_UNKNOWN",
          subject: machine.id,
          message: `Terminal state ${terminal} is not a declared machine state.`,
        });
      }
    }
    for (const dependency of machine.dependencies) {
      if (!machineIds.has(dependency)) {
        findings.push({
          reasonId: "Q0_INVARIANT_REFERENCE_INVALID",
          subject: machine.id,
          message: `Machine dependency ${dependency} does not exist.`,
        });
      }
    }
    if (machine.stateProbe) {
      const productionStates = snapshot.states[machine.stateProbe.exportName];
      if (!productionStates || !sameSet(productionStates, machine.states)) {
        findings.push({
          reasonId: "Q0_UNKNOWN_PRODUCTION_STATE",
          subject: machine.id,
          message: `Manifest states ${JSON.stringify(machine.states)} disagree with ${machine.stateProbe.exportName} ${JSON.stringify(productionStates ?? [])}.`,
        });
      }
      const productionTerminals = snapshot.terminalStates[machine.stateProbe.exportName];
      if (productionTerminals && !sameSet(productionTerminals, machine.terminalStates)) {
        findings.push({
          reasonId: "Q0_MANIFEST_TERMINAL_UNKNOWN",
          subject: machine.id,
          message: `Manifest terminal states disagree with production terminal states.`,
        });
      }
    }
    if (machine.transitionEdges) {
      const expected = flattenEdges(machine.transitionEdges);
      const actual = snapshot.transitionEdges[machine.id] ?? [];
      if (!sameSet(expected, actual)) {
        findings.push({
          reasonId: "Q0_TRANSITION_AUTHORITY_DRIFT",
          subject: machine.id,
          message: `Manifest transition edges disagree with the production transition helper.`,
        });
      }
    }
  }

  const singleOwnerConcerns = new Map<string, string>();
  for (const concern of manifest.ownership) {
    if (concern.status !== "single_owner") continue;
    const prior = singleOwnerConcerns.get(concern.concern);
    if (prior) {
      findings.push({
        reasonId: "Q0_DUPLICATE_AUTHORITATIVE_OWNER",
        subject: concern.concern,
        message: `Both ${prior} and ${concern.id} claim unambiguous authority.`,
      });
    } else {
      singleOwnerConcerns.set(concern.concern, concern.id);
    }
  }

  for (const overlay of manifest.legacyOverlays) {
    if (overlay.classification === "unresolved_from_static_source") {
      findings.push({
        reasonId: "Q0_UNCLASSIFIED_LEGACY_OVERLAY",
        subject: overlay.id,
        message: "Legacy overlay is not mechanically classified.",
      });
    }
  }
  const classifiedOverlayNames = new Set(manifest.legacyOverlays.map(({ name }) => name));
  for (const requiredOverlay of requiredLegacyOverlayNames) {
    if (!classifiedOverlayNames.has(requiredOverlay)) {
      findings.push({
        reasonId: "Q0_UNCLASSIFIED_LEGACY_OVERLAY",
        subject: requiredOverlay,
        message: "A current or retained overlapping lifecycle model is absent from classification.",
      });
    }
  }

  for (const architectureSource of manifest.architectureSources) {
    if (
      architectureSource.status === "canonical" &&
      !allowedCanonicalSources.has(architectureSource.path)
    ) {
      findings.push({
        reasonId: "Q0_STALE_ARCHITECTURE_CANONICAL",
        subject: architectureSource.path,
        message: "A superseded or supporting architecture source is marked canonical.",
      });
    }
  }

  for (const boundary of manifest.boundaries) {
    if (!ownerIds.has(boundary.ownerConcernId)) {
      findings.push({
        reasonId: "Q0_BOUNDARY_OWNER_UNKNOWN",
        subject: boundary.id,
        message: `Ownership concern ${boundary.ownerConcernId} does not exist.`,
      });
    }
    if (!boundary.recoveryOwner.trim()) {
      findings.push({
        reasonId: "Q0_BOUNDARY_RECOVERY_OWNER_MISSING",
        subject: boundary.id,
        message: "High-risk boundary has no recovery owner.",
      });
    }
    for (const invariantId of boundary.invariantIds) {
      if (!invariantIds.has(invariantId)) {
        findings.push({
          reasonId: "Q0_INVARIANT_REFERENCE_INVALID",
          subject: boundary.id,
          message: `Boundary references nonexistent invariant ${invariantId}.`,
        });
      }
    }
  }

  for (const invariant of manifest.invariants) {
    for (const machineId of invariant.machineIds) {
      if (!machineIds.has(machineId)) {
        findings.push({
          reasonId: "Q0_INVARIANT_REFERENCE_INVALID",
          subject: invariant.id,
          message: `Invariant references nonexistent machine ${machineId}.`,
        });
      }
    }
    for (const stateRef of invariant.stateRefs) {
      const machine = manifest.machines.find(({ id }) => id === stateRef.machineId);
      if (!machine || !machine.states.includes(stateRef.state)) {
        findings.push({
          reasonId: "Q0_INVARIANT_REFERENCE_INVALID",
          subject: invariant.id,
          message: `Invariant references nonexistent state ${stateRef.machineId}:${stateRef.state}.`,
        });
      }
    }
    for (const boundaryId of invariant.boundaryIds) {
      if (!boundaryIds.has(boundaryId)) {
        findings.push({
          reasonId: "Q0_INVARIANT_REFERENCE_INVALID",
          subject: invariant.id,
          message: `Invariant references nonexistent boundary ${boundaryId}.`,
        });
      }
    }
  }

  for (const risk of manifest.risks) {
    const missingInvariant = risk.invariantIds.find((id) => !invariantIds.has(id));
    const missingBoundary = risk.boundaryIds.find((id) => !boundaryIds.has(id));
    if (
      !risk.invariantIds.length ||
      !risk.boundaryIds.length ||
      !risk.owner.trim() ||
      !risk.stabilizationMilestone ||
      missingInvariant ||
      missingBoundary
    ) {
      findings.push({
        reasonId: "Q0_RISK_TRACEABILITY_INCOMPLETE",
        subject: risk.id,
        message: `P0/P1 risk traceability is incomplete${missingInvariant ? `; missing ${missingInvariant}` : ""}${missingBoundary ? `; missing ${missingBoundary}` : ""}.`,
      });
    }
  }

  const requestLoader = manifest.authorityDomains.find(
    ({ id }) => id === "authority.request_loader",
  );
  if (!requestLoader || requestLoader.mayEstablishDocumentAuthority) {
    findings.push({
      reasonId: "Q0_REQUEST_LOADER_DOCUMENT_AUTHORITY",
      subject: "authority.request_loader",
      message: "Request loader telemetry must never establish document authority.",
    });
  }

  for (const evidence of allSourceEvidence(manifest)) {
    try {
      await access(path.join(root, evidence.path));
    } catch {
      findings.push({
        reasonId: "Q0_SOURCE_EVIDENCE_MISSING",
        subject: evidence.path,
        message: "Manifest source evidence path does not exist.",
      });
    }
  }

  return stableFindings(findings);
}

export async function runNegativeControls(
  root: string,
  manifest: CorrectnessManifest,
  snapshot: ProductionSnapshot,
): Promise<NegativeControlResult[]> {
  const controls: Array<{
    id: string;
    expectedReasonId: Q0ReasonId;
    mutate: (manifest: CorrectnessManifest, snapshot: ProductionSnapshot) => void;
  }> = [
    {
      id: "duplicate-authoritative-owner",
      expectedReasonId: "Q0_DUPLICATE_AUTHORITATIVE_OWNER",
      mutate: (candidate) => {
        const existing = candidate.ownership.find(({ status }) => status === "single_owner")!;
        candidate.ownership.push({ ...existing, id: `${existing.id}.negative_duplicate` });
      },
    },
    {
      id: "stale-architecture-canonical",
      expectedReasonId: "Q0_STALE_ARCHITECTURE_CANONICAL",
      mutate: (candidate) => {
        candidate.architectureSources.find(
          ({ status }) => status === "superseded_or_historical",
        )!.status = "canonical";
      },
    },
    {
      id: "unknown-production-state",
      expectedReasonId: "Q0_UNKNOWN_PRODUCTION_STATE",
      mutate: (_candidate, production) => {
        production.states.missionStatusSchema!.push("negative_control_unknown");
      },
    },
    {
      id: "unclassified-legacy-overlay",
      expectedReasonId: "Q0_UNCLASSIFIED_LEGACY_OVERLAY",
      mutate: (candidate) => {
        candidate.legacyOverlays[0]!.classification = "unresolved_from_static_source";
      },
    },
    {
      id: "boundary-without-recovery-owner",
      expectedReasonId: "Q0_BOUNDARY_RECOVERY_OWNER_MISSING",
      mutate: (candidate) => {
        candidate.boundaries[0]!.recoveryOwner = "";
      },
    },
    {
      id: "request-loader-as-document-authority",
      expectedReasonId: "Q0_REQUEST_LOADER_DOCUMENT_AUTHORITY",
      mutate: (candidate) => {
        candidate.authorityDomains.find(
          ({ id }) => id === "authority.request_loader",
        )!.mayEstablishDocumentAuthority = true;
      },
    },
  ];

  const results: NegativeControlResult[] = [];
  for (const control of controls) {
    const candidate = structuredClone(manifest);
    const production = structuredClone(snapshot);
    control.mutate(candidate, production);
    const observed = await validateQ0Manifest(root, candidate, production);
    const observedReasonIds = [...new Set(observed.map(({ reasonId }) => reasonId))].sort();
    results.push({
      id: control.id,
      expectedReasonId: control.expectedReasonId,
      observedReasonIds,
      passed: observedReasonIds.includes(control.expectedReasonId),
    });
  }
  return results;
}

export async function architectureSourceDigest(
  root: string,
  manifest: CorrectnessManifest,
): Promise<string> {
  const paths = new Set([
    ...allSourceEvidence(manifest).map(({ path: sourcePath }) => sourcePath),
    ...manifest.architectureSources.map(({ path: sourcePath }) => sourcePath),
  ]);
  const files: string[] = [];
  for (const sourcePath of [...paths].sort()) {
    files.push(...(await collectFiles(path.join(root, sourcePath))));
  }
  const hash = createHash("sha256");
  for (const file of [...new Set(files)].sort()) {
    hash
      .update(path.relative(root, file))
      .update("\0")
      .update(await readFile(file))
      .update("\0");
  }
  return hash.digest("hex");
}

export function schemaFingerprint(root: string): string {
  return execFileSync(process.execPath, ["scripts/schema-fingerprint.mjs"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

export function deterministicDigest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(sortObject(value), null, 2)}\n`;
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortObject(nested)]),
    );
  }
  return value;
}

async function extractAdaptiveTransitions(root: string): Promise<Record<string, string[]>> {
  const file = path.join(
    root,
    "apps/api/src/adaptive-sessions/repositories/adaptive-session.repository.ts",
  );
  const contents = await readFile(file, "utf8");
  const start = contents.indexOf("const transitions:");
  const end = contents.indexOf("\n};", start);
  if (start < 0 || end < 0) throw new Error("Q0_ADAPTIVE_TRANSITION_AUTHORITY_NOT_FOUND");
  const block = contents.slice(start, end);
  const result: Record<string, string[]> = {};
  for (const match of block.matchAll(/^\s*([a-z_]+):\s*\[([^\]]*)\],?$/gm)) {
    result[match[1]!] = [...match[2]!.matchAll(/"([a-z_]+)"/g)].map((state) => state[1]!);
  }
  return result;
}

function flattenEdges(edges: Record<string, readonly string[]>): string[] {
  return Object.entries(edges)
    .flatMap(([from, destinations]) => destinations.map((to) => `${from}->${to}`))
    .sort();
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join("\0") === [...right].sort().join("\0");
}

function checkDuplicateIds(findings: Q0Finding[], kind: string, ids: string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      findings.push({
        reasonId: "Q0_DUPLICATE_ID",
        subject: id,
        message: `Duplicate ${kind} ID.`,
      });
    }
    seen.add(id);
  }
}

function allSourceEvidence(manifest: CorrectnessManifest) {
  return [
    ...manifest.machines.flatMap(({ sourceEvidence }) => sourceEvidence),
    ...manifest.legacyOverlays.flatMap(({ sourceEvidence }) => sourceEvidence),
    ...manifest.ownership.flatMap(({ sourceEvidence }) => sourceEvidence),
    ...manifest.boundaries.flatMap(({ sourceEvidence }) => sourceEvidence),
    ...manifest.timersAndLeases.flatMap(({ sourceEvidence }) => sourceEvidence),
    ...manifest.authorityDomains.flatMap(({ sourceEvidence }) => sourceEvidence),
    ...manifest.conflictScopes.flatMap(({ sourceEvidence }) => sourceEvidence),
  ];
}

async function collectFiles(target: string): Promise<string[]> {
  const targetStat = await stat(target);
  if (targetStat.isFile()) return [target];
  const entries = await readdir(target, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(child)));
    else if (entry.isFile() && /\.(?:ts|sql|md|json)$/.test(entry.name)) files.push(child);
  }
  return files;
}

function stableFindings(findings: Q0Finding[]): Q0Finding[] {
  return findings.sort((left, right) =>
    `${left.reasonId}:${left.subject}:${left.message}`.localeCompare(
      `${right.reasonId}:${right.subject}:${right.message}`,
    ),
  );
}
